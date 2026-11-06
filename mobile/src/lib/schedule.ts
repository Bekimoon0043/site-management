// Local reads for schedule progress ("My tasks"), task verification and the monthly
// tasks window (look-ahead). Pure SQL over the `rows` table; no network.
import type { BoqItem, Element } from './contract';
import type { ScheduleTask, TaskBoqLink, TaskElementLink, TaskProgress, PublicHoliday, CalendarException } from './contract-schedule';
import {
  canCommitWeek, readinessOf, worstConstraint, type LookaheadConstraint, type LookaheadItem, type LookaheadPlan,
  type LookaheadWeek, type Readiness, type WeeklyCommitment,
} from './contract-lookahead';
import type { AppRole } from './contract';
import { get, getDb, list } from './db';
import { addDays, isoDate, today } from './format';
import { activePlanIds } from './sync-schedule';

const j = (f: string, a = '') => `json_extract(${a ? `${a}.` : ''}json, '$.${f}')`;
const parse = <T>(rs: { json: string; pending?: string | null }[]): (T & { _pending?: string })[] =>
  rs.map((r) => { const o = JSON.parse(r.json) as T & { _pending?: string }; if (r.pending) o._pending = r.pending; return o; });

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Monday of the week containing iso. */
export function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return isoDate(d);
}
export function weeks() {
  const ws = mondayOf(today());
  return { thisStart: ws, thisEnd: addDays(ws, 6), nextStart: addDays(ws, 7), nextEnd: addDays(ws, 13) };
}
const DAY = 86400e3;
/** Linear planned % on calendar days at today. */
export function plannedPct(start: string | null, finish: string | null, at = today()): number | null {
  if (!start || !finish) return null;
  const s = new Date(`${start}T00:00:00`).getTime();
  const f = new Date(`${finish}T00:00:00`).getTime() + DAY;
  const n = new Date(`${at}T12:00:00`).getTime();
  if (f <= s) return n >= f ? 100 : 0;
  return Math.max(0, Math.min(100, ((n - s) / (f - s)) * 100));
}
export const daysBetween = (a: string, b: string) =>
  Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / DAY);

// ---------------------------------------------------------------------------
// Schedule tasks
// ---------------------------------------------------------------------------

export function activeScheduleIds(projectId: string): string[] {
  const rs = getDb().getAllSync<{ pk: string; s: string }>(
    `SELECT pk, ${j('status')} AS s FROM rows WHERE tbl = 'schedules' AND project_id = ? AND deleted = 0`, [projectId]);
  const active = rs.filter((r) => r.s === 'active').map((r) => r.pk);
  return active.length ? active : rs.filter((r) => r.s !== 'archived').map((r) => r.pk);
}

/** Schedule task ids assigned to me through the look-ahead (responsible) or my commitments. */
export function myTaskIds(projectId: string, userId: string): Set<string> {
  const plans = activePlanIds(projectId);
  if (!plans.length) return new Set();
  const inPlans = plans.map((p) => `'${p}'`).join(',');
  const rs = getDb().getAllSync<{ t: string | null }>(
    `SELECT ${j('schedule_task_id', 'i')} AS t FROM rows i WHERE i.tbl = 'lookahead_items' AND i.project_id = ? AND i.deleted = 0
       AND ${j('plan_id', 'i')} IN (${inPlans}) AND (${j('responsible_id', 'i')} = ?
         OR EXISTS (SELECT 1 FROM rows c WHERE c.tbl = 'weekly_commitments' AND c.parent = i.pk AND ${j('committed_by', 'c')} = ?))`,
    [projectId, userId, userId]);
  return new Set(rs.map((r) => r.t).filter((x): x is string => !!x));
}

export type AgendaSection = 'overdue' | 'this' | 'next';
export interface TaskRow {
  id: string; name: string; wbs: string | null; start: string | null; finish: string | null; pct: number; reported: number;
  planned: number | null; critical: boolean; milestone: boolean; method: string; elements: number; toVerify: boolean;
  lateDays: number; section: AgendaSection; sync: 'pending' | 'failed' | null;
}

/** Overdue / this week / next week agenda of leaf tasks (forecast dates when present). */
export function taskAgenda(projectId: string, userId: string, mine: boolean, sync: Map<string, 'pending' | 'failed'>): { rows: TaskRow[]; assigned: number } {
  const sids = activeScheduleIds(projectId);
  if (!sids.length) return { rows: [], assigned: 0 };
  const w = weeks();
  const d = today();
  const ids = myTaskIds(projectId, userId);
  const rs = getDb().getAllSync<{ json: string; pending: string | null; els: number; pend: number }>(
    `SELECT t.json AS json, t.pending AS pending,
       (SELECT COUNT(*) FROM rows l WHERE l.tbl = 'task_element_links' AND l.parent = t.pk AND l.deleted = 0) AS els,
       (SELECT COUNT(*) FROM rows p WHERE p.tbl = 'task_progress' AND p.parent = t.pk AND ${j('status', 'p')} = 'reported') AS pend
     FROM rows t WHERE t.tbl = 'schedule_tasks' AND t.project_id = ? AND t.deleted = 0
       AND ${j('schedule_id', 't')} IN (${sids.map((s) => `'${s}'`).join(',')})
       AND COALESCE(${j('is_summary', 't')}, 0) = 0 AND COALESCE(${j('source_state', 't')}, 'active') = 'active'
       AND CAST(COALESCE(${j('pct_complete', 't')}, 0) AS REAL) < 100
       AND COALESCE(${j('forecast_start', 't')}, ${j('planned_start', 't')}) <= ?
     ORDER BY COALESCE(${j('forecast_finish', 't')}, ${j('planned_finish', 't')}), CAST(${j('sort_order', 't')} AS INTEGER)`,
    [projectId, w.nextEnd]);
  const out: TaskRow[] = [];
  for (const r of rs) {
    const t = JSON.parse(r.json) as ScheduleTask;
    if (mine && ids.size && !ids.has(t.id)) continue;
    const start = t.forecast_start ?? t.planned_start;
    const finish = t.forecast_finish ?? t.planned_finish;
    let section: AgendaSection | null = null;
    if (finish && finish < d) section = 'overdue';
    else if (start && start <= w.thisEnd && (!finish || finish >= w.thisStart)) section = 'this';
    else if (start && start <= w.nextEnd && (!finish || finish >= w.nextStart)) section = 'next';
    if (!section) continue;
    out.push({
      id: t.id, name: t.name, wbs: t.wbs, start, finish, pct: Number(t.pct_complete ?? 0), reported: Number(t.reported_pct ?? 0),
      planned: plannedPct(t.planned_start, t.planned_finish), critical: !!t.is_critical, milestone: !!t.is_milestone,
      method: t.ev_method, elements: r.els, toVerify: r.pend > 0 || !!r.pending, lateDays: finish && finish < d ? daysBetween(finish, d) : 0,
      section, sync: sync.get(t.id) ?? null,
    });
  }
  const order: Record<AgendaSection, number> = { overdue: 0, this: 1, next: 2 };
  out.sort((a, b) => order[a.section] - order[b.section]);
  return { rows: out, assigned: ids.size };
}

export interface TaskDetail {
  task: ScheduleTask & { _pending?: string };
  boq: { link: TaskBoqLink; item: BoqItem | null }[];
  elements: { link: TaskElementLink; el: Element | null }[];
  steps: { id: string; seq: number; name: string; weight: number; reported_pct: number; verified_pct: number }[];
  history: (TaskProgress & { _pending?: string; delay_cause?: string | null; verify_comment?: string | null })[];
}
export function taskDetail(id: string): TaskDetail | null {
  const task = get<ScheduleTask>('schedule_tasks', id);
  if (!task) return null;
  return {
    task,
    boq: list<TaskBoqLink>('task_boq_links', { parent: id }).filter((l) => !l.deleted_at).map((link) => ({ link, item: get<BoqItem>('boq_items', link.boq_item_id) })),
    elements: list<TaskElementLink>('task_element_links', { parent: id }).filter((l) => !l.deleted_at).map((link) => ({ link, el: get<Element>('elements', link.element_id) })),
    steps: list<TaskDetail['steps'][number] & { deleted_at?: string | null }>('task_steps', { parent: id }).filter((s) => !s.deleted_at).sort((a, b) => a.seq - b.seq),
    history: list<TaskDetail['history'][number]>('task_progress', { parent: id }).sort((a, b) => b.created_at.localeCompare(a.created_at)),
  };
}

/** Task progress reports waiting for verification (not my own). */
export function tasksToVerify(projectId: string, userId: string) {
  return parse<TaskProgress & { delay_cause?: string | null; steps?: { step_id: string; done_pct: number }[] | null }>(getDb().getAllSync(
    `SELECT json, pending FROM rows WHERE tbl = 'task_progress' AND project_id = ? AND ${j('status')} = 'reported' AND ${j('reported_by')} != ?
     ORDER BY ${j('created_at')} ASC`, [projectId, userId]));
}

// ---------------------------------------------------------------------------
// Look-ahead
// ---------------------------------------------------------------------------

export function plansFor(projectId: string): LookaheadPlan[] {
  const ids = new Set(activePlanIds(projectId));
  return list<LookaheadPlan>('lookahead_plans', { project: projectId }).filter((p) => ids.has(p.id))
    .sort((a, b) => a.period_start.localeCompare(b.period_start));
}
/** The plan shown by default: current period in the preferred calendar, else any current, else next. */
export function defaultPlan(projectId: string, calendar: 'gregorian' | 'ethiopian'): LookaheadPlan | null {
  const ps = plansFor(projectId);
  const d = today();
  const cur = ps.filter((p) => p.period_start <= d && p.period_end >= d);
  return cur.find((p) => p.calendar_mode === calendar) ?? cur[0] ?? ps.find((p) => p.calendar_mode === calendar) ?? ps[0] ?? null;
}

export const planWeeks = (planId: string) =>
  list<LookaheadWeek>('lookahead_weeks', { parent: planId }).sort((a, b) => a.week_start.localeCompare(b.week_start));
export const itemConstraints = (itemId: string) =>
  list<LookaheadConstraint>('lookahead_constraints', { parent: itemId })
    .sort((a, b) => Number(b.status === 'blocked') - Number(a.status === 'blocked') || (a.due_date ?? '9').localeCompare(b.due_date ?? '9'));
export const itemCommitments = (itemId: string) => list<WeeklyCommitment>('weekly_commitments', { parent: itemId });
export const isOpenConstraint = (c: Pick<LookaheadConstraint, 'status'>) => c.status === 'open' || c.status === 'in_progress' || c.status === 'blocked';

export interface Holiday { date: string; name: string; nameAm: string | null; tentative: boolean }
export function holidaysBetween(projectId: string, from: string, to: string): Holiday[] {
  const hs = getDb().getAllSync<{ json: string }>(
    `SELECT json FROM rows WHERE tbl = 'public_holidays' AND deleted = 0 AND ${j('on_date')} BETWEEN ? AND ?`, [from, to])
    .map((r) => JSON.parse(r.json) as PublicHoliday)
    .map((h) => ({ date: h.on_date, name: h.name, nameAm: h.name_am, tentative: !!h.is_tentative }));
  const ex = getDb().getAllSync<{ json: string }>(
    `SELECT json FROM rows WHERE tbl = 'calendar_exceptions' AND project_id = ? AND deleted = 0 AND ${j('on_date')} BETWEEN ? AND ?
       AND COALESCE(${j('is_working')}, 0) = 0`, [projectId, from, to])
    .map((r) => JSON.parse(r.json) as CalendarException)
    .map((e) => ({ date: e.on_date, name: e.name ?? 'Non-working day', nameAm: null, tentative: false }));
  const seen = new Set<string>();
  return [...hs, ...ex].filter((h) => (seen.has(`${h.date}|${h.name}`) ? false : (seen.add(`${h.date}|${h.name}`), true)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface AgendaItem {
  id: string; name: string; role: LookaheadItem['window_role']; readiness: Readiness; critical: boolean; milestone: boolean;
  start: string | null; finish: string | null; pct: number; responsible: string | null; worst: string | null; worstType: string | null;
  committedThis: boolean; committedNext: boolean; outcomeThis: string | null; elementId: string | null; sync: 'pending' | 'failed' | null;
}
export type AgendaEntry =
  | { type: 'week'; key: string; week: LookaheadWeek; label: string }
  | { type: 'day'; key: string; date: string; holidays: Holiday[] }
  | { type: 'continuing'; key: string; n: number }
  | { type: 'item'; key: string; item: AgendaItem; continuing: boolean };

export function planItems(planId: string, sync: Map<string, 'pending' | 'failed'>): AgendaItem[] {
  const w = weeks();
  const wk = planWeeks(planId);
  const weekId = (start: string) => wk.find((x) => x.week_start === start)?.id ?? null;
  const thisId = weekId(mondayOf(today())) ?? wk.find((x) => x.week_start <= today() && x.week_end >= today())?.id ?? null;
  const nextId = weekId(w.nextStart) ?? wk.find((x) => x.week_start > today())?.id ?? null;
  return list<LookaheadItem>('lookahead_items', { parent: planId }).filter((i) => i.status === 'active').map((i) => {
    const cs = itemConstraints(i.id);
    const worst = worstConstraint(cs);
    const cm = itemCommitments(i.id).filter((c) => c.kind === 'commitment');
    const ct = cm.find((c) => c.week_id === thisId);
    return {
      id: i.id, name: i.name, role: i.window_role, readiness: cs.length ? readinessOf(cs, today()) : i.readiness, critical: !!i.is_critical,
      milestone: !!i.is_milestone, start: i.planned_start, finish: i.planned_finish, pct: Number(i.pct_complete ?? 0),
      responsible: i.responsible_id, worst: worst?.description ?? null, worstType: worst?.ctype ?? null,
      committedThis: !!ct, committedNext: cm.some((c) => c.week_id === nextId), outcomeThis: ct?.outcome ?? null,
      elementId: i.element_id, sync: sync.get(i.id) ?? null,
    };
  });
}

/** Month agenda: week header → "continuing" → day headers (holidays) → items starting that day. */
export function buildAgenda(plan: LookaheadPlan, items: AgendaItem[], holidays: Holiday[], range: { from: string; to: string } | null,
  weekLabel: (w: LookaheadWeek) => string): AgendaEntry[] {
  const out: AgendaEntry[] = [];
  for (const w of planWeeks(plan.id)) {
    if (range && (w.week_end < range.from || w.week_start > range.to)) continue;
    const inWeek = items.filter((i) => (i.start ?? w.week_start) <= w.week_end && (i.finish ?? i.start ?? w.week_start) >= w.week_start);
    const wh = holidays.filter((h) => h.date >= w.week_start && h.date <= w.week_end);
    if (!inWeek.length && !wh.length) continue;
    out.push({ type: 'week', key: `w:${w.id}`, week: w, label: weekLabel(w) });
    const cont = inWeek.filter((i) => (i.start ?? w.week_start) < w.week_start);
    if (cont.length) {
      out.push({ type: 'continuing', key: `c:${w.id}`, n: cont.length });
      cont.forEach((i) => out.push({ type: 'item', key: `i:${w.id}:${i.id}`, item: i, continuing: true }));
    }
    for (let k = 0; k < 7; k++) {
      const d = addDays(w.week_start, k);
      const starting = inWeek.filter((i) => (i.start ?? w.week_start) === d);
      const hs = wh.filter((h) => h.date === d);
      if (!starting.length && !hs.length) continue;
      out.push({ type: 'day', key: `d:${w.id}:${d}`, date: d, holidays: hs });
      starting.forEach((i) => out.push({ type: 'item', key: `i:${w.id}:${i.id}`, item: i, continuing: false }));
    }
  }
  return out;
}

/** PPC for the current week (so far) and the latest 4-week rolling value from local closed weeks. */
export function localPpc(planId: string): { thisDone: number; thisTotal: number; rolling: number | null } {
  const wk = planWeeks(planId);
  const d = today();
  const cur = wk.find((w) => w.week_start <= d && w.week_end >= d);
  const cm = cur ? list<WeeklyCommitment>('weekly_commitments', { project: cur.project_id }).filter((c) => c.week_id === cur.id && c.kind === 'commitment') : [];
  const closed = wk.filter((w) => w.status === 'closed' && w.week_end < d).slice(-4);
  const tot = closed.reduce((s, w) => s + (w.committed_count ?? 0), 0);
  const done = closed.reduce((s, w) => s + (w.completed_count ?? 0), 0);
  return { thisDone: cm.filter((c) => c.outcome === 'completed').length, thisTotal: cm.length, rolling: tot ? Math.round((1000 * done) / tot) / 10 : null };
}

export function weekFor(planId: string, which: 'this' | 'next'): LookaheadWeek | null {
  const wk = planWeeks(planId);
  const d = today();
  return which === 'this' ? wk.find((w) => w.week_start <= d && w.week_end >= d) ?? null : wk.find((w) => w.week_start > d) ?? null;
}

/** May this user commit this item for the week (role + responsible + week lock)? */
export function canCommitItem(item: Pick<LookaheadItem, 'responsible_id'>, week: LookaheadWeek | null, role: AppRole, userId: string, planStatus: string) {
  if (!week || planStatus !== 'published') return false;
  if (!(role === 'site_engineer' || role === 'coordinator' || role === 'admin')) return false;
  if (role === 'site_engineer' && item.responsible_id && item.responsible_id !== userId) return false;
  return canCommitWeek(week, today(), role);
}
