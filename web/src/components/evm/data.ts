// Data layer for Earned Value (/evm, /evm/periods, /costs) and the Monthly Tasks Window (/lookahead).
// Contracts: lib/contract-schedule.ts (20261030000003_schedule_evm.sql) and lib/contract-lookahead.ts
// (20261030000004_lookahead.sql). Kept out of lib/ so the typed core `rpc()` stays untouched.
import type { AppRole } from '../../lib/contract';
import type { RpcMapSchedule, EvmPeriod, EvmBand } from '../../lib/contract-schedule';
import type { RpcMapLookahead } from '../../lib/contract-lookahead';
import { calendarPref } from '../../lib/calendar';
import { check, supabase } from '../../lib/supabase';
import { invalidateAfterWrite } from '../../lib/query';
import { useAsync } from '../../lib/hooks';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PlanRpcMap = RpcMapSchedule & RpcMapLookahead;
export type PlanPayload<N extends keyof PlanRpcMap> = DistOmit<PlanRpcMap[N], 'op_id'> & { op_id?: string };

/** EVM / look-ahead RPC with a fresh op_id; invalidates non-lookup queries like `rpc()`. */
export async function planRpc<N extends keyof PlanRpcMap>(name: N, payload: PlanPayload<N>): Promise<Record<string, unknown>> {
  const p = name === 'get_evm_timeseries' || name === 'get_lookahead_preview' ? payload : { op_id: crypto.randomUUID(), ...payload };
  const { data, error } = await supabase.rpc(name, { p });
  if (error) throw new Error(error.message);
  if (name !== 'get_evm_timeseries' && name !== 'get_lookahead_preview') invalidateAfterWrite();
  return (data ?? {}) as Record<string, unknown>;
}

/** Read-only RPC (no op_id, no invalidation). */
export async function planRead<T>(name: 'get_evm_timeseries' | 'get_lookahead_preview', p: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, { p });
  if (error) throw new Error(error.message);
  return data as T;
}

/** Amharic UI copy when the user's profile locale is am. */
export const isAm = () => calendarPref().locale === 'am';
export const tr = (en: string, am: string | null | undefined) => (isAm() && am ? am : en);

/** Today in East Africa Time (UTC+3), 'YYYY-MM-DD'. */
export const eatToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
};
/** ISO weekday 1 = Monday … 7 = Sunday. */
export const isoDow = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; };
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** Compact money for cards: "ETB 152.2 M" (full value in title). */
export function moneyShort(v: unknown, currency = 'ETB'): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(n / 1e9).toFixed(2)} B` : a >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : a >= 1e3 ? `${(n / 1e3).toFixed(1)} K` : n.toFixed(0);
  return `${currency} ${s}`;
}
export const idx = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Number(v).toFixed(2));
export const pct = (v: unknown, d = 1) => (v === null || v === undefined || v === '' ? '—' : `${Number(v).toFixed(d)} %`);

// ---------------------------------------------------------------------------
// Role lists (literals mirror SCHEDULE_PERMS / LA_PERMS so nav stays light)
// ---------------------------------------------------------------------------

export const PERIOD_OPEN_ROLES: AppRole[] = ['office_engineer', 'coordinator', 'manager', 'admin'];
export const PERIOD_CLOSE_ROLES: AppRole[] = ['coordinator', 'manager', 'admin'];
export const PERIOD_REOPEN_ROLES: AppRole[] = ['manager', 'admin'];
export const has = (roles: AppRole[], role: AppRole | null | undefined) => !!role && roles.includes(role);

// ---------------------------------------------------------------------------
// Schedules & periods
// ---------------------------------------------------------------------------

export interface SchedRow {
  id: string; code: string; name: string; status: string; status_date: string | null; fc_finish: string | null; es_finish: string | null;
  approved_baseline_id: string | null; planned_start: string | null; planned_finish: string | null;
}

export function useSchedules(projectId: string) {
  return useAsync(async () => check(await supabase.from('schedules')
    .select('id, code, name, status, status_date, fc_finish, es_finish, approved_baseline_id, planned_start, planned_finish')
    .eq('project_id', projectId).neq('status', 'archived').order('updated_at', { ascending: false })) as SchedRow[],
  [projectId], { key: 'evm-schedules', enabled: !!projectId });
}

export type PeriodRow = EvmPeriod & {
  project_id: string; prepared_by: string | null; prepared_at: string | null; closed_by: string | null; closed_at: string | null;
  close_comment: string | null; reopened_reason: string | null; reopen_count: number; created_at: string;
};

export function usePeriods(scheduleId: string | undefined) {
  return useAsync(async () => check(await supabase.from('evm_periods').select('*').eq('schedule_id', scheduleId!)
    .order('period_no', { ascending: false })) as PeriodRow[], [scheduleId], { key: 'evm-periods', enabled: !!scheduleId });
}

// ---------------------------------------------------------------------------
// Band words (icon + word, never colour alone)
// ---------------------------------------------------------------------------

export type BandTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
export const bandTone = (b: EvmBand | null | undefined): BandTone =>
  b === 'ok' ? 'success' : b === 'warning' ? 'warning' : b === 'critical' ? 'danger' : b === 'info' ? 'info' : 'neutral';

const BAND_WORDS = {
  schedule: { ok: ['On track', 'በዕቅዱ መሠረት'], warning: ['Behind', 'ወደኋላ የቀረ'], critical: ['Late', 'በጣም የዘገየ'], info: ['Ahead — check claims', 'ቀድሟል — ያረጋግጡ'] },
  cost: { ok: ['On budget', 'በበጀቱ መሠረት'], warning: ['Over budget', 'ከበጀት በላይ'], critical: ['Well over budget', 'ከበጀት እጅግ በላይ'], info: ['Under budget — check costs', 'ከበጀት በታች — ያረጋግጡ'] },
} as const;
export function bandWord(kind: 'schedule' | 'cost', b: EvmBand | null | undefined, value?: number | null): string {
  if (!b) return isAm() ? 'መረጃ የለም' : 'No data';
  if (kind === 'cost' && b === 'ok' && value != null && value >= 1.02) return isAm() ? 'ከበጀት በታች' : 'Under budget';
  const w = BAND_WORDS[kind][b];
  return isAm() ? w[1] : w[0];
}
