// Helpers shared by the MSPDI and Excel readers.
import type { ImportSchedulePayload, ParsedSchedule as ContractParsedSchedule } from '../contract-schedule';
import type { ImportLink, ImportTask, ParsedSchedule, SourceLink } from './types';

/** Assigns `parent_uid` from outline order: parent = nearest preceding task with a lower outline level. */
export function assignParents(tasks: ImportTask[]): void {
  const stack: ImportTask[] = [];
  for (const t of tasks) {
    while (stack.length && stack[stack.length - 1].outline_level >= t.outline_level) stack.pop();
    t.parent_uid = stack.length ? stack[stack.length - 1].uid : null;
    stack.push(t);
  }
}

/**
 * Links that touch summary tasks are expanded to the summary's leaf descendants (MSP semantics).
 * Returns the leaf-only links (deduplicated; the larger lag wins for duplicates) and the source links annotated.
 */
export function expandSummaryLinks(tasks: ImportTask[], links: ImportLink[]): { links: ImportLink[]; source: SourceLink[] } {
  const byUid = new Map(tasks.map((t) => [t.uid, t]));
  const children = new Map<number, number[]>();
  for (const t of tasks) if (t.parent_uid != null) {
    const a = children.get(t.parent_uid) ?? [];
    a.push(t.uid);
    children.set(t.parent_uid, a);
  }
  const leafCache = new Map<number, number[]>();
  const leaves = (uid: number): number[] => {
    const hit = leafCache.get(uid);
    if (hit) return hit;
    const t = byUid.get(uid);
    const kids = children.get(uid) ?? [];
    const out = t?.is_summary && kids.length ? kids.flatMap(leaves) : [uid];
    leafCache.set(uid, out);
    return out;
  };
  const isAncestor = (a: number, b: number) => {
    for (let p = byUid.get(b)?.parent_uid ?? null, i = 0; p != null && i < 100; p = byUid.get(p)?.parent_uid ?? null, i++) if (p === a) return true;
    return false;
  };
  const source: SourceLink[] = [];
  const out = new Map<string, ImportLink>();
  for (const l of links) {
    const ps = !!byUid.get(l.pred_uid)?.is_summary, ss = !!byUid.get(l.succ_uid)?.is_summary;
    source.push({ ...l, pred_is_summary: ps, succ_is_summary: ss });
    for (const p of ps ? leaves(l.pred_uid) : [l.pred_uid]) for (const s of ss ? leaves(l.succ_uid) : [l.succ_uid]) {
      if (p === s || isAncestor(p, s) || isAncestor(s, p)) continue;
      const key = `${p}|${s}|${l.type}`;
      const prev = out.get(key);
      if (!prev || l.lag_days > prev.lag_days) out.set(key, { pred_uid: p, succ_uid: s, type: l.type, lag_days: l.lag_days });
    }
  }
  return { links: [...out.values()], source };
}

export interface ImportPayloadOptions {
  op_id: string;
  project_id: string;
  schedule_id?: string | null;
  version_id?: string;
  code?: string;
  /** Overrides the schedule name (header.name). */
  name?: string;
  /** Custom field (FieldName or alias) holding element codes, e.g. Text2 / "Element Codes" → task.element_codes. */
  elementField?: string | null;
  mapping?: ImportSchedulePayload['mapping'];
  options?: ImportSchedulePayload['options'];
}

const def = <T,>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);
const fieldKey = (s: ParsedSchedule, pick: string | null | undefined) => {
  if (!pick) return null;
  const p = pick.toLowerCase();
  return s.custom_fields.find((f) => f.field_name.toLowerCase() === p || f.alias?.toLowerCase() === p)?.field_name ?? pick;
};

/** Parsed schedule → the contract's ParsedSchedule (shared/contract-schedule.ts). Links are sent as written; the server expands summary links. */
export function toContractSchedule(s: ParsedSchedule, opts: { name?: string; elementField?: string | null } = {}): ContractParsedSchedule {
  const elKey = fieldKey(s, opts.elementField);
  return {
    source: s.source,
    file_name: s.file_name,
    file_sha256: s.file_sha256 ?? '',
    header: {
      name: opts.name ?? s.name, start_date: s.project_start, finish_date: def(s.project_finish), status_date: def(s.status_date),
      minutes_per_day: s.minutes_per_day, minutes_per_week: s.minutes_per_week,
      days_per_month: Math.round((s.minutes_per_week / s.minutes_per_day) * 4.33),
      currency_code: def(s.currency), baseline_for_ev: s.baseline_number, save_version: def(s.save_version),
    },
    calendars: s.calendars.map((c) => ({
      uid: c.uid, name: c.name, is_base: c.base_uid == null, base_uid: def(c.base_uid),
      week: ([0, 1, 2, 3, 4, 5, 6] as const).map((dow) => {
        const working = c.working_weekdays.includes(dow === 0 ? 7 : dow);
        return { dow, working, minutes: working ? Math.round(c.hours_per_day * 60) : 0 };
      }),
      exceptions: c.exceptions.map((e) => ({ from: e.from, to: e.to, working: e.is_working, name: def(e.name) })),
    })),
    project_calendar_uid: s.project_calendar_uid ?? s.calendars[0]?.uid ?? 0,
    tasks: s.tasks.map((t) => {
      const baseline = t.baseline_start || t.baseline_finish || t.baseline_cost != null
        ? [{ number: s.baseline_number, start: def(t.baseline_start), finish: def(t.baseline_finish),
            duration_days: def(t.baseline_duration_days), cost: def(t.baseline_cost) }]
        : undefined;
      return {
        uid: t.uid, guid: def(t.guid), id: t.id, name: t.name, wbs: def(t.wbs), outline_number: def(t.outline_number),
        outline_level: t.outline_level, parent_uid: def(t.parent_uid), is_summary: t.is_summary, is_milestone: t.is_milestone,
        start: t.start, finish: t.finish, duration_days: t.duration_days,
        constraint_type: def(t.constraint_type), constraint_date: def(t.constraint_date), calendar_uid: def(t.calendar_uid),
        critical: t.is_critical, total_float_days: def(t.total_float_days), free_float_days: def(t.free_float_days),
        pct_complete: def(t.pct_complete), physical_pct: def(t.physical_pct), actual_start: def(t.actual_start), actual_finish: def(t.actual_finish),
        cost: def(t.cost), baselines: baseline, custom: t.custom,
        boq_codes: def(t.boq_code), element_codes: elKey ? def(t.custom[elKey]) : undefined, notes: def(t.notes),
      };
    }),
    links: s.source_links.map((l) => ({ pred_uid: l.pred_uid, succ_uid: l.succ_uid, type: l.type, lag_days: l.lag_days })),
    resources: s.resources.map((r) => ({ ...r })),
    assignments: s.assignments.map((a) => ({ uid: a.uid, task_uid: a.task_uid, resource_uid: a.resource_uid, units: def(a.units),
      work_hours: def(a.work_hours), cost: def(a.cost), baseline_cost: def(a.baseline_cost) })),
    custom_fields: s.custom_fields.map((f) => ({ field_id: f.field_id ?? 0, field_name: f.field_name, alias: def(f.alias) })),
    warnings: s.warnings,
  };
}

/** Builds the import_schedule RPC payload (contract shape: { op_id, project_id, schedule_id?, schedule, mapping, options }). */
export function toImportPayload(s: ParsedSchedule, o: ImportPayloadOptions): ImportSchedulePayload {
  const p: ImportSchedulePayload = {
    op_id: o.op_id,
    project_id: o.project_id,
    schedule: toContractSchedule(s, { name: o.name, elementField: o.elementField }),
    mapping: o.mapping ?? { ...(s.boq_field ? { boq_field: s.boq_field } : {}), ...(o.elementField ? { element_field: fieldKey(s, o.elementField)! } : {}) },
    options: { baseline_number: s.baseline_number, ...o.options },
  };
  if (o.schedule_id) p.schedule_id = o.schedule_id;
  if (o.version_id) p.version_id = o.version_id;
  if (o.code) p.code = o.code;
  return p;
}
