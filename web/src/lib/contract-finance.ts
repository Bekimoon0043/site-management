// Contract for finance & admin (migration 20261105000060_finance.sql): supplier invoices with a 3-way match,
// petty cash, cash-flow forecast, finance overview, monthly tax report, admin handover.
// Copy next to contract.ts in each app (npm run sync:contract).
//
// Supplier invoice / petty cash claim chain: prepared (procurement / finance / office engineer; the custodian for petty
// cash) → checked (coordinator) → approved (manager; a 3-way-match variance needs a written override) → paid (finance).

export interface Op { op_id?: string }

export type FinanceDocType = 'supplier_invoice' | 'petty_cash';
export type FinanceDocStatus = 'draft' | 'submitted' | 'checked' | 'approved' | 'paid' | 'returned' | 'rejected';
export type FinanceAction = 'submit' | 'check' | 'approve' | 'pay' | 'return' | 'reject';
export type PettyCategory = 'transport' | 'fuel' | 'food' | 'materials' | 'repairs' | 'office' | 'labour' | 'other';

export const FINANCE_STATUS_LABELS: Record<FinanceDocStatus, string> = {
  draft: 'Draft', submitted: 'To check', checked: 'To approve', approved: 'To pay', paid: 'Paid', returned: 'Returned', rejected: 'Rejected',
};
export const PETTY_CATEGORY_LABELS: Record<PettyCategory, string> = {
  transport: 'Transport', fuel: 'Fuel', food: 'Food & refreshments', materials: 'Small materials', repairs: 'Repairs',
  office: 'Office & stationery', labour: 'Casual labour', other: 'Other',
};

/** v_supplier_invoices */
export interface SupplierInvoice {
  id: string; project_id: string; number: string; supplier_id: string; po_id: string; invoice_no: string; invoice_date: string; due_date: string;
  status: FinanceDocStatus; subtotal: number; vat: number; total: number; withholding_rate: number; withholding: number; net_payable: number;
  match_status: 'matched' | 'variance'; match_notes: string[]; override_comment: string | null; remarks: string | null; return_comment: string | null;
  prepared_by: string | null; submitted_at: string | null; checked_by: string | null; checked_at: string | null; approved_by: string | null;
  approved_at: string | null; paid_by: string | null; paid_at: string | null; payment_method: 'bank_transfer' | 'cheque' | 'cash' | null;
  payment_ref: string | null; payment_date: string | null; created_at: string;
  supplier_name: string; supplier_tin: string | null; po_number: string;
}
export interface SupplierInvoiceLine {
  id: string; invoice_id: string; po_line_id: string; line_no: number; description: string | null; qty: number; unit_price: number; amount: number;
  vat_applicable: boolean; po_unit_price: number | null; qty_ordered: number | null; qty_accepted: number | null; qty_invoiced_before: number | null;
  flag: 'price' | 'qty' | 'price_qty' | null;
}
/** v_po_invoiceable — PO lines with goods accepted vs already invoiced (price data). */
export interface PoInvoiceable {
  po_line_id: string; po_id: string; project_id: string; po_number: string; supplier_id: string; line_no: number; material_spec_id: string;
  spec: string; material: string; uom: string | null; qty_ordered: number; qty_accepted: number; qty_invoiced: number; unit_price: number; vat_applicable: boolean;
}

/** v_petty_cash_floats */
export interface PettyFloat {
  id: string; project_id: string; name: string; custodian_id: string; custodian_name: string; float_amount: number; is_active: boolean;
  unclaimed: number; in_claim: number; balance: number; created_at: string;
}
export interface PettyEntry {
  id: string; project_id: string; float_id: string; number: string; entry_date: string; category: PettyCategory; description: string;
  payee: string | null; receipt_no: string | null; amount: number; claim_id: string | null; voided: boolean; recorded_by: string | null; created_at: string;
}
export interface PettyClaim {
  id: string; project_id: string; float_id: string; number: string; status: Exclude<FinanceDocStatus, 'draft'>; total: number; entries: number;
  remarks: string | null; return_comment: string | null; prepared_by: string | null; submitted_at: string | null; checked_by: string | null;
  approved_by: string | null; approved_at: string | null; paid_by: string | null; payment_method: string | null; payment_ref: string | null;
  payment_date: string | null; created_at: string;
}

/** cash_flow_forecast(project, weeks) */
export interface CashFlowWeek {
  week_start: string; client_in: number; suppliers_out: number; subcontractors_out: number; labour_out: number; petty_cash_out: number;
  committed_out: number; net: number; cumulative: number;
}
/** cash_flow_items(project) */
export interface CashFlowItem { direction: 'in' | 'out'; bucket: string; ref: string; party: string; due: string; amount: number }
/** finance_overview(project) */
export interface FinanceOverview {
  receivable: number; receivable_ageing: { d0_30: number; d31_60: number; d61_90: number; d90_plus: number };
  retention_receivable: number; advance_to_recover_from_us: number; retention_payable: number;
  payable_approved: number; payable_overdue: number; supplier_invoices_overdue: number; petty_cash_in_hand: number;
}
export type TaxSection = 'wht_payable' | 'payroll_tax' | 'vat_output' | 'vat_input' | 'wht_credit';
export const TAX_SECTION_LABELS: Record<TaxSection, string> = {
  wht_payable: 'Withholding tax to remit (suppliers & subcontractors)', payroll_tax: 'Tax withheld from daily labour',
  vat_output: 'VAT output (certificates to the client)', vat_input: 'VAT input (supplier invoices & subcontractor certificates)',
  wht_credit: 'Withholding deducted by the client (tax credit)',
};
/** tax_report(project | null, month) */
export interface TaxRow {
  section: TaxSection; project_id: string; doc_type: string; doc_id: string; number: string; party: string; tin: string | null;
  doc_date: string | null; base: number; rate: number | null; amount: number;
}

export interface SaveSupplierInvoicePayload extends Op {
  id: string; po_id: string; invoice_no: string; invoice_date: string; due_date?: string; remarks?: string; submit?: boolean;
  lines: { po_line_id: string; qty: number; unit_price?: number; description?: string }[];
}
export interface FinanceDocActionPayload extends Op {
  doc_type: FinanceDocType; id: string; action: FinanceAction; comment?: string;
  payment_method?: 'bank_transfer' | 'cheque' | 'cash'; payment_ref?: string; payment_date?: string;
}
export interface SavePettyFloatPayload extends Op { id: string; project_id: string; name?: string; custodian_id: string; float_amount: number; is_active?: boolean }
export type RecordPettyExpensePayload = Op & ({
  id: string; float_id: string; entry_date: string; category: PettyCategory; description: string; payee?: string; receipt_no?: string; amount: number;
} | { id: string; void: true });
export interface SubmitPettyClaimPayload extends Op { id: string; float_id: string; remarks?: string }

export interface RpcMapFinance {
  save_supplier_invoice: SaveSupplierInvoicePayload;   // → { ok, id, number, status, match_status, match_notes, net_payable }
  finance_doc_action: FinanceDocActionPayload;         // → { ok, id, number, status }
  save_petty_float: SavePettyFloatPayload;             // → { ok, id }
  record_petty_expense: RecordPettyExpensePayload;     // → { ok, id, number, balance }
  submit_petty_claim: SubmitPettyClaimPayload;         // → { ok, id, number, total, entries }
}

/** Roles per step (the server re-checks; supplier invoices also need price access). */
export const FINANCE_ROLES = {
  invoiceView: ['procurement', 'finance', 'office_engineer', 'coordinator', 'manager', 'admin'],
  invoicePrepare: ['procurement', 'finance', 'office_engineer', 'coordinator', 'admin'],
  check: ['coordinator', 'admin'],
  approve: ['manager', 'admin'],
  pay: ['finance', 'admin'],
  floatManage: ['manager', 'finance', 'admin'],
  reports: ['finance', 'manager', 'coordinator', 'admin'],
} as const;
