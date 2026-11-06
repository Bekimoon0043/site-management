// Monthly Tasks Window helpers: unified item shape (plan rows or pre-generation preview), month maths
// (Gregorian / Ethiopian), labels. Contract: lib/contract-lookahead.ts.
import type { AppRole } from '../../lib/contract';
import { ETHIOPIAN_MONTHS, fromEthiopian, toEthiopian } from '../../lib/contract-control';
import {
  CONSTRAINT_LABELS, READINESS_LABELS, WINDOW_ROLE_LABELS, canLookahead,
  type CalendarMode, type CommitmentKind, type CommitmentOutcome, type ConstraintType, type LookaheadAction, type LookaheadPlan,
  type Readiness, type RncCode, type WindowRole,
} from '../../lib/contract-lookahead';
import { addDays, isAm } from '../evm/data';

export interface LaCommit {
  id: string; week_id: string; week_start: string; week_no: number; kind: CommitmentKind; description: string; target_pct: number | null;
  outcome: CommitmentOutcome; rnc_code: RncCode | null; committed_by: string | null;
}
export interface LaItem {
  id: string; plan_id: string | null; schedule_task_id: string | null; name: string; window_role: WindowRole; is_milestone: boolean; is_critical: boolean;
  total_float_days: number | null; start: string | null; finish: string | null; pct: number; target_pct: number | null;
  week_days: Record<string, number>; responsible_id: string | null; responsible_name: string | null; readiness: Readiness | null;
  open_constraints: number; open_types: ConstraintType[]; worst_ctype: ConstraintType | null; worst_description: string | null; earliest_due: string | null;
  commitments: LaCommit[]; status: string; group_name: string | null; wbs: string | null; element_code: string | null; block_id: string | null;
  preview: boolean; preds_open?: number;
}
export interface LaWeek { id: string | null; week_no: number; week_start: string; week_end: string; working_days: number; in_buffer: boolean; status: string; ppc?: number | null; committed_count?: number | null; completed_count?: number | null }

const N = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function fromPlanRow(r: Record<string, unknown>): LaItem {
  return {
    id: String(r.id), plan_id: String(r.plan_id), schedule_task_id: (r.schedule_task_id as string) ?? null, name: String(r.name),
    window_role: r.window_role as WindowRole, is_milestone: !!r.is_milestone, is_critical: !!r.is_critical, total_float_days: N(r.total_float_days),
    start: (r.planned_start as string) ?? null, finish: (r.planned_finish as string) ?? (r.planned_start as string) ?? null,
    pct: Number(r.pct_complete ?? 0), target_pct: N(r.target_pct_end_of_period), week_days: (r.week_days as Record<string, number>) ?? {},
    responsible_id: (r.responsible_id as string) ?? null, responsible_name: (r.responsible_name as string) ?? null, readiness: (r.readiness as Readiness) ?? null,
    open_constraints: Number(r.open_constraints ?? 0), open_types: (r.open_types as ConstraintType[]) ?? [], worst_ctype: (r.worst_ctype as ConstraintType) ?? null,
    worst_description: (r.worst_description as string) ?? null, earliest_due: (r.earliest_due as string) ?? null,
    commitments: (r.commitments as LaCommit[]) ?? [], status: String(r.status ?? 'active'), group_name: (r.group_name as string) ?? null,
    wbs: (r.wbs as string) ?? null, element_code: (r.element_code as string) ?? null, block_id: (r.block_id as string) ?? null, preview: false,
  };
}
export function fromCandidate(c: Record<string, unknown>): LaItem {
  return {
    id: String(c.task_id), plan_id: null, schedule_task_id: String(c.task_id), name: String(c.name), window_role: c.window_role as WindowRole,
    is_milestone: !!c.is_milestone, is_critical: !!c.is_critical, total_float_days: N(c.total_float_days), start: (c.s as string) ?? null,
    finish: (c.f as string) ?? (c.s as string) ?? null, pct: Number(c.pct ?? 0), target_pct: N(c.expected_pct), week_days: (c.week_days as Record<string, number>) ?? {},
    responsible_id: null, responsible_name: null, readiness: null, open_constraints: 0, open_types: [], worst_ctype: Number(c.preds_open ?? 0) > 0 ? 'predecessor' : null,
    worst_description: Number(c.preds_open ?? 0) > 0 ? `${c.preds_open} predecessor(s) not finished` : null, earliest_due: null, commitments: [], status: 'active',
    group_name: (c.group_name as string) ?? null, wbs: (c.wbs as string) ?? null, element_code: null, block_id: null, preview: true, preds_open: Number(c.preds_open ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

export interface MonthSel { mode: CalendarMode; year: number; month: number }
export const monthKey = (m: MonthSel) => `${m.year}-${m.month}`;
export function parseMonth(s: string, mode: CalendarMode): MonthSel | null {
  const r = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (!r) return null;
  const month = Number(r[2]);
  return month >= 1 && month <= 12 ? { mode, year: Number(r[1]), month } : null;
}
export function monthOf(d: string, mode: CalendarMode): MonthSel {
  if (mode === 'gregorian') return { mode, year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) };
  const e = toEthiopian(d);
  return e.month === 13 ? { mode, year: e.year + 1, month: 1 } : { mode, year: e.year, month: e.month };
}
export function shiftMonth(m: MonthSel, n: number): MonthSel {
  const i = m.year * 12 + (m.month - 1) + n;
  return { mode: m.mode, year: Math.floor(i / 12), month: (i % 12) + 1 };
}
/** Same rule as app.la_period (Ethiopian Meskerem includes the preceding Pagume). */
export function monthRange(m: MonthSel): { start: string; end: string } {
  if (m.mode === 'gregorian') {
    const start = `${m.year}-${String(m.month).padStart(2, '0')}-01`;
    const end = new Date(Date.UTC(m.year, m.month, 0)).toISOString().slice(0, 10);
    return { start, end };
  }
  return { start: m.month === 1 ? fromEthiopian(m.year - 1, 13, 1) : fromEthiopian(m.year, m.month, 1), end: fromEthiopian(m.year, m.month, 30) };
}
const GREG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Title in the plan's calendar + the other calendar as a subtitle. */
export function monthTitle(m: MonthSel): { title: string; other: string } {
  const { start, end } = monthRange(m);
  const a = toEthiopian(start), b = toEthiopian(end);
  const am = ETHIOPIAN_MONTHS.am, en = ETHIOPIAN_MONTHS.en;
  if (m.mode === 'gregorian') {
    const eth = `${am[a.month - 1]}${a.month !== b.month ? `–${am[b.month - 1]}` : ''} ${b.year}`;
    return { title: `${GREG[m.month - 1]} ${m.year}`, other: eth };
  }
  const g = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return { title: `${isAm() ? am[m.month - 1] : en[m.month - 1]} ${m.year}`, other: `${isAm() ? en[m.month - 1] : am[m.month - 1]} · ${g(start)} – ${g(end)} ${end.slice(0, 4)}` };
}
export const planMatches = (p: LookaheadPlan, m: MonthSel) => p.calendar_mode === m.mode && p.period_year === m.year && p.period_month === m.month;

/** Monday of the week containing d. */
export const mondayOf = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return addDays(d, w === 0 ? -6 : 1 - w); };

// ---------------------------------------------------------------------------
// Labels & permissions
// ---------------------------------------------------------------------------

type L = { en: string; am: string };
export const lbl = (l: L | undefined, fallback = '') => (l ? (isAm() ? l.am : l.en) : fallback);
export const roleLabel = (r: WindowRole) => lbl(WINDOW_ROLE_LABELS[r], r);
export const readinessLabel = (r: Readiness | null) => (r ? lbl(READINESS_LABELS[r]) : isAm() ? 'አልተፈተሸም' : 'Not checked');
export const ctypeLabel = (c: ConstraintType | null) => (c ? lbl(CONSTRAINT_LABELS[c], c) : '');
export const ctypeShort = (c: ConstraintType | null) => (c ? CONSTRAINT_LABELS[c]?.short ?? c : '');
export const can = (role: AppRole | null | undefined, a: LookaheadAction) => canLookahead(role, a);
