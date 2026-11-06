import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCheck, Plus } from 'lucide-react';
import { useAuth, useProjectId } from '../lib/auth';
import { useAsync, useLookups } from '../lib/hooks';
import { fetchAll, rpc, supabase } from '../lib/supabase';
import type { MaterialRequest, MrStatus } from '../lib/contract';
import {
  PURCHASE_STATUS_LABELS, SITE_USE_STATUS_LABELS, canFlow, flowStatusLabel, nextActor, type FlowMrStatus, type MrWorkflowRow, type RequestType,
} from '../lib/contract-flows';
import { flowOpts, isMyTurn, isPurchase, safeRows, type FlowSettings } from '../lib/flows';
import { dueIn, shortDate, today, dateTime } from '../lib/format';
import { useUrlFilters, useUrlParam } from '../lib/url';
import { FlowPill, FlowStatusBadge } from '../components/flows/FlowTimeline';
import { PurchaseRequestForm } from '../components/flows/PurchaseRequestForm';
import { Badge, DataTable, ErrorBanner, FilterBar, FilterDate, FilterSelect, Page, PriorityBadge, SearchInput, Tabs, confirm, toast, type Column } from '../components/ui';

type MrRow = Pick<MaterialRequest, 'id' | 'number' | 'priority' | 'block_id' | 'requested_by' | 'required_date' | 'submitted_at' | 'is_lookahead' | 'purpose' | 'created_at' | 'store_id'>
  & { status: FlowMrStatus; request_type?: RequestType | null; source_mr_id?: string | null; issue_by?: string | null;
      mr_lines: { material_spec_id: string; exceeds_boq: boolean; deleted_at: string | null }[] };
type WfRow = Pick<MrWorkflowRow, 'id' | 'hours_in_status' | 'sla_hours' | 'is_overdue' | 'status_since' | 'source_number' | 'po_numbers'>;
type Row = MrRow & { type: RequestType; wf?: WfRow };

const PENDING: MrStatus[] = ['submitted', 'reviewed'];
const TERMINAL = ['closed', 'rejected', 'cancelled', 'draft'];
const SUR_OPEN = ['submitted', 'reviewed', 'approved', 'sourced', 'ordered', 'partially_issued', 'issued'];
const PR_BUYING = ['approved_by_management', 'approved', 'with_procurement', 'sourced', 'ordered', 'delivery_expected', 'partially_received'];
const RESET = { view: 'all', status: '', priority: '', block: '', requester: '', spec: '', from: '', to: '', q: '' };
type View = 'all' | 'action' | 'waiting' | 'urgent' | 'approved' | 'buying' | 'received' | 'overdue' | 'drafts';

/**
 * Request register split by flow (procurement-lookahead.md §2): site-use requests (issue from store)
 * and purchase requests (buy from a supplier). Stage column = compact FlowTimeline; "Needs my action" =
 * ball in court (nextActor) for the signed-in role.
 */
export function Requests() {
  const projectId = useProjectId();
  const auth = useAuth();
  const nav = useNavigate();
  const lk = useLookups(projectId);
  const settings = auth.settings as FlowSettings | null;
  const q = useAsync(async () => {
    const [rows, wf] = await Promise.all([
      fetchAll<MrRow>((a, b) => supabase.from('material_requests')
        .select('id, number, status, priority, block_id, requested_by, required_date, submitted_at, is_lookahead, purpose, created_at, store_id, request_type, source_mr_id, issue_by, mr_lines(material_spec_id, exceeds_boq, deleted_at)')
        .eq('project_id', projectId).order('created_at', { ascending: false }).range(a, b)),
      safeRows<WfRow>(supabase.from('v_mr_workflow').select('id, hours_in_status, sla_hours, is_overdue, status_since, source_number, po_numbers')
        .eq('project_id', projectId).not('status', 'in', '(closed,rejected,cancelled,draft)').limit(5000)),
    ]);
    const w = new Map(wf.map((x) => [x.id, x]));
    return rows.map((r): Row => ({ ...r, type: isPurchase(r) ? 'purchase' : 'site_use', wf: w.get(r.id) }));
  }, [projectId], { key: 'mr-register' });

  const [f, setF, { active, setMany }] = useUrlFilters({ type: 'site_use', view: 'all', status: '', priority: '', block: '', requester: '', spec: '', from: '', to: '', q: '' });
  const [newParam, setNewParam] = useUrlParam('new');
  const type: RequestType = f.type === 'purchase' ? 'purchase' : 'site_use';
  const role = auth.profile?.role ?? null;
  const me = auth.profile?.id;
  const t = today();
  const opts = flowOpts(settings);

  const mine = (r: Row) => !TERMINAL.includes(r.status) && r.status !== 'received' && isMyTurn(nextActor(r.status as FlowMrStatus, r.type, opts), { id: me, role }, r.requested_by);
  const inView = (r: Row, v: View) => {
    switch (v) {
      case 'action': return mine(r);
      case 'waiting': return !TERMINAL.includes(r.status) && r.status !== 'received' && !mine(r) && (r.requested_by === me || role !== 'site_engineer');
      case 'urgent': return r.priority !== 'normal' && !TERMINAL.includes(r.status) && r.status !== 'received';
      case 'approved': return ['approved', 'sourced', 'ordered', 'partially_issued'].includes(r.status);
      case 'buying': return PR_BUYING.includes(r.status);
      case 'received': return r.status === 'received' || (r.status === 'closed' && r.type === 'purchase');
      case 'overdue': return (r.type === 'purchase' ? [...PR_BUYING, 'submitted', 'reviewed_by_coordinator', 'reviewed'] : SUR_OPEN).includes(r.status) && (r.required_date < t || !!r.wf?.is_overdue);
      case 'drafts': return (r.status === 'draft' || r.status === 'returned') && r.requested_by === me;
      default: return true;
    }
  };
  const all = q.data ?? [];
  const ofType = useMemo(() => all.filter((r) => r.type === type), [all, type]);
  const VIEWS: View[] = type === 'purchase' ? ['action', 'waiting', 'buying', 'received', 'overdue', 'urgent', 'drafts', 'all'] : ['action', 'waiting', 'urgent', 'approved', 'overdue', 'drafts', 'all'];
  const view = (VIEWS.includes(f.view as View) ? f.view : 'all') as View;
  const viewCounts = useMemo(() => Object.fromEntries(VIEWS.map((v) => [v, ofType.filter((r) => inView(r, v)).length])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ofType, me, role, type, settings]);
  const typeCounts = useMemo(() => ({
    site_use: all.filter((r) => r.type === 'site_use' && mine(r)).length, purchase: all.filter((r) => r.type === 'purchase' && mine(r)).length,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [all, me, role, settings]);

  const term = f.q.toLowerCase();
  const rows = useMemo(() => ofType.filter((r) => inView(r, view) &&
    (!f.status || (f.status === 'pending' ? ['submitted', 'reviewed', 'reviewed_by_coordinator'].includes(r.status) : r.status === f.status)) &&
    (!f.priority || r.priority === f.priority) && (!f.block || r.block_id === f.block) && (!f.requester || r.requested_by === f.requester) &&
    (!f.spec || r.mr_lines.some((l) => !l.deleted_at && l.material_spec_id === f.spec)) &&
    (!f.from || r.required_date >= f.from) && (!f.to || r.required_date <= f.to) &&
    (!term || r.number.toLowerCase().includes(term) || (r.purpose ?? '').toLowerCase().includes(term))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [ofType, view, f.status, f.priority, f.block, f.requester, f.spec, f.from, f.to, term, me, role]);

  const L = lk.data;
  const purchase = type === 'purchase';
  const columns: Column<Row>[] = [
    { key: 'number', label: purchase ? 'PR' : 'Request', id: true },
    { key: 'status', label: 'Status', value: (r) => flowStatusLabel(r.status as FlowMrStatus, r.type), render: (r) => <FlowStatusBadge status={r.status} type={r.type} /> },
    { key: 'stage', label: 'Stage', value: (r) => r.wf?.hours_in_status ?? null, render: (r) => <FlowPill type={r.type} status={r.status} hours={r.wf?.hours_in_status} sla={r.wf?.sla_hours} settings={settings} /> },
    { key: 'priority', label: 'Priority', value: (r) => (r.priority === 'normal' ? '' : r.priority), render: (r) => <PriorityBadge value={r.priority} /> },
    { key: 'for', label: purchase ? 'For' : 'Block', value: (r) => (purchase ? r.purpose ?? (L?.block(r.block_id) || '') : L?.block(r.block_id)),
      render: (r) => (purchase ? <span className="ellipsis" title={r.purpose ?? undefined}>{r.purpose ?? (L?.block(r.block_id) || '—')}{r.source_mr_id && <> <Badge outline tone="info" label={`Shortfall${r.wf?.source_number ? ` of ${r.wf.source_number}` : ''}`} icon={null} /></>}</span> : L?.block(r.block_id)) },
    { key: 'requested_by', label: 'Requested by', value: (r) => L?.person(r.requested_by) },
    { key: 'required_date', label: 'Need by', value: (r) => r.required_date, render: (r) => {
      const due = !TERMINAL.includes(r.status) && r.status !== 'received' ? dueIn(r.required_date) : null;
      return <span className="nowrap">{shortDate(r.required_date)}{due?.text && <span className={`small-text ${due.late ? 'danger-text' : 'muted'}`}> · {due.text}</span>}</span>;
    } },
    { key: 'lines', label: 'Lines', align: 'right', value: (r) => r.mr_lines.filter((l) => !l.deleted_at).length,
      render: (r) => <>{r.mr_lines.filter((l) => !l.deleted_at).length}{r.mr_lines.some((l) => !l.deleted_at && l.exceeds_boq) && <> <Badge outline tone="danger" label="Over BoQ" icon={null} /></>}</> },
    ...(purchase ? [{ key: 'po', label: 'PO', value: (r: Row) => (r.wf?.po_numbers ?? []).join(', '), hidden: false }] : [{ key: 'issue_by', label: 'Issue by', hidden: true, value: (r: Row) => r.issue_by ?? '' }]),
    { key: 'materials', label: 'Materials', hidden: true, value: (r) => r.mr_lines.filter((l) => !l.deleted_at).map((l) => L?.spec(l.material_spec_id)).join(', ') },
    { key: 'purpose', label: 'Purpose', hidden: true },
    { key: 'submitted_at', label: 'Submitted', hidden: true, value: (r) => r.submitted_at, render: (r) => dateTime(r.submitted_at) },
    { key: 'is_lookahead', label: 'Look-ahead', hidden: true, value: (r) => (r.is_lookahead ? 'Yes' : '') },
  ];

  const canBulk = !purchase && canFlow(role, 'sur.approve');
  const bulkApprove = async (sel: Row[], clearSel: () => void) => {
    if (!(await confirm({ title: `Approve ${sel.length} request${sel.length === 1 ? '' : 's'} in full?`, body: <p className="muted mb-0">Every line is approved at the reviewed / requested quantity as a store order from the request's store. Open a request to approve partially or choose a store and issue-by date.</p>, confirm: `Approve ${sel.length}` }))) return;
    let ok = 0;
    for (const r of sel) {
      try { await rpc('mr_action', { mr_id: r.id, action: 'approve' }); ok++; } catch (e) { toast.error(`${r.number}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (ok) toast.success(`${ok} request${ok === 1 ? '' : 's'} approved`);
    clearSel();
  };

  const VIEW_LABEL: Record<View, string> = {
    all: 'All', action: 'Needs my action', waiting: 'Waiting on others', urgent: 'Urgent / critical', approved: 'Store orders not fully issued',
    buying: 'In purchase', received: 'Received', overdue: 'Overdue', drafts: 'My drafts & returned',
  };
  const canCreatePr = canFlow(role, 'pr.create');
  const tabs = VIEWS.filter((v) => v !== 'drafts' || (purchase ? canCreatePr : auth.can('mr.create'))).map((key) => ({ key, label: VIEW_LABEL[key] }));
  const filterActive = active - (f.view !== 'all' ? 1 : 0) - (f.type !== 'site_use' ? 1 : 0);
  const statusOpts = Object.entries(purchase ? PURCHASE_STATUS_LABELS : SITE_USE_STATUS_LABELS).filter(([k]) => k !== 'reviewed' || !purchase).filter(([k]) => k !== 'approved' || !purchase);
  const canCreateMr = auth.can('mr.create');
  const showForm = newParam === 'pr' && canCreatePr && !!L;
  const showMrForm = newParam === 'mr' && canCreateMr && !!L;

  return (
    <Page title="Material requests" subtitle={purchase ? 'Purchase requests — buy from a supplier: coordinator → management → procurement → store' : 'Site-use requests — issue from store: office engineer → coordinator (store order) → store keeper'}
      actions={canCreatePr || canCreateMr ? <>
        {canCreateMr && <button className={purchase ? '' : 'primary'} onClick={() => setNewParam('mr', true)}><Plus size={14} aria-hidden />New site-use request</button>}
        {canCreatePr && <button className={purchase ? 'primary' : ''} onClick={() => setNewParam('pr', true)}><Plus size={14} aria-hidden />New purchase request</button>}
      </> : undefined}>
      <Tabs label="Request type" variant="segmented" value={type} onChange={(v) => setMany({ ...RESET, type: v })} tabs={[
        { key: 'site_use', label: 'Site-use requests', count: typeCounts.site_use || undefined, hot: true },
        { key: 'purchase', label: 'Purchase requests', count: typeCounts.purchase || undefined, hot: true },
      ]} />
      <Tabs label="Saved views" value={view} onChange={(v) => setF('view', v)} tabs={tabs.map((x) => ({ ...x, count: viewCounts[x.key], hot: x.key === 'action' || x.key === 'overdue' }))} />
      <ErrorBanner error={q.error ?? lk.error} onRetry={q.reload} />
      <FilterBar active={filterActive} onClear={() => setMany({ ...RESET, view: f.view })}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder={purchase ? 'Search PR no., purpose' : 'Search MR no., purpose'} />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)}
          options={[{ value: 'pending', label: 'Awaiting review/approval' }, ...statusOpts.map(([k, v]) => ({ value: k, label: v }))]} />
        <FilterSelect label="Priority" value={f.priority} onChange={(v) => setF('priority', v)} options={[{ value: 'normal', label: 'Normal' }, { value: 'urgent', label: 'Urgent' }, { value: 'critical', label: 'Critical' }]} />
        <FilterSelect label="Block" value={f.block} onChange={(v) => setF('block', v)} options={(L?.blocks ?? []).map((b) => ({ value: b.id, label: b.code }))} />
        <FilterSelect label="Requester" value={f.requester} onChange={(v) => setF('requester', v)} options={(L?.profiles ?? []).map((p) => ({ value: p.id, label: p.full_name || p.email || p.id }))} />
        <FilterSelect label="Material" value={f.spec} onChange={(v) => setF('spec', v)} options={(L?.specs ?? []).map((s) => ({ value: s.id, label: s.label }))} />
        <FilterDate label="Needed from" value={f.from} onChange={(v) => setF('from', v)} />
        <FilterDate label="to" value={f.to} onChange={(v) => setF('to', v)} />
      </FilterBar>
      <DataTable rows={rows} columns={columns} loading={!q.data || !L} error={q.error} onRetry={q.reload} urlKey="" viewKey={purchase ? 'requests-pr' : 'requests'} stickyFirst
        exportName={purchase ? 'purchase-request-register' : 'site-use-request-register'} onRowClick={(r) => nav(`/requests/${r.id}`)}
        filtered={filterActive > 0 || view !== 'all'} onClearFilters={() => setMany(RESET)}
        empty={purchase
          ? { title: 'No purchase requests yet', body: 'Office engineers raise purchase requests for materials to buy; shortfalls of site-use requests appear here too.', action: canCreatePr ? <button className="primary" onClick={() => setNewParam('pr', true)}><Plus size={14} aria-hidden />New purchase request</button> : undefined }
          : { title: 'No site-use requests yet', body: 'Requests raised on site (here or in the mobile app) appear here for review and approval.',
            action: canCreateMr ? <button className="primary" onClick={() => setNewParam('mr', true)}><Plus size={14} aria-hidden />New site-use request</button> : undefined }}
        selectable={canBulk}
        bulkActions={canBulk ? (sel, clearSel) => {
          const blocked = sel.some((r) => !(PENDING as string[]).includes(r.status) || r.mr_lines.some((l) => !l.deleted_at && l.exceeds_boq));
          return <button className="small primary" disabled={blocked} title={blocked ? 'Only submitted/reviewed requests without over-BoQ lines can be bulk-approved' : undefined}
            onClick={() => void bulkApprove(sel, clearSel)}><CheckCheck size={14} aria-hidden />Approve in full</button>;
        } : undefined} />
      {showForm && <PurchaseRequestForm projectId={projectId} L={L!} onClose={() => setNewParam(null)} onSaved={(id) => { setNewParam(null); nav(`/requests/${id}`); }} />}
      {showMrForm && <PurchaseRequestForm type="site_use" projectId={projectId} L={L!} onClose={() => setNewParam(null)} onSaved={(id) => { setNewParam(null); nav(`/requests/${id}`); }} />}
    </Page>
  );
}
