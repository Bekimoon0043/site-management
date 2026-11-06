import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import {
  boqCodeFromName, buildTemplateWorkbook, diffSchedule, formatPredecessors, isoDurMinutes, parseExcelSchedule, parseMspdi,
  parsePredecessors, parseScheduleBuffer, qualityReport, scheduleToTemplateRows, sha256Hex, toImportPayload, type ParseOptions,
} from '../index';
import type { ImportSchedulePayload } from '../../contract-schedule';

const DP = DOMParser as unknown as ParseOptions['DOMParser'];
const xml = readFileSync(new URL('../../../../../docs/samples/demo-tower-schedule.xml', import.meta.url), 'utf8');
const s = parseMspdi(xml, 'demo-tower-schedule.xml', { DOMParser: DP });
const T = (uid: number) => s.tasks.find((t) => t.uid === uid)!;
const predsOf = (uid: number, links = s.links) => links.filter((l) => l.succ_uid === uid).sort((a, b) => a.pred_uid - b.pred_uid);

describe('units', () => {
  it('converts ISO durations', () => {
    expect(isoDurMinutes('PT16H0M0S')).toBe(960);
    expect(isoDurMinutes('PT1H30M0S')).toBe(90);
    expect(isoDurMinutes('P1DT2H')).toBe(1560);
    expect(isoDurMinutes('-PT8H0M0S')).toBe(-480);
    expect(isoDurMinutes('junk')).toBeNull();
  });
  it('reads and writes Unique ID predecessor syntax', () => {
    const { links, errors } = parsePredecessors('12FS+2d, 15SS;18FF-1d,20SF+3ed,7, x');
    expect(links).toEqual([
      { uid: 12, type: 'FS', lag: 2, unit: 'd' }, { uid: 15, type: 'SS', lag: 0, unit: 'd' }, { uid: 18, type: 'FF', lag: -1, unit: 'd' },
      { uid: 20, type: 'SF', lag: 3, unit: 'ed' }, { uid: 7, type: 'FS', lag: 0, unit: 'd' },
    ]);
    expect(errors).toHaveLength(1);
    expect(formatPredecessors([{ pred_uid: 12, type: 'FS', lag_days: 2 }, { pred_uid: 15, type: 'SS', lag_days: 0 },
      { pred_uid: 7, type: 'FS', lag_days: 0 }, { pred_uid: 18, type: 'FF', lag_days: -1 }])).toBe('12FS+2d,15SS,7,18FF-1d');
  });
  it('finds BoQ codes in task names', () => {
    expect(boqCodeFromName('Columns L1 BOQ 3.2.1')).toBe('3.2.1');
    expect(boqCodeFromName('Kitchen cabinets [7.6.1]')).toBe('7.6.1');
    expect(boqCodeFromName('BoQ: 02.03 blinding')).toBe('02.03');
    expect(boqCodeFromName('Footing F1')).toBeNull();
  });
});

describe('MSPDI sample (Demo Tower)', () => {
  it('reads the header', () => {
    expect(s.source).toBe('mspdi');
    expect(s.name).toBe('Demo Tower — G+2 Residential Building');
    expect(s.project_start).toBe('2026-08-03');
    expect(s.project_finish).toBe('2027-03-06');
    expect(s.status_date).toBe('2026-10-24');
    expect(s.currency).toBe('ETB');
    expect(s.minutes_per_day).toBe(480);
    expect(s.minutes_per_week).toBe(2880);
    expect(s.project_calendar_uid).toBe(1);
    expect(s.project_cost).toBe(14831000);
    expect(s.warnings).toEqual([]);
  });

  it('reads tasks, hierarchy, summary and milestone flags (project summary UID 0 skipped)', () => {
    expect(s.tasks).toHaveLength(77);
    expect(s.tasks.some((t) => t.uid === 0)).toBe(false);
    expect(s.tasks.filter((t) => t.is_summary)).toHaveLength(11);
    expect(s.tasks.filter((t) => t.is_milestone).map((t) => t.uid)).toEqual([2, 25, 42, 57, 103]);
    expect(T(16)).toMatchObject({ name: 'Footing F1 — rebar, formwork & pour', parent_uid: 15, outline_level: 3, wbs: '2.5.1', id: 14 });
    expect(T(15).parent_uid).toBe(10);
    expect(T(10).parent_uid).toBeNull();
    expect(T(16).guid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-/);
  });

  it('converts durations to working days on the 6-day week', () => {
    expect(T(16)).toMatchObject({ start: '2026-08-27', finish: '2026-08-31', duration_days: 4 }); // Thu, Fri, Sat, Mon
    expect(T(11).duration_days).toBe(8);
    expect(T(6).duration_days).toBe(165);
    expect(T(25)).toMatchObject({ is_milestone: true, duration_days: 0, start: '2026-09-25', finish: '2026-09-25' });
    expect(T(20)).toMatchObject({ start: '2026-09-04', finish: '2026-09-10', duration_days: 6 });
    // FS+2d after Thu 09-10 skips Enkutatash (Fri 09-11) and Sunday: lag days Sat 12, Mon 14 → start Tue 15
    expect(T(22)).toMatchObject({ start: '2026-09-15', duration_days: 5 });
  });

  it('reads link types and lags (tenths of minutes → days)', () => {
    expect(predsOf(40)).toEqual([
      { pred_uid: 38, succ_uid: 40, type: 'FF', lag_days: 1 }, { pred_uid: 39, succ_uid: 40, type: 'FS', lag_days: 0 }]);
    expect(predsOf(12)).toEqual([{ pred_uid: 11, succ_uid: 12, type: 'SS', lag_days: 4 }]);
    expect(predsOf(51)).toEqual([{ pred_uid: 40, succ_uid: 51, type: 'FS', lag_days: 7 }]);
    expect(predsOf(82)).toEqual([{ pred_uid: 80, succ_uid: 82, type: 'FS', lag_days: -3 }]);
    const types = new Set(s.links.map((l) => l.type));
    expect([...types].sort()).toEqual(['FF', 'FS', 'SS']);
  });

  it('expands summary links to leaf tasks', () => {
    expect(s.source_links).toHaveLength(85);
    expect(s.source_links.filter((l) => l.pred_is_summary || l.succ_is_summary)).toEqual([
      { pred_uid: 15, succ_uid: 20, type: 'FS', lag_days: 0, pred_is_summary: true, succ_is_summary: false }]);
    expect(predsOf(20).map((l) => l.pred_uid)).toEqual([12, 16, 17, 18, 19]);
    expect(s.links).toHaveLength(85 - 1 + 4);
    const summaries = new Set(s.tasks.filter((t) => t.is_summary).map((t) => t.uid));
    expect(s.links.some((l) => summaries.has(l.pred_uid) || summaries.has(l.succ_uid))).toBe(false);
  });

  it('reads Baseline 0 dates, durations and costs (currency ÷100)', () => {
    expect(T(16)).toMatchObject({ baseline_start: '2026-08-25', baseline_finish: '2026-08-28', baseline_duration_days: 4, baseline_cost: 210000, cost: 210000 });
    expect(T(11)).toMatchObject({ baseline_duration_days: 6, duration_days: 8 });
    expect(T(39)).toMatchObject({ baseline_cost: 480000, cost: 520000 });
    expect(T(93)).toMatchObject({ baseline_start: null, baseline_finish: null, baseline_cost: null });
    expect(parseMspdi(xml, 'x.xml', { DOMParser: DP, currencyScale: 1 }).tasks.find((t) => t.uid === 16)!.cost).toBe(21000000);
  });

  it('reads progress, float, constraints and notes', () => {
    expect(T(16)).toMatchObject({ pct_complete: 100, physical_pct: 100, actual_start: '2026-08-27', actual_finish: '2026-08-31', is_critical: true });
    expect(T(41)).toMatchObject({ pct_complete: 65, actual_start: '2026-10-22', actual_finish: null });
    expect(T(51)).toMatchObject({ total_float_days: -5, is_critical: true, pct_complete: 0 });
    expect(T(56).total_float_days).toBeGreaterThan(44);
    expect(T(57)).toMatchObject({ constraint_type: 7, constraint_date: '2026-11-27' }); // FNLT
    expect(T(2)).toMatchObject({ constraint_type: 2, constraint_date: '2026-08-03' }); // MSO
    expect(T(11)).toMatchObject({ constraint_type: 0, constraint_date: null, calendar_uid: null });
    expect(T(40).notes).toMatch(/continuous operation/);
  });

  it('resolves custom fields by alias and picks the BoQ code', () => {
    expect(s.custom_fields).toEqual([
      { field_id: 188743731, field_name: 'Text1', alias: 'BoQ Code' },
      { field_id: 188743734, field_name: 'Text2', alias: 'Element Codes' }]);
    expect(s.boq_field).toBe('Text1');
    expect(T(16).custom).toEqual({ Text1: '2.3.1', Text2: 'F1' });
    expect(T(16).boq_code).toBe('2.3.1');
    expect(T(93).boq_code).toBe('7.6.1'); // from the name "[7.6.1]"
    expect(T(95).boq_code).toBeNull();
    const byAlias = parseMspdi(xml, 'x.xml', { DOMParser: DP, boqField: 'element codes', boqFromName: false });
    expect(byAlias.boq_field).toBe('Text2');
    expect(byAlias.tasks.find((t) => t.uid === 32)!.boq_code).toBe('C1');
    expect(byAlias.tasks.find((t) => t.uid === 93)!.boq_code).toBeNull();
  });

  it('reads calendars: 6-day week, Ethiopian holidays, inheritance', () => {
    const c1 = s.calendars.find((c) => c.uid === 1)!;
    expect(c1).toMatchObject({ name: 'Ethiopian 6-day (Mon–Sat)', base_uid: null, working_weekdays: [1, 2, 3, 4, 5, 6], hours_per_day: 8 });
    const ex = Object.fromEntries(c1.exceptions.map((e) => [e.from, e]));
    for (const d of ['2026-09-11', '2026-09-27', '2027-01-07', '2027-01-19']) expect(ex[d]).toMatchObject({ to: d, is_working: false });
    expect(ex['2026-09-27'].name).toBe('Meskel');
    expect(c1.exceptions).toHaveLength(5); // legacy DayType 0 duplicates are merged
    expect(s.calendars.find((c) => c.uid === 2)!.working_weekdays).toEqual([1, 2, 3, 4, 5]);
    const c3 = s.calendars.find((c) => c.uid === 3)!;
    expect(c3).toMatchObject({ base_uid: 1, working_weekdays: [1, 2, 3, 4, 5, 6] });
    expect(c3.exceptions).toHaveLength(5);
  });

  it('reads resources and assignments', () => {
    expect(s.resources).toEqual([
      { uid: 1, name: 'Concrete gang (foreman + 8)', type: 'work' },
      { uid: 2, name: 'C-25 ready-mix concrete', type: 'material' },
      { uid: 3, name: 'Masonry subcontractor', type: 'cost' }]);
    expect(s.assignments).toHaveLength(16);
    expect(s.assignments[0]).toEqual({ uid: 1, task_uid: 16, resource_uid: 1, units: 1, cost: 52500, baseline_cost: 52500, work_hours: 32 });
  });

  it('builds the import_schedule payload in the contract shape (shared/contract-schedule.ts)', async () => {
    const buf = new TextEncoder().encode(xml).buffer as ArrayBuffer;
    const withSha = { ...s, file_sha256: await sha256Hex(buf) };
    const p: ImportSchedulePayload = toImportPayload(withSha, { op_id: 'op-1', project_id: 'proj-1', schedule_id: 'sch-1', elementField: 'Element Codes' });
    expect(Object.keys(p).sort()).toEqual(['mapping', 'op_id', 'options', 'project_id', 'schedule', 'schedule_id']);
    expect(p.mapping).toEqual({ boq_field: 'Text1', element_field: 'Text2' });
    expect(p.options).toEqual({ baseline_number: 0 });
    const c = p.schedule;
    expect(c.file_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.header).toMatchObject({ name: 'Demo Tower — G+2 Residential Building', start_date: '2026-08-03', finish_date: '2027-03-06',
      status_date: '2026-10-24', minutes_per_day: 480, minutes_per_week: 2880, currency_code: 'ETB', baseline_for_ev: 0 });
    expect(c.project_calendar_uid).toBe(1);
    const cal = c.calendars.find((x) => x.uid === 1)!;
    expect(cal.week.filter((w) => w.working).map((w) => w.dow)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cal.week[0]).toEqual({ dow: 0, working: false, minutes: 0 });
    expect(cal.exceptions[0]).toEqual({ from: '2026-09-11', to: '2026-09-11', working: false, name: 'Enkutatash (Ethiopian New Year)' });
    const t16 = c.tasks.find((t) => t.uid === 16)!;
    expect(t16).toMatchObject({ critical: true, boq_codes: '2.3.1', element_codes: 'F1', constraint_type: 0,
      baselines: [{ number: 0, start: '2026-08-25', finish: '2026-08-28', duration_days: 4, cost: 210000 }] });
    expect(c.tasks.find((t) => t.uid === 93)!.baselines).toBeUndefined();
    expect(c.links).toHaveLength(85); // as written; the server expands summary links
    expect(c.links).toContainEqual({ pred_uid: 15, succ_uid: 20, type: 'FS', lag_days: 0 });
    expect(JSON.parse(JSON.stringify(p)).schedule.tasks[0]).not.toHaveProperty('guid', null);
  });

  it('produces the quality report', () => {
    const q = qualityReport(s);
    const c = Object.fromEntries(q.checks.map((x) => [x.id, x]));
    expect(q.leaf_count).toBe(66);
    expect(q.blocking).toBe(false);
    expect(c.missing_logic.count).toBe(4);
    expect(c.missing_logic.examples.map((e) => e.uid)).toEqual([6, 62, 73, 103]);
    expect(c.negative_float.count).toBe(6);
    expect(c.missing_baseline.examples.map((e) => e.uid)).toEqual([93, 94]);
    expect(c.high_duration.examples.map((e) => e.uid)).toEqual([6]);
    expect(c.hard_constraints.examples.map((e) => e.uid)).toEqual([2, 57]);
    expect(c.leads.examples.map((e) => e.uid)).toEqual([82]);
    expect(c.summary_links.count).toBe(1);
    expect(c.missing_boq.examples.map((e) => e.uid)).toEqual([95]);
    expect(c.cycles.count).toBe(0);
    expect(c.calendar.label).toBe('Calendar: 6-day week, 5 holiday(s)');
  });
});

describe('MSPDI edge cases', () => {
  const mini = (tasks: string) => `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><MinutesPerDay>480</MinutesPerDay>
    <CalendarUID>1</CalendarUID><StartDate>2026-08-03T08:00:00</StartDate>
    <Calendars><Calendar><UID>1</UID><Name>Std</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID><WeekDays>
    ${[1, 2, 3, 4, 5, 6, 7].map((d) => `<WeekDay><DayType>${d}</DayType><DayWorking>${d === 1 || d === 7 ? 0 : 1}</DayWorking>${d === 1 || d === 7 ? '' : '<WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime><WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes>'}</WeekDay>`).join('')}
    </WeekDays></Calendar></Calendars><Tasks>${tasks}</Tasks></Project>`;
  it('uses direct children only, fixes 08:00 finishes, skips inactive tasks, reads name BoQ codes', () => {
    const r = parseMspdi(mini(`
      <Task><UID>0</UID><OutlineLevel>0</OutlineLevel><Name>P</Name><Summary>1</Summary></Task>
      <Task><UID>1</UID><ID>1</ID><Name>Excavation BOQ 2.1.1</Name><OutlineLevel>1</OutlineLevel><Start>2026-08-03T08:00:00</Start>
        <Finish>2026-08-08T08:00:00</Finish><Duration>PT40H0M0S</Duration><DurationFormat>7</DurationFormat>
        <Baseline><Number>1</Number><Start>2026-07-01T08:00:00</Start><Finish>2026-07-02T17:00:00</Finish></Baseline>
        <Baseline><Number>0</Number><UID>99</UID><Start>2026-08-03T08:00:00</Start><Finish>2026-08-07T17:00:00</Finish><Cost>500000</Cost></Baseline></Task>
      <Task><UID>2</UID><ID>2</ID><Name>Curing</Name><OutlineLevel>1</OutlineLevel><Start>2026-08-10T08:00:00</Start><Finish>2026-08-16T17:00:00</Finish>
        <Duration>PT168H0M0S</Duration><DurationFormat>8</DurationFormat>
        <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>3</Type><LinkLag>28800</LinkLag><LagFormat>8</LagFormat></PredecessorLink>
        <PredecessorLink><PredecessorUID>3</PredecessorUID><Type>1</Type></PredecessorLink></Task>
      <Task><UID>3</UID><ID>3</ID><Name>Old</Name><Active>0</Active><OutlineLevel>1</OutlineLevel></Task>`), 'mini.xml', { DOMParser: DP });
    expect(r.tasks.map((t) => t.uid)).toEqual([1, 2]);
    expect(r.tasks[0]).toMatchObject({ finish: '2026-08-07', duration_days: 5, boq_code: '2.1.1', baseline_start: '2026-08-03', baseline_cost: 5000 });
    expect(r.tasks[1].duration_days).toBe(7); // elapsed days
    expect(r.links).toEqual([{ pred_uid: 1, succ_uid: 2, type: 'SS', lag_days: 2 }]); // 2 elapsed days (28800 tenths)
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/inactive/), expect.stringMatching(/dropped/)]));
    expect(r.calendars[0]).toMatchObject({ working_weekdays: [1, 2, 3, 4, 5], hours_per_day: 8 });
  });
  it('rejects non-MSPDI files and .mpp', () => {
    expect(() => parseMspdi('<html></html>', 'a.xml', { DOMParser: DP })).toThrow(/not an MS Project XML/);
    expect(() => parseScheduleBuffer(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]).buffer, 'plan.mpp')).toThrow(/Save As › XML/);
  });
  it('dispatches by format', () => {
    const buf = new TextEncoder().encode(xml).buffer as ArrayBuffer;
    expect(parseScheduleBuffer(buf, 'demo.xml', {}, { DOMParser: DP }).tasks).toHaveLength(77);
  });
});

describe('Excel template', () => {
  const holidays = s.calendars[0].exceptions;
  const toBuf = (wb: XLSX.WorkBook) => XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  it('round-trips the sample through the template', () => {
    const buf = toBuf(buildTemplateWorkbook(XLSX, scheduleToTemplateRows(s)));
    const x = parseExcelSchedule(buf, 'demo.xlsx', { holidays, currency: 'ETB' });
    expect(x.source).toBe('excel');
    expect(x.warnings).toEqual([]);
    expect(x.tasks).toHaveLength(77);
    const pick = (t: (typeof s.tasks)[number]) => ({ uid: t.uid, wbs: t.wbs, level: t.outline_level, parent: t.parent_uid, name: t.name,
      start: t.start, finish: t.finish, dur: t.duration_days, sum: t.is_summary, ms: t.is_milestone, bs: t.baseline_start,
      bf: t.baseline_finish, bc: t.baseline_cost, pct: t.pct_complete, boq: t.boq_code });
    expect(x.tasks.map(pick)).toEqual(s.tasks.map(pick));
    const key = (l: { pred_uid: number; succ_uid: number; type: string; lag_days: number }) => `${l.pred_uid}${l.type}${l.lag_days}>${l.succ_uid}`;
    expect(x.links.map(key).sort()).toEqual(s.links.map(key).sort());
    expect(x.source_links.filter((l) => l.pred_is_summary)).toHaveLength(1);
    const leaf = x.tasks.filter((t) => !t.is_summary && !t.is_milestone && t.baseline_start);
    for (const t of leaf) expect(t.baseline_duration_days).toBe(s.tasks.find((o) => o.uid === t.uid)!.baseline_duration_days);
    expect(qualityReport(x).checks.find((c) => c.id === 'leads')!.count).toBe(1);
  });

  it('reads the blank template example, Excel date serials, fractions and derived summaries', () => {
    const ex = parseExcelSchedule(toBuf(buildTemplateWorkbook(XLSX)), 'template.xlsx');
    expect(ex.tasks).toHaveLength(6);
    expect(ex.links).toContainEqual({ pred_uid: 3, succ_uid: 4, type: 'FS', lag_days: 1 });
    expect(ex.links).toContainEqual({ pred_uid: 4, succ_uid: 5, type: 'SS', lag_days: 1 });
    const ws = XLSX.utils.aoa_to_sheet([
      ['Task Name', 'Unique ID', 'Outline Level', 'Start Date', 'Finish Date', '% Complete', 'Unique ID Predecessors', 'Text1'],
      ['Frame', 10, 1, 46237, 46245, 0.5, null, null],
      ['Columns BOQ 3.1.1', 11, 2, 46237, 46239, 1, null, 'C1'],
      ['Slab', 12, 2, '2026-08-07', '2026-08-12', 0, '11FS+1w', null],
      ['Bad', 13, 2, 'Mon 2/5/24', '2026-08-12', 0, '99', null],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Export');
    const r = parseExcelSchedule(toBuf(wb), 'msp-export.xlsx');
    expect(r.tasks.map((t) => [t.uid, t.is_summary, t.parent_uid, t.start, t.finish, t.duration_days, t.pct_complete])).toEqual([
      [10, true, null, '2026-08-03', '2026-08-11', 8, 50],
      [11, false, 10, '2026-08-03', '2026-08-05', 3, 100],
      [12, false, 10, '2026-08-07', '2026-08-12', 5, 0],
      [13, false, 10, '2026-08-12', '2026-08-12', 1, 0],
    ]);
    expect(r.tasks[1]).toMatchObject({ boq_code: '3.1.1', custom: { Text1: 'C1' } });
    expect(r.links).toEqual([{ pred_uid: 11, succ_uid: 12, type: 'FS', lag_days: 6 }]); // 1w on a 6-day week
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/not a date/), expect.stringMatching(/predecessor 99 not found/)]));
  });
});

describe('diff', () => {
  it('matches by UID then GUID and reports added / changed / removed', () => {
    const t16 = T(16), t17 = T(17);
    const existing = [
      { key: 'a', uid: 16, guid: t16.guid, name: t16.name, start: t16.start, finish: '2026-08-29' },
      { key: 'b', uid: 9999, guid: t17.guid, name: t17.name, start: t17.start, finish: t17.finish },
      { key: 'c', uid: 500, guid: null, name: 'Deleted task', has_progress: true },
    ];
    const d = diffSchedule([t16, t17, T(18)], existing, {
      parsedLinks: [{ pred_uid: 16, succ_uid: 17, type: 'SS', lag_days: 1 }],
      existingLinks: [{ pred_uid: 16, succ_uid: 17, type: 'SS', lag_days: 2 }, { pred_uid: 1, succ_uid: 2, type: 'FS', lag_days: 0 }],
    });
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]).toMatchObject({ matched_by: 'uid', changes: [{ field: 'finish', from: '2026-08-29', to: '2026-08-31' }] });
    expect(d.unchanged.map((u) => [u.task.uid, u.matched_by])).toEqual([[17, 'guid']]);
    expect(d.added.map((t) => t.uid)).toEqual([18]);
    expect(d.removed.map((e) => e.key)).toEqual(['c']);
    expect(d.removed_with_progress).toHaveLength(1);
    expect(d.summary).toEqual({ added: 1, changed: 1, unchanged: 1, removed: 1, dates_changed: 1 });
    expect(d.links).toMatchObject({ added: [], removed: [{ pred_uid: 1 }], changed: [{ from: { lag_days: 2 }, to: { lag_days: 1 } }] });
  });
});
