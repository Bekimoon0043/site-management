// Applies an outbox op to the local store immediately so the app reflects it
// offline (including stock balances). Rows are tagged with the op id; they are
// replaced by server copies on pull, or rolled back if the op is discarded.
import type {
  Adjustment, AdjustmentLine, ElementActivity, Element, Grn, MaterialRequest, Miv, MrActionPayload, MrLine, MrStatus,
  ProgressUpdate, RpcMap, RpcName, StockCount, StockCountLine, StockLedgerEntry, StockStatus, Transfer, TransferLine,
  AppNotification, Mrn,
} from './contract';
import { get, list, putPending, type Row } from './db';
import { myId, myRole } from './me';
import { issuedForLine, mrLines, stockQty } from './queries';

const now = () => new Date().toISOString();

let localSeq = 0;
function ledgerRow(op: string, e: Omit<StockLedgerEntry, 'id' | 'created_at'>) {
  const id = `local:${op}:${localSeq++}`;
  putPending('stock_ledger', { ...e, id, created_at: now(), updated_at: now() } as unknown as Row, op, id);
}

function patch<T extends object>(tbl: string, id: string, changes: Partial<T>, op: string) {
  const cur = get<T>(tbl, id);
  if (!cur) return;
  const { _pending: _, ...rest } = cur as T & { _pending?: string };
  putPending(tbl, { ...rest, ...changes, updated_at: now() } as Row, op);
}

function refreshMrStatus(mrId: string, op: string) {
  const mr = get<MaterialRequest>('material_requests', mrId);
  if (!mr || !['approved', 'partially_issued', 'issued'].includes(mr.status)) return;
  let total = 0, issued = 0, any = false;
  for (const l of mrLines(mrId)) {
    if (l.deleted_at || !l.approved_qty) continue;
    const i = issuedForLine(mr.project_id, l.id);
    total += Number(l.approved_qty);
    issued += Math.min(Number(l.approved_qty), i);
    any = any || i > 0;
  }
  const status: MrStatus = total > 0 && issued >= total - 1e-9 ? 'issued' : any ? 'partially_issued' : 'approved';
  if (status !== mr.status) patch<MaterialRequest>('material_requests', mrId, { status }, op);
}

const ACTION_STATUS: Record<MrActionPayload['action'], MrStatus> = {
  review: 'reviewed', approve: 'approved', reject: 'rejected', return: 'returned', cancel: 'cancelled', close: 'closed',
};

export function applyOptimistic<N extends RpcName>(rpc: N, payload: RpcMap[N], op: string): void {
  const p = payload as RpcMap[RpcName];
  const t = now();
  switch (rpc) {
    case 'save_mr': {
      const x = p as RpcMap['save_mr'];
      const prev = get<MaterialRequest>('material_requests', x.id);
      const mr: MaterialRequest = {
        ...(prev ?? {} as MaterialRequest),
        id: x.id, project_id: x.project_id, number: x.number, block_id: x.block_id, priority: x.priority,
        required_date: x.required_date, delivery_location: x.delivery_location ?? null, store_id: x.store_id ?? null,
        drawing_ref: x.drawing_ref ?? null, purpose: x.purpose ?? null, is_lookahead: !!x.is_lookahead,
        requested_by: prev?.requested_by ?? myId(), requester_role: prev?.requester_role ?? myRole() ?? 'site_engineer',
        status: x.submit ? 'submitted' : prev?.status === 'returned' ? 'returned' : 'draft',
        version: (prev?.version ?? 0) + 1, submitted_at: x.submit ? t : prev?.submitted_at ?? null,
        reviewed_by: prev?.reviewed_by ?? null, reviewed_at: prev?.reviewed_at ?? null,
        approved_by: null, approved_at: null, created_at: prev?.created_at ?? t, updated_at: t,
      };
      putPending('material_requests', mr as unknown as Row, op);
      const keep = new Set(x.lines.map((l) => l.id));
      for (const old of list<MrLine>('mr_lines', { parent: x.id })) {
        if (!keep.has(old.id)) patch<MrLine>('mr_lines', old.id, { deleted_at: t }, op);
      }
      x.lines.forEach((l, i) => {
        putPending('mr_lines', {
          id: l.id, mr_id: x.id, project_id: x.project_id, line_no: i + 1, material_spec_id: l.material_spec_id, qty: l.qty,
          approved_qty: null, required_date: l.required_date ?? x.required_date, remarks: l.remarks ?? null,
          boq_item_id: null, exceeds_boq: !!l.over_boq_reason, over_boq_reason: l.over_boq_reason ?? null,
          deleted_at: null, updated_at: t,
        }, op);
        const keepEl = new Set(l.elements.map((e) => e.id));
        for (const old of list<{ id: string }>('mr_line_elements', { parent: l.id })) {
          if (!keepEl.has(old.id)) patch('mr_line_elements', old.id, { deleted_at: t }, op);
        }
        for (const e of l.elements) {
          putPending('mr_line_elements', { id: e.id, mr_line_id: l.id, project_id: x.project_id, element_id: e.element_id, qty: e.qty, deleted_at: null, updated_at: t }, op);
        }
      });
      putPending('mr_events', { id: `local:${op}`, mr_id: x.id, project_id: x.project_id, action: x.submit ? 'submit' : 'save', from_status: prev?.status ?? null, to_status: mr.status, comment: null, actor: myId(), created_at: t, updated_at: t }, op, `local:${op}`);
      break;
    }
    case 'mr_action': {
      const x = p as RpcMap['mr_action'];
      const mr = get<MaterialRequest>('material_requests', x.mr_id);
      if (!mr) break;
      const status = ACTION_STATUS[x.action];
      patch<MaterialRequest>('material_requests', x.mr_id, { status, ...(x.action === 'approve' ? { approved_by: myId(), approved_at: t } : {}) }, op);
      if (x.action === 'approve') {
        for (const l of mrLines(x.mr_id)) {
          const given = x.lines?.find((g) => g.id === l.id)?.approved_qty;
          patch<MrLine>('mr_lines', l.id, { approved_qty: given != null ? Math.min(given, Number(l.qty)) : Number(l.qty) }, op);
        }
      }
      putPending('mr_events', { id: `local:${op}`, mr_id: x.mr_id, project_id: mr.project_id, action: x.action, from_status: mr.status, to_status: status, comment: x.comment ?? null, actor: myId(), created_at: t, updated_at: t }, op, `local:${op}`);
      break;
    }
    case 'post_grn': {
      const x = p as RpcMap['post_grn'];
      const g: Grn = { id: x.id, project_id: x.project_id, number: x.number, store_id: x.store_id, supplier_id: x.supplier_id ?? null, supplier_name: x.supplier_name ?? null, delivery_note_no: x.delivery_note_no ?? null, vehicle_plate: x.vehicle_plate ?? null, driver_name: x.driver_name ?? null, received_at: x.received_at, remarks: x.remarks ?? null, supplier_signature: x.supplier_signature ?? null, status: 'posted', confirmed_by: null, created_by: myId(), created_at: t };
      putPending('grns', { ...g, updated_at: t } as unknown as Row, op);
      x.lines.forEach((l, i) => {
        const rej = l.qty_rejected ?? 0;
        const acc = l.qty_accepted ?? l.qty_delivered - rej;
        putPending('grn_lines', { ...l, grn_id: x.id, project_id: x.project_id, line_no: i + 1, qty_accepted: acc, qty_rejected: rej, inspection_result: l.inspection_result ?? 'pass', variance_flag: null, updated_at: t }, op);
        const base = { project_id: x.project_id, store_id: x.store_id, material_spec_id: l.material_spec_id, txn_type: 'grn' as const, doc_type: 'grn', doc_id: x.id, doc_number: x.number, element_id: null, mr_line_id: l.mr_line_id ?? null, txn_at: x.received_at };
        if (acc > 0) ledgerRow(op, { ...base, qty: acc, stock_status: 'available' });
        if (rej > 0) ledgerRow(op, { ...base, qty: rej, stock_status: 'quarantine' });
      });
      break;
    }
    case 'confirm_grn': {
      const x = p as RpcMap['confirm_grn'];
      patch<Grn>('grns', x.grn_id, { confirmed_by: myId() }, op);
      break;
    }
    case 'post_miv': {
      const x = p as RpcMap['post_miv'];
      const m: Miv = { id: x.id, project_id: x.project_id, number: x.number, store_id: x.store_id, mr_id: x.mr_id ?? null, issued_to: x.issued_to, issued_by: myId(), issued_at: x.issued_at, status: x.receiver_signature ? 'acknowledged' : 'pending_ack', acknowledged_at: x.receiver_signature ? t : null, receiver_signature: x.receiver_signature ?? null, is_emergency: !!x.is_emergency && !x.mr_id, emergency_reason: x.emergency_reason ?? null, regularised_at: null, remarks: x.remarks ?? null };
      putPending('mivs', { ...m, created_at: t, updated_at: t } as unknown as Row, op);
      x.lines.forEach((l, i) => {
        putPending('miv_lines', { ...l, mr_line_id: l.mr_line_id ?? null, miv_id: x.id, project_id: x.project_id, line_no: i + 1, substitution_reason: l.substitution_reason ?? null, updated_at: t }, op);
        ledgerRow(op, { project_id: x.project_id, store_id: x.store_id, material_spec_id: l.material_spec_id, qty: -l.qty, stock_status: 'available', txn_type: 'miv', doc_type: 'miv', doc_id: x.id, doc_number: x.number, element_id: l.element_id, mr_line_id: l.mr_line_id ?? null, txn_at: x.issued_at });
      });
      if (x.mr_id) refreshMrStatus(x.mr_id, op);
      break;
    }
    case 'acknowledge_miv': {
      const x = p as RpcMap['acknowledge_miv'];
      patch<Miv>('mivs', x.miv_id, { status: 'acknowledged', acknowledged_at: t }, op);
      break;
    }
    case 'regularise_miv': {
      const x = p as RpcMap['regularise_miv'];
      patch<Miv>('mivs', x.miv_id, { mr_id: x.mr_id, regularised_at: t }, op);
      break;
    }
    case 'post_mrn': {
      const x = p as RpcMap['post_mrn'];
      const m: Mrn = { id: x.id, project_id: x.project_id, number: x.number, store_id: x.store_id, miv_id: x.miv_id ?? null, returned_by: x.returned_by ?? null, received_by: myId(), returned_at: x.returned_at, status: 'posted' };
      putPending('mrns', { ...m, created_at: t, updated_at: t } as unknown as Row, op);
      x.lines.forEach((l, i) => {
        putPending('mrn_lines', { ...l, element_id: l.element_id ?? null, mrn_id: x.id, project_id: x.project_id, line_no: i + 1, updated_at: t }, op);
        ledgerRow(op, { project_id: x.project_id, store_id: x.store_id, material_spec_id: l.material_spec_id, qty: l.qty, stock_status: l.condition === 'good' ? 'available' : 'quarantine', txn_type: 'mrn', doc_type: 'mrn', doc_id: x.id, doc_number: x.number, element_id: l.element_id ?? null, mr_line_id: l.mr_line_id ?? null, txn_at: x.returned_at });
      });
      break;
    }
    case 'create_adjustment': {
      const x = p as RpcMap['create_adjustment'];
      const a: Adjustment = { id: x.id, project_id: x.project_id, number: x.number, store_id: x.store_id, adj_type: x.adj_type, reason_code: x.reason_code, remarks: x.remarks ?? null, status: 'pending', requested_by: myId(), created_at: t };
      putPending('adjustments', { ...a, updated_at: t } as unknown as Row, op);
      x.lines.forEach((l, i) => putPending('adjustment_lines', { id: l.id, adjustment_id: x.id, project_id: x.project_id, line_no: i + 1, material_spec_id: l.material_spec_id, element_id: l.element_id ?? null, stock_status: l.stock_status ?? 'available', qty_delta: -Math.abs(l.qty), updated_at: t }, op));
      break;
    }
    case 'decide_adjustment': {
      const x = p as RpcMap['decide_adjustment'];
      const a = get<Adjustment>('adjustments', x.adjustment_id);
      if (!a) break;
      patch<Adjustment>('adjustments', a.id, { status: x.approve ? 'approved' : 'rejected' }, op);
      if (x.approve) {
        for (const l of list<AdjustmentLine>('adjustment_lines', { parent: a.id })) {
          ledgerRow(op, { project_id: a.project_id, store_id: a.store_id, material_spec_id: l.material_spec_id, qty: Number(l.qty_delta), stock_status: l.stock_status, txn_type: 'adjustment', doc_type: 'adjustment', doc_id: a.id, doc_number: a.number, element_id: l.element_id, mr_line_id: null, txn_at: t });
        }
      }
      break;
    }
    case 'submit_stock_count': {
      const x = p as RpcMap['submit_stock_count'];
      const c: StockCount = { id: x.id, project_id: x.project_id, number: x.number, store_id: x.store_id, count_type: x.count_type, counted_by: myId(), counted_at: x.counted_at, status: 'submitted' };
      putPending('stock_counts', { ...c, created_at: t, updated_at: t } as unknown as Row, op);
      for (const l of x.lines) {
        const sys = stockQty(x.project_id, l.material_spec_id, x.store_id);
        const line: StockCountLine = { id: l.id, count_id: x.id, material_spec_id: l.material_spec_id, system_qty: sys, counted_qty: l.counted_qty, variance: l.counted_qty - sys };
        putPending('stock_count_lines', { ...line, project_id: x.project_id, updated_at: t } as unknown as Row, op);
      }
      break;
    }
    case 'decide_stock_count': {
      const x = p as RpcMap['decide_stock_count'];
      const c = get<StockCount>('stock_counts', x.count_id);
      if (!c) break;
      patch<StockCount>('stock_counts', c.id, { status: x.approve ? 'approved' : 'rejected' }, op);
      if (x.approve) {
        for (const l of list<StockCountLine>('stock_count_lines', { parent: c.id })) {
          if (Number(l.variance) === 0) continue;
          ledgerRow(op, { project_id: c.project_id, store_id: c.store_id, material_spec_id: l.material_spec_id, qty: Number(l.variance), stock_status: 'available', txn_type: 'adjustment', doc_type: 'adjustment', doc_id: c.id, doc_number: `${c.number}-ADJ`, element_id: null, mr_line_id: null, txn_at: t });
        }
      }
      break;
    }
    case 'send_transfer': {
      const x = p as RpcMap['send_transfer'];
      const toStore = get<{ project_id: string }>('stores', x.to_store_id);
      const tr: Transfer = { id: x.id, project_id: x.project_id, number: x.number, from_store_id: x.from_store_id, to_project_id: toStore?.project_id ?? x.project_id, to_store_id: x.to_store_id, status: 'in_transit', sent_at: x.sent_at, received_at: null };
      putPending('transfers', { ...tr, created_at: t, updated_at: t } as unknown as Row, op);
      x.lines.forEach((l, i) => {
        putPending('transfer_lines', { ...l, transfer_id: x.id, project_id: x.project_id, line_no: i + 1, qty_received: null, updated_at: t }, op);
        ledgerRow(op, { project_id: x.project_id, store_id: x.from_store_id, material_spec_id: l.material_spec_id, qty: -l.qty, stock_status: 'available', txn_type: 'transfer_out', doc_type: 'transfer', doc_id: x.id, doc_number: x.number, element_id: null, mr_line_id: null, txn_at: x.sent_at });
      });
      break;
    }
    case 'receive_transfer': {
      const x = p as RpcMap['receive_transfer'];
      const tr = get<Transfer>('transfers', x.transfer_id);
      if (!tr) break;
      patch<Transfer>('transfers', tr.id, { status: 'received', received_at: x.received_at }, op);
      for (const l of list<TransferLine>('transfer_lines', { parent: tr.id })) {
        const q = x.lines?.find((r) => r.id === l.id)?.qty_received ?? Number(l.qty);
        if (q > 0) ledgerRow(op, { project_id: tr.to_project_id, store_id: tr.to_store_id, material_spec_id: l.material_spec_id, qty: q, stock_status: 'available', txn_type: 'transfer_in', doc_type: 'transfer', doc_id: tr.id, doc_number: tr.number, element_id: null, mr_line_id: null, txn_at: x.received_at });
      }
      break;
    }
    case 'reverse_document': {
      const x = p as RpcMap['reverse_document'];
      const tbl = `${x.doc_type}s`;
      patch(tbl, x.doc_id, { status: 'reversed' }, op);
      const doc = get<{ project_id: string; mr_id?: string | null }>(tbl, x.doc_id);
      if (!doc) break;
      for (const l of list<StockLedgerEntry>('stock_ledger', { project: doc.project_id })) {
        if (l.doc_id !== x.doc_id || l.txn_type === 'reversal') continue;
        ledgerRow(op, { ...l, qty: -Number(l.qty), stock_status: l.stock_status as StockStatus, txn_type: 'reversal', txn_at: t });
      }
      if (x.doc_type === 'miv' && doc.mr_id) refreshMrStatus(doc.mr_id, op);
      break;
    }
    case 'report_progress': {
      const x = p as RpcMap['report_progress'];
      const a = get<ElementActivity>('element_activities', x.element_activity_id);
      if (!a) break;
      const u: ProgressUpdate = { id: x.id, project_id: a.project_id, element_id: a.element_id, element_activity_id: a.id, report_date: x.report_date, pct_complete: x.pct_complete, qty_achieved: x.qty_achieved ?? null, uom: x.uom ?? null, remarks: x.remarks ?? null, status: 'reported', reported_by: myId(), verified_by: null, verified_pct: null, verify_comment: null, created_at: t };
      putPending('progress_updates', { ...u, updated_at: t } as unknown as Row, op);
      patch<ElementActivity>('element_activities', a.id, { reported_pct: x.pct_complete }, op);
      break;
    }
    case 'verify_progress': {
      const x = p as RpcMap['verify_progress'];
      const u = get<ProgressUpdate>('progress_updates', x.progress_id);
      if (!u) break;
      const pct = x.verified_pct ?? Number(u.pct_complete);
      const status = !x.approve ? 'rejected' : pct !== Number(u.pct_complete) ? 'adjusted' : 'verified';
      patch<ProgressUpdate>('progress_updates', u.id, { status, verified_by: myId(), verified_pct: x.approve ? pct : null, verify_comment: x.comment ?? null }, op);
      if (x.approve) {
        patch<ElementActivity>('element_activities', u.element_activity_id, { verified_pct: pct }, op);
        const acts = list<ElementActivity>('element_activities', { parent: u.element_id });
        const w = acts.reduce((s, a) => s + Number(a.weight), 0);
        const prog = w > 0 ? acts.reduce((s, a) => s + Number(a.weight) * Number(a.verified_pct), 0) / w : 0;
        patch<Element>('elements', u.element_id, { progress_pct: Math.round(prog * 100) / 100, status: prog >= 100 ? 'completed' : 'in_progress' }, op);
      }
      break;
    }
    case 'mark_notifications_read': {
      const x = p as RpcMap['mark_notifications_read'];
      for (const n of list<AppNotification>('notifications', { parent: myId() })) {
        if (!n.read_at && (!x.ids || x.ids.includes(n.id))) patch<AppNotification>('notifications', n.id, { read_at: t }, op);
      }
      break;
    }
    default:
      break;
  }
}
