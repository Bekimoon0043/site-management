// DCMA-14-style schedule quality checks for the import preview (docs/research/progress-evm.md §6).
// They warn; only duplicate UIDs and logic cycles are blocking.
import type { ParsedSchedule } from './types';
import { HARD_CONSTRAINTS, MSP_CONSTRAINTS } from './units';

export type QualitySeverity = 'ok' | 'info' | 'warning' | 'error';
export type QualityCheckId =
  | 'missing_logic' | 'negative_float' | 'missing_baseline' | 'high_duration' | 'hard_constraints' | 'leads'
  | 'summary_links' | 'missing_boq' | 'high_float' | 'lags' | 'non_fs_links' | 'duplicate_uids' | 'cycles' | 'calendar';

export interface QualityExample { uid: number; name: string; detail?: string }
export interface QualityCheck {
  id: QualityCheckId;
  label: string;
  count: number;
  /** Population the count is measured against (leaf tasks, links…). */
  total: number;
  pct: number;
  /** Target ratio (0.05 = 5 %); 0 means "should be none". */
  threshold: number;
  severity: QualitySeverity;
  blocking: boolean;
  examples: QualityExample[];
  hint?: string;
}
export interface QualityReport {
  checks: QualityCheck[];
  leaf_count: number;
  link_count: number;
  blocking: boolean;
  /** Count of checks at warning/error. */
  issues: number;
}

export interface QualityOptions {
  highDurationDays?: number;
  highFloatDays?: number;
  maxExamples?: number;
  /** Treat level-of-effort tasks (name matches) as exempt from the high-duration check. */
  loePattern?: RegExp;
}

export function qualityReport(s: ParsedSchedule, o: QualityOptions = {}): QualityReport {
  const maxEx = o.maxExamples ?? 5;
  const highDur = o.highDurationDays ?? 44;
  const highFloat = o.highFloatDays ?? 44;
  const loe = o.loePattern ?? /\b(LOE|level of effort)\b/i;
  const leaves = s.tasks.filter((t) => !t.is_summary);
  const byUid = new Map(s.tasks.map((t) => [t.uid, t]));
  const hasPred = new Set(s.links.map((l) => l.succ_uid));
  const hasSucc = new Set(s.links.map((l) => l.pred_uid));
  const checks: QualityCheck[] = [];
  const ex = (uid: number, detail?: string): QualityExample => ({ uid, name: byUid.get(uid)?.name ?? `#${uid}`, detail });

  const add = (id: QualityCheckId, label: string, items: QualityExample[], total: number, threshold: number,
    opts: { blocking?: boolean; hint?: string; info?: boolean } = {}) => {
    const count = items.length;
    const pct = total ? count / total : 0;
    const severity: QualitySeverity = count === 0 ? 'ok' : opts.blocking ? 'error' : opts.info ? 'info'
      : pct > threshold ? 'warning' : 'info';
    checks.push({ id, label, count, total, pct: Math.round(pct * 1000) / 10, threshold, severity, blocking: !!opts.blocking && count > 0,
      examples: items.slice(0, maxEx), hint: opts.hint });
  };

  // Blocking: duplicate UIDs, cycles
  const seen = new Map<number, number>();
  for (const t of s.tasks) seen.set(t.uid, (seen.get(t.uid) ?? 0) + 1);
  add('duplicate_uids', 'Duplicate Unique IDs', [...seen].filter(([, n]) => n > 1).map(([u, n]) => ex(u, `${n}×`)), s.tasks.length, 0, { blocking: true });
  add('cycles', 'Logic loops (circular links)', findCycleTasks(s).map((u) => ex(u)), leaves.length, 0, { blocking: true,
    hint: 'Fix the loop in MS Project before importing' });

  const incomplete = leaves.filter((t) => (t.pct_complete ?? 0) < 100);
  add('missing_logic', 'Missing logic (no predecessor or no successor)', incomplete
    .filter((t) => !hasPred.has(t.uid) || !hasSucc.has(t.uid))
    .map((t) => ex(t.uid, [!hasPred.has(t.uid) && 'no predecessor', !hasSucc.has(t.uid) && 'no successor'].filter(Boolean).join(', '))),
  incomplete.length, 0.05, { hint: 'Every unfinished task needs a predecessor and a successor (except the start and finish milestones)' });

  add('negative_float', 'Negative float', leaves.filter((t) => (t.total_float_days ?? 0) < 0)
    .map((t) => ex(t.uid, `${t.total_float_days} d`)), leaves.length, 0, { hint: 'A constraint or deadline cannot be met' });

  add('missing_baseline', 'No baseline dates', leaves.filter((t) => !t.baseline_start || !t.baseline_finish).map((t) => ex(t.uid)),
    leaves.length, 0, { hint: s.tasks.some((t) => t.baseline_start) ? 'Tasks added after the baseline was saved' : 'Offer "baseline from current plan"' });

  add('high_duration', `Durations over ${highDur} working days`, leaves
    .filter((t) => !t.is_milestone && t.duration_days > highDur && !loe.test(t.name))
    .map((t) => ex(t.uid, `${t.duration_days} d`)), leaves.length, 0.05, { hint: 'Split long tasks for measurable progress' });

  add('high_float', `Float over ${highFloat} working days`, incomplete.filter((t) => (t.total_float_days ?? 0) > highFloat)
    .map((t) => ex(t.uid, `${t.total_float_days} d`)), incomplete.length, 0.05, { hint: 'Usually a missing successor' });

  add('hard_constraints', 'Hard constraints (MSO/MFO/SNLT/FNLT)', leaves
    .filter((t) => t.constraint_type != null && HARD_CONSTRAINTS.has(t.constraint_type))
    .map((t) => ex(t.uid, `${MSP_CONSTRAINTS[t.constraint_type!]} ${t.constraint_date ?? ''}`.trim())), leaves.length, 0.05);

  const src = s.source_links;
  add('leads', 'Leads (negative lag)', src.filter((l) => l.lag_days < 0)
    .map((l) => ex(l.succ_uid, `${l.pred_uid}${l.type}${l.lag_days}d`)), src.length, 0);
  add('lags', 'Links with lag', src.filter((l) => l.lag_days > 0).map((l) => ex(l.succ_uid, `${l.pred_uid}${l.type}+${l.lag_days}d`)),
    src.length, 0.05, { info: true });
  add('non_fs_links', 'Non-FS links', src.filter((l) => l.type !== 'FS').map((l) => ex(l.succ_uid, `${l.pred_uid}${l.type}`)),
    src.length, 0.1, { info: true, hint: '≥ 90 % FS recommended; SF ≈ 0' });
  add('summary_links', 'Links on summary tasks (expanded to leaf tasks)', src.filter((l) => l.pred_is_summary || l.succ_is_summary)
    .map((l) => ex(l.succ_uid, `${byUid.get(l.pred_uid)?.name ?? l.pred_uid} → ${byUid.get(l.succ_uid)?.name ?? l.succ_uid}`)), src.length, 0);

  const workLeaves = leaves.filter((t) => !t.is_milestone);
  add('missing_boq', 'Tasks without a BoQ code', workLeaves.filter((t) => !t.boq_code).map((t) => ex(t.uid)), workLeaves.length, 0,
    { info: true, hint: 'Map them after import, or add the code in the BoQ custom field' });

  const cal = s.calendars.find((c) => c.uid === s.project_calendar_uid) ?? s.calendars[0];
  const holidays = cal ? cal.exceptions.filter((e) => !e.is_working).length : 0;
  checks.push({
    id: 'calendar', label: cal ? `Calendar: ${cal.working_weekdays.length}-day week, ${holidays} holiday(s)` : 'No calendar in file',
    count: holidays === 0 ? 1 : 0, total: 1, pct: 0, threshold: 0, severity: holidays === 0 ? 'warning' : 'ok', blocking: false, examples: [],
    hint: holidays === 0 ? 'No holidays found — load the Ethiopian public holiday list' : undefined,
  });

  return {
    checks, leaf_count: leaves.length, link_count: s.links.length,
    blocking: checks.some((c) => c.blocking), issues: checks.filter((c) => c.severity === 'warning' || c.severity === 'error').length,
  };
}

/** UIDs of tasks on (or downstream of) a logic loop: the nodes Kahn's algorithm cannot order. */
export function findCycleTasks(s: Pick<ParsedSchedule, 'links' | 'tasks'>): number[] {
  const indeg = new Map<number, number>();
  const out = new Map<number, number[]>();
  for (const t of s.tasks) { indeg.set(t.uid, 0); out.set(t.uid, []); }
  for (const l of s.links) {
    if (!out.has(l.pred_uid) || !indeg.has(l.succ_uid)) continue;
    out.get(l.pred_uid)!.push(l.succ_uid);
    indeg.set(l.succ_uid, indeg.get(l.succ_uid)! + 1);
  }
  const q = [...indeg].filter(([, d]) => d === 0).map(([u]) => u);
  while (q.length) {
    const u = q.pop()!;
    for (const v of out.get(u)!) { const d = indeg.get(v)! - 1; indeg.set(v, d); if (d === 0) q.push(v); }
  }
  return [...indeg].filter(([, d]) => d > 0).map(([u]) => u);
}
