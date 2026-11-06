import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { invalidateAfterWrite } from '../../lib/query';
import { ROLE_LABELS, type AppRole } from '../../lib/contract';
import { canFlow, type ApprovalDelegation, type ApprovalDocType, type ProjectSettingsFlowFields } from '../../lib/contract-flows';
import { flowRpc } from '../../lib/flows';
import { date, money, today } from '../../lib/format';
import { Badge } from '../Badge';
import { DataTable } from '../DataTable';
import { Card, Empty, ErrorBanner, Loading } from '../Page';
import { Field, useBusy } from '../Form';
import { Modal, confirm } from '../Dialog';
import { toast } from '../toast';

const PR_SLA: [string, string][] = [['submitted', 'Coordinator review'], ['reviewed_by_coordinator', 'Management approval'], ['approved_by_management', 'Procurement accepts'],
  ['with_procurement', 'Sourcing (RFQ / PO)'], ['delivery_overdue', 'Delivery overdue after ETA']];
const SUR_SLA: [string, string][] = [['submitted', 'Office engineer review'], ['reviewed', 'Coordinator approval'], ['approved', 'Store keeper issues'],
  ['issued', 'Site engineer acknowledges'], ['issued_unacked', 'Unacknowledged issue']];
const DOC_LABEL: Record<ApprovalDocType, string> = { any: 'Any document', purchase_request: 'Purchase requests', site_use: 'Site-use requests', po: 'Purchase orders' };

type Form = Omit<ProjectSettingsFlowFields, 'pr_coordinator_final_limit'> & { pr_coordinator_final_limit: string };

/** Project settings for the two procurement flows (20261030000002_mr_flows.sql §1). Nothing hard-coded: routing, limits, SLA hours. */
export function FlowSettingsCard({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const auth = useAuth();
  const q = useAsync(async () => check(await supabase.from('project_settings').select('*').eq('project_id', projectId).maybeSingle()) as Partial<ProjectSettingsFlowFields> | null,
    [projectId], { key: 'flow-settings' });
  const [form, setForm] = useState<Form | null>(null);
  const [dirty, setDirty] = useState(false);
  const { busy, error, run } = useBusy();
  useEffect(() => {
    const s = q.data;
    if (!s) return;
    setForm({
      wf_sla_hours: { pr: { ...(s.wf_sla_hours?.pr ?? {}) }, sur: { ...(s.wf_sla_hours?.sur ?? {}) } },
      pr_require_coordinator_review: s.pr_require_coordinator_review ?? true, pr_coordinator_final_limit: s.pr_coordinator_final_limit === null || s.pr_coordinator_final_limit === undefined ? '' : String(s.pr_coordinator_final_limit),
      direct_purchase_limit: Number(s.direct_purchase_limit ?? 0), po_tolerance_pct: Number(s.po_tolerance_pct ?? 10), po_auto_approve: s.po_auto_approve ?? true,
      delivery_notice_days: Number(s.delivery_notice_days ?? 2), pr_requires_elements: s.pr_requires_elements ?? false, sur_auto_close_hours: Number(s.sur_auto_close_hours ?? 24),
    });
  }, [q.data]);
  if (!form) return q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading />;
  const upd = (p: Partial<Form>) => { setForm({ ...form, ...p }); setDirty(true); };
  const sla = (flow: 'pr' | 'sur', k: string, v: string) => upd({ wf_sla_hours: { ...form.wf_sla_hours, [flow]: { ...form.wf_sla_hours[flow], [k]: v === '' ? undefined : Number(v) } } });
  const save = () => run(async () => {
    check(await supabase.from('project_settings').update({
      wf_sla_hours: form.wf_sla_hours, pr_require_coordinator_review: form.pr_require_coordinator_review,
      pr_coordinator_final_limit: form.pr_coordinator_final_limit === '' ? null : Number(form.pr_coordinator_final_limit),
      direct_purchase_limit: Number(form.direct_purchase_limit) || 0, po_tolerance_pct: Number(form.po_tolerance_pct) || 0, po_auto_approve: form.po_auto_approve,
      delivery_notice_days: Number(form.delivery_notice_days) || 0, pr_requires_elements: form.pr_requires_elements, sur_auto_close_hours: Number(form.sur_auto_close_hours) || 0,
    }).eq('project_id', projectId));
    setDirty(false);
    toast.success('Procurement flow settings saved');
    invalidateAfterWrite();
    void auth.reload();
  });
  const n = (v: number | string, set: (s: string) => void, step = '1') => <input type="number" min={0} step={step} disabled={!canEdit} value={v} onChange={(e) => set(e.target.value)} />;
  return (
    <Card title="Procurement flows" sub="Purchase requests (buy) and site-use requests (issue from store): routing, limits and response times">
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Coordinator reviews purchase requests before management" check>
          <input type="checkbox" disabled={!canEdit} checked={form.pr_require_coordinator_review} onChange={(e) => upd({ pr_require_coordinator_review: e.target.checked })} />
        </Field>
        <Field label="Auto-approve POs fully traced to approved purchase requests" check hint={`Within ${form.po_tolerance_pct}% of the PR estimate`}>
          <input type="checkbox" disabled={!canEdit} checked={form.po_auto_approve} onChange={(e) => upd({ po_auto_approve: e.target.checked })} />
        </Field>
        <Field label="Purchase lines must link a structural element (BoQ)" check>
          <input type="checkbox" disabled={!canEdit} checked={form.pr_requires_elements} onChange={(e) => upd({ pr_requires_elements: e.target.checked })} />
        </Field>
        <Field label={`Coordinator may finally approve PRs up to (${auth.project?.currency ?? 'ETB'})`} hint="Blank = management always approves (client flow)">
          <input type="number" min={0} step="any" disabled={!canEdit} value={form.pr_coordinator_final_limit} placeholder="Management always" onChange={(e) => upd({ pr_coordinator_final_limit: e.target.value })} />
        </Field>
        <Field label={`Direct purchase limit incl. VAT (${auth.project?.currency ?? 'ETB'})`} hint="0 = direct (cash) purchase switched off">
          {n(form.direct_purchase_limit, (v) => upd({ direct_purchase_limit: Number(v) }), 'any')}
        </Field>
        <Field label="PO price tolerance vs estimate (%)">{n(form.po_tolerance_pct, (v) => upd({ po_tolerance_pct: Number(v) }), 'any')}</Field>
        <Field label="Delivery notice expected (days before)">{n(form.delivery_notice_days, (v) => upd({ delivery_notice_days: Number(v) }))}</Field>
        <Field label="Auto-close received site-use requests after (hours)">{n(form.sur_auto_close_hours, (v) => upd({ sur_auto_close_hours: Number(v) }))}</Field>
      </div>
      <h3>Response time per step (SLA hours — halved for urgent/critical)</h3>
      <div className="form-grid">
        {PR_SLA.map(([k, label]) => <Field key={`pr${k}`} label={`Purchase · ${label}`}>{n(form.wf_sla_hours.pr[k] ?? '', (v) => sla('pr', k, v))}</Field>)}
        {SUR_SLA.map(([k, label]) => <Field key={`sur${k}`} label={`Site use · ${label}`}>{n(form.wf_sla_hours.sur[k] ?? '', (v) => sla('sur', k, v))}</Field>)}
      </div>
      {canEdit && (
        <div className="save-bar mt-4">
          <span className="grow">{dirty ? 'Unsaved changes' : ''}</span>
          <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy && <span className="spinner" />}Save flow settings</button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Approval limits (BR-08 extended: per document type, optional per person)
// ---------------------------------------------------------------------------
interface LimitRow { id: string; project_id: string | null; role: AppRole; doc_type: ApprovalDocType; user_id: string | null; max_value: number }
export function ApprovalLimitsCard({ projectId }: { projectId: string }) {
  const auth = useAuth();
  const lk = useLookups(projectId);
  const canEdit = auth.profile?.role === 'manager' || auth.profile?.role === 'admin';
  const q = useAsync(async () => check(await supabase.from('approval_limits').select('*').or(`project_id.eq.${projectId},project_id.is.null`).order('doc_type').order('role')) as LimitRow[],
    [projectId], { key: 'approval-limits' });
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const { busy, error, run } = useBusy();
  const save = (r: LimitRow) => run(async () => {
    const v = Number(edit[r.id]);
    if (!Number.isFinite(v) || v < 0) throw new Error('Enter a valid amount');
    check(await supabase.from('approval_limits').update({ max_value: v }).eq('id', r.id));
    setEdit((e) => { const n = { ...e }; delete n[r.id]; return n; });
    toast.success('Limit saved'); q.reload();
  });
  const remove = async (r: LimitRow) => {
    if (!(await confirm({ title: 'Remove this limit?', body: <p className="muted mb-0">Without a matching row the role is unlimited for this document type.</p>, danger: true, confirm: 'Remove' }))) return;
    await run(async () => { check(await supabase.from('approval_limits').delete().eq('id', r.id)); q.reload(); });
  };
  const cur = auth.project?.currency;
  return (
    <Card title="Approval limits" sub="Value an approver may approve per document; above it the request is endorsed up to a covering approver. No row = unlimited."
      actions={canEdit ? <button className="small" onClick={() => setAdd(true)}><Plus size={14} aria-hidden />Add limit</button> : undefined} flush>
      <ErrorBanner error={error ?? q.error} />
      <DataTable rows={q.data ?? []} loading={!q.data} maxHeight="none" empty="No limits — every approver is unlimited." columns={[
        { key: 'doc_type', label: 'Document', value: (r) => DOC_LABEL[r.doc_type] ?? r.doc_type },
        { key: 'role', label: 'Role', value: (r) => ROLE_LABELS[r.role] ?? r.role },
        { key: 'user', label: 'Person', value: (r) => (r.user_id ? lk.data?.person(r.user_id) : 'Everyone in role') },
        { key: 'scope', label: 'Scope', render: (r) => (r.project_id ? <Badge tone="primary" label="This project" icon={null} /> : <Badge tone="neutral" label="Company default" icon={null} />) },
        { key: 'max_value', label: 'Limit', align: 'right', render: (r) => (canEdit
          ? <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
              <input type="number" min={0} step="any" style={{ width: 140 }} aria-label="Limit" value={edit[r.id] ?? String(r.max_value)} onChange={(e) => setEdit({ ...edit, [r.id]: e.target.value })} />
              {edit[r.id] !== undefined && <button className="small primary" disabled={busy} onClick={() => void save(r)}>Save</button>}
            </span>
          : money(r.max_value, cur)) },
        { key: 'x', label: '', noExport: true, render: (r) => (canEdit ? <button className="icon-btn sm" aria-label="Remove limit" onClick={() => void remove(r)}><Trash2 size={14} /></button> : null) },
      ]} />
      {add && lk.data && <AddLimitModal projectId={projectId} profiles={lk.data.profiles} onClose={() => setAdd(false)} onDone={q.reload} />}
    </Card>
  );
}

function AddLimitModal({ projectId, profiles, onClose, onDone }: { projectId: string; profiles: { id: string; full_name: string; role: AppRole; is_active: boolean }[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ role: 'coordinator' as AppRole, doc_type: 'purchase_request' as ApprovalDocType, user_id: '', max_value: '', scope: 'project' });
  const { busy, error, run } = useBusy();
  const go = () => run(async () => {
    if (!(Number(f.max_value) >= 0) || f.max_value === '') throw new Error('Enter the limit amount');
    check(await supabase.from('approval_limits').insert({ project_id: f.scope === 'project' ? projectId : null, role: f.role, doc_type: f.doc_type, user_id: f.user_id || null, max_value: Number(f.max_value) }));
    toast.success('Limit added'); onDone(); onClose();
  });
  return (
    <Modal title="Add approval limit" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={() => void go()}>{busy && <span className="spinner" />}Add</button></>}>
      <div className="stack tight">
        <ErrorBanner error={error} />
        <div className="form-grid">
          <Field label="Document"><select value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value as ApprovalDocType })}>{Object.entries(DOC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Role"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as AppRole })}>{(['coordinator', 'manager', 'admin', 'procurement', 'office_engineer'] as AppRole[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></Field>
          <Field label="Person (optional)"><select value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })}>
            <option value="">Everyone in the role</option>
            {profiles.filter((p) => p.is_active && p.role === f.role).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select></Field>
          <Field label="Scope"><select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="project">This project</option><option value="company">Company default</option></select></Field>
          <Field label="Maximum value" required><input type="number" min={0} step="any" value={f.max_value} onChange={(e) => setF({ ...f, max_value: e.target.value })} data-autofocus /></Field>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Approval cover (save_approval_delegation): e.g. manager on leave
// ---------------------------------------------------------------------------
export function DelegationsCard({ projectId }: { projectId: string | null }) {
  const auth = useAuth();
  const lk = useLookups(projectId ?? '');
  const me = auth.profile?.id;
  const isMgmt = auth.profile?.role === 'manager' || auth.profile?.role === 'admin';
  const q = useAsync(async () => check(await supabase.from('approval_delegations').select('*').order('valid_from', { ascending: false }).limit(200)) as ApprovalDelegation[],
    [me], { key: 'delegations' });
  const [open, setOpen] = useState(false);
  const { error, run } = useBusy();
  if (!canFlow(auth.profile?.role, 'delegation.save')) return null;
  const t = today();
  const state = (d: ApprovalDelegation) => (d.revoked_at ? 'revoked' : d.valid_to < t ? 'expired' : d.valid_from > t ? 'scheduled' : 'active');
  const revoke = async (d: ApprovalDelegation) => {
    if (!(await confirm({ title: 'Revoke this delegation?', danger: true, confirm: 'Revoke' }))) return;
    await run(async () => { await flowRpc('save_approval_delegation', { id: d.id, revoke: true }); toast.success('Delegation revoked'); q.reload(); });
  };
  const L = lk.data;
  return (
    <Card title="Approval cover (delegations)" sub="While you are away, a colleague approves on your behalf with your role and limit. Every sign-off records “for you”."
      actions={<button className="small" onClick={() => setOpen(true)}><Plus size={14} aria-hidden />Delegate…</button>} flush>
      <ErrorBanner error={error ?? q.error} />
      {!q.data ? <Loading lines={2} /> : !q.data.length ? <Empty inline>No delegations.</Empty> : (
        <DataTable rows={q.data} maxHeight="none" columns={[
          { key: 'from', label: 'From', value: (d) => L?.person(d.from_user) },
          { key: 'to', label: 'To', value: (d) => L?.person(d.to_user) },
          { key: 'doc', label: 'Covers', value: (d) => DOC_LABEL[d.doc_type] },
          { key: 'when', label: 'Period', value: (d) => d.valid_from, render: (d) => `${date(d.valid_from)} – ${date(d.valid_to)}` },
          { key: 'scope', label: 'Project', value: (d) => (d.project_id ? auth.projects.find((p) => p.id === d.project_id)?.code ?? '' : 'All projects') },
          { key: 'reason', label: 'Reason' },
          { key: 'state', label: 'Status', render: (d) => { const s = state(d); return <Badge tone={s === 'active' ? 'success' : s === 'scheduled' ? 'info' : 'neutral'} label={s} icon={null} />; } },
          { key: 'x', label: '', noExport: true, render: (d) => (!d.revoked_at && d.valid_to >= t && (d.from_user === me || d.created_by === me || isMgmt)
            ? <button className="small" onClick={() => void revoke(d)}>Revoke</button> : null) },
        ]} />
      )}
      {open && L && <DelegateModal projectId={projectId} L={L} onClose={() => setOpen(false)} onDone={q.reload} />}
    </Card>
  );
}

function DelegateModal({ projectId, L, onClose, onDone }: { projectId: string | null; L: NonNullable<ReturnType<typeof useLookups>['data']>; onClose: () => void; onDone: () => void }) {
  const auth = useAuth();
  const me = auth.profile?.id ?? '';
  const isMgmt = auth.profile?.role === 'manager' || auth.profile?.role === 'admin';
  const [f, setF] = useState({ from_user: me, to_user: '', doc_type: 'any' as ApprovalDocType, valid_from: today(), valid_to: '', reason: '', scope: projectId ? 'project' : 'all' });
  const { busy, error, run } = useBusy();
  const go = () => run(async () => {
    if (!f.to_user) throw new Error('Choose who covers');
    if (!f.valid_to || f.valid_to < f.valid_from) throw new Error('Choose a valid end date');
    if (!f.reason.trim()) throw new Error('A reason is required');
    await flowRpc('save_approval_delegation', { id: crypto.randomUUID(), from_user: f.from_user !== me ? f.from_user : undefined, to_user: f.to_user,
      project_id: f.scope === 'project' ? projectId : null, doc_type: f.doc_type, valid_from: f.valid_from, valid_to: f.valid_to, reason: f.reason.trim() });
    toast.success(`Approvals delegated to ${L.person(f.to_user)} until ${date(f.valid_to)}`);
    onDone(); onClose();
  });
  const people = L.profiles.filter((p) => p.is_active && p.id !== f.from_user);
  return (
    <Modal size="md" title="Delegate approvals" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={() => void go()}>{busy && <span className="spinner" />}Delegate</button></>}>
      <div className="stack tight">
        <ErrorBanner error={error} />
        <div className="form-grid">
          {isMgmt && <Field label="On behalf of"><select value={f.from_user} onChange={(e) => setF({ ...f, from_user: e.target.value })}>
            {L.profiles.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.id === me ? ' (me)' : ''} — {ROLE_LABELS[p.role]}</option>)}
          </select></Field>}
          <Field label="Covered by" required><select value={f.to_user} onChange={(e) => setF({ ...f, to_user: e.target.value })} data-autofocus>
            <option value="">Choose…</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name} — {ROLE_LABELS[p.role]}</option>)}
          </select></Field>
          <Field label="Covers"><select value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value as ApprovalDocType })}>{Object.entries(DOC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Projects"><select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>
            {projectId && <option value="project">This project only</option>}<option value="all">All my projects</option>
          </select></Field>
          <Field label="From" required><input type="date" value={f.valid_from} onChange={(e) => setF({ ...f, valid_from: e.target.value })} /></Field>
          <Field label="Until" required><input type="date" min={f.valid_from} value={f.valid_to} onChange={(e) => setF({ ...f, valid_to: e.target.value })} /></Field>
          <Field label="Reason" required wide><input value={f.reason} placeholder="e.g. Annual leave" onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        </div>
      </div>
    </Modal>
  );
}
