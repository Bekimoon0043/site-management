import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { ELEMENT_TYPES } from '../../lib/contract';
import { canField, type ChecklistItemType, type ChecklistTemplate, type ChecklistTemplateItem } from '../../lib/contract-field';
import { optNum, optStr, rpcx, uuid } from '../../lib/fieldx';
import { humanize } from '../../lib/format';
import { SBadge } from '../../components/field/StatusBadge';
import { Badge, Banner, DataTable, Drawer, ErrorBanner, Field, FilterBar, Loading, SearchInput, toast, useBusy } from '../../components/ui';
import { useTemplates } from './QualityInspections';

const ITEM_TYPES: { value: ChecklistItemType; label: string }[] = [
  { value: 'yes_no', label: 'Pass / fail / N/A' }, { value: 'value', label: 'Measured value' }, { value: 'photo', label: 'Photo' }, { value: 'text', label: 'Text' },
];
const MGMT = ['coordinator', 'manager', 'admin'];

type Tpl = ChecklistTemplate & { checklist_template_items: { id: string; deleted_at: string | null }[] };
interface ItemDraft { id: string; text: string; text_am: string; item_type: ChecklistItemType; min_value: string; max_value: string; unit: string; photo_required: boolean; is_critical: boolean }

export function TemplatesTab() {
  const projectId = useProjectId();
  const auth = useAuth();
  const tpl = useTemplates(projectId);
  const [term, setTerm] = useState('');
  const [editing, setEditing] = useState<Tpl | 'new' | null>(null);
  const role = auth.profile?.role;
  const canEdit = canField(role, 'checklist.edit');
  const rows = (tpl.data ?? []).filter((t) => !term || `${t.code} ${t.name}`.toLowerCase().includes(term.toLowerCase()));
  return (
    <>
      <ErrorBanner error={tpl.error} onRetry={tpl.reload} />
      <FilterBar right={canEdit && <button className="primary" onClick={() => setEditing('new')}><Plus size={14} aria-hidden />New checklist</button>}>
        <SearchInput value={term} onChange={setTerm} placeholder="Code or name" />
      </FilterBar>
      <DataTable rows={rows} loading={!tpl.data} exportName="checklist-templates" onRowClick={canEdit ? (r) => setEditing(r) : undefined}
        empty={{ title: 'No checklists', body: 'Create inspection checklists (ITPs) used for hold points before casting.' }}
        columns={[
          { key: 'code', label: 'Code', id: true },
          { key: 'name', label: 'Name' },
          { key: 'scope', label: 'Scope', value: (r) => (r.project_id ? 'This project' : 'Company-wide'), render: (r) => <Badge tone={r.project_id ? 'primary' : 'neutral'} label={r.project_id ? 'This project' : 'Company-wide'} icon={null} /> },
          { key: 'element_types', label: 'Element types', value: (r) => r.element_types.join(', ') || 'Any' },
          { key: 'hold_activities', label: 'Clears hold points', value: (r) => r.hold_activities.join(', ') },
          { key: 'items', label: 'Items', align: 'right', value: (r) => r.checklist_template_items.filter((i) => !i.deleted_at).length },
          { key: 'version', label: 'Version', align: 'right' },
          { key: 'is_active', label: 'Status', value: (r) => (r.is_active ? 'Active' : 'Inactive'), render: (r) => <SBadge value={r.is_active ? 'active' : 'inactive'} /> },
        ]} />
      {editing && <TemplateEditor tpl={editing === 'new' ? null : editing} canCompany={!!role && MGMT.includes(role)} onClose={() => setEditing(null)} />}
    </>
  );
}

function TemplateEditor({ tpl, canCompany, onClose }: { tpl: Tpl | null; canCompany: boolean; onClose: () => void }) {
  const projectId = useProjectId();
  const items = useAsync(async () => (tpl ? check(await supabase.from('checklist_template_items').select('*').eq('template_id', tpl.id).is('deleted_at', null).order('seq')) as ChecklistTemplateItem[] : []),
    [tpl?.id], { key: 'checklist-items' });
  const holds = useAsync(async () => check(await supabase.from('activity_templates').select('name, element_type').eq('is_hold_point', true).order('element_type')) as { name: string; element_type: string }[],
    [], { key: 'hold-activities', staleTime: 10 * 60_000 });
  const readOnly = !!tpl && !tpl.project_id && !canCompany;
  const [form, setForm] = useState({
    code: tpl?.code ?? '', name: tpl?.name ?? '', name_am: tpl?.name_am ?? '', description: tpl?.description ?? '',
    element_types: tpl?.element_types ?? [] as string[], hold_activities: (tpl?.hold_activities ?? []).join(', '),
    is_active: tpl?.is_active ?? true, company: tpl ? !tpl.project_id : false,
  });
  const [draft, setDraft] = useState<ItemDraft[] | null>(tpl ? null : [blank()]);
  const { busy, error, run } = useBusy();
  const list: ItemDraft[] = draft ?? (items.data ?? []).map((i) => ({
    id: i.id, text: i.text, text_am: i.text_am ?? '', item_type: i.item_type, min_value: i.min_value === null ? '' : String(i.min_value),
    max_value: i.max_value === null ? '' : String(i.max_value), unit: i.unit ?? '', photo_required: i.photo_required, is_critical: i.is_critical,
  }));
  const edit = (fn: (l: ItemDraft[]) => ItemDraft[]) => setDraft(fn([...list]));
  const setItem = (i: number, patch: Partial<ItemDraft>) => edit((l) => { l[i] = { ...l[i], ...patch }; return l; });
  const move = (i: number, d: number) => edit((l) => { const j = i + d; if (j < 0 || j >= l.length) return l; [l[i], l[j]] = [l[j], l[i]]; return l; });
  const holdOptions = [...new Set((holds.data ?? []).map((h) => h.name.toLowerCase()))];

  const save = () => run(async () => {
    if (!form.code.trim() || !form.name.trim()) throw new Error('Code and name are required.');
    const clean = list.filter((i) => i.text.trim());
    if (!clean.length) throw new Error('Add at least one checklist item.');
    await rpcx('save_checklist_template', {
      id: tpl?.id ?? uuid(), project_id: form.company ? null : projectId, code: form.code.trim(), name: form.name.trim(),
      name_am: optStr(form.name_am), description: optStr(form.description), element_types: form.element_types,
      hold_activities: form.hold_activities.split(',').map((s) => s.trim()).filter(Boolean), is_active: form.is_active,
      items: clean.map((i, n) => ({
        id: i.id, seq: n + 1, text: i.text.trim(), text_am: optStr(i.text_am), item_type: i.item_type,
        min_value: i.item_type === 'value' ? optNum(i.min_value) : undefined, max_value: i.item_type === 'value' ? optNum(i.max_value) : undefined,
        unit: i.item_type === 'value' ? optStr(i.unit) : undefined, photo_required: i.photo_required || i.item_type === 'photo', is_critical: i.is_critical,
      })),
    });
    toast.success(`Checklist ${form.code.trim()} saved`);
    onClose();
  });

  return (
    <Drawer size="lg" title={tpl ? `${tpl.code} — ${tpl.name}` : 'New checklist'} subtitle={tpl ? `Version ${tpl.version} · editing a used checklist creates a new version` : undefined}
      onClose={onClose} footer={<>
        <button onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && <button className="primary" disabled={busy || !items.data && !!tpl} onClick={() => void save()}>{busy && <span className="spinner" />}Save checklist</button>}
      </>}>
      <ErrorBanner error={error ?? items.error} />
      {readOnly && <Banner tone="info">Company-wide checklists can only be changed by coordinators, managers and administrators.</Banner>}
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="form-grid">
          <Field label="Code" required><input data-autofocus value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="PREPOUR-SLAB" /></Field>
          <Field label="Name" required><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Name (Amharic)"><input lang="am" value={form.name_am} onChange={(e) => setForm({ ...form, name_am: e.target.value })} /></Field>
          <Field label="Description" wide><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Applies to element types" wide hint="None ticked = any element type">
            <div className="check-list">
              {ELEMENT_TYPES.map((t) => (
                <label key={t}><input type="checkbox" checked={form.element_types.includes(t)}
                  onChange={(e) => setForm({ ...form, element_types: e.target.checked ? [...form.element_types, t] : form.element_types.filter((x) => x !== t) })} />{humanize(t)}</label>
              ))}
            </div>
          </Field>
          <Field label="Clears hold-point activities" wide hint={holdOptions.length ? `Comma-separated activity names. Hold points: ${holdOptions.join(', ')}` : 'Comma-separated activity names (hold points)'}>
            <input value={form.hold_activities} onChange={(e) => setForm({ ...form, hold_activities: e.target.value })} placeholder="rebar & formwork inspection" />
          </Field>
          <Field label="Active" check><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /></Field>
          {canCompany && !tpl && <Field label="Company-wide (all projects)" check><input type="checkbox" checked={form.company} onChange={(e) => setForm({ ...form, company: e.target.checked })} /></Field>}
        </div>
        <h3 className="mt-2">Items</h3>
        {tpl && !items.data && <Loading lines={4} />}
        <DataTable rows={list.map((x, i) => ({ ...x, _i: i }))} rowKey={(r) => r.id} maxHeight="none" virtual={false} columns={[
          { key: 'seq', label: '#', align: 'right', width: 36, sortable: false, value: (r) => r._i + 1 },
          { key: 'text', label: 'Check', sortable: false, render: (r) => <input aria-label={`Item ${r._i + 1} text`} value={r.text} onChange={(e) => setItem(r._i, { text: e.target.value })} style={{ width: '100%', minWidth: 220 }} /> },
          { key: 'item_type', label: 'Type', sortable: false, render: (r) => (
            <select aria-label="Type" value={r.item_type} onChange={(e) => setItem(r._i, { item_type: e.target.value as ChecklistItemType })}>
              {ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>) },
          { key: 'range', label: 'Tolerance', sortable: false, render: (r) => r.item_type !== 'value' ? <span className="muted-dash">—</span> : (
            <span className="nowrap">
              <input aria-label="Min" style={{ width: 60 }} value={r.min_value} onChange={(e) => setItem(r._i, { min_value: e.target.value })} placeholder="min" />–
              <input aria-label="Max" style={{ width: 60 }} value={r.max_value} onChange={(e) => setItem(r._i, { max_value: e.target.value })} placeholder="max" />
              <input aria-label="Unit" style={{ width: 50 }} value={r.unit} onChange={(e) => setItem(r._i, { unit: e.target.value })} placeholder="mm" />
            </span>) },
          { key: 'is_critical', label: 'Critical', align: 'center', sortable: false, render: (r) => <input type="checkbox" aria-label="Critical" checked={r.is_critical} onChange={(e) => setItem(r._i, { is_critical: e.target.checked })} /> },
          { key: 'photo_required', label: 'Photo', align: 'center', sortable: false, render: (r) => <input type="checkbox" aria-label="Photo required" checked={r.photo_required || r.item_type === 'photo'} disabled={r.item_type === 'photo'} onChange={(e) => setItem(r._i, { photo_required: e.target.checked })} /> },
          { key: 'ops', label: '', sortable: false, noExport: true, render: (r) => (
            <span className="nowrap">
              <button className="icon-btn" aria-label="Move up" disabled={r._i === 0} onClick={() => move(r._i, -1)}><ArrowUp size={14} /></button>
              <button className="icon-btn" aria-label="Move down" disabled={r._i === list.length - 1} onClick={() => move(r._i, 1)}><ArrowDown size={14} /></button>
              <button className="icon-btn" aria-label="Remove item" onClick={() => edit((l) => l.filter((_, j) => j !== r._i))}><Trash2 size={14} /></button>
            </span>) },
        ]} />
        <button className="mt-2" onClick={() => edit((l) => [...l, blank()])}><Plus size={14} aria-hidden />Add item</button>
        <p className="muted small-text">A failed <strong>critical</strong> item fails the inspection; failed non-critical items give a conditional pass (hold point still clears).</p>
      </fieldset>
    </Drawer>
  );
}

const blank = (): ItemDraft => ({ id: uuid(), text: '', text_am: '', item_type: 'yes_no', min_value: '', max_value: '', unit: '', photo_required: false, is_critical: false });
