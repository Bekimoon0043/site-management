import { createClient } from '@supabase/supabase-js';
import type { RpcMap, RpcName } from './contract';
import { invalidateAfterWrite } from './query';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const configured = !!url && !!anonKey;

// Persistent per-browser id, sent as x-device-id for the audit trail (FR-AU-01).
function deviceId(): string {
  const key = 'site-console-device-id';
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
export const DEVICE_ID = deviceId();

export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'missing', {
  global: { headers: { 'x-device-id': DEVICE_ID } },
});

/** Raises a readable Error from a Supabase error object. */
export function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

type Payload<N extends RpcName> = Omit<RpcMap[N], 'op_id'> & { op_id?: string };

/** Calls a transactional RPC with a fresh op_id. */
export async function rpc<N extends RpcName>(name: N, payload: Payload<N>): Promise<Record<string, unknown>> {
  const p = { op_id: crypto.randomUUID(), ...payload };
  const { data, error } = await supabase.rpc(name, { p });
  if (error) throw new Error(error.message);
  // Business writes change lists, counts and badges everywhere — mark the cache stale.
  invalidateAfterWrite();
  return data as Record<string, unknown>;
}

/** Calls the admin-users edge function, surfacing its { error } body. */
export async function adminUsers<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('admin-users', { body });
  if (error) {
    let msg = error.message;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = (await ctx.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch { /* keep message */ }
    }
    throw new Error(msg);
  }
  if (data && typeof data === 'object' && 'error' in data) throw new Error(String((data as { error: unknown }).error));
  return data as T;
}

/** Row count without downloading rows (HEAD request, exact count). */
export async function countRows(build: () => PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> {
  const { count, error } = await build();
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Fetches every row of a query in pages of 1000 (PostgREST max rows). */
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  max = 20000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
