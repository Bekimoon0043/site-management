import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { canField, type ChecklistTemplate, type Inspection } from '../../lib/contract-field';
import { nextNumber, optStr, rpcx, uuid } from '../../lib/fieldx';
import { date, dateTime } from '../../lib/format';
import { useUrlFilters } from '../../lib/url';
import { SBadge } from '../../components/field/StatusBadge';
import { DataTable, Drawer, ErrorBanner, Field, FilterBar, FilterDate, FilterSelect, SearchInput, toast, useBusy } from '../../components/ui';

export type InspRow = Inspection & { checklist_templates: { code: string; name: string } | null };

/** Active templates visible to the project (project-specific + company-wide). */
export function useTemplates(projectId: string) {
  return useAsync(async () => check(await supabase.from('checklist_templates').select('*, checklist_template_items(id, deleted_at)')
    .or(`project_id.is.null,project_id.eq.${projectId}`).is('deleted_at', null).order('code')) as (ChecklistTemplate & { checklist_template_items: { id: string; deleted_at: string | null }[] })[],
  [projectId], { key: 'checklist-templates' });
}

export function InspectionsTab() {
  const projectId = useProjectId();
  const auth = useAuth();
  const nav = useNavigate();
  const lk = useLookups(projectId);
  const tpl = useTemplates(projectId);
  const q = useAsync(() => fetchAll<InspRow>((a, b) => supabase.from('inspections').select('*, checklist_templates(code, name)')
    .eq('project_id', projectId).order('created_at', { ascending: false }).range(a, b)), [projectId], { key: 'inspections' });
  const [f, setF, { active, clear }] = useUrlFilters({ status: '', result: '', template: '', block: '', element: '', from: '', to: '', q: '' }, 'i_');
  const [creating, setCreating] = useState(false);
  const L = lk.data;
  const term = f.q.toLowerCase();
  const rows = useMemo(() => (q.data ?? []).filter((r) => {
    const el = L?.elements.find((e) => e.id === r.element_id);
    const day = (r.inspected_at ?? r.requested_at ?? r.created_at).slice(0, 10);
    return (!f.status || r.status === f.status) && (!f.result || r.result === f.result) && (!f.template || r.template_id === f.template)
      && (!f.element || r.element_id === f.element) && (!f.block || el?.block_id === f.block)
      && (!f.from || day >= f.from) && (!f.to || day <= f.to)
      && (!term || r.number.toLowerCase().includes(term) || (L?.element(r.element_id) ?? '').toLowerCase().includes(term) || (r.consultant_name ?? '').toLowerCase().includes(term));
  }), [q.data, L, f.status, f.result, f.template, f.element, f.block, f.from, f.to, term]);

  return (
    <>
      <ErrorBanner error={q.error ?? lk.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={clear}
        right={canField(auth.profile?.role, 'inspection.request') && <button className="primary" onClick={() => setCreating(true)}><Plus size={14} aria-hidden />Request inspection</button>}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Inspection no., element, consultant" />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={[{ value: 'requested', label: 'Requested' }, { value: 'completed', label: 'Completed' }, { value: 'cancelled', label: 'Cancelled' }]} />
        <FilterSelect label="Result" value={f.result} onChange={(v) => setF('result', v)} options={[{ value: 'pass', label: 'Pass' }, { value: 'conditional', label: 'Conditional' }, { value: 'fail', label: 'Fail' }]} />
        <FilterSelect label="Checklist" value={f.template} onChange={(v) => setF('template', v)} options={(tpl.data ?? []).map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` }))} />
        <FilterSelect label="Block" value={f.block} onChange={(v) => setF('block', v)} options={(L?.blocks ?? []).map((b) => ({ value: b.id, label: b.code }))} />
        <FilterSelect label="Element" value={f.element} onChange={(v) => setF('element', v)} options={(L?.elements ?? []).map((e) => ({ value: e.id, label: L!.element(e.id) }))} />
        <FilterDate label="From" value={f.from} onChange={(v) => setF('from', v)} />
        <FilterDate label="to" value={f.to} onChange={(v) => setF('to', v)} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data || !L} error={q.error} onRetry={q.reload} urlKey="i_" stickyFirst exportName="inspections" viewKey="inspections"
        filtered={active > 0} onClearFilters={clear} onRowClick={(r) => nav(`/quality/inspections/${r.id}`)}
        empty={{ title: 'No inspections yet', body: 'Inspections requested and performed on site appear here with their results.' }}
        columns={[
          { key: 'number', label: 'Inspection', id: true },
          { key: 'template', label: 'Checklist', value: (r) => r.checklist_templates ? `${r.checklist_templates.code} — ${r.checklist_templates.name}` : '' },
          { key: 'element', label: 'Element', value: (r) => L?.element(r.element_id) },
          { key: 'status', label: 'Status', render: (r) => <SBadge value={r.status} /> },
          { key: 'result', label: 'Result', value: (r) => r.result ?? '', render: (r) => <SBadge value={r.result} /> },
          { key: 'requested_for', label: 'Requested for', value: (r) => r.requested_for, render: (r) => dateTime(r.requested_for) },
          { key: 'inspected_at', label: 'Inspected', value: (r) => r.inspected_at, render: (r) => dateTime(r.inspected_at) },
          { key: 'inspector', label: 'Inspector', value: (r) => L?.person(r.inspector_id) },
          { key: 'consultant_name', label: 'Consultant' },
          { key: 'requested_by', label: 'Requested by', hidden: true, value: (r) => L?.person(r.requested_by) },
          { key: 'reinspection', label: 'Re-inspection', hidden: true, value: (r) => (r.reinspection_of ? 'Yes' : '') },
          { key: 'created_at', label: 'Created', hidden: true, value: (r) => r.created_at, render: (r) => date(r.created_at) },
        ]} />
      {creating && <RequestInspectionDrawer onClose={() => setCreating(false)} onDone={(id) => nav(`/quality/inspections/${id}`)} />}
    </>
  );
}

function RequestInspectionDrawer({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const tpl = useTemplates(projectId);
  const [form, setForm] = useState({ template_id: '', element_id: '', requested_for: '', remarks: '' });
  const { busy, error, run } = useBusy();
  const L = lk.data;
  const el = L?.elements.find((e) => e.id === form.element_id);
  const templates = (tpl.data ?? []).filter((t) => t.is_active && (!el || !t.element_types.length || t.element_types.includes(String(el.element_type).toLowerCase())));
  const save = () => run(async () => {
    if (!form.template_id || !form.element_id) throw new Error('Choose an element and a checklist.');
    const id = uuid();
    const number = await nextNumber(auth.project?.code ?? 'PRJ', 'INS', 'inspections');
    await rpcx('request_inspection', { id, project_id: projectId, number, template_id: form.template_id, element_id: form.element_id,
      requested_for: form.requested_for ? new Date(form.requested_for).toISOString() : undefined, remarks: optStr(form.remarks) });
    toast.success(`${number} requested`);
    onDone(id);
  });
  return (
    <Drawer title="Request inspection" onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Request</button>
    </>}>
      <ErrorBanner error={error ?? tpl.error} />
      <div className="form-grid one">
        <Field label="Element" required>
          <select data-autofocus value={form.element_id} onChange={(e) => setForm({ ...form, element_id: e.target.value })}>
            <option value="">Choose…</option>
            {(L?.elements ?? []).map((e) => <option key={e.id} value={e.id}>{L!.element(e.id)} · {e.element_type}</option>)}
          </select>
        </Field>
        <Field label="Checklist" required hint={el ? `Checklists for ${el.element_type} elements` : undefined}>
          <select value={form.template_id} onChange={(e) => setForm({ ...form, template_id: e.target.value })}>
            <option value="">Choose…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
          </select>
        </Field>
        <Field label="Requested for"><input type="datetime-local" value={form.requested_for} onChange={(e) => setForm({ ...form, requested_for: e.target.value })} /></Field>
        <Field label="Remarks"><textarea rows={3} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} /></Field>
      </div>
    </Drawer>
  );
}
