// RPC + numbering helpers for the field & quality / site control pages
// (contracts: contract-field.ts, contract-control.ts). Lives beside lib/supabase.ts
// so the typed core `rpc()` stays untouched.
import { DEVICE_ID, supabase } from './supabase';
import { invalidateAfterWrite } from './query';
import { docNumber, type AppRole, type DocType } from './contract';
import { canField, type FieldAction, type RpcMapField } from './contract-field';
import { canControl, type ActionControl, type RpcMapControl } from './contract-control';
import { NAV } from '../nav';

type XMap = RpcMapField & RpcMapControl;
export type XName = keyof XMap;
type XPayload<N extends XName> = Omit<XMap[N], 'op_id'> & { op_id?: string };

/** Transactional field/control RPC with a fresh op_id; invalidates non-lookup queries like `rpc()`. */
export async function rpcx<N extends XName>(name: N, payload: XPayload<N>): Promise<Record<string, unknown>> {
  const p = { op_id: crypto.randomUUID(), ...payload };
  const { data, error } = await supabase.rpc(name, { p });
  if (error) throw new Error(error.message);
  invalidateAfterWrite();
  return (data ?? {}) as Record<string, unknown>;
}

/** Read-only RPC (get_diary_summary, sign_qr …) — no cache invalidation. */
export async function rpcRead<T>(name: XName, p: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, { p });
  if (error) throw new Error(error.message);
  return data as T;
}

let prefixP: Promise<string> | null = null;
/** This browser's device prefix (register_device is idempotent; cached per session). */
function devicePrefix(): Promise<string> {
  if (!prefixP) {
    prefixP = Promise.resolve(supabase.rpc('register_device', { p: { device_id: DEVICE_ID, name: 'Web console' } })).then(({ data, error }) => {
      if (error) { prefixP = null; throw new Error(error.message); }
      return (data as { prefix: string }).prefix;
    });
  }
  return prefixP;
}

/**
 * Next `<PROJECT>-<TYPE>-<DEVICE>-<SEQ>` number (FR-OF-06) for documents created on the web.
 * Sequence = highest existing number with this device prefix + 1.
 */
export async function nextNumber(projectCode: string, type: DocType, table: string): Promise<string> {
  const prefix = await devicePrefix();
  const stem = `${projectCode}-${type}-${prefix}-`;
  const { data, error } = await supabase.from(table).select('number').like('number', `${stem}%`).order('number', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const last = (data as { number: string }[] | null)?.[0]?.number;
  const n = last ? parseInt(last.slice(stem.length), 10) || 0 : 0;
  return docNumber(projectCode, type, prefix, n + 1);
}

export const uuid = () => crypto.randomUUID();

/** Optional number from a text input ('' → undefined). */
export const optNum = (v: string): number | undefined => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
/** Optional text ('' → undefined). */
export const optStr = (v: string | null | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);

export const ALL_ROLES: AppRole[] = ['store_keeper', 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'procurement', 'admin', 'security'];

/** Roles allowed any of these actions by canField / canControl. */
export const fieldRoles = (...a: FieldAction[]) => ALL_ROLES.filter((r) => a.some((x) => canField(r, x)));
export const controlRoles = (...a: ActionControl[]) => ALL_ROLES.filter((r) => a.some((x) => canControl(r, x)));

// Dev guard: the sidebar's literal role lists (nav.tsx) must match the contract permission maps.
if (import.meta.env.DEV) {
  const expect: Record<string, AppRole[]> = {
    '/diary': fieldRoles('diary.write', 'diary.sign'),
    '/quality': fieldRoles('inspection.request', 'inspection.perform', 'snag.create', 'snag.review'),
    '/concrete': fieldRoles('pour.write', 'pour.receiveTruck', 'cube.results', 'mix.edit'),
    '/rebar': [...new Set<AppRole>([...fieldRoles('bbs.edit', 'pour.write'), 'store_keeper'])],
    '/gate': controlRoles('gatepass.create', 'gatepass.verify', 'vehicle.log'),
    '/alerts': controlRoles('alert.manage'),
    '/qr-labels': controlRoles('qr.register'),
  };
  for (const [to, roles] of Object.entries(expect)) {
    const got = NAV.find((n) => n.to === to)?.roles ?? [];
    if (roles.length !== got.length || roles.some((r) => !got.includes(r))) console.warn(`nav.tsx roles for ${to} differ from the contract:`, got, 'expected', roles);
  }
}
