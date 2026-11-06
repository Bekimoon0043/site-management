import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { useAuth, useProjectId } from '../lib/auth';
import { useAsync, useLookups, type Lookups } from '../lib/hooks';
import { check, fetchAll, rpc, supabase } from '../lib/supabase';
import type { Adjustment, AdjustmentLine, Grn, GrnLine, Miv, MivLine, Mrn, MrnLine, StockCount, StockCountLine, Transfer, TransferLine } from '../lib/contract';
import { dateTime, hoursSince, humanize, num, shortDate } from '../lib/format';
import { isOverdueEmergency, type BalanceRow } from '../lib/domain';
import { useUrlFilters, useUrlParam } from '../lib/url';
import { useNavCounts } from '../lib/approvals';
import { Attachments } from '../components/Attachments';
import { IncomingOrders } from '../components/store/Incoming';
import { InventoryValue } from '../components/costing/MaterialCosting';
import { ToolsTab } from '../components/store/Tools';
import { StockAgeingTab } from '../components/store/StockAgeing';
import {
  Badge, Banner, Card, DataTable, Drawer, ErrorBanner, FilterBar, FilterDate, FilterSelect, FilterText, FilterToggle, Loading, Page, PrintHeader, ReasonModal, SearchInput, Signatures, TabGroups, toast, useHashTab, type TabDef,
} from '../components/ui';

export type { BalanceRow } from '../lib/domain';

const TABS = ['balances', 'low', 'bincard', 'ageing', 'tools', 'incoming', 'grn', 'miv', 'mrn', 'transfers', 'adjustments', 'counts', 'emergency'] as const;
type Tab = (typeof TABS)[number];

export function StorePage() {
  const projectId = useProjectId();
  const auth = useAuth();
  const [tab, setTab] = useHashTab<Tab>(TABS, 'balances');
  const lk = useLookups(projectId);
  const counts = useNavCounts(auth.projectId, auth.can, auth.profile?.role);
  const emergency = counts.data?.emergencyOverdue ?? 0;

  const groups: { label: string; tabs: TabDef<Tab>[] }[] = [
    { label: 'Stock', tabs: [{ key: 'balances', label: 'Balance' }, { key: 'low', label: 'Low stock' }, { key: 'bincard', label: 'Bin card' }, { key: 'ageing', label: 'Shelf life', count: (counts.data?.byType.stock_expiry ?? 0) || undefined, hot: true }] },
    { label: 'Tools', tabs: [{ key: 'tools', label: 'Tools register', count: (counts.data?.byType.tool_overdue ?? 0) || undefined, hot: true }] },
    { label: 'Movements', tabs: [{ key: 'incoming', label: 'Incoming orders', count: (counts.data?.byType.po_receive ?? 0) || undefined, hot: true }, { key: 'grn', label: 'Receipts (GRN)' }, { key: 'miv', label: 'Issues (MIV)' }, { key: 'mrn', label: 'Returns (MRN)' }, { key: 'transfers', label: 'Transfers' }] },
    { label: 'Control', tabs: [
      { key: 'adjustments', label: 'Adjustments', count: counts.data?.byType.adjustment || undefined, hot: true },
      { key: 'counts', label: 'Stock counts', count: counts.data?.byType.count || undefined, hot: true },
      { key: 'emergency', label: 'Emergency issues', count: emergency || undefined, hot: true },
    ] },
  ];

  return (
    <Page title="Store" subtitle="Stock, shelf life, tools, incoming orders, receipts, issues, returns, adjustments and counts">
      <TabGroups groups={groups} value={tab} onChange={setTab} />
      {emergency > 0 && tab !== 'emergency' && (
        <Banner tone="error" action={<Link to="/approvals?type=emergency" className="nowrap">Regularise <ArrowRight size={12} aria-hidden /></Link>}>
          {emergency} emergency issue{emergency === 1 ? '' : 's'} older than 24 h not yet linked to an approved request (BR-01).
        </Banner>
      )}
      <ErrorBanner error={lk.error} onRetry={lk.reload} />
      {!lk.data ? <Loading lines={8} /> : (
        <>
          {(tab === 'balances' || tab === 'low') && <Balances key={tab} L={lk.data} projectId={projectId} lowOnly={tab === 'low'} />}
          {tab === 'bincard' && <BinCardTab L={lk.data} />}
          {tab === 'ageing' && <StockAgeingTab projectId={projectId} />}
          {tab === 'tools' && <ToolsTab L={lk.data} projectId={projectId} />}
          {tab === 'incoming' && <IncomingOrders L={lk.data} projectId={projectId} />}
          {tab === 'grn' && <GrnList L={lk.data} projectId={projectId} />}
          {tab === 'miv' && <MivList L={lk.data} projectId={projectId} emergencyOnly={false} />}
          {tab === 'emergency' && <MivList L={lk.data} projectId={projectId} emergencyOnly />}
          {tab === 'mrn' && <MrnList L={lk.data} projectId={projectId} />}
          {tab === 'adjustments' && <Adjustments L={lk.data} projectId={projectId} />}
          {tab === 'counts' && <Counts L={lk.data} projectId={projectId} />}
          {tab === 'transfers' && <Transfers L={lk.data} projectId={projectId} />}
        </>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

function Balances({ L, projectId, lowOnly }: { L: Lookups; projectId: string; lowOnly: boolean }) {
  const q = useAsync(() => fetchAll<BalanceRow>((a, b) => supabase.from('v_stock_balance').select('*').eq('project_id', projectId).order('label').range(a, b)), [projectId], { key: 'stock-balance' });
  const [f, setF, { active, clear }] = useUrlFilters({ store: '', status: lowOnly ? 'available' : '', q: '', zero: '1', group: '' });
  const [bin, setBin] = useState<{ store: string; spec: string; status: string } | null>(null);
  const term = f.q.toLowerCase();
  const rows = useMemo(() => {
    const r = (q.data ?? []).filter((x) => (!lowOnly || x.below_reorder) && (!f.store || x.store_id === f.store) && (!f.status || x.stock_status === f.status)
      && (f.zero !== '1' || Number(x.qty) !== 0) && (!term || x.label.toLowerCase().includes(term) || x.category.toLowerCase().includes(term)));
    if (f.group === 'category') return [...r].sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
    if (f.group === 'store') return [...r].sort((a, b) => a.store_name.localeCompare(b.store_name) || a.label.localeCompare(b.label));
    return r;
  }, [q.data, lowOnly, f.store, f.status, f.zero, term, f.group]);
  const filterCount = active - (f.zero === '1' ? 0 : 1);
  const auth = useAuth();
  return (
    <div className="stack">
      {!lowOnly && auth.canSeePrices && <InventoryValue projectId={projectId} cur={auth.project?.currency ?? 'ETB'} compact />}
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <FilterBar active={filterCount} onClear={clear}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Material, category" />
        <FilterSelect label="Store" value={f.store} onChange={(v) => setF('store', v)} options={L.stores.map((s) => ({ value: s.id, label: s.name }))} />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={[{ value: 'available', label: 'Available' }, { value: 'quarantine', label: 'Quarantine' }]} />
        <FilterSelect label="Group by" value={f.group} allLabel="None" onChange={(v) => setF('group', v)} options={[{ value: 'store', label: 'Store' }, { value: 'category', label: 'Category' }]} />
        <FilterToggle label="Hide zero balances" checked={f.zero === '1'} onChange={(v) => setF('zero', v ? '1' : '0')} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data} exportName={lowOnly ? 'low-stock' : 'stock-status'} rowKey={(r) => r.store_id + r.material_spec_id + r.stock_status}
        onRowClick={(r) => setBin({ store: r.store_id, spec: r.material_spec_id, status: r.stock_status })} viewKey="stock-balance" stickyFirst
        filtered={filterCount > 0} onClearFilters={clear}
        empty={lowOnly ? { title: 'Nothing at or below reorder level', body: 'Items appear here when their balance drops to the reorder level set in Materials.' } : { title: 'No stock recorded yet', body: 'Post opening balances under Project setup, or receive a delivery (GRN).' }}
        columns={[
          { key: 'label', label: 'Material / grade', render: (r) => <>{r.below_reorder && <span className="warn-line" title="At or below reorder level"><TriangleAlert size={14} /></span>} <span className="strong">{r.label}</span></> },
          { key: 'category', label: 'Category' },
          { key: 'store_name', label: 'Store' },
          { key: 'stock_status', label: 'Status', render: (r) => <Badge value={r.stock_status} /> },
          { key: 'qty', label: 'Balance', align: 'right', render: (r) => <>{num(r.qty, 3)}<span className="unit">{r.uom}</span></> },
          { key: 'reorder', label: 'vs reorder', value: (r) => (Number(r.reorder_level) ? Number(r.qty) / Number(r.reorder_level) : null), render: (r) => (Number(r.reorder_level) > 0
            ? <div className={`bar${r.below_reorder ? ' warn' : ''}`} style={{ width: 90 }} title={`${num(r.qty, 3)} / ${num(r.reorder_level, 3)}`}><span style={{ width: `${Math.min(100, (Number(r.qty) / (Number(r.reorder_level) * 2)) * 100)}%` }} /></div>
            : <span className="muted-dash">—</span>) },
          { key: 'reorder_level', label: 'Reorder at', align: 'right', render: (r) => num(r.reorder_level, 3) },
          { key: 'min_level', label: 'Min', align: 'right', hidden: true, render: (r) => num(r.min_level, 3) },
          { key: 'last_txn_at', label: 'Last movement', render: (r) => shortDate(r.last_txn_at) },
        ]} />
      {bin && (
        <Drawer size="lg" title={`Bin card — ${L.spec(bin.spec)}`} subtitle={`${L.store(bin.store)} · ${humanize(bin.status)} · unit ${L.specUom(bin.spec)}`} onClose={() => setBin(null)}
          footer={<><Link to={`/store?bstore=${bin.store}&bspec=${bin.spec}#bincard`}>Open full bin card</Link><span className="grow" /><button onClick={() => setBin(null)}>Close</button></>}>
          <BinCardTable L={L} store={bin.store} spec={bin.spec} status={bin.status as 'available' | 'quarantine'} />
        </Drawer>
      )}
    </div>
  );
}

interface BinRow { id: string; txn_at: string; doc_number: string; doc_type: string; txn_type: string; element_code: string | null; qty: number; running_balance: number; stock_status: string; batch_no: string | null; created_by: string | null }

function BinCardTable({ L, store, spec, status }: { L: Lookups; store: string; spec: string; status: 'available' | 'quarantine' }) {
  const q = useAsync(() => fetchAll<BinRow>((a, b) => supabase.from('v_bin_card').select('*').eq('store_id', store).eq('material_spec_id', spec).eq('stock_status', status)
    .order('txn_at').order('created_at').range(a, b)), [store, spec, status], { key: 'bin-card' });
  return (
    <>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <DataTable rows={q.data ?? []} loading={!q.data} exportName={`bin-card-${L.spec(spec)}`} pageSize={100} empty="No movements for this material in this store." columns={[
        { key: 'txn_at', label: 'Date', render: (r) => dateTime(r.txn_at) },
        { key: 'doc_number', label: 'Document', id: true },
        { key: 'txn_type', label: 'Type', value: (r) => humanize(r.txn_type) },
        { key: 'element_code', label: 'Element' },
        { key: 'batch_no', label: 'Batch', hidden: true },
        { key: 'in', label: 'Receipts', align: 'right', value: (r) => (Number(r.qty) > 0 ? Number(r.qty) : ''), render: (r) => (Number(r.qty) > 0 ? num(r.qty, 3) : '') },
        { key: 'out', label: 'Issues', align: 'right', value: (r) => (Number(r.qty) < 0 ? -Number(r.qty) : ''), render: (r) => (Number(r.qty) < 0 ? num(-Number(r.qty), 3) : '') },
        { key: 'running_balance', label: 'Balance', align: 'right', render: (r) => <strong>{num(r.running_balance, 3)}</strong> },
        { key: 'created_by', label: 'By', value: (r) => L.person(r.created_by) },
      ]} />
    </>
  );
}

function BinCardTab({ L }: { L: Lookups }) {
  const [f, setF] = useUrlFilters({ bstore: L.stores[0]?.id ?? '', bspec: '', bstatus: 'available' });
  return (
    <div className="stack">
      <FilterBar>
        <FilterSelect label="Store" allLabel="Choose…" value={f.bstore} onChange={(v) => setF('bstore', v)} options={L.stores.map((s) => ({ value: s.id, label: s.name }))} />
        <FilterSelect label="Material" allLabel="Choose…" value={f.bspec} onChange={(v) => setF('bspec', v)} options={L.specs.map((s) => ({ value: s.id, label: s.label }))} />
        <FilterSelect label="Stock" allLabel="Available" value={f.bstatus === 'available' ? '' : f.bstatus} onChange={(v) => setF('bstatus', v || 'available')} options={[{ value: 'quarantine', label: 'Quarantine' }]} />
      </FilterBar>
      {!f.bstore || !f.bspec ? <Card><p className="muted mb-0">Choose a store and material to see its bin card — or click a row in Stock balance.</p></Card> : (
        <Card title={`Bin card — ${L.spec(f.bspec)} at ${L.store(f.bstore)}`} sub={`Unit ${L.specUom(f.bspec)}`} flush>
          <PrintHeader title={`Bin card — ${L.spec(f.bspec)}`} filters={`${L.store(f.bstore)} · ${f.bstatus}`} />
          <BinCardTable L={L} store={f.bstore} spec={f.bspec} status={f.bstatus as 'available' | 'quarantine'} />
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

const inRange = (d: string, from: string, to: string) => (!from || d.slice(0, 10) >= from) && (!to || d.slice(0, 10) <= to);

function DocDrawer({ title, onClose, header, lines, entityType, entityId, actions, status }: {
  title: string; onClose: () => void; header: [string, ReactNode][]; lines: ReactNode; entityType: string; entityId: string; actions?: ReactNode; status?: ReactNode;
}) {
  const role = useAuth().profile?.role ?? '';
  const canAttach = entityType !== 'stock_count' && ['store_keeper', 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin'].includes(role);
  return (
    <Drawer size="lg" title={<span className="row">{title}{status}</span>} onClose={onClose}
      footer={<>{actions}<span className="grow" /><button onClick={() => window.print()}>Print</button><button onClick={onClose}>Close</button></>}>
      <div className="stack print-doc">
        <PrintHeader title={title} />
        <dl className="kv">{header.map(([k, v]) => <FragmentKV key={k} k={k} v={v} />)}</dl>
        {lines}
        <div><h3>Photos & signatures</h3><Attachments entityType={entityType} entityId={entityId} canAdd={canAttach} kinds={['photo', 'delivery_note', 'invoice', 'signature', 'document']} /></div>
        <Signatures />
      </div>
    </Drawer>
  );
}
function FragmentKV({ k, v }: { k: string; v: ReactNode }) {
  return <><dt>{k}</dt><dd>{v || <span className="muted-dash">—</span>}</dd></>;
}

function ReverseButton({ docType, docId, number, onDone }: { docType: 'grn' | 'miv' | 'mrn'; docId: string; number: string; onDone: () => void }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can('reverse')) return null;
  return (
    <>
      <button className="danger" onClick={() => setOpen(true)}>Reverse…</button>
      {open && <ReasonModal title={`Reverse ${number} (BR-07)`} label="Reason for reversal" danger confirm="Post reversal" onClose={() => setOpen(false)}
        onSubmit={async (reason) => { await rpc('reverse_document', { doc_type: docType, doc_id: docId, reason }); toast.success(`${number} reversed`); onDone(); }} />}
    </>
  );
}

type GrnRow = Grn & { grn_lines: GrnLine[] };
function GrnList({ L, projectId }: { L: Lookups; projectId: string }) {
  const q = useAsync(() => fetchAll<GrnRow>((a, b) => supabase.from('grns').select('*, grn_lines(*)').eq('project_id', projectId).order('received_at', { ascending: false }).range(a, b)), [projectId], { key: 'grns' });
  const [f, setF, { active, clear }] = useUrlFilters({ from: '', to: '', supplier: '', store: '', flag: '' }, 'g');
  const [openId, setOpenId] = useUrlParam('open');
  const supplierName = (g: Grn) => g.supplier_name ?? L.suppliers.find((s) => s.id === g.supplier_id)?.name ?? '';
  const rows = (q.data ?? []).filter((g) => inRange(g.received_at, f.from, f.to) && (!f.store || g.store_id === f.store)
    && (!f.supplier || supplierName(g).toLowerCase().includes(f.supplier.toLowerCase()))
    && (!f.flag || g.grn_lines.some((l) => (f.flag === 'rejected' ? Number(l.qty_rejected) > 0 : !!l.variance_flag))));
  const open = q.data?.find((g) => g.id === openId) ?? null;
  return (
    <div className="stack">
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={clear}>
        <FilterDate label="From" value={f.from} onChange={(v) => setF('from', v)} />
        <FilterDate label="To" value={f.to} onChange={(v) => setF('to', v)} />
        <FilterSelect label="Store" value={f.store} onChange={(v) => setF('store', v)} options={L.stores.map((s) => ({ value: s.id, label: s.name }))} />
        <FilterText label="Supplier" value={f.supplier} onChange={(v) => setF('supplier', v)} />
        <FilterSelect label="Flags" value={f.flag} onChange={(v) => setF('flag', v)} options={[{ value: 'variance', label: 'Any variance flag' }, { value: 'rejected', label: 'Rejected quantity' }]} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data} exportName="grn-register" onRowClick={(r) => setOpenId(r.id, true)} activeKey={openId} urlKey="g" viewKey="grns" stickyFirst
        filtered={active > 0} onClearFilters={clear} empty={{ title: 'No deliveries received yet', body: 'GRNs posted by store keepers (mobile app) appear here.' }} columns={[
        { key: 'number', label: 'GRN', id: true },
        { key: 'received_at', label: 'Received', render: (r) => dateTime(r.received_at) },
        { key: 'store', label: 'Store', value: (r) => L.store(r.store_id) },
        { key: 'supplier', label: 'Supplier', value: supplierName },
        { key: 'delivery_note_no', label: 'Delivery note' },
        { key: 'vehicle_plate', label: 'Vehicle', hidden: true },
        { key: 'materials', label: 'Materials', value: (r) => r.grn_lines.map((l) => `${L.spec(l.material_spec_id)} ${num(l.qty_accepted)}`).join('; '), render: (r) => <span className="truncate" style={{ display: 'inline-block', maxWidth: 320 }}>{r.grn_lines.map((l) => `${L.spec(l.material_spec_id)} ${num(l.qty_accepted)}`).join('; ')}</span> },
        { key: 'flags', label: 'Flags', value: (r) => r.grn_lines.map((l) => l.variance_flag).filter(Boolean).join(', '),
          render: (r) => <span className="badges">{[...new Set(r.grn_lines.map((l) => l.variance_flag).filter(Boolean))].map((v) => <Badge key={v} value={v} outline tone="danger" icon={null} />)}{r.grn_lines.some((l) => Number(l.qty_rejected) > 0) && <Badge outline tone="danger" icon={null} label="Rejected qty" />}</span> },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'created_by', label: 'Store keeper', value: (r) => L.person(r.created_by), hidden: true },
      ]} />
      {open && (
        <DocDrawer title={`GRN ${open.number}`} status={<Badge value={open.status} />} onClose={() => setOpenId(null)} entityType="grn" entityId={open.id}
          actions={open.status === 'posted' && <ReverseButton docType="grn" docId={open.id} number={open.number} onDone={() => setOpenId(null)} />}
          header={[['Received', dateTime(open.received_at)], ['Store', L.store(open.store_id)], ['Supplier', supplierName(open)], ['Delivery note', open.delivery_note_no],
            ['Vehicle / driver', [open.vehicle_plate, open.driver_name].filter(Boolean).join(' · ')], ['Store keeper', L.person(open.created_by)],
            ['Confirmed by engineer', open.confirmed_by ? L.person(open.confirmed_by) : ''], ['Remarks', open.remarks]]}
          lines={<DataTable rows={[...open.grn_lines].sort((a, b) => a.line_no - b.line_no)} maxHeight="none" columns={[
            { key: 'line_no', label: '#', align: 'right' },
            { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
            { key: 'ordered_qty', label: 'Ordered', align: 'right', render: (l) => num(l.ordered_qty, 3) },
            { key: 'qty_delivered', label: 'Delivered', align: 'right', render: (l) => num(l.qty_delivered, 3) },
            { key: 'qty_accepted', label: 'Accepted', align: 'right', render: (l) => num(l.qty_accepted, 3) },
            { key: 'qty_rejected', label: 'Rejected', align: 'right', render: (l) => (Number(l.qty_rejected) ? <span className="danger-text">{num(l.qty_rejected, 3)}</span> : '0') },
            { key: 'batch_no', label: 'Batch' },
            { key: 'inspection_result', label: 'Inspection', render: (l) => <><Badge value={l.inspection_result} /> <span className="muted small-text">{l.inspection_notes}</span></> },
            { key: 'variance_flag', label: 'Flag', render: (l) => <Badge value={l.variance_flag} outline tone="danger" icon={null} /> },
          ]} />} />
      )}
    </div>
  );
}

type MivRow = Miv & { miv_lines: MivLine[] };
function MivList({ L, projectId, emergencyOnly }: { L: Lookups; projectId: string; emergencyOnly: boolean }) {
  const nav = useNavigate();
  const q = useAsync(() => fetchAll<MivRow>((a, b) => {
    let qb = supabase.from('mivs').select('*, miv_lines(*)').eq('project_id', projectId);
    if (emergencyOnly) qb = qb.eq('is_emergency', true);
    return qb.order('issued_at', { ascending: false }).range(a, b);
  }), [projectId, emergencyOnly], { key: 'mivs' });
  const p = emergencyOnly ? 'e' : 'm';
  const [f, setF, { active, clear }] = useUrlFilters({ from: '', to: '', element: '', receiver: '', status: '' }, p);
  const [openId, setOpenId] = useUrlParam('open');
  const { can } = useAuth();
  const rows = (q.data ?? []).filter((m) => inRange(m.issued_at, f.from, f.to) && (!f.element || m.miv_lines.some((l) => l.element_id === f.element))
    && (!f.receiver || m.issued_to === f.receiver) && (!f.status || m.status === f.status || (f.status === 'open' && !m.mr_id && m.status !== 'reversed')));
  const open = q.data?.find((m) => m.id === openId) ?? null;
  return (
    <div className="stack">
      <ErrorBanner error={q.error} onRetry={q.reload} />
      {emergencyOnly && <Banner tone="warn">Emergency issues must be regularised against an approved request within 24 hours (BR-01). Regularise from the <Link to="/approvals?type=emergency">Approvals inbox</Link>.</Banner>}
      <FilterBar active={active} onClear={clear}>
        <FilterDate label="From" value={f.from} onChange={(v) => setF('from', v)} />
        <FilterDate label="To" value={f.to} onChange={(v) => setF('to', v)} />
        <FilterSelect label="Element" value={f.element} onChange={(v) => setF('element', v)} options={L.elements.map((e) => ({ value: e.id, label: L.element(e.id) }))} />
        <FilterSelect label="Issued to" value={f.receiver} onChange={(v) => setF('receiver', v)} options={L.profiles.map((x) => ({ value: x.id, label: x.full_name || x.email || '' }))} />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={emergencyOnly
          ? [{ value: 'open', label: 'Not regularised' }, { value: 'reversed', label: 'Reversed' }]
          : [{ value: 'pending_ack', label: 'Awaiting sign-off' }, { value: 'acknowledged', label: 'Acknowledged' }, { value: 'reversed', label: 'Reversed' }]} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data} exportName={emergencyOnly ? 'emergency-issues' : 'issue-register'} onRowClick={(r) => setOpenId(r.id, true)} activeKey={openId}
        urlKey={p} viewKey={emergencyOnly ? 'emergency' : 'mivs'} stickyFirst filtered={active > 0} onClearFilters={clear}
        empty={emergencyOnly ? { title: 'No emergency issues', body: 'Good — every issue went through an approved request.' } : { title: 'No issues yet', body: 'MIVs posted by store keepers appear here.' }}
        columns={[
          { key: 'number', label: 'MIV', id: true, render: (r) => <>{isOverdueEmergency(r) && <span className="danger-text" title="Not regularised after 24 h"><TriangleAlert size={13} /> </span>}{r.number}</> },
          { key: 'issued_at', label: 'Issued', render: (r) => dateTime(r.issued_at) },
          { key: 'store', label: 'Store', value: (r) => L.store(r.store_id) },
          { key: 'issued_to', label: 'Issued to', value: (r) => L.person(r.issued_to) },
          { key: 'elements', label: 'Elements', value: (r) => [...new Set(r.miv_lines.map((l) => L.element(l.element_id)))].join(', ') },
          { key: 'materials', label: 'Materials', hidden: true, value: (r) => r.miv_lines.map((l) => `${L.spec(l.material_spec_id)} ${num(l.qty)}`).join('; ') },
          { key: 'emergency', label: 'Emergency', value: (r) => (r.is_emergency ? (r.mr_id ? 'Regularised' : 'Open') : ''),
            render: (r) => (r.is_emergency ? <Badge value={r.mr_id ? 'approved' : 'critical'} label={r.mr_id ? 'Regularised' : `Open · ${num(hoursSince(r.issued_at), 0)} h`} /> : '') },
          { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
          ...(emergencyOnly && can('miv.post') ? [{ key: '_reg', label: '', noExport: true, render: (r: MivRow) => (!r.mr_id && r.status !== 'reversed'
            ? <button className="small primary" onClick={() => nav(`/approvals?type=emergency&id=${r.id}`)}>Regularise…</button> : null) }] : []),
        ]} />
      {open && (
        <DocDrawer title={`MIV ${open.number}`} status={<Badge value={open.status} />} onClose={() => setOpenId(null)} entityType="miv" entityId={open.id}
          actions={open.status !== 'reversed' && <ReverseButton docType="miv" docId={open.id} number={open.number} onDone={() => setOpenId(null)} />}
          header={[['Issued', dateTime(open.issued_at)], ['Store', L.store(open.store_id)], ['Issued by', L.person(open.issued_by)], ['Issued to', L.person(open.issued_to)],
            ['Request', open.mr_id ? <Link key="mr" to={`/requests/${open.mr_id}`}>Open request</Link> : ''], ['Acknowledged', dateTime(open.acknowledged_at)],
            ['Emergency', open.is_emergency ? `Yes — ${open.emergency_reason ?? ''}${open.regularised_at ? ` (regularised ${dateTime(open.regularised_at)})` : ''}` : 'No'], ['Remarks', open.remarks]]}
          lines={<DataTable rows={[...open.miv_lines].sort((a, b) => a.line_no - b.line_no)} maxHeight="none" columns={[
            { key: 'line_no', label: '#', align: 'right' },
            { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
            { key: 'element', label: 'Element', value: (l) => L.element(l.element_id) },
            { key: 'qty', label: 'Qty', align: 'right', render: (l) => <>{num(l.qty, 3)}<span className="unit">{L.specUom(l.material_spec_id)}</span></> },
            { key: 'substitution_reason', label: 'Substitution' },
          ]} />} />
      )}
    </div>
  );
}

type MrnRow = Mrn & { mrn_lines: MrnLine[]; remarks: string | null };
function MrnList({ L, projectId }: { L: Lookups; projectId: string }) {
  const q = useAsync(() => fetchAll<MrnRow>((a, b) => supabase.from('mrns').select('*, mrn_lines(*)').eq('project_id', projectId).order('returned_at', { ascending: false }).range(a, b)), [projectId], { key: 'mrns' });
  const [openId, setOpenId] = useUrlParam('open');
  const open = q.data?.find((m) => m.id === openId) ?? null;
  return (
    <div className="stack">
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <DataTable rows={q.data ?? []} loading={!q.data} exportName="return-register" onRowClick={(r) => setOpenId(r.id, true)} activeKey={openId} urlKey="r" stickyFirst
        empty={{ title: 'No returns yet', body: 'Material returned from site to the store (MRN) appears here.' }} columns={[
        { key: 'number', label: 'MRN', id: true },
        { key: 'returned_at', label: 'Returned', render: (r) => dateTime(r.returned_at) },
        { key: 'store', label: 'Store', value: (r) => L.store(r.store_id) },
        { key: 'returned_by', label: 'Returned by', value: (r) => L.person(r.returned_by) },
        { key: 'materials', label: 'Materials', value: (r) => r.mrn_lines.map((l) => `${L.spec(l.material_spec_id)} ${num(l.qty)} (${l.condition})`).join('; ') },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
      ]} />
      {open && (
        <DocDrawer title={`MRN ${open.number}`} status={<Badge value={open.status} />} onClose={() => setOpenId(null)} entityType="mrn" entityId={open.id}
          actions={open.status === 'posted' && <ReverseButton docType="mrn" docId={open.id} number={open.number} onDone={() => setOpenId(null)} />}
          header={[['Returned', dateTime(open.returned_at)], ['Store', L.store(open.store_id)], ['Returned by', L.person(open.returned_by)], ['Received by', L.person(open.received_by)], ['Remarks', open.remarks]]}
          lines={<DataTable rows={open.mrn_lines} maxHeight="none" columns={[
            { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
            { key: 'element', label: 'Element', value: (l) => L.element(l.element_id) },
            { key: 'qty', label: 'Qty', align: 'right', render: (l) => num(l.qty, 3) },
            { key: 'condition', label: 'Condition', render: (l) => <Badge value={l.condition} /> },
          ]} />} />
      )}
    </div>
  );
}

type TransferRow = Transfer & { transfer_lines: TransferLine[]; remarks: string | null };
function Transfers({ L, projectId }: { L: Lookups; projectId: string }) {
  const q = useAsync(() => fetchAll<TransferRow>((a, b) => supabase.from('transfers').select('*, transfer_lines(*)')
    .or(`project_id.eq.${projectId},to_project_id.eq.${projectId}`).order('sent_at', { ascending: false }).range(a, b)), [projectId], { key: 'transfers' });
  const stores = useAsync(async () => new Map((check(await supabase.from('stores').select('id, name, project_id')) as { id: string; name: string }[]).map((s) => [s.id, s.name])), [], { key: 'all-stores', staleTime: 10 * 60_000 });
  const storeName = (id: string) => stores.data?.get(id) ?? L.store(id);
  const [f, setF, { active, clear }] = useUrlFilters({ tstatus: 'in_transit' });
  const rows = (q.data ?? []).filter((r) => !f.tstatus || r.status === f.tstatus);
  return (
    <div className="stack">
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={() => setF('tstatus', '')}>
        <FilterSelect label="Status" value={f.tstatus} onChange={(v) => setF('tstatus', v)} options={[{ value: 'in_transit', label: 'In transit' }, { value: 'received', label: 'Received' }]} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data} exportName="transfers" urlKey="t" stickyFirst filtered={!!f.tstatus} onClearFilters={clear}
        empty={{ title: 'No transfers', body: 'Store-to-store and inter-project transfers appear here.' }} columns={[
        { key: 'number', label: 'Transfer', id: true },
        { key: 'direction', label: 'Direction', value: (r) => (r.project_id === projectId ? (r.to_project_id === projectId ? 'Internal' : 'Outgoing') : 'Incoming') },
        { key: 'from', label: 'From', value: (r) => storeName(r.from_store_id) },
        { key: 'to', label: 'To', value: (r) => storeName(r.to_store_id) },
        { key: 'sent_at', label: 'Sent', render: (r) => dateTime(r.sent_at) },
        { key: 'age', label: 'Age', align: 'right', value: (r) => (r.status === 'in_transit' ? hoursSince(r.sent_at) : null),
          render: (r) => (r.status === 'in_transit' ? <span className={hoursSince(r.sent_at) > 72 ? 'danger-text' : ''}>{num(hoursSince(r.sent_at) / 24, 1)} d</span> : <span className="muted-dash">—</span>) },
        { key: 'received_at', label: 'Received', render: (r) => dateTime(r.received_at) },
        { key: 'materials', label: 'Materials', value: (r) => r.transfer_lines.map((l) => `${L.spec(l.material_spec_id)} ${num(l.qty)}${l.qty_received !== null && Number(l.qty_received) !== Number(l.qty) ? ` (recv ${num(l.qty_received)})` : ''}`).join('; ') },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
      ]} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

type AdjRow = Adjustment & { adjustment_lines: AdjustmentLine[]; decided_by: string | null; decision_comment: string | null };
function Adjustments({ L, projectId }: { L: Lookups; projectId: string }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const q = useAsync(() => fetchAll<AdjRow>((a, b) => supabase.from('adjustments').select('*, adjustment_lines(*)').eq('project_id', projectId).order('created_at', { ascending: false }).range(a, b)), [projectId], { key: 'adjustments' });
  const [f, setF, { active, clear }] = useUrlFilters({ astatus: can('adjustment.decide') ? 'pending' : '', atype: '' });
  const [openId, setOpenId] = useUrlParam('open');
  const rows = (q.data ?? []).filter((r) => (!f.astatus || r.status === f.astatus) && (!f.atype || r.adj_type === f.atype));
  const open = q.data?.find((r) => r.id === openId) ?? null;
  return (
    <div className="stack">
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={() => { setF('astatus', ''); setF('atype', ''); }}>
        <FilterSelect label="Status" value={f.astatus} onChange={(v) => setF('astatus', v)} options={[{ value: 'pending', label: 'Awaiting approval' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} />
        <FilterSelect label="Type" value={f.atype} onChange={(v) => setF('atype', v)} options={['wastage', 'damage', 'loss', 'write_off', 'count_variance'].map((x) => ({ value: x, label: humanize(x) }))} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data} exportName="adjustments" urlKey="a" stickyFirst filtered={active > 0} onClearFilters={clear} activeKey={openId}
        onRowClick={(r) => (r.status === 'pending' && can('adjustment.decide') ? nav(`/approvals?type=adjustment&id=${r.id}`) : setOpenId(r.id, true))}
        empty={{ title: 'No adjustments', body: 'Wastage, damage, loss and write-offs raised by store keepers appear here.' }} columns={[
        { key: 'number', label: 'Number', id: true },
        { key: 'created_at', label: 'Raised', render: (r) => dateTime(r.created_at) },
        { key: 'adj_type', label: 'Type', value: (r) => humanize(r.adj_type) },
        { key: 'reason_code', label: 'Reason' },
        { key: 'store', label: 'Store', value: (r) => L.store(r.store_id) },
        { key: 'lines', label: 'Materials', value: (r) => r.adjustment_lines.map((l) => `${L.spec(l.material_spec_id)} ${num(l.qty_delta)}${l.stock_status === 'quarantine' ? ' (quarantine)' : ''}`).join('; ') },
        { key: 'requested_by', label: 'Raised by', value: (r) => L.person(r.requested_by) },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        ...(can('adjustment.decide') ? [{ key: '_act', label: '', noExport: true, render: (r: AdjRow) => (r.status === 'pending'
          ? <button className="small primary" onClick={() => nav(`/approvals?type=adjustment&id=${r.id}`)}>Review</button> : null) }] : []),
      ]} />
      {open && (
        <DocDrawer title={`Adjustment ${open.number}`} status={<Badge value={open.status} />} onClose={() => setOpenId(null)} entityType="adjustment" entityId={open.id}
          header={[['Type', humanize(open.adj_type)], ['Reason', open.reason_code], ['Store', L.store(open.store_id)], ['Raised by', L.person(open.requested_by)],
            ['Decided by', L.person(open.decided_by)], ['Decision comment', open.decision_comment], ['Remarks', open.remarks]]}
          lines={<DataTable rows={open.adjustment_lines} maxHeight="none" columns={[
            { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
            { key: 'element', label: 'Element', value: (l) => L.element(l.element_id) },
            { key: 'stock_status', label: 'Stock', render: (l) => <Badge value={l.stock_status} /> },
            { key: 'qty_delta', label: 'Change', align: 'right', render: (l) => num(l.qty_delta, 3) },
          ]} />} />
      )}
    </div>
  );
}

type CountRow = StockCount & { stock_count_lines: StockCountLine[]; remarks: string | null; decided_by: string | null; decision_comment: string | null };
function Counts({ L, projectId }: { L: Lookups; projectId: string }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const q = useAsync(() => fetchAll<CountRow>((a, b) => supabase.from('stock_counts').select('*, stock_count_lines(*)').eq('project_id', projectId).order('counted_at', { ascending: false }).range(a, b)), [projectId], { key: 'stock-counts' });
  const [f, setF, { active, clear }] = useUrlFilters({ cstatus: can('count.decide') ? 'submitted' : '' });
  const [openId, setOpenId] = useUrlParam('open');
  const rows = (q.data ?? []).filter((r) => !f.cstatus || r.status === f.cstatus);
  const open = q.data?.find((r) => r.id === openId) ?? null;
  return (
    <div className="stack">
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={() => setF('cstatus', '')}>
        <FilterSelect label="Status" value={f.cstatus} onChange={(v) => setF('cstatus', v)} options={[{ value: 'submitted', label: 'Awaiting approval' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data} exportName="stock-counts" urlKey="c" stickyFirst filtered={active > 0} onClearFilters={clear} activeKey={openId}
        onRowClick={(r) => (r.status === 'submitted' && can('count.decide') ? nav(`/approvals?type=count&id=${r.id}`) : setOpenId(r.id, true))}
        empty={{ title: 'No stock counts yet', body: 'Periodic and spot counts submitted from the store appear here.' }} columns={[
        { key: 'number', label: 'Count', id: true },
        { key: 'counted_at', label: 'Counted', render: (r) => dateTime(r.counted_at) },
        { key: 'count_type', label: 'Type', value: (r) => humanize(r.count_type) },
        { key: 'store', label: 'Store', value: (r) => L.store(r.store_id) },
        { key: 'items', label: 'Items', align: 'right', value: (r) => r.stock_count_lines.length },
        { key: 'variances', label: 'With variance', align: 'right', value: (r) => r.stock_count_lines.filter((l) => Number(l.variance) !== 0).length },
        { key: 'counted_by', label: 'Counted by', value: (r) => L.person(r.counted_by) },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status === 'submitted' ? 'pending' : r.status} label={r.status === 'submitted' ? 'Awaiting approval' : undefined} /> },
      ]} />
      {open && (
        <DocDrawer title={`Stock count ${open.number}`} status={<Badge value={open.status === 'submitted' ? 'pending' : open.status} />} onClose={() => setOpenId(null)} entityType="stock_count" entityId={open.id}
          header={[['Store', L.store(open.store_id)], ['Counted', `${dateTime(open.counted_at)} by ${L.person(open.counted_by)}`], ['Decided by', L.person(open.decided_by)], ['Decision comment', open.decision_comment]]}
          lines={<DataTable rows={open.stock_count_lines} maxHeight="none" rowClass={(l) => (Number(l.variance) !== 0 ? 'row-warn' : undefined)} columns={[
            { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
            { key: 'system_qty', label: 'System', align: 'right', render: (l) => num(l.system_qty, 3) },
            { key: 'counted_qty', label: 'Physical', align: 'right', render: (l) => num(l.counted_qty, 3) },
            { key: 'variance', label: 'Variance', align: 'right', render: (l) => <span className={Number(l.variance) < 0 ? 'danger-text' : ''}>{num(l.variance, 3)}</span> },
          ]} />} />
      )}
    </div>
  );
}

