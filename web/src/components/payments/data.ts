// Payments data layer (contract: lib/contract-payments.ts, migration 20261103000010_payments.sql).
import { check, fetchAll, supabase } from '../../lib/supabase';
import { invalidateAfterWrite } from '../../lib/query';
import type {
  LabourAttendance, LabourPayroll, LabourPayrollLine, LabourPiecework, LabourWorker, PaymentEvent, PaymentRegisterRow, RpcMapPayments,
  ScCertificate, ScCertificateLine, SubcontractItem, Subcontractor, SubcontractRow,
} from '../../lib/contract-payments';

type PayPayload<N extends keyof RpcMapPayments> = Omit<RpcMapPayments[N], 'op_id'> & { op_id?: string };

/** Payment RPC with a fresh op_id; invalidates non-lookup queries. */
export async function payRpc<N extends keyof RpcMapPayments>(name: N, payload: PayPayload<N>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc(name, { p: { op_id: crypto.randomUUID(), ...payload } });
  if (error) throw new Error(error.message);
  invalidateAfterWrite();
  return (data ?? {}) as Record<string, unknown>;
}

export const loadSubcontractors = async () =>
  check(await supabase.from('subcontractors').select('*').order('name')) as Subcontractor[];

export const loadSubcontracts = (projectId: string) => fetchAll<SubcontractRow>((a, b) => supabase.from('v_subcontracts').select('*')
  .eq('project_id', projectId).order('number').range(a, b));

export const loadSubcontractItems = async (subcontractId: string) =>
  check(await supabase.from('subcontract_items').select('*').eq('subcontract_id', subcontractId).is('deleted_at', null).order('line_no')) as SubcontractItem[];

export const loadCertificates = (projectId: string) => fetchAll<ScCertificate>((a, b) => supabase.from('sc_certificates').select('*')
  .eq('project_id', projectId).order('created_at', { ascending: false }).range(a, b));

export interface CertificateDetail {
  c: ScCertificate; lines: ScCertificateLine[]; sc: SubcontractRow; items: SubcontractItem[]; events: PaymentEvent[];
  /** Earlier approved / paid certificates of the same subcontract (previous payments on the printed sheet). */
  previous: ScCertificate[];
}
export async function loadCertificate(id: string): Promise<CertificateDetail> {
  const c = check(await supabase.from('sc_certificates').select('*').eq('id', id).single()) as ScCertificate;
  const [lines, sc, items, events, previous] = await Promise.all([
    supabase.from('sc_certificate_lines').select('*').eq('certificate_id', id).then(check) as Promise<ScCertificateLine[]>,
    supabase.from('v_subcontracts').select('*').eq('id', c.subcontract_id).single().then(check) as Promise<SubcontractRow>,
    loadSubcontractItems(c.subcontract_id),
    loadEvents(id),
    supabase.from('sc_certificates').select('*').eq('subcontract_id', c.subcontract_id).lt('cert_no', c.cert_no)
      .in('status', ['approved', 'paid']).order('cert_no').then(check) as Promise<ScCertificate[]>,
  ]);
  return { c, lines, sc, items, events, previous };
}

export const loadEvents = async (docId: string) =>
  check(await supabase.from('payment_events').select('*').eq('doc_id', docId).order('created_at')) as PaymentEvent[];

export const loadWorkers = async (projectId: string) =>
  check(await supabase.from('labour_workers').select('*').eq('project_id', projectId).order('full_name')) as LabourWorker[];

export const loadPayrolls = (projectId: string) => fetchAll<LabourPayroll>((a, b) => supabase.from('labour_payrolls').select('*')
  .eq('project_id', projectId).order('period_from', { ascending: false }).range(a, b));

export interface PayrollDetail { pr: LabourPayroll; attendance: LabourAttendance[]; piece: LabourPiecework[]; lines: LabourPayrollLine[]; events: PaymentEvent[] }
export async function loadPayroll(id: string): Promise<PayrollDetail> {
  const pr = check(await supabase.from('labour_payrolls').select('*').eq('id', id).single()) as LabourPayroll;
  const [attendance, piece, lines, events] = await Promise.all([
    supabase.from('labour_attendance').select('*').eq('payroll_id', id).then(check) as Promise<LabourAttendance[]>,
    supabase.from('labour_piecework').select('*').eq('payroll_id', id).order('work_date').then(check) as Promise<LabourPiecework[]>,
    supabase.from('labour_payroll_lines').select('*').eq('payroll_id', id).then(check) as Promise<LabourPayrollLine[]>,
    loadEvents(id),
  ]);
  return { pr, attendance, piece, lines, events };
}

export const loadRegister = (projectId: string) => fetchAll<PaymentRegisterRow>((a, b) => supabase.from('v_payment_register').select('*')
  .eq('project_id', projectId).order('created_at', { ascending: false }).range(a, b));

/** kg per berga (12 m bar) for each rebar spec: spec_conversions alt_uom 'berga'. */
export async function loadBergaFactors(): Promise<Map<string, number>> {
  const rows = check(await supabase.from('spec_conversions').select('material_spec_id, factor').eq('alt_uom', 'berga').is('deleted_at', null)) as { material_spec_id: string; factor: number }[];
  return new Map(rows.map((r) => [r.material_spec_id, Number(r.factor)]));
}

/** Calendar days of a period, 'YYYY-MM-DD'. */
export function periodDays(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  for (let i = 0; d <= end && i < 40; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

export const etb = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
