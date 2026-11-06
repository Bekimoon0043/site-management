// Re-import diff: compares parsed tasks with the tasks already stored for the schedule.
// Match by UID first, then GUID (docs/research/progress-evm.md §4.3). Unmatched existing tasks are "removed".
import type { ImportLink, ImportTask } from './types';

/** An existing DB task. Map DB columns (e.g. msp_uid / msp_guid) onto `uid` / `guid` before calling. */
export type ExistingTask = Partial<Omit<ImportTask, 'uid' | 'guid'>> & {
  /** DB row id, passed through untouched. */
  key?: string;
  uid: number | null;
  guid: string | null;
  name: string;
  /** Has verified progress; removal needs confirmation. */
  has_progress?: boolean;
};

export type DiffField = keyof Omit<ImportTask, 'uid' | 'guid' | 'id' | 'custom'>;
export const DEFAULT_DIFF_FIELDS: DiffField[] = [
  'name', 'wbs', 'outline_level', 'parent_uid', 'is_summary', 'is_milestone', 'start', 'finish', 'duration_days',
  'baseline_start', 'baseline_finish', 'baseline_cost', 'cost', 'constraint_type', 'constraint_date', 'boq_code',
];

export interface FieldChange { field: DiffField; from: unknown; to: unknown }
export interface ChangedTask { task: ImportTask; existing: ExistingTask; matched_by: 'uid' | 'guid'; changes: FieldChange[] }
export interface ScheduleDiff {
  added: ImportTask[];
  changed: ChangedTask[];
  /** Matched with no field changes. */
  unchanged: { task: ImportTask; existing: ExistingTask; matched_by: 'uid' | 'guid' }[];
  removed: ExistingTask[];
  /** Removed tasks that carry progress (need confirmation / remap). */
  removed_with_progress: ExistingTask[];
  links?: { added: ImportLink[]; removed: ImportLink[]; changed: { from: ImportLink; to: ImportLink }[] };
  summary: { added: number; changed: number; unchanged: number; removed: number; dates_changed: number };
}

const same = (a: unknown, b: unknown) => {
  if ((a == null || a === '') && (b == null || b === '')) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return a === b;
};

export function diffSchedule(
  parsed: ImportTask[],
  existing: ExistingTask[],
  opts: { fields?: DiffField[]; parsedLinks?: ImportLink[]; existingLinks?: ImportLink[] } = {},
): ScheduleDiff {
  const fields = opts.fields ?? DEFAULT_DIFF_FIELDS;
  const byUid = new Map<number, ExistingTask>();
  const byGuid = new Map<string, ExistingTask>();
  for (const e of existing) {
    if (e.uid != null) byUid.set(e.uid, e);
    if (e.guid) byGuid.set(e.guid.toUpperCase(), e);
  }
  const used = new Set<ExistingTask>();
  const out: ScheduleDiff = { added: [], changed: [], unchanged: [], removed: [], removed_with_progress: [],
    summary: { added: 0, changed: 0, unchanged: 0, removed: 0, dates_changed: 0 } };
  for (const t of parsed) {
    let e = byUid.get(t.uid);
    let matched_by: 'uid' | 'guid' = 'uid';
    if (!e || used.has(e)) {
      e = t.guid ? byGuid.get(t.guid.toUpperCase()) : undefined;
      matched_by = 'guid';
    }
    if (!e || used.has(e)) { out.added.push(t); continue; }
    used.add(e);
    const changes: FieldChange[] = [];
    for (const f of fields) if (f in e && !same(e[f], t[f])) changes.push({ field: f, from: e[f], to: t[f] });
    if (changes.length) {
      out.changed.push({ task: t, existing: e, matched_by, changes });
      if (changes.some((c) => c.field === 'start' || c.field === 'finish')) out.summary.dates_changed++;
    } else out.unchanged.push({ task: t, existing: e, matched_by });
  }
  for (const e of existing) if (!used.has(e)) { out.removed.push(e); if (e.has_progress) out.removed_with_progress.push(e); }

  if (opts.parsedLinks && opts.existingLinks) {
    const k = (l: ImportLink) => `${l.pred_uid}|${l.succ_uid}`;
    const oldMap = new Map(opts.existingLinks.map((l) => [k(l), l]));
    const newMap = new Map(opts.parsedLinks.map((l) => [k(l), l]));
    out.links = {
      added: opts.parsedLinks.filter((l) => !oldMap.has(k(l))),
      removed: opts.existingLinks.filter((l) => !newMap.has(k(l))),
      changed: opts.parsedLinks.filter((l) => { const o = oldMap.get(k(l)); return o && (o.type !== l.type || !same(o.lag_days, l.lag_days)); })
        .map((l) => ({ from: oldMap.get(k(l))!, to: l })),
    };
  }
  out.summary.added = out.added.length;
  out.summary.changed = out.changed.length;
  out.summary.unchanged = out.unchanged.length;
  out.summary.removed = out.removed.length;
  return out;
}
