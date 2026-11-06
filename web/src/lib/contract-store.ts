// Contract for the materials roles additions (migrations 20261105000050–53): tools & small equipment register,
// supplier performance scorecard, shelf life / FIFO stock ageing. Copy next to contract.ts in each app (npm run sync:contract).

export interface Op { op_id?: string }

// ---- tools register --------------------------------------------------------------------------------------
export type ToolCategory = 'hand_tool' | 'power_tool' | 'measuring' | 'equipment' | 'safety' | 'formwork' | 'other';
export type ToolStatus = 'in_store' | 'issued' | 'repair' | 'lost' | 'disposed';
export type ToolCondition = 'good' | 'fair' | 'damaged';
export type ToolActionName = 'issue' | 'return' | 'repair' | 'repaired' | 'lost' | 'found' | 'dispose';

export const TOOL_CATEGORY_LABELS: Record<ToolCategory, string> = {
  hand_tool: 'Hand tool', power_tool: 'Power tool', measuring: 'Measuring / survey', equipment: 'Minor equipment',
  safety: 'Safety gear', formwork: 'Formwork & props', other: 'Other',
};
export const TOOL_STATUS_LABELS: Record<ToolStatus, string> = {
  in_store: 'In store', issued: 'Issued', repair: 'Under repair', lost: 'Lost', disposed: 'Written off',
};

/** v_tools */
export interface ToolRow {
  id: string; project_id: string; store_id: string | null; store_name: string | null; tag: string; name: string; category: ToolCategory;
  serial_no: string | null; status: ToolStatus; condition: ToolCondition; holder_id: string | null; holder_name: string | null;
  holder: string | null; issued_at: string | null; due_on: string | null; is_overdue: boolean; days_overdue: number | null;
  notes: string | null; created_by: string; created_at: string; updated_at: string;
}
export interface ToolMovement {
  id: string; tool_id: string; project_id: string; action: ToolActionName; holder_id: string | null; holder_name: string | null;
  due_on: string | null; condition: ToolCondition | null; note: string | null; created_by: string; created_at: string;
}
export interface SaveToolPayload extends Op {
  id: string; project_id: string; tag?: string; name: string; category?: ToolCategory; store_id?: string | null; serial_no?: string;
  condition?: ToolCondition; notes?: string;
}
export interface ToolActionPayload extends Op {
  tool_id: string; action: ToolActionName; holder_id?: string; holder_name?: string; due_on?: string; condition?: ToolCondition; note?: string;
}
/** Roles per tool action (the server re-checks). */
export const TOOL_ROLES = {
  manage: ['store_keeper', 'coordinator', 'manager', 'admin'],
  dispose: ['coordinator', 'manager', 'admin'],
} as const;

// ---- supplier performance -------------------------------------------------------------------------------
/** v_supplier_performance — score = quality 50 % + on time 35 % + price 15 % (re-weighted without price access). */
export interface SupplierPerformance {
  supplier_id: string; name: string; phone: string | null; categories: string[];
  orders: number; overdue_orders: number; deliveries: number; on_time: number | null; dated: number | null;
  avg_days_late: number | null; rejected_lines: number | null; last_delivery: string | null;
  on_time_pct: number | null; quality_pct: number | null; price_index: number | null; price_score: number | null;
  service_rating: number | null; ratings: number; score: number | null; grade: 'A' | 'B' | 'C' | 'D' | null;
}
/** v_supplier_deliveries — one row per goods receipt against a purchase order. */
export interface SupplierDelivery {
  grn_id: string; grn_number: string; project_id: string; po_id: string; po_number: string; supplier_id: string;
  promised_on: string | null; received_on: string; days_late: number | null;
  qty_delivered: number; qty_accepted: number; qty_rejected: number; rejected_lines: number;
}
export interface SupplierRating { id: string; project_id: string; supplier_id: string; po_id: string; score: number; comment: string | null; created_by: string; created_at: string }
export interface RateSupplierPayload extends Op { po_id: string; score: number; comment?: string }

// ---- shelf life / stock ageing --------------------------------------------------------------------------
export type ExpiryStatus = 'expired' | 'expiring' | 'ok' | 'no_expiry';
/** v_stock_lots — stock on hand split into received lots, oldest consumed first (FIFO). */
export interface StockLot {
  ledger_id: string; project_id: string; store_id: string; store_name: string; material_spec_id: string; label: string; category: string;
  uom: string; txn_type: string; doc_number: string; batch_no: string | null; grn_line_id: string | null; received_on: string;
  remaining_qty: number; age_days: number; shelf_life_days: number | null; expiry_date: string | null; days_to_expiry: number | null;
  expiry_status: ExpiryStatus;
}
export interface SetLotExpiryPayload extends Op { grn_line_id: string; expiry_date: string | null }

export interface RpcMapStore {
  save_tool: SaveToolPayload;            // → { ok, id, tag }
  tool_action: ToolActionPayload;        // → { ok, id, tag, status }
  rate_supplier: RateSupplierPayload;    // → { ok, po_id, score }
  set_lot_expiry: SetLotExpiryPayload;   // → { ok, grn_line_id, expiry_date }
}
export type RpcNameStore = keyof RpcMapStore;
