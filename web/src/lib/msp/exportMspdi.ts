// Current schedule → MS Project XML (MSPDI), so planners can round-trip: export → edit in MS Project → import.
// UIDs, outline, durations, constraints, links (type + lag), custom fields (Unit / Qty / Rate / Amount …),
// the baseline in force, the project calendar, resources and assignments are written.
import { isCustomCostField } from './parseMspdi';
import type { CustomFieldDef } from './types';

export interface ExportTask {
  uid: number; name: string; wbs: string | null; outline_number: string | null; outline_level: number; is_summary: boolean; is_milestone: boolean;
  start: string | null; finish: string | null; duration_days: number | null; constraint_type: number | null; constraint_date: string | null;
  deadline: string | null; notes: string | null; pct_complete: number; actual_start: string | null; actual_finish: string | null;
  baseline_start: string | null; baseline_finish: string | null; custom: Record<string, string> | null;
}
export interface ExportLink { pred_uid: number; succ_uid: number; type: 'FS' | 'SS' | 'FF' | 'SF'; lag_days: number }
export interface ExportResource { uid: number; code: string; name: string; kind: 'labour' | 'crew' | 'equipment' | 'material'; unit: string; max_units: number; std_rate: number | null; cost_per_use: number | null }
export interface ExportAssignment { task_uid: number; resource_uid: number; units: number; duration_days: number; kind: ExportResource['kind'] }
export interface ExportInput {
  name: string; start: string; currency: string; minutesPerDay?: number; workingWeekdays: number[];   // ISO 1 = Monday … 7 = Sunday
  holidays: { date: string; name: string }[]; customFields: CustomFieldDef[];
  tasks: ExportTask[]; links: ExportLink[]; resources: ExportResource[]; assignments: ExportAssignment[];
}

const LINK_TYPE: Record<ExportLink['type'], number> = { FF: 0, FS: 1, SF: 2, SS: 3 };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (n: string, v: string | number | null | undefined) => (v == null || v === '' ? '' : `<${n}>${typeof v === 'string' ? esc(v) : v}</${n}>`);
const hours = (minutes: number) => { const h = Math.floor(minutes / 60), m = Math.round(minutes - h * 60); return `PT${h}H${m}M0S`; };

export function buildMspdi(x: ExportInput): string {
  const mpd = x.minutesPerDay ?? 480;
  const at = (d: string | null, time: string) => (d ? `${d.slice(0, 10)}T${time}` : null);
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<Project xmlns="http://schemas.microsoft.com/project">');
  out.push(`<SaveVersion>14</SaveVersion>${tag('Name', x.name)}${tag('Title', x.name)}<ScheduleFromStart>1</ScheduleFromStart>${tag('StartDate', at(x.start, '08:00:00'))}`);
  out.push(`<CurrencyCode>${esc(x.currency)}</CurrencyCode><CurrencyDigits>2</CurrencyDigits><CalendarUID>1</CalendarUID>`);
  out.push(`<DefaultStartTime>08:00:00</DefaultStartTime><DefaultFinishTime>17:00:00</DefaultFinishTime><MinutesPerDay>${mpd}</MinutesPerDay>`);
  out.push(`<MinutesPerWeek>${mpd * x.workingWeekdays.length}</MinutesPerWeek><DaysPerMonth>${Math.round(x.workingWeekdays.length * 52 / 12)}</DaysPerMonth>`);
  out.push('<DurationFormat>7</DurationFormat><WorkFormat>2</WorkFormat><NewTasksEffortDriven>0</NewTasksEffortDriven>');
  if (x.customFields.some((f) => f.field_id != null)) {
    out.push('<ExtendedAttributes>');
    for (const f of x.customFields) if (f.field_id != null) out.push(`<ExtendedAttribute><FieldID>${f.field_id}</FieldID>${tag('FieldName', f.field_name)}${tag('Alias', f.alias)}</ExtendedAttribute>`);
    out.push('</ExtendedAttributes>');
  }
  // Calendar: MSPDI DayType 1 = Sunday … 7 = Saturday; holidays as non-working exceptions.
  out.push('<Calendars><Calendar><UID>1</UID><Name>Project calendar</Name><IsBaseCalendar>1</IsBaseCalendar><WeekDays>');
  for (let dt = 1; dt <= 7; dt++) {
    const iso = dt === 1 ? 7 : dt - 1;
    out.push(x.workingWeekdays.includes(iso)
      ? `<WeekDay><DayType>${dt}</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>12:00:00</ToTime></WorkingTime><WorkingTime><FromTime>13:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>`
      : `<WeekDay><DayType>${dt}</DayType><DayWorking>0</DayWorking></WeekDay>`);
  }
  out.push('</WeekDays>');
  if (x.holidays.length) {
    out.push('<Exceptions>');
    for (const h of x.holidays) {
      out.push(`<Exception><EnteredByOccurrences>0</EnteredByOccurrences><TimePeriod><FromDate>${h.date}T00:00:00</FromDate><ToDate>${h.date}T23:59:00</ToDate></TimePeriod><Occurrences>1</Occurrences>${tag('Name', h.name)}<Type>1</Type><DayWorking>0</DayWorking></Exception>`);
    }
    out.push('</Exceptions>');
  }
  out.push('</Calendar></Calendars>');

  const preds = new Map<number, ExportLink[]>();
  for (const l of x.links) { const a = preds.get(l.succ_uid) ?? []; a.push(l); preds.set(l.succ_uid, a); }
  const costIds = new Map(x.customFields.map((f) => [f.field_name, f.field_id]));
  out.push('<Tasks>');
  x.tasks.forEach((t, i) => {
    const dur = t.is_milestone ? 0 : Math.max(0, Number(t.duration_days ?? 0));
    const parts = [
      tag('UID', t.uid), tag('ID', i + 1), tag('Name', t.name), tag('Type', 0), '<IsNull>0</IsNull>', tag('WBS', t.wbs), tag('OutlineNumber', t.outline_number),
      tag('OutlineLevel', t.outline_level), tag('Start', at(t.start, t.is_milestone ? '17:00:00' : '08:00:00')), tag('Finish', at(t.finish, '17:00:00')),
      tag('Duration', hours(dur * mpd)), '<DurationFormat>7</DurationFormat>', '<Manual>0</Manual>', '<Estimated>0</Estimated>',
      tag('Summary', t.is_summary ? 1 : 0), tag('Milestone', t.is_milestone ? 1 : 0), tag('PercentComplete', Math.round(Number(t.pct_complete) || 0)),
      tag('ActualStart', at(t.actual_start, '08:00:00')), tag('ActualFinish', at(t.actual_finish, '17:00:00')),
      tag('ConstraintType', t.constraint_type ?? 0), tag('ConstraintDate', at(t.constraint_date, '08:00:00')), tag('Deadline', at(t.deadline, '17:00:00')),
      tag('Notes', t.notes),
    ];
    for (const l of (preds.get(t.uid) ?? [])) {
      parts.push(`<PredecessorLink><PredecessorUID>${l.pred_uid}</PredecessorUID><Type>${LINK_TYPE[l.type]}</Type><CrossProject>0</CrossProject>`
        + `<LinkLag>${Math.round(l.lag_days * mpd * 10)}</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`);
    }
    for (const [k, v] of Object.entries(t.custom ?? {})) {
      const id = costIds.get(k);
      if (id == null || v == null || v === '') continue;
      const val = isCustomCostField(k) && Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 100)) : v;
      parts.push(`<ExtendedAttribute><FieldID>${id}</FieldID><Value>${esc(val)}</Value></ExtendedAttribute>`);
    }
    if (t.baseline_start && t.baseline_finish) {
      parts.push(`<Baseline><Number>0</Number>${tag('Start', at(t.baseline_start, '08:00:00'))}${tag('Finish', at(t.baseline_finish, '17:00:00'))}</Baseline>`);
    }
    out.push(`<Task>${parts.join('')}</Task>`);
  });
  out.push('</Tasks>');

  if (x.resources.length) {
    out.push('<Resources>');
    x.resources.forEach((r, i) => {
      const material = r.kind === 'material';
      // MSPDI keeps work rates per hour; the sheet's rate is per day (labour / equipment) or per unit (material).
      const rate = r.std_rate == null ? null : material ? r.std_rate : r.std_rate / (mpd / 60);
      out.push(`<Resource>${tag('UID', r.uid)}${tag('ID', i + 1)}${tag('Name', r.name)}${tag('Initials', r.code)}${tag('Type', material ? 0 : 1)}`
        + `${material ? tag('MaterialLabel', r.unit) : tag('MaxUnits', r.max_units)}${tag('StandardRate', rate)}<StandardRateFormat>${material ? 7 : 3}</StandardRateFormat>`
        + `${tag('CostPerUse', r.cost_per_use)}</Resource>`);
    });
    out.push('</Resources><Assignments>');
    x.assignments.forEach((a, i) => {
      const work = a.kind === 'material' ? a.units * 60 : a.units * a.duration_days * mpd;
      out.push(`<Assignment>${tag('UID', i + 1)}${tag('TaskUID', a.task_uid)}${tag('ResourceUID', a.resource_uid)}${tag('Units', a.units)}${tag('Work', hours(work))}</Assignment>`);
    });
    out.push('</Assignments>');
  }
  out.push('</Project>');
  return out.join('\n');
}
