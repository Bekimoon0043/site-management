// Client billing data layer (contract: lib/contract-billing.ts, migration 20261103000060_client_billing.sql).
import { check, fetchAll, supabase } from '../../lib/supabase';
import { invalidateAfterWrite } from '../../lib/query';
import type {
  ClientContract, ClientIpc, ClientIpcLine, IpcTotals, RpcMapBilling, Variation, VariationLine,
} from '../../lib/contract-billing';
import type { AppRole } from '../../lib/contract';
import { BILLING_ROLES } from '../../lib/contract-billing';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export async function billRpc<N extends keyof RpcMapBilling>(name: N, payload: DistOmit<RpcMapBilling[N], 'op_id'>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc(name, { p: { op_id: crypto.randomUUID(), ...payload } });
  if (error) throw new Error(error.message);
  invalidateAfterWrite();
  return (data ?? {}) as Record<string, unknown>;
}

export const canBill = (role: AppRole | null | undefined, action: keyof typeof BILLING_ROLES) =>
  !!role && (BILLING_ROLES[action] as readonly string[]).includes(role);

export async function loadContract(projectId: string) {
  return (check(await supabase.from('client_contracts').select('*').eq('project_id', projectId).maybeSingle()) as ClientContract | null);
}
export async function loadIpcs(projectId: string) {
  return check(await supabase.from('client_ipcs').select('*').eq('project_id', projectId).order('ipc_no', { ascending: false })) as ClientIpc[];
}
export async function loadIpc(id: string) {
  const ipc = check(await supabase.from('client_ipcs').select('*').eq('id', id).single()) as ClientIpc;
  const lines = check(await supabase.from('client_ipc_lines').select('*').eq('ipc_id', id).order('item_no')) as ClientIpcLine[];
  return { ipc, lines };
}
/** Approved variation orders: total ex VAT and count (contract summary on the certificate). */
export async function loadApprovedVos(projectId: string) {
  const vs = check(await supabase.from('variations').select('amount').eq('project_id', projectId).eq('status', 'approved')) as { amount: number }[];
  return { total: vs.reduce((s, v) => s + Number(v.amount), 0), count: vs.length };
}
export async function loadVariations(projectId: string) {
  const vs = check(await supabase.from('variations').select('*').eq('project_id', projectId).order('created_at', { ascending: false })) as Variation[];
  const ids = vs.map((v) => v.id);
  const lines = ids.length ? check(await supabase.from('variation_lines').select('*').in('variation_id', ids).order('line_no')) as VariationLine[] : [];
  return vs.map((v) => ({ ...v, lines: lines.filter((l) => l.variation_id === v.id) }));
}

export const totalsOf = (i: Pick<ClientIpc, 'certified' | 'claimed'>): Partial<IpcTotals> => (i.certified ?? i.claimed ?? {}) as Partial<IpcTotals>;

/** Natural sort for BoQ item numbers (1.2.10 after 1.2.9). */
export const byItemNo = (a: { item_no: string }, b: { item_no: string }) =>
  a.item_no.localeCompare(b.item_no, undefined, { numeric: true, sensitivity: 'base' });

export interface BoqRated { id: string; item_no: string; description: string; unit: string; quantity: number; rate: number | null }
/** BoQ items with their contract rate (price data). */
export async function loadBoqRated(projectId: string): Promise<BoqRated[]> {
  const rows = await fetchAll<Omit<BoqRated, 'rate'> & { boq_rates: { rate: number } | { rate: number }[] | null }>((a, b) => supabase.from('boq_items')
    .select('id, item_no, description, unit, quantity, boq_rates(rate)' as '*').eq('project_id', projectId).is('deleted_at', null).range(a, b), 20000);
  return rows.map(({ boq_rates: r, ...b }) => ({ ...b, rate: (Array.isArray(r) ? r[0]?.rate : r?.rate) ?? null })).sort(byItemNo);
}
