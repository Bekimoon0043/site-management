// Contract for client billing (migration 20261103000060_client_billing.sql): contract terms, interim payment
// certificates (IPC) to the client and variations. Copy next to contract.ts in each app (npm run sync:contract).
//
// IPC flow: draft → prepared (office engineer / QS) → checked (coordinator) → submitted to the consultant (manager)
// → certified (consultant's figures recorded) → paid (finance / manager). Returned → draft.
// Variation flow: draft → pending (manager) → submitted to the client → approved (enters the BoQ) | rejected.
// All amounts are ex VAT unless named otherwise; readable only by roles that can see prices.

export interface Op { op_id?: string }

export type IpcStatus = 'draft' | 'prepared' | 'checked' | 'submitted' | 'certified' | 'paid' | 'cancelled';
export type VariationStatus = 'draft' | 'pending' | 'submitted' | 'approved' | 'rejected' | 'cancelled';

export const IPC_STATUS_LABELS: Record<IpcStatus, string> = {
  draft: 'Draft', prepared: 'To check', checked: 'To approve', submitted: 'With consultant', certified: 'Certified — awaiting payment',
  paid: 'Paid', cancelled: 'Cancelled',
};
export const VARIATION_STATUS_LABELS: Record<VariationStatus, string> = {
  draft: 'Draft', pending: 'Awaiting approval', submitted: 'With client', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled',
};

export interface ClientContract {
  project_id: string; contract_no: string | null; client_name: string | null; consultant_name: string | null;
  contract_sum: number; vat_pct: number; advance_amount: number; advance_recovery_pct: number;
  retention_pct: number; retention_limit_pct: number; mos_pct: number; wht_pct: number;
  supplementary_sum: number; rebate_pct: number; signed_on: string | null; updated_at: string;
}

/** app.ipc_totals (20261104000000). Certificate lines: 1 value_cum, 2 previous_value, 3 rebate, 4 retention_this, 5 penalty,
 *  6 material_delivered, 7 total_deduction, 8 net_before_advance, 9 advance_this, 10 net_after_advance, 11 wht, 12 vat → payable.
 *  rebate, retention, wht and vat are % × this_value (1 − 2). Other fields are cumulative breakdowns. */
export interface IpcTotals {
  value_cum: number; previous_value: number; this_value: number; rebate: number; retention_this: number; penalty: number;
  material_delivered: number; total_deduction: number; net_before_advance: number; advance_this: number; net_after_advance: number;
  rebate_pct: number;
  work_cum: number; work_prev: number; work_this: number; mos: number; price_adjustment: number; gross_cum: number;
  retention_cum: number; advance_recovery_cum: number; net_cum: number; previous_net: number; this_net: number;
  vat: number; total_incl_vat: number; wht: number; payable: number;
  retention_pct: number; advance_recovery_pct: number; vat_pct: number; wht_pct: number; mos_pct: number;
  contract_sum: number; progress_pct: number | null;
}

export interface ClientIpc {
  id: string; project_id: string; ipc_no: number; period_from: string | null; period_to: string; status: IpcStatus; is_final: boolean;
  mos_value: number; price_adjustment: number; penalty: number; material_delivered: number; claimed: IpcTotals | Record<string, never>; certified: IpcTotals | null;
  certified_mos_value: number | null; certified_price_adjustment: number | null; consultant_ref: string | null; certified_on: string | null;
  paid_amount: number; paid_on: string | null; payment_ref: string | null; remarks: string | null; return_comment: string | null;
  prepared_by: string | null; prepared_at: string | null; checked_by: string | null; checked_at: string | null;
  submitted_by: string | null; submitted_at: string | null; certified_by: string | null; paid_by: string | null;
  created_by: string; created_at: string; updated_at: string;
}

export interface ClientIpcLine {
  id: string; ipc_id: string; boq_item_id: string; item_no: string; description: string; unit: string;
  contract_qty: number; rate: number; verified_qty: number; prev_qty: number; cum_qty: number; certified_cum_qty: number | null; remeasured: boolean;
}

export interface Variation {
  id: string; project_id: string; number: string; title: string; instruction_ref: string | null; instruction_date: string | null;
  reason: string | null; status: VariationStatus; amount: number; client_ref: string | null; decided_at: string | null;
  decision_comment: string | null; created_by: string; approved_by: string | null; approved_at: string | null; created_at: string; updated_at: string;
}
export interface VariationLine {
  id: string; variation_id: string; line_no: number; boq_item_id: string | null; item_no: string; description: string; unit: string;
  qty: number; rate: number; amount: number; created_boq_item_id: string | null;
}

export interface SaveClientContractPayload extends Op {
  project_id: string; contract_no?: string; client_name?: string; consultant_name?: string; contract_sum: number; vat_pct?: number;
  advance_amount?: number; advance_recovery_pct?: number; retention_pct?: number; retention_limit_pct?: number; mos_pct?: number; wht_pct?: number;
  supplementary_sum?: number; rebate_pct?: number; signed_on?: string;
}
export interface SaveClientIpcPayload extends Op {
  id: string; project_id: string; period_to?: string; period_from?: string; mos_value?: number; price_adjustment?: number;
  penalty?: number; material_delivered?: number;
  remarks?: string; is_final?: boolean; lines?: { boq_item_id: string; cum_qty: number }[]; refresh?: boolean; prepare?: boolean;
}
export type DecideClientIpcPayload = Op & { ipc_id: string; comment?: string } & (
  | { action: 'check' | 'submit' | 'return' | 'cancel' }
  | { action: 'certify'; certified_lines?: { boq_item_id: string; cum_qty: number }[]; certified_mos_value?: number;
      certified_price_adjustment?: number; consultant_ref?: string; certified_on?: string }
  | { action: 'pay'; amount: number; paid_on?: string; payment_ref?: string });
export interface SaveVariationPayload extends Op {
  id: string; project_id: string; title: string; instruction_ref?: string; instruction_date?: string; reason?: string; submit?: boolean;
  lines: { boq_item_id?: string | null; item_no?: string; description?: string; unit?: string; qty: number; rate?: number }[];
}
export interface DecideVariationPayload extends Op {
  variation_id: string; action: 'approve' | 'return' | 'client_approve' | 'client_reject' | 'cancel'; comment?: string; client_ref?: string;
}

export interface RpcMapBilling {
  save_client_contract: SaveClientContractPayload;   // → { ok, project_id }
  save_client_ipc: SaveClientIpcPayload;             // → { ok, id, ipc_no, status, claimed }
  decide_client_ipc: DecideClientIpcPayload;         // → { ok, id, status, claimed, certified, paid_amount }
  save_variation: SaveVariationPayload;              // → { ok, id, number, status, amount }
  decide_variation: DecideVariationPayload;          // → { ok, id, status }
}
export type RpcNameBilling = keyof RpcMapBilling;

/** Roles per action (the server re-checks; all also need price access). */
export const BILLING_ROLES = {
  terms: ['coordinator', 'manager', 'admin'],
  prepare: ['office_engineer', 'coordinator', 'manager', 'admin'],
  check: ['coordinator', 'admin'],
  submit: ['manager', 'admin'],
  certify: ['coordinator', 'manager', 'admin'],
  pay: ['finance', 'manager', 'admin'],
  variationApprove: ['manager', 'admin'],
  variationClient: ['coordinator', 'manager', 'admin'],
} as const;
