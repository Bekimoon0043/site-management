// Optimistic local apply for procurement (contract-procurement.ts) and site-control
// (contract-control.ts) RPCs, mirroring 20261029000005_procurement.sql and
// 20261029000007_control_comms.sql closely enough for offline use: PO status / receipt
// quantities, reorder requests, gate passes (incl. pending gate_out / gate_in ledger rows
// and on_loan stock), vehicle log, alerts, notification prefs and locale.
// Rows are tagged with the op id and replaced by server copies on pull.
import type { Grn, MaterialRequest, PostGrnPayload, Profile, RpcName, StockLedgerEntry } from './contract';
import type {
  PoLine, PoStatus, PurchaseOrder, RfqStatus, Rfq, RpcMapProcurement,
} from './contract-procurement';
import type { Alert, GatePass, GatePassLine, GatePassStatus, RpcMapControl, VehicleMovement } from './contract-control';
import { get, putPending, type Row } from './db';
import { myId, myRole } from './me';
import { applyOptimistic } from './optimistic';
import { canSeePrices, gatePassLines, normPlate, poLines } from './pc';

export type RpcMapPC = RpcMapProcurement & RpcMapControl;
type Name = keyof RpcMapPC;
const NAMES: Record<Name, true> = {
  save_rfq: true, rfq_action: true, record_quotation: true, award_rfq: true, save_po: true, po_action: true, amend_po: true,
  update_po_delivery: true, post_grn: true, log_market_price: true, save_budget: true, create_mr_from_suggestions: true,
  save_gate_pass: true, gate_pass_action: true, verify_gate_pass: true, return_gate_pass: true, log_vehicle: true,
  evaluate_alerts: true, alert_action: true, save_alert_rule: true, sign_qr: true, verify_qr: true, get_qr_key: true,
  register_qr_labels: true, mark_qr_printed: true, create_telegram_link_code: true, unlink_telegram: true,
  set_notification_prefs: true, save_project_channel: true, set_my_locale: true,
};
export const PC_RPCS = new Set<string>(Object.keys(NAMES));

const now = () => new Date().toISOString();

function patch<T extends object>(tbl: string, id: string, changes: Partial<T>, op: string) {
  const cur = get<T>(tbl, id);
  if (!cur) return;
  const { _pending: _, ...rest } = cur as T & { _pending?: string };
  putPending(tbl, { ...rest, ...changes, updated_at: now() } as Row, op);
}

let seq = 0;
type LedgerStatus = StockLedgerEntry['stock_status'] | 'on_loan';
type LedgerTxn = StockLedgerEntry['txn_type'] | 'gate_out' | 'gate_in';
function ledgerRow(op: string, e: Omit<StockLedgerEntry, 'id' | 'created_at' | 'stock_status' | 'txn_type'> & { stock_status: LedgerStatus; txn_type: LedgerTxn }) {
  const id = `local:${op}:pc${seq++}`;
  putPending('stock_ledger', { ...e, id, created_at: now(), updated_at: now() } as unknown as Row, op, id);
}

function poEvent(op: string, po: PurchaseOrder, action: string, to: PoStatus | null, comment?: string | null) {
  const t = now();
  putPending('po_events', { id: `local:${op}`, po_id: po.id, project_id: po.project_id, action, from_status: po.status, to_status: to, comment: comment ?? null, actor: myId(), created_at: t, updated_at: t }, op, `local:${op}`);
}

/** Receipt-driven PO status (app.refresh_po_status). */
function refreshPoStatus(poId: string, op: string) {
  const po = get<PurchaseOrder>('purchase_orders', poId);
  if (!po || !['approved', 'sent', 'partially_received', 'received'].includes(po.status)) return;
  const ls = poLines(poId);
  const any = ls.some((l) => Number(l.qty_accepted) > 0);
  const all = ls.length > 0 && ls.every((l) => l.closed || Number(l.qty_accepted) >= Number(l.qty) - 0.0005);
  const status: PoStatus = all ? 'received' : any ? 'partially_received' : po.status;
  if (status !== po.status) patch<PurchaseOrder>('purchase_orders', poId, { status, delivery_status: all ? 'delivered' : po.delivery_status }, op);
}

const PO_ACTION: Record<RpcMapProcurement['po_action']['action'], PoStatus> = {
  submit: 'submitted', approve: 'approved', reject: 'rejected', send: 'sent', cancel: 'cancelled', close: 'closed',
};
const RFQ_ACTION: Record<RpcMapProcurement['rfq_action']['action'], RfqStatus> = { send: 'sent', close: 'closed', cancel: 'cancelled' };
const GP_ACTION: Record<RpcMapControl['gate_pass_action']['action'], GatePassStatus> = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' };

export function applyOptimisticPC<N extends Name>(rpc: N, payload: RpcMapPC[N], op: string): void {
  const t = now();
  switch (rpc) {
    // ---------------------------------------------------------------- procurement
    case 'post_grn': {
      const x = payload as RpcMapProcurement['post_grn'];
      applyOptimistic('post_grn' as RpcName, x as unknown as PostGrnPayload as never, op);
      const poId = x.po_id ?? x.lines.map((l) => (l.po_line_id ? get<PoLine>('po_lines', l.po_line_id)?.po_id : null)).find(Boolean) ?? null;
      if (!poId) break;
      const po = get<PurchaseOrder>('purchase_orders', poId);
      patch<Grn & { po_id: string }>('grns', x.id, { po_id: poId, supplier_id: x.supplier_id ?? po?.supplier_id ?? null }, op);
      for (const l of x.lines) {
        if (!l.po_line_id) continue;
        const pl = get<PoLine>('po_lines', l.po_line_id);
        if (!pl) continue;
        const rej = l.qty_rejected ?? 0;
        const acc = l.qty_accepted ?? l.qty_delivered - rej;
        patch<PoLine>('po_lines', pl.id, {
          qty_received: Number(pl.qty_received) + l.qty_delivered, qty_accepted: Number(pl.qty_accepted) + acc, qty_rejected: Number(pl.qty_rejected) + rej,
        }, op);
      }
      refreshPoStatus(poId, op);
      break;
    }
    case 'po_action': {
      const x = payload as RpcMapProcurement['po_action'];
      const po = get<PurchaseOrder>('purchase_orders', x.po_id);
      if (!po) break;
      let to = PO_ACTION[x.action];
      const changes: Partial<PurchaseOrder> = {};
      if (x.action === 'submit') changes.submitted_at = t;
      if (x.action === 'approve') {
        changes.approved_by = myId(); changes.approved_at = t;
        const received = poLines(po.id).some((l) => Number(l.qty_received) > 0);
        to = !po.sent_at && !received ? 'approved' : 'sent';
      }
      if (x.action === 'send') changes.sent_at = t;
      if (x.action === 'cancel') { changes.cancelled_at = t; changes.status_reason = x.comment ?? null; }
      if (x.action === 'close') {
        changes.closed_at = t; changes.status_reason = x.comment ?? null;
        for (const l of poLines(po.id)) patch<PoLine>('po_lines', l.id, { closed: true }, op);
      }
      patch<PurchaseOrder>('purchase_orders', po.id, { ...changes, status: to }, op);
      poEvent(op, po, x.action, to, x.comment);
      if (x.action === 'approve' && to === 'sent') refreshPoStatus(po.id, op);
      break;
    }
    case 'update_po_delivery': {
      const x = payload as RpcMapProcurement['update_po_delivery'];
      const po = get<PurchaseOrder>('purchase_orders', x.po_id);
      if (!po) break;
      patch<PurchaseOrder>('purchase_orders', po.id, { delivery_status: x.status, eta: x.eta ?? po.eta }, op);
      putPending('po_delivery_updates', { id: x.id, po_id: po.id, project_id: po.project_id, status: x.status, eta: x.eta ?? null, note: x.note ?? null, created_by: myId(), created_at: t, updated_at: t }, op);
      break;
    }
    case 'save_po': {
      const x = payload as RpcMapProcurement['save_po'];
      const prev = get<PurchaseOrder>('purchase_orders', x.id);
      const po: PurchaseOrder = {
        ...(prev ?? {} as PurchaseOrder), id: x.id, project_id: x.project_id, number: x.number, supplier_id: x.supplier_id,
        rfq_id: x.rfq_id ?? null, delivery_store_id: x.delivery_store_id, status: x.submit ? 'submitted' : 'draft',
        revision: prev?.revision ?? 0, order_date: x.order_date ?? prev?.order_date ?? t.slice(0, 10), expected_date: x.expected_date ?? null,
        eta: prev?.eta ?? null, delivery_status: prev?.delivery_status ?? 'pending', payment_terms: x.payment_terms ?? null,
        advance_pct: x.advance_pct ?? null, delivery_terms: x.delivery_terms ?? null, remarks: x.remarks ?? null,
        created_by: prev?.created_by ?? myId(), submitted_at: x.submit ? t : prev?.submitted_at ?? null, approved_by: null, approved_at: null,
        sent_at: null, closed_at: null, cancelled_at: null, status_reason: null, created_at: prev?.created_at ?? t, updated_at: t,
      };
      putPending('purchase_orders', po as unknown as Row, op);
      const keep = new Set(x.lines.map((l) => l.id));
      for (const old of poLines(x.id)) if (!keep.has(old.id)) patch<PoLine>('po_lines', old.id, { deleted_at: t }, op);
      x.lines.forEach((l, i) => putPending('po_lines', {
        id: l.id, po_id: x.id, project_id: x.project_id, line_no: i + 1, material_spec_id: l.material_spec_id, qty: l.qty, uom: l.uom ?? null,
        mr_line_id: l.mr_line_id ?? null, quotation_line_id: l.quotation_line_id ?? null, expected_date: l.expected_date ?? null,
        qty_received: 0, qty_accepted: 0, qty_rejected: 0, closed: false, remarks: l.remarks ?? null, deleted_at: null, updated_at: t,
      }, op));
      break;
    }
    case 'rfq_action': {
      const x = payload as RpcMapProcurement['rfq_action'];
      const r = get<Rfq>('rfqs', x.rfq_id);
      if (r) patch<Rfq>('rfqs', r.id, { status: RFQ_ACTION[x.action], ...(x.action === 'send' ? { sent_at: t } : x.action === 'close' ? { closed_at: t } : {}) }, op);
      break;
    }
    case 'log_market_price': {
      const x = payload as RpcMapProcurement['log_market_price'];
      if (!canSeePrices(myRole())) break;
      putPending('price_observations', {
        id: x.id, project_id: x.project_id, material_spec_id: x.material_spec_id, supplier_id: x.supplier_id ?? null, unit_price: x.unit_price,
        currency: 'ETB', observed_on: x.observed_on ?? t.slice(0, 10), source: 'market', source_id: null, location: x.location ?? null,
        note: x.note ?? null, avg_90d: null, is_spike: false, created_at: t, updated_at: t,
      }, op);
      break;
    }
    case 'create_mr_from_suggestions': {
      const x = payload as RpcMapProcurement['create_mr_from_suggestions'];
      const submit = x.submit ?? true;
      const req = x.required_date ?? new Date(Date.now() + 7 * 86400e3).toISOString().slice(0, 10);
      const store = get<{ name: string }>('stores', x.store_id);
      const mr: MaterialRequest = {
        id: x.id, project_id: x.project_id, number: x.number, block_id: x.block_id ?? null, requested_by: myId(),
        requester_role: myRole() ?? 'store_keeper', status: submit ? 'submitted' : 'draft', priority: x.priority ?? 'normal', required_date: req,
        delivery_location: store?.name ?? null, store_id: x.store_id, drawing_ref: null, purpose: 'Reorder', is_lookahead: false, version: 1,
        submitted_at: submit ? t : null, reviewed_by: null, reviewed_at: null, approved_by: null, approved_at: null, created_at: t, updated_at: t,
      };
      putPending('material_requests', mr as unknown as Row, op);
      x.lines.forEach((l, i) => putPending('mr_lines', {
        id: l.id, mr_id: x.id, project_id: x.project_id, line_no: i + 1, material_spec_id: l.material_spec_id, qty: l.qty, approved_qty: null,
        required_date: req, remarks: l.remarks ?? 'Reorder suggestion', boq_item_id: null, exceeds_boq: false, over_boq_reason: null, deleted_at: null, updated_at: t,
      }, op));
      putPending('mr_events', { id: `local:${op}`, mr_id: x.id, project_id: x.project_id, action: submit ? 'submit' : 'create', from_status: null, to_status: mr.status, comment: null, actor: myId(), created_at: t, updated_at: t }, op, `local:${op}`);
      break;
    }
    // ---------------------------------------------------------------- gate
    case 'save_gate_pass': {
      const x = payload as RpcMapControl['save_gate_pass'];
      const prev = get<GatePass>('gate_passes', x.id);
      const g: GatePass = {
        ...(prev ?? {} as GatePass), id: x.id, project_id: x.project_id, number: x.number, pass_type: x.pass_type, store_id: x.store_id ?? null,
        destination: x.destination.trim(), purpose: x.purpose.trim(), vehicle_plate: x.vehicle_plate?.trim() || null, driver_name: x.driver_name || null,
        driver_phone: x.driver_phone || null, expected_return: x.expected_return ?? null, linked_doc_type: x.linked_doc_type ?? null,
        linked_doc_id: x.linked_doc_id ?? null, status: x.submit ? 'pending' : 'draft', requested_by: prev?.requested_by ?? myId(),
        submitted_at: x.submit ? t : prev?.submitted_at ?? null, approved_by: null, approved_at: null, decision_comment: null, qr_code: null,
        exited_at: null, returned_at: null, created_at: prev?.created_at ?? t, updated_at: t,
      };
      putPending('gate_passes', g as unknown as Row, op);
      const keep = new Set(x.lines.map((l) => l.id));
      for (const old of gatePassLines(x.id)) if (!keep.has(old.id)) patch<GatePassLine>('gate_pass_lines', old.id, { deleted_at: t }, op);
      x.lines.forEach((l, i) => putPending('gate_pass_lines', {
        id: l.id, gate_pass_id: x.id, project_id: x.project_id, line_no: i + 1, material_spec_id: l.material_spec_id ?? null,
        description: l.description?.trim() || null, qty: l.qty, uom: l.uom ?? (l.material_spec_id ? get<{ uom: string }>('material_specs', l.material_spec_id)?.uom ?? null : null),
        qty_returned: 0, deleted_at: null, updated_at: t,
      }, op));
      break;
    }
    case 'gate_pass_action': {
      const x = payload as RpcMapControl['gate_pass_action'];
      const g = get<GatePass>('gate_passes', x.gate_pass_id);
      if (!g) break;
      patch<GatePass>('gate_passes', g.id, {
        status: GP_ACTION[x.action], decision_comment: x.comment ?? g.decision_comment,
        ...(x.action === 'approve' ? { approved_by: myId(), approved_at: t } : {}),
      }, op);
      break;
    }
    case 'verify_gate_pass': {
      const x = payload as RpcMapControl['verify_gate_pass'];
      const g = get<GatePass>('gate_passes', x.gate_pass_id);
      if (!g) break;
      const at = x.at ?? t;
      const match = x.matches && (!g.vehicle_plate || normPlate(x.plate_seen) === normPlate(g.vehicle_plate));
      putPending('gate_events', {
        id: x.id, project_id: g.project_id, gate_pass_id: g.id, event: match ? 'exit_verified' : 'exit_mismatch', plate_seen: x.plate_seen ?? null,
        matches: match, note: x.note ?? (match ? null : `Plate seen ${x.plate_seen ?? '—'} ≠ ${g.vehicle_plate ?? '—'}`), actor: myId(), at, created_at: t, updated_at: t,
      }, op);
      if (!match) break;
      for (const l of gatePassLines(g.id)) {
        if (!l.material_spec_id || !g.store_id) continue;
        const base = { project_id: g.project_id, store_id: g.store_id, material_spec_id: l.material_spec_id, txn_type: 'gate_out' as const, doc_type: 'gate_pass', doc_id: g.id, doc_number: g.number, element_id: null, mr_line_id: null, txn_at: at };
        ledgerRow(op, { ...base, qty: -Number(l.qty), stock_status: 'available' });
        if (g.pass_type === 'returnable') ledgerRow(op, { ...base, qty: Number(l.qty), stock_status: 'on_loan' });
      }
      patch<GatePass>('gate_passes', g.id, { status: 'exited', exited_at: at }, op);
      break;
    }
    case 'return_gate_pass': {
      const x = payload as RpcMapControl['return_gate_pass'];
      const g = get<GatePass>('gate_passes', x.gate_pass_id);
      if (!g) break;
      const at = x.at ?? t;
      putPending('gate_events', { id: x.id, project_id: g.project_id, gate_pass_id: g.id, event: 'return_in', plate_seen: x.plate_seen ?? null, matches: true, note: x.note ?? null, actor: myId(), at, created_at: t, updated_at: t }, op);
      const lines = new Map(gatePassLines(g.id).map((l) => [l.id, l]));
      for (const r of x.lines) {
        const l = lines.get(r.gate_pass_line_id);
        if (!l || !(r.qty_returned > 0)) continue;
        const qr = Number(l.qty_returned) + r.qty_returned;
        patch<GatePassLine>('gate_pass_lines', l.id, { qty_returned: qr }, op);
        lines.set(l.id, { ...l, qty_returned: qr });
        if (l.material_spec_id && g.store_id) {
          const base = { project_id: g.project_id, store_id: g.store_id, material_spec_id: l.material_spec_id, txn_type: 'gate_in' as const, doc_type: 'gate_pass', doc_id: g.id, doc_number: g.number, element_id: null, mr_line_id: null, txn_at: at };
          ledgerRow(op, { ...base, qty: -r.qty_returned, stock_status: 'on_loan' });
          ledgerRow(op, { ...base, qty: r.qty_returned, stock_status: 'available' });
        }
      }
      const done = [...lines.values()].every((l) => Number(l.qty_returned) >= Number(l.qty) - 0.0005);
      patch<GatePass>('gate_passes', g.id, { status: done ? 'returned' : 'partially_returned', returned_at: done ? at : null }, op);
      break;
    }
    case 'log_vehicle': {
      const x = payload as RpcMapControl['log_vehicle'];
      const v: VehicleMovement = {
        id: x.id, project_id: x.project_id, number: x.number, direction: x.direction, plate: x.plate.trim().toUpperCase(), driver_name: x.driver_name || null,
        purpose: x.purpose || null, loaded: !!x.loaded, linked_doc_type: x.linked_doc_type ?? null, linked_doc_id: x.linked_doc_id ?? null,
        flagged: x.direction === 'out' && !!x.loaded && !x.linked_doc_id, at: x.at ?? t, actor: myId(),
      };
      putPending('vehicle_movements', { ...v, created_at: t, updated_at: t } as unknown as Row, op);
      break;
    }
    // ---------------------------------------------------------------- alerts / prefs
    case 'alert_action': {
      const x = payload as RpcMapControl['alert_action'];
      const a = get<Alert>('alerts', x.alert_id);
      if (!a) break;
      patch<Alert>('alerts', a.id, x.action === 'acknowledge'
        ? { status: 'acknowledged', acked_by: myId(), acked_at: t }
        : { status: 'closed', closed_by: myId(), closed_at: t, close_note: x.note ?? null }, op);
      break;
    }
    case 'set_notification_prefs': {
      const x = payload as RpcMapControl['set_notification_prefs'];
      for (const p of x.prefs) {
        putPending('notification_prefs', {
          user_id: myId(), event: p.event, in_app: p.in_app ?? true, push: p.push ?? true, telegram: p.telegram ?? true, sms: p.sms ?? false,
          quiet_from: p.quiet_from ?? null, quiet_to: p.quiet_to ?? null, updated_at: t,
        }, op);
      }
      break;
    }
    case 'set_my_locale': {
      const x = payload as RpcMapControl['set_my_locale'];
      if (get<Profile>('profiles', myId())) patch<Profile & { locale: string; calendar: string }>('profiles', myId(), { ...x }, op);
      break;
    }
    case 'unlink_telegram': {
      if (get('telegram_links', myId())) patch<{ deleted_at: string }>('telegram_links', myId(), { deleted_at: t }, op);
      break;
    }
    default:
      // save_rfq / record_quotation / award_rfq / amend_po / save_budget / save_alert_rule / save_project_channel /
      // register_qr_labels: web-console flows; server copies arrive on the next pull.
      break;
  }
}

/** Gate-pass lines still out (returnable passes). */
export const outstandingReturn = (l: GatePassLine) => Math.max(Number(l.qty) - Number(l.qty_returned ?? 0), 0);
