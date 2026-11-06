// Excel (.xlsx/.xls/.csv) schedule reader for our template and MSP Export-Wizard sheets
// (docs/research/progress-evm.md §1.4). Predecessors use MSP "Unique ID Predecessors" syntax: `12FS+2d,15SS`.
import * as XLSX from 'xlsx';
import { assignParents, expandSummaryLinks } from './common';
import type { ExcelParseOptions, ImportCalendar, ImportLink, ImportTask, ParsedSchedule } from './types';
import { boqCodeFromName, cleanBoq, isoDurMinutes, lagTokenDays, parsePredecessors, round2, workingDaysInclusive } from './units';

type Col = 'uid' | 'id' | 'wbs' | 'level' | 'name' | 'start' | 'finish' | 'duration' | 'preds' | 'bstart' | 'bfinish' | 'bcost'
  | 'cost' | 'pct' | 'boq' | 'ms' | 'summary' | 'notes' | 'critical';

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9%]/g, '');
/** Accepted header spellings (normalised: lowercase alphanumerics). */
const ALIASES: Record<Col, string[]> = {
  uid: ['uniqueid', 'uid', 'uniqueidentifier'],
  id: ['id', 'rowid'],
  wbs: ['wbs', 'wbscode'],
  level: ['outlinelevel', 'level'],
  name: ['name', 'taskname', 'activity', 'activityname', 'description'],
  start: ['start', 'startdate', 'plannedstart'],
  finish: ['finish', 'finishdate', 'end', 'enddate', 'plannedfinish'],
  duration: ['duration', 'durationd', 'durationdays', 'days'],
  preds: ['predecessors', 'uniqueidpredecessors', 'predecessorsuid'],
  bstart: ['baselinestart', 'baseline0start'],
  bfinish: ['baselinefinish', 'baseline0finish'],
  bcost: ['baselinecost', 'baseline0cost'],
  cost: ['cost', 'budget'],
  pct: ['%complete', 'percentcomplete', 'pctcomplete', '%'],
  boq: ['boqcode', 'boqitems', 'boqitem', 'boq', 'boqno'],
  ms: ['milestone', 'milestoneyn', 'ismilestone'],
  summary: ['summary', 'summaryyn', 'issummary'],
  notes: ['notes', 'remarks', 'comment', 'comments'],
  critical: ['critical'],
};
const lookup = new Map<string, Col>();
for (const [k, v] of Object.entries(ALIASES) as [Col, string[]][]) for (const a of v) lookup.set(a, k);
const CUSTOM_RE = /^(text|number|flag|outlinecode)\d{1,2}$|^elementcodes?$/;

export class ExcelScheduleError extends Error {}

const pad = (n: number) => String(n).padStart(2, '0');
const isoOk = (y: number, m: number, d: number) => y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31;

/** Excel cell → 'YYYY-MM-DD'. Accepts date serials, ISO strings and Date objects; rejects locale text dates. */
export function excelDate(v: unknown): string | null | undefined {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const p = XLSX.SSF.parse_date_code(v);
    return p && isoOk(p.y, p.m, p.d) ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : undefined;
  }
  if (v instanceof Date) return Number.isNaN(+v) ? undefined : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m && isoOk(+m[1], +m[2], +m[3])) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  return undefined;
}

const yes = (v: unknown) => v === true || v === 1 || /^(y|yes|true|1|x)$/i.test(String(v ?? '').trim());

/** "5", "5d", "5 days", "2w", "3 ed", "16h", "PT40H0M0S" → working days (null when unreadable/blank). */
export function excelDuration(v: unknown, workdaysPerWeek: number, hoursPerDay: number): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/\?$/, '');
  if (/^-?P/i.test(s)) { const m = isoDurMinutes(s.toUpperCase()); return m == null ? null : m / 60 / hoursPerDay; }
  const m = /^(\d+(?:\.\d+)?)\s*(d|days?|w|wks?|weeks?|ed|edays?|ew|h|hrs?|hours?|mo|mons?)?$/i.exec(s);
  if (!m) return null;
  const u = (m[2] ?? 'd').toLowerCase();
  const unit = u.startsWith('ed') ? 'ed' : u === 'ew' ? 'ew' : u.startsWith('h') ? 'h' : u.startsWith('w') ? 'w' : u.startsWith('mo') ? 'mo' : 'd';
  return lagTokenDays({ lag: Number(m[1]), unit }, workdaysPerWeek, hoursPerDay);
}

export function parseExcelSchedule(data: ArrayBuffer | Uint8Array, fileName = 'schedule.xlsx', opts: ExcelParseOptions = {}): ParsedSchedule {
  const warnings: string[] = [];
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  const sheetName = (opts.sheet && wb.SheetNames.includes(opts.sheet) ? opts.sheet : null)
    ?? wb.SheetNames.find((n) => /^tasks?$/i.test(n.trim()))
    ?? wb.SheetNames.find((n) => !/instruction|readme|help/i.test(n))
    ?? wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new ExcelScheduleError('The workbook has no sheets');
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true, blankrows: false });

  // Header row: first row (within 15) with ≥ 3 known headers incl. Name.
  let hIdx = -1;
  let cols = new Map<Col, number>();
  const customCols: { idx: number; name: string }[] = [];
  for (let r = 0; r < Math.min(aoa.length, 15); r++) {
    const m = new Map<Col, number>();
    (aoa[r] ?? []).forEach((h, i) => { const c = lookup.get(norm(h)); if (c && !m.has(c)) m.set(c, i); });
    if (m.has('name') && m.size >= 3) { hIdx = r; cols = m; break; }
  }
  if (hIdx < 0) throw new ExcelScheduleError(`Sheet "${sheetName}": no header row with Name, Start, Finish… columns found`);
  (aoa[hIdx] ?? []).forEach((h, i) => { if (CUSTOM_RE.test(norm(h))) customCols.push({ idx: i, name: String(h).trim() }); });
  if (!cols.has('uid')) {
    if (cols.has('id')) { cols.set('uid', cols.get('id')!); warnings.push('No "Unique ID" column — using "ID" (re-imports will match by row number)'); }
    else warnings.push('No "Unique ID" column — row numbers used as IDs (re-imports cannot be matched reliably)');
  }
  for (const c of ['start', 'finish'] as const) if (!cols.has(c)) warnings.push(`No "${c === 'start' ? 'Start' : 'Finish'}" column`);

  const cal: ImportCalendar = {
    uid: 1, name: 'Excel import calendar', base_uid: null,
    working_weekdays: [...(opts.workingWeekdays ?? [1, 2, 3, 4, 5, 6])].sort((a, b) => a - b),
    hours_per_day: opts.hoursPerDay ?? 8,
    exceptions: opts.holidays ?? [],
  };
  const wpw = cal.working_weekdays.length || 6;
  const get = (row: unknown[], c: Col) => { const i = cols.get(c); return i == null ? null : row[i] ?? null; };

  const body = aoa.slice(hIdx + 1);
  // % complete column: 0–1 fractions (percent-formatted cells) vs 0–100 numbers
  const pctVals = body.map((r) => get(r, 'pct')).filter((v): v is number => typeof v === 'number');
  const pctIsFraction = pctVals.length > 0 && pctVals.every((v) => v <= 1);

  const tasks: ImportTask[] = [];
  const predText = new Map<number, unknown>();
  const seen = new Set<number>();
  const bad = (rowNo: number, msg: string) => { if (warnings.length < 200) warnings.push(`Row ${rowNo}: ${msg}`); };
  body.forEach((row, i) => {
    const rowNo = hIdx + i + 2;
    const name = String(get(row, 'name') ?? '').trim();
    if (!name) return;
    const uidRaw = get(row, 'uid');
    const uid = uidRaw == null || uidRaw === '' ? i + 1 : Number(uidRaw);
    if (!Number.isInteger(uid) || uid < 0) { bad(rowNo, `Unique ID "${uidRaw}" is not a whole number — row skipped`); return; }
    if (seen.has(uid)) { bad(rowNo, `duplicate Unique ID ${uid} — row skipped`); return; }
    const date = (c: Col, label: string) => {
      const v = excelDate(get(row, c));
      if (v === undefined) { bad(rowNo, `${label} "${get(row, c)}" is not a date (use YYYY-MM-DD or an Excel date)`); return null; }
      return v;
    };
    let start = date('start', 'Start');
    let finish = date('finish', 'Finish');
    const wbs = get(row, 'wbs') == null ? null : String(get(row, 'wbs')).trim() || null;
    const lvlRaw = get(row, 'level');
    const outline_level = lvlRaw != null && lvlRaw !== '' && Number.isFinite(Number(lvlRaw)) ? Number(lvlRaw) : wbs ? wbs.split('.').length : 1;
    let dur = excelDuration(get(row, 'duration'), wpw, cal.hours_per_day);
    if (get(row, 'duration') != null && get(row, 'duration') !== '' && dur == null) bad(rowNo, `Duration "${get(row, 'duration')}" not understood`);
    const msCol = cols.has('ms') ? yes(get(row, 'ms')) : null;
    const is_milestone = msCol ?? (dur === 0 || (dur == null && !!start && start === finish && false));
    if (!start && finish) start = finish;
    if (!finish && start) finish = start;
    if (!start || !finish) bad(rowNo, 'no Start/Finish date');
    if (dur == null) dur = is_milestone ? 0 : start && finish ? workingDaysInclusive(start, finish, cal) : 0;
    const pctRaw = get(row, 'pct');
    let pct: number | null = null;
    if (typeof pctRaw === 'number') pct = pctIsFraction ? pctRaw * 100 : pctRaw;
    else if (pctRaw != null && /^\d+(\.\d+)?\s*%?$/.test(String(pctRaw).trim())) pct = Number(String(pctRaw).replace('%', ''));
    const numOrNull = (c: Col) => { const v = get(row, c); if (v == null || v === '') return null; const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    const custom: Record<string, string> = {};
    for (const cc of customCols) { const v = row[cc.idx]; if (v != null && String(v).trim() !== '') custom[cc.name] = String(v).trim(); }
    const bs = date('bstart', 'Baseline Start'), bf = date('bfinish', 'Baseline Finish');
    const t: ImportTask = {
      uid, guid: null, id: tasks.length + 1, wbs, outline_level, outline_number: wbs, parent_uid: null, name,
      is_summary: cols.has('summary') ? yes(get(row, 'summary')) : false,
      is_milestone,
      start: start ?? '', finish: finish ?? '',
      duration_days: is_milestone ? 0 : round2(dur),
      baseline_start: bs, baseline_finish: bf,
      baseline_duration_days: bs && bf ? (is_milestone ? 0 : workingDaysInclusive(bs, bf, cal)) : null,
      baseline_cost: numOrNull('bcost'),
      cost: numOrNull('cost'),
      pct_complete: pct == null ? null : round2(pct),
      physical_pct: null,
      actual_start: null, actual_finish: null,
      is_critical: cols.has('critical') ? yes(get(row, 'critical')) : false,
      total_float_days: null, free_float_days: null,
      constraint_type: null, constraint_date: null,
      calendar_uid: null,
      notes: get(row, 'notes') == null ? null : String(get(row, 'notes')),
      custom,
      boq_code: cleanBoq(get(row, 'boq')) ?? (opts.boqFromName === false ? null : boqCodeFromName(name)),
    };
    tasks.push(t);
    seen.add(uid);
    predText.set(uid, get(row, 'preds'));
    if (i % 500 === 0) opts.onProgress?.({ stage: 'tasks', done: i, total: body.length });
  });
  if (!tasks.length) throw new ExcelScheduleError(`Sheet "${sheetName}" has no task rows`);
  // Summary column missing → a row is a summary when the next row is deeper.
  if (!cols.has('summary')) tasks.forEach((t, i) => { t.is_summary = (tasks[i + 1]?.outline_level ?? 0) > t.outline_level; if (t.is_summary) t.is_milestone = false; });
  assignParents(tasks);

  const byUid = new Map(tasks.map((t) => [t.uid, t]));
  const links: ImportLink[] = [];
  for (const t of tasks) {
    const { links: toks, errors } = parsePredecessors(predText.get(t.uid) as string | number | null);
    for (const e of errors) warnings.push(`Task ${t.uid}: ${e}`);
    for (const k of toks) {
      const pred = byUid.get(k.uid);
      if (!pred) { warnings.push(`Task ${t.uid}: predecessor ${k.uid} not found — link dropped`); continue; }
      if (k.unit === '%') warnings.push(`Task ${t.uid}: percent lag converted as % of predecessor ${k.uid} duration`);
      links.push({ pred_uid: k.uid, succ_uid: t.uid, type: k.type, lag_days: round2(lagTokenDays(k, wpw, cal.hours_per_day, pred.duration_days)) });
    }
  }
  const expanded = expandSummaryLinks(tasks, links);
  const starts = tasks.map((t) => t.start).filter(Boolean).sort();
  const finishes = tasks.map((t) => t.finish).filter(Boolean).sort();
  return {
    name: fileName.replace(/\.[^.]+$/, ''),
    source: 'excel',
    file_name: fileName,
    file_sha256: null,
    project_start: starts[0] ?? '',
    project_finish: finishes[finishes.length - 1] ?? null,
    status_date: null,
    currency: opts.currency ?? null,
    minutes_per_day: Math.round(cal.hours_per_day * 60),
    minutes_per_week: Math.round(cal.hours_per_day * 60 * wpw),
    project_calendar_uid: cal.uid,
    baseline_number: 0,
    save_version: null,
    calendars: [cal],
    tasks,
    links: expanded.links,
    source_links: expanded.source,
    resources: [],
    assignments: [],
    custom_fields: customCols.map((c) => ({ field_id: null, field_name: c.name, alias: null })),
    boq_field: cols.has('boq') ? 'BoQ Code' : null,
    project_cost: null,
    warnings,
  };
}
