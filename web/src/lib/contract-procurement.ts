// Procurement & cost contract (features P1 #1–#5) — mirrors
// supabase/migrations/20261029000005_procurement.sql.
//
// Price access: money lives only in the price-restricted tables listed in
// PRICE_TABLES_PROCUREMENT (RLS: app.can_see_prices() = app_settings.price_roles
// or admin). Apps sync SYNC_TABLES_PROCUREMENT for everyone (quantities only, so
// store keepers can receive against POs offline) and fetch price tables / price
// views only when can(role, 'prices.view').

import type { AppRole, InspectionResult, MrPriority, PostGrnPayload, SyncTable } from './contract';

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export type RfqStatus = 'draft' | 'sent' | 'closed' | 'awarded' | 'cancelled';
export type QuotationStatus = 'received' | 'withdrawn' | 'awarded' | 'not_awarded';
export type PoStatus =
  | 'draft' | 'submitted' | 'approved' | 'rejected' | 'sent'
  | 'partially_received' | 'received' | 'closed' | 'cancelled';
export type DeliveryStatus = 'pending' | 'confirmed' | 'dispatched' | 'delayed' | 'delivered';
export type RfqSentVia = 'telegram' | 'whatsapp' | 'email' | 'sms' | 'in_person' | 'phone';
export type PriceSource = 'quotation' | 'po' | 'grn' | 'market';

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  draft: 'Draft', submitted: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected', sent: 'Sent to supplier',
  partially_received: 'Partially received', received: 'Received', closed: 'Closed', cancelled: 'Cancelled',
};
export const RFQ_STATUS_LABELS: Record<RfqStatus, string> = {
  draft: 'Draft', sent: 'Sent', closed: 'Closed for quotes', awarded: 'Awarded', cancelled: 'Cancelled',
};
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: 'Pending', confirmed: 'Confirmed', dispatched: 'Dispatched', delayed: 'Delayed', delivered: 'Delivered',
};

// MR statuses used by procurement (already in MrStatus): approved → sourced (on a sent
// RFQ or draft/submitted/approved PO) → ordered (PO sent). Issues are allowed from
// sourced/ordered and move the MR to partially_issued / issued.

// ---------------------------------------------------------------------------
// Permissions (UI gating; the database enforces the same rules)
// ---------------------------------------------------------------------------

export type ProcurementAction =
  | 'rfq.create' | 'quotation.record' | 'rfq.award'
  | 'po.create' | 'po.approve' | 'po.send' | 'po.delivery' | 'po.receive'
  | 'price.log' | 'budget.edit' | 'reorder.createMr';

const MGMT: AppRole[] = ['coordinator', 'manager', 'admin'];
const PROC_PERMS: Record<ProcurementAction, AppRole[]> = {
  'rfq.create': ['procurement', ...MGMT],
  'quotation.record': ['procurement', ...MGMT],   // + price access
  'rfq.award': MGMT,                              // + price access
  'po.create': ['procurement', ...MGMT],          // + price access
  'po.approve': MGMT,                             // + approval_limits on PO total incl. VAT
  'po.send': ['procurement', ...MGMT],
  'po.delivery': ['procurement', ...MGMT],
  'po.receive': ['store_keeper', ...MGMT],        // post_grn with po_line_id
  'price.log': ['procurement', ...MGMT],          // + price access
  'budget.edit': MGMT,                            // + price access
  'reorder.createMr': ['store_keeper', 'procurement', 'office_engineer', ...MGMT],
};
export const canProcure = (role: AppRole | null | undefined, action: ProcurementAction) =>
  !!role && PROC_PERMS[action].includes(role);

// ---------------------------------------------------------------------------
// Document numbers: <PROJECT>-<TYPE>-<DEVICE>-<SEQ>
// ---------------------------------------------------------------------------

export type ProcurementDocType = 'RFQ' | 'QT' | 'PO';
export const procurementDocNumber = (projectCode: string, type: ProcurementDocType, devicePrefix: string, seq: number) =>
  `${projectCode}-${type}-${devicePrefix}-${String(seq).padStart(4, '0')}`;

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Quantity/document tables — readable by all project members. */
export const SYNC_TABLES_PROCUREMENT: SyncTable[] = [
  { name: 'rfqs', pk: ['id'] },
  { name: 'rfq_lines', pk: ['id'] },
  { name: 'rfq_suppliers', pk: ['id'] },
  { name: 'quotations', pk: ['id'] },
  { name: 'quotation_lines', pk: ['id'] },
  { name: 'rfq_awards', pk: ['id'] },
  { name: 'purchase_orders', pk: ['id'] },
  { name: 'po_lines', pk: ['id'] },
  { name: 'po_events', pk: ['id'] },
  { name: 'po_delivery_updates', pk: ['id'] },
];

/** Price-restricted — fetch only when the user can see prices (empty otherwise). */
export const PRICE_TABLES_PROCUREMENT: SyncTable[] = [
  { name: 'quotation_line_prices', pk: ['quotation_line_id'] },
  { name: 'po_line_prices', pk: ['po_line_id'] },
  { name: 'po_totals', pk: ['po_id'] },
  { name: 'price_observations', pk: ['id'] },
  { name: 'budget_lines', pk: ['id'] },
  // po_revisions (snapshots incl. prices) and tax_settings are web/online only.
];

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface SupplierProcurementFields { tin: string | null; vat_registered: boolean; payment_terms: string | null }
export interface MaterialSpecReorderFields { pack_size: number; safety_days: number }
export interface ProjectSettingsProcurementFields { min_quotes: number; price_spike_pct: number; over_receipt_pct: number }

export interface TaxSettings {
  id: string; effective_from: string; vat_rate: number; wht_goods_rate: number; wht_goods_threshold: number; wht_no_tin_rate: number;
}

export interface Rfq {
  id: string; project_id: string; number: string; title: string; status: RfqStatus; required_by: string | null;
  delivery_store_id: string | null; min_quotes: number; notes: string | null; min_quotes_override_reason: string | null;
  created_by: string; sent_at: string | null; closed_at: string | null; awarded_by: string | null; awarded_at: string | null;
  created_at: string; updated_at: string;
}
export interface RfqLine {
  id: string; rfq_id: string; project_id: string; line_no: number; material_spec_id: string; qty: number;
  mr_line_id: string | null; required_date: string | null; remarks: string | null; deleted_at: string | null;
}
export interface RfqSupplier { id: string; rfq_id: string; project_id: string; supplier_id: string; sent_via: RfqSentVia | null; sent_at: string | null; deleted_at: string | null }
export interface Quotation {
  id: string; rfq_id: string; project_id: string; supplier_id: string; number: string; quote_ref: string | null; quote_date: string;
  valid_until: string | null; prices_include_vat: boolean; delivery_days: number | null; payment_terms: string | null;
  transport_included: boolean | null; status: QuotationStatus; created_by: string; created_at: string;
}
export interface QuotationLine {
  id: string; quotation_id: string; project_id: string; rfq_line_id: string; offered_spec_id: string; qty: number;
  available: boolean; remarks: string | null;
}
/** Price-restricted. unit_price as quoted (incl. VAT when quotation.prices_include_vat); transport_cost = line total. */
export interface QuotationLinePrice { quotation_line_id: string; project_id: string; unit_price: number; currency: string; transport_cost: number }
export interface RfqAward {
  id: string; rfq_id: string; project_id: string; rfq_line_id: string; quotation_line_id: string; supplier_id: string;
  qty: number; is_lowest: boolean; reason: string | null; awarded_by: string; awarded_at: string;
}

export interface PurchaseOrder {
  id: string; project_id: string; number: string; supplier_id: string; rfq_id: string | null; delivery_store_id: string;
  status: PoStatus; revision: number; order_date: string; expected_date: string | null; eta: string | null;
  delivery_status: DeliveryStatus; payment_terms: string | null; advance_pct: number | null; delivery_terms: string | null;
  remarks: string | null; created_by: string; submitted_at: string | null; approved_by: string | null; approved_at: string | null;
  sent_at: string | null; closed_at: string | null; cancelled_at: string | null; status_reason: string | null;
  created_at: string; updated_at: string;
}
/** No prices — store keepers receive against these. Outstanding = qty − qty_accepted (unless closed). */
export interface PoLine {
  id: string; po_id: string; project_id: string; line_no: number; material_spec_id: string; qty: number; uom: string | null;
  mr_line_id: string | null; quotation_line_id: string | null; expected_date: string | null;
  qty_received: number; qty_accepted: number; qty_rejected: number; closed: boolean; remarks: string | null; deleted_at: string | null;
}
/** Price-restricted. unit_price is ex-VAT per base uom. */
export interface PoLinePrice { po_line_id: string; project_id: string; unit_price: number; vat_applicable: boolean; currency: string }
/** Price-restricted; computed server-side from tax_settings + supplier TIN. */
export interface PoTotals {
  po_id: string; project_id: string; tax_settings_id: string | null; subtotal: number; vat_rate: number; vat: number;
  total: number; withholding_rate: number; withholding: number; net_payable: number; currency: string;
}
export interface PoEvent { id: string; po_id: string; project_id: string; action: string; from_status: PoStatus | null; to_status: PoStatus | null; comment: string | null; actor: string | null; created_at: string }
export interface PoDeliveryUpdate { id: string; po_id: string; project_id: string; status: DeliveryStatus; eta: string | null; note: string | null; created_by: string; created_at: string }
export interface PoRevision { id: string; po_id: string; project_id: string; revision: number; snapshot: unknown; reason: string; created_by: string; created_at: string }

/** Price-restricted. unit_price ex-VAT; avg_90d = company-wide average of the prior 90 days. */
export interface PriceObservation {
  id: string; project_id: string; material_spec_id: string; supplier_id: string | null; unit_price: number; currency: string;
  observed_on: string; source: PriceSource; source_id: string | null; location: string | null; note: string | null;
  avg_90d: number | null; is_spike: boolean; created_at: string;
}
/** Price-restricted. Scope: boq_item (optionally + spec) > material spec > category. */
export interface BudgetLine {
  id: string; project_id: string; boq_item_id: string | null; material_spec_id: string | null; category: string | null;
  description: string | null; budget_qty: number | null; budget_rate: number | null; budget_amount: number; deleted_at: string | null;
}

/** grns.po_id and grn_lines.po_line_id added by 0005. */
export interface GrnProcurementFields { po_id: string | null }
export interface GrnLineProcurementFields { po_line_id: string | null }

// ---------------------------------------------------------------------------
// View rows
// ---------------------------------------------------------------------------

export interface PoLineStatusRow {
  po_line_id: string; po_id: string; po_number: string; project_id: string; supplier_id: string; supplier_name: string;
  delivery_store_id: string; po_status: PoStatus; delivery_status: DeliveryStatus; line_no: number; material_spec_id: string;
  label: string; uom: string; mr_line_id: string | null; ordered_qty: number; qty_received: number; qty_accepted: number;
  qty_rejected: number; outstanding_qty: number; expected_date: string | null; is_delayed: boolean;
}
/** v_expected_deliveries = open PO lines with outstanding_qty > 0 (same columns). */
export type ExpectedDeliveryRow = PoLineStatusRow;
export interface PoStatusRow {
  id: string; project_id: string; number: string; supplier_id: string; supplier_name: string; delivery_store_id: string;
  status: PoStatus; revision: number; order_date: string; expected_date: string | null; eta: string | null;
  delivery_status: DeliveryStatus; sent_at: string | null; approved_at: string | null; lines: number; received_pct: number;
  is_delayed: boolean; days_late: number | null;
}
export interface QuotationComparisonRow {
  rfq_id: string; project_id: string; rfq_line_id: string; line_no: number; material_spec_id: string; label: string; uom: string;
  rfq_qty: number; quotation_id: string; quotation_number: string; supplier_id: string; supplier_name: string; rating: number | null;
  quote_date: string; valid_until: string | null; delivery_days: number | null; payment_terms: string | null; prices_include_vat: boolean;
  quotation_status: QuotationStatus; quotation_line_id: string; offered_spec_id: string; offered_qty: number; available: boolean;
  quoted_unit_price: number; transport_cost: number; unit_price_ex_vat: number; landed_unit_cost: number; landed_total: number;
  price_rank: number; is_lowest: boolean; is_awarded: boolean; last_po_price: number | null;
}
export interface PriceTrendRow {
  material_spec_id: string; week: string; observations: number; min_price: number; avg_price: number; median_price: number;
  max_price: number; has_spike: boolean; label: string; category: string; uom: string; avg_90d: number | null;
  latest_price: number; latest_on: string; week_vs_90d_pct: number | null; latest_vs_90d_pct: number | null;
}
export interface CommittedCostRow {
  project_id: string; po_id: string; po_number: string; supplier_name: string; po_line_id: string; material_spec_id: string;
  label: string; category: string; mr_line_id: string | null; boq_item_id: string | null; outstanding_qty: number;
  unit_price: number; committed_value: number;
}
/** Ex-VAT. remaining = budget − committed (open PO) − received. */
export interface CostControlRow {
  budget_line_id: string; project_id: string; scope: 'boq_item' | 'material' | 'category'; boq_item_id: string | null;
  boq_item_no: string | null; material_spec_id: string | null; label: string | null; category: string | null; description: string | null;
  budget_qty: number | null; budget_rate: number | null; budget_amount: number; committed: number; received: number; issued: number;
  /** budget − used (materials are cost when used, 20261103000020). */
  remaining: number; pct_used: number | null;
  /** = issued: actual cost (consumption at average cost). */
  used: number;
  /** budget − max(received, used) − committed: still free to buy. */
  remaining_uncommitted: number;
}
export interface ReorderSuggestionRow {
  project_id: string; store_id: string; store_name: string; material_spec_id: string; label: string; category: string; uom: string;
  available: number; reorder_level: number; min_level: number; lead_time_days: number; safety_days: number; pack_size: number;
  avg_daily_issue_30d: number; days_cover: number | null; stockout_date: string | null; pending_mr_qty: number; open_po_qty: number;
  next_eta: string | null; suggested_qty: number; stockout_before_lead_time: boolean;
}
export interface MrLineProcurementRow {
  mr_line_id: string; mr_id: string; project_id: string; material_spec_id: string; approved_qty: number | null;
  ordered_qty: number; received_qty: number; on_rfq: boolean;
}

// ---------------------------------------------------------------------------
// RPC payloads — supabase.rpc(name, { p: payload })
// ---------------------------------------------------------------------------

interface Op { op_id: string }

export interface SaveRfqPayload extends Op {
  id: string; project_id: string; number: string; title: string; required_by?: string; delivery_store_id?: string;
  min_quotes?: number; notes?: string; send?: boolean;
  lines: { id: string; material_spec_id: string; qty: number; mr_line_id?: string; required_date?: string; remarks?: string }[];
  suppliers: { id: string; supplier_id: string; sent_via?: RfqSentVia }[];
}
export interface RfqActionPayload extends Op { rfq_id: string; action: 'send' | 'close' | 'cancel'; comment?: string }
export interface RecordQuotationPayload extends Op {
  id: string; rfq_id: string; supplier_id: string; number: string; quote_ref?: string; quote_date: string; valid_until?: string;
  prices_include_vat?: boolean; delivery_days?: number; payment_terms?: string; transport_included?: boolean;
  /** Proforma photos already uploaded via the attachment outbox (kind 'photo' | 'document'); relinked to the quotation. */
  attachment_ids?: string[];
  lines: { id: string; rfq_line_id: string; offered_spec_id?: string; qty?: number; unit_price?: number; transport_cost?: number;
           available?: boolean; remarks?: string }[];
}
export interface AwardRfqPayload extends Op {
  rfq_id: string;
  /** Required when fewer than rfqs.min_quotes quotations were received. */
  override_reason?: string;
  /** reason required when the quotation line is not the lowest landed cost. */
  awards: { id: string; rfq_line_id: string; quotation_line_id: string; qty?: number; reason?: string }[];
  create_po?: boolean;
  /** One entry per awarded supplier when create_po (client-generated id + number). */
  pos?: { id: string; number: string; supplier_id: string; order_date?: string; expected_date?: string }[];
}
export interface PoLineInput {
  id: string; material_spec_id: string; qty: number; uom?: string; mr_line_id?: string; quotation_line_id?: string;
  expected_date?: string; remarks?: string;
  /** Ex-VAT. Defaults to the quotation line price (VAT removed) when quotation_line_id is given. */
  unit_price?: number; vat_applicable?: boolean;
}
export interface SavePoPayload extends Op {
  id: string; project_id: string; number: string; supplier_id: string; rfq_id?: string; delivery_store_id: string;
  order_date?: string; expected_date?: string; payment_terms?: string; advance_pct?: number; delivery_terms?: string;
  remarks?: string; submit?: boolean; lines: PoLineInput[];
}
export interface PoActionPayload extends Op {
  po_id: string; action: 'submit' | 'approve' | 'reject' | 'send' | 'cancel' | 'close';
  /** Required for reject, cancel (non-draft) and short-close. */
  comment?: string;
}
export interface AmendPoPayload extends Op {
  po_id: string; reason: string; expected_date?: string; payment_terms?: string; delivery_terms?: string; remarks?: string;
  /** Full line list (omitted lines are removed; received lines cannot be removed or reduced below qty_accepted). */
  lines?: PoLineInput[];
}
export interface UpdatePoDeliveryPayload extends Op { id: string; po_id: string; status: DeliveryStatus; eta?: string; note?: string }
/** post_grn extended: optional header po_id and line po_line_id (old payloads unchanged). */
export interface PostGrnPoPayload extends Omit<PostGrnPayload, 'lines'> {
  po_id?: string;
  lines: (PostGrnPayload['lines'][number] & { po_line_id?: string })[];
}
export interface LogMarketPricePayload extends Op {
  id: string; project_id: string; material_spec_id: string; unit_price: number; observed_on?: string; prices_include_vat?: boolean;
  supplier_id?: string; location?: string; note?: string;
}
export interface SaveBudgetPayload extends Op {
  project_id: string;
  lines: { id: string; boq_item_id?: string; material_spec_id?: string; category?: string; description?: string;
           budget_qty?: number; budget_rate?: number; budget_amount?: number; deleted?: boolean }[];
}
export interface CreateMrFromSuggestionsPayload extends Op {
  id: string; project_id: string; number: string; store_id: string; block_id?: string; required_date?: string;
  priority?: MrPriority; submit?: boolean; device_created_at?: string;
  lines: { id: string; material_spec_id: string; qty: number; remarks?: string }[];
}

export interface RpcMapProcurement {
  save_rfq: SaveRfqPayload;
  rfq_action: RfqActionPayload;
  record_quotation: RecordQuotationPayload;
  award_rfq: AwardRfqPayload;
  save_po: SavePoPayload;
  po_action: PoActionPayload;
  amend_po: AmendPoPayload;
  update_po_delivery: UpdatePoDeliveryPayload;
  post_grn: PostGrnPoPayload;
  log_market_price: LogMarketPricePayload;
  save_budget: SaveBudgetPayload;
  create_mr_from_suggestions: CreateMrFromSuggestionsPayload;
}
export type RpcNameProcurement = keyof RpcMapProcurement;

// Views: v_po_line_status, v_expected_deliveries, v_po_status, v_mr_line_procurement (no prices);
//        v_quotation_comparison, v_price_trend, v_committed_cost, v_cost_control (price roles only);
//        v_reorder_suggestions (no prices).

export type { InspectionResult };
