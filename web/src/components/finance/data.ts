// Finance data layer (contract: lib/contract-finance.ts, migration 20261105000060_finance.sql).
import { check, fetchAll, supabase } from '../../lib/supabase';
import { invalidateAfterWrite } from '../../lib/query';
import type { AppRole } from '../../lib/contract';
import {
  FINANCE_ROLES, type CashFlowItem, type CashFlowWeek, type FinanceOverview, type PettyClaim, type PettyEntry, type PettyFloat,
  type PoInvoiceable, type RpcMapFinance, type SupplierInvoice, type SupplierInvoiceLine, type TaxRow,
} from '../../lib/contract-finance';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export async function finRpc<N extends keyof RpcMapFinance>(name: N, payload: DistOmit<RpcMapFinance[N], 'op_id'>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc(name, { p: { op_id: crypto.randomUUID(), ...payload } });
  if (error) throw new Error(error.message);
  invalidateAfterWrite();
  return (data ?? {}) as Record<string, unknown>;
}

export const canFin = (role: AppRole | null | undefined, a: keyof typeof FINANCE_ROLES) =>
  !!role && (FINANCE_ROLES[a] as readonly string[]).includes(role);

export const loadInvoices = (projectId: string) => fetchAll<SupplierInvoice>((a, b) => supabase.from('v_supplier_invoices').select('*')
  .eq('project_id', projectId).order('created_at', { ascending: false }).range(a, b));
export const loadInvoiceLines = async (id: string) =>
  check(await supabase.from('supplier_invoice_lines').select('*').eq('invoice_id', id).order('line_no')) as SupplierInvoiceLine[];
export const loadInvoiceable = (projectId: string) => fetchAll<PoInvoiceable>((a, b) => supabase.from('v_po_invoiceable').select('*')
  .eq('project_id', projectId).order('po_number').order('line_no').range(a, b));

export const loadFloats = async (projectId: string) =>
  check(await supabase.from('v_petty_cash_floats').select('*').eq('project_id', projectId).order('created_at')) as PettyFloat[];
export const loadPettyEntries = (projectId: string) => fetchAll<PettyEntry>((a, b) => supabase.from('petty_cash_entries').select('*')
  .eq('project_id', projectId).order('entry_date', { ascending: false }).order('number', { ascending: false }).range(a, b));
export const loadPettyClaims = async (projectId: string) =>
  check(await supabase.from('petty_cash_claims').select('*').eq('project_id', projectId).order('created_at', { ascending: false })) as PettyClaim[];

const rows = async <T,>(fn: string, args: Record<string, unknown>) => {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return (data ?? []) as T;
};
export const loadCashFlow = (projectId: string, weeks = 13) => rows<CashFlowWeek[]>('cash_flow_forecast', { p_project: projectId, p_weeks: weeks });
export const loadCashItems = (projectId: string) => rows<CashFlowItem[]>('cash_flow_items', { p_project: projectId });
export const loadOverview = (projectId: string) => rows<FinanceOverview>('finance_overview', { p_project: projectId });
export const loadTaxReport = (projectId: string | null, month: string) => rows<TaxRow[]>('tax_report', { p_project: projectId, p_month: `${month}-01` });
