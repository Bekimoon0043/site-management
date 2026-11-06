// Optimistic local apply for the material procurement flows (contract-flows.ts RpcMapFlows),
// mirroring 20261030000002_mr_flows.sql closely enough for offline use: save_mr with request_type,
// every mr_action variant per flow (review / approve incl. reviewed_qty, issue_by, store_id; accept;
// return / reject / cancel / close; convert_shortfall → linked PR created with the client id/number),
// delivery notices (notify / acknowledge), post_grn closing a notice + PR receipt status, and
// acknowledge_miv → 'received'. Rows are tagged with the op id and replaced by server copies on pull.
import type { Grn, Miv, MrEvent, MrLineElement, RpcMap, RpcName } from './contract';
import {
  nextActor, type DeliveryNotice, type FlowMrStatus, type MrActionFlowPayload, type MrApproval, type RpcMapFlows,
  type PostGrnFlowFields, type RequestType,
} from './contract-flows';
import type { PoLine, PurchaseOrder, RpcMapProcurement } from './contract-procurement';
import { get, list, putPending, type Row } from './db';
import { myId, myRole } from './me';
import { applyOptimistic } from './optimistic';
import { applyOptimisticPC } from './optimistic-pc';
import { issuedForLine, mrLines } from './queries';
import { flowSettings, requestTypeOf, type FlowLine, type FlowMr } from './flows';

/** RPCs handled here (save_mr / mr_action / post_grn / acknowledge_miv are delegated + extended). */
export type RpcMapFlowsApp = Omit<RpcMapFlows, 'save_mr'> & {
  save_mr: RpcMapFlows['save_mr'];
  post_grn: RpcMapProcurement['post_grn'] & PostGrnFlowFields;
  acknowledge_miv: RpcMap['acknowledge_miv'];
};
type Name = keyof RpcMapFlowsApp;
const NAMES: Record<Name, true> = {
  save_mr: true, mr_action: true, create_rfq_from_prs: true, record_direct_purchase: true, notify_store_delivery: true,
  acknowledge_delivery_notice: true, save_approval_delegation: true, post_grn: true, acknowledge_miv: true,
};
export const FLOW_RPCS = new Set<string>(Object.keys(NAMES));

const now = () => new Date().toISOString();

function patch<T extends object>(tbl: string, id: string, changes: Partial<T>, op: string) {
  const cur = get<T>(tbl, id);
  if (!cur) return;
  const { _pending: _, ...rest } = cur as T & { _pending?: string };
  putPending(tbl, { ...rest, ...changes, updated_at: now() } as Row, op);
}

function event(op: string, mr: FlowMr, action: string, to: FlowMrStatus | null, comment?: string | null, suffix = '') {
  const t = now();
  const id = `local:${op}${suffix}`;
  putPending('mr_events', { id, mr_id: mr.id, project_id: mr.project_id, action, from_status: mr.status, to_status: to, comment: comment ?? null, actor: myId(), created_at: t, updated_at: t } as MrEvent & Row, op, id);
}

function approval(op: string, mr: FlowMr, step: MrApproval['step'], comment?: string | null, suffix = '') {
  const t = now();
  const id = `local:${op}:ap${suffix}`;
  const a: MrApproval = { id, mr_id: mr.id, project_id: mr.project_id, step, actor: myId(), actor_role: myRole() ?? 'coordinator', delegated_from: null, comment: comment ?? null, superseded: false, created_at: t };
  putPending('mr_approvals', { ...a, updated_at: t } as unknown as Row, op, id);
}

function supersede(op: string, mrId: string) {
  for (const a of list<MrApproval>('mr_approvals', { parent: mrId })) if (!a.superseded) patch<MrApproval>('mr_approvals', a.id, { superseded: true }, op);
}

/** Status change + ball in court + timestamps (app.mr_transition). */
function transition(op: string, mr: FlowMr, to: FlowMrStatus, action: string, comment: string | null | undefined, extra: Partial<FlowMr> = {}) {
  const type = requestTypeOf(mr);
  const s = flowSettings(mr.project_id);
  const t = now();
  const owner = to === 'draft' || to === 'returned' ? 'requester' : nextActor(to, type, s);
  patch<FlowMr>('material_requests', mr.id, {
    ...extra, status: to, current_owner_role: owner,
    ...(to === 'received' ? { received_at: t } : {}),
    ...(['closed', 'rejected', 'cancelled'].includes(to) ? { closed_at: t } : {}),
    ...(['returned', 'rejected', 'cancelled', 'closed'].includes(to) && comment ? { status_reason: comment } : {}),
  }, op);
  event(op, mr, action, to, comment);
}

// ---------------------------------------------------------------------------
// mr_action
// ---------------------------------------------------------------------------

function mrAction(x: MrActionFlowPayload, op: string) {
  const mr = get<FlowMr>('material_requests', x.mr_id);
  if (!mr) return;
  const type = requestTypeOf(mr);
  const t = now();
  const lines = (mrLines(mr.id) as FlowLine[]).filter((l) => !l.deleted_at);
  const given = (id: string) => x.lines?.find((g) => g.id === id);

  switch (x.action) {
    case 'review': {
      for (const l of lines) {
        const q = given(l.id)?.reviewed_qty;
        if (q != null) patch<FlowLine>('mr_lines', l.id, { reviewed_qty: Math.min(q, Number(l.qty)) }, op);
      }
      if (type === 'purchase') {
        approval(op, mr, 'coordinator_review', x.comment);
        transition(op, mr, 'reviewed_by_coordinator', 'review', x.comment, { coordinator_reviewed_by: myId(), coordinator_reviewed_at: t, reviewed_by: myId(), reviewed_at: t });
      } else {
        approval(op, mr, 'oe_review', x.comment);
        transition(op, mr, 'reviewed', 'review', x.comment, { reviewed_by: myId(), reviewed_at: t });
      }
      break;
    }
    case 'approve': {
      for (const l of lines) {
        const reviewed = given(l.id)?.reviewed_qty ?? l.reviewed_qty;
        const cap = Number(reviewed ?? l.qty);
        const g = given(l.id)?.approved_qty;
        const base = type === 'purchase' ? Number(l.approved_qty ?? cap) : cap;
        patch<FlowLine>('mr_lines', l.id, { approved_qty: g != null ? Math.min(g, cap) : base }, op);
      }
      approval(op, mr, 'approve', x.comment);
      if (type === 'purchase') {
        const coord = myRole() === 'coordinator';
        transition(op, mr, 'approved_by_management', 'approve', x.comment, {
          approved_by: myId(), approved_at: t,
          ...(coord && !mr.coordinator_reviewed_by ? { coordinator_reviewed_by: myId(), coordinator_reviewed_at: t } : {}),
        });
      } else {
        transition(op, mr, 'approved', 'approve', x.comment, {
          approved_by: myId(), approved_at: t,
          ...(x.store_id ? { store_id: x.store_id } : {}), ...(x.issue_by ? { issue_by: x.issue_by } : {}),
        });
      }
      break;
    }
    case 'accept': {
      approval(op, mr, 'procurement_accept', x.comment);
      transition(op, mr, 'with_procurement', 'accept', x.comment, { procurement_owner: x.assign_to ?? myId(), procurement_accepted_at: t });
      break;
    }
    case 'return': {
      if (type === 'purchase') {
        for (const l of lines) patch<FlowLine>('mr_lines', l.id, { approved_qty: null }, op);
      }
      supersede(op, mr.id);
      transition(op, mr, 'returned', 'return', x.comment, type === 'purchase' ? { approved_by: null, approved_at: null, procurement_owner: null, procurement_accepted_at: null } : {});
      break;
    }
    case 'reject': transition(op, mr, 'rejected', 'reject', x.comment); break;
    case 'cancel': transition(op, mr, 'cancelled', 'cancel', x.comment); break;
    case 'close': {
      if (type === 'purchase') {
        for (const l of lines) {
          if ((l.line_status ?? 'open') === 'open' && Number(l.qty_received ?? 0) < Number(l.approved_qty ?? 0) - 0.0005) {
            patch<FlowLine>('mr_lines', l.id, { line_status: 'short_closed' }, op);
          }
        }
      }
      transition(op, mr, 'closed', 'close', x.comment);
      break;
    }
    case 'convert_shortfall': {
      convertShortfall(x, mr, lines, op);
      break;
    }
    default: {
      // Legacy payloads (contract.ts MrActionPayload) are a subset of the flow payload.
      applyOptimistic('mr_action', x as unknown as RpcMap['mr_action'], op);
    }
  }
}

/** Linked purchase request for the shortfall (app.convert_shortfall): submitted straight to the coordinator. */
function convertShortfall(x: MrActionFlowPayload, sur: FlowMr, lines: FlowLine[], op: string) {
  if (!x.pr_id || !x.pr_number) return;   // server derives them; the PR then arrives on pull
  const t = now();
  const s = flowSettings(sur.project_id);
  const pr: FlowMr = {
    ...sur, id: x.pr_id, number: x.pr_number, request_type: 'purchase', source_mr_id: sur.id, status: 'submitted',
    current_owner_role: nextActor('submitted', 'purchase', s), requested_by: myId(), requester_role: myRole() ?? 'office_engineer',
    purpose: `Shortfall of ${sur.number}${sur.purpose ? `: ${sur.purpose}` : ''}`, store_id: sur.store_id, version: 1,
    submitted_at: t, reviewed_by: null, reviewed_at: null, approved_by: null, approved_at: null, coordinator_reviewed_by: null,
    coordinator_reviewed_at: null, procurement_owner: null, procurement_accepted_at: null, issue_by: null, received_at: null,
    closed_at: null, status_reason: null, created_at: t, updated_at: t,
  };
  delete (pr as { _pending?: string })._pending;
  putPending('material_requests', pr as unknown as Row, op);
  let n = 0;
  for (const g of x.lines ?? []) {
    const l = lines.find((y) => y.id === g.id);
    const q = Number(g.qty ?? 0);
    if (!l || !(q > 0)) continue;
    n++;
    const lineId = g.pr_line_id ?? `local:${op}:prl${n}`;
    putPending('mr_lines', {
      id: lineId, mr_id: pr.id, project_id: pr.project_id, line_no: n, material_spec_id: l.material_spec_id, qty: q, approved_qty: null,
      reviewed_qty: null, required_date: l.required_date, remarks: `Shortfall of ${sur.number} line ${l.line_no}`, boq_item_id: l.boq_item_id,
      exceeds_boq: false, over_boq_reason: null, source_mr_line_id: l.id, qty_received: 0, line_status: 'open', deleted_at: null, updated_at: t,
    }, op, lineId);
    // element split scaled to the purchase quantity (remainder on the last element)
    const els = list<MrLineElement>('mr_line_elements', { parent: l.id }).filter((e) => !e.deleted_at).sort((a, b) => a.id.localeCompare(b.id));
    const tot = els.reduce((sum, e) => sum + Number(e.qty), 0);
    let acc = 0;
    els.forEach((e, i) => {
      const eq = i === els.length - 1 ? q - acc : Math.round((Number(e.qty) * q / tot) * 1000) / 1000;
      acc += eq;
      if (eq > 0 && tot > 0) {
        const eid = `local:${op}:pre${n}:${i}`;
        putPending('mr_line_elements', { id: eid, mr_line_id: lineId, project_id: pr.project_id, element_id: e.element_id, qty: eq, deleted_at: null, updated_at: t }, op, eid);
      }
    });
  }
  event(op, { ...pr, status: 'draft' }, 'submit', 'submitted', null, ':pr');
  event(op, sur, 'convert_shortfall', sur.status, x.comment ?? `Purchase request ${pr.number}`);
}

// ---------------------------------------------------------------------------
// Purchase receipt status (app.refresh_mr_procurement, receipt part)
// ---------------------------------------------------------------------------

function refreshPrReceipt(mrId: string, op: string) {
  const mr = get<FlowMr>('material_requests', mrId);
  if (!mr || requestTypeOf(mr) !== 'purchase' || ['closed', 'rejected', 'cancelled', 'received'].includes(mr.status)) return;
  const ls = (mrLines(mrId) as FlowLine[]).filter((l) => !l.deleted_at && Number(l.approved_qty ?? 0) > 0 && (l.line_status ?? 'open') === 'open');
  if (!ls.length) return;
  const any = ls.some((l) => Number(l.qty_received ?? 0) > 0);
  const all = ls.every((l) => Number(l.qty_received ?? 0) >= Number(l.approved_qty) - 0.0005);
  const to: FlowMrStatus | null = all ? 'received' : any ? 'partially_received' : null;
  if (to && to !== mr.status) transition(op, mr, to, 'receive', null);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function applyOptimisticFlows<N extends Name>(rpc: N, payload: RpcMapFlowsApp[N], op: string): void {
  const t = now();
  switch (rpc) {
    case 'save_mr': {
      const x = payload as RpcMapFlowsApp['save_mr'];
      const prev = get<FlowMr>('material_requests', x.id);
      const type: RequestType = x.request_type ?? (prev ? requestTypeOf(prev) : 'site_use');
      applyOptimistic('save_mr', { ...x, block_id: x.block_id ?? '' } as unknown as RpcMap['save_mr'], op);
      const s = flowSettings(x.project_id);
      const status: FlowMrStatus = x.submit ? 'submitted' : prev?.status === 'returned' ? 'returned' : 'draft';
      patch<FlowMr>('material_requests', x.id, {
        request_type: type, block_id: x.block_id || null, lookahead_plan_id: x.lookahead_plan_id ?? prev?.lookahead_plan_id ?? null,
        current_owner_role: status === 'submitted' ? nextActor('submitted', type, s) : 'requester',
        source_mr_id: prev?.source_mr_id ?? null,
      }, op);
      for (const l of x.lines) patch<FlowLine>('mr_lines', l.id, { reviewed_qty: null, qty_received: 0, line_status: 'open', lookahead_item_id: l.lookahead_item_id ?? null }, op);
      break;
    }
    case 'mr_action':
      mrAction(payload as MrActionFlowPayload, op);
      break;
    case 'notify_store_delivery': {
      const x = payload as RpcMapFlowsApp['notify_store_delivery'];
      const po = get<PurchaseOrder>('purchase_orders', x.po_id);
      if (!po) break;
      const pls = list<PoLine>('po_lines', { parent: po.id }).filter((l) => !l.deleted_at && !l.closed);
      const lines = x.lines?.length
        ? x.lines.map((l) => ({ po_line_id: l.po_line_id, material_spec_id: pls.find((p) => p.id === l.po_line_id)?.material_spec_id ?? '', qty: l.qty }))
        : pls.map((l) => ({ po_line_id: l.id, material_spec_id: l.material_spec_id, qty: Number(l.qty) - Number(l.qty_accepted ?? 0) })).filter((l) => l.qty > 0.0005);
      const dn: DeliveryNotice = {
        id: x.id, project_id: po.project_id, po_id: po.id, store_id: po.delivery_store_id ?? '', expected_date: x.expected_date,
        expected_window: x.expected_window ?? null, vehicle_plate: x.vehicle_plate?.trim().toUpperCase() || null, driver_name: x.driver_name ?? null,
        driver_phone: x.driver_phone ?? null, lines, note: x.note ?? null, status: 'notified', ack_by: null, ack_at: null, ack_note: null,
        proposed_date: null, grn_id: null, created_by: myId(), created_at: t,
      };
      putPending('delivery_notices', { ...dn, updated_at: t } as unknown as Row, op);
      patch<PurchaseOrder>('purchase_orders', po.id, { eta: x.expected_date }, op);
      const mrIds = new Set(pls.map((l) => (l.mr_line_id ? get<FlowLine>('mr_lines', l.mr_line_id)?.mr_id : null)).filter((v): v is string => !!v));
      for (const id of mrIds) {
        const mr = get<FlowMr>('material_requests', id);
        if (mr && requestTypeOf(mr) === 'purchase' && ['with_procurement', 'sourced', 'ordered'].includes(mr.status)) {
          transition(op, mr, 'delivery_expected', 'delivery_notice', null);
        }
      }
      break;
    }
    case 'acknowledge_delivery_notice': {
      const x = payload as RpcMapFlowsApp['acknowledge_delivery_notice'];
      patch<DeliveryNotice>('delivery_notices', x.id, x.decision === 'accept'
        ? { status: 'acknowledged', ack_by: myId(), ack_at: t, ack_note: x.note ?? null }
        : { status: 'reschedule_requested', ack_by: myId(), ack_at: t, ack_note: x.note ?? null, proposed_date: x.proposed_date ?? null }, op);
      break;
    }
    case 'post_grn': {
      const x = payload as RpcMapFlowsApp['post_grn'];
      applyOptimisticPC('post_grn', x, op);
      // purchase request receipt quantities + status
      const touched = new Set<string>();
      for (const l of x.lines) {
        if (!l.mr_line_id) continue;
        const ml = get<FlowLine>('mr_lines', l.mr_line_id);
        if (!ml) continue;
        const mr = get<FlowMr>('material_requests', ml.mr_id);
        if (!mr || requestTypeOf(mr) !== 'purchase') continue;
        const acc = l.qty_accepted ?? l.qty_delivered - (l.qty_rejected ?? 0);
        patch<FlowLine>('mr_lines', ml.id, { qty_received: Number(ml.qty_received ?? 0) + acc }, op);
        touched.add(mr.id);
      }
      touched.forEach((id) => refreshPrReceipt(id, op));
      // the delivery notice (given, else the PO's earliest open one) is closed by the GRN
      const poId = x.po_id ?? x.lines.map((l) => (l.po_line_id ? get<PoLine>('po_lines', l.po_line_id)?.po_id : null)).find(Boolean) ?? null;
      const noticeId = x.delivery_notice_id ?? (poId ? list<DeliveryNotice>('delivery_notices', { parent: poId })
        .filter((d) => ['notified', 'acknowledged', 'reschedule_requested', 'arrived'].includes(d.status))
        .sort((a, b) => a.expected_date.localeCompare(b.expected_date))[0]?.id : null);
      if (noticeId) patch<DeliveryNotice>('delivery_notices', noticeId, { status: 'received', grn_id: x.id }, op);
      patch<Grn & { delivery_notice_id?: string }>('grns', x.id, x.delivery_notice_id ? { delivery_notice_id: x.delivery_notice_id } : {}, op);
      break;
    }
    case 'acknowledge_miv': {
      const x = payload as RpcMapFlowsApp['acknowledge_miv'];
      applyOptimistic('acknowledge_miv', x, op);
      const m = get<Miv>('mivs', x.miv_id);
      if (!m?.mr_id) break;
      const mr = get<FlowMr>('material_requests', m.mr_id);
      if (!mr || mr.status !== 'issued') break;
      const open = list<Miv>('mivs', { project: mr.project_id }).some((v) => v.mr_id === mr.id && v.status === 'pending_ack' && v.id !== m.id);
      const fully = (mrLines(mr.id) as FlowLine[]).filter((l) => !l.deleted_at && Number(l.approved_qty ?? 0) > 0)
        .every((l) => issuedForLine(mr.project_id, l.id) >= Number(l.approved_qty) - 0.0005);
      if (!open && fully) transition(op, mr, 'received', 'acknowledge', null);
      break;
    }
    default:
      // create_rfq_from_prs / record_direct_purchase / save_approval_delegation: server-side only on mobile.
      break;
  }
}
