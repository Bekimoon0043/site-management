// In-app schedule editing + resources: RPC helper, "Predecessors" column parsing/formatting, loaders.
import { check, fetchAll, supabase } from '../../lib/supabase';
import { invalidateAfterWrite } from '../../lib/query';
import type { LinkType } from '../../lib/contract-schedule';
import type {
  PredecessorSpec, RpcMapScheduleEdit, ScheduleEdit, ScheduleResource, ScheduleResourceRate, TaskAssignment, TaskResourceCost,
} from '../../lib/contract-schedule-edit';
import type { SchedLink, SchedTask } from './data';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Transactional editing RPC with a fresh op_id; refreshes the cached schedule queries. */
export async function editRpc<N extends keyof RpcMapScheduleEdit>(name: N, payload: DistOmit<RpcMapScheduleEdit[N], 'op_id'>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc(name, { p: { op_id: crypto.randomUUID(), ...payload } });
  if (error) throw new Error(error.message);
  invalidateAfterWrite();
  return (data ?? {}) as Record<string, unknown>;
}

const LINK_TYPES: LinkType[] = ['FS', 'SS', 'FF', 'SF'];

const fmtNum = (n: number) => String(Math.round(n * 100) / 100);

/** MS Project style: "12", "12SS", "12FS+2d", "7FF-1d", "9SS+50%". */
export function formatPredecessor(uid: number, type: LinkType, lagDays: number): string {
  const lag = Number(lagDays) || 0;
  return `${uid}${type !== 'FS' || lag ? type : ''}${lag ? `${lag > 0 ? '+' : ''}${fmtNum(lag)}d` : ''}`;
}

export function formatPredecessors(taskId: string, links: SchedLink[] | undefined, byId: Map<string, SchedTask>): string {
  if (!links) return '';
  return links.filter((l) => l.succ_task_id === taskId)
    .map((l) => ({ uid: byId.get(l.pred_task_id)?.msp_uid ?? 0, l }))
    .sort((a, b) => a.uid - b.uid)
    .map(({ uid, l }) => formatPredecessor(uid, l.link_type, Number(l.lag_days))).join(', ');
}

/** Parses "12, 15SS, 20FS+2d, 7FF-1, 9SS+50%" into link specs; throws with a readable message. */
export function parsePredecessors(text: string, uids: Set<number>): PredecessorSpec[] {
  const out: PredecessorSpec[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const m = raw.toUpperCase().replace(/\s+/g, '').match(/^(\d+)(FS|SS|FF|SF)?(?:([+-])(\d+(?:\.\d+)?)(D|DAYS?|W|WK|%)?)?$/);
    if (!m) throw new Error(`"${raw}" — write it like 12, 12SS or 12FS+2d`);
    const uid = Number(m[1]);
    if (!uids.has(uid)) throw new Error(`Task ${uid} is not in this schedule`);
    const type = (m[2] ?? 'FS') as LinkType;
    if (!LINK_TYPES.includes(type)) throw new Error(`Unknown link type in "${raw}"`);
    const key = `${uid}${type}`;
    if (seen.has(key)) throw new Error(`${uid}${type} is listed twice`);
    seen.add(key);
    const sign = m[3] === '-' ? -1 : 1;
    const amount = m[4] ? Number(m[4]) * sign : 0;
    const unit = m[5] ?? 'D';
    if (unit === '%') out.push({ pred_uid: uid, link_type: type, lag_pct: amount });
    else out.push({ pred_uid: uid, link_type: type, lag_days: unit.startsWith('W') ? amount * 6 : amount });
  }
  return out;
}

/** "5", "5d", "5 days", "2w" (6-day weeks), "0" → working days; null when not a duration. */
export function parseDuration(text: string): number | null {
  const m = text.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(d|day|days|w|wk|wks|week|weeks)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2]?.startsWith('w') ? n * 6 : n;
}

export const loadResources = (projectId: string) => fetchAll<ScheduleResource>((a, b) => supabase.from('schedule_resources')
  .select('id, project_id, code, name, kind, unit, max_units, labour_trade_id, material_spec_id, notes, is_active')
  .eq('project_id', projectId).is('deleted_at', null).order('kind').order('code').range(a, b), 5000);

/** Rates are RLS-restricted to price roles (empty for others). */
export const loadResourceRates = (projectId: string) => fetchAll<ScheduleResourceRate>((a, b) => supabase.from('schedule_resource_rates')
  .select('resource_id, std_rate, cost_per_use').eq('project_id', projectId).range(a, b), 5000);

export const loadAssignments = (scheduleId: string) => fetchAll<TaskAssignment>((a, b) => supabase.from('task_assignments')
  .select('id, task_id, resource_id, units, notes').eq('schedule_id', scheduleId).is('deleted_at', null).range(a, b), 60000);

export const loadTaskCosts = (taskId: string) => supabase.from('v_task_resource_cost').select('*').eq('task_id', taskId)
  .then(check) as unknown as Promise<TaskResourceCost[]>;

export async function loadEdits(scheduleId: string): Promise<ScheduleEdit[]> {
  return check(await supabase.from('schedule_edits').select('id, action, task_id, summary, moved, undone_at, created_by, created_at')
    .eq('schedule_id', scheduleId).order('created_at', { ascending: false }).limit(40)) as ScheduleEdit[];
}

export async function loadTrades(): Promise<{ id: string; name: string }[]> {
  return check(await supabase.from('labour_trades').select('id, name').order('sort_order')) as { id: string; name: string }[];
}
