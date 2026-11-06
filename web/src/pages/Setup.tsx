import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleCheck, Circle, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { invalidateLookups, useAsync, useLookups } from '../lib/hooks';
import { check, countRows, rpc, supabase } from '../lib/supabase';
import { invalidateAfterWrite } from '../lib/query';
import { ROLE_LABELS, type Profile } from '../lib/contract';
import { num } from '../lib/format';
import { CrudTable } from '../components/CrudTable';
import { ApprovalLimitsCard, DelegationsCard, FlowSettingsCard } from '../components/flows/FlowSettings';
import { Card, DataTable, Empty, ErrorBanner, Field, Loading, Page, Tabs, confirm, toast, useBusy, useHashTab } from '../components/ui';

const TABS = ['projects', 'members', 'structure', 'stores', 'opening'] as const;
type Tab = (typeof TABS)[number];

export function Setup() {
  const auth = useAuth();
  const [tab, setTab] = useHashTab<Tab>(TABS, 'projects');
  const projectId = auth.projectId;
  const isMgmt = auth.can('mr.approve');

  return (
    <Page title="Project setup" width="form" subtitle={auth.project ? `${auth.project.code} · ${auth.project.name}` : 'No project selected'}>
      {projectId && <SetupChecklist projectId={projectId} onGo={setTab} />}
      <div className="subnav-layout">
      <Tabs variant="vertical" label="Setup sections" value={tab} onChange={setTab} tabs={[
        { key: 'projects', label: 'Projects & settings' },
        { key: 'members', label: 'Members' },
        { key: 'structure', label: 'Blocks, levels, zones' },
        { key: 'stores', label: 'Stores' },
        { key: 'opening', label: 'Opening balances' },
      ]} />
      <div className="stack" style={{ minWidth: 0 }}>
      {tab === 'projects' && (
        <div className="stack">
          <CrudTable table="projects" title="Project" softDelete={false} orderBy="code" canEdit={isMgmt}
            onSaved={() => void auth.reload()} exportName="projects"
            fields={[
              { key: 'code', label: 'Code', required: true, hint: 'Uppercase letters/digits, used in document numbers (e.g. BOLE)' },
              { key: 'name', label: 'Name', required: true },
              { key: 'location', label: 'Location' },
              { key: 'client', label: 'Client' },
              { key: 'start_date', label: 'Start', type: 'date' },
              { key: 'end_date', label: 'End', type: 'date' },
              { key: 'currency', label: 'Currency', required: true },
              { key: 'is_active', label: 'Active', type: 'bool' },
            ]}
            defaults={{ currency: 'ETB', is_active: true }} />
          {projectId && <ProjectSettingsCard projectId={projectId} canEdit={isMgmt} />}
          {projectId && <FlowSettingsCard projectId={projectId} canEdit={isMgmt} />}
          {projectId && isMgmt && <ApprovalLimitsCard projectId={projectId} />}
          {projectId && <DelegationsCard projectId={projectId} />}
        </div>
      )}
      {!projectId && tab !== 'projects' && <Empty>Select or create a project first.</Empty>}
      {projectId && tab === 'members' && <Members projectId={projectId} canEdit={isMgmt} />}
      {projectId && tab === 'structure' && <Structure projectId={projectId} canEdit={auth.can('master.edit')} />}
      {projectId && tab === 'stores' && (
        <CrudTable table="stores" title="Store" filter={{ project_id: projectId }} defaults={{ project_id: projectId, store_type: 'main' }}
          orderBy="name" canEdit={auth.can('master.edit')} onSaved={invalidateLookups} exportName="stores"
          fields={[
            { key: 'name', label: 'Name', required: true },
            { key: 'store_type', label: 'Type', type: 'select', required: true, options: [
              { value: 'main', label: 'Main store' }, { value: 'satellite', label: 'Satellite store' },
              { value: 'yard', label: 'Open yard' }, { value: 'batching', label: 'Batching area' }] },
          ]} />
      )}
      {projectId && tab === 'opening' && <OpeningBalances projectId={projectId} canPost={isMgmt} />}
      </div>
      </div>
    </Page>
  );
}

/** First-run checklist: shown until every setup step is done. */
function SetupChecklist({ projectId, onGo }: { projectId: string; onGo: (t: Tab) => void }) {
  const nav = useNavigate();
  const q = useAsync(async () => {
    const head = (t: string) => supabase.from(t).select('*', { count: 'exact', head: true }).eq('project_id', projectId);
    const [blocks, levels, stores, boq, elements, opening, members] = await Promise.all([
      countRows(() => head('blocks').is('deleted_at', null)), countRows(() => head('levels').is('deleted_at', null)),
      countRows(() => head('stores').is('deleted_at', null)), countRows(() => head('boq_items').is('deleted_at', null)),
      countRows(() => head('elements').is('deleted_at', null)), countRows(() => head('stock_ledger').eq('txn_type', 'opening')),
      countRows(() => head('project_members')),
    ]);
    return { structure: blocks > 0 && levels > 0, stores: stores > 0, boq: boq > 0, elements: elements > 0, opening: opening > 0, members: members > 1 };
  }, [projectId], { key: 'setup-checklist' });
  if (!q.data || Object.values(q.data).every(Boolean)) return null;
  const steps: { done: boolean; label: string; go: () => void }[] = [
    { done: q.data.structure, label: 'Create blocks & levels', go: () => onGo('structure') },
    { done: q.data.stores, label: 'Add stores', go: () => onGo('stores') },
    { done: q.data.boq, label: 'Import BoQ', go: () => nav('/elements#import') },
    { done: q.data.elements, label: 'Import elements', go: () => nav('/elements#import') },
    { done: q.data.opening, label: 'Opening balances', go: () => onGo('opening') },
    { done: q.data.members, label: 'Invite members', go: () => onGo('members') },
  ];
  const done = steps.filter((x) => x.done).length;
  return (
    <Card title="Get this project ready" sub={`${done} of ${steps.length} done`}>
      <div className="row" style={{ gap: '8px 20px' }}>
        {steps.map((x, i) => (
          <button key={x.label} className="link-btn" style={{ color: x.done ? 'var(--text-muted)' : 'var(--primary)' }} onClick={x.go}>
            {x.done ? <CircleCheck size={16} className="ok-text" aria-hidden /> : <Circle size={16} aria-hidden />} {i + 1}. {x.label}
          </button>
        ))}
      </div>
    </Card>
  );
}

function ProjectSettingsCard({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const auth = useAuth();
  const q = useAsync(async () => check(await supabase.from('project_settings').select('*').eq('project_id', projectId).maybeSingle()), [projectId]);
  const [form, setForm] = useState<{ require_review: boolean; enforce_hold_points: boolean; escalation_hours: number; thresholds: { cat: string; pct: string }[] } | null>(null);
  const { busy, error, run } = useBusy();
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const s = q.data as { require_review: boolean; enforce_hold_points: boolean; escalation_hours: number; variance_thresholds: Record<string, number> } | null | undefined;
    if (s) setForm({
      require_review: s.require_review, enforce_hold_points: s.enforce_hold_points, escalation_hours: s.escalation_hours,
      thresholds: Object.entries(s.variance_thresholds ?? {}).map(([cat, pct]) => ({ cat, pct: String(pct) })),
    });
  }, [q.data]);

  if (q.loading && !form) return <Loading />;
  if (!form) return <ErrorBanner error={q.error ?? 'Project settings not found'} />;

  const save = () => run(async () => {
    const thresholds: Record<string, number> = {};
    for (const t of form.thresholds) if (t.cat.trim() && t.pct !== '') thresholds[t.cat.trim()] = Number(t.pct);
    check(await supabase.from('project_settings').update({
      require_review: form.require_review, enforce_hold_points: form.enforce_hold_points,
      escalation_hours: Number(form.escalation_hours), variance_thresholds: thresholds,
    }).eq('project_id', projectId));
    setDirty(false);
    toast.success('Workflow settings saved');
    void auth.reload();
    invalidateAfterWrite();
  });
  const upd = (patch: Partial<NonNullable<typeof form>>) => { setForm({ ...form, ...patch }); setDirty(true); };

  return (
    <Card title="Workflow settings" sub="Approval routing, hold points and variance thresholds for the selected project">
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Office Engineer review before approval" check>
          <input type="checkbox" disabled={!canEdit} checked={form.require_review} onChange={(e) => upd({ require_review: e.target.checked })} />
        </Field>
        <Field label="Enforce inspection hold points (FR-PG-05)" check>
          <input type="checkbox" disabled={!canEdit} checked={form.enforce_hold_points} onChange={(e) => upd({ enforce_hold_points: e.target.checked })} />
        </Field>
        <Field label="Escalate pending approvals after (hours)">
          <input type="number" min={1} disabled={!canEdit} value={form.escalation_hours} onChange={(e) => upd({ escalation_hours: Number(e.target.value) })} />
        </Field>
      </div>
      <h3>Consumption variance thresholds (FR-CC-02)</h3>
      <p className="muted">Alert when issued quantity exceeds the earned (take-off × progress) quantity by more than this % for the material category.</p>
      {form.thresholds.map((t, i) => (
        <div className="row" key={i} style={{ marginBottom: 6 }}>
          <input placeholder="Category (e.g. Reinforcement)" disabled={!canEdit} value={t.cat}
            onChange={(e) => upd({ thresholds: form.thresholds.map((x, j) => (j === i ? { ...x, cat: e.target.value } : x)) })} />
          <input type="number" step="any" style={{ width: 90 }} disabled={!canEdit} value={t.pct}
            onChange={(e) => upd({ thresholds: form.thresholds.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)) })} /> %
          {canEdit && <button className="icon-btn sm" aria-label="Remove threshold" onClick={() => upd({ thresholds: form.thresholds.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>}
        </div>
      ))}
      {canEdit && <button className="small" onClick={() => upd({ thresholds: [...form.thresholds, { cat: '', pct: '' }] })}><Plus size={14} aria-hidden />Add threshold</button>}
      {canEdit && (
        <div className="save-bar mt-4">
          <span className="grow">{dirty ? 'Unsaved changes' : ''}</span>
          <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy && <span className="spinner" />}Save settings</button>
        </div>
      )}
    </Card>
  );
}

function Members({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const q = useAsync(async () => {
    const [members, profiles] = await Promise.all([
      supabase.from('project_members').select('user_id, created_at').eq('project_id', projectId).then(check),
      supabase.from('profiles').select('*').order('full_name').then(check),
    ]);
    return { members: members as { user_id: string; created_at: string }[], profiles: profiles as Profile[] };
  }, [projectId]);
  const [add, setAdd] = useState('');
  const { busy, error, run } = useBusy();
  if (!q.data) return q.error ? <ErrorBanner error={q.error} /> : <Loading />;
  const memberIds = new Set(q.data.members.map((m) => m.user_id));
  const rows = q.data.profiles.filter((p) => memberIds.has(p.id));
  const candidates = q.data.profiles.filter((p) => !memberIds.has(p.id) && p.is_active);

  return (
    <Card title="Project members (FR-ACC-04)">
      <ErrorBanner error={error} />
      {canEdit && (
        <div className="row" style={{ marginBottom: 12 }}>
          <select value={add} onChange={(e) => setAdd(e.target.value)}>
            <option value="">Select a user to add…</option>
            {candidates.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email} — {ROLE_LABELS[p.role]}</option>)}
          </select>
          <button className="primary" disabled={!add || busy} onClick={() => void run(async () => {
            check(await supabase.from('project_members').insert({ project_id: projectId, user_id: add }));
            setAdd(''); invalidateLookups(); toast.success('Member added');
          })}><Plus size={14} aria-hidden />Add member</button>
        </div>
      )}
      <DataTable rows={rows} exportName="project-members" empty={{ title: 'No members yet', body: 'Add the people who work on this project.' }} columns={[
        { key: 'full_name', label: 'Name', id: true },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Phone' },
        { key: 'role', label: 'Role', value: (r) => ROLE_LABELS[r.role] },
        { key: 'is_active', label: 'Active', value: (r) => (r.is_active ? 'Yes' : 'No') },
        ...(canEdit ? [{ key: '_rm', label: '', noExport: true, render: (r: Profile) => (
          <button className="icon-btn sm" aria-label={`Remove ${r.full_name || r.email}`} title="Remove from project" disabled={busy} onClick={async () => {
            if (!(await confirm({ title: `Remove ${r.full_name || r.email} from this project?`, confirm: 'Remove member', danger: true }))) return;
            void run(async () => {
              check(await supabase.from('project_members').delete().match({ project_id: projectId, user_id: r.id }));
              invalidateAfterWrite({ lookups: true });
              toast.success('Member removed');
            });
          }}><Trash2 size={14} /></button>
        ) }] : []),
      ]} />
    </Card>
  );
}

function Structure({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const lk = useLookups(projectId);
  const blocks = lk.data?.blocks ?? [];
  const levels = lk.data?.levels ?? [];
  return (
    <div className="stack">
      <Card title="Blocks / buildings">
        <CrudTable table="blocks" title="Block" filter={{ project_id: projectId }} defaults={{ project_id: projectId }} orderBy="code"
          canEdit={canEdit} onSaved={invalidateLookups} exportName="blocks"
          fields={[{ key: 'code', label: 'Code', required: true }, { key: 'name', label: 'Name', required: true }]} />
      </Card>
      <Card title="Levels / floors">
        <CrudTable table="levels" title="Level" filter={{ project_id: projectId }} defaults={{ project_id: projectId, sort_order: 0 }} orderBy="sort_order"
          canEdit={canEdit} onSaved={invalidateLookups} exportName="levels"
          fields={[
            { key: 'block_id', label: 'Block', type: 'select', required: true, options: blocks.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })) },
            { key: 'code', label: 'Code', required: true },
            { key: 'name', label: 'Name', required: true },
            { key: 'sort_order', label: 'Order', type: 'number' },
          ]} />
      </Card>
      <Card title="Zones">
        <CrudTable table="zones" title="Zone" filter={{ project_id: projectId }} defaults={{ project_id: projectId }} orderBy="name"
          canEdit={canEdit} onSaved={invalidateLookups} exportName="zones"
          fields={[
            { key: 'level_id', label: 'Level', type: 'select', options: levels.map((l) => ({ value: l.id, label: `${lk.data?.block(l.block_id)} / ${l.code}` })) },
            { key: 'name', label: 'Name', required: true },
          ]} />
      </Card>
    </div>
  );
}

function OpeningBalances({ projectId, canPost }: { projectId: string; canPost: boolean }) {
  const lk = useLookups(projectId);
  const [store, setStore] = useState('');
  const [lines, setLines] = useState<{ spec: string; qty: string }[]>([{ spec: '', qty: '' }]);
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useBusy();
  if (!lk.data) return lk.error ? <ErrorBanner error={lk.error} /> : <Loading />;
  if (!canPost) return <Empty>Only coordinators and managers can post opening balances.</Empty>;
  const L = lk.data;

  const post = () => run(async () => {
    if (!store) throw new Error('Choose a store');
    const valid = lines.filter((l) => l.spec && Number(l.qty) > 0);
    if (!valid.length) throw new Error('Add at least one line with a quantity');
    await rpc('post_opening_balance', { project_id: projectId, store_id: store, lines: valid.map((l) => ({ material_spec_id: l.spec, qty: Number(l.qty) })) });
    setDone(`Posted ${valid.length} opening balance line(s) to ${L.store(store)}.`);
    toast.success('Opening balances posted');
    setLines([{ spec: '', qty: '' }]);
  });

  return (
    <Card title="Opening stock balances" actions={<button className="primary" disabled={busy} onClick={() => void post()}>Post opening balances</button>}>
      <p className="muted">Use once at go-live to load the physical stock already on site. Entries go to the stock ledger and cannot be edited — correct mistakes with a stock count.</p>
      <ErrorBanner error={error} />
      {done && <div className="banner ok" role="status">{done}</div>}
      <Field label="Store">
        <select value={store} onChange={(e) => setStore(e.target.value)}>
          <option value="">Choose…</option>
          {L.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <div className="table-wrap mt-3"><table>
        <thead><tr><th>Material / grade</th><th className="right">Quantity</th><th>Unit</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <select value={l.spec} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, spec: e.target.value } : x)))}>
                  <option value="">Choose…</option>
                  {L.specs.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </td>
              <td className="right"><input type="number" inputMode="decimal" className="num-input" step="any" min={0} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></td>
              <td>{L.specUom(l.spec)}</td>
              <td><button className="icon-btn sm" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => setLines([...lines, { spec: '', qty: '' }])}><Plus size={14} aria-hidden />Add line</button>
        <span className="muted">{lines.filter((l) => l.spec && Number(l.qty) > 0).length} line(s), total {num(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0))}</span>
      </div>
    </Card>
  );
}
