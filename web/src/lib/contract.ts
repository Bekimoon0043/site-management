// Shared contract between the database (supabase/migrations), the mobile app
// and the web console. Copied into each app as src/lib/contract.ts — keep the
// copies identical (`npm run sync:contract` at the repo root).

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type AppRole =
  | 'store_keeper' | 'site_engineer' | 'office_engineer'
  | 'coordinator' | 'manager' | 'procurement' | 'admin' | 'security' | 'finance' | 'client';

export const ROLE_LABELS: Record<AppRole, string> = {
  store_keeper: 'Store Keeper',
  site_engineer: 'Site Engineer',
  office_engineer: 'Office Engineer',
  coordinator: 'Project Coordinator',
  manager: 'Manager',
  procurement: 'Procurement Officer',
  admin: 'System Administrator',
  security: 'Gate / Security',
  finance: 'Finance Officer',
  client: 'Client (Read Only)',
};

export type MrStatus =
  | 'draft' | 'submitted' | 'reviewed' | 'returned' | 'approved' | 'sourced' | 'ordered'
  | 'partially_issued' | 'issued' | 'closed' | 'rejected' | 'cancelled';

export const MR_STATUS_LABELS: Record<MrStatus, string> = {
  draft: 'Draft', submitted: 'Submitted', reviewed: 'Reviewed', returned: 'Returned for clarification',
  approved: 'Approved', sourced: 'Sourced', ordered: 'Ordered', partially_issued: 'Partially issued',
  issued: 'Fully issued', closed: 'Closed', rejected: 'Rejected', cancelled: 'Cancelled',
};

export type MrPriority = 'normal' | 'urgent' | 'critical';
export type StockStatus = 'available' | 'quarantine';
export type InspectionResult = 'pass' | 'conditional' | 'reject';
export type AdjustmentType = 'wastage' | 'damage' | 'loss' | 'write_off' | 'count_variance';
export type ElementType = 'footing' | 'column' | 'beam' | 'slab' | 'wall' | 'staircase' | string;

export const ELEMENT_TYPES = ['footing', 'column', 'beam', 'slab', 'wall', 'staircase'] as const;
export const WASTAGE_REASONS = ['Breakage', 'Spillage', 'Rust / corrosion', 'Expired / set', 'Theft / loss', 'Off-cuts', 'Other'];

// ---------------------------------------------------------------------------
// Permissions (SRS §3). UI gating only — the database enforces the same rules.
// ---------------------------------------------------------------------------

export type Action =
  | 'mr.create' | 'mr.review' | 'mr.approve' | 'mr.viewAll'
  | 'grn.post' | 'grn.confirm' | 'miv.post' | 'miv.acknowledge'
  | 'mrn.post' | 'adjustment.create' | 'adjustment.decide' | 'count.submit' | 'count.decide'
  | 'transfer.post' | 'reverse' | 'progress.report' | 'progress.verify'
  | 'master.edit' | 'prices.view' | 'users.manage' | 'audit.view';

const MGMT: AppRole[] = ['coordinator', 'manager', 'admin'];
const PERMS: Record<Action, AppRole[]> = {
  'mr.create': ['site_engineer', 'office_engineer', ...MGMT],
  'mr.review': ['office_engineer', ...MGMT],
  'mr.approve': MGMT,
  'mr.viewAll': [...MGMT, 'procurement', 'finance'],
  'grn.post': ['store_keeper', ...MGMT],
  'grn.confirm': ['site_engineer', 'office_engineer', ...MGMT],
  'miv.post': ['store_keeper', ...MGMT],
  'miv.acknowledge': ['site_engineer', 'office_engineer', ...MGMT],
  'mrn.post': ['store_keeper', ...MGMT],
  'adjustment.create': ['store_keeper', ...MGMT],
  'adjustment.decide': MGMT,
  'count.submit': ['store_keeper', ...MGMT],
  'count.decide': MGMT,
  'transfer.post': ['store_keeper', ...MGMT],
  'reverse': ['store_keeper', ...MGMT],
  'progress.report': ['site_engineer', 'office_engineer', ...MGMT],
  'progress.verify': ['office_engineer', ...MGMT],
  'master.edit': ['office_engineer', ...MGMT],
  'prices.view': [...MGMT, 'procurement', 'finance'], // default; app_settings.price_roles is authoritative
  'users.manage': ['admin', 'manager', 'coordinator'],
  'audit.view': MGMT,
};

export const can = (role: AppRole | null | undefined, action: Action) => !!role && PERMS[action].includes(role);

export type DashboardKind = 'store' | 'site' | 'office' | 'management';
export const dashboardFor = (role: AppRole): DashboardKind =>
  role === 'store_keeper' || role === 'security' ? 'store' // security has its own gate home (contract-control dashboardForControl)
  : role === 'site_engineer' ? 'site'
  : role === 'office_engineer' ? 'office'
  : 'management';

// ---------------------------------------------------------------------------
// Offline document numbers (FR-OF-06): <PROJECT>-<TYPE>-<DEVICE>-<SEQ>
// ---------------------------------------------------------------------------

export type DocType = 'MR' | 'GRN' | 'MIV' | 'MRN' | 'ADJ' | 'CNT' | 'TRF'
  | 'RFQ' | 'QT' | 'PO'                                  // procurement (contract-procurement.ts)
  | 'SD' | 'INS' | 'SNG' | 'POUR' | 'CUBE' | 'BBS'       // field & quality (contract-field.ts)
  | 'GP' | 'VEH';                                        // site control (contract-control.ts)
export const docNumber = (projectCode: string, type: DocType, devicePrefix: string, seq: number) =>
  `${projectCode}-${type}-${devicePrefix}-${String(seq).padStart(4, '0')}`;

// ---------------------------------------------------------------------------
// Sync: tables pulled incrementally by updated_at (RLS limits rows to the
// user's projects). Writes never go to these tables directly — they go
// through the RPCs below via the outbox.
// ---------------------------------------------------------------------------

export interface SyncTable { name: string; pk: string[] }

export const SYNC_TABLES: SyncTable[] = [
  { name: 'profiles', pk: ['id'] },
  { name: 'app_settings', pk: ['id'] },
  { name: 'projects', pk: ['id'] },
  { name: 'project_settings', pk: ['project_id'] },
  { name: 'project_members', pk: ['project_id', 'user_id'] },
  { name: 'blocks', pk: ['id'] },
  { name: 'levels', pk: ['id'] },
  { name: 'zones', pk: ['id'] },
  { name: 'stores', pk: ['id'] },
  { name: 'activity_templates', pk: ['id'] },
  { name: 'elements', pk: ['id'] },
  { name: 'element_activities', pk: ['id'] },
  { name: 'materials', pk: ['id'] },
  { name: 'material_specs', pk: ['id'] },
  { name: 'spec_conversions', pk: ['id'] },
  { name: 'spec_prices', pk: ['material_spec_id'] },
  { name: 'suppliers', pk: ['id'] },
  { name: 'boq_items', pk: ['id'] },
  { name: 'element_takeoffs', pk: ['id'] },
  { name: 'material_requests', pk: ['id'] },
  { name: 'mr_lines', pk: ['id'] },
  { name: 'mr_line_elements', pk: ['id'] },
  { name: 'mr_events', pk: ['id'] },
  { name: 'grns', pk: ['id'] },
  { name: 'grn_lines', pk: ['id'] },
  { name: 'mivs', pk: ['id'] },
  { name: 'miv_lines', pk: ['id'] },
  { name: 'mrns', pk: ['id'] },
  { name: 'mrn_lines', pk: ['id'] },
  { name: 'transfers', pk: ['id'] },
  { name: 'transfer_lines', pk: ['id'] },
  { name: 'stock_counts', pk: ['id'] },
  { name: 'stock_count_lines', pk: ['id'] },
  { name: 'adjustments', pk: ['id'] },
  { name: 'adjustment_lines', pk: ['id'] },
  { name: 'stock_ledger', pk: ['id'] },
  { name: 'progress_updates', pk: ['id'] },
  { name: 'attachments', pk: ['id'] },
  { name: 'notifications', pk: ['id'] },
];

// Rows with deleted_at set are soft-deleted and must be hidden by clients.

// ---------------------------------------------------------------------------
// Row types (subset of columns the apps use; see migrations for full schema)
// ---------------------------------------------------------------------------

export interface Profile { id: string; full_name: string; email: string | null; phone: string | null; role: AppRole; is_active: boolean }
export interface Project { id: string; code: string; name: string; location: string | null; client: string | null; start_date: string | null; end_date: string | null; currency: string; is_active: boolean }
export interface ProjectSettings { project_id: string; require_review: boolean; enforce_hold_points: boolean; escalation_hours: number; variance_thresholds: Record<string, number> }
export interface Block { id: string; project_id: string; code: string; name: string; deleted_at: string | null }
export interface Level { id: string; project_id: string; block_id: string; code: string; name: string; sort_order: number; deleted_at: string | null }
export interface Zone { id: string; project_id: string; level_id: string | null; name: string; deleted_at: string | null }
export interface Store { id: string; project_id: string; name: string; store_type: 'main' | 'satellite' | 'yard' | 'batching'; deleted_at: string | null }
export interface Element {
  id: string; project_id: string; block_id: string | null; level_id: string | null; zone_id: string | null;
  code: string; element_type: ElementType; grid: string | null; drawing_ref: string | null; dimensions: string | null;
  planned_start: string | null; planned_finish: string | null; actual_start: string | null; actual_finish: string | null;
  progress_pct: number; status: 'not_started' | 'in_progress' | 'completed'; deleted_at: string | null;
}
export interface ElementActivity { id: string; project_id: string; element_id: string; seq: number; name: string; weight: number; is_hold_point: boolean; reported_pct: number; verified_pct: number }
export interface Material { id: string; category: string; name: string; standard_ref: string | null; deleted_at: string | null }
export interface MaterialSpec {
  id: string; material_id: string; grade: string; description: string | null; uom: string; wastage_pct: number;
  min_level: number; reorder_level: number; lead_time_days: number; track_batches: boolean; is_active: boolean; deleted_at: string | null;
  /** 20261105000053: days a received lot stays usable; null = no expiry. */
  shelf_life_days?: number | null;
}
export interface SpecConversion { id: string; material_spec_id: string; alt_uom: string; factor: number; deleted_at: string | null }
export interface SpecPrice { material_spec_id: string; unit_price: number; currency: string }
export interface Supplier { id: string; name: string; contact_person: string | null; phone: string | null; email: string | null; address: string | null; categories: string[]; rating: number | null; deleted_at: string | null }
export interface BoqItem { id: string; project_id: string; item_no: string; description: string; unit: string; quantity: number; deleted_at: string | null }
export interface ElementTakeoff { id: string; project_id: string; element_id: string; material_spec_id: string; boq_item_id: string | null; planned_qty: number; deleted_at: string | null }

export interface MaterialRequest {
  id: string; project_id: string; number: string; block_id: string | null; requested_by: string; requester_role: AppRole;
  status: MrStatus; priority: MrPriority; required_date: string; delivery_location: string | null; store_id: string | null;
  drawing_ref: string | null; purpose: string | null; is_lookahead: boolean; version: number;
  submitted_at: string | null; reviewed_by: string | null; reviewed_at: string | null; approved_by: string | null; approved_at: string | null;
  created_at: string; updated_at: string;
}
export interface MrLine {
  id: string; mr_id: string; project_id: string; line_no: number; material_spec_id: string; qty: number; approved_qty: number | null;
  required_date: string | null; remarks: string | null; boq_item_id: string | null; exceeds_boq: boolean; over_boq_reason: string | null; deleted_at: string | null;
}
export interface MrLineElement { id: string; mr_line_id: string; project_id: string; element_id: string; qty: number; deleted_at: string | null }
export interface MrEvent { id: string; mr_id: string; action: string; from_status: MrStatus | null; to_status: MrStatus | null; comment: string | null; actor: string | null; created_at: string }

export interface Grn {
  id: string; project_id: string; number: string; store_id: string; supplier_id: string | null; supplier_name: string | null;
  delivery_note_no: string | null; vehicle_plate: string | null; driver_name: string | null; received_at: string; remarks: string | null;
  supplier_signature: string | null; status: 'posted' | 'reversed'; confirmed_by: string | null; created_by: string; created_at: string;
}
export interface GrnLine {
  id: string; grn_id: string; line_no: number; material_spec_id: string; mr_line_id: string | null; ordered_qty: number | null;
  qty_delivered: number; qty_accepted: number; qty_rejected: number; batch_no: string | null;
  inspection_result: InspectionResult; inspection_notes: string | null; variance_flag: 'shortage' | 'excess' | 'wrong_grade' | null;
}
export interface Miv {
  id: string; project_id: string; number: string; store_id: string; mr_id: string | null; issued_to: string; issued_by: string;
  issued_at: string; status: 'pending_ack' | 'acknowledged' | 'reversed'; acknowledged_at: string | null;
  receiver_signature: string | null; is_emergency: boolean; emergency_reason: string | null; regularised_at: string | null; remarks: string | null;
}
export interface MivLine { id: string; miv_id: string; line_no: number; mr_line_id: string | null; material_spec_id: string; element_id: string; qty: number; substitution_reason: string | null }
export interface Mrn { id: string; project_id: string; number: string; store_id: string; miv_id: string | null; returned_by: string | null; received_by: string; returned_at: string; status: 'posted' | 'reversed' }
export interface MrnLine { id: string; mrn_id: string; material_spec_id: string; element_id: string | null; qty: number; condition: 'good' | 'damaged' }
export interface Adjustment { id: string; project_id: string; number: string; store_id: string; adj_type: AdjustmentType; reason_code: string | null; remarks: string | null; status: 'pending' | 'approved' | 'rejected'; requested_by: string; created_at: string }
export interface AdjustmentLine { id: string; adjustment_id: string; material_spec_id: string; element_id: string | null; stock_status: StockStatus; qty_delta: number }
export interface StockCount { id: string; project_id: string; number: string; store_id: string; count_type: 'periodic' | 'spot'; counted_by: string; counted_at: string; status: 'submitted' | 'approved' | 'rejected' }
export interface StockCountLine { id: string; count_id: string; material_spec_id: string; system_qty: number; counted_qty: number; variance: number }
export interface Transfer { id: string; project_id: string; number: string; from_store_id: string; to_project_id: string; to_store_id: string; status: 'in_transit' | 'received'; sent_at: string; received_at: string | null }
export interface TransferLine { id: string; transfer_id: string; material_spec_id: string; qty: number; qty_received: number | null }
export interface StockLedgerEntry {
  id: string; project_id: string; store_id: string; material_spec_id: string; qty: number; stock_status: StockStatus;
  txn_type: 'opening' | 'grn' | 'miv' | 'mrn' | 'transfer_out' | 'transfer_in' | 'adjustment' | 'reversal';
  doc_type: string; doc_id: string; doc_number: string; element_id: string | null; mr_line_id: string | null; txn_at: string; created_at: string;
}
export interface ProgressUpdate {
  id: string; project_id: string; element_id: string; element_activity_id: string; report_date: string; pct_complete: number;
  qty_achieved: number | null; uom: string | null; remarks: string | null; status: 'reported' | 'verified' | 'adjusted' | 'rejected';
  reported_by: string; verified_by: string | null; verified_pct: number | null; verify_comment: string | null; created_at: string;
}
export interface Attachment { id: string; project_id: string; entity_type: string; entity_id: string; kind: 'photo' | 'delivery_note' | 'signature' | 'document'; storage_path: string; mime_type: string | null; latitude: number | null; longitude: number | null; created_by: string; created_at: string }
export interface AppNotification { id: string; user_id: string; project_id: string | null; title: string; body: string | null; entity_type: string | null; entity_id: string | null; is_critical: boolean; read_at: string | null; created_at: string }

// ---------------------------------------------------------------------------
// RPC payloads. Every call is supabase.rpc(name, { p: payload }).
// op_id makes retries idempotent — generate one per user action and keep it
// in the outbox entry.
// ---------------------------------------------------------------------------

interface Op { op_id: string }

export interface SaveMrPayload extends Op {
  id: string; project_id: string; number: string; block_id: string; priority: MrPriority; required_date: string;
  delivery_location?: string; store_id?: string; drawing_ref?: string; purpose?: string; is_lookahead?: boolean;
  device_created_at?: string; submit: boolean;
  lines: { id: string; material_spec_id: string; qty: number; required_date?: string; remarks?: string; over_boq_reason?: string;
           elements: { id: string; element_id: string; qty: number }[] }[];
}
export interface MrActionPayload extends Op {
  mr_id: string; action: 'review' | 'approve' | 'reject' | 'return' | 'cancel' | 'close'; comment?: string;
  lines?: { id: string; approved_qty: number }[];
}
export interface PostGrnPayload extends Op {
  id: string; project_id: string; number: string; store_id: string; supplier_id?: string; supplier_name?: string;
  delivery_note_no?: string; vehicle_plate?: string; driver_name?: string; received_at: string; remarks?: string; supplier_signature?: string;
  lines: { id: string; material_spec_id: string; mr_line_id?: string; ordered_qty?: number; qty_delivered: number; qty_accepted?: number;
           qty_rejected?: number; entered_uom?: string; entered_qty?: number; batch_no?: string; inspection_result?: InspectionResult; inspection_notes?: string }[];
}
export interface PostMivPayload extends Op {
  id: string; project_id: string; number: string; store_id: string; mr_id?: string | null; issued_to: string; issued_at: string;
  is_emergency?: boolean; emergency_reason?: string; remarks?: string; receiver_signature?: string;
  lines: { id: string; mr_line_id?: string; material_spec_id: string; element_id: string; qty: number; batch_no?: string; substitution_reason?: string }[];
}
export interface AcknowledgeMivPayload extends Op { miv_id: string; signature?: string }
export interface RegulariseMivPayload extends Op { miv_id: string; mr_id: string }
export interface PostMrnPayload extends Op {
  id: string; project_id: string; number: string; store_id: string; miv_id?: string; returned_by?: string; returned_at: string; remarks?: string;
  lines: { id: string; material_spec_id: string; element_id?: string; mr_line_id?: string; qty: number; condition: 'good' | 'damaged' }[];
}
export interface CreateAdjustmentPayload extends Op {
  id: string; project_id: string; number: string; store_id: string; adj_type: Exclude<AdjustmentType, 'count_variance'>; reason_code: string; remarks?: string;
  lines: { id: string; material_spec_id: string; element_id?: string; stock_status?: StockStatus; qty: number }[];
}
export interface DecideAdjustmentPayload extends Op { adjustment_id: string; approve: boolean; comment?: string }
export interface SubmitStockCountPayload extends Op {
  id: string; project_id: string; number: string; store_id: string; count_type: 'periodic' | 'spot'; counted_at: string; remarks?: string;
  lines: { id: string; material_spec_id: string; counted_qty: number }[];
}
export interface DecideStockCountPayload extends Op { count_id: string; approve: boolean; comment?: string }
export interface SendTransferPayload extends Op {
  id: string; project_id: string; number: string; from_store_id: string; to_store_id: string; sent_at: string; remarks?: string;
  lines: { id: string; material_spec_id: string; qty: number }[];
}
export interface ReceiveTransferPayload extends Op { transfer_id: string; received_at: string; lines?: { id: string; qty_received: number }[] }
export interface ReverseDocumentPayload extends Op { doc_type: 'grn' | 'miv' | 'mrn'; doc_id: string; reason: string }
export interface ReportProgressPayload extends Op {
  id: string; element_activity_id: string; report_date: string; pct_complete: number; qty_achieved?: number; uom?: string; remarks?: string;
}
export interface VerifyProgressPayload extends Op { progress_id: string; approve: boolean; verified_pct?: number; comment?: string }
export interface OpeningBalancePayload extends Op { project_id: string; store_id: string; lines: { material_spec_id: string; qty: number }[] }

export interface RpcMap {
  register_device: { device_id: string; name?: string };
  save_mr: SaveMrPayload;
  mr_action: MrActionPayload;
  post_grn: PostGrnPayload;
  confirm_grn: { grn_id: string };
  post_miv: PostMivPayload;
  acknowledge_miv: AcknowledgeMivPayload;
  regularise_miv: RegulariseMivPayload;
  post_mrn: PostMrnPayload;
  create_adjustment: CreateAdjustmentPayload;
  decide_adjustment: DecideAdjustmentPayload;
  submit_stock_count: SubmitStockCountPayload;
  decide_stock_count: DecideStockCountPayload;
  send_transfer: SendTransferPayload;
  receive_transfer: ReceiveTransferPayload;
  reverse_document: ReverseDocumentPayload;
  report_progress: ReportProgressPayload;
  verify_progress: VerifyProgressPayload;
  post_opening_balance: OpeningBalancePayload;
  mark_notifications_read: { ids?: string[] };
}
export type RpcName = keyof RpcMap;

// Reporting views (web console + online mobile reports):
//   v_specs, v_stock_balance, v_bin_card, v_mr_line_status, v_element_consumption,
//   v_request_ageing, v_progress_rollup, v_element_cost, v_overdue_emergency_issues
