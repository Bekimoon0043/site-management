import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { nextDocNumber } from '../../lib/device-numbers';
import { flowRpc } from '../../lib/flows';
import type { DeliveryNotice } from '../../lib/contract-flows';
import type { PoLine } from '../../lib/contract-procurement';
import { money, num, qty as fmtQty, today, dateTime } from '../../lib/format';
import { Drawer, Modal } from '../Dialog';
import { Banner, ErrorBanner, Loading } from '../Page';
import { Field, QtyInput, useBusy } from '../Form';
import { DataTable } from '../DataTable';
import { toast } from '../toast';
import './flows.css';

const Foot = ({ busy, onClose, label, onOk, disabled, danger }: { busy: boolean; onClose: () => void; label: string; onOk: () => void; disabled?: boolean; danger?: boolean }) => (
  <>
    <button onClick={onClose} disabled={busy}>Cancel</button>
    <button className={danger ? 'danger' : 'primary'} disabled={busy || disabled} onClick={onOk}>{busy && <span className="spinner" />}{label}</button>
  </>
);

// ---------------------------------------------------------------------------
// Procurement accepts a management-approved purchase request (optionally assigns a buyer)
// ---------------------------------------------------------------------------
export function AcceptPrModal({ mr, L, onClose, onDone }: { mr: { id: string; number: string }; L: Lookups; onClose: () => void; onDone: () => void }) {
  const auth = useAuth();
  const [assign, setAssign] = useState(auth.profile?.id ?? '');
  const [comment, setComment] = useState('');
  const { busy, error, run } = useBusy();
  const buyers = L.profiles.filter((p) => p.is_active && (p.role === 'procurement' || p.id === auth.profile?.id));
  const go = () => run(async () => {
    await flowRpc('mr_action', { mr_id: mr.id, action: 'accept', assign_to: assign || undefined, comment: comment.trim() || undefined });
    toast.success(`${mr.number} accepted — with procurement`);
    onDone(); onClose();
  });
  return (
    <Modal title={`Accept ${mr.number}`} subtitle="Procurement takes ownership and starts buying" onClose={onClose}
      footer={<Foot busy={busy} onClose={onClose} label="Accept" onOk={() => void go()} />}>
      <div className="stack tight">
        <ErrorBanner error={error} />
        <Field label="Buyer (owner)">
          <select value={assign} onChange={(e) => setAssign(e.target.value)} data-autofocus>
            {buyers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}{p.id === auth.profile?.id ? ' (me)' : ''}</option>)}
          </select>
        </Field>
        <Field label="Comment (optional)"><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Coordinator approves a site-use request = store order (store + issue-by date)
// ---------------------------------------------------------------------------
export function StoreOrderModal({ L, storeId, requiredDate, partial, onClose, onSubmit }: {
  L: Lookups; storeId: string | null; requiredDate: string; partial: number; onClose: () => void;
  onSubmit: (v: { store_id: string; issue_by: string; comment?: string }) => Promise<void>;
}) {
  const [store, setStore] = useState(storeId ?? L.stores.find((s) => s.store_type === 'main')?.id ?? L.stores[0]?.id ?? '');
  const [issueBy, setIssueBy] = useState(requiredDate && requiredDate >= today() ? requiredDate : today());
  const [comment, setComment] = useState('');
  const { busy, error, run } = useBusy();
  return (
    <Modal title="Approve as store order" subtitle={partial ? `${partial} line${partial === 1 ? '' : 's'} approved below the requested quantity` : 'All lines approved as reviewed'}
      onClose={onClose} footer={<Foot busy={busy} onClose={onClose} label="Approve & send to store" disabled={!store || !issueBy}
        onOk={() => void run(async () => { await onSubmit({ store_id: store, issue_by: issueBy, comment: comment.trim() || undefined }); onClose(); })} />}>
      <div className="stack tight">
        <ErrorBanner error={error} />
        <div className="form-grid">
          <Field label="Issue from store" required>
            <select value={store} onChange={(e) => setStore(e.target.value)} data-autofocus>
              {L.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Issue by" required><input type="date" value={issueBy} onChange={(e) => setIssueBy(e.target.value)} /></Field>
        </div>
        <Field label="Comment (optional)"><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <p className="muted small-text mb-0">The store keeper is notified to issue the approved quantities (MIV) by this date.</p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Site-use shortfall → linked purchase request (one click, pre-filled)
// ---------------------------------------------------------------------------
export interface ShortfallLine { id: string; line_no: number; label: string; uom: string; requested: number; shortfall: number }
export function ConvertShortfallModal({ mr, lines, onClose, onDone }: {
  mr: { id: string; number: string }; lines: ShortfallLine[]; onClose: () => void; onDone: (prId: string, prNumber: string) => void;
}) {
  const auth = useAuth();
  const [q, setQ] = useState<Record<string, string>>(Object.fromEntries(lines.map((l) => [l.id, l.shortfall > 0 ? String(Math.round(l.shortfall * 1000) / 1000) : ''])));
  const [comment, setComment] = useState('');
  const { busy, error, run } = useBusy();
  const chosen = lines.filter((l) => Number(q[l.id]) > 0);
  const go = () => run(async () => {
    const bad = chosen.find((l) => Number(q[l.id]) > l.requested + 0.0005);
    if (bad) throw new Error(`Line ${bad.line_no}: cannot purchase more than the requested ${num(bad.requested, 3)}`);
    const prNumber = await nextDocNumber(auth.project?.code ?? '', 'PR');
    const prId = crypto.randomUUID();
    const res = await flowRpc('mr_action', { mr_id: mr.id, action: 'convert_shortfall', pr_id: prId, pr_number: prNumber, comment: comment.trim() || undefined,
      lines: chosen.map((l) => ({ id: l.id, qty: Number(q[l.id]), pr_line_id: crypto.randomUUID() })) });
    const num_ = String(res.pr_number ?? prNumber);
    toast.success(`Purchase request ${num_} raised for the shortfall`);
    onDone(String(res.pr_id ?? prId), num_);
    onClose();
  });
  return (
    <Modal size="md" title="Convert shortfall to purchase request" subtitle={`From ${mr.number} — enters the purchase flow at the coordinator`} onClose={onClose}
      footer={<Foot busy={busy} onClose={onClose} label={`Raise purchase request${chosen.length ? ` (${chosen.length})` : ''}`} disabled={!chosen.length} onOk={() => void go()} />}>
      <div className="stack tight">
        <ErrorBanner error={error} />
        <DataTable rows={lines} maxHeight="none" columns={[
          { key: 'line_no', label: '#', align: 'right', width: 32 },
          { key: 'label', label: 'Material' },
          { key: 'requested', label: 'Requested', align: 'right', render: (l) => fmtQty(l.requested, l.uom) },
          { key: 'shortfall', label: 'Short', align: 'right', render: (l) => <span className={l.shortfall > 0 ? 'danger-text strong' : 'muted'}>{fmtQty(l.shortfall, l.uom)}</span> },
          { key: 'buy', label: 'Purchase', align: 'right', render: (l) => <QtyInput width={130} value={q[l.id] ?? ''} unit={l.uom} min={0} max={l.requested} aria-label={`Purchase line ${l.line_no}`} onChange={(v) => setQ({ ...q, [l.id]: v })} /> },
        ]} />
        <Field label="Comment (optional)"><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Procurement: RFQ pre-filled from approved PR lines
// ---------------------------------------------------------------------------
export interface PrLinePick { mr_line_id: string; mr_number: string; line_no: number; material_spec_id: string; label: string; uom: string; qty: number; required: string | null; store_id?: string | null }
export function RfqFromPrsModal({ lines, L, onClose, onDone }: { lines: PrLinePick[]; L: Lookups; onClose: () => void; onDone?: (rfqId: string) => void }) {
  const auth = useAuth();
  const mrs = [...new Set(lines.map((l) => l.mr_number))];
  const minQ = (auth.settings as { min_quotes?: number } | null)?.min_quotes ?? 3;
  const [f, setF] = useState({
    title: `RFQ for ${mrs.slice(0, 3).join(', ')}${mrs.length > 3 ? ` +${mrs.length - 3}` : ''}`,
    required_by: lines.map((l) => l.required ?? '').filter(Boolean).sort()[0] ?? '', store: lines.find((l) => l.store_id)?.store_id ?? '',
    min_quotes: String(minQ), notes: '', send: true, sent_via: 'phone',
  });
  const [sup, setSup] = useState<Set<string>>(new Set());
  const [term, setTerm] = useState('');
  const { busy, error, run } = useBusy();
  const go = () => run(async () => {
    if (f.send && !sup.size) throw new Error('Choose at least one supplier to send the RFQ to (or save it unsent)');
    const id = crypto.randomUUID();
    const number = await nextDocNumber(auth.project?.code ?? '', 'RFQ');
    await flowRpc('create_rfq_from_prs', { id, number, mr_line_ids: lines.map((l) => l.mr_line_id), supplier_ids: [...sup], title: f.title || undefined,
      required_by: f.required_by || undefined, delivery_store_id: f.store || undefined, min_quotes: Number(f.min_quotes) || undefined,
      notes: f.notes || undefined, send: f.send, sent_via: f.send ? f.sent_via : undefined });
    toast.success(`${number} ${f.send ? 'sent' : 'saved'} — ${lines.length} line${lines.length === 1 ? '' : 's'}`);
    onDone?.(id); onClose();
  });
  const shown = L.suppliers.filter((s) => !term || s.name.toLowerCase().includes(term.toLowerCase()));
  return (
    <Modal size="lg" title="Create RFQ from purchase requests" subtitle={`${lines.length} approved line${lines.length === 1 ? '' : 's'} · ${mrs.join(', ')}`} onClose={onClose}
      footer={<Foot busy={busy} onClose={onClose} label={f.send ? `Create & send${sup.size ? ` to ${sup.size}` : ''}` : 'Create draft RFQ'} onOk={() => void go()} />}>
      <div className="stack tight">
        <ErrorBanner error={error} />
        <DataTable rows={lines} rowKey={(l) => l.mr_line_id} maxHeight="220px" columns={[
          { key: 'mr_number', label: 'PR', id: true },
          { key: 'line_no', label: 'Line', align: 'right', width: 44 },
          { key: 'label', label: 'Material' },
          { key: 'qty', label: 'Qty', align: 'right', render: (l) => <>{fmtQty(l.qty, l.uom)}<span className="unit">{l.uom}</span></> },
        ]} />
        <div className="form-grid">
          <Field label="Title" wide><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Quotes needed by / required"><input type="date" value={f.required_by} onChange={(e) => setF({ ...f, required_by: e.target.value })} /></Field>
          <Field label="Deliver to">
            <select value={f.store} onChange={(e) => setF({ ...f, store: e.target.value })}>
              <option value="">Store on the request</option>
              {L.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Minimum quotes"><input type="number" min={1} value={f.min_quotes} onChange={(e) => setF({ ...f, min_quotes: e.target.value })} /></Field>
          <Field label="Send now" check><input type="checkbox" checked={f.send} onChange={(e) => setF({ ...f, send: e.target.checked })} /></Field>
          {f.send && <Field label="Sent via">
            <select value={f.sent_via} onChange={(e) => setF({ ...f, sent_via: e.target.value })}>
              {['phone', 'email', 'telegram', 'whatsapp', 'in_person'].map((v) => <option key={v} value={v}>{v.replace('_', ' ')}</option>)}
            </select>
          </Field>}
          <Field label="Notes to suppliers" wide><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </div>
        <Field label={`Suppliers (${sup.size} selected)`} wide>
          <input placeholder="Filter suppliers" value={term} onChange={(e) => setTerm(e.target.value)} />
        </Field>
        <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 'var(--sp-2)' }}>
          {shown.map((s) => (
            <label key={s.id} className="row" style={{ gap: 8, padding: '2px 0' }}>
              <input type="checkbox" checked={sup.has(s.id)} onChange={() => setSup((x) => { const n = new Set(x); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
              {s.name}{s.categories?.length ? <span className="muted small-text"> · {s.categories.join(', ')}</span> : null}
            </label>
          ))}
          {!shown.length && <span className="muted small-text">No suppliers match.</span>}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Procurement: direct (cash / single proforma) purchase below the project limit
// ---------------------------------------------------------------------------
export function DirectPurchaseModal({ lines, L, onClose, onDone }: { lines: PrLinePick[]; L: Lookups; onClose: () => void; onDone?: (poId: string) => void }) {
  const auth = useAuth();
  const limit = Number((auth.settings as { direct_purchase_limit?: number } | null)?.direct_purchase_limit ?? 0);
  const [f, setF] = useState({ supplier: '', reason: '', receipt_ref: '', expected_date: today(), payment_terms: 'Cash', store: lines.find((l) => l.store_id)?.store_id ?? '' });
  const [ln, setLn] = useState<Record<string, { qty: string; price: string; vat: boolean }>>(Object.fromEntries(lines.map((l) => [l.mr_line_id, { qty: String(l.qty), price: '', vat: true }])));
  const { busy, error, run } = useBusy();
  const subtotal = lines.reduce((t, l) => t + (Number(ln[l.mr_line_id]?.qty) || 0) * (Number(ln[l.mr_line_id]?.price) || 0), 0);
  const go = () => run(async () => {
    if (!f.supplier) throw new Error('Choose the supplier');
    if (!f.reason.trim()) throw new Error('A reason is required for a direct purchase');
    for (const l of lines) if (!(Number(ln[l.mr_line_id]?.price) > 0)) throw new Error(`${l.mr_number} line ${l.line_no}: enter the unit price`);
    const poId = crypto.randomUUID();
    const number = await nextDocNumber(auth.project?.code ?? '', 'PO');
    await flowRpc('record_direct_purchase', { po_id: poId, number, supplier_id: f.supplier, reason: f.reason.trim(), receipt_ref: f.receipt_ref || undefined,
      delivery_store_id: f.store || undefined, expected_date: f.expected_date || undefined, payment_terms: f.payment_terms || undefined,
      lines: lines.map((l) => ({ id: crypto.randomUUID(), mr_line_id: l.mr_line_id, qty: Number(ln[l.mr_line_id].qty), unit_price: Number(ln[l.mr_line_id].price), vat_applicable: ln[l.mr_line_id].vat })) });
    toast.success(`Direct purchase ${number} recorded`);
    onDone?.(poId); onClose();
  });
  return (
    <Modal size="lg" title="Record direct purchase" subtitle={limit > 0 ? `Cash / single proforma up to ${money(limit, auth.project?.currency)} incl. VAT` : 'Direct purchase is switched off for this project (limit 0)'}
      onClose={onClose} footer={<Foot busy={busy} onClose={onClose} label="Record purchase" disabled={limit <= 0} onOk={() => void go()} />}>
      <div className="stack tight">
        <ErrorBanner error={error} />
        {limit > 0 && subtotal > limit && <Banner tone="warn">Subtotal {money(subtotal, auth.project?.currency)} is above the direct-purchase limit — use an RFQ.</Banner>}
        <div className="form-grid">
          <Field label="Supplier" required>
            <select value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} data-autofocus>
              <option value="">Choose…</option>
              {L.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Receipt / proforma no."><input value={f.receipt_ref} onChange={(e) => setF({ ...f, receipt_ref: e.target.value })} /></Field>
          <Field label="Expected delivery"><input type="date" value={f.expected_date} onChange={(e) => setF({ ...f, expected_date: e.target.value })} /></Field>
          <Field label="Payment terms"><input value={f.payment_terms} onChange={(e) => setF({ ...f, payment_terms: e.target.value })} /></Field>
          <Field label="Deliver to">
            <select value={f.store} onChange={(e) => setF({ ...f, store: e.target.value })}>
              <option value="">Store on the request</option>
              {L.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Reason" required wide><textarea rows={2} value={f.reason} placeholder="e.g. Single local supplier, urgent small quantity" onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        </div>
        <DataTable rows={lines} rowKey={(l) => l.mr_line_id} maxHeight="none" columns={[
          { key: 'mr_number', label: 'PR', id: true },
          { key: 'label', label: 'Material' },
          { key: 'qty', label: 'Qty', align: 'right', render: (l) => <QtyInput width={120} value={ln[l.mr_line_id].qty} unit={l.uom} min={0} max={l.qty} aria-label="Quantity"
            onChange={(v) => setLn({ ...ln, [l.mr_line_id]: { ...ln[l.mr_line_id], qty: v } })} /> },
          { key: 'price', label: 'Unit price (ex VAT)', align: 'right', render: (l) => <QtyInput width={130} value={ln[l.mr_line_id].price} min={0} aria-label="Unit price"
            onChange={(v) => setLn({ ...ln, [l.mr_line_id]: { ...ln[l.mr_line_id], price: v } })} /> },
          { key: 'vat', label: 'VAT', align: 'center', render: (l) => <input type="checkbox" aria-label="VAT applicable" checked={ln[l.mr_line_id].vat}
            onChange={(e) => setLn({ ...ln, [l.mr_line_id]: { ...ln[l.mr_line_id], vat: e.target.checked } })} /> },
          { key: 'amt', label: 'Amount', align: 'right', render: (l) => money((Number(ln[l.mr_line_id].qty) || 0) * (Number(ln[l.mr_line_id].price) || 0), auth.project?.currency) },
        ]} />
        <div className="strong" style={{ textAlign: 'right' }}>Subtotal {money(subtotal, auth.project?.currency)}</div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Procurement → store keeper (+ security): delivery notice for a PO
// ---------------------------------------------------------------------------
export function NotifyDeliveryModal({ poId, poNumber, L, onClose, onDone }: { poId: string; poNumber: string; L: Lookups; onClose: () => void; onDone?: () => void }) {
  const q = useAsync(async () => check(await supabase.from('po_lines').select('id, line_no, material_spec_id, qty, qty_accepted, closed, deleted_at').eq('po_id', poId).is('deleted_at', null).order('line_no')) as PoLine[],
    [poId], { key: 'po-lines-min' });
  const open = (q.data ?? []).filter((l) => !l.closed && Number(l.qty) - Number(l.qty_accepted) > 0.0005);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [f, setF] = useState({ expected_date: today(), expected_window: '', vehicle_plate: '', driver_name: '', driver_phone: '', note: '' });
  const { busy, error, run } = useBusy();
  const val = (l: PoLine) => qty[l.id] ?? String(Number(l.qty) - Number(l.qty_accepted));
  const go = () => run(async () => {
    if (!f.expected_date) throw new Error('Expected delivery date is required');
    const lines = open.map((l) => ({ po_line_id: l.id, qty: Number(val(l)) })).filter((l) => l.qty > 0);
    if (!lines.length) throw new Error('Nothing to deliver');
    await flowRpc('notify_store_delivery', { id: crypto.randomUUID(), po_id: poId, expected_date: f.expected_date, expected_window: f.expected_window || undefined,
      vehicle_plate: f.vehicle_plate || undefined, driver_name: f.driver_name || undefined, driver_phone: f.driver_phone || undefined, note: f.note || undefined, lines });
    toast.success(`Store keeper and gate notified — PO ${poNumber} on ${f.expected_date}`);
    onDone?.(); onClose();
  });
  return (
    <Modal size="md" title={`Notify store: delivery of PO ${poNumber}`} subtitle="The store keeper accepts the delivery; security expects the vehicle at the gate" onClose={onClose}
      footer={<Foot busy={busy} onClose={onClose} label="Send delivery notice" disabled={!open.length} onOk={() => void go()} />}>
      <div className="stack tight">
        <ErrorBanner error={error ?? q.error} />
        <div className="form-grid">
          <Field label="Expected date" required><input type="date" value={f.expected_date} onChange={(e) => setF({ ...f, expected_date: e.target.value })} data-autofocus /></Field>
          <Field label="Time window"><input value={f.expected_window} placeholder="e.g. 08:00–12:00" onChange={(e) => setF({ ...f, expected_window: e.target.value })} /></Field>
          <Field label="Vehicle plate"><input value={f.vehicle_plate} onChange={(e) => setF({ ...f, vehicle_plate: e.target.value.toUpperCase() })} /></Field>
          <Field label="Driver"><input value={f.driver_name} onChange={(e) => setF({ ...f, driver_name: e.target.value })} /></Field>
          <Field label="Driver phone"><input type="tel" value={f.driver_phone} onChange={(e) => setF({ ...f, driver_phone: e.target.value })} /></Field>
          <Field label="Note" wide><textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
        {!q.data ? <Loading lines={3} /> : !open.length ? <Banner tone="info">Nothing is outstanding on this PO.</Banner> : (
          <DataTable rows={open} maxHeight="none" columns={[
            { key: 'line_no', label: '#', align: 'right', width: 32 },
            { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
            { key: 'out', label: 'Outstanding', align: 'right', render: (l) => fmtQty(Number(l.qty) - Number(l.qty_accepted), L.specUom(l.material_spec_id)) },
            { key: 'q', label: 'On this trip', align: 'right', render: (l) => <QtyInput width={120} value={val(l)} unit={L.specUom(l.material_spec_id)} min={0} aria-label={`Line ${l.line_no} quantity`}
              onChange={(v) => setQty({ ...qty, [l.id]: v })} /> },
          ]} />
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Store keeper: accept / reschedule a delivery notice
// ---------------------------------------------------------------------------
export function AckNoticeModal({ notice, poNumber, decision, onClose, onDone }: {
  notice: Pick<DeliveryNotice, 'id' | 'expected_date'>; poNumber: string; decision: 'accept' | 'reschedule'; onClose: () => void; onDone?: () => void;
}) {
  const [note, setNote] = useState('');
  const [date, setDate] = useState('');
  const { busy, error, run } = useBusy();
  const go = () => run(async () => {
    if (decision === 'reschedule' && !date) throw new Error('Propose another delivery date');
    await flowRpc('acknowledge_delivery_notice', { id: notice.id, decision, note: note.trim() || undefined, proposed_date: decision === 'reschedule' ? date : undefined });
    toast.success(decision === 'accept' ? `Delivery of PO ${poNumber} accepted` : `Reschedule requested for PO ${poNumber}`);
    onDone?.(); onClose();
  });
  return (
    <Modal title={decision === 'accept' ? `Accept delivery of PO ${poNumber}` : `Ask to reschedule PO ${poNumber}`}
      subtitle={`Announced for ${notice.expected_date}`} onClose={onClose}
      footer={<Foot busy={busy} onClose={onClose} label={decision === 'accept' ? 'Accept delivery' : 'Request new date'} onOk={() => void go()} />}>
      <div className="stack tight">
        <ErrorBanner error={error} />
        {decision === 'reschedule' && <Field label="Proposed date" required><input type="date" min={today()} value={date} onChange={(e) => setDate(e.target.value)} data-autofocus /></Field>}
        <Field label={decision === 'accept' ? 'Note (space / labour ready, optional)' : 'Reason'}><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Store keeper: GRN against a delivery notice (post_grn with delivery_notice_id + po lines)
// ---------------------------------------------------------------------------
type NoticeRow = DeliveryNotice & { purchase_orders?: { number: string; supplier_id: string } | null };
export function GrnFromNoticeDrawer({ notice, L, onClose, onDone }: { notice: NoticeRow; L: Lookups; onClose: () => void; onDone?: (grnId: string) => void }) {
  const auth = useAuth();
  const q = useAsync(async () => check(await supabase.from('po_lines').select('id, line_no, material_spec_id, qty, qty_accepted, mr_line_id, closed, deleted_at').eq('po_id', notice.po_id).is('deleted_at', null).order('line_no')) as PoLine[],
    [notice.po_id], { key: 'po-lines-grn' });
  const [rows, setRows] = useState<Record<string, { del: string; rej: string; result: 'pass' | 'conditional' | 'reject'; notes: string }>>({});
  const [h, setH] = useState({ delivery_note_no: '', vehicle_plate: notice.vehicle_plate ?? '', driver_name: notice.driver_name ?? '', remarks: '' });
  const { busy, error, run } = useBusy();
  const poLine = (id: string) => q.data?.find((l) => l.id === id);
  const lines = notice.lines.filter((l) => poLine(l.po_line_id));
  const r = (id: string, def: number) => rows[id] ?? { del: String(def), rej: '0', result: 'pass' as const, notes: '' };
  const setR = (id: string, def: number, patch: Partial<ReturnType<typeof r>>) => setRows({ ...rows, [id]: { ...r(id, def), ...patch } });
  const go = () => run(async () => {
    const out = lines.map((l, i) => {
      const x = r(l.po_line_id, l.qty); const pl = poLine(l.po_line_id)!;
      const del = Number(x.del), rej = Number(x.rej) || 0;
      if (!(del >= 0) || rej < 0 || rej > del) throw new Error(`Line ${i + 1}: check delivered / rejected quantities`);
      return { id: crypto.randomUUID(), material_spec_id: pl.material_spec_id, po_line_id: pl.id, mr_line_id: pl.mr_line_id ?? undefined, ordered_qty: Number(l.qty), // announced on this notice (a planned partial trip is not a shortage)
        qty_delivered: del, qty_rejected: rej, qty_accepted: del - rej, inspection_result: x.result, inspection_notes: x.notes || undefined };
    }).filter((l) => l.qty_delivered > 0);
    if (!out.length) throw new Error('Enter the delivered quantity for at least one line');
    const id = crypto.randomUUID();
    const number = await nextDocNumber(auth.project?.code ?? '', 'GRN');
    await flowRpc('post_grn', { id, project_id: notice.project_id, number, store_id: notice.store_id, po_id: notice.po_id, delivery_notice_id: notice.id,
      supplier_id: notice.purchase_orders?.supplier_id, delivery_note_no: h.delivery_note_no || undefined, vehicle_plate: h.vehicle_plate || undefined,
      driver_name: h.driver_name || undefined, received_at: new Date().toISOString(), remarks: h.remarks || undefined, lines: out });
    toast.success(`${number} posted — requester informed`);
    onDone?.(id); onClose();
  });
  return (
    <Drawer size="lg" title={`Receive PO ${notice.purchase_orders?.number ?? ''} (GRN)`} subtitle={`${L.store(notice.store_id)} · announced ${notice.expected_date}${notice.ack_at ? ` · accepted ${dateTime(notice.ack_at)}` : ''}`}
      onClose={onClose} footer={<Foot busy={busy} onClose={onClose} label="Post GRN" disabled={!lines.length} onOk={() => void go()} />}>
      <div className="stack">
        <ErrorBanner error={error ?? q.error} />
        <div className="form-grid">
          <Field label="Supplier delivery note no."><input value={h.delivery_note_no} onChange={(e) => setH({ ...h, delivery_note_no: e.target.value })} data-autofocus /></Field>
          <Field label="Vehicle plate"><input value={h.vehicle_plate} onChange={(e) => setH({ ...h, vehicle_plate: e.target.value.toUpperCase() })} /></Field>
          <Field label="Driver"><input value={h.driver_name} onChange={(e) => setH({ ...h, driver_name: e.target.value })} /></Field>
          <Field label="Remarks" wide><input value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} /></Field>
        </div>
        {!q.data ? <Loading lines={4} /> : (
          <DataTable rows={lines} rowKey={(l) => l.po_line_id} maxHeight="none" columns={[
            { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
            { key: 'qty', label: 'Announced', align: 'right', render: (l) => fmtQty(l.qty, L.specUom(l.material_spec_id)) },
            { key: 'del', label: 'Delivered', align: 'right', render: (l) => <QtyInput width={110} value={r(l.po_line_id, l.qty).del} unit={L.specUom(l.material_spec_id)} min={0} aria-label="Delivered"
              onChange={(v) => setR(l.po_line_id, l.qty, { del: v })} /> },
            { key: 'rej', label: 'Rejected', align: 'right', render: (l) => <QtyInput width={100} value={r(l.po_line_id, l.qty).rej} min={0} aria-label="Rejected"
              onChange={(v) => setR(l.po_line_id, l.qty, { rej: v })} /> },
            { key: 'res', label: 'Inspection', render: (l) => (
              <select aria-label="Inspection result" value={r(l.po_line_id, l.qty).result} onChange={(e) => setR(l.po_line_id, l.qty, { result: e.target.value as 'pass' })}>
                <option value="pass">Pass</option><option value="conditional">Conditional</option><option value="reject">Reject</option>
              </select>) },
            { key: 'notes', label: 'Notes', render: (l) => <input aria-label="Inspection notes" value={r(l.po_line_id, l.qty).notes} onChange={(e) => setR(l.po_line_id, l.qty, { notes: e.target.value })} /> },
          ]} />
        )}
        <p className="muted small-text mb-0">Accepted quantity = delivered − rejected. Posting closes this delivery notice and updates the purchase requests it serves.</p>
      </div>
    </Drawer>
  );
}
