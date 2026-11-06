import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, FilePlus2, ShoppingCart } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { fetchAll, supabase } from '../../lib/supabase';
import { canFlow, type FlowMrStatus, type PrTrackerRow } from '../../lib/contract-flows';
import { flowRpc, safeRows } from '../../lib/flows';
import { dueIn, qty, shortDate } from '../../lib/format';
import { useUrlFilters } from '../../lib/url';
import { FlowStatusBadge } from '../../components/flows/FlowTimeline';
import { DirectPurchaseModal, RfqFromPrsModal, type PrLinePick } from '../../components/flows/FlowDialogs';
import { DataTable, ErrorBanner, FilterBar, FilterSelect, PriorityBadge, SearchInput, Tabs, confirm, toast, type Column } from '../../components/ui';

type Head = { id: string; required_date: string; store_id: string | null; procurement_owner: string | null; requested_by: string };
type Row = PrTrackerRow & { head?: Head; toSource: number };
type Stage = 'accept' | 'source' | 'ordered' | 'delivery' | 'pending' | 'all';
const ACCEPT: FlowMrStatus[] = ['approved_by_management', 'approved'];
const BUYING: FlowMrStatus[] = ['approved_by_management', 'approved', 'with_procurement', 'sourced', 'ordered', 'partially_received'];

const stageOf = (r: Row): Stage => {
  if (ACCEPT.includes(r.status)) return 'accept';
  if (r.status === 'delivery_expected') return 'delivery';
  if (['submitted', 'reviewed_by_coordinator', 'reviewed'].includes(r.status)) return 'pending';
  if (r.toSource > 0.0005 && BUYING.includes(r.status)) return 'source';
  return 'ordered';
};

/** Procurement hub › Purchase requests: approved PR lines to accept / source, tracked through to receipt (v_pr_tracker). */
export function PrSourcing({ L, projectId }: { L: Lookups; projectId: string }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const q = useAsync(async () => {
    const [lines, heads] = await Promise.all([
      fetchAll<PrTrackerRow>((a, b) => supabase.from('v_pr_tracker').select('*').eq('project_id', projectId)
        .not('status', 'in', '(draft,closed,rejected,cancelled,received)').order('number').order('line_no').range(a, b)),
      safeRows<Head>(supabase.from('material_requests').select('id, required_date, store_id, procurement_owner, requested_by')
        .eq('project_id', projectId).eq('request_type', 'purchase').not('status', 'in', '(draft,closed,rejected,cancelled,received)').limit(5000)),
    ]);
    const h = new Map(heads.map((x) => [x.id, x]));
    // Fully received lines are done; a short-closed PO puts its undelivered balance back under "To source".
    return lines.filter((l) => l.line_status === 'open' && Number(l.outstanding_qty) > 0.0005).map((l): Row => ({ ...l, head: h.get(l.mr_id), toSource: Math.max(0, Number(l.approved_qty ?? 0) - Number(l.ordered_qty)) }));
  }, [projectId], { key: 'pr-tracker' });
  const [f, setF, { active, clear }] = useUrlFilters({ stage: '', q: '', spec: '', priority: '' }, 'p.');
  const [dialog, setDialog] = useState<{ kind: 'rfq' | 'direct'; lines: PrLinePick[] } | null>(null);
  const all = q.data ?? [];
  const counts = useMemo(() => {
    const c: Record<Stage, number> = { accept: 0, source: 0, ordered: 0, delivery: 0, pending: 0, all: all.length };
    for (const r of all) c[stageOf(r)]++;
    return c;
  }, [all]);
  const stage = (f.stage || (counts.accept ? 'accept' : 'source')) as Stage;
  const term = f.q.toLowerCase();
  const rows = all.filter((r) => (stage === 'all' || stageOf(r) === stage) && (!f.spec || r.material_spec_id === f.spec) && (!f.priority || r.priority === f.priority)
    && (!term || r.number.toLowerCase().includes(term) || r.label.toLowerCase().includes(term)));

  const canAccept = canFlow(role, 'pr.accept');
  const canRfq = canFlow(role, 'rfq.fromPr');
  const canDirect = canFlow(role, 'po.direct') && auth.canSeePrices && Number((auth.settings as { direct_purchase_limit?: number } | null)?.direct_purchase_limit ?? 0) > 0;
  const pick = (sel: Row[]): PrLinePick[] => sel.filter((r) => BUYING.includes(r.status) && r.toSource > 0.0005).map((r) => ({
    mr_line_id: r.mr_line_id, mr_number: r.number, line_no: r.line_no, material_spec_id: r.material_spec_id, label: r.label, uom: r.uom,
    qty: r.toSource, required: r.head?.required_date ?? null, store_id: r.head?.store_id ?? null,
  }));
  const accept = async (sel: Row[], clearSel: () => void) => {
    const ids = [...new Map(sel.filter((r) => ACCEPT.includes(r.status)).map((r) => [r.mr_id, r.number])).entries()];
    if (!ids.length || !(await confirm({ title: `Accept ${ids.length} purchase request${ids.length === 1 ? '' : 's'}?`, body: <p className="muted mb-0">You become the buyer; requesters are informed.</p>, confirm: `Accept ${ids.length}` }))) return;
    let ok = 0;
    for (const [id, number] of ids) {
      try { await flowRpc('mr_action', { mr_id: id, action: 'accept', assign_to: auth.profile?.id }); ok++; } catch (e) { toast.error(`${number}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (ok) toast.success(`${ok} accepted`);
    clearSel();
  };

  const columns: Column<Row>[] = [
    { key: 'number', label: 'PR', id: true, render: (r) => <Link to={`/requests/${r.mr_id}`} onClick={(e) => e.stopPropagation()}>{r.number}</Link> },
    { key: 'line_no', label: 'Line', align: 'right', width: 50 },
    { key: 'label', label: 'Material / grade' },
    { key: 'status', label: 'Status', render: (r) => <FlowStatusBadge status={r.status} type="purchase" /> },
    { key: 'priority', label: 'Priority', value: (r) => (r.priority === 'normal' ? '' : r.priority), render: (r) => <PriorityBadge value={r.priority} /> },
    { key: 'approved_qty', label: 'Approved', align: 'right', render: (r) => (r.approved_qty === null ? <span className="muted-dash">—</span> : qty(r.approved_qty, r.uom)) },
    { key: 'on_rfq_qty', label: 'On RFQ', align: 'right', render: (r) => qty(r.on_rfq_qty, r.uom) },
    { key: 'ordered_qty', label: 'Ordered', align: 'right', render: (r) => qty(r.ordered_qty, r.uom) },
    { key: 'toSource', label: 'To source', align: 'right', render: (r) => (r.toSource > 0 ? <strong>{qty(r.toSource, r.uom)}<span className="unit">{r.uom}</span></strong> : <span className="muted-dash">—</span>) },
    { key: 'received_qty', label: 'Received', align: 'right', render: (r) => qty(r.received_qty, r.uom) },
    { key: 'need', label: 'Need by', value: (r) => r.head?.required_date ?? '', render: (r) => {
      if (!r.head) return null;
      const d = dueIn(r.head.required_date);
      return <span className="nowrap">{shortDate(r.head.required_date)}{d.text && <span className={`small-text ${d.late ? 'danger-text' : 'muted'}`}> · {d.text}</span>}</span>;
    } },
    { key: 'eta', label: 'ETA / notice', value: (r) => r.notice_date ?? r.eta ?? '', render: (r) => (r.notice_date ? <>{shortDate(r.notice_date)} <span className="muted small-text">notice</span></> : r.eta ? shortDate(r.eta) : null) },
    { key: 'buyer', label: 'Buyer', value: (r) => L.person(r.head?.procurement_owner) },
    { key: 'store', label: 'Deliver to', hidden: true, value: (r) => L.store(r.head?.store_id) },
  ];

  return (
    <>
      <Tabs label="Purchase request stage" variant="segmented" value={stage} onChange={(v) => setF('stage', v)} tabs={[
        { key: 'accept', label: 'To accept', count: counts.accept, hot: true },
        { key: 'source', label: 'To source', count: counts.source, hot: true },
        { key: 'ordered', label: 'Ordered', count: counts.ordered },
        { key: 'delivery', label: 'Delivery expected', count: counts.delivery },
        { key: 'pending', label: 'Awaiting approval', count: counts.pending },
        { key: 'all', label: 'All open', count: counts.all },
      ]} />
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <FilterBar active={active - (f.stage ? 1 : 0)} onClear={() => { clear(); }}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="PR no., material" />
        <FilterSelect label="Material" value={f.spec} onChange={(v) => setF('spec', v)} options={L.specs.map((s) => ({ value: s.id, label: s.label }))} />
        <FilterSelect label="Priority" value={f.priority} onChange={(v) => setF('priority', v)} options={[{ value: 'urgent', label: 'Urgent' }, { value: 'critical', label: 'Critical' }, { value: 'normal', label: 'Normal' }]} />
      </FilterBar>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.mr_line_id} loading={!q.data} error={q.error} onRetry={q.reload} urlKey="p." viewKey="pr-tracker"
        exportName="purchase-requests-tracker" filtered={active > 0} onClearFilters={clear} stickyFirst selectable={canAccept || canRfq || canDirect}
        empty={{ title: 'No open purchase requests', body: 'Management-approved purchase requests appear here for procurement to accept and source.' }}
        bulkActions={(sel, clearSel) => {
          const src = pick(sel);
          const acc = sel.filter((r) => ACCEPT.includes(r.status)).length;
          return <>
            {canAccept && <button className="small" disabled={!acc} onClick={() => void accept(sel, clearSel)}><Check size={14} aria-hidden />Accept{acc ? ` (${new Set(sel.filter((r) => ACCEPT.includes(r.status)).map((r) => r.mr_id)).size})` : ''}</button>}
            {canRfq && <button className="small primary" disabled={!src.length} title={src.length ? undefined : 'Select approved lines with a quantity still to source'} onClick={() => { setDialog({ kind: 'rfq', lines: src }); clearSel(); }}><FilePlus2 size={14} aria-hidden />Create RFQ</button>}
            {canDirect && <button className="small" disabled={!src.length} onClick={() => { setDialog({ kind: 'direct', lines: src }); clearSel(); }}><ShoppingCart size={14} aria-hidden />Direct purchase</button>}
          </>;
        }} />
      {dialog?.kind === 'rfq' && <RfqFromPrsModal lines={dialog.lines} L={L} onClose={() => setDialog(null)} onDone={() => q.reload()} />}
      {dialog?.kind === 'direct' && <DirectPurchaseModal lines={dialog.lines} L={L} onClose={() => setDialog(null)} onDone={() => q.reload()} />}
    </>
  );
}
