// Normalised schedule shapes produced by the MSPDI / Excel readers. `toImportPayload` (common.ts) converts them to
// the `import_schedule` contract (src/lib/contract-schedule.ts = shared/contract-schedule.ts).
// Spec: docs/research/progress-evm.md §1. Dates are naive local 'YYYY-MM-DD' strings (never Date objects).

export type LinkType = 'FS' | 'SS' | 'FF' | 'SF';
export type ScheduleSource = 'mspdi' | 'excel';
/** Readable names for MSPDI ConstraintType 0..7 (see MSP_CONSTRAINTS). */
export type ConstraintCode = 'ASAP' | 'ALAP' | 'MSO' | 'MFO' | 'SNET' | 'SNLT' | 'FNET' | 'FNLT';
export type ResourceType = 'work' | 'material' | 'cost';

export interface ImportCalendarException {
  from: string;
  to: string;
  is_working: boolean;
  name: string | null;
}

export interface ImportCalendar {
  uid: number;
  name: string;
  base_uid: number | null;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  working_weekdays: number[];
  hours_per_day: number;
  exceptions: ImportCalendarException[];
}

export interface ImportTask {
  uid: number;
  guid: string | null;
  id: number;
  wbs: string | null;
  outline_level: number;
  outline_number: string | null;
  parent_uid: number | null;
  name: string;
  is_summary: boolean;
  is_milestone: boolean;
  start: string;
  finish: string;
  /** Working days (elapsed formats converted at 1440 min/day). Milestones = 0. */
  duration_days: number;
  baseline_start: string | null;
  baseline_finish: string | null;
  baseline_duration_days: number | null;
  baseline_cost: number | null;
  cost: number | null;
  pct_complete: number | null;
  physical_pct: number | null;
  actual_start: string | null;
  actual_finish: string | null;
  is_critical: boolean;
  total_float_days: number | null;
  free_float_days: number | null;
  /** MSPDI ConstraintType: 0 ASAP, 1 ALAP, 2 MSO, 3 MFO, 4 SNET, 5 SNLT, 6 FNET, 7 FNLT. */
  constraint_type: number | null;
  constraint_date: string | null;
  /** null = project calendar. */
  calendar_uid: number | null;
  notes: string | null;
  /** Custom fields keyed by FieldName (e.g. `Text1`). Aliases are in `ParsedSchedule.custom_fields`. */
  custom: Record<string, string>;
  boq_code: string | null;
}

export interface ImportLink {
  pred_uid: number;
  succ_uid: number;
  type: LinkType;
  /** Working days; negative = lead. */
  lag_days: number;
}

export interface ImportResource {
  uid: number;
  name: string;
  type: ResourceType;
}

export interface ImportAssignment {
  uid: number;
  task_uid: number;
  resource_uid: number;
  /** 1 = 100 %. */
  units: number | null;
  cost: number | null;
  baseline_cost: number | null;
  work_hours: number | null;
}

export interface CustomFieldDef {
  field_id: number | null;
  field_name: string;
  alias: string | null;
}

/** A link as written in the file, before summary links are expanded to leaves. */
export interface SourceLink extends ImportLink {
  pred_is_summary: boolean;
  succ_is_summary: boolean;
}

/** Parser output: the payload body (without op/project ids) plus preview-only metadata. */
export interface ParsedSchedule {
  name: string;
  source: ScheduleSource;
  file_name: string;
  /** Set by the worker / parseScheduleFile (SHA-256 hex of the file bytes); re-importing the same file is a no-op. */
  file_sha256: string | null;
  project_start: string;
  currency: string | null;
  minutes_per_day: number;
  calendars: ImportCalendar[];
  tasks: ImportTask[];
  /** Leaf-only links (summary links expanded). */
  links: ImportLink[];
  resources: ImportResource[];
  assignments: ImportAssignment[];
  project_finish: string | null;
  status_date: string | null;
  minutes_per_week: number;
  project_calendar_uid: number | null;
  baseline_number: number;
  save_version: string | null;
  custom_fields: CustomFieldDef[];
  /** Custom field (FieldName) the BoQ code was read from, if any. */
  boq_field: string | null;
  /** Links as in the file (incl. those touching summaries). `links` holds the expanded leaf links. */
  source_links: SourceLink[];
  /** Project summary (UID 0) cost, for the currency-scale sanity check. */
  project_cost: number | null;
  warnings: string[];
}

export interface ParseOptions {
  /** Custom field holding the BoQ code: FieldName (`Text1`) or Alias (`BoQ Code`). Default: first alias matching /boq/i. */
  boqField?: string | null;
  /** Fall back to a code in the task name ("BOQ 3.2.1", "[3.2.1]"). Default true. */
  boqFromName?: boolean;
  /** Baseline number to read (0 = "Baseline"). Default 0. */
  baselineNumber?: number;
  /** MSPDI currency divisor. MSPDI stores hundredths → 100 (verify on the client's first file). Default 100. */
  currencyScale?: number;
  /** DOMParser constructor; defaults to globalThis.DOMParser (main thread). Workers pass @xmldom/xmldom's. */
  DOMParser?: { new (): { parseFromString(s: string, type: string): unknown } };
  onProgress?: (p: MspParseProgress) => void;
}

export interface ExcelParseOptions {
  /** Sheet name; default `Tasks`, else the first sheet. */
  sheet?: string;
  /** ISO weekdays of the default calendar. Default Mon–Sat (Ethiopian 6-day week). */
  workingWeekdays?: number[];
  hoursPerDay?: number;
  holidays?: ImportCalendarException[];
  currency?: string | null;
  boqFromName?: boolean;
  onProgress?: (p: MspParseProgress) => void;
}

export type MspParseProgress = { stage: string; done?: number; total?: number };
