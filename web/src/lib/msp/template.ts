// Excel schedule template (sheet "Tasks") + export of a parsed schedule into it (round-trip).
import type * as XLSXNS from 'xlsx';
import type { ParsedSchedule } from './types';
import { formatPredecessors } from './units';

export const TEMPLATE_HEADERS = [
  'Unique ID', 'WBS', 'Outline Level', 'Name', 'Start', 'Finish', 'Duration', 'Predecessors',
  'Baseline Start', 'Baseline Finish', 'Baseline Cost', '% Complete', 'BoQ Code', 'Milestone', 'Summary', 'Notes',
] as const;
export type TemplateRow = Record<(typeof TEMPLATE_HEADERS)[number], string | number | null>;

export const TEMPLATE_EXAMPLE: (string | number | null)[][] = [
  [1, '1', 1, 'Substructure', '2026-08-03', '2026-08-22', 18, null, '2026-08-03', '2026-08-20', null, 0, null, 'N', 'Y', null],
  [2, '1.1', 2, 'Bulk excavation to formation level', '2026-08-03', '2026-08-11', 8, null, '2026-08-03', '2026-08-10', 420000, 0, '2.1.1', 'N', 'N', null],
  [3, '1.2', 2, 'Blinding concrete C-15', '2026-08-12', '2026-08-14', 3, '2', '2026-08-11', '2026-08-13', 130000, 0, '2.2.1', 'N', 'N', null],
  [4, '1.3', 2, 'Footing F1 — rebar, formwork & pour', '2026-08-15', '2026-08-19', 4, '3FS+1d', '2026-08-14', '2026-08-18', 210000, 0, '2.3.1', 'N', 'N', 'Element F1'],
  [5, '1.4', 2, 'Footing F2 — rebar, formwork & pour', '2026-08-17', '2026-08-20', 4, '4SS+1d', '2026-08-15', '2026-08-19', 210000, 0, '2.3.1', 'N', 'N', null],
  [6, '1.5', 2, 'Substructure complete', '2026-08-22', '2026-08-22', 0, '5', '2026-08-20', '2026-08-20', null, 0, null, 'Y', 'N', null],
];

export const TEMPLATE_INSTRUCTIONS: string[][] = [
  ['Schedule import template'],
  [''],
  ['Unique ID', 'Required. Whole number, never reused (MS Project "Unique ID"). Re-imports match tasks on it.'],
  ['WBS / Outline Level', 'Hierarchy. Level 1 = top. A row followed by deeper rows is a summary.'],
  ['Start / Finish', 'YYYY-MM-DD text or Excel dates. Locale text like "Mon 2/5/24" is rejected.'],
  ['Duration', 'Working days (number) or 5d / 2w / 3ed / 16h. Blank = counted from Start–Finish (Mon–Sat).'],
  ['Predecessors', 'MS Project "Unique ID Predecessors": 12FS+2d,15SS,18FF-1d,20SF+3ed (FS+0 when omitted).'],
  ['% Complete', '0–100.'],
  ['BoQ Code', 'BoQ item number(s), e.g. 2.3.1 or 02.03;02.04=45.5.'],
  ['Milestone / Summary', 'Y or N.'],
  [''],
  ['From MS Project', 'File › Export › Excel with a map using "Unique ID" and "Unique ID Predecessors", or (better) File › Save As › XML.'],
];

/** Parsed schedule → template rows (summary links kept as written; dates as ISO text). */
export function scheduleToTemplateRows(s: ParsedSchedule): (string | number | null)[][] {
  const bySucc = new Map<number, typeof s.source_links>();
  for (const l of s.source_links) { const a = bySucc.get(l.succ_uid) ?? []; a.push(l); bySucc.set(l.succ_uid, a); }
  return s.tasks.map((t) => [
    t.uid, t.wbs, t.outline_level, t.name, t.start, t.finish, t.duration_days,
    formatPredecessors(bySucc.get(t.uid) ?? []) || null,
    t.baseline_start, t.baseline_finish, t.baseline_cost, t.pct_complete, t.boq_code,
    t.is_milestone ? 'Y' : 'N', t.is_summary ? 'Y' : 'N', t.notes,
  ]);
}

export function buildTemplateWorkbook(XLSX: typeof XLSXNS, rows: (string | number | null)[][] = TEMPLATE_EXAMPLE): XLSXNS.WorkBook {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADERS], ...rows]);
  ws['!cols'] = TEMPLATE_HEADERS.map((h) => ({ wch: h === 'Name' ? 44 : h === 'Predecessors' ? 20 : Math.max(10, h.length + 2) }));
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws, 'Tasks');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(TEMPLATE_INSTRUCTIONS), 'Instructions');
  return wb;
}

/** Downloads the template (blank example, or a parsed schedule converted to template rows). Lazy-loads SheetJS. */
export async function downloadScheduleTemplate(from?: ParsedSchedule, fileName = 'schedule-import-template.xlsx'): Promise<void> {
  const XLSX = await import('xlsx');
  XLSX.writeFile(buildTemplateWorkbook(XLSX, from ? scheduleToTemplateRows(from) : TEMPLATE_EXAMPLE), fileName);
}
