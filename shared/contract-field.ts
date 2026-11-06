// Field & quality contract (P1 #6–#9): site diary, inspections & snags,
// concrete pours / ready-mix tickets / cubes, rebar BBS reconciliation.
// Database: supabase/migrations/20261029000006_field_quality.sql
// Every call is supabase.rpc(name, { p: payload }); op_id makes retries idempotent.

import type { AppRole, SyncTable } from './contract';

// ---------------------------------------------------------------------------
// Document numbers: docNumber(projectCode, type, devicePrefix, seq) from ./contract
// with these extra types. Server-derived numbers: auto snags from an inspection
// are `<INS number>-S<item seq>`, from a cube failure `<CUBE number>-S1`
// (unless the client passes snag_number / snag.number).
// ---------------------------------------------------------------------------

export type FieldDocType = 'SD' | 'INS' | 'SNG' | 'POUR' | 'CUBE' | 'BBS';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type Weather = 'sunny' | 'cloudy' | 'rain' | 'heavy_rain' | 'windy' | 'fog';
export const WEATHER_OPTIONS: Weather[] = ['sunny', 'cloudy', 'rain', 'heavy_rain', 'windy', 'fog'];
export type DiaryStatus = 'draft' | 'submitted' | 'signed';
export type DelayCause =
  | 'rain' | 'weather' | 'cement_shortage' | 'material_shortage' | 'power_cut' | 'water_shortage'
  | 'design_change' | 'design_info' | 'payment' | 'labour' | 'equipment' | 'client' | 'permit' | 'other';
export const DELAY_CAUSE_LABELS: Record<DelayCause, string> = {
  rain: 'Rain', weather: 'Other weather', cement_shortage: 'Cement shortage', material_shortage: 'Material shortage',
  power_cut: 'Power cut', water_shortage: 'Water shortage', design_change: 'Design change', design_info: 'Design info / RFI',
  payment: 'Payment', labour: 'Labour', equipment: 'Equipment', client: 'Client', permit: 'Permit', other: 'Other',
};
export type EquipmentStatus = 'working' | 'idle' | 'breakdown';

export type ChecklistItemType = 'yes_no' | 'value' | 'photo' | 'text';
export type InspectionStatus = 'requested' | 'completed' | 'cancelled';
/** fail = a critical item failed; conditional = only non-critical items failed (still clears the hold point). */
export type InspectionOutcome = 'pass' | 'conditional' | 'fail';
export type ItemResponse = 'pass' | 'fail' | 'na';

export type SnagSeverity = 'low' | 'medium' | 'high' | 'critical';
export type SnagStatus = 'open' | 'in_progress' | 'ready_for_review' | 'closed' | 'reopened' | 'cancelled';
export type SnagSource = 'inspection' | 'pour' | 'cube' | 'diary' | 'walk' | 'other';
export type SnagAction = 'start' | 'ready' | 'close' | 'reopen' | 'cancel';
export const SNAG_STATUS_LABELS: Record<SnagStatus, string> = {
  open: 'Open', in_progress: 'In progress', ready_for_review: 'Ready for review', closed: 'Closed',
  reopened: 'Reopened', cancelled: 'Cancelled',
};

export type MixSource = 'ready_mix' | 'site';
export type PourMethod = 'ready_mix' | 'site_batched';
export type PourStatus = 'planned' | 'in_progress' | 'completed' | 'cancelled';
export type TruckStatus = 'awaiting_receipt' | 'posted' | 'rejected';
export type TruckWarning = 'late_arrival' | 'water_added' | 'slump_out_of_range' | 'hot_concrete';
export type BbsStatus = 'draft' | 'approved' | 'superseded';
export type RebarFlag = 'ok' | 'over' | 'under' | 'no_basis';

/** Rebar unit weight, kg/m = Ø²/162 (same formula as bbs_lines.weight_kg). */
export const bbsWeightKg = (diameterMm: number, members: number, barsPerMember: number, cutLengthM: number) =>
  Math.round(members * barsPerMember * cutLengthM * diameterMm * diameterMm / 162 * 1000) / 1000;

// ---------------------------------------------------------------------------
// Permissions (UI gating only — the database enforces the same rules)
// ---------------------------------------------------------------------------


export type FieldAction =
  | 'diary.write' | 'diary.sign' | 'inspection.request' | 'inspection.perform' | 'checklist.edit'
  | 'snag.create' | 'snag.review' | 'mix.edit' | 'pour.write' | 'pour.receiveTruck' | 'pour.issue'
  | 'cube.sample' | 'cube.results' | 'bbs.edit';

const MGMT: AppRole[] = ['coordinator', 'manager', 'admin'];
const FIELD_PERMS: Record<FieldAction, AppRole[]> = {
  'diary.write': ['site_engineer', 'office_engineer', ...MGMT],
  'diary.sign': ['office_engineer', ...MGMT],           // not the author
  'inspection.request': ['site_engineer', 'office_engineer', ...MGMT],
  'inspection.perform': ['office_engineer', ...MGMT],
  'checklist.edit': ['office_engineer', ...MGMT],       // company-wide templates: MGMT only
  'snag.create': ['site_engineer', 'office_engineer', ...MGMT],
  'snag.review': ['office_engineer', ...MGMT],          // close / reopen / cancel
  'mix.edit': ['office_engineer', ...MGMT],
  'pour.write': ['site_engineer', 'office_engineer', ...MGMT],
  'pour.receiveTruck': ['store_keeper', ...MGMT],
  'pour.issue': ['store_keeper', ...MGMT],
  'cube.sample': ['site_engineer', 'office_engineer', ...MGMT],
  'cube.results': ['office_engineer', ...MGMT],
  'bbs.edit': ['office_engineer', ...MGMT],
};
export const canField = (role: AppRole | null | undefined, action: FieldAction) => !!role && FIELD_PERMS[action].includes(role);

// ---------------------------------------------------------------------------
// Sync tables (pulled by updated_at; RLS limits to the user's projects).
// Child rows with deleted_at set are soft-deleted.
// ---------------------------------------------------------------------------

export const SYNC_TABLES_FIELD: SyncTable[] = [
  { name: 'labour_trades', pk: ['id'] },
  { name: 'site_diaries', pk: ['id'] },
  { name: 'diary_labour', pk: ['id'] },
  { name: 'diary_equipment', pk: ['id'] },
  { name: 'diary_delays', pk: ['id'] },
  { name: 'diary_visitors', pk: ['id'] },
  { name: 'diary_instructions', pk: ['id'] },
  { name: 'diary_elements', pk: ['id'] },
  { name: 'diary_addenda', pk: ['id'] },
  { name: 'checklist_templates', pk: ['id'] },
  { name: 'checklist_template_items', pk: ['id'] },
  { name: 'inspections', pk: ['id'] },
  { name: 'inspection_items', pk: ['id'] },
  { name: 'snags', pk: ['id'] },
  { name: 'snag_events', pk: ['id'] },
  { name: 'mix_designs', pk: ['id'] },
  { name: 'pours', pk: ['id'] },
  { name: 'pour_elements', pk: ['id'] },
  { name: 'pour_trucks', pk: ['id'] },
  { name: 'pour_batches', pk: ['id'] },
  { name: 'pour_issues', pk: ['id'] },
  { name: 'cube_sets', pk: ['id'] },
  { name: 'cube_results', pk: ['id'] },
  { name: 'bbs_schedules', pk: ['id'] },
  { name: 'bbs_lines', pk: ['id'] },
];

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface LabourTrade { id: string; name: string; name_am: string | null; sort_order: number; deleted_at: string | null }
export interface SiteDiary {
  id: string; project_id: string; number: string; diary_date: string; block_id: string | null;
  weather_am: Weather | null; weather_pm: Weather | null; rain_hours: number | null; temp_min: number | null; temp_max: number | null;
  weather_source: 'manual' | 'api'; work_summary: string | null; safety_notes: string | null; notes: string | null;
  status: DiaryStatus; version: number; created_by: string; submitted_at: string | null;
  signed_by: string | null; signed_at: string | null; sign_comment: string | null; created_at: string; updated_at: string;
}
export interface DiaryLabour { id: string; diary_id: string; project_id: string; trade_id: string | null; trade_name: string | null; subcontractor: string | null; headcount: number; hours: number | null; deleted_at: string | null }
export interface DiaryEquipment { id: string; diary_id: string; project_id: string; equipment: string; qty: number; hours_worked: number | null; hours_idle: number | null; idle_reason: string | null; status: EquipmentStatus; note: string | null; deleted_at: string | null }
export interface DiaryDelay { id: string; diary_id: string; project_id: string; cause: DelayCause; hours_lost: number | null; element_id: string | null; description: string | null; deleted_at: string | null }
export interface DiaryVisitor { id: string; diary_id: string; project_id: string; name: string; organisation: string | null; purpose: string | null; time_in: string | null; time_out: string | null; deleted_at: string | null }
export interface DiaryInstruction { id: string; diary_id: string; project_id: string; given_by: string | null; organisation: string | null; instruction: string; element_id: string | null; deleted_at: string | null }
export interface DiaryElement { id: string; diary_id: string; project_id: string; element_id: string; note: string | null; deleted_at: string | null }
export interface DiaryAddendum { id: string; diary_id: string; project_id: string; text: string; created_by: string; created_at: string }

export interface ChecklistTemplate {
  id: string; project_id: string | null; code: string; name: string; name_am: string | null; description: string | null;
  element_types: string[]; hold_activities: string[]; version: number; is_active: boolean; deleted_at: string | null;
}
export interface ChecklistTemplateItem {
  id: string; template_id: string; project_id: string | null; seq: number; text: string; text_am: string | null;
  item_type: ChecklistItemType; min_value: number | null; max_value: number | null; unit: string | null;
  photo_required: boolean; is_critical: boolean; deleted_at: string | null;
}
export interface Inspection {
  id: string; project_id: string; number: string; template_id: string; template_version: number | null;
  element_id: string; element_activity_id: string | null; status: InspectionStatus; result: InspectionOutcome | null;
  requested_by: string | null; requested_at: string | null; requested_for: string | null; inspector_id: string | null;
  inspected_at: string | null; consultant_name: string | null; remarks: string | null; reinspection_of: string | null; created_at: string;
}
export interface InspectionItem {
  id: string; inspection_id: string; project_id: string; template_item_id: string; seq: number; text: string;
  item_type: ChecklistItemType; is_critical: boolean; response: ItemResponse; value_num: number | null; value_text: string | null; snag_id: string | null;
}
export interface Snag {
  id: string; project_id: string; number: string; element_id: string | null; block_id: string | null; level_id: string | null;
  location_text: string | null; category: string | null; trade: string | null; severity: SnagSeverity; title: string; description: string | null;
  assignee_user_id: string | null; assignee_party: string | null; due_date: string | null; source_type: SnagSource; source_id: string | null;
  status: SnagStatus; raised_by: string | null; closed_by: string | null; closed_at: string | null; created_at: string; updated_at: string;
}
export interface SnagEvent { id: string; snag_id: string; project_id: string; action: string; from_status: SnagStatus | null; to_status: SnagStatus | null; comment: string | null; actor: string | null; created_at: string }

export interface MixDesign {
  id: string; project_id: string; code: string; grade: string; source: MixSource; material_spec_id: string | null;
  target_strength_mpa: number; cement_spec_id: string | null; cement_kg_per_m3: number | null; water_cement_ratio: number | null;
  sand_m3_per_m3: number | null; aggregate_m3_per_m3: number | null; target_slump_mm: number | null; slump_tolerance_mm: number;
  remarks: string | null; deleted_at: string | null;
}
export interface Pour {
  id: string; project_id: string; number: string; pour_date: string; mix_design_id: string; method: PourMethod;
  supplier_id: string | null; supplier_name: string | null; store_id: string | null; mr_id: string | null;
  planned_m3: number; actual_m3: number | null; start_at: string | null; end_at: string | null; weather: string | null;
  curing_method: string | null; status: PourStatus; remarks: string | null; created_by: string; closed_by: string | null; created_at: string;
}
export interface PourElement { id: string; pour_id: string; project_id: string; element_id: string; planned_m3: number | null; deleted_at: string | null }
export interface PourTruck {
  id: string; pour_id: string; project_id: string; seq: number; ticket_no: string; supplier_name: string | null; truck_plate: string | null;
  volume_m3: number; batched_at: string | null; arrived_at: string | null; discharge_start: string | null; discharge_end: string | null;
  slump_mm: number | null; concrete_temp_c: number | null; water_added_l: number | null; accepted: boolean; reject_reason: string | null;
  status: TruckStatus; warnings: TruckWarning[]; grn_id: string | null; miv_id: string | null; recorded_by: string; received_by: string | null; created_at: string;
}
export interface PourBatch { id: string; pour_id: string; project_id: string; seq: number; volume_m3: number | null; cement_bags: number; sand_m3: number | null; aggregate_m3: number | null; water_l: number | null; slump_mm: number | null; mixer: string | null; batched_at: string }
export interface PourIssue { id: string; project_id: string; pour_id: string; miv_id: string; grn_id: string | null; truck_id: string | null }
export interface CubeSet {
  id: string; project_id: string; number: string; pour_id: string; truck_id: string | null; element_id: string | null; sampled_at: string;
  cubes_count: number; cube_size_mm: number; test_ages: number[]; lab_name: string | null; required_strength_mpa: number;
  result_early: 'ok' | 'low' | null; result_28d: 'pass' | 'fail' | null; mean_28d_mpa: number | null; snag_id: string | null;
}
export interface CubeResult { id: string; cube_set_id: string; project_id: string; cube_label: string; age_days: number; tested_on: string | null; load_kn: number | null; strength_mpa: number; density_kg_m3: number | null; failure_mode: string | null; passed: boolean }
export interface BbsSchedule { id: string; project_id: string; number: string; element_id: string; revision: number; drawing_ref: string | null; remarks: string | null; status: BbsStatus; created_by: string; approved_by: string | null; approved_at: string | null; deleted_at: string | null }
export interface BbsLine {
  id: string; bbs_id: string; project_id: string; line_no: number; bar_mark: string; material_spec_id: string | null; diameter_mm: number;
  shape_code: string | null; no_of_members: number; bars_per_member: number; cut_length_m: number;
  total_length_m: number; unit_weight_kg_m: number; weight_kg: number; deleted_at: string | null;   // generated
}

// ---------------------------------------------------------------------------
// Views (online reports)
// ---------------------------------------------------------------------------

export interface DiaryActivityRow { project_id: string; activity_date: string; kind: 'grn' | 'miv' | 'progress' | 'pour' | 'inspection' | 'snag'; doc_id: string; number: string; block_id: string | null; element_id: string | null; summary: string; status: string; actor: string | null; at: string }
export interface PourSummaryRow {
  pour_id: string; project_id: string; number: string; pour_date: string; method: PourMethod; status: PourStatus; mix_code: string; grade: string;
  target_strength_mpa: number; planned_m3: number; actual_m3: number | null; over_pour_pct: number | null;
  trucks: number; trucks_rejected: number; trucks_awaiting: number; accepted_m3: number; rejected_m3: number; trucks_with_warnings: number;
  batches: number; batched_m3: number; cement_bags: number; cement_kg_issued: number; design_cement_kg_per_m3: number | null;
  design_cement_kg: number | null; batched_cement_kg_per_m3: number | null; issued_cement_kg_per_m3: number | null; cement_variance_pct: number | null;
  cube_sets: number; cube_sets_passed: number; cube_sets_failed: number;
}
export interface CubeDueRow { cube_set_id: string; project_id: string; number: string; pour_id: string; pour_number: string; element_id: string | null; age_days: number; due_date: string; due_status: 'overdue' | 'due' | 'upcoming'; lab_name: string | null; cubes_count: number }
export interface RebarReconciliationRow {
  project_id: string; element_id: string; element_code: string; element_type: string; block_id: string | null; level_id: string | null;
  element_status: string; diameter_mm: number; bbs_id: string | null; bbs_number: string | null; bbs_revision: number | null; bbs_status: BbsStatus | null;
  bbs_kg: number; takeoff_kg: number; issued_kg: number; returned_kg: number; net_issued_kg: number; basis_kg: number;
  variance_kg: number; variance_pct: number | null; bbs_vs_takeoff_pct: number | null; allowance_pct: number; flag: RebarFlag;
}
export const FIELD_VIEWS = ['v_diary_activity', 'v_pour_summary', 'v_cubes_due', 'v_rebar_reconciliation'] as const;

// ---------------------------------------------------------------------------
// RPC payloads
// ---------------------------------------------------------------------------

interface Op { op_id: string }

/** Child arrays replace-by-id while draft/submitted; omit an array to leave it unchanged. */
export interface SaveSiteDiaryPayload extends Op {
  id: string; project_id: string; number: string; diary_date: string; block_id?: string | null;
  weather_am?: Weather; weather_pm?: Weather; rain_hours?: number; temp_min?: number; temp_max?: number; weather_source?: 'manual' | 'api';
  work_summary?: string; safety_notes?: string; notes?: string; submit?: boolean;
  labour?: { id: string; trade_id?: string | null; trade_name?: string; subcontractor?: string; headcount: number; hours?: number }[];
  equipment?: { id: string; equipment: string; qty?: number; hours_worked?: number; hours_idle?: number; idle_reason?: string; status?: EquipmentStatus; note?: string }[];
  delays?: { id: string; cause: DelayCause; hours_lost?: number; element_id?: string; description?: string }[];
  visitors?: { id: string; name: string; organisation?: string; purpose?: string; time_in?: string; time_out?: string }[];
  instructions?: { id: string; given_by?: string; organisation?: string; instruction: string; element_id?: string }[];
  elements?: { id: string; element_id: string; note?: string }[];
}
/** On a duplicate project/block/date the result is { ok:false, conflict:'exists', existing_id, existing_number } → offer "add as addendum". */
export type SaveSiteDiaryResult =
  | { ok: true; id: string; status: DiaryStatus }
  | { ok: false; conflict: 'exists'; existing_id: string; existing_number: string };
export interface SignSiteDiaryPayload extends Op { diary_id: string; approve?: boolean; comment?: string }  // approve:false returns it to draft (comment required)
export interface AddDiaryAddendumPayload extends Op { id: string; diary_id: string; text: string }
export interface GetDiarySummaryPayload { project_id: string; diary_date: string; block_id?: string }
export type DiarySummary = Partial<Record<DiaryActivityRow['kind'], { id: string; number: string; summary: string; status: string; element_id: string | null; at: string }[]>>;

export interface SaveChecklistTemplatePayload extends Op {
  id: string; project_id?: string | null; code: string; name: string; name_am?: string; description?: string;
  element_types?: string[]; hold_activities?: string[]; is_active?: boolean;
  items: { id: string; seq?: number; text: string; text_am?: string; item_type: ChecklistItemType; min_value?: number; max_value?: number; unit?: string; photo_required?: boolean; is_critical?: boolean }[];
}
export interface RequestInspectionPayload extends Op {
  id: string; project_id: string; number: string; template_id: string; element_id: string; element_activity_id?: string;
  requested_for?: string; remarks?: string; reinspection_of?: string;
}
/** Completes a requested inspection (same id) or records a new one (then project_id/number/template_id/element_id are required). */
export interface SubmitInspectionPayload extends Op {
  id: string; project_id?: string; number?: string; template_id?: string; element_id?: string; element_activity_id?: string;
  reinspection_of?: string; inspected_at?: string; consultant_name?: string; remarks?: string;
  items: { id: string; template_item_id: string; response?: ItemResponse; value_num?: number; value_text?: string;
           create_snag?: boolean; snag_id?: string; snag_number?: string }[];
  snag_defaults?: { assignee_user_id?: string; assignee_party?: string; due_date?: string; trade?: string };
}
export interface SubmitInspectionResult { ok: true; id: string; result: InspectionOutcome; hold_point_cleared: boolean; pending_checklists: string[]; snag_ids: string[] }
export interface CancelInspectionPayload extends Op { inspection_id: string; comment?: string }

export interface SaveSnagPayload extends Op {
  id: string; project_id: string; number?: string; element_id?: string; block_id?: string; level_id?: string; location_text?: string;
  category?: string; trade?: string; severity?: SnagSeverity; title: string; description?: string;
  assignee_user_id?: string; assignee_party?: string; due_date?: string; source_type?: SnagSource; source_id?: string;
}
export interface SnagActionPayload extends Op { snag_id: string; action: SnagAction; comment?: string }  // reopen/cancel need comment

export interface SaveMixDesignPayload extends Op {
  id: string; project_id: string; code?: string; grade: string; source: MixSource; material_spec_id?: string;
  target_strength_mpa?: number; cement_spec_id?: string; cement_kg_per_m3?: number; water_cement_ratio?: number;
  sand_m3_per_m3?: number; aggregate_m3_per_m3?: number; target_slump_mm?: number; slump_tolerance_mm?: number; remarks?: string;
}
export interface SavePourPayload extends Op {
  id: string; project_id: string; number: string; pour_date: string; mix_design_id: string; method?: PourMethod;
  supplier_id?: string; supplier_name?: string; store_id?: string; mr_id?: string; planned_m3: number;
  weather?: string; curing_method?: string; remarks?: string;
  elements: { id: string; element_id: string; planned_m3?: number }[];
}
/** grn_id/grn_number/miv_id/miv_number are used when the caller is a store role (posts immediately); otherwise the truck waits for receive_pour_truck. */
export interface AddPourTruckPayload extends Op {
  id: string; pour_id: string; seq?: number; ticket_no: string; supplier_name?: string; truck_plate?: string; volume_m3: number;
  batched_at?: string; arrived_at?: string; discharge_start?: string; discharge_end?: string; slump_mm?: number;
  concrete_temp_c?: number; water_added_l?: number; accepted: boolean; reject_reason?: string;
  store_id?: string; grn_id?: string; grn_number?: string; miv_id?: string; miv_number?: string;
}
export interface AddPourTruckResult { ok: true; id: string; status: TruckStatus; warnings: TruckWarning[]; grn_id?: string; miv_id?: string }
export interface ReceivePourTruckPayload extends Op { truck_id: string; store_id?: string; grn_id?: string; grn_number: string; miv_id?: string; miv_number: string }
export interface AddPourBatchPayload extends Op {
  id: string; pour_id: string; seq?: number; volume_m3?: number; cement_bags: number; sand_m3?: number; aggregate_m3?: number;
  water_l?: number; slump_mm?: number; mixer?: string; batched_at?: string;
}
export interface IssuePourMaterialsPayload extends Op {
  pour_id: string; miv_id: string; number: string; store_id?: string; issued_at?: string; remarks?: string;
  lines: { material_spec_id: string; qty: number; batch_no?: string }[];   // split pro-rata over pour elements
}
export interface ClosePourPayload extends Op { pour_id: string; actual_m3?: number; end_at?: string; remarks?: string; cancel?: boolean }
export interface SaveCubeSetPayload extends Op {
  id: string; project_id: string; number: string; pour_id: string; truck_id?: string; element_id?: string; sampled_at?: string;
  cubes_count?: number; cube_size_mm?: number; test_ages?: number[]; lab_name?: string;
}
export interface RecordCubeResultsPayload extends Op {
  cube_set_id: string;
  results: { id: string; cube_label: string; age_days: number; tested_on?: string; load_kn?: number; strength_mpa?: number; density_kg_m3?: number; failure_mode?: string }[];
  snag?: { id?: string; number?: string; assignee_user_id?: string };   // used if the 28-day set fails
}
export interface RecordCubeResultsResult { ok: true; id: string; result_early: 'ok' | 'low' | null; result_28d: 'pass' | 'fail' | null; mean_28d_mpa: number | null; snag_id: string | null }

export interface SaveBbsPayload extends Op {
  id: string; project_id: string; number: string; element_id: string; revision?: number; drawing_ref?: string; remarks?: string;
  lines: { id: string; bar_mark: string; material_spec_id?: string; diameter_mm?: number; shape_code?: string;
           no_of_members?: number; bars_per_member: number; cut_length_m: number }[];   // diameter inferred from spec grade 'Ø16' if omitted
}
export interface ApproveBbsPayload extends Op { bbs_id: string; update_takeoff?: boolean }

export interface RpcMapField {
  save_site_diary: SaveSiteDiaryPayload;
  sign_site_diary: SignSiteDiaryPayload;
  add_diary_addendum: AddDiaryAddendumPayload;
  get_diary_summary: GetDiarySummaryPayload;
  save_checklist_template: SaveChecklistTemplatePayload;
  request_inspection: RequestInspectionPayload;
  submit_inspection: SubmitInspectionPayload;
  cancel_inspection: CancelInspectionPayload;
  save_snag: SaveSnagPayload;
  snag_action: SnagActionPayload;
  save_mix_design: SaveMixDesignPayload;
  save_pour: SavePourPayload;
  add_pour_truck: AddPourTruckPayload;
  receive_pour_truck: ReceivePourTruckPayload;
  add_pour_batch: AddPourBatchPayload;
  issue_pour_materials: IssuePourMaterialsPayload;
  close_pour: ClosePourPayload;
  save_cube_set: SaveCubeSetPayload;
  record_cube_results: RecordCubeResultsPayload;
  save_bbs: SaveBbsPayload;
  approve_bbs: ApproveBbsPayload;
}
export type RpcNameField = keyof RpcMapField;

/** Attachment entity_type values used by these features (photos, signatures, lab sheets, tickets). */
export type FieldAttachmentEntity = 'site_diary' | 'inspection' | 'inspection_item' | 'snag' | 'pour' | 'pour_truck' | 'cube_set' | 'bbs';
