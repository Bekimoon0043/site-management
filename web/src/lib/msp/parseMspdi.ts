// MS Project XML (MSPDI) reader → normalised schedule (docs/research/progress-evm.md §1.2–1.3).
// Reads DIRECT child elements only: UID/Start/Finish/Type also occur inside Baseline, PredecessorLink and
// TimephasedData, so getElementsByTagName would return the wrong values.
// Works with the browser DOMParser (main thread) or @xmldom/xmldom (Web Worker / Node) via `opts.DOMParser`.
import { assignParents, expandSummaryLinks } from './common';
import type {
  CustomFieldDef, ImportAssignment, ImportCalendar, ImportCalendarException, ImportLink, ImportResource, ImportTask,
  ParseOptions, ParsedSchedule, ResourceType,
} from './types';
import {
  MSP_CONSTRAINTS, MSP_LINK_TYPES, PERCENT_FORMATS, boqCodeFromName, cleanBoq, datePart, isoDurMinutes, prevWorkingDay,
  round2, tenthsToDays, timePart, toDays,
} from './units';

export const MSPDI_NS = 'http://schemas.microsoft.com/project';

/** Well-known FieldIDs, used when ExtendedAttributes lacks a FieldName. */
const KNOWN_FIELD_IDS: Record<number, string> = {
  188743731: 'Text1', 188743734: 'Text2', 188743737: 'Text3', 188743740: 'Text4', 188743743: 'Text5',
  188743767: 'Number1', 188743768: 'Number2', 188743769: 'Number3', 188743770: 'Number4', 188743771: 'Number5',
  188743786: 'Cost1', 188743787: 'Cost2', 188743788: 'Cost3',
};

/** Custom Cost1..Cost10 values are written in hundredths like task Cost (scaled by currencyScale). */
export const isCustomCostField = (fieldName: string) => /^cost([1-9]|10)$/i.test(fieldName);

// Minimal structural DOM types (satisfied by both lib.dom and xmldom).
interface XNode { nodeType: number; localName?: string | null; nodeName: string; textContent: string | null; childNodes: ArrayLike<XNode> }

const kids = (el: XNode | null, n: string): XNode[] => {
  const out: XNode[] = [];
  if (!el) return out;
  const cn = el.childNodes;
  for (let i = 0; i < cn.length; i++) {
    const c = cn[i];
    if (c.nodeType === 1 && (c.localName ?? c.nodeName.replace(/^.*:/, '')) === n) out.push(c);
  }
  return out;
};
const kid = (el: XNode | null, n: string) => kids(el, n)[0] ?? null;
const txt = (el: XNode | null, n: string) => kid(el, n)?.textContent?.trim() || null;
const num = (el: XNode | null, n: string) => { const t = txt(el, n); if (t == null) return null; const v = Number(t); return Number.isFinite(v) ? v : null; };
const bool = (el: XNode | null, n: string) => txt(el, n) === '1';

const hhmmToMin = (s: string | null) => (s ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)) : null);

interface RawCal {
  cal: ImportCalendar;
  hasWeek: boolean;
  dayStart: string | null;
}

function readCalendars(root: XNode, minutesPerDay: number, warnings: string[]): Map<number, RawCal> {
  const out = new Map<number, RawCal>();
  for (const c of kids(kid(root, 'Calendars'), 'Calendar')) {
    const uid = num(c, 'UID');
    if (uid == null) continue;
    const baseUid = num(c, 'BaseCalendarUID');
    const working: number[] = [];
    const dayMinutes: number[] = [];
    let dayStart: string | null = null;
    const exceptions: ImportCalendarException[] = [];
    const weekDays = kids(kid(c, 'WeekDays'), 'WeekDay');
    for (const wd of weekDays) {
      const dt = num(wd, 'DayType');
      const on = bool(wd, 'DayWorking');
      if (dt === 0) {
        // Legacy exception entry (pre-2007 style; 2007+ duplicates them in <Exceptions>).
        const tp = kid(wd, 'TimePeriod');
        const from = datePart(txt(tp, 'FromDate')), to = datePart(txt(tp, 'ToDate'));
        if (from && to) exceptions.push({ from, to, is_working: on, name: null });
        continue;
      }
      if (dt == null || dt < 1 || dt > 7) continue;
      if (!on) continue;
      working.push(dt === 1 ? 7 : dt - 1);
      let mins = 0;
      for (const w of kids(kid(wd, 'WorkingTimes'), 'WorkingTime')) {
        const f = txt(w, 'FromTime'), t = txt(w, 'ToTime');
        const a = hhmmToMin(f), b = hhmmToMin(t);
        if (a == null || b == null) continue;
        mins += (b <= a ? b + 1440 : b) - a;
        if (f && (!dayStart || f < dayStart)) dayStart = f.slice(0, 5);
      }
      if (mins > 0) dayMinutes.push(mins);
    }
    for (const e of kids(kid(c, 'Exceptions'), 'Exception')) {
      const tp = kid(e, 'TimePeriod');
      const from = datePart(txt(tp, 'FromDate')), to = datePart(txt(tp, 'ToDate'));
      if (!from || !to) continue;
      if ((num(e, 'Occurrences') ?? 1) > 1 && from !== to && num(e, 'Type') !== 1) {
        warnings.push(`Calendar "${txt(c, 'Name')}": recurring exception "${txt(e, 'Name') ?? ''}" read as a single date range`);
      }
      const is_working = bool(e, 'DayWorking');
      const name = txt(e, 'Name');
      const dup = exceptions.findIndex((x) => x.from === from && x.to === to);
      if (dup >= 0) exceptions[dup] = { from, to, is_working, name: name ?? exceptions[dup].name };
      else exceptions.push({ from, to, is_working, name });
    }
    if (kids(kid(c, 'WorkWeeks'), 'WorkWeek').length) warnings.push(`Calendar "${txt(c, 'Name')}": alternative work weeks are ignored`);
    exceptions.sort((a, b) => a.from.localeCompare(b.from));
    working.sort((a, b) => a - b);
    const avg = dayMinutes.length ? dayMinutes.reduce((a, b) => a + b, 0) / dayMinutes.length : minutesPerDay;
    out.set(uid, {
      cal: {
        uid, name: txt(c, 'Name') ?? `Calendar ${uid}`,
        base_uid: baseUid != null && baseUid >= 0 && baseUid !== uid ? baseUid : null,
        working_weekdays: working, hours_per_day: round2(avg / 60), exceptions,
      },
      hasWeek: weekDays.some((w) => (num(w, 'DayType') ?? 0) > 0),
      dayStart,
    });
  }
  // Derived calendars (resource/task) inherit week pattern + holidays from their base calendar.
  const resolve = (r: RawCal, depth = 0): RawCal => {
    if (depth > 10 || r.cal.base_uid == null) return r;
    const base = out.get(r.cal.base_uid);
    if (!base) return r;
    const b = resolve(base, depth + 1);
    if (!r.hasWeek) {
      r.cal.working_weekdays = [...b.cal.working_weekdays];
      r.cal.hours_per_day = b.cal.hours_per_day;
      r.dayStart = r.dayStart ?? b.dayStart;
      r.hasWeek = true;
    }
    const own = new Set(r.cal.exceptions.map((e) => `${e.from}|${e.to}`));
    r.cal.exceptions = [...r.cal.exceptions, ...b.cal.exceptions.filter((e) => !own.has(`${e.from}|${e.to}`))]
      .sort((x, y) => x.from.localeCompare(y.from));
    return r;
  };
  for (const r of out.values()) resolve(r);
  return out;
}

export class MspdiError extends Error {}

export function parseMspdi(text: string, fileName = 'schedule.xml', opts: ParseOptions = {}): ParsedSchedule {
  const warnings: string[] = [];
  const DP = opts.DOMParser ?? (globalThis as { DOMParser?: ParseOptions['DOMParser'] }).DOMParser;
  if (!DP) throw new MspdiError('No XML parser available (pass opts.DOMParser in a worker)');
  let doc: { documentElement: XNode | null; getElementsByTagName?: (n: string) => ArrayLike<unknown> };
  try {
    doc = new DP().parseFromString(text.replace(/^﻿/, ''), 'text/xml') as typeof doc;
  } catch (e) {
    throw new MspdiError(`Not a valid XML file: ${(e as Error).message.split('\n')[0]}`);
  }
  const root = doc.documentElement;
  if (!root || (doc.getElementsByTagName && doc.getElementsByTagName('parsererror').length)) {
    throw new MspdiError('Not a valid XML file');
  }
  const rootName = root.localName ?? root.nodeName;
  if (rootName !== 'Project') {
    throw new MspdiError('This is not an MS Project XML file. In MS Project use File › Save As › XML Format (*.xml).');
  }
  const ns = (root as { namespaceURI?: string | null }).namespaceURI;
  if (ns !== MSPDI_NS) warnings.push(`Unexpected XML namespace "${ns ?? ''}" — expected ${MSPDI_NS}`);
  if (txt(root, 'ScheduleFromStart') === '0') warnings.push('Project is scheduled from the finish date; dates are read as written');

  const minutesPerDay = num(root, 'MinutesPerDay') || 480;
  const minutesPerWeek = num(root, 'MinutesPerWeek') || minutesPerDay * 5;
  const scale = opts.currencyScale ?? 100;
  const money = (v: number | null) => (v == null ? null : round2(v / scale));
  const baselineNo = opts.baselineNumber ?? 0;
  const projectCalUid = num(root, 'CalendarUID');

  // Custom-field dictionary
  const custom_fields: CustomFieldDef[] = [];
  const fieldById = new Map<number, CustomFieldDef>();
  for (const ea of kids(kid(root, 'ExtendedAttributes'), 'ExtendedAttribute')) {
    const id = num(ea, 'FieldID');
    const def: CustomFieldDef = {
      field_id: id,
      field_name: txt(ea, 'FieldName') ?? (id != null ? KNOWN_FIELD_IDS[id] ?? `Field${id}` : 'Unknown'),
      alias: txt(ea, 'Alias'),
    };
    // Some files define the same field twice (same FieldID / FieldName, often the same alias): keep one, prefer an alias.
    const dup = custom_fields.find((f) => (id != null && f.field_id === id) || f.field_name.toLowerCase() === def.field_name.toLowerCase());
    if (dup) { if (!dup.alias && def.alias) dup.alias = def.alias; continue; }
    custom_fields.push(def);
    if (id != null) fieldById.set(id, def);
  }
  const fieldName = (id: number) => fieldById.get(id)?.field_name ?? KNOWN_FIELD_IDS[id] ?? `Field${id}`;
  const boqField = resolveField(custom_fields, opts.boqField);
  if (opts.boqField && !boqField) warnings.push(`Custom field "${opts.boqField}" not found in this file`);

  // Calendars
  const rawCals = readCalendars(root, minutesPerDay, warnings);
  const calendars = [...rawCals.values()].map((r) => r.cal);
  const projCal = (projectCalUid != null ? rawCals.get(projectCalUid) : undefined) ?? rawCals.values().next().value;
  const calFor = (uid: number | null) => (uid != null ? rawCals.get(uid) : undefined) ?? projCal;
  const defaultDayStart = txt(root, 'DefaultStartTime')?.slice(0, 5) ?? '08:00';

  // Tasks
  const taskEls = kids(kid(root, 'Tasks'), 'Task');
  opts.onProgress?.({ stage: 'tasks', done: 0, total: taskEls.length });
  const tasks: ImportTask[] = [];
  const kept = new Set<number>();
  const rawLinks: { el: XNode; succ: number }[] = [];
  let projectCost: number | null = null;
  let skippedInactive = 0, skippedExternal = 0, manual = 0;
  taskEls.forEach((el, i) => {
    if (i % 500 === 0) opts.onProgress?.({ stage: 'tasks', done: i, total: taskEls.length });
    const uid = num(el, 'UID');
    if (uid == null) return;
    const level = num(el, 'OutlineLevel') ?? 1;
    if (uid === 0 || level === 0) { projectCost = money(num(el, 'Cost')); return; }
    if (bool(el, 'IsNull')) return;
    if (txt(el, 'Active') === '0') { skippedInactive++; return; }
    if (bool(el, 'ExternalTask') || bool(el, 'IsSubproject')) { skippedExternal++; return; }
    if (bool(el, 'Manual')) manual++;
    const name = txt(el, 'Name') ?? `Task ${uid}`;
    const isSummary = bool(el, 'Summary');
    const isMilestone = bool(el, 'Milestone');
    const calUidRaw = num(el, 'CalendarUID');
    const calendar_uid = calUidRaw != null && calUidRaw >= 0 ? calUidRaw : null;
    const cal = calFor(calendar_uid);
    const rawStart = txt(el, 'Start'), rawFinish = txt(el, 'Finish');
    const start = datePart(rawStart);
    let finish = datePart(rawFinish);
    const durMin = isoDurMinutes(txt(el, 'Duration'));
    const durFmt = num(el, 'DurationFormat');
    const duration_days = isMilestone ? 0 : durMin == null ? 0 : round2(toDays(durMin, durFmt, minutesPerDay));
    // A finish at/before the first working minute (e.g. 08:00) belongs to the previous working day.
    const ft = timePart(rawFinish);
    const dayStart = cal?.dayStart ?? defaultDayStart;
    if (finish && ft && !isMilestone && duration_days > 0 && ft <= dayStart && cal) finish = prevWorkingDay(finish, cal.cal);
    if (!start || !finish) warnings.push(`Task ${uid} "${name}" has no start/finish date`);

    let bl: XNode | null = null;
    for (const b of kids(el, 'Baseline')) if ((num(b, 'Number') ?? 0) === baselineNo && txt(b, 'Interim') !== '1') { bl = b; break; }
    const blDur = bl ? isoDurMinutes(txt(bl, 'Duration')) : null;

    const custom: Record<string, string> = {};
    for (const ea of kids(el, 'ExtendedAttribute')) {
      const id = num(ea, 'FieldID');
      const v = txt(ea, 'Value');
      if (id == null || v == null) continue;
      const fname = fieldName(id);
      const n = isCustomCostField(fname) ? Number(v) : NaN;
      custom[fname] = Number.isFinite(n) ? String(round2(n / scale)) : v;
    }
    const ct = num(el, 'ConstraintType');
    const constraint_type = ct != null && ct >= 0 && ct < MSP_CONSTRAINTS.length ? ct : null;
    const ts = num(el, 'TotalSlack'), fs = num(el, 'FreeSlack');
    const task: ImportTask = {
      uid,
      guid: txt(el, 'GUID'),
      id: num(el, 'ID') ?? i,
      wbs: txt(el, 'WBS'),
      outline_level: level,
      outline_number: txt(el, 'OutlineNumber'),
      parent_uid: null,
      name,
      is_summary: isSummary,
      is_milestone: isMilestone,
      start: start ?? finish ?? '',
      finish: finish ?? start ?? '',
      duration_days,
      baseline_start: bl ? datePart(txt(bl, 'Start')) : null,
      baseline_finish: bl ? datePart(txt(bl, 'Finish')) : null,
      baseline_duration_days: blDur == null ? null : isMilestone ? 0 : round2(toDays(blDur, num(bl, 'DurationFormat'), minutesPerDay)),
      baseline_cost: bl ? money(num(bl, 'Cost')) : null,
      cost: money(num(el, 'Cost')),
      pct_complete: num(el, 'PercentComplete'),
      physical_pct: num(el, 'PhysicalPercentComplete'),
      actual_start: datePart(txt(el, 'ActualStart')),
      actual_finish: datePart(txt(el, 'ActualFinish')),
      is_critical: bool(el, 'Critical'),
      total_float_days: ts == null ? null : round2(tenthsToDays(ts, null, minutesPerDay)),
      free_float_days: fs == null ? null : round2(tenthsToDays(fs, null, minutesPerDay)),
      constraint_type,
      constraint_date: constraint_type != null && constraint_type > 1 ? datePart(txt(el, 'ConstraintDate')) : null,
      calendar_uid,
      notes: txt(el, 'Notes'),
      custom,
      boq_code: null,
    };
    task.boq_code = (boqField ? cleanBoq(custom[boqField]) : null) ?? (opts.boqFromName === false ? null : boqCodeFromName(name));
    tasks.push(task);
    kept.add(uid);
    for (const pl of kids(el, 'PredecessorLink')) rawLinks.push({ el: pl, succ: uid });
  });
  if (skippedInactive) warnings.push(`${skippedInactive} inactive task(s) skipped`);
  if (skippedExternal) warnings.push(`${skippedExternal} external/subproject task(s) skipped`);
  if (manual) warnings.push(`${manual} manually scheduled task(s) — dates are taken as written`);
  if (calendars.length && !calendars.some((c) => c.uid === projectCalUid)) warnings.push('Project calendar not found in file');
  assignParents(tasks);

  // Links
  opts.onProgress?.({ stage: 'links' });
  const byUid = new Map(tasks.map((t) => [t.uid, t]));
  const links: ImportLink[] = [];
  let crossProject = 0, dangling = 0, pctLags = 0;
  for (const { el, succ } of rawLinks) {
    if (bool(el, 'CrossProject')) { crossProject++; continue; }
    const pred = num(el, 'PredecessorUID');
    if (pred == null || !kept.has(pred)) { dangling++; continue; }
    const type = MSP_LINK_TYPES[num(el, 'Type') ?? 1] ?? 'FS';
    const lagRaw = num(el, 'LinkLag') ?? 0;
    const lagFmt = num(el, 'LagFormat');
    let lag_days: number;
    if (lagFmt != null && PERCENT_FORMATS.has(lagFmt)) {
      // Percent lag: encoding not clearly documented (MPXJ reads LinkLag as the percent value). Verify on a sample.
      pctLags++;
      lag_days = round2((lagRaw / 100) * (byUid.get(pred)?.duration_days ?? 0));
    } else lag_days = round2(tenthsToDays(lagRaw, lagFmt, minutesPerDay));
    links.push({ pred_uid: pred, succ_uid: succ, type, lag_days });
  }
  if (crossProject) warnings.push(`${crossProject} cross-project link(s) skipped`);
  if (dangling) warnings.push(`${dangling} link(s) to skipped or unknown tasks dropped`);
  if (pctLags) warnings.push(`${pctLags} percent lag(s) converted as % of the predecessor duration — check them`);
  const expanded = expandSummaryLinks(tasks, links);

  // Resources & assignments (optional)
  const resources: ImportResource[] = [];
  const resIds = new Set<number>();
  for (const r of kids(kid(root, 'Resources'), 'Resource')) {
    const uid = num(r, 'UID');
    const name = txt(r, 'Name');
    if (uid == null || uid === 0 || bool(r, 'IsNull') || !name) continue;
    const t = num(r, 'Type');
    const type: ResourceType = t === 0 ? 'material' : t === 2 ? 'cost' : 'work';
    resources.push({ uid, name, type });
    resIds.add(uid);
  }
  const assignments: ImportAssignment[] = [];
  for (const a of kids(kid(root, 'Assignments'), 'Assignment')) {
    const task_uid = num(a, 'TaskUID'), resource_uid = num(a, 'ResourceUID');
    if (task_uid == null || resource_uid == null || !kept.has(task_uid) || !resIds.has(resource_uid)) continue;
    let bl: XNode | null = null;
    for (const b of kids(a, 'Baseline')) if ((num(b, 'Number') ?? 0) === baselineNo) { bl = b; break; }
    const work = isoDurMinutes(txt(a, 'Work'));
    assignments.push({
      uid: num(a, 'UID') ?? assignments.length + 1, task_uid, resource_uid,
      units: num(a, 'Units'),
      cost: money(num(a, 'Cost')),
      baseline_cost: bl ? money(num(bl, 'Cost')) : null,
      work_hours: work == null ? null : round2(work / 60),
    });
  }

  const starts = tasks.map((t) => t.start).filter(Boolean).sort();
  const finishes = tasks.map((t) => t.finish).filter(Boolean).sort();
  const title = txt(root, 'Title') ?? txt(root, 'Name')?.replace(/\.(xml|mpp)$/i, '') ?? fileName.replace(/\.[^.]+$/, '');
  opts.onProgress?.({ stage: 'done', done: tasks.length, total: tasks.length });
  return {
    name: title,
    source: 'mspdi',
    file_name: fileName,
    file_sha256: null,
    project_start: datePart(txt(root, 'StartDate')) ?? starts[0] ?? '',
    project_finish: datePart(txt(root, 'FinishDate')) ?? finishes[finishes.length - 1] ?? null,
    status_date: datePart(txt(root, 'StatusDate')),
    currency: txt(root, 'CurrencyCode'),
    minutes_per_day: minutesPerDay,
    minutes_per_week: minutesPerWeek,
    project_calendar_uid: projectCalUid,
    baseline_number: baselineNo,
    save_version: txt(root, 'SaveVersion'),
    calendars,
    tasks,
    links: expanded.links,
    source_links: expanded.source,
    resources,
    assignments,
    custom_fields,
    boq_field: boqField,
    project_cost: projectCost,
    warnings,
  };
}

/** Resolves a user-picked custom field (FieldName or Alias, case-insensitive) to its FieldName. Default: alias ~ /boq/i. */
export function resolveField(fields: CustomFieldDef[], pick: string | null | undefined): string | null {
  if (pick === null) return null;
  if (pick) {
    const p = pick.trim().toLowerCase();
    const f = fields.find((x) => x.field_name.toLowerCase() === p || x.alias?.toLowerCase() === p);
    return f?.field_name ?? (/^(text|number|outlinecode|flag)\d+$/i.test(pick) ? pick : null);
  }
  return fields.find((x) => x.alias && /\bbo?q\b|bill of quant/i.test(x.alias))?.field_name ?? null;
}
