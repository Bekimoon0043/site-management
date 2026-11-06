import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FilePlus2, Plus, ShoppingCart } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups, type Lookups } from '../../lib/hooks';
import { fetchAll, supabase } from '../../lib/supabase';
import type { MaterialRequest, MrPriority } from '../../lib/contract';
import {
  PO_STATUS_LABELS, RFQ_STATUS_LABELS, canProcure, type ExpectedDeliveryRow, type MrLineProcurementRow, type PoStatusRow, type PoTotals,
  type ReorderSuggestionRow, type Rfq,
} from '../../lib/contract-procurement';
import { nextDocNumbers } from '../../lib/device-numbers';
import { OPEN_PO, procRpc } from '../../lib/procurement';
import { date, dateTime, dueIn, money, num, qty, shortDate, today } from '../../lib/format';
import { useUrlFilters, useUrlParam } from '../../lib/url';
import {
  Badge, Bar, Banner, DataTable, ErrorBanner, Field, FilterBar, FilterSelect, FilterToggle, Modal, Page, PriorityBadge, SearchInput, Tabs,
  toast, useBusy, useHashTab, type Column,
} from '../../components/ui';
import { DelayedBadge, DeliveryBadge, PoBadge, RfqBadge } from '../../components/procurement/badges';
import { RfqEditor, newRfqLine, type RfqDraft } from '../../components/procurement/RfqEditor';
import { PrSourcing } from '../flows/PrSourcing';
import { SupplierPerformanceTab } from '../../components/procurement/SupplierPerformance';

const TABS = ['prs', 'needs', 'rfqs', 'pos', 'deliveries', 'reorder', 'suppliers'] as const;

/** Procurement hub (features P1 #1–#5): sourcing queue → RFQs → POs → deliveries, plus reorder suggestions. */
export function Procurement() {
  const projectId = useProjectId();
  const auth = useAuth();
  const nav = useNavigate();
  const lk = useLookups(projectId);
  const role = auth.profile?.role;
  const [tab, setTab] = useHashTab(TABS, 'prs');
  const [newParam, setNewParam] = useUrlParam('new');
  const [rfqDraft, setRfqDraft] = useState<RfqDraft | null>(null);
  const minQuotes = String((auth.settings as { min_quotes?: number } | null)?.min_quotes ?? 3);
  const blankRfq = (p: Partial<RfqDraft> = {}): RfqDraft => ({ title: '', required_by: '', delivery_store_id: lk.data?.stores[0]?.id ?? '', min_quotes: minQuotes, notes: '', lines: [newRfqLine()], suppliers: [], ...p });
  const editorOpen = rfqDraft ?? (newParam === 'rfq' && lk.data ? blankRfq() : null);
  const closeEditor = () => { setRfqDraft(null); if (newParam) setNewParam(null); };

  const counts = useAsync(async () => {
    const head = (t: string) => supabase.from(t).select('*', { count: 'exact', head: true }).eq('project_id', projectId);
    const [rfqs, pos, delayed, prs] = await Promise.all([
      head('rfqs').in('status', ['draft', 'sent', 'closed']),
      head('purchase_orders').in('status', ['draft', 'submitted', 'rejected']),
      head('v_po_status').eq('is_delayed', true),
      head('material_requests').eq('request_type', 'purchase').in('status', ['approved_by_management', 'with_procurement']),
    ]);
    return { rfqs: rfqs.count ?? 0, pos: pos.count ?? 0, delayed: delayed.count ?? 0, prs: prs.count ?? 0 };
  }, [projectId], { key: 'proc-counts', staleTime: 30_000 });

  const canRfq = canProcure(role, 'rfq.create');
  const canPo = canProcure(role, 'po.create') && auth.canSeePrices;
  const L = lk.data;
  return (
    <Page title="Procurement" subtitle="Approved requests → RFQs & quotations → purchase orders → deliveries"
      actions={<>
        {canRfq && <button disabled={!L} onClick={() => setRfqDraft(blankRfq())}><FilePlus2 size={14} aria-hidden />New RFQ</button>}
        {canPo && <button className="primary" onClick={() => nav('/procurement/po/new')}><Plus size={14} aria-hidden />New purchase order</button>}
      </>}>
      <Tabs label="Procurement" value={tab} onChange={setTab} tabs={[
        { key: 'prs', label: 'Purchase requests', count: counts.data?.prs, hot: true },
        { key: 'needs', label: 'Needs sourcing' },
        { key: 'rfqs', label: 'RFQs', count: counts.data?.rfqs },
        { key: 'pos', label: 'Purchase orders', count: counts.data?.pos },
        { key: 'deliveries', label: 'Expected deliveries', count: counts.data?.delayed, hot: true },
        { key: 'reorder', label: 'Reorder suggestions' },
        { key: 'suppliers', label: 'Supplier performance' },
      ]} />
      <ErrorBanner error={lk.error} onRetry={lk.reload} />
      {!auth.canSeePrices && <Banner tone="info">Your role can't see prices — quotations, PO values and price-based actions are hidden.</Banner>}
      {L && tab === 'prs' && <PrSourcing L={L} projectId={projectId} />}
      {L && tab === 'needs' && <NeedsSourcing L={L} projectId={projectId} canRfq={canRfq} canPo={canPo} onRfq={(d) => setRfqDraft(blankRfq(d))} />}
      {L && tab === 'rfqs' && <RfqList projectId={projectId} />}
      {L && tab === 'pos' && <PoList projectId={projectId} L={L} withPrices={auth.canSeePrices} currency={auth.project?.currency} />}
      {L && tab === 'deliveries' && <Deliveries projectId={projectId} L={L} />}
      {L && tab === 'reorder' && <Reorder projectId={projectId} L={L} canCreate={canProcure(role, 'reorder.createMr')} />}
      {tab === 'suppliers' && <SupplierPerformanceTab />}
      {L && editorOpen && <RfqEditor initial={editorOpen} L={L} projectId={projectId} onClose={closeEditor} />}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Needs sourcing: approved MR lines with an unordered balance
// ---------------------------------------------------------------------------

type MrHead = Pick<MaterialRequest, 'id' | 'number' | 'status' | 'priority' | 'store_id' | 'required_date' | 'block_id'>
  & { mr_lines: { id: string; line_no: number; material_spec_id: string; deleted_at: string | null }[] };
interface NeedRow extends MrLineProcurementRow { mr: MrHead; line_no: number; remaining: number }

function NeedsSourcing({ L, projectId, canRfq, canPo, onRfq }: { L: Lookups; projectId: string; canRfq: boolean; canPo: boolean; onRfq: (d: Partial<RfqDraft>) => void }) {
  const nav = useNavigate();
  const q = useAsync(async () => {
    const [mrs, lines] = await Promise.all([
      fetchAll<MrHead>((a, b) => supabase.from('material_requests').select('id, number, status, priority, store_id, required_date, block_id, mr_lines(id, line_no, material_spec_id, deleted_at)')
        .eq('project_id', projectId).eq('request_type', 'site_use').in('status', ['approved', 'sourced', 'ordered', 'partially_issued']).order('required_date').range(a, b)),
      fetchAll<MrLineProcurementRow>((a, b) => supabase.from('v_mr_line_procurement').select('*').eq('project_id', projectId).gt('approved_qty', 0).range(a, b)),
    ]);
    const byMr = new Map(mrs.map((m) => [m.id, m]));
    const out: NeedRow[] = [];
    for (const l of lines) {
      const mr = byMr.get(l.mr_id);
      if (!mr) continue;
      const remaining = Math.max(0, Number(l.approved_qty ?? 0) - Number(l.ordered_qty));
      if (remaining <= 0.0005) continue;
      out.push({ ...l, mr, remaining, line_no: mr.mr_lines.find((x) => x.id === l.mr_line_id)?.line_no ?? 0 });
    }
    return out.sort((a, b) => a.mr.required_date.localeCompare(b.mr.required_date) || a.mr.number.localeCompare(b.mr.number) || a.line_no - b.line_no);
  }, [projectId], { key: 'proc-needs' });
  const [f, setF, { active, clear }] = useUrlFilters({ q: '', spec: '', rfq: '', priority: '' }, 'n.');
  const term = f.q.toLowerCase();
  const rows = (q.data ?? []).filter((r) => (f.rfq === '1' || !r.on_rfq) && (!f.spec || r.material_spec_id === f.spec) && (!f.priority || r.mr.priority === f.priority)
    && (!term || r.mr.number.toLowerCase().includes(term) || L.spec(r.material_spec_id).toLowerCase().includes(term)));

  const columns: Column<NeedRow>[] = [
    { key: 'mr', label: 'Request', id: true, value: (r) => r.mr.number, render: (r) => <Link to={`/requests/${r.mr_id}`} onClick={(e) => e.stopPropagation()}>{r.mr.number}</Link> },
    { key: 'line_no', label: 'Line', align: 'right', width: 50 },
    { key: 'spec', label: 'Material / grade', value: (r) => L.spec(r.material_spec_id) },
    { key: 'priority', label: 'Priority', value: (r) => r.mr.priority, render: (r) => <PriorityBadge value={r.mr.priority} /> },
    { key: 'approved_qty', label: 'Approved', align: 'right', render: (r) => qty(r.approved_qty, L.specUom(r.material_spec_id)) },
    { key: 'ordered_qty', label: 'Ordered', align: 'right', render: (r) => qty(r.ordered_qty, L.specUom(r.material_spec_id)) },
    { key: 'remaining', label: 'To source', align: 'right', render: (r) => <strong>{qty(r.remaining, L.specUom(r.material_spec_id))}<span className="unit">{L.specUom(r.material_spec_id)}</span></strong> },
    { key: 'required', label: 'Required', value: (r) => r.mr.required_date, render: (r) => {
      const d = dueIn(r.mr.required_date);
      return <span className="nowrap">{shortDate(r.mr.required_date)}{d.text && <span className={`small-text ${d.late ? 'danger-text' : 'muted'}`}> · {d.text}</span>}</span>;
    } },
    { key: 'store', label: 'Deliver to', value: (r) => L.store(r.mr.store_id) },
    { key: 'on_rfq', label: 'RFQ', value: (r) => (r.on_rfq ? 'On RFQ' : ''), render: (r) => (r.on_rfq ? <Badge tone="info" label="On RFQ" icon={null} /> : null) },
  ];

  const toRfq = (sel: NeedRow[]) => {
    const stores = new Set(sel.map((r) => r.mr.store_id).filter(Boolean));
    const req = sel.map((r) => r.mr.required_date).sort()[0] ?? '';
    const mrs = [...new Set(sel.map((r) => r.mr.number))];
    onRfq({
      title: `${mrs.slice(0, 3).join(', ')}${mrs.length > 3 ? ` +${mrs.length - 3}` : ''}`, required_by: req,
      delivery_store_id: stores.size === 1 ? [...stores][0]! : L.stores[0]?.id ?? '',
      lines: sel.map((r) => newRfqLine({ material_spec_id: r.material_spec_id, qty: String(r.remaining), mr_line_id: r.mr_line_id, required_date: r.mr.required_date, source: `${r.mr.number} line ${r.line_no}` })),
    });
  };

  return (
    <>
      <FilterBar active={active} onClear={clear}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="MR no., material" />
        <FilterSelect label="Material" value={f.spec} onChange={(v) => setF('spec', v)} options={L.specs.map((s) => ({ value: s.id, label: s.label }))} />
        <FilterSelect label="Priority" value={f.priority} onChange={(v) => setF('priority', v)} options={[{ value: 'urgent', label: 'Urgent' }, { value: 'critical', label: 'Critical' }, { value: 'normal', label: 'Normal' }]} />
        <FilterToggle label="Include lines already on an RFQ" checked={f.rfq === '1'} onChange={(v) => setF('rfq', v ? '1' : '')} />
      </FilterBar>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.mr_line_id} loading={!q.data} error={q.error} onRetry={q.reload} urlKey="n." viewKey="proc-needs"
        exportName="needs-sourcing" filtered={active > 0} onClearFilters={clear} stickyFirst selectable={canRfq || canPo}
        empty={{ title: 'Nothing waiting to be sourced', body: 'Approved request lines with an unordered balance appear here.' }}
        bulkActions={(sel, clearSel) => <>
          {canRfq && <button className="small" onClick={() => { toRfq(sel); clearSel(); }}><FilePlus2 size={14} aria-hidden />Create RFQ</button>}
          {canPo && <button className="small primary" onClick={() => nav(`/procurement/po/new?mr_lines=${sel.map((r) => r.mr_line_id).join(',')}`)}><ShoppingCart size={14} aria-hidden />Create PO</button>}
        </>} />
    </>
  );
}

// ---------------------------------------------------------------------------
// RFQ register
// ---------------------------------------------------------------------------

type RfqRow = Rfq & { rfq_lines: { id: string; deleted_at: string | null }[]; rfq_suppliers: { id: string; deleted_at: string | null }[]; quotations: { id: string; status: string }[] };

function RfqList({ projectId }: { projectId: string }) {
  const nav = useNavigate();
  const q = useAsync(() => fetchAll<RfqRow>((a, b) => supabase.from('rfqs').select('*, rfq_lines(id, deleted_at), rfq_suppliers(id, deleted_at), quotations(id, status)')
    .eq('project_id', projectId).order('created_at', { ascending: false }).range(a, b)), [projectId], { key: 'rfq-register' });
  const [f, setF, { active, clear }] = useUrlFilters({ q: '', status: '' }, 'r.');
  const term = f.q.toLowerCase();
  const rows = (q.data ?? []).filter((r) => (!f.status || r.status === f.status) && (!term || r.number.toLowerCase().includes(term) || r.title.toLowerCase().includes(term)));
  const quotes = (r: RfqRow) => r.quotations.filter((x) => x.status !== 'withdrawn').length;
  return (
    <>
      <FilterBar active={active} onClear={clear}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="RFQ no., title" />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={Object.entries(RFQ_STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data} error={q.error} onRetry={q.reload} urlKey="r." exportName="rfqs" stickyFirst filtered={active > 0} onClearFilters={clear}
        onRowClick={(r) => nav(`/procurement/rfq/${r.id}`)} empty={{ title: 'No RFQs yet', body: 'Select approved request lines under "Needs sourcing" and choose Create RFQ.' }}
        columns={[
          { key: 'number', label: 'RFQ', id: true },
          { key: 'title', label: 'Title' },
          { key: 'status', label: 'Status', value: (r) => RFQ_STATUS_LABELS[r.status], render: (r) => <RfqBadge status={r.status} /> },
          { key: 'lines', label: 'Lines', align: 'right', value: (r) => r.rfq_lines.filter((l) => !l.deleted_at).length },
          { key: 'suppliers', label: 'Invited', align: 'right', value: (r) => r.rfq_suppliers.filter((l) => !l.deleted_at).length },
          { key: 'quotes', label: 'Quotes', align: 'right', value: quotes, render: (r) => <span className={quotes(r) < r.min_quotes && ['sent', 'closed'].includes(r.status) ? 'warn-text strong' : ''}>{quotes(r)} / {r.min_quotes}</span> },
          { key: 'required_by', label: 'Required by', render: (r) => date(r.required_by) },
          { key: 'sent_at', label: 'Sent', render: (r) => dateTime(r.sent_at) },
        ]} />
    </>
  );
}

// ---------------------------------------------------------------------------
// PO register
// ---------------------------------------------------------------------------

function PoList({ projectId, L, withPrices, currency }: { projectId: string; L: Lookups; withPrices: boolean; currency?: string }) {
  const nav = useNavigate();
  const q = useAsync(async () => {
    const [pos, totals] = await Promise.all([
      fetchAll<PoStatusRow>((a, b) => supabase.from('v_po_status').select('*').eq('project_id', projectId).order('order_date', { ascending: false }).range(a, b)),
      withPrices ? fetchAll<Pick<PoTotals, 'po_id' | 'total' | 'net_payable' | 'currency'>>((a, b) => supabase.from('po_totals').select('po_id, total, net_payable, currency').eq('project_id', projectId).range(a, b)) : Promise.resolve([]),
    ]);
    return { pos, totals: new Map(totals.map((t) => [t.po_id, t])) };
  }, [projectId, withPrices], { key: 'po-register' });
  const [f, setF, { active, clear }] = useUrlFilters({ q: '', status: '', supplier: '', delayed: '' }, 'p.');
  const term = f.q.toLowerCase();
  const rows = (q.data?.pos ?? []).filter((r) => (!f.status || (f.status === 'open' ? OPEN_PO.includes(r.status) : r.status === f.status)) && (!f.supplier || r.supplier_id === f.supplier)
    && (!f.delayed || r.is_delayed) && (!term || r.number.toLowerCase().includes(term) || r.supplier_name.toLowerCase().includes(term)));
  const cur = currency ?? 'ETB';
  return (
    <>
      <FilterBar active={active} onClear={clear}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="PO no., supplier" />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={[{ value: 'open', label: 'Open (approved / sent / part received)' }, ...Object.entries(PO_STATUS_LABELS).map(([value, label]) => ({ value, label }))]} />
        <FilterSelect label="Supplier" value={f.supplier} onChange={(v) => setF('supplier', v)} options={L.suppliers.map((s) => ({ value: s.id, label: s.name }))} />
        <FilterToggle label="Delayed" checked={!!f.delayed} onChange={(v) => setF('delayed', v ? '1' : '')} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data} error={q.error} onRetry={q.reload} urlKey="p." viewKey="po-register" exportName="purchase-orders" stickyFirst
        filtered={active > 0} onClearFilters={clear} onRowClick={(r) => nav(`/procurement/po/${r.id}`)}
        empty={{ title: 'No purchase orders yet', body: 'Create one from an RFQ award, from approved request lines, or from scratch.' }}
        columns={[
          { key: 'number', label: 'PO', id: true, render: (r) => <>{r.number}{r.revision > 0 && <span className="muted small-text"> rev {r.revision}</span>}</> },
          { key: 'supplier_name', label: 'Supplier' },
          { key: 'status', label: 'Status', value: (r) => PO_STATUS_LABELS[r.status], render: (r) => <PoBadge status={r.status} /> },
          { key: 'delivery', label: 'Delivery', value: (r) => r.delivery_status, render: (r) => <span className="badges">{OPEN_PO.includes(r.status) && <DeliveryBadge status={r.delivery_status} />}{r.is_delayed && <DelayedBadge days={r.days_late} />}</span> },
          { key: 'order_date', label: 'Ordered', render: (r) => shortDate(r.order_date) },
          { key: 'expected', label: 'Expected', value: (r) => r.eta ?? r.expected_date, render: (r) => shortDate(r.eta ?? r.expected_date) },
          { key: 'received_pct', label: 'Received', render: (r) => <Bar pct={Number(r.received_pct)} /> },
          { key: 'store', label: 'Deliver to', value: (r) => L.store(r.delivery_store_id), hidden: true },
          ...(withPrices ? [{ key: 'total', label: 'Total incl. VAT', align: 'right' as const, value: (r: PoStatusRow) => q.data?.totals.get(r.id)?.total ?? null,
            render: (r: PoStatusRow) => money(q.data?.totals.get(r.id)?.total, cur) }] : []),
        ]} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Expected deliveries (open PO lines with balance)
// ---------------------------------------------------------------------------

function Deliveries({ projectId, L }: { projectId: string; L: Lookups }) {
  const nav = useNavigate();
  const q = useAsync(() => fetchAll<ExpectedDeliveryRow>((a, b) => supabase.from('v_expected_deliveries').select('*').eq('project_id', projectId)
    .order('expected_date', { ascending: true, nullsFirst: false }).range(a, b)), [projectId], { key: 'expected-deliveries' });
  const [f, setF, { active, clear }] = useUrlFilters({ q: '', delayed: '', store: '', supplier: '' }, 'd.');
  const term = f.q.toLowerCase();
  const rows = (q.data ?? []).filter((r) => (!f.delayed || r.is_delayed) && (!f.store || r.delivery_store_id === f.store) && (!f.supplier || r.supplier_id === f.supplier)
    && (!term || r.po_number.toLowerCase().includes(term) || r.label.toLowerCase().includes(term)));
  const t = today();
  return (
    <>
      <FilterBar active={active} onClear={clear}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="PO no., material" />
        <FilterSelect label="Store" value={f.store} onChange={(v) => setF('store', v)} options={L.stores.map((s) => ({ value: s.id, label: s.name }))} />
        <FilterSelect label="Supplier" value={f.supplier} onChange={(v) => setF('supplier', v)} options={L.suppliers.map((s) => ({ value: s.id, label: s.name }))} />
        <FilterToggle label="Delayed only" checked={!!f.delayed} onChange={(v) => setF('delayed', v ? '1' : '')} />
      </FilterBar>
      <DataTable rows={rows} rowKey={(r) => r.po_line_id} loading={!q.data} error={q.error} onRetry={q.reload} urlKey="d." exportName="expected-deliveries" stickyFirst
        filtered={active > 0} onClearFilters={clear} onRowClick={(r) => nav(`/procurement/po/${r.po_id}`)} rowClass={(r) => (r.is_delayed ? 'row-warn' : undefined)}
        empty={{ title: 'Nothing on order', body: 'Approved and sent purchase orders with an outstanding balance appear here.' }}
        columns={[
          { key: 'po_number', label: 'PO', id: true },
          { key: 'expected_date', label: 'Expected', value: (r) => r.expected_date, render: (r) => {
            const d = dueIn(r.expected_date);
            return <span className="nowrap">{shortDate(r.expected_date) || '—'}{d.text && <span className={`small-text ${r.expected_date && r.expected_date < t ? 'danger-text' : 'muted'}`}> · {d.text}</span>}</span>;
          } },
          { key: 'supplier_name', label: 'Supplier' },
          { key: 'label', label: 'Material / grade' },
          { key: 'ordered_qty', label: 'Ordered', align: 'right', render: (r) => qty(r.ordered_qty, r.uom) },
          { key: 'qty_accepted', label: 'Received', align: 'right', render: (r) => qty(r.qty_accepted, r.uom) },
          { key: 'outstanding_qty', label: 'Outstanding', align: 'right', render: (r) => <strong>{qty(r.outstanding_qty, r.uom)}<span className="unit">{r.uom}</span></strong> },
          { key: 'delivery_status', label: 'Status', render: (r) => <span className="badges"><DeliveryBadge status={r.delivery_status} />{r.is_delayed && <DelayedBadge />}</span> },
          { key: 'store', label: 'Deliver to', value: (r) => L.store(r.delivery_store_id) },
        ]} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Reorder suggestions → stock-replenishment MR
// ---------------------------------------------------------------------------

function Reorder({ projectId, L, canCreate }: { projectId: string; L: Lookups; canCreate: boolean }) {
  const q = useAsync(() => fetchAll<ReorderSuggestionRow>((a, b) => supabase.from('v_reorder_suggestions').select('*').eq('project_id', projectId)
    .order('days_cover', { ascending: true, nullsFirst: false }).range(a, b)), [projectId], { key: 'reorder-suggestions' });
  const [f, setF, { active, clear }] = useUrlFilters({ q: '', store: '', risk: '' }, 'o.');
  const [creating, setCreating] = useState<ReorderSuggestionRow[] | null>(null);
  const term = f.q.toLowerCase();
  const rows = (q.data ?? []).filter((r) => (!f.store || r.store_id === f.store) && (!f.risk || r.stockout_before_lead_time) && (!term || r.label.toLowerCase().includes(term) || r.category.toLowerCase().includes(term)));
  return (
    <>
      <FilterBar active={active} onClear={clear}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Material, category" />
        <FilterSelect label="Store" value={f.store} onChange={(v) => setF('store', v)} options={L.stores.map((s) => ({ value: s.id, label: s.name }))} />
        <FilterToggle label="Runs out before lead time" checked={!!f.risk} onChange={(v) => setF('risk', v ? '1' : '')} />
      </FilterBar>
      <DataTable rows={rows} rowKey={(r) => `${r.store_id}:${r.material_spec_id}`} loading={!q.data} error={q.error} onRetry={q.reload} urlKey="o." viewKey="reorder"
        exportName="reorder-suggestions" stickyFirst filtered={active > 0} onClearFilters={clear} selectable={canCreate}
        rowClass={(r) => (r.stockout_before_lead_time ? 'row-warn' : undefined)}
        empty={{ title: 'No reorder needed', body: 'Suggestions appear when projected demand exceeds stock plus open orders (reorder level, lead time + safety days, pack size).' }}
        bulkActions={(sel, clearSel) => <button className="small primary" onClick={() => { setCreating(sel); clearSel(); }}><Plus size={14} aria-hidden />Create request{sel.length > 1 ? 's' : ''}</button>}
        columns={[
          { key: 'label', label: 'Material / grade', id: true },
          { key: 'store_name', label: 'Store' },
          { key: 'available', label: 'Available', align: 'right', render: (r) => qty(r.available, r.uom) },
          { key: 'avg_daily_issue_30d', label: 'Avg/day (30 d)', align: 'right', render: (r) => num(r.avg_daily_issue_30d, 2) },
          { key: 'days_cover', label: 'Days cover', align: 'right', render: (r) => (r.days_cover === null ? '—' : <span className={r.stockout_before_lead_time ? 'danger-text strong' : ''}>{num(r.days_cover, 1)}</span>) },
          { key: 'stockout_date', label: 'Stock-out', render: (r) => shortDate(r.stockout_date) },
          { key: 'lead_time_days', label: 'Lead time', align: 'right', render: (r) => `${r.lead_time_days} d` },
          { key: 'pending_mr_qty', label: 'Pending MR', align: 'right', render: (r) => qty(r.pending_mr_qty, r.uom) },
          { key: 'open_po_qty', label: 'On order', align: 'right', render: (r) => <>{qty(r.open_po_qty, r.uom)}{r.next_eta && <span className="muted small-text"> · {shortDate(r.next_eta)}</span>}</> },
          { key: 'suggested_qty', label: 'Suggested', align: 'right', render: (r) => <strong>{qty(r.suggested_qty, r.uom)}<span className="unit">{r.uom}</span></strong> },
          { key: 'pack_size', label: 'Pack', align: 'right', hidden: true },
          { key: 'reorder_level', label: 'Reorder level', align: 'right', hidden: true },
        ]} />
      {creating && <ReorderMrModal rows={creating} projectId={projectId} L={L} onClose={() => setCreating(null)} />}
    </>
  );
}

function ReorderMrModal({ rows, projectId, L, onClose }: { rows: ReorderSuggestionRow[]; projectId: string; L: Lookups; onClose: () => void }) {
  const auth = useAuth();
  const nav = useNavigate();
  const [qtys, setQtys] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [`${r.store_id}:${r.material_spec_id}`, String(r.suggested_qty)])));
  const [req, setReq] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  const [priority, setPriority] = useState<MrPriority>(rows.some((r) => r.stockout_before_lead_time) ? 'urgent' : 'normal');
  const [submit, setSubmit] = useState(true);
  const { busy, error, run } = useBusy();
  const byStore = useMemo(() => {
    const m = new Map<string, ReorderSuggestionRow[]>();
    for (const r of rows) m.set(r.store_id, [...(m.get(r.store_id) ?? []), r]);
    return [...m.entries()];
  }, [rows]);
  const go = () => run(async () => {
    const numbers = await nextDocNumbers(auth.project?.code ?? '', 'MR', byStore.length);
    const ids: string[] = [];
    for (const [i, [store, list]] of byStore.entries()) {
      const id = crypto.randomUUID();
      await procRpc('create_mr_from_suggestions', {
        id, project_id: projectId, number: numbers[i], store_id: store, required_date: req, priority, submit, device_created_at: new Date().toISOString(),
        lines: list.map((r) => {
          const v = Number(qtys[`${r.store_id}:${r.material_spec_id}`]);
          if (!(v > 0)) throw new Error(`${r.label}: quantity must be greater than zero`);
          return { id: crypto.randomUUID(), material_spec_id: r.material_spec_id, qty: v, remarks: `Reorder suggestion (${num(r.days_cover ?? 0, 1)} d cover)` };
        }),
      });
      ids.push(id);
    }
    toast.success(`${numbers.join(', ')} ${submit ? 'submitted for approval' : 'saved as draft'}`, ids.length === 1 ? { action: { label: 'Open', onClick: () => nav(`/requests/${ids[0]}`) } } : undefined);
    onClose();
  });
  return (
    <Modal size="lg" title={`Create ${byStore.length === 1 ? 'a stock request' : `${byStore.length} stock requests (one per store)`}`} onClose={onClose}
      footer={<><button onClick={onClose} disabled={busy}>Cancel</button><button className="primary" disabled={busy} onClick={() => void go()}>{busy && <span className="spinner" />}{submit ? 'Create & submit' : 'Create draft'}</button></>}>
      <div className="stack">
        <ErrorBanner error={error} />
        <div className="form-grid">
          <Field label="Required by" required><input type="date" value={req} min={today()} onChange={(e) => setReq(e.target.value)} /></Field>
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(e.target.value as MrPriority)}><option value="normal">Normal</option><option value="urgent">Urgent</option><option value="critical">Critical</option></select>
          </Field>
          <Field label="Submit for approval now" check><input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} /></Field>
        </div>
        {byStore.map(([store, list]) => (
          <div key={store}>
            <div className="strong">{L.store(store)}</div>
            <div className="table-wrap mt-2"><table>
              <thead><tr><th>Material</th><th className="right">Suggested</th><th className="right">Request qty</th></tr></thead>
              <tbody>{list.map((r) => {
                const k = `${r.store_id}:${r.material_spec_id}`;
                return <tr key={k}><td>{r.label}</td><td className="right">{qty(r.suggested_qty, r.uom)}</td>
                  <td className="right"><input type="number" className="num-input" min={0} step="any" value={qtys[k]} aria-label={`${r.label} quantity`} onChange={(e) => setQtys({ ...qtys, [k]: e.target.value })} /> <span className="unit">{r.uom}</span></td></tr>;
              })}</tbody>
            </table></div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

