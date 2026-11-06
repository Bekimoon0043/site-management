// Material costing (migration 20261103000020_material_costing.sql): materials are cost when USED.
// Moving weighted average per project × spec; receipts at PO price ex-VAT (standard price without a PO).
// All views here are price-restricted (app.can_see_prices) — non-price roles get no rows.

export type CostKind = 'receipt' | 'opening' | 'issue' | 'return' | 'wastage' | 'loss' | 'count' | 'transfer' | 'gate' | 'quarantine' | 'other';

export const COST_KIND_LABELS: Record<CostKind, string> = {
  receipt: 'Received (GRN)', opening: 'Opening stock', issue: 'Issued to work', return: 'Returned from site', wastage: 'Wastage',
  loss: 'Damage / loss / write-off', count: 'Stock-count variance', transfer: 'Transfer', gate: 'Gate pass', quarantine: 'Quarantine (not valued)',
  other: 'Other',
};

/** v_inventory_value — stock on hand at average cost, per store × spec (quarantine excluded). */
export interface InventoryValueRow {
  project_id: string; store_id: string; store_name: string; material_spec_id: string; label: string; category: string; uom: string;
  qty: number; avg_cost: number | null; value: number;
}

/** v_material_cost — actuals per spec × BoQ item, with or without budget lines. used_value = actual cost (AC). */
export interface MaterialCostRow {
  project_id: string; material_spec_id: string; label: string; category: string; uom: string;
  boq_item_id: string | null; boq_item_no: string | null; boq_description: string | null; allowance_pct: number | null;
  committed: number; received_qty: number; received_value: number; issued_qty: number; used_value: number;
  wastage_qty: number; wastage_value: number;
}

/** v_stock_ledger_value — bin card with value per movement. */
export interface StockLedgerValueRow {
  id: string; project_id: string; store_id: string; material_spec_id: string; qty: number; stock_status: string; txn_type: string;
  doc_type: string; doc_id: string; doc_number: string; element_id: string | null; txn_at: string; cost_kind: CostKind;
  is_consumption: boolean; unit_cost: number | null; value: number; pool_qty_after: number | null; pool_avg_after: number | null;
}

export const PRICE_VIEWS_COSTING = ['v_inventory_value', 'v_material_cost', 'v_stock_ledger_value', 'stock_ledger_costs', 'stock_cost_pool'] as const;
