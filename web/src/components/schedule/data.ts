// Schedule data layer for the Planning pages (/schedule, /schedule/import) and the approvals previews.
// Contract: lib/contract-schedule.ts (migration 20261030000003_schedule_evm.sql). Kept out of lib/ so the
// typed core `rpc()` and other agents' modules stay untouched.
import type { AppRole } from '../../lib/contract';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { invalidateAfterWrite } from '../../lib/query';
import { num } from '../../lib/format';
import type {
  BaselineStatus, DiaryActivity, EvMethod, LinkType, RpcMapSchedule, Schedule, ScheduleTask, TaskBoqLink, TaskElementLink, TaskProgress,
} from '../../lib/contract-schedule';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SchedPayload<N extends keyof RpcMapSchedule> = DistOmit<RpcMapSchedule[N], 'op_id'> & { op_id?: string };

/** Transactional schedule RPC with a fresh op_id; invalidates non-lookup queries like `rpc()`. */
export async function schedRpc<N extends keyof RpcMapSchedule>(name: N, payload: SchedPayload<N>): Promise<Record<string, unknown>> {
  const p = { op_id: crypto.randomUUID(), ...payload };
  const { data, error } = await supabase.rpc(name, { p });
  if (error) throw new Error(error.message);
  invalidateAfterWrite();
  return (data ?? {}) as Record<string, unknown>;
}

/** Same role lists as SCHEDULE_PERMS (literals so nav/approvals don't pull the contract in). */
export const SCHEDULE_EDIT_ROLES: AppRole[] = ['office_engineer', 'coordinator', 'manager', 'admin'];
export const BASELINE_APPROVE_ROLES: AppRole[] = ['coordinator', 'manager', 'admin'];
export const PROGRESS_REPORT_ROLES: AppRole[] = ['site_engineer', ...SCHEDULE_EDIT_ROLES];
export const canEditSchedule = (role: AppRole | null | undefined) => !!role && SCHEDULE_EDIT_ROLES.includes(role);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type SchedTask = Pick<ScheduleTask,
  'id' | 'schedule_id' | 'msp_uid' | 'msp_guid' | 'wbs' | 'outline_level' | 'parent_id' | 'sort_order' | 'name' | 'is_summary' | 'is_milestone'
  | 'planned_start' | 'planned_finish' | 'baseline_start' | 'baseline_finish' | 'forecast_start' | 'forecast_finish' | 'actual_start' | 'actual_finish'
  | 'duration_days' | 'pct_complete' | 'reported_pct' | 'is_critical' | 'total_float_days' | 'free_float_days' | 'ev_method' | 'start_pct'
  | 'remaining_days' | 'custom' | 'source_state' | 'block_id' | 'level_id'> & { msp_critical: boolean | null; msp_pct_complete: number | null; notes: string | null;
    constraint_type: number | null; constraint_date: string | null; origin?: 'import' | 'app'; edited_at?: string | null;
    client_recovery_action: string | null; client_recovery_updated_at: string | null };

const TASK_COLS = 'id, schedule_id, msp_uid, msp_guid, wbs, outline_level, parent_id, sort_order, name, is_summary, is_milestone, planned_start, planned_finish, '
  + 'baseline_start, baseline_finish, forecast_start, forecast_finish, actual_start, actual_finish, duration_days, pct_complete, reported_pct, is_critical, '
  + 'total_float_days, free_float_days, ev_method, start_pct, remaining_days, custom, source_state, block_id, level_id, msp_critical, msp_pct_complete, notes, '
  + 'constraint_type, constraint_date, origin, edited_at, client_recovery_action, client_recovery_updated_at';

export interface SchedVersion { id: string; version_no: number; source: string; file_name: string | null; imported_by: string | null; imported_at: string; quality: Record<string, unknown> | null }
export type SchedHeader = Schedule & { calendar_id: string | null; forecast_run_at: string | null; currency_code: string };

export interface SchedLink { pred_task_id: string; succ_task_id: string; link_type: LinkType; lag_days: number }

export interface BaselineRow {
  id: string; schedule_id: string; baseline_no: number; name: string; source: 'msp_baseline' | 'current_plan'; msp_baseline_number: number | null;
  effective_from: string; reason: string | null; cost_source: string; status: BaselineStatus; task_count: number;
  proposed_by: string | null; proposed_at: string; approved_by: string | null; approved_at: string | null; decision_comment: string | null;
}

/** All schedules of the project (MASTER first) + the current version of each. */
export async function loadSchedules(projectId: string): Promise<{ schedules: SchedHeader[]; versions: Map<string, SchedVersion> }> {
  const schedules = check(await supabase.from('schedules').select('*').eq('project_id', projectId).neq('status', 'archived')
    .order('code')) as SchedHeader[];
  schedules.sort((a, b) => Number(b.code === 'MASTER') - Number(a.code === 'MASTER'));
  const ids = schedules.map((s) => s.current_version_id).filter(Boolean) as string[];
  const versions = new Map<string, SchedVersion>();
  if (ids.length) {
    const rows = check(await supabase.from('schedule_versions').select('id, version_no, source, file_name, imported_by, imported_at, quality').in('id', ids)) as SchedVersion[];
    for (const v of rows) versions.set(v.id, v);
  }
  return { schedules, versions };
}

export const loadTasks = (scheduleId: string) => fetchAll<SchedTask>((a, b) => supabase.from('schedule_tasks').select(TASK_COLS as '*')
  .eq('schedule_id', scheduleId).is('deleted_at', null).order('sort_order').order('msp_uid').range(a, b), 30000);

export const loadLinks = (scheduleId: string) => fetchAll<SchedLink>((a, b) => supabase.from('schedule_links')
  .select('pred_task_id, succ_task_id, link_type, lag_days').eq('schedule_id', scheduleId).is('deleted_at', null).range(a, b), 60000);

/** Task ids that have BoQ / element links, pending reports, and the ones I reported or verified. */
export async function loadTaskFlags(projectId: string, me: string) {
  const [boq, el, pending, mine] = await Promise.all([
    fetchAll<{ task_id: string }>((a, b) => supabase.from('task_boq_links').select('task_id').eq('project_id', projectId).is('deleted_at', null).range(a, b), 60000),
    fetchAll<{ task_id: string }>((a, b) => supabase.from('task_element_links').select('task_id').eq('project_id', projectId).is('deleted_at', null).range(a, b), 60000),
    fetchAll<{ task_id: string }>((a, b) => supabase.from('task_progress').select('task_id').eq('project_id', projectId).eq('status', 'reported').range(a, b), 20000),
    me ? fetchAll<{ task_id: string }>((a, b) => supabase.from('task_progress').select('task_id').eq('project_id', projectId)
      .or(`reported_by.eq.${me},verified_by.eq.${me}`).range(a, b), 20000) : Promise.resolve([]),
  ]);
  const count = (rows: { task_id: string }[]) => { const m = new Map<string, number>(); for (const r of rows) m.set(r.task_id, (m.get(r.task_id) ?? 0) + 1); return m; };
  return { boq: count(boq), elements: count(el), pending: count(pending), mine: new Set(mine.map((r) => r.task_id)) };
}
export type TaskFlags = Awaited<ReturnType<typeof loadTaskFlags>>;

export interface BoqItemRow { id: string; item_no: string; description: string; unit: string; quantity: number }
export const loadBoqItems = (projectId: string) => fetchAll<BoqItemRow>((a, b) => supabase.from('boq_items')
  .select('id, item_no, description, unit, quantity').eq('project_id', projectId).is('deleted_at', null).order('item_no').range(a, b), 20000);

export async function loadBaselines(scheduleId: string): Promise<BaselineRow[]> {
  return check(await supabase.from('schedule_baselines').select('*').eq('schedule_id', scheduleId).order('baseline_no', { ascending: false })) as BaselineRow[];
}

export interface TaskDetail {
  boq: (TaskBoqLink & { boq_items: { item_no: string; description: string; unit: string; quantity: number } | null })[];
  elements: TaskElementLink[];
  steps: { id: string; seq: number; name: string; weight: number; reported_pct: number; verified_pct: number }[];
  progress: (TaskProgress & { verify_comment: string | null; delay_cause: string | null; source: string; verified_at: string | null })[];
}
export async function loadTaskDetail(taskId: string): Promise<TaskDetail> {
  const [boq, elements, steps, progress] = await Promise.all([
    supabase.from('task_boq_links').select('*, boq_items(item_no, description, unit, quantity)').eq('task_id', taskId).is('deleted_at', null).then(check),
    supabase.from('task_element_links').select('*').eq('task_id', taskId).is('deleted_at', null).then(check),
    supabase.from('task_steps').select('id, seq, name, weight, reported_pct, verified_pct').eq('task_id', taskId).is('deleted_at', null).order('seq').then(check),
    supabase.from('task_progress').select('*').eq('task_id', taskId).order('status_date', { ascending: false }).order('created_at', { ascending: false }).limit(100).then(check),
  ]);
  return { boq, elements, steps, progress } as unknown as TaskDetail;
}

/** Default project calendar (weekend shading) — Mon–Sat when none is set. */
export async function loadWorkWeek(projectId: string): Promise<{ weekdays: number[]; holidays: Map<string, string> }> {
  const cal = check(await supabase.from('project_calendars').select('id, working_weekdays').eq('project_id', projectId).eq('is_default', true)
    .is('deleted_at', null).limit(1)) as { id: string; working_weekdays: number[] }[];
  const holidays = new Map<string, string>();
  const [ph, ex] = await Promise.all([
    supabase.from('public_holidays').select('on_date, name').is('deleted_at', null).limit(2000).then((r) => (r.data ?? []) as { on_date: string; name: string }[]),
    cal[0] ? supabase.from('calendar_exceptions').select('on_date, name, is_working').eq('calendar_id', cal[0].id).is('deleted_at', null).limit(5000)
      .then((r) => (r.data ?? []) as { on_date: string; name: string | null; is_working: boolean }[]) : Promise.resolve([]),
  ]);
  for (const h of ph) holidays.set(h.on_date, h.name);
  for (const e of ex) if (!e.is_working) holidays.set(e.on_date, e.name ?? 'Non-working day'); else holidays.delete(e.on_date);
  return { weekdays: cal[0]?.working_weekdays?.length ? cal[0].working_weekdays : [1, 2, 3, 4, 5, 6], holidays };
}

// ---------------------------------------------------------------------------
// Dates & status (naive 'YYYY-MM-DD'; integer day numbers, no Date per frame)
// ---------------------------------------------------------------------------

/** Days since 1970-01-01 for 'YYYY-MM-DD' (NaN when blank). */
export function dayNo(s: string | null | undefined): number {
  if (!s) return NaN;
  return Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
}
export const dayStr = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
export const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10-05' → '05 Oct 26' (compact, Gregorian — Gantt / tables). */
export function d2(s: string | null | undefined): string {
  if (!s) return '';
  return `${s.slice(8, 10)} ${MON[+s.slice(5, 7) - 1]} ${s.slice(2, 4)}`;
}

export type TaskState = 'not_started' | 'in_progress' | 'completed';
export const taskState = (t: Pick<SchedTask, 'pct_complete' | 'actual_start' | 'actual_finish'>): TaskState =>
  t.actual_finish || Number(t.pct_complete) >= 100 ? 'completed' : t.actual_start || Number(t.pct_complete) > 0 ? 'in_progress' : 'not_started';

/** Working-day-agnostic lateness in calendar days (0 = on time). Forecast vs baseline (or plan), else start missed / finish passed. */
export function lateDays(t: SchedTask, statusDay: number): number {
  if (t.is_summary || taskState(t) === 'completed') return 0;
  const ref = dayNo(t.baseline_finish ?? t.planned_finish);
  const fc = dayNo(t.forecast_finish);
  let late = 0;
  if (!Number.isNaN(fc) && !Number.isNaN(ref)) late = Math.max(late, fc - ref);
  if (!Number.isNaN(ref) && ref < statusDay) late = Math.max(late, statusDay - ref);
  const ps = dayNo(t.planned_start);
  if (taskState(t) === 'not_started' && !Number.isNaN(ps) && ps < statusDay) late = Math.max(late, statusDay - ps);
  return late;
}

export const EV_METHODS: EvMethod[] = ['units', 'elements', 'steps', '0_100', '50_50', 'pct', 'milestone', 'loe'];
/** Methods whose progress is not typed in (derived from elements / time). */
export const DERIVED_METHODS: EvMethod[] = ['elements', 'loe'];

/** Normalised code for matching (trim, lower-case, no spaces / dots / dashes). */
export const normCode = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[\s.\-_/]/g, '');

/** One daily output as text: "120 m3 (to date 200)" for quantities, else the percent / finished. */
export const outputText = (e: Pick<DiaryActivity, 'output' | 'pct_to_date' | 'method'>) =>
  e.output.length ? e.output.map((o) => `${num(o.qty_today, 2)} ${o.unit} (to date ${num(o.qty_to_date, 2)})`).join(', ')
    : e.method === 'pct' || e.method === 'steps' ? `${num(e.pct_to_date, 1)} % to date` : Number(e.pct_to_date) >= 100 ? 'Finished' : `${num(e.pct_to_date, 0)} %`;
