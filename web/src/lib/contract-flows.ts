// Material procurement flows contract — mirrors
// supabase/migrations/20261030000001_mr_flow_enums.sql + 20261030000002_mr_flows.sql
// (spec: docs/research/procurement-lookahead.md §3–§7).
//
//   Flow A  PURCHASE  (request_type 'purchase', numbers <PROJ>-PR-<DEV>-<SEQ>)
//     Office Engineer raises → Coordinator reviews → Management approves → Procurement buys
//     (RFQ / quotations / PO or direct purchase) → delivery notice to Store Keeper (+ security)
//     → Store Keeper accepts the notice and confirms with a GRN → received → closed.
//   Flow B  SITE USE  (request_type 'site_use', default; legacy <PROJ>-MR-… numbers stay valid)
//     Site Engineer requests → Office Engineer reviews (BoQ / stock) → Coordinator approves
//     (= store order) → Store Keeper issues (MIV) → Site Engineer acknowledges → received → closed.
//
// Price access: mr_estimates and mr_approval_values are price-restricted (fetch only when
// can(role, 'prices.view')). Everything in SYNC_TABLES_FLOWS is quantity-only.

import type { AppRole, MrPriority, MrStatus, SyncTable } from './contract';

// ---------------------------------------------------------------------------
// Types & statuses
// ---------------------------------------------------------------------------

export type RequestType = 'site_use' | 'purchase';

/** MrStatus extended with the values added in 20261030000001_mr_flow_enums.sql. */
export type FlowMrStatus = MrStatus
  | 'reviewed_by_coordinator' | 'approved_by_management' | 'with_procurement'
  | 'delivery_expected' | 'partially_received' | 'received';

export type PurchaseStatus =
  | 'draft' | 'submitted' | 'returned' | 'reviewed_by_coordinator' | 'approved_by_management' | 'with_procurement'
  | 'sourced' | 'ordered' | 'delivery_expected' | 'partially_received' | 'received' | 'closed' | 'rejected' | 'cancelled'
  | 'reviewed' | 'approved';   // legacy values on old reorder rows (= reviewed_by_coordinator / approved_by_management)

export type SiteUseStatus =
  | 'draft' | 'submitted' | 'returned' | 'reviewed' | 'approved' | 'sourced' | 'ordered'
  | 'partially_issued' | 'issued' | 'received' | 'closed' | 'rejected' | 'cancelled';

export const REQUEST_TYPE_LABELS: Record<RequestType, string> = { site_use: 'Site use request', purchase: 'Purchase request' };
export const REQUEST_TYPE_PREFIX: Record<RequestType, 'MR' | 'PR'> = { site_use: 'MR', purchase: 'PR' };
export const flowDocNumber = (projectCode: string, type: RequestType, devicePrefix: string, seq: number) =>
  `${projectCode}-${REQUEST_TYPE_PREFIX[type]}-${devicePrefix}-${String(seq).padStart(4, '0')}`;

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  draft: 'Draft', submitted: 'Submitted to coordinator', returned: 'Returned for clarification',
  reviewed_by_coordinator: 'Reviewed by coordinator', approved_by_management: 'Approved by management',
  with_procurement: 'With procurement', sourced: 'Sourcing (RFQ / PO)', ordered: 'Purchased',
  delivery_expected: 'Delivery expected', partially_received: 'Partially received', received: 'Received',
  closed: 'Closed', rejected: 'Rejected', cancelled: 'Cancelled',
  reviewed: 'Reviewed by coordinator', approved: 'Approved by management',
};
export const SITE_USE_STATUS_LABELS: Record<SiteUseStatus, string> = {
  draft: 'Draft', submitted: 'Waiting for office engineer review', returned: 'Returned for clarification',
  reviewed: 'Forwarded to coordinator', approved: 'Store order issued', sourced: 'Store order issued (on order)',
  ordered: 'Store order issued (on order)', partially_issued: 'Partially issued', issued: 'Issued — awaiting acknowledgement',
  received: 'Received on site', closed: 'Closed', rejected: 'Rejected', cancelled: 'Cancelled',
};
export const flowStatusLabel = (status: FlowMrStatus, type: RequestType): string =>
  type === 'purchase'
    ? PURCHASE_STATUS_LABELS[status as PurchaseStatus] ?? status
    : SITE_USE_STATUS_LABELS[status as SiteUseStatus] ?? status;

const TERMINAL = new Set<FlowMrStatus>(['closed', 'rejected', 'cancelled']);
export const isTerminal = (status: FlowMrStatus) => TERMINAL.has(status);

// ---------------------------------------------------------------------------
// Steps per flow (UI timelines) — who acts at each status ("ball in court").
// 'requester' = material_requests.requested_by. Mirrors app.mr_owner_role().
// ---------------------------------------------------------------------------

export type FlowActor = AppRole | 'requester';
export interface FlowStep {
  key: string;
  label: string;
  /** Statuses during which this step is the current one. */
  statuses: FlowMrStatus[];
  actor: FlowActor | null;
  /** mr_action / RPC the actor uses to complete the step. */
  actions: string[];
}

export const PURCHASE_STEPS: FlowStep[] = [
  { key: 'raise', label: 'Raised by office engineer', statuses: ['draft', 'returned'], actor: 'requester', actions: ['save_mr'] },
  { key: 'review', label: 'Coordinator review', statuses: ['submitted'], actor: 'coordinator', actions: ['review', 'return', 'reject'] },
  { key: 'approve', label: 'Management approval', statuses: ['reviewed_by_coordinator', 'reviewed'], actor: 'manager', actions: ['approve', 'return', 'reject'] },
  { key: 'accept', label: 'Procurement accepts', statuses: ['approved_by_management', 'approved'], actor: 'procurement', actions: ['accept', 'return'] },
  { key: 'buy', label: 'RFQ / quotations / PO', statuses: ['with_procurement', 'sourced'], actor: 'procurement',
    actions: ['create_rfq_from_prs', 'record_quotation', 'award_rfq', 'po_action', 'record_direct_purchase'] },
  { key: 'notify', label: 'Purchased — notify store', statuses: ['ordered', 'partially_received'], actor: 'procurement', actions: ['notify_store_delivery'] },
  { key: 'deliver', label: 'Store keeper accepts delivery & posts GRN', statuses: ['delivery_expected'], actor: 'store_keeper',
    actions: ['acknowledge_delivery_notice', 'post_grn'] },
  { key: 'received', label: 'Received — requester informed', statuses: ['received', 'closed'], actor: null, actions: [] },
];

export const SITE_USE_STEPS: FlowStep[] = [
  { key: 'request', label: 'Requested by site engineer', statuses: ['draft', 'returned'], actor: 'requester', actions: ['save_mr'] },
  { key: 'review', label: 'Office engineer review (BoQ / stock)', statuses: ['submitted'], actor: 'office_engineer',
    actions: ['review', 'return', 'convert_shortfall'] },
  { key: 'approve', label: 'Coordinator approval = store order', statuses: ['reviewed'], actor: 'coordinator',
    actions: ['approve', 'return', 'reject', 'convert_shortfall'] },
  { key: 'issue', label: 'Store keeper issues (MIV)', statuses: ['approved', 'sourced', 'ordered', 'partially_issued'], actor: 'store_keeper', actions: ['post_miv'] },
  { key: 'acknowledge', label: 'Site engineer acknowledges', statuses: ['issued'], actor: 'requester', actions: ['acknowledge_miv'] },
  { key: 'received', label: 'Received', statuses: ['received', 'closed'], actor: null, actions: [] },
];

export const flowSteps = (type: RequestType) => (type === 'purchase' ? PURCHASE_STEPS : SITE_USE_STEPS);

/**
 * Who acts next. `requireReview` (project_settings.require_review) / `requireCoordinatorReview`
 * (pr_require_coordinator_review) change the actor at 'submitted'. Server value: material_requests.current_owner_role.
 */
export function nextActor(status: FlowMrStatus, type: RequestType,
  opts: { requireReview?: boolean; requireCoordinatorReview?: boolean } = {}): FlowActor | null {
  if (status === 'submitted') {
    if (type === 'purchase') return opts.requireCoordinatorReview === false ? 'manager' : 'coordinator';
    return opts.requireReview === false ? 'coordinator' : 'office_engineer';
  }
  if (type === 'purchase' && status === 'partially_received') return 'procurement';
  if (type === 'purchase' && status === 'received') return 'requester';
  return flowSteps(type).find((s) => s.statuses.includes(status))?.actor ?? null;
}
export const stepIndex = (status: FlowMrStatus, type: RequestType) => flowSteps(type).findIndex((s) => s.statuses.includes(status));

// ---------------------------------------------------------------------------
// Permissions (UI gating; the database enforces the same rules incl. value limits,
// delegations and "no self-approval")
// ---------------------------------------------------------------------------

export type FlowAction =
  | 'sur.create' | 'sur.review' | 'sur.approve' | 'sur.convertShortfall' | 'sur.issue' | 'sur.close'
  | 'pr.create' | 'pr.review' | 'pr.approve' | 'pr.accept' | 'pr.return' | 'pr.close'
  | 'rfq.fromPr' | 'po.direct' | 'delivery.notify' | 'delivery.acknowledge' | 'delegation.save';

const FLOW_PERMS: Record<FlowAction, AppRole[]> = {
  'sur.create': ['site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin'],
  'sur.review': ['office_engineer', 'coordinator', 'manager', 'admin'],
  'sur.approve': ['coordinator', 'manager', 'admin'],
  'sur.convertShortfall': ['office_engineer', 'coordinator', 'admin'],
  'sur.issue': ['store_keeper', 'coordinator', 'manager', 'admin'],
  'sur.close': ['store_keeper', 'coordinator', 'manager', 'admin'],
  'pr.create': ['office_engineer', 'coordinator', 'manager', 'procurement', 'store_keeper', 'admin'],
  'pr.review': ['coordinator', 'admin'],
  /** coordinator only when project_settings.pr_coordinator_final_limit is set and the value is within it. */
  'pr.approve': ['manager', 'admin'],
  'pr.accept': ['procurement', 'admin'],
  'pr.return': ['coordinator', 'manager', 'procurement', 'admin'],
  'pr.close': ['procurement', 'coordinator', 'manager', 'admin'],
  'rfq.fromPr': ['procurement', 'coordinator', 'manager', 'admin'],
  'po.direct': ['procurement', 'coordinator', 'manager', 'admin'],
  'delivery.notify': ['procurement', 'coordinator', 'manager', 'admin'],
  'delivery.acknowledge': ['store_keeper', 'coordinator', 'manager', 'admin'],
  'delegation.save': ['coordinator', 'manager', 'admin', 'office_engineer', 'procurement', 'store_keeper', 'site_engineer'],
};
export const canFlow = (role: AppRole | null | undefined, action: FlowAction) => !!role && FLOW_PERMS[action].includes(role);

// ---------------------------------------------------------------------------
// Approval inbox kinds (v_my_approvals.kind)
// Site-use kinds keep the pre-existing names mr_review / mr_approve (spec: sur_review / sur_approve).
// ---------------------------------------------------------------------------

export type FlowInboxKind = 'mr_review' | 'mr_approve' | 'sur_issue' | 'miv_ack'
  | 'pr_review' | 'pr_approve' | 'pr_accept' | 'delivery_ack' | 'po_approve';
export const FLOW_INBOX: Record<FlowInboxKind, { flow: RequestType | null; role: FlowActor; entity: string; actions: string[] }> = {
  mr_review: { flow: 'site_use', role: 'office_engineer', entity: 'material_request', actions: ['review', 'return'] },
  mr_approve: { flow: 'site_use', role: 'coordinator', entity: 'material_request', actions: ['approve', 'reject', 'return'] },
  sur_issue: { flow: 'site_use', role: 'store_keeper', entity: 'material_request', actions: ['issue'] },
  miv_ack: { flow: 'site_use', role: 'requester', entity: 'miv', actions: ['acknowledge'] },
  pr_review: { flow: 'purchase', role: 'coordinator', entity: 'material_request', actions: ['review', 'return', 'reject'] },
  pr_approve: { flow: 'purchase', role: 'manager', entity: 'material_request', actions: ['approve', 'return', 'reject'] },
  pr_accept: { flow: 'purchase', role: 'procurement', entity: 'material_request', actions: ['accept', 'return'] },
  delivery_ack: { flow: 'purchase', role: 'store_keeper', entity: 'delivery_notice', actions: ['accept', 'reschedule'] },
  po_approve: { flow: 'purchase', role: 'manager', entity: 'purchase_order', actions: ['approve', 'reject'] },
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type ApprovalDocType = 'any' | 'purchase_request' | 'site_use' | 'po';
export type DeliveryNoticeStatus = 'notified' | 'acknowledged' | 'reschedule_requested' | 'arrived' | 'received' | 'cancelled';
export type MrLineStatus = 'open' | 'short_closed' | 'cancelled';
export type PurchaseMethod = 'rfq' | 'direct' | 'framework';

/** Columns added to material_requests. */
export interface MaterialRequestFlowFields {
  request_type: RequestType; source_mr_id: string | null; lookahead_plan_id: string | null;
  current_owner_role: FlowActor | null; coordinator_reviewed_by: string | null; coordinator_reviewed_at: string | null;
  procurement_owner: string | null; procurement_accepted_at: string | null; issue_by: string | null;
  received_at: string | null; closed_at: string | null; status_reason: string | null;
}
/** Columns added to mr_lines. */
export interface MrLineFlowFields {
  reviewed_qty: number | null; source_mr_line_id: string | null; lookahead_item_id: string | null;
  qty_received: number; line_status: MrLineStatus;
}
export interface ProjectSettingsFlowFields {
  wf_sla_hours: { pr: Record<string, number>; sur: Record<string, number> };
  pr_require_coordinator_review: boolean; pr_coordinator_final_limit: number | null; direct_purchase_limit: number;
  po_tolerance_pct: number; po_auto_approve: boolean; delivery_notice_days: number; pr_requires_elements: boolean;
  sur_auto_close_hours: number;
}
export interface PurchaseOrderFlowFields { purchase_method: PurchaseMethod; auto_approved: boolean; receipt_ref: string | null }
export interface ApprovalLimitFlowFields { doc_type: ApprovalDocType; user_id: string | null }

export interface MrApproval {
  id: string; mr_id: string; project_id: string;
  step: 'oe_review' | 'coordinator_review' | 'endorse' | 'approve' | 'procurement_accept';
  actor: string; actor_role: AppRole; delegated_from: string | null; comment: string | null; superseded: boolean; created_at: string;
}
/** Price-restricted. */
export interface MrApprovalValue { approval_id: string; project_id: string; est_value: number | null; limit_used: number | null }
/** Price-restricted. */
export interface MrEstimate {
  mr_id: string; project_id: string; est_value: number | null; priced_lines: number; unpriced_lines: number;
  line_prices: { mr_line_id: string; unit_price: number | null; qty: number }[]; computed_at: string;
}
export interface ApprovalDelegation {
  id: string; project_id: string | null; from_user: string; to_user: string; doc_type: ApprovalDocType;
  valid_from: string; valid_to: string; reason: string; revoked_at: string | null; created_by: string; created_at: string;
}
export interface DeliveryNotice {
  id: string; project_id: string; po_id: string; store_id: string; expected_date: string; expected_window: string | null;
  vehicle_plate: string | null; driver_name: string | null; driver_phone: string | null;
  lines: { po_line_id: string; material_spec_id: string; qty: number }[]; note: string | null;
  status: DeliveryNoticeStatus; ack_by: string | null; ack_at: string | null; ack_note: string | null;
  proposed_date: string | null; grn_id: string | null; created_by: string; created_at: string;
}

/** mr_action review/approve: stock check per line (§5.1). */
export interface StockCheckLine {
  id: string; line_no: number; material_spec_id: string; store_id: string; requested: number; qty: number;
  reviewed_qty: number | null; approved_qty: number | null; issued: number; ati: number; shortfall: number;
  other_stores: { store_id: string; store_name: string; qty: number }[];
  open_po: { po_id: string; po_number: string; eta: string | null; qty: number }[];
}

// Views
export interface StockAvailableToIssueRow {
  project_id: string; store_id: string; store_name: string; material_spec_id: string; label: string; uom: string;
  available: number; reserved: number; ati: number; over_promised: boolean;
}
export interface MrWorkflowRow {
  id: string; project_id: string; number: string; request_type: RequestType; status: FlowMrStatus; priority: MrPriority;
  current_owner_role: FlowActor | null; requested_by: string; requested_by_name: string; requester_role: AppRole;
  required_date: string; issue_by: string | null; store_id: string | null; source_mr_id: string | null; source_number: string | null;
  procurement_owner: string | null; status_since: string; hours_in_status: number; sla_hours: number | null; sla_due: string | null;
  is_overdue: boolean; linked_pr_numbers: string[]; po_numbers: string[]; grn_numbers: string[]; miv_numbers: string[];
}
export interface PrTrackerRow {
  mr_line_id: string; mr_id: string; number: string; project_id: string; status: FlowMrStatus; priority: MrPriority;
  source_mr_id: string | null; source_mr_line_id: string | null; line_no: number; material_spec_id: string; label: string; uom: string;
  requested_qty: number; reviewed_qty: number | null; approved_qty: number | null; line_status: MrLineStatus;
  on_rfq_qty: number; ordered_qty: number; eta: string | null; notice_date: string | null; received_qty: number; outstanding_qty: number;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Quantity-only tables (all project members). material_requests / mr_lines gain columns — re-pull them once. */
export const SYNC_TABLES_FLOWS: SyncTable[] = [
  { name: 'mr_approvals', pk: ['id'] },
  { name: 'delivery_notices', pk: ['id'] },
  { name: 'approval_delegations', pk: ['id'] },
];
/** Price-restricted: fetch only when can(role, 'prices.view'). */
export const PRICE_TABLES_FLOWS: SyncTable[] = [
  { name: 'mr_estimates', pk: ['mr_id'] },
  { name: 'mr_approval_values', pk: ['approval_id'] },
];

// ---------------------------------------------------------------------------
// RPC payloads (supabase.rpc(name, { p: payload }))
// ---------------------------------------------------------------------------

interface Op { op_id: string }
type ElementSplit = { id: string; element_id: string; qty: number };

/** save_mr extended: request_type on insert (immutable after the first submit). PR numbers must contain "-PR-". */
export interface SaveMrFlowPayload extends Op {
  id: string; project_id: string; number: string; request_type?: RequestType;
  /** Required for site_use; optional for purchase. */
  block_id?: string | null; priority: MrPriority; required_date: string;
  delivery_location?: string; store_id?: string; drawing_ref?: string; purpose?: string; is_lookahead?: boolean;
  lookahead_plan_id?: string; device_created_at?: string; submit: boolean;
  lines: { id: string; material_spec_id: string; qty: number; required_date?: string; remarks?: string; over_boq_reason?: string;
           lookahead_item_id?: string;
           /** Required for site_use; optional for purchase (unless project_settings.pr_requires_elements). */
           elements: ElementSplit[] }[];
}

export type MrFlowAction = 'review' | 'approve' | 'reject' | 'return' | 'cancel' | 'close' | 'accept' | 'convert_shortfall';
export interface MrActionFlowPayload extends Op {
  mr_id: string; action: MrFlowAction;
  /** Required for reject, return, PR short-close and cancel after management approval. */
  comment?: string;
  /** review: reviewed_qty (≤ qty); approve: approved_qty (≤ reviewed_qty ?? qty; 0 removes the line);
   *  convert_shortfall: qty to purchase (+ optional client pr_line_id). */
  lines?: { id: string; reviewed_qty?: number; approved_qty?: number; qty?: number; pr_line_id?: string }[];
  /** site-use approve: store order date / store. */
  issue_by?: string; store_id?: string;
  /** purchase accept: assign to another procurement user. */
  assign_to?: string;
  /** convert_shortfall: client-generated PR id / number (defaults derived from the SUR number). */
  pr_id?: string; pr_number?: string;
}
export interface MrActionFlowResult {
  ok: true; id: string; status: FlowMrStatus;
  /** review / approve on site-use requests. */
  stock?: StockCheckLine[];
  /** purchase approve above the approver's limit: status unchanged, routed to a covering approver. */
  endorsed?: boolean;
  /** convert_shortfall */
  pr_id?: string; pr_number?: string; pr_lines?: { sur_line_id: string; pr_line_id: string; qty: number }[];
}

export interface CreateRfqFromPrsPayload extends Op {
  id: string; number: string; mr_line_ids: string[]; supplier_ids: string[]; title?: string; required_by?: string;
  delivery_store_id?: string; min_quotes?: number; notes?: string; sent_via?: string;
  /** default true */
  send?: boolean;
}
export interface CreateRfqFromPrsResult { ok: true; id: string; status: string; lines: { mr_line_id: string; rfq_line_id: string; qty: number }[] }

export interface RecordDirectPurchasePayload extends Op {
  po_id: string; number: string; supplier_id: string; reason: string; receipt_ref?: string; delivery_store_id?: string;
  order_date?: string; expected_date?: string; payment_terms?: string;
  /** Total incl. VAT must be ≤ project_settings.direct_purchase_limit. */
  lines: { id?: string; mr_line_id: string; qty?: number; unit_price: number; material_spec_id?: string; vat_applicable?: boolean }[];
}
export interface NotifyStoreDeliveryPayload extends Op {
  id: string; po_id: string; expected_date: string; expected_window?: string; vehicle_plate?: string;
  driver_name?: string; driver_phone?: string; note?: string;
  /** Defaults to every outstanding PO line. */
  lines?: { po_line_id: string; qty: number }[];
}
export interface AcknowledgeDeliveryNoticePayload extends Op {
  id: string; decision: 'accept' | 'reschedule'; note?: string;
  /** Required for reschedule. */
  proposed_date?: string;
}
export interface SaveApprovalDelegationPayload extends Op {
  id: string; to_user?: string; from_user?: string; project_id?: string | null; doc_type?: ApprovalDocType;
  valid_from?: string; valid_to?: string; reason?: string; revoke?: boolean;
}
/** post_grn extended: optional delivery_notice_id (else the PO's earliest open notice is closed). */
export interface PostGrnFlowFields { delivery_notice_id?: string }

export interface RpcMapFlows {
  save_mr: SaveMrFlowPayload;
  mr_action: MrActionFlowPayload;
  create_rfq_from_prs: CreateRfqFromPrsPayload;
  record_direct_purchase: RecordDirectPurchasePayload;
  notify_store_delivery: NotifyStoreDeliveryPayload;
  acknowledge_delivery_notice: AcknowledgeDeliveryNoticePayload;
  save_approval_delegation: SaveApprovalDelegationPayload;
}
export type RpcNameFlows = keyof RpcMapFlows;

// Views: v_stock_available_to_issue, v_mr_workflow (supersedes v_request_ageing), v_pr_tracker — no prices.
// Server job: public.escalate_pending_requests() (pg_cron, hourly) — SLA per type × status, delivery overdue,
// unacknowledged issues, auto-close of received site-use requests.
