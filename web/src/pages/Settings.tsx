import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { check, supabase } from '../lib/supabase';
import { ROLE_LABELS, type AppRole } from '../lib/contract';
import { money } from '../lib/format';
import { CrudTable } from '../components/CrudTable';
import { ProjectChannels } from '../components/control/ProjectChannels';
import { Card, ErrorBanner, Field, Page, toast, useBusy } from '../components/ui';

const ROLES = Object.keys(ROLE_LABELS) as AppRole[];

async function saveLogo(logo: string | null) {
  check(await supabase.from('app_settings').update({ company_logo: logo }).eq('id', 1));
}

/** Scale the picked image down (max 600×300) so it fits the settings row (≤ 700 kB data URL). */
async function logoDataUrl(file: File): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(url); resolve(i); };
    i.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file is not an image')); };
    i.src = url;
  });
  const k = Math.min(1, 600 / img.width, 300 / img.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
  const png = c.toDataURL('image/png');
  return png.length <= 700_000 ? png : c.toDataURL('image/jpeg', 0.85);
}

export function Settings() {
  const auth = useAuth();
  const canEditApp = auth.profile?.role === 'admin' || auth.profile?.role === 'manager';
  const canEditLimits = canEditApp;
  const [company, setCompany] = useState(auth.companyName);
  const [priceRoles, setPriceRoles] = useState<AppRole[]>(auth.priceRoles);
  const [dirty, setDirty] = useState(false);
  const { busy, error, run } = useBusy();

  useEffect(() => { setCompany(auth.companyName); setPriceRoles(auth.priceRoles); setDirty(false); }, [auth.companyName, auth.priceRoles]);

  const save = () => run(async () => {
    check(await supabase.from('app_settings').update({ company_name: company.trim() || 'Company', price_roles: [...new Set<AppRole>([...priceRoles, 'admin'])] }).eq('id', 1));
    await auth.reload();
    setDirty(false);
    toast.success('Settings saved');
  });

  return (
    <Page title="Settings" subtitle="Company-wide configuration" width="form">
      <Card title="Company profile" sub="Shown on printed forms and reports">
        <ErrorBanner error={error} />
        {!canEditApp && <p className="muted">Only managers and administrators can change these settings.</p>}
        <div className="form-grid">
          <Field label="Company name"><input value={company} disabled={!canEditApp} onChange={(e) => { setCompany(e.target.value); setDirty(true); }} /></Field>
          <Field label="Logo" hint="PNG or JPG, printed at the top of payment certificates">
            <span className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {auth.companyLogo && <img src={auth.companyLogo} alt="Company logo" style={{ maxHeight: 48, maxWidth: 160 }} />}
              {canEditApp && <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void run(async () => { await saveLogo(await logoDataUrl(f)); await auth.reload(); toast.success('Logo saved'); });
              }} />}
              {canEditApp && auth.companyLogo && <button type="button" className="small" disabled={busy}
                onClick={() => void run(async () => { await saveLogo(null); await auth.reload(); toast.success('Logo removed'); })}>Remove</button>}
            </span>
          </Field>
        </div>
        <h3>Who can see prices and costs (FR-ACC-03, NFR-05)</h3>
        <p className="muted">Unit prices, BoQ rates and cost reports are hidden by the database from every other role.</p>
        <div className="check-list">
          {ROLES.map((r) => (
            <label key={r}>
              <input type="checkbox" disabled={!canEditApp || r === 'admin'} checked={priceRoles.includes(r)}
                onChange={(e) => { setPriceRoles(e.target.checked ? [...priceRoles, r] : priceRoles.filter((x) => x !== r)); setDirty(true); }} />
              {ROLE_LABELS[r]}
            </label>
          ))}
        </div>
        {canEditApp && (
          <div className="save-bar mt-4">
            <span className="grow">{dirty ? 'Unsaved changes' : ''}</span>
            <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy && <span className="spinner" />}Save</button>
          </div>
        )}
      </Card>
      <Card title="Approval limits by role (BR-08)" sub="Maximum request value (at current unit prices) a role may approve. Blank project = company-wide default; a project-specific limit overrides it. No limit = unlimited.">
        <CrudTable table="approval_limits" title="Approval limit" softDelete={false} hardDelete canEdit={canEditLimits} exportName="approval-limits"
          fields={[
            { key: 'role', label: 'Role', type: 'select', required: true, options: (['coordinator', 'manager', 'admin'] as AppRole[]).map((r) => ({ value: r, label: ROLE_LABELS[r] })) },
            { key: 'project_id', label: 'Project', type: 'select', options: auth.projects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })),
              render: (r) => (r.project_id ? auth.projects.find((p) => p.id === r.project_id)?.code ?? '?' : 'All projects') },
            { key: 'max_value', label: 'Max value (ETB)', type: 'number', required: true, render: (r) => money(r.max_value) },
          ]} />
      </Card>
      <ProjectChannels />
    </Page>
  );
}
