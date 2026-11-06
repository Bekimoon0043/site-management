// Cached reads and authenticated writes for the tools, supplier-performance and stock-ageing views.
import * as Crypto from 'expo-crypto';
import { kvGet, kvSet } from './db';
import { supabase } from './supabase';
import type { RpcMapStore, StockLot, SupplierDelivery, SupplierPerformance, ToolRow } from './contract-store';

interface Cache<T> { at: string; rows: T[] }

function readCache<T>(key: string): Cache<T> | null {
  try {
    const raw = kvGet(key);
    return raw ? JSON.parse(raw) as Cache<T> : null;
  } catch { return null; }
}

async function refresh<T>(key: string, query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<Cache<T>> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const cache = { at: new Date().toISOString(), rows: data ?? [] };
  kvSet(key, JSON.stringify(cache));
  return cache;
}

const toolsKey = (projectId: string) => `cache:tools:${projectId}`;
const lotsKey = (projectId: string) => `cache:stock-lots:${projectId}`;
const suppliersKey = (projectId: string) => `cache:supplier-performance:${projectId}`;

export const cachedTools = (projectId: string) => readCache<ToolRow>(toolsKey(projectId));
export const cachedLots = (projectId: string) => readCache<StockLot>(lotsKey(projectId));
export const cachedSupplierPerformance = (projectId: string) => readCache<SupplierPerformance>(suppliersKey(projectId));

export const refreshTools = (projectId: string) => refresh<ToolRow>(toolsKey(projectId),
  supabase.from('v_tools').select('*').eq('project_id', projectId).order('tag'));
export const refreshLots = (projectId: string) => refresh<StockLot>(lotsKey(projectId),
  supabase.from('v_stock_lots').select('*').eq('project_id', projectId).order('received_on'));
export const refreshSupplierPerformance = (projectId: string) => refresh<SupplierPerformance>(suppliersKey(projectId),
  supabase.from('v_supplier_performance').select('*').order('name'));

export async function loadSupplierDeliveries(supplierId: string): Promise<SupplierDelivery[]> {
  const { data, error } = await supabase.from('v_supplier_deliveries').select('*')
    .eq('supplier_id', supplierId).order('received_on', { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as SupplierDelivery[];
}

export async function storeRpc<N extends keyof RpcMapStore>(name: N, payload: Omit<RpcMapStore[N], 'op_id'>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc(name, { p: { op_id: Crypto.randomUUID(), ...payload } });
  if (error) throw new Error(error.message);
  return (data ?? {}) as Record<string, unknown>;
}
