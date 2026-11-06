import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Check, PackageCheck } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { fetchAll, supabase } from '../../lib/supabase';
import { canFlow, type DeliveryNotice, type DeliveryNoticeStatus } from '../../lib/contract-flows';
import { can as canBase } from '../../lib/contract';
import { date, dateTime, dueIn, humanize, qty, shortDate } from '../../lib/format';
import { useUrlFilters, useUrlParam } from '../../lib/url';
import { AckNoticeModal, GrnFromNoticeDrawer } from '../../components/flows/FlowDialogs';
import { Badge, DataTable, Drawer, ErrorBanner, FilterBar, FilterSelect, Page, SearchInput, Tabs, type Column, type Tone } from '../../components/ui';
import '../../components/flows/flows.css';

type Row = DeliveryNotice & { purchase_orders: { number: string; supplier_id: string; status: string } | null };
const OPEN: DeliveryNoticeStatus[] = ['notified', 'acknowledged', 'reschedule_requested', 'arrived'];
const TONE: Record<DeliveryNoticeStatus, Tone> = { notified: 'info', acknowledged: 'success', reschedule_requested: 'warning', arrived: 'violet', received: 'success', cancelled: 'neutral' };
const LABEL: Record<DeliveryNoticeStatus, string> = { notified: 'Awaiting store', acknowledged: 'Accepted by store', reschedule_requested: 'Reschedule asked', arrived: 'At the gate', received: 'Received (GRN)', cancelled: 'Cancelled' };
export const NoticeBadge = ({ s }: { s: DeliveryNoticeStatus }) => <Badge tone={TONE[s]} label={LABEL[s] ?? humanize(s)} icon={null} />;

/**
 * Delivery notices (procurement-lookahead.md §5.4): procurement announces a PO delivery; the store keeper
 * accepts it (or asks for another date) and confirms with a GRN linked to the notice; security sees expected vehicles.
 */
export function Deliveries() {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const role = auth.profile?.role;
  const q = useAsync(() => fetchAll<Row>((a, b) => supabase.from('delivery_notices').select('*, purchase_orders(number, supplier_id, status)')
    .eq('project_id', projectId).order('expected_date', { ascending: true }).range(a, b), 5000), [projectId], { key: 'delivery-notices' });
  const [f, setF, { active, clear }] = useUrlFilters({ view: 'open', store: '', q: '' });
  const [open, setOpen] = useUrlParam('open');
  const [dlg, setDlg] = useState<{ kind: 'accept' | 'reschedule' | 'grn'; row: Row } | null>(null);
  const L = lk.data;
  const all = q.data ?? [];
  const term = f.q.toLowerCase();
  const inView = (r: Row) => (f.view === 'open' ? OPEN.includes(r.status) : f.view === 'mine' ? r.status === 'notified' || r.status === 'arrived' : f.view === 'done' ? !OPEN.includes(r.status) : true);
  const rows = all.filter((r) => inView(r) && (!f.store || r.store_id === f.store) && (!term || (r.purchase_orders?.number ?? '').toLowerCase().includes(term) || (r.vehicle_plate ?? '').toLowerCase().includes(term)));
  const canAck = canFlow(role, 'delivery.acknowledge');
  const canGrn = canBase(role ?? null, 'grn.post');
  const sel = all.find((r) => r.id === open) ?? null;
  const supplier = (id?: string) => L?.suppliers.find((s) => s.id === id)?.name ?? '';

  const columns: Column<Row>[] = [
    { key: 'expected_date', label: 'Expected', render: (r) => {
      const d = OPEN.includes(r.status) ? dueIn(r.expected_date) : null;
      return <span className="nowrap">{shortDate(r.expected_date)}{r.expected_window && <span className="muted small-text"> {r.expected_window}</span>}{d?.text && <span className={`small-text ${d.late ? 'danger-text' : 'muted'}`}> · {d.text}</span>}</span>;
    } },
    { key: 'po', label: 'PO', id: true, value: (r) => r.purchase_orders?.number ?? '' },
    { key: 'supplier', label: 'Supplier', value: (r) => supplier(r.purchase_orders?.supplier_id) },
    { key: 'store', label: 'Store', value: (r) => L?.store(r.store_id) },
    { key: 'items', label: 'Items', value: (r) => r.lines.map((l) => `${L?.spec(l.material_spec_id)} × ${qty(l.qty, L?.specUom(l.material_spec_id))}`).join(', ') },
    { key: 'vehicle', label: 'Vehicle', value: (r) => [r.vehicle_plate, r.driver_name].filter(Boolean).join(' · ') },
    { key: 'status', label: 'Status', value: (r) => LABEL[r.status], render: (r) => <><NoticeBadge s={r.status} />{r.proposed_date && r.status === 'reschedule_requested' && <span className="small-text muted"> → {shortDate(r.proposed_date)}</span>}</> },
    { key: 'ack', label: 'Store', hidden: true, value: (r) => (r.ack_by ? `${L?.person(r.ack_by)} ${dateTime(r.ack_at)}` : '') },
  ];

  return (
    <Page title="Deliveries" subtitle="Purchased materials announced by procurement — accept the delivery, then confirm it with a GRN">
      <Tabs label="Delivery views" value={f.view} onChange={(v) => setF('view', v)} tabs={[
        { key: 'mine', label: canAck ? 'Needs my action' : 'Awaiting store', count: all.filter((r) => r.status === 'notified' || r.status === 'arrived').length, hot: true },
        { key: 'open', label: 'Open', count: all.filter((r) => OPEN.includes(r.status)).length },
        { key: 'done', label: 'Received / cancelled' },
        { key: 'all', label: 'All' },
      ]} />
      <ErrorBanner error={q.error ?? lk.error} onRetry={q.reload} />
      <FilterBar active={active - (f.view !== 'open' ? 1 : 0)} onClear={() => { clear(); }}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="PO no., vehicle" />
        <FilterSelect label="Store" value={f.store} onChange={(v) => setF('store', v)} options={(L?.stores ?? []).map((s) => ({ value: s.id, label: s.name }))} />
      </FilterBar>
      <DataTable rows={rows} columns={columns} loading={!q.data || !L} error={q.error} onRetry={q.reload} urlKey="" viewKey="deliveries" stickyFirst exportName="delivery-notices"
        filtered={active > 0} onClearFilters={clear} activeKey={open} onRowClick={(r) => setOpen(r.id, true)}
        empty={{ title: 'No deliveries announced', body: 'When procurement notifies the store of a purchase order delivery it appears here (and at the gate).' }} />

      {sel && L && (
        <Drawer title={`Delivery · PO ${sel.purchase_orders?.number ?? ''}`} subtitle={`${supplier(sel.purchase_orders?.supplier_id)} → ${L.store(sel.store_id)} · ${date(sel.expected_date)}${sel.expected_window ? ` ${sel.expected_window}` : ''}`}
          onClose={() => setOpen(null)} footer={<>
            <span className="grow"><NoticeBadge s={sel.status} /></span>
            {canAck && ['notified', 'acknowledged'].includes(sel.status) && <button onClick={() => setDlg({ kind: 'reschedule', row: sel })}><CalendarClock size={14} aria-hidden />Reschedule…</button>}
            {canAck && ['notified', 'reschedule_requested'].includes(sel.status) && <button className={canGrn ? '' : 'primary'} onClick={() => setDlg({ kind: 'accept', row: sel })}><Check size={14} aria-hidden />Accept delivery</button>}
            {canGrn && OPEN.includes(sel.status) && sel.purchase_orders && ['approved', 'sent', 'partially_received'].includes(sel.purchase_orders.status) &&
              <button className="primary" onClick={() => { setDlg({ kind: 'grn', row: sel }); setOpen(null); }}><PackageCheck size={14} aria-hidden />Receive (GRN)…</button>}
          </>}>
          <div className="stack">
            <dl className="kv">
              <dt>Purchase order</dt><dd><Link to={`/procurement/po/${sel.po_id}`}>{sel.purchase_orders?.number}</Link></dd>
              <dt>Vehicle</dt><dd>{sel.vehicle_plate ?? '—'}{sel.driver_name && <> · {sel.driver_name}</>}{sel.driver_phone && <> · <a href={`tel:${sel.driver_phone}`}>{sel.driver_phone}</a></>}</dd>
              <dt>Notified</dt><dd>{L.person(sel.created_by)} · {dateTime(sel.created_at)}</dd>
              {sel.note && <><dt>Note</dt><dd>{sel.note}</dd></>}
              {sel.ack_by && <><dt>Store</dt><dd>{L.person(sel.ack_by)} · {dateTime(sel.ack_at)}{sel.ack_note && <> — “{sel.ack_note}”</>}</dd></>}
              {sel.proposed_date && <><dt>Proposed date</dt><dd>{date(sel.proposed_date)}</dd></>}
              {sel.grn_id && <><dt>GRN</dt><dd><Link to={`/store?open=${sel.grn_id}#grn`}>Open receipt</Link></dd></>}
            </dl>
            <DataTable rows={sel.lines} rowKey={(l) => l.po_line_id} maxHeight="none" columns={[
              { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
              { key: 'qty', label: 'Expected', align: 'right', render: (l) => <>{qty(l.qty, L.specUom(l.material_spec_id))}<span className="unit">{L.specUom(l.material_spec_id)}</span></> },
            ]} />
          </div>
        </Drawer>
      )}
      {dlg && dlg.kind !== 'grn' && <AckNoticeModal notice={dlg.row} poNumber={dlg.row.purchase_orders?.number ?? ''} decision={dlg.kind} onClose={() => setDlg(null)} onDone={() => q.reload()} />}
      {dlg?.kind === 'grn' && L && <GrnFromNoticeDrawer notice={dlg.row} L={L} onClose={() => setDlg(null)} onDone={() => { setOpen(null); q.reload(); }} />}
    </Page>
  );
}
