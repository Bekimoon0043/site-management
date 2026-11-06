import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { parseMspdi, type ParseOptions } from '../index';
import { buildMspdi, type ExportInput } from '../exportMspdi';

const DP = DOMParser as unknown as ParseOptions['DOMParser'];

const input: ExportInput = {
  name: 'Round trip & <test>', start: '2026-09-01', currency: 'ETB', workingWeekdays: [1, 2, 3, 4, 5, 6],
  holidays: [{ date: '2026-09-11', name: 'Enkutatash' }],
  customFields: [{ field_id: 188743731, field_name: 'Text1', alias: 'Unit' }, { field_id: 188743767, field_name: 'Number1', alias: 'Qty' },
    { field_id: 188743786, field_name: 'Cost1', alias: 'Amount' }],
  tasks: [
    { uid: 1, name: 'Sub structure', wbs: '1', outline_number: '1', outline_level: 1, is_summary: true, is_milestone: false, start: '2026-09-01', finish: '2026-09-12',
      duration_days: 10, constraint_type: 0, constraint_date: null, deadline: null, notes: null, pct_complete: 0, actual_start: null, actual_finish: null,
      baseline_start: null, baseline_finish: null, custom: null },
    { uid: 2, name: 'Excavation', wbs: '1.1', outline_number: '1.1', outline_level: 2, is_summary: false, is_milestone: false, start: '2026-09-01', finish: '2026-09-05',
      duration_days: 5, constraint_type: 4, constraint_date: '2026-09-01', deadline: '2026-09-10', notes: 'Grid A–C', pct_complete: 40, actual_start: '2026-09-01', actual_finish: null,
      baseline_start: '2026-09-01', baseline_finish: '2026-09-05', custom: { Text1: 'm3', Number1: '850', Cost1: '175950.5' } },
    { uid: 3, name: 'Blinding', wbs: '1.2', outline_number: '1.2', outline_level: 2, is_summary: false, is_milestone: false, start: '2026-09-07', finish: '2026-09-09',
      duration_days: 3, constraint_type: 0, constraint_date: null, deadline: null, notes: null, pct_complete: 0, actual_start: null, actual_finish: null,
      baseline_start: null, baseline_finish: null, custom: null },
    { uid: 4, name: 'Sub-structure complete', wbs: '1.3', outline_number: '1.3', outline_level: 2, is_summary: false, is_milestone: true, start: '2026-09-12', finish: '2026-09-12',
      duration_days: 0, constraint_type: 0, constraint_date: null, deadline: null, notes: null, pct_complete: 0, actual_start: null, actual_finish: null,
      baseline_start: null, baseline_finish: null, custom: null },
  ],
  links: [{ pred_uid: 2, succ_uid: 3, type: 'FS', lag_days: 1 }, { pred_uid: 3, succ_uid: 4, type: 'SS', lag_days: -0.5 }],
  resources: [{ uid: 1, code: 'EXC', name: 'Excavator', kind: 'equipment', unit: 'machine-day', max_units: 1, std_rate: 12000, cost_per_use: 5000 },
    { uid: 2, code: 'C25', name: 'Concrete C-25', kind: 'material', unit: 'm3', max_units: 1, std_rate: 6500, cost_per_use: 0 }],
  assignments: [{ task_uid: 2, resource_uid: 1, units: 1, duration_days: 5, kind: 'equipment' }, { task_uid: 3, resource_uid: 2, units: 40, duration_days: 3, kind: 'material' }],
};

describe('MSPDI export round trip', () => {
  const xml = buildMspdi(input);
  const s = parseMspdi(xml, 'export.xml', { DOMParser: DP });
  const T = (uid: number) => s.tasks.find((t) => t.uid === uid)!;

  it('escapes text and keeps the project header', () => {
    expect(xml).toContain('<Name>Round trip &amp; &lt;test&gt;</Name>');
    expect(s.tasks).toHaveLength(4);
  });
  it('keeps UIDs, outline, summary / milestone, dates and durations', () => {
    expect(T(1).is_summary).toBe(true);
    expect(T(2).parent_uid).toBe(1);
    expect(T(2).duration_days).toBe(5);
    expect(T(2).start).toBe('2026-09-01');
    expect(T(2).finish).toBe('2026-09-05');
    expect(T(4).is_milestone).toBe(true);
    expect(T(2).constraint_type).toBe(4);
    expect(T(2).baseline_start).toBe('2026-09-01');
    expect(T(2).notes).toBe('Grid A–C');
  });
  it('keeps links with type and lag', () => {
    const l23 = s.source_links.find((l) => l.pred_uid === 2 && l.succ_uid === 3)!;
    const l34 = s.source_links.find((l) => l.pred_uid === 3 && l.succ_uid === 4)!;
    expect(l23.type).toBe('FS');
    expect(l23.lag_days).toBe(1);
    expect(l34.type).toBe('SS');
    expect(l34.lag_days).toBe(-0.5);
  });
  it('keeps the BoQ custom fields (cost fields in hundredths)', () => {
    expect(s.custom_fields.map((f) => f.alias)).toEqual(expect.arrayContaining(['Unit', 'Qty', 'Amount']));
    expect(T(2).custom.Text1).toBe('m3');
    expect(T(2).custom.Number1).toBe('850');
    expect(Number(T(2).custom.Cost1)).toBeCloseTo(175950.5, 2);
  });
  it('writes the calendar holidays, resources and assignments', () => {
    const cal = s.calendars[0];
    expect(cal.exceptions.some((e) => e.from.startsWith('2026-09-11') && !e.is_working)).toBe(true);
    expect(xml).toContain('<Initials>EXC</Initials>');
    expect(xml).toMatch(/<StandardRate>1500<\/StandardRate>/);   // 12 000 a day = 1 500 an hour
    expect(xml.match(/<Assignment>/g)).toHaveLength(2);
  });
});
