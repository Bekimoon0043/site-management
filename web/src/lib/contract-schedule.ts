// Contract for project progress management: MS Project schedule import, baselines,
// task progress, CPM forecast, periods and Earned Value (migration
// 20261030000003_schedule_evm.sql). Copy next to contract.ts in each app
// (src/lib/contract-schedule.ts). Pure TypeScript, no runtime deps.
//
// Money lives only in PRICE_TABLES_SCHEDULE / PRICE_VIEWS_SCHEDULE (RLS:
// app.can_see_prices()). Mobile syncs SYNC_TABLES_SCHEDULE (no money) and reads
// v_progress_overview for its dashboard. The MSPDI XML parser itself lives in web;
// the unit conversions it needs are below so both apps (and tests) share them.
//
// Type-only import so Node can run this file directly with type stripping.
import type { AppRole, SyncTable } from './contract';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type EvMethod = 'units' | 'elements' | 'steps' | '0_100' | '50_50' | 'pct' | 'milestone' | 'loe';
export type LinkType = 'FS' | 'SS' | 'FF' | 'SF';
export type TaskProgressStatus = 'reported' | 'verified' | 'adjusted' | 'rejected';
export type BaselineStatus = 'proposed' | 'approved' | 'superseded' | 'rejected';
export type PeriodStatus = 'open' | 'prepared' | 'closed';
export type PeriodKind = 'weekly' | 'monthly';
export type CostCategory = 'labour' | 'equipment' | 'subcontract' | 'material_direct' | 'overhead' | 'other';
export type EvmBand = 'ok' | 'warning' | 'critical' | 'info';
export type EvmCostBasis = 'full' | 'materials';
export type BaselineCostSource = 'value' | 'msp_baseline_cost' | 'budget_lines' | 'value_less_margin';

export const EV_METHOD_LABELS: Record<EvMethod, { en: string; am: string; hint: string }> = {
  units: { en: 'Quantity done', am: 'የተሰራ መጠን', hint: 'Measured BoQ quantity ÷ planned quantity (weighted by BoQ rate)' },
  elements: { en: 'From elements', am: 'ከመዋቅር ክፍሎች', hint: 'Verified progress of the linked columns, slabs, walls…' },
  steps: { en: 'Weighted steps', am: 'ደረጃዎች', hint: 'Each finished step earns its weight' },
  '0_100': { en: '0 / 100', am: '0 / 100', hint: 'Earns only when finished (short tasks, tests)' },
  '50_50': { en: 'Start / finish', am: 'ጅምር / ማጠናቀቅ', hint: 'Earns the start % when started, 100 % when finished' },
  pct: { en: 'Percent estimate', am: 'የመቶኛ ግምት', hint: 'Physical % judged on site (minor items only)' },
  milestone: { en: 'Payment milestone', am: 'የክፍያ ምዕራፍ', hint: '100 % when achieved' },
  loe: { en: 'Level of effort', am: 'በጊዜ የሚታሰብ', hint: 'Earns with time (preliminaries, supervision)' },
};

export const COST_CATEGORY_LABELS: Record<CostCategory, { en: string; am: string }> = {
  labour: { en: 'Labour', am: 'የሰው ኃይል' }, equipment: { en: 'Equipment', am: 'መሳሪያ' },
  subcontract: { en: 'Subcontract', am: 'ንዑስ ተቋራጭ' }, material_direct: { en: 'Direct material', am: 'በቀጥታ የተገዛ ዕቃ' },
  overhead: { en: 'Site overhead', am: 'የሳይት ወጪ' }, other: { en: 'Other', am: 'ሌላ' },
};

// ---------------------------------------------------------------------------
// Permissions (mirrors the RPC role checks)
// ---------------------------------------------------------------------------

export type ScheduleAction =
  | 'schedule.import' | 'task.setup' | 'progress.report' | 'progress.verify' | 'baseline.propose' | 'baseline.approve'
  | 'forecast.run' | 'period.open' | 'period.prepare' | 'period.close' | 'period.reopen' | 'cost.record' | 'usage.record';
const OE_UP: AppRole[] = ['office_engineer', 'coordinator', 'manager', 'admin'];
const SCHEDULE_PERMS: Record<ScheduleAction, AppRole[]> = {
  'schedule.import': OE_UP, 'task.setup': OE_UP,
  'progress.report': ['site_engineer', ...OE_UP], 'progress.verify': OE_UP,
  'baseline.propose': OE_UP, 'baseline.approve': ['coordinator', 'manager', 'admin'],
  'forecast.run': OE_UP, 'period.open': OE_UP, 'period.prepare': OE_UP,
  'period.close': ['coordinator', 'manager', 'admin'], 'period.reopen': ['manager', 'admin'],
  'cost.record': ['coordinator', 'manager', 'procurement', 'admin', 'office_engineer'], // + must be a price role
  'usage.record': ['site_engineer', ...OE_UP],
};
export const canSchedule = (role: AppRole | null | undefined, action: ScheduleAction) =>
  !!role && SCHEDULE_PERMS[action].includes(role);

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** No money — safe for every member (mobile offline). */
export const SYNC_TABLES_SCHEDULE: SyncTable[] = [
  { name: 'public_holidays', pk: ['id'] },
  { name: 'project_calendars', pk: ['id'] },
  { name: 'calendar_exceptions', pk: ['id'] },
  { name: 'schedules', pk: ['id'] },
  { name: 'schedule_versions', pk: ['id'] },
  { name: 'schedule_tasks', pk: ['id'] },
  { name: 'schedule_links', pk: ['id'] },
  { name: 'schedule_baselines', pk: ['id'] },
  { name: 'schedule_baseline_tasks', pk: ['baseline_id', 'task_id'] },
  { name: 'task_boq_links', pk: ['id'] },
  { name: 'task_element_links', pk: ['id'] },
  { name: 'task_steps', pk: ['id'] },
  { name: 'task_progress', pk: ['id'] },
  { name: 'evm_periods', pk: ['id'] },
  { name: 'evm_task_status', pk: ['id'] },
  { name: 'period_boq_progress', pk: ['period_id', 'boq_item_id'] },
  { name: 'evm_variance_notes', pk: ['id'] },
  { name: 'resource_usage', pk: ['id'] },
];
/** Price-restricted tables (empty for non-price roles). Web / online only. */
export const PRICE_TABLES_SCHEDULE: SyncTable[] = [
  { name: 'schedule_task_costs', pk: ['task_id'] },
  { name: 'schedule_baseline_task_costs', pk: ['baseline_id', 'task_id'] },
  { name: 'cost_entries', pk: ['id'] },
  { name: 'cost_rates', pk: ['id'] },
  { name: 'evm_snapshots', pk: ['id'] },
];
/** Views with money (empty rows for non-price roles). */
export const PRICE_VIEWS_SCHEDULE = ['v_evm_task', 'v_evm_wbs', 'v_evm_project', 'v_evm_timeseries', 'v_ac_material_alloc'] as const;
/** Views without money (mobile-safe). */
export const VIEWS_SCHEDULE = ['v_progress_overview', 'v_boq_progress', 'v_boq_mapping_check'] as const;

// ---------------------------------------------------------------------------
// Rows (selected columns)
// ---------------------------------------------------------------------------

export interface ProjectCalendar {
  id: string; project_id: string; name: string; working_weekdays: number[]; hours_per_day: number; saturday_factor: number;
  use_public_holidays: boolean; is_default: boolean; source: 'manual' | 'msp_import'; updated_at: string; deleted_at: string | null;
}
export interface CalendarException { id: string; calendar_id: string; project_id: string; on_date: string; is_working: boolean; factor: number | null; name: string | null; deleted_at: string | null }
export interface PublicHoliday { id: string; on_date: string; name: string; name_am: string | null; is_tentative: boolean; country: string; kind: string }

export interface Schedule {
  id: string; project_id: string; code: string; name: string; status: 'draft' | 'active' | 'archived';
  current_version_id: string | null; approved_baseline_id: string | null; planned_start: string | null; planned_finish: string | null;
  status_date: string | null; fc_finish: string | null; es_finish: string | null; minutes_per_day: number; updated_at: string;
}
export interface ScheduleTask {
  id: string; project_id: string; schedule_id: string; msp_uid: number; msp_guid: string | null; wbs: string | null;
  outline_level: number; parent_id: string | null; sort_order: number; name: string; is_summary: boolean; is_milestone: boolean;
  planned_start: string | null; planned_finish: string | null; baseline_start: string | null; baseline_finish: string | null;
  forecast_start: string | null; forecast_finish: string | null; actual_start: string | null; actual_finish: string | null;
  duration_days: number | null; pct_complete: number; reported_pct: number; is_critical: boolean; total_float_days: number | null;
  free_float_days: number | null; ev_method: EvMethod; start_pct: number | null; remaining_days: number | null;
  custom: Record<string, string>; source_state: 'active' | 'removed_in_source'; block_id: string | null; level_id: string | null;
  client_recovery_action: string | null; client_recovery_updated_at: string | null; client_recovery_updated_by: string | null;
  updated_at: string; deleted_at: string | null;
}
export interface ScheduleLink { id: string; schedule_id: string; pred_task_id: string; succ_task_id: string; link_type: LinkType; lag_days: number; deleted_at: string | null }
export interface TaskBoqLink { id: string; task_id: string; boq_item_id: string; qty_share: number; reported_qty: number; verified_qty: number; source: string; deleted_at: string | null }
/** schedule_task_costs (price roles). budget_* come from create_boq_from_schedule (ex-VAT = EV value basis). */
export interface ScheduleTaskCost {
  task_id: string; project_id: string; msp_cost: number | null; msp_fixed_cost: number | null; msp_actual_cost: number | null;
  msp_baseline_cost: number | null; budget_ex_vat: number | null; budget_incl_vat: number | null; budget_vat_pct: number | null;
  budget_source: 'schedule_boq' | null; updated_at: string;
}
export interface TaskElementLink { id: string; task_id: string; element_id: string; weight: number | null; activity_seq_from: number | null; activity_seq_to: number | null; deleted_at: string | null }
export interface TaskProgress {
  id: string; project_id: string; task_id: string; status_date: string; original_status_date: string | null; method: EvMethod;
  pct_complete: number | null; qty_done: number | null; qty: { boq_item_id: string; qty_to_date: number }[] | null;
  remaining_days: number | null; actual_start: string | null; actual_finish: string | null; remarks: string | null;
  status: TaskProgressStatus; verified_pct: number | null; reported_by: string; verified_by: string | null; created_at: string;
}
export interface EvmPeriod { id: string; schedule_id: string; period_no: number; kind: PeriodKind; period_start: string; status_date: string; status: PeriodStatus; prepared_summary: PeriodChecks | null }
export interface PeriodChecks {
  blocking: { issue: string; message: string; count?: number }[];
  breaches: { indicator: 'spi' | 'cpi' | 'spi_t' | 'tcpi'; value: number; band: EvmBand }[];
  warnings: string[]; pct_planned: number | null; pct_earned: number | null; spi: number | null; cpi: number | null; spi_t: number | null;
}

/** v_evm_project (price roles). Task / WBS views carry the same money + ratio columns. */
export interface EvmProject {
  project_id: string; schedule_id: string; status_date: string; bac: number; pv: number; ev: number; ac: number; ac_unallocated: number;
  bac_value: number; pv_value: number; ev_value: number; pct_planned: number | null; pct_earned: number | null;
  sv: number; cv: number; spi: number | null; cpi: number | null; eac: number; etc: number; vac: number; tcpi: number | null;
  tcpi_eac: number | null; eac_fallback: boolean; eac_method: string; cost_basis: EvmCostBasis;
  es_days: number | null; at_days: number | null; pd_days: number | null; spi_t: number | null; sv_t_days: number | null;
  es_finish: string | null; fc_finish: string | null; baseline_start: string | null; baseline_finish: string | null;
  spi_status: EvmBand | null; cpi_status: EvmBand | null; spi_t_status: EvmBand | null; tcpi_status: 'ok' | 'warning' | null;
  unbaselined_tasks: number; ac_coverage_pct: number | null;
}
/** v_progress_overview (no money; level 'project' row + one row per WBS summary). */
export interface ProgressOverview {
  project_id: string; schedule_id: string; level: 'project' | 'wbs'; task_id: string | null; wbs: string | null; name: string;
  status_date: string; pct_planned: number | null; pct_earned: number | null; spi: number | null; spi_status: EvmBand | null;
  spi_t: number | null; sv_t_days: number | null; spi_t_status: EvmBand | null; forecast_finish: string | null; es_finish: string | null;
  baseline_finish: string | null; leaf_tasks: number; completed_tasks: number; in_progress_tasks: number; late_tasks: number;
  critical_tasks: number; negative_float_tasks: number; pending_verification: number;
}
export interface EvmTimeseriesRow { grain: 'day' | 'week' | 'month'; period_end: string; as_of: string | null; is_actual: boolean; pv: number; ev: number | null; ac: number | null; pv_value: number; ev_value: number | null }

// ---------------------------------------------------------------------------
// Import payload (browser parser → import_schedule)
// ---------------------------------------------------------------------------

export interface ParsedScheduleTask {
  uid: number; guid?: string; id?: number; name: string; wbs?: string; outline_number?: string; outline_level: number;
  parent_uid?: number; is_summary: boolean; is_milestone: boolean; is_manual?: boolean; active?: boolean;
  start: string; finish: string; duration_days: number; is_elapsed?: boolean; remaining_days?: number;
  constraint_type?: number; constraint_date?: string; deadline?: string; calendar_uid?: number;
  critical?: boolean; total_float_days?: number; free_float_days?: number;
  pct_complete?: number; physical_pct?: number; actual_start?: string; actual_finish?: string;
  cost?: number; fixed_cost?: number; fixed_cost_accrual?: 1 | 2 | 3; actual_cost?: number; work_hours?: number;
  /** MSP Baseline 0..10; `cost` is dropped server-side for non-price roles. */
  baselines?: { number: number; start?: string; finish?: string; duration_days?: number; cost?: number; work_hours?: number }[];
  custom?: Record<string, string>;       // keyed by FieldName or alias, e.g. { Text1: '02.03;02.04=120' }
  boq_codes?: string | string[];          // alternative to mapping.boq_field ('02.03' or '02.03=45.5')
  element_codes?: string | string[];      // 'C1;C2@GF'
  notes?: string; raw_start?: string; raw_finish?: string;
}
export interface ParsedSchedule {
  source: 'mspdi' | 'excel' | 'manual'; file_name: string; file_sha256: string;
  header: { name?: string; start_date: string; finish_date?: string; status_date?: string; minutes_per_day: number;
            minutes_per_week: number; days_per_month: number; currency_code?: string; baseline_for_ev: number; save_version?: string };
  calendars: { uid: number; name: string; is_base: boolean; base_uid?: number;
               week: { dow: 0 | 1 | 2 | 3 | 4 | 5 | 6; working: boolean; minutes: number }[];   // 0 = Sunday
               exceptions: { from: string; to: string; working: boolean; minutes?: number; name?: string }[] }[];
  project_calendar_uid: number;
  tasks: ParsedScheduleTask[];
  links: { pred_uid: number; succ_uid: number; type: LinkType; lag_days: number; lag_elapsed?: boolean }[];
  resources?: { uid: number; name: string; type: 'work' | 'material' | 'cost'; std_rate?: number; cost?: number }[];
  assignments?: { uid: number; task_uid: number; resource_uid: number; units?: number; work_hours?: number; cost?: number; baseline_cost?: number }[];
  custom_fields?: { field_id: number; field_name: string; alias?: string }[];
  warnings: string[];
}

interface Op { op_id: string }

export interface ImportSchedulePayload extends Op {
  project_id: string; schedule_id?: string; version_id?: string; code?: string;
  schedule: ParsedSchedule;
  mapping?: { boq_field?: string; element_field?: string; file_mapping_wins?: boolean };
  options?: { opening_progress?: boolean; uid_remap?: { old_uid: number; new_uid: number }[]; confirm_remove_uids?: number[];
              accept_currency?: boolean; baseline_number?: number; apply_calendar?: boolean };
}
export interface ImportDiffItem { uid: number; name: string; id: string; fields?: Record<string, unknown>; pct_complete?: number }
export interface ImportScheduleResult {
  ok: true; duplicate?: boolean; schedule_id: string; version_id: string; version_no: number;
  added: number; changed: number; removed: number; kept_progress: number; links: number; warnings: string[];
  quality: Record<string, unknown>;
  diff: { added: ImportDiffItem[]; changed: ImportDiffItem[]; removed: ImportDiffItem[]; kept_progress: ImportDiffItem[] };
}

export interface SaveTaskSetupItem {
  task_id: string; ev_method?: EvMethod; start_pct?: number | null; comment?: string; block_id?: string | null; level_id?: string | null;
  /** qty_share = BoQ quantity (item unit) this task delivers; omit to split the remaining quantity automatically by duration. */
  boq_links?: { id?: string; boq_item_id: string; qty_share?: number; deleted?: boolean }[];
  element_links?: { id?: string; element_id: string; weight?: number; activity_seq_from?: number; activity_seq_to?: number; deleted?: boolean }[];
  steps?: { id: string; seq: number; name: string; weight: number; deleted?: boolean }[];
}
export type SaveTaskSetupPayload = Op & (SaveTaskSetupItem | { tasks: SaveTaskSetupItem[] });
export interface AutoLinkTasksPayload extends Op { schedule_id: string; boq_field?: string; element_field?: string; overwrite?: boolean; set_methods?: boolean }

export interface ReportTaskProgressPayload extends Op {
  id: string; task_id: string; status_date?: string; pct_complete?: number;
  qty?: { boq_item_id: string; qty_to_date: number }[];  // cumulative ('units')
  qty_done?: number;                                       // cumulative, single-BoQ-link tasks
  steps?: { step_id: string; done_pct: number }[];
  actual_start?: string; actual_finish?: string; remaining_days?: number; delay_cause?: string; remarks?: string;
}
/** Daily output on a schedule activity: TODAY's quantity (units) or % / status to date, plus the diary line (manpower…). */
export interface ReportDailyOutputPayload extends Op {
  id: string; task_id: string; date?: string;
  /** Opens that day's site diary (draft) when none exists yet for the project / block. */
  diary_number?: string; block_id?: string | null;
  output?: { boq_item_id: string; qty_today: number }[];  // 'units'
  pct_complete?: number;                                    // pct / 0_100 / 50_50 / milestone (to date)
  steps?: { step_id: string; done_pct: number }[];          // to date
  headcount?: number; labour_hours?: number; equipment?: string;
  actual_start?: string; actual_finish?: string; remaining_days?: number; delay_cause?: string; remarks?: string;
}
export interface DailyOutputLine { boq_item_id: string; item_no: string; unit: string; qty_today: number; qty_to_date: number }
export interface ReportDailyOutputResult {
  ok: true; id: string; task_progress_id: string; diary_id: string; diary_number: string; diary_status: 'draft' | 'submitted' | 'signed';
  status_date: string; pct_complete: number; output: DailyOutputLine[]; rolled_to_next_period: boolean;
}
/** diary_activities row (one daily output). */
export interface DiaryActivity {
  id: string; diary_id: string; project_id: string; task_id: string; task_progress_id: string | null; activity_date: string; method: EvMethod;
  output: DailyOutputLine[]; pct_to_date: number | null; headcount: number | null; labour_hours: number | null; equipment: string | null;
  delay_cause: string | null; remarks: string | null; after_signoff: boolean; created_by: string; created_at: string;
}
export interface VerifyTaskProgressItem {
  progress_id: string; approve: boolean; verified_pct?: number; verified_qty?: { boq_item_id: string; qty_to_date: number }[];
  verified_steps?: { step_id: string; done_pct: number }[]; actual_start?: string; actual_finish?: string; remaining_days?: number; comment?: string;
}
export type VerifyTaskProgressPayload = Op & (VerifyTaskProgressItem | { items: VerifyTaskProgressItem[] });
export interface SetBaselinePayload extends Op {
  id: string; schedule_id: string; name?: string; source?: 'msp_baseline' | 'current_plan'; msp_baseline_number?: number;
  effective_from?: string; reason?: string; cost_source?: BaselineCostSource; unmapped_value?: 'msp_cost' | 'zero';
}
/**
 * create_boq_from_schedule (migration 20261030000005) — "the schedule IS the BoQ": every non-summary task with Qty > 0
 * becomes a BoQ item (item_no from WBS, unit normalised), linked to its task (qty_share = Qty), EV method 'units',
 * plus rate and task budget for price roles. Idempotent (re-run updates by item_no).
 * Fields are FieldName (Number1) or alias (Qty). VALUE CONTRACT: custom values are taken as stored by import_schedule;
 * the web parser already divides custom Cost1..Cost10 by the MSPDI currency scale, so amount_scale defaults to 1
 * (pass 100 only for raw hundredths). Rate = ex-VAT unit rate (missing → Amount ÷ amount_scale ÷ Qty ÷ (1 + VAT if
 * included)). BAC value basis is EX-VAT (boq_rates.rate ex-VAT); schedule_task_costs keeps budget_ex_vat (basis) and
 * budget_incl_vat (file Amount when it includes VAT) for reconciliation.
 */
export interface CreateBoqFromSchedulePayload extends Op {
  schedule_id: string; qty_field: string; unit_field?: string | null; rate_field?: string | null; amount_field?: string | null;
  /** Divisor applied to the amount field. Default 1 (values already in currency units). */
  amount_scale?: number;
  /** Amount includes VAT. Omitted → detected (median Amount ÷ (Qty × Rate) > 1.01). */
  vat_included?: boolean;
  /** Default: tax_settings.vat_rate in force, else 15. */
  vat_pct?: number;
  item_no_from?: 'wbs' | 'outline_number';
  /** auto (default): parent name + " – " + leaf name when the leaf starts with a sub-item marker ("a)", "(b)", "iv)"). */
  description_mode?: 'auto' | 'name' | 'parent_and_name';
  /** Default true; only for price roles. */
  set_budget?: boolean;
  /** Default true → ev_method 'units' (kept where the task already has progress). */
  set_ev_method?: boolean;
  /** Default true: other BoQ links of the task are removed. */
  replace_links?: boolean;
}
export interface CreateBoqFromScheduleResult {
  ok: true; schedule_id: string; items_created: number; items_updated: number; items_unchanged: number; links: number;
  ev_methods_set: number; rates_saved: number; budgets_saved: number;
  skipped: { no_qty: number; summaries: number };
  fields: { unit: string | null; qty: string; rate: string | null; amount: string | null };
  vat_included: boolean; vat_pct: number; amount_scale: number;
  /** null for roles that cannot see prices. */
  total_amount_ex_vat: number | null; total_amount_incl_vat: number | null;
  warnings: string[];
}
export interface ApproveBaselinePayload extends Op { baseline_id: string; approve: boolean; comment?: string }
export interface RunForecastPayload extends Op { schedule_id: string; status_date: string }
export interface OpenPeriodPayload extends Op { id: string; schedule_id: string; kind?: PeriodKind; period_no?: number; period_start?: string; status_date: string }
export interface RecordActualCostPayload extends Op {
  id: string; project_id: string; number: string; entry_date: string; category: CostCategory; task_id?: string; boq_item_id?: string;
  element_id?: string; description: string; supplier_id?: string; subcontractor?: string; qty?: number; uom?: string; rate?: number;
  amount?: number; source?: 'manual' | 'payroll' | 'invoice' | 'import'; source_ref?: string; is_estimate?: boolean;
}
export interface RecordResourceUsagePayload extends Op {
  id: string; project_id: string; usage_date: string; kind: 'labour' | 'equipment' | 'subcontract'; task_id?: string; trade_id?: string;
  equipment?: string; subcontractor?: string; boq_item_id?: string; qty: number; uom: string; diary_id?: string; remarks?: string;
}

export interface RpcMapSchedule {
  import_schedule: ImportSchedulePayload;            // → ImportScheduleResult
  save_task_setup: SaveTaskSetupPayload;             // → { ok, tasks }
  auto_link_tasks: AutoLinkTasksPayload;             // → { ok, boq_links, element_links, warnings }
  create_boq_from_schedule: CreateBoqFromSchedulePayload;   // → CreateBoqFromScheduleResult
  report_task_progress: ReportTaskProgressPayload;   // → { ok, id, status_date, pct_complete, rolled_to_next_period }
  report_daily_output: ReportDailyOutputPayload;     // → ReportDailyOutputResult
  verify_task_progress: VerifyTaskProgressPayload;   // → { ok, id, status, verified_pct, status_date } | { ok, items }
  set_baseline: SetBaselinePayload;                  // → { ok, id, baseline_no, status, tasks, without_file_baseline, bac_value?, bac_cost? }
  approve_baseline: ApproveBaselinePayload;          // → { ok, id, status }
  run_forecast: RunForecastPayload;                  // → { ok, fc_finish, es_finish, critical_count, negative_float_count, spi_t }
  open_period: OpenPeriodPayload;                    // → { ok, id, period_no, period_start, status_date }
  prepare_period_close: Op & { period_id: string; carry_ids?: string[] };   // → { ok, status, ...PeriodChecks }
  close_period: Op & { period_id: string; comment?: string };              // → { ok, status, pct_planned, pct_earned, spi, spi_t }
  reopen_period: Op & { period_id: string; reason: string };
  save_variance_note: Op & { id: string; period_id: string; task_id?: string; indicator: string; cause: string; impact?: string;
                             corrective_action?: string; owner_id?: string; due_date?: string };
  record_actual_cost: RecordActualCostPayload;       // → { ok, id, entry_date, rolled_to_next_period }
  reverse_cost_entry: Op & { id: string; number: string; reversal_of: string; reason: string };
  record_resource_usage: RecordResourceUsagePayload;
  save_cost_rate: Op & { id: string; project_id?: string; kind: 'labour' | 'equipment' | 'subcontract'; trade_id?: string;
                         equipment?: string; subcontractor?: string; boq_item_id?: string; uom: string; rate: number; valid_from: string };
  estimate_costs_from_usage: Op & { project_id: string; from?: string; to?: string };
  get_evm_timeseries: { schedule_id: string; grain: 'day' | 'week' | 'month'; status_date?: string };  // → EvmTimeseriesRow[]
}
export type RpcNameSchedule = keyof RpcMapSchedule;
/** Mobile outbox ops. */
export const OUTBOX_RPCS_SCHEDULE: RpcNameSchedule[] = ['report_task_progress', 'verify_task_progress', 'record_resource_usage'];
/** Inbox kinds added to v_my_approvals and the RPC each one maps to. */
export const APPROVAL_RPC_SCHEDULE = {
  task_progress: 'verify_task_progress', schedule_baseline: 'approve_baseline', evm_period: 'close_period',
} as const;

// ---------------------------------------------------------------------------
// EVM metric descriptors (plain language, English + Amharic)
// ---------------------------------------------------------------------------

export interface EvmMetric { key: string; label: string; label_am: string; formula: string; explain: string; explain_am: string; money: boolean; good: 'high' | 'low' | 'one' | null }
export const EVM_METRICS: EvmMetric[] = [
  { key: 'bac', label: 'Budget at completion', label_am: 'ጠቅላላ በጀት', formula: 'Σ task budgets in the approved baseline', money: true, good: null,
    explain: 'What all the work is planned to cost.', explain_am: 'ሁሉም ሥራ እንዲያወጣ የታቀደው ጠቅላላ ወጪ።' },
  { key: 'pv', label: 'Planned value', label_am: 'የታቀደ እሴት', formula: 'BAC × planned fraction at the status date', money: true, good: null,
    explain: 'Value of the work that should be done by now.', explain_am: 'እስከ ዛሬ መሰራት የነበረበት ሥራ እሴት።' },
  { key: 'ev', label: 'Earned value', label_am: 'የተገኘ እሴት', formula: 'BAC × verified % complete', money: true, good: 'high',
    explain: 'Value of the work actually done (verified only).', explain_am: 'በትክክል የተሰራ (የተረጋገጠ) ሥራ እሴት።' },
  { key: 'ac', label: 'Actual cost', label_am: 'ትክክለኛ ወጪ', formula: 'Issued materials + labour, equipment, subcontract, overhead', money: true, good: 'low',
    explain: 'What the work done has really cost.', explain_am: 'የተሰራው ሥራ በእውነት ያስወጣው።' },
  { key: 'sv', label: 'Schedule variance', label_am: 'የጊዜ ልዩነት', formula: 'EV − PV', money: true, good: 'high',
    explain: 'Negative means less work done than planned.', explain_am: 'አሉታዊ ከሆነ ከታቀደው ያነሰ ሥራ ተሰርቷል።' },
  { key: 'cv', label: 'Cost variance', label_am: 'የወጪ ልዩነት', formula: 'EV − AC', money: true, good: 'high',
    explain: 'Negative means the work cost more than its budget.', explain_am: 'አሉታዊ ከሆነ ሥራው ከበጀቱ በላይ አስወጥቷል።' },
  { key: 'spi', label: 'Schedule performance', label_am: 'የጊዜ አፈጻጸም', formula: 'EV ÷ PV', money: false, good: 'one',
    explain: 'For every 1 birr of work planned, we did {v} birr.', explain_am: 'ለታቀደው 1 ብር ሥራ {v} ብር ሰርተናል።' },
  { key: 'cpi', label: 'Cost performance', label_am: 'የወጪ አፈጻጸም', formula: 'EV ÷ AC', money: false, good: 'one',
    explain: 'For every 1 birr spent, we earned {v} birr of work.', explain_am: 'ለወጣው 1 ብር {v} ብር ሥራ አግኝተናል።' },
  { key: 'eac', label: 'Estimate at completion', label_am: 'የመጨረሻ ወጪ ግምት', formula: 'AC + (BAC − EV) ÷ CPI  (= BAC ÷ CPI; AC + BAC − EV while < 10 % earned)', money: true, good: 'low',
    explain: 'Expected final cost if cost performance stays the same.', explain_am: 'አፈጻጸሙ እንደዚሁ ከቀጠለ የሚጠበቀው የመጨረሻ ወጪ።' },
  { key: 'etc', label: 'Estimate to complete', label_am: 'ለማጠናቀቅ የቀረ ወጪ', formula: 'EAC − AC', money: true, good: 'low',
    explain: 'Money still needed to finish.', explain_am: 'ለማጠናቀቅ ገና የሚያስፈልገው ገንዘብ።' },
  { key: 'vac', label: 'Variance at completion', label_am: 'በማጠናቀቂያ ልዩነት', formula: 'BAC − EAC', money: true, good: 'high',
    explain: 'Expected saving (+) or overrun (−) at the end.', explain_am: 'በመጨረሻ የሚጠበቅ ቁጠባ (+) ወይም ብክነት (−)።' },
  { key: 'tcpi', label: 'To-complete performance', label_am: 'የሚያስፈልግ አፈጻጸም', formula: '(BAC − EV) ÷ (BAC − AC)', money: false, good: 'low',
    explain: 'Cost performance needed on the remaining work to stay on budget (above 1.10 is unlikely).', explain_am: 'በበጀቱ ለመጨረስ በቀረው ሥራ የሚያስፈልግ አፈጻጸም (ከ1.10 በላይ አስቸጋሪ ነው)።' },
  { key: 'spi_t', label: 'Time performance (earned schedule)', label_am: 'የጊዜ አፈጻጸም (የተገኘ ጊዜ)', formula: 'ES ÷ AT', money: false, good: 'one',
    explain: 'For every working day passed we gained {v} days of planned work.', explain_am: 'ላለፈው እያንዳንዱ የሥራ ቀን {v} ቀን የታቀደ ሥራ አግኝተናል።' },
  { key: 'sv_t_days', label: 'Days ahead / behind', label_am: 'ቀድሞ / ዘግይቶ (ቀን)', formula: 'ES − AT (working days)', money: false, good: 'high',
    explain: 'Negative = working days behind the baseline.', explain_am: 'አሉታዊ = ከመነሻ ዕቅድ የዘገየ የሥራ ቀን።' },
  { key: 'pct_planned', label: 'Planned %', label_am: 'የታቀደ %', formula: 'PV ÷ BAC', money: false, good: null,
    explain: 'Share of the project that should be done by now.', explain_am: 'እስከ ዛሬ መጠናቀቅ የነበረበት ድርሻ።' },
  { key: 'pct_earned', label: 'Earned %', label_am: 'የተሰራ %', formula: 'EV ÷ BAC', money: false, good: 'high',
    explain: 'Share of the project actually done (verified).', explain_am: 'በትክክል የተሰራ (የተረጋገጠ) ድርሻ።' },
];
export const EVM_THRESHOLDS_DEFAULT = { idx_warn: 0.95, idx_crit: 0.9, tcpi_warn: 1.1, idx_high: 1.15, late_start_wd: 5, unverified_days: 2 };
/** Same banding as app.idx_band (SPI, CPI, SPI(t)). */
export const evmBand = (v: number | null | undefined, t = EVM_THRESHOLDS_DEFAULT): EvmBand | null =>
  v == null ? null : v < t.idx_crit ? 'critical' : v < t.idx_warn ? 'warning' : v > t.idx_high ? 'info' : 'ok';

// ---------------------------------------------------------------------------
// MSPDI unit conversions (shared with the web parser; docs/research/progress-evm.md §1.3)
// ---------------------------------------------------------------------------

/** ISO-8601 duration → minutes. MSP writes PTnHnMnS; PnDT… accepted (D = 24 h, as MPXJ). */
export function isoDurMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m) return null;
  const n = (v: string | undefined) => (v === undefined ? 0 : Number(v));
  const min = n(m[2]) * 525600 + n(m[3]) * 43200 + n(m[4]) * 1440 + n(m[5]) * 60 + n(m[6]) + n(m[7]) / 60;
  return m[1] ? -min : min;
}
/** DurationFormat codes that are elapsed (calendar) time. */
export const ELAPSED_FORMATS = new Set([4, 6, 8, 10, 12, 20, 36, 38, 40, 42, 44, 52]);
export const isElapsedFormat = (fmt: number | null | undefined) => ELAPSED_FORMATS.has(fmt ?? 7);
/** Minutes → working days (or calendar days when the format is elapsed). */
export const toDays = (minutes: number, fmt: number | null | undefined, minPerDay = 480) =>
  isElapsedFormat(fmt) ? minutes / 1440 : minutes / minPerDay;
/** ISO duration string → days, rounded to 2 decimals. */
export const isoDurToDays = (s: string | null | undefined, fmt: number | null | undefined, minPerDay = 480) => {
  const m = isoDurMinutes(s);
  return m == null ? null : Math.round(toDays(m, fmt, minPerDay) * 100) / 100;
};
/** LinkLag / TotalSlack / FreeSlack: integers in tenths of a minute → days. */
export const tenthsToDays = (v: number, fmt: number | null | undefined, minPerDay = 480) => toDays(v / 10, fmt, minPerDay);
/** MSPDI currency is written in hundredths (MPXJ divides by 100) — confirm on the client's first file. */
export const mspCost = (v: number | string | null | undefined, scale = 100) =>
  v == null || v === '' ? null : Math.round((Number(v) / scale) * 100) / 100;
/** MSP PredecessorLink Type: 0 FF, 1 FS, 2 SF, 3 SS. */
export const MSP_LINK_TYPE: Record<number, LinkType> = { 0: 'FF', 1: 'FS', 2: 'SF', 3: 'SS' };
/** MSP WeekDay DayType 1 = Sunday … 7 = Saturday → ParsedSchedule dow 0 = Sunday … 6. */
export const mspDayTypeToDow = (dayType: number) => (dayType - 1) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
/** dow (0 = Sunday) → ISO weekday (1 = Monday … 7 = Sunday) as stored in project_calendars.working_weekdays. */
export const dowToIso = (dow: number) => (dow === 0 ? 7 : dow);
/** Naive local date/time parts — never `new Date(s)` (applies the browser time zone). */
export const datePart = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);
export const timePart = (s: string | null | undefined) => (s ? s.slice(11, 16) : null);
/** 'Unique ID Predecessors' syntax: '12FS+2d;15SS;18FF-1d;20SF+3ed'. Lag in days ('w' = 6 working days, 'h' via minPerDay). */
export function parsePredecessors(s: string | null | undefined, succUid: number, minPerDay = 480, daysPerWeek = 6) {
  const out: { pred_uid: number; succ_uid: number; type: LinkType; lag_days: number; lag_elapsed: boolean }[] = [];
  for (const raw of (s ?? '').split(/[;,]/)) {
    const m = /^\s*(\d+)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(\d+(?:\.\d+)?)\s*(ed|d|w|h|%)?)?\s*$/i.exec(raw);
    if (!m) continue;
    const n = m[4] ? Number(m[4]) * (m[3] === '-' ? -1 : 1) : 0;
    const unit = (m[5] ?? 'd').toLowerCase();
    const lag = unit === 'w' ? n * daysPerWeek : unit === 'h' ? (n * 60) / minPerDay : n;
    out.push({ pred_uid: Number(m[1]), succ_uid: succUid, type: ((m[2] ?? 'FS').toUpperCase() as LinkType), lag_days: lag, lag_elapsed: unit === 'ed' });
  }
  return out;
}
