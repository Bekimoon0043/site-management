// Materials roles data layer (contract: lib/contract-store.ts, migrations 20261105000050–53).
import { fetchAll, supabase, check } from '../../lib/supabase';
import { invalidateAfterWrite } from '../../lib/query';
import type { RpcMapStore, StockLot, SupplierDelivery, SupplierPerformance, ToolMovement, ToolRow } from '../../lib/contract-store';

export async function storeRpc<N extends keyof RpcMapStore>(name: N, payload: Omit<RpcMapStore[N], 'op_id'>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc(name, { p: { op_id: crypto.randomUUID(), ...payload } });
  if (error) throw new Error(error.message);
  invalidateAfterWrite();
  return (data ?? {}) as Record<string, unknown>;
}

export const loadTools = (projectId: string) => fetchAll<ToolRow>((a, b) => supabase.from('v_tools').select('*')
  .eq('project_id', projectId).order('tag').range(a, b), 20000);
export const loadToolMovements = async (toolId: string) => check(await supabase.from('tool_movements').select('*')
  .eq('tool_id', toolId).order('created_at', { ascending: false })) as ToolMovement[];
export const loadLots = (projectId: string) => fetchAll<StockLot>((a, b) => supabase.from('v_stock_lots').select('*')
  .eq('project_id', projectId).order('received_on').range(a, b), 50000);
export const loadSupplierPerformance = async () => check(await supabase.from('v_supplier_performance').select('*').order('name')) as SupplierPerformance[];
export const loadSupplierDeliveries = async (supplierId: string) => check(await supabase.from('v_supplier_deliveries').select('*')
  .eq('supplier_id', supplierId).order('received_on', { ascending: false }).limit(200)) as SupplierDelivery[];
