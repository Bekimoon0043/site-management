// Payments contract (migration 20261103000010_payments.sql): subcontractor interim payment certificates and the
// daily-labour payroll (day-rate attendance + piece-rate work in berga / m² / m³ / pcs). Chain for both:
// office engineer prepares → coordinator checks → manager approves (posts actual cost) → finance pays.
// Copied into each app as src/lib/contract-payments.ts (`npm run sync:contract`).
import type { AppRole } from './contract';

interface Op { op_id: string }

export type PaymentStatus = 'draft' | 'submitted' | 'checked' | 'approved' | 'paid' | 'returned' | 'rejected';
export type PaymentDocType = 'sc_certificate' | 'payroll';
export type PaymentAction = 'submit' | 'check' | 'approve' | 'pay' | 'return' | 'reject';
export type PaymentMethod = 'bank_transfer' | 'cheque' | 'cash';
export type PayrollFrequency = 'weekly' | 'fortnightly' | 'monthly';

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  draft: 'Draft', submitted: 'To check', checked: 'To approve', approved: 'To pay', paid: 'Paid', returned: 'Returned', rejected: 'Rejected',
};
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = { bank_transfer: 'Bank transfer', cheque: 'Cheque', cash: 'Cash' };
/** Piece-work units offered in the payroll (berga = one 12 m reinforcement bar). Free text is allowed too. */
export const PIECE_UNITS = ['berga', 'm2', 'm3', 'm', 'pcs', 'kg', 'no.'] as const;
/** Daily-labour tax rates offered (the payroll records the rate used; a worker can override). */
export const LABOUR_TAX_RATES = [15, 30] as const;
export const WHT_PCT_DEFAULT = 3;      // Proclamation 1395/2025: 3 % on services ≥ ETB 10,000
export const VAT_PCT = 15;

export type PaymentPermAction = 'payment.view' | 'payment.prepare' | 'payment.check' | 'payment.approve' | 'payment.pay' | 'piece.verify';
const PAYMENT_PERMS: Record<PaymentPermAction, AppRole[]> = {
  'payment.view': ['office_engineer', 'coordinator', 'manager', 'finance', 'admin'],
  'payment.prepare': ['office_engineer', 'coordinator', 'admin'],
  'payment.check': ['coordinator', 'admin'],
  'payment.approve': ['manager', 'admin'],
  'payment.pay': ['finance', 'admin'],
  'piece.verify': ['site_engineer', 'office_engineer', 'coordinator', 'admin'],
};
export const canPay = (role: AppRole | null | undefined, a: PaymentPermAction) => !!role && PAYMENT_PERMS[a].includes(role);
export const PAYMENT_ROLES = PAYMENT_PERMS['payment.view'];

export interface Subcontractor {
  id: string; name: string; trade: string | null; tin: string | null; vat_registered: boolean; contact_person: string | null; phone: string | null;
  email: string | null; address: string | null; bank_name: string | null; bank_account: string | null; is_active: boolean;
}
export interface SubcontractItem {
  id: string; subcontract_id: string; line_no: number; boq_item_id: string | null; task_id: string | null; description: string; unit: string;
  qty: number; rate: number; deleted_at: string | null;
}
export interface SubcontractRow {
  id: string; project_id: string; number: string; subcontractor_id: string; title: string; scope: string | null; start_date: string | null; end_date: string | null;
  retention_pct: number; advance_amount: number; advance_recovery_pct: number; vat_pct: number; wht_pct: number; wht_threshold: number;
  status: 'draft' | 'active' | 'completed' | 'terminated'; created_at: string;
  // v_subcontracts
  subcontractor_name: string; subcontractor_tin: string | null; vat_registered: boolean; contract_value: number; certified_to_date: number;
  paid_to_date: number; retention_held: number; advance_recovered: number; last_certificate_status: PaymentStatus | null;
}
export interface ScCertificate {
  id: string; project_id: string; subcontract_id: string; number: string; cert_no: number; period_from: string; period_to: string; is_final: boolean;
  status: PaymentStatus; gross_to_date: number; gross_previous: number; gross_this: number; retention_pct: number; retention_this: number;
  retention_release: number; advance_recovery_this: number; material_deduction: number; penalty: number; other_deduction: number;
  other_deduction_note: string | null; vat_pct: number; vat_this: number; wht_pct: number; wht_this: number; net_payable: number; remarks: string | null;
  prepared_by: string | null; submitted_at: string | null; checked_by: string | null; checked_at: string | null; approved_by: string | null;
  approved_at: string | null; paid_by: string | null; paid_at: string | null; payment_method: PaymentMethod | null; payment_ref: string | null;
  payment_date: string | null; return_comment: string | null; created_at: string;
}
export interface ScCertificateLine {
  id: string; certificate_id: string; subcontract_item_id: string; qty_claimed_to_date: number; qty_verified_to_date: number; qty_previous: number;
  site_qty_to_date: number | null; rate: number; amount_to_date: number; amount_previous: number; amount_this: number; remark: string | null;
}
export interface LabourWorker {
  id: string; project_id: string; full_name: string; trade_id: string | null; trade_name: string | null; daily_rate: number; tin: string | null;
  tax_pct: number | null; id_no: string | null; phone: string | null; bank_account: string | null; is_active: boolean;
}
export interface LabourPayroll {
  id: string; project_id: string; number: string; period_from: string; period_to: string; frequency: PayrollFrequency; tax_pct: number;
  ot_multiplier: number; status: PaymentStatus; workers: number; days: number; gross: number; tax: number; deductions: number; net: number;
  remarks: string | null; prepared_by: string | null; submitted_at: string | null; checked_by: string | null; checked_at: string | null;
  approved_by: string | null; approved_at: string | null; paid_by: string | null; paid_at: string | null; payment_method: PaymentMethod | null;
  payment_ref: string | null; payment_date: string | null; return_comment: string | null; created_at: string;
}
export interface LabourAttendance { id: string; payroll_id: string; worker_id: string; work_date: string; day_value: number; ot_hours: number; task_id: string | null }
export interface LabourPiecework {
  id: string; payroll_id: string; worker_id: string; work_date: string; description: string; unit: string; qty_claimed: number;
  qty_verified: number | null; rate: number; amount: number; task_id: string | null; element_id: string | null; boq_item_id: string | null;
  material_spec_id: string | null; kg_equivalent: number | null; verified_by: string | null; verified_at: string | null; remark: string | null;
}
export interface LabourPayrollLine {
  id: string; payroll_id: string; worker_id: string; days: number; ot_hours: number; daily_rate: number; ot_amount: number; piece_amount: number;
  gross: number; tax_pct: number; tax: number; other_deduction: number; deduction_note: string | null; net: number;
}
export interface PaymentEvent { id: string; doc_type: PaymentDocType; doc_id: string; action: string; from_status: string | null; to_status: string | null; actor: string | null; comment: string | null; created_at: string }
export interface PaymentRegisterRow {
  doc_type: PaymentDocType; id: string; project_id: string; number: string; party: string; period_from: string; period_to: string; status: PaymentStatus;
  gross: number; deductions: number; vat: number; tax: number; net: number; prepared_by: string | null; checked_by: string | null; approved_by: string | null;
  approved_at: string | null; paid_by: string | null; paid_at: string | null; payment_method: PaymentMethod | null; payment_ref: string | null;
  payment_date: string | null; created_at: string;
}

export interface SaveSubcontractorPayload extends Op {
  id?: string; name: string; trade?: string; tin?: string; vat_registered?: boolean; contact_person?: string; phone?: string; email?: string;
  address?: string; bank_name?: string; bank_account?: string; is_active?: boolean;
}
export interface SaveSubcontractPayload extends Op {
  id: string; project_id: string; subcontractor_id: string; title: string; scope?: string; start_date?: string | null; end_date?: string | null;
  retention_pct?: number; advance_amount?: number; advance_recovery_pct?: number; vat_pct?: number; wht_pct?: number; wht_threshold?: number;
  status?: SubcontractRow['status'];
  items?: { id?: string; boq_item_id?: string | null; task_id?: string | null; description: string; unit: string; qty: number; rate: number }[];
}
export interface SaveScCertificatePayload extends Op {
  id: string; subcontract_id: string; period_from: string; period_to: string; is_final?: boolean; retention_release?: number;
  material_deduction?: number; penalty?: number; other_deduction?: number; other_deduction_note?: string; remarks?: string;
  lines: { subcontract_item_id: string; qty_claimed_to_date: number; qty_verified_to_date: number; remark?: string }[];
}
export interface SaveLabourWorkerPayload extends Op {
  id?: string; project_id: string; full_name: string; trade_id?: string | null; trade_name?: string; daily_rate: number; tin?: string;
  tax_pct?: number | null; id_no?: string; phone?: string; bank_account?: string; is_active?: boolean;
}
export interface SavePayrollPayload extends Op {
  id: string; project_id: string; period_from: string; period_to: string; frequency?: PayrollFrequency; tax_pct?: number; ot_multiplier?: number; remarks?: string;
  attendance?: { worker_id: string; work_date: string; day_value: number; ot_hours?: number; task_id?: string | null }[];
  piecework?: { id?: string; worker_id: string; work_date: string; description: string; unit: string; qty_claimed: number; rate: number;
    task_id?: string | null; element_id?: string | null; boq_item_id?: string | null; material_spec_id?: string | null; remark?: string }[];
  deductions?: { worker_id: string; other_deduction: number; deduction_note?: string }[];
}
export interface VerifyPieceworkPayload extends Op { payroll_id: string; lines: { id: string; qty_verified: number; remark?: string }[] }
export interface PaymentActionPayload extends Op {
  doc_type: PaymentDocType; id: string; action: PaymentAction; comment?: string;
  payment_method?: PaymentMethod; payment_ref?: string; payment_date?: string;
}

export interface RpcMapPayments {
  save_subcontractor: SaveSubcontractorPayload;     // → { ok, id }
  save_subcontract: SaveSubcontractPayload;         // → { ok, id, number }
  save_sc_certificate: SaveScCertificatePayload;    // → { ok, id, number, status, gross_this, net_payable }
  save_labour_worker: SaveLabourWorkerPayload;      // → { ok, id }
  save_payroll: SavePayrollPayload;                 // → { ok, id, number, status, workers, gross, tax, net }
  verify_piecework: VerifyPieceworkPayload;         // → { ok, verified, gross, net }
  payment_action: PaymentActionPayload;             // → { ok, id, number, status }
}
