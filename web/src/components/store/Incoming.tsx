// Store: purchase orders on their way — from the award (approved / awaiting approval / being sent) to delivery —
// and receiving against the PO itself (post_grn with po_id; the open delivery notice is closed with it when there is one).
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PackageCheck } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { can } from '../../lib/contract';
import { flowRpc } from '../../lib/flows';
import { nextDocNumber } from '../../lib/device-numbers';
import { dueIn, qty as fmtQty, shortDate } from '../../lib/format';
import { Badge, Banner, DataTable, Drawer, ErrorBanner, Field, FilterBar, Loading, QtyInput, SearchInput, Tabs, toast, useBusy, type Tone } from '../ui';

type PoLineLite = { id: string; line_no: number; material_spec_id: string; qty: number; qty_accepted: number; mr_line_id: string | null; closed: boolean; deleted_at: string | null };
type NoticeLite = { id: string; po_id: string; status: string; expected_date: string; store_id: string; lines: { po_line_id: string; qty: number }[]; vehicle_plate: string | null; driver_name: string | null };
export type IncomingPo = {
  id: string; number: string; status: string; supplier_id: string; delivery_store_id: string | null; project_id: string; rfq_id: string | null;
  expected_date: string | null; eta: string | null; approved_at: string | null; sent_at: string | null; delivery_status: string | null;
  suppliers: { name: string } | null; po_lines: PoLineLite[];
};

const OPEN_NOTICE = ['notified', 'acknowledged', 'reschedule_requested', 'arrived'];
const RECEIVABLE = ['approved', 'sent', 'partially_received'];

export function poStage(po: IncomingPo, notice?: NoticeLite): { label: string; tone: Tone; step: number } {
  if (po.status === 'draft') return { label: 'Being prepared by procurement', tone: 'neutral', step: 0 };
  if (po.status === 'submitted') return { label: 'Awaiting approval', tone: 'warning', step: 1 };
  if (po.status === 'approved') return { label: 'Approved — not yet sent to supplier', tone: 'info', step: 2 };
  if (notice?.status === 'arrived') return { label: 'At the gate', tone: 'violet', step: 4 };
  if (notice) return { label: 'Delivery announced', tone: 'info', step: 4 };
  if (po.status === 'partially_received') return { label: 'Partially received', tone: 'violet', step: 4 };
  return { label: 'Ordered — on the way', tone: 'success', step: 3 };
}

const outstanding = (l: PoLineLite) => (l.closed || l.deleted_at ? 0 : Math.max(Number(l.qty) - Number(l.qty_accepted), 0));

const PO_SELECT = 'id, number, status, supplier_id, delivery_store_id, project_id, rfq_id, expected_date, eta, approved_at, sent_at, delivery_status, suppliers(name), po_lines(id, line_no, material_spec_id, qty, qty_accepted, mr_line_id, closed, deleted_at)';

export async function loadIncoming(projectId: string): Promise<{ pos: IncomingPo[]; notices: NoticeLite[] }> {
  const [pos, notices] = await Promise.all([
    fetchAll<IncomingPo>((a, b) => supabase.from('purchase_orders').select(PO_SELECT as '*')
      .eq('project_id', projectId).in('status', ['draft', 'submitted', 'approved', 'sent', 'partially_received'])
      .order('expected_date', { ascending: true, nullsFirst: false }).range(a, b), 5000),
    fetchAll<NoticeLite>((a, b) => supabase.from('delivery_notices').select('id, po_id, status, expected_date, store_id, lines, vehicle_plate, driver_name')
      .eq('project_id', projectId).in('status', OPEN_NOTICE).order('expected_date').range(a, b), 5000),
  ]);
  return { pos: pos.filter((p) => p.status !== 'draft' || p.rfq_id), notices };
}

/** One order with its open delivery notice (inbox previews). */
export async function loadIncomingPo(id: string): Promise<{ po: IncomingPo; notice?: NoticeLite }> {
  const po = check(await supabase.from('purchase_orders').select(PO_SELECT as '*').eq('id', id).maybeSingle()) as IncomingPo | null;
  if (!po) throw new Error('Purchase order not found or not in your projects');
  const ns = check(await supabase.from('delivery_notices').select('id, po_id, status, expected_date, store_id, lines, vehicle_plate, driver_name')
    .eq('po_id', id).in('status', OPEN_NOTICE).order('expected_date').limit(1)) as NoticeLite[];
  return { po, notice: ns[0] };
}

/** Store tab "Incoming orders". */
export function IncomingOrders({ L, projectId }: { L: Lookups; projectId: string }) {
  const auth = useAuth();
  const canGrn = can(auth.profile?.role ?? null, 'grn.post');
  const q = useAsync(() => loadIncoming(projectId), [projectId], { key: 'store-incoming', staleTime: 15_000 });
  const [view, setView] = useState<'due' | 'all'>('all');
  const [term, setTerm] = useState('');
  const [receive, setReceive] = useState<{ po: IncomingPo; notice?: NoticeLite } | null>(null);
  const noticeOf = useMemo(() => new Map((q.data?.notices ?? []).map((n) => [n.po_id, n])), [q.data]);
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const rows = (q.data?.pos ?? []).filter((p) => p.po_lines.some((l) => outstanding(l) > 0 || !RECEIVABLE.includes(p.status)))
    .filter((p) => view === 'all' || (RECEIVABLE.includes(p.status) && (p.eta ?? p.expected_date ?? today) <= soon))
    .filter((p) => !term || `${p.number} ${p.suppliers?.name ?? ''}`.toLowerCase().includes(term.toLowerCase()));
  const due = (q.data?.pos ?? []).filter((p) => RECEIVABLE.includes(p.status) && (p.eta ?? p.expected_date ?? today) <= soon).length;

  return (
    <div className="stack">
      <FilterBar right={<SearchInput value={term} onChange={setTerm} placeholder="PO or supplier" />}>
        <Tabs variant="segmented" label="Incoming view" value={view} onChange={setView}
          tabs={[{ key: 'all', label: 'All open orders', count: q.data?.pos.length }, { key: 'due', label: 'Due in 3 days', count: due, hot: due > 0 }]} />
      </FilterBar>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <DataTable rows={rows} rowKey={(p) => p.id} loading={!q.data} maxHeight="none"
        empty={{ title: 'Nothing on order', body: 'Awarded and approved purchase orders appear here until they are fully received.' }}
        columns={[
          { key: 'number', label: 'PO', id: true, render: (p) => <Link to={`/procurement/po/${p.id}`}>{p.number}</Link> },
          { key: 'supplier', label: 'Supplier', value: (p) => p.suppliers?.name ?? '' },
          { key: 'stage', label: 'Stage', value: (p) => poStage(p, noticeOf.get(p.id)).label,
            render: (p) => { const s = poStage(p, noticeOf.get(p.id)); return <Badge tone={s.tone} label={s.label} icon={null} />; } },
          { key: 'expected', label: 'Expected', value: (p) => noticeOf.get(p.id)?.expected_date ?? p.eta ?? p.expected_date ?? '',
            render: (p) => {
              const d = noticeOf.get(p.id)?.expected_date ?? p.eta ?? p.expected_date;
              const x = d && RECEIVABLE.includes(p.status) ? dueIn(d) : null;
              return d ? <span className="nowrap">{shortDate(d)}{x?.text && <span className={`small-text ${x.late ? 'danger-text' : 'muted'}`}> {x.text}</span>}</span> : '—';
            } },
          { key: 'store', label: 'Deliver to', value: (p) => L.store(p.delivery_store_id) },
          { key: 'items', label: 'Still to come', value: (p) => p.po_lines.filter((l) => !l.deleted_at && (outstanding(l) > 0 || !RECEIVABLE.includes(p.status)))
            .map((l) => `${L.spec(l.material_spec_id)} ${fmtQty(RECEIVABLE.includes(p.status) ? outstanding(l) : l.qty, L.specUom(l.material_spec_id))}`).join(' · ') },
          { key: 'act', label: '', sortable: false, noExport: true, render: (p) => (canGrn && RECEIVABLE.includes(p.status)
            ? <button className="small primary" onClick={(e) => { e.stopPropagation(); setReceive({ po: p, notice: noticeOf.get(p.id) }); }}><PackageCheck size={14} aria-hidden />Receive (GRN)</button>
            : null) },
        ]} />
      {!canGrn && <p className="muted small-text mb-0">Store keepers receive these orders with a GRN when the truck arrives.</p>}
      {receive && <GrnFromPoDrawer po={receive.po} notice={receive.notice} L={L} onClose={() => setReceive(null)} onDone={() => q.reload()} />}
    </div>
  );
}

/** GRN against a purchase order (and its open delivery notice, if any). */
export function GrnFromPoDrawer({ po, notice, L, onClose, onDone }: { po: IncomingPo; notice?: NoticeLite; L: Lookups; onClose: () => void; onDone?: () => void }) {
  const auth = useAuth();
  const lq = useAsync(async () => check(await supabase.from('po_lines').select('id, line_no, material_spec_id, qty, qty_accepted, mr_line_id, closed, deleted_at')
    .eq('po_id', po.id).is('deleted_at', null).order('line_no')) as PoLineLite[], [po.id], { key: 'po-lines-grn' });
  const lines = (lq.data ?? []).filter((l) => outstanding(l) > 0);
  const announced = (l: PoLineLite) => Number(notice?.lines.find((x) => x.po_line_id === l.id)?.qty ?? outstanding(l));
  const [store, setStore] = useState(notice?.store_id ?? po.delivery_store_id ?? '');
  const [rows, setRows] = useState<Record<string, { del: string; rej: string; result: 'pass' | 'conditional' | 'reject'; notes: string }>>({});
  const [h, setH] = useState({ delivery_note_no: '', vehicle_plate: notice?.vehicle_plate ?? '', driver_name: notice?.driver_name ?? '', remarks: '' });
  const { busy, error, run } = useBusy();
  const r = (l: PoLineLite) => rows[l.id] ?? { del: String(announced(l)), rej: '0', result: 'pass' as const, notes: '' };
  const setR = (l: PoLineLite, patch: Partial<ReturnType<typeof r>>) => setRows({ ...rows, [l.id]: { ...r(l), ...patch } });
  const stores = L.stores.filter((s) => s.project_id === po.project_id);

  const go = () => void run(async () => {
    if (!store) throw new Error('Choose the store receiving the goods');
    const out = lines.map((l, i) => {
      const x = r(l); const del = Number(x.del), rej = Number(x.rej) || 0;
      if (!(del >= 0) || rej < 0 || rej > del) throw new Error(`Line ${i + 1}: check delivered / rejected quantities`);
      return { id: crypto.randomUUID(), material_spec_id: l.material_spec_id, po_line_id: l.id, mr_line_id: l.mr_line_id ?? undefined, ordered_qty: announced(l),
        qty_delivered: del, qty_rejected: rej, qty_accepted: del - rej, inspection_result: x.result, inspection_notes: x.notes || undefined };
    }).filter((l) => l.qty_delivered > 0);
    if (!out.length) throw new Error('Enter the delivered quantity for at least one line');
    const number = await nextDocNumber(auth.project?.code ?? '', 'GRN');
    await flowRpc('post_grn', { id: crypto.randomUUID(), project_id: po.project_id, number, store_id: store, po_id: po.id,
      ...(notice && notice.store_id === store ? { delivery_notice_id: notice.id } : {}),
      supplier_id: po.supplier_id, delivery_note_no: h.delivery_note_no || undefined, vehicle_plate: h.vehicle_plate || undefined,
      driver_name: h.driver_name || undefined, received_at: new Date().toISOString(), remarks: h.remarks || undefined, lines: out });
    toast.success(`${number} posted — stock updated, requester informed`);
    onDone?.(); onClose();
  });

  return (
    <Drawer size="lg" title={`Receive ${po.number} (GRN)`} subtitle={`${po.suppliers?.name ?? ''}${notice ? ` · delivery announced for ${shortDate(notice.expected_date)}` : ''}`} onClose={onClose}
      footer={<><button onClick={onClose} disabled={busy}>Cancel</button><button className="primary" disabled={busy || !lines.length} onClick={go}>{busy && <span className="spinner" />}Post GRN</button></>}>
      <div className="stack">
        <ErrorBanner error={error ?? lq.error} />
        {!notice && <Banner tone="info">No delivery notice for this order — you can still receive it against the purchase order.</Banner>}
        <div className="form-grid">
          <Field label="Receiving store" required>
            <select value={store} onChange={(e) => setStore(e.target.value)}>
              <option value="">Choose…</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Supplier delivery note no."><input value={h.delivery_note_no} onChange={(e) => setH({ ...h, delivery_note_no: e.target.value })} data-autofocus /></Field>
          <Field label="Vehicle plate"><input value={h.vehicle_plate} onChange={(e) => setH({ ...h, vehicle_plate: e.target.value.toUpperCase() })} /></Field>
          <Field label="Driver"><input value={h.driver_name} onChange={(e) => setH({ ...h, driver_name: e.target.value })} /></Field>
          <Field label="Remarks" wide><input value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} /></Field>
        </div>
        {!lq.data ? <Loading lines={4} /> : !lines.length ? <Banner tone="ok">Everything on this order has been received.</Banner> : (
          <DataTable rows={lines} rowKey={(l) => l.id} maxHeight="none" columns={[
            { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
            { key: 'out', label: notice ? 'Announced' : 'Outstanding', align: 'right', render: (l) => fmtQty(announced(l), L.specUom(l.material_spec_id)) },
            { key: 'del', label: 'Delivered', align: 'right', render: (l) => <QtyInput width={110} value={r(l).del} unit={L.specUom(l.material_spec_id)} min={0} aria-label="Delivered" onChange={(v) => setR(l, { del: v })} /> },
            { key: 'rej', label: 'Rejected', align: 'right', render: (l) => <QtyInput width={100} value={r(l).rej} min={0} aria-label="Rejected" onChange={(v) => setR(l, { rej: v })} /> },
            { key: 'res', label: 'Inspection', render: (l) => (
              <select aria-label="Inspection result" value={r(l).result} onChange={(e) => setR(l, { result: e.target.value as 'pass' })}>
                <option value="pass">Pass</option><option value="conditional">Conditional</option><option value="reject">Reject</option>
              </select>) },
            { key: 'notes', label: 'Notes', render: (l) => <input aria-label="Inspection notes" value={r(l).notes} onChange={(e) => setR(l, { notes: e.target.value })} /> },
          ]} />
        )}
        <p className="muted small-text mb-0">Accepted = delivered − rejected. The stock balance and bin card update as soon as the GRN is posted.</p>
      </div>
    </Drawer>
  );
}
