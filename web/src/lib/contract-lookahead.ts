// Contract for the Monthly Tasks Window / look-ahead (migration 20261030000004_lookahead.sql).
// Copy next to contract.ts in each app (src/lib/contract-lookahead.ts). Pure TypeScript, no runtime deps.
//
// Flow: office engineer / coordinator generates (or pg_cron on the 25th) → reviews constraints & material
// needs, raises PRs → publishes → site engineers commit READY work per Mon–Sat week → report outcomes →
// coordinator/manager closes the week (PPC = completed / committed, reasons required, roll-forward).
//
// Type-only import so Node can run this file directly with type stripping.
import type { AppRole, SyncTable } from './contract';

// ---------------------------------------------------------------------------
// Enums & labels (en + am)
// ---------------------------------------------------------------------------

export type CalendarMode = 'gregorian' | 'ethiopian';
export type PlanStatus = 'draft' | 'published' | 'closed';
export type WeekStatus = 'open' | 'committed' | 'closed';   // committed = week started (locked)
export type WindowRole = 'starting' | 'ongoing' | 'finishing' | 'starting_next' | 'late' | 'manual';
export type Readiness = 'ready' | 'at_risk' | 'not_ready';
export type ItemStatus = 'active' | 'dropped' | 'done';
export type ConstraintType =
  | 'predecessor' | 'material' | 'approval' | 'inspection' | 'information'   // auto-detected
  | 'labour' | 'equipment' | 'space' | 'external';                          // manual (external: Kiremt advisory is auto)
export type ConstraintStatus = 'open' | 'in_progress' | 'cleared' | 'blocked' | 'waived';
export type CommitmentKind = 'commitment' | 'candidate';                   // candidate = rolled forward, must be re-committed
export type CommitmentOutcome = 'pending' | 'completed' | 'not_completed';
export type RncCode =
  | 'materials' | 'prerequisite_work' | 'design_info' | 'failed_inspection' | 'labour' | 'equipment' | 'weather'
  | 'space_access' | 'approvals' | 'client_change' | 'bad_planning' | 'subcontractor' | 'power_water_outage' | 'other';
export type NeedStatus = 'late_order' | 'raise_pr_now' | 'to_order' | 'arrives_late' | 'in_procurement' | 'covered';

type L = { en: string; am: string };

export const READINESS_LABELS: Record<Readiness, L> = {
  ready: { en: 'Ready', am: 'ዝግጁ' },
  at_risk: { en: 'At risk', am: 'ስጋት አለ' },
  not_ready: { en: 'Not ready', am: 'ዝግጁ አይደለም' },
};
export const WINDOW_ROLE_LABELS: Record<WindowRole, L> = {
  starting: { en: 'Starting', am: 'የሚጀመር' },
  ongoing: { en: 'Ongoing', am: 'በሂደት ላይ' },
  finishing: { en: 'Finishing', am: 'የሚጠናቀቅ' },
  starting_next: { en: 'Starts next (make-ready)', am: 'በቀጣይ የሚጀመር' },
  late: { en: 'Late', am: 'የዘገየ' },
  manual: { en: 'Added manually', am: 'በእጅ የተጨመረ' },
};
export const CONSTRAINT_LABELS: Record<ConstraintType, L & { short: string }> = {
  predecessor: { en: 'Predecessor work', am: 'ቀዳሚ ሥራ', short: 'Pred' },
  material: { en: 'Materials', am: 'ግብዓት', short: 'Mat' },
  approval: { en: 'Approval', am: 'ማጽደቅ', short: 'Appr' },
  inspection: { en: 'Inspection / hold point', am: 'ፍተሻ', short: 'Insp' },
  information: { en: 'Drawing / information', am: 'ስዕል / መረጃ', short: 'Dwg' },
  labour: { en: 'Labour', am: 'የሰው ኃይል', short: 'Lab' },
  equipment: { en: 'Equipment', am: 'መሣሪያ', short: 'Eqp' },
  space: { en: 'Space / access', am: 'ቦታ / መዳረሻ', short: 'Space' },
  external: { en: 'Weather / permit', am: 'የአየር ሁኔታ / ፈቃድ', short: 'Ext' },
};
export const CONSTRAINT_STATUS_LABELS: Record<ConstraintStatus, L> = {
  open: { en: 'Open', am: 'ክፍት' },
  in_progress: { en: 'In progress', am: 'በሂደት ላይ' },
  cleared: { en: 'Cleared', am: 'ተፈቷል' },
  blocked: { en: 'Blocked', am: 'ታግዷል' },
  waived: { en: 'Waived', am: 'ታልፏል' },
};
export const RNC_LABELS: Record<RncCode, L> = {
  materials: { en: 'Materials not available', am: 'የግብዓት እጥረት' },
  prerequisite_work: { en: 'Prerequisite work not complete', am: 'ቀዳሚ ሥራ አልተጠናቀቀም' },
  design_info: { en: 'Design / information missing', am: 'የዲዛይን ወይም የመረጃ ችግር' },
  failed_inspection: { en: 'Failed or pending inspection', am: 'ፍተሻ አላለፈም' },
  labour: { en: 'Labour / crew not available', am: 'የሰው ኃይል እጥረት' },
  equipment: { en: 'Equipment not available', am: 'የመሣሪያ ችግር' },
  weather: { en: 'Weather', am: 'የአየር ሁኔታ' },
  space_access: { en: 'Space / access not available', am: 'ቦታ ወይም መዳረሻ አልተገኘም' },
  approvals: { en: 'Approval / permit late', am: 'ፈቃድ ወይም ማጽደቅ ዘግይቷል' },
  client_change: { en: 'Client / design change', am: 'የአሠሪ ለውጥ' },
  bad_planning: { en: 'Over-commitment / poor planning', am: 'ከአቅም በላይ ዕቅድ' },
  subcontractor: { en: 'Subcontractor did not perform', am: 'ንዑስ ተቋራጭ' },
  power_water_outage: { en: 'Power or water outage', am: 'የመብራት ወይም የውሃ መቋረጥ' },
  other: { en: 'Other', am: 'ሌላ' },
};
export const NEED_STATUS_LABELS: Record<NeedStatus, L> = {
  late_order: { en: 'Order date passed', am: 'የትዕዛዝ ቀን አልፏል' },
  raise_pr_now: { en: 'Raise purchase request now', am: 'አሁን የግዥ ጥያቄ ያቅርቡ' },
  to_order: { en: 'To order', am: 'የሚታዘዝ' },
  arrives_late: { en: 'Arrives late', am: 'ዘግይቶ ይደርሳል' },
  in_procurement: { en: 'In procurement', am: 'በግዥ ሂደት ላይ' },
  covered: { en: 'Covered', am: 'ተሸፍኗል' },
};

// ---------------------------------------------------------------------------
// Permissions (mirror the RPC role checks)
// ---------------------------------------------------------------------------

export type LookaheadAction =
  | 'lookahead.generate' | 'lookahead.publish' | 'lookahead.assign' | 'lookahead.refresh' | 'lookahead.constraint'
  | 'lookahead.commit' | 'lookahead.report' | 'lookahead.close_week' | 'lookahead.raise_pr' | 'lookahead.raise_sur';
const LA_PERMS: Record<LookaheadAction, AppRole[]> = {
  'lookahead.generate': ['office_engineer', 'coordinator', 'admin'],
  'lookahead.publish': ['office_engineer', 'coordinator', 'admin'],
  'lookahead.assign': ['office_engineer', 'coordinator', 'admin'],
  'lookahead.refresh': ['site_engineer', 'office_engineer', 'coordinator', 'manager', 'procurement', 'admin'],
  'lookahead.constraint': ['site_engineer', 'office_engineer', 'coordinator', 'procurement', 'manager', 'admin'],
  'lookahead.commit': ['site_engineer', 'coordinator', 'admin'],
  'lookahead.report': ['site_engineer', 'coordinator', 'admin'],
  'lookahead.close_week': ['coordinator', 'manager', 'admin'],
  'lookahead.raise_pr': ['office_engineer', 'coordinator', 'manager', 'admin'],
  'lookahead.raise_sur': ['site_engineer', 'office_engineer', 'coordinator', 'admin'],
};
export const canLookahead = (role: AppRole | null | undefined, action: LookaheadAction) =>
  !!role && LA_PERMS[action].includes(role);

// ---------------------------------------------------------------------------
// Sync (mobile: current + next plan only — filter lookahead_* by plan_id)
// ---------------------------------------------------------------------------

export const SYNC_TABLES_LOOKAHEAD: SyncTable[] = [
  { name: 'lookahead_plans', pk: ['id'] },
  { name: 'lookahead_weeks', pk: ['id'] },
  { name: 'lookahead_items', pk: ['id'] },
  { name: 'lookahead_constraints', pk: ['id'] },
  { name: 'constraint_events', pk: ['id'] },
  { name: 'weekly_commitments', pk: ['id'] },
  { name: 'rnc_reasons', pk: ['code'] },
];
/** Online views (security_invoker, no prices). */
export const LOOKAHEAD_VIEWS = [
  'v_monthly_lookahead', 'v_lookahead_material_needs', 'v_lookahead_material_summary', 'v_lookahead_readiness',
  'v_ppc', 'v_ppc_by_responsible', 'v_rnc_pareto', 'v_constraint_removal',
] as const;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface LookaheadPlan {
  id: string; project_id: string; calendar_mode: CalendarMode; period_year: number; period_month: number;
  period_label: string; period_label_am: string | null; period_start: string; period_end: string; horizon_end: string;
  working_days: number; status: PlanStatus; schedule_id: string | null; schedule_version_id: string | null;
  generated_at: string | null; generated_by: string | null; refreshed_at: string | null;
  published_at: string | null; published_by: string | null; closed_at: string | null; notes: string | null; updated_at: string;
}
export interface LookaheadWeek {
  id: string; plan_id: string; project_id: string; week_no: number; week_start: string; week_end: string;
  working_days: number; in_buffer: boolean; status: WeekStatus; committed_count: number | null; completed_count: number | null;
  ppc: number | null; pcr: number | null; ta: number | null; closed_by: string | null; closed_at: string | null; updated_at: string;
}
export interface LookaheadItem {
  id: string; plan_id: string; project_id: string; schedule_task_id: string | null; element_id: string | null;
  wbs: string | null; group_name: string | null; name: string; window_role: WindowRole; is_milestone: boolean; is_critical: boolean;
  total_float_days: number | null; planned_start: string | null; planned_finish: string | null;
  pct_at_generation: number; pct_complete: number; target_pct_end_of_period: number | null;
  /** { 'YYYY-MM-DD' (week_start): working days of the task in that week } */
  week_days: Record<string, number>;
  responsible_id: string | null; readiness: Readiness; status: ItemStatus; first_seen_on: string; sort_key: string | null;
  notes: string | null; updated_at: string;
}
export interface LookaheadConstraint {
  id: string; item_id: string; project_id: string; ctype: ConstraintType; description: string; auto: boolean; advisory: boolean;
  source_type: 'schedule_task' | 'material_spec' | 'material_request' | 'element_activity' | 'element_drawing' | 'diary_instruction' | 'kiremt' | null;
  source_id: string | null; material_spec_id: string | null; qty_short: number | null; linked_mr_id: string | null;
  owner_id: string | null; owner_role: string | null; due_date: string | null; status: ConstraintStatus;
  cleared_at: string | null; cleared_on: string | null; cleared_by: string | null; created_by: string | null; updated_at: string;
}
export interface ConstraintEvent {
  id: string; constraint_id: string; project_id: string;
  action: 'created' | 'auto_created' | 'auto_cleared' | 'auto_reopened' | 'status' | 'owner' | 'due' | 'comment' | 'pr_raised';
  from_status: ConstraintStatus | null; to_status: ConstraintStatus | null; comment: string | null; payload: unknown;
  actor: string | null; created_at: string;
}
export interface WeeklyCommitment {
  id: string; item_id: string; week_id: string; plan_id: string; project_id: string; kind: CommitmentKind; description: string;
  target_pct: number | null; target_qty: number | null; target_uom: string | null; committed_by: string; committed_at: string;
  readiness_at_commit: Readiness; override_reason: string | null; outcome: CommitmentOutcome;
  actual_pct: number | null; actual_qty: number | null; rnc_code: RncCode | null; rnc_note: string | null;
  reported_by: string | null; reported_at: string | null; rolled_from_id: string | null; rolled_to_id: string | null;
  closed_by: string | null; closed_at: string | null; updated_at: string;
}
export interface RncReason { code: RncCode; label: string; label_am: string | null; category: string; is_lci: boolean; sort: number }

/** v_lookahead_material_needs (per plan × item × spec). */
export interface LookaheadMaterialNeed {
  plan_id: string; project_id: string; item_id: string; item_name: string; material_spec_id: string; label: string; uom: string;
  total_need: number; remaining: number; window_need: number; weekly_need: Record<string, number>;
  need_by: string; order_by: string; lead_time_days: number; safety_days: number; pack_size: number;
  ati_before: number; from_stock: number; from_po: number; from_po_late: number; from_procurement: number; from_pending_pr: number;
  short_firm: number; to_order: number; suggested_qty: number;
  raise_pr_now: boolean; late_order: boolean; arrives_late: boolean; suggest_sur: boolean;
  next_po_eta: string | null; late_po_eta: string | null; po_numbers: string[]; mr_numbers: string[]; need_status: NeedStatus;
}
/** v_ppc */
export interface PpcWeek {
  week_id: string; plan_id: string; project_id: string; period_label: string; week_no: number; week_start: string; week_end: string;
  working_days: number; in_buffer: boolean; status: WeekStatus; committed: number; completed: number; not_completed: number;
  pending: number; candidates: number; overrides: number; ppc: number | null; pcr: number | null; ta: number | null;
  ppc_rolling_4w: number | null; ppc_target: number | null;
}

// ---------------------------------------------------------------------------
// RPC payloads — supabase.rpc(name, { p })
// ---------------------------------------------------------------------------

interface Op { op_id: string }
type MonthSel = { year: number; month: number } | { month: `${number}-${number}` };

/** Default month = next planning month. Regenerating keeps responsible/manual constraints/commitments. */
export type GenerateLookaheadPayload = Op & { project_id: string; calendar_mode?: CalendarMode; horizon_weeks?: number;
  plan_id?: string; schedule_id?: string } & Partial<MonthSel>;
export type LookaheadPreviewPayload = { project_id: string; calendar_mode?: CalendarMode; horizon_weeks?: number; schedule_id?: string } & Partial<MonthSel>;
export interface UpdateConstraintPayload extends Op {
  id: string;                       // new uuid → creates a manual constraint (needs item_id, ctype, description)
  item_id?: string; ctype?: ConstraintType; description?: string; material_spec_id?: string; qty_short?: number;
  owner_id?: string | null; owner_role?: AppRole; due_date?: string; status?: ConstraintStatus;
  comment?: string;                 // required to waive, and to clear a material auto constraint by hand
}
export interface CommitPayload extends Op {
  id: string;                       // existing candidate id to confirm a rolled-forward task
  item_id: string; week_id?: string; week_start?: string; description?: string;
  target_pct?: number; target_qty?: number; target_uom?: string;
  override_reason?: string;         // required when the item is not `ready`
}
export interface ReportCommitmentPayload extends Op {
  commitment_id: string; outcome: CommitmentOutcome; actual_pct?: number; actual_qty?: number; rnc_code?: RncCode; rnc_note?: string;
}
export interface CloseWeekPayload extends Op {
  week_id: string;
  results: { commitment_id: string; outcome: 'completed' | 'not_completed'; actual_pct?: number; actual_qty?: number;
             rnc_code?: RncCode; rnc_note?: string; roll_forward?: boolean /* default true */ }[];
}
/** Without `lines`: every material with something to order (or only raise_pr_now ones with only_urgent). Qty rounded up to pack size. */
export interface CreatePrsFromLookaheadPayload extends Op {
  plan_id: string; id?: string; number?: string; store_id?: string; block_id?: string; submit?: boolean; only_urgent?: boolean;
  lines?: { material_spec_id: string; qty: number; need_by?: string; item_ids?: string[] }[];
}
/** Without `lines`: the item's need covered by stock (the week's need when week_id is given), split to elements by take-off. */
export interface CreateSurFromLookaheadPayload extends Op {
  item_id: string; week_id?: string; id?: string; number?: string; store_id?: string; block_id?: string; required_date?: string;
  submit?: boolean; lines?: { material_spec_id: string; qty: number }[];
}

export interface RpcMapLookahead {
  generate_lookahead: GenerateLookaheadPayload;      // → { ok, plan_id, status, period_*, horizon_end, weeks, new, dropped, items, ready, at_risk, not_ready, constraints_open, material_shortfalls, raise_pr_now, late_order, constraints:{new,auto_cleared,reopened} }
  refresh_lookahead: { op_id?: string; plan_id: string };   // → same summary
  publish_lookahead: Op & { plan_id: string };       // → { ok, plan_id, status }
  assign_lookahead_item: Op & ({ item_id: string } | { item_ids: string[] }) & { responsible_id: string | null };
  update_constraint: UpdateConstraintPayload;        // → { ok, id, status, readiness }
  commit_lookahead_item: CommitPayload;              // → { ok, id, week_id, readiness_at_commit }
  report_commitment: ReportCommitmentPayload;        // → { ok, id, outcome }
  close_week: CloseWeekPayload;                      // → { ok, week_id, committed, completed, ppc, pcr, ta, rolled, plan_status }
  create_prs_from_lookahead: CreatePrsFromLookaheadPayload;  // → { ok, id, number, status, store_id, lines }
  create_sur_from_lookahead: CreateSurFromLookaheadPayload;  // → { ok, id, number, status, lines }
  get_lookahead_preview: LookaheadPreviewPayload;    // → { period_*, horizon_end, working_days, weeks[], items[], plan_id|null }
}
export type RpcNameLookahead = keyof RpcMapLookahead;

/** Extra v_my_approvals rows from the look-ahead (same MyApproval shape as contract-control). */
export type LookaheadApprovalKind = 'lookahead_constraint' | 'lookahead_week_close';
export const LOOKAHEAD_APPROVAL_RPC = { lookahead_constraint: 'update_constraint', lookahead_week: 'close_week' } as const;

// ---------------------------------------------------------------------------
// Helpers (same rules as the database)
// ---------------------------------------------------------------------------

/** ready: nothing open · not_ready: blocked or a non-advisory open constraint past due · else at_risk. */
export const readinessOf = (cs: Pick<LookaheadConstraint, 'status' | 'due_date' | 'advisory'>[], today: string): Readiness => {
  const open = cs.filter((c) => c.status === 'open' || c.status === 'in_progress' || c.status === 'blocked');
  if (open.length === 0) return 'ready';
  return open.some((c) => !c.advisory && (c.status === 'blocked' || (c.due_date !== null && c.due_date < today))) ? 'not_ready' : 'at_risk';
};
/** Worst open constraint first (blocked, then non-advisory, then earliest due) — for the bar chip. */
export const worstConstraint = <C extends Pick<LookaheadConstraint, 'status' | 'due_date' | 'advisory'>>(cs: C[]): C | undefined =>
  cs.filter((c) => c.status === 'open' || c.status === 'in_progress' || c.status === 'blocked')
    .sort((a, b) => Number(b.status === 'blocked') - Number(a.status === 'blocked') || Number(a.advisory) - Number(b.advisory)
      || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))[0];
export const ppc = (completed: number, committed: number) => (committed > 0 ? Math.round((10000 * completed) / committed) / 100 : null);
export const roundToPack = (qty: number, pack: number) => (qty > 0 ? Math.ceil(qty / (pack || 1) - 1e-9) * (pack || 1) : 0);
export const ppcTone = (value: number | null, target = 80): 'good' | 'watch' | 'poor' | 'none' =>
  value === null ? 'none' : value >= target ? 'good' : value >= target - 20 ? 'watch' : 'poor';
/** Window class rule (s/f = forecast else planned). */
export const windowRoleOf = (s: string, f: string, periodStart: string, periodEnd: string): WindowRole =>
  f < periodStart ? 'late' : s > periodEnd ? 'starting_next' : s >= periodStart ? 'starting' : f <= periodEnd ? 'finishing' : 'ongoing';
/** Can a commitment for this week still be made (site engineer: before the week starts; coordinator: up to day 1)? */
export const canCommitWeek = (week: Pick<LookaheadWeek, 'status' | 'week_start'>, today: string, role: AppRole) =>
  week.status === 'open' && (week.week_start > today || ((role === 'coordinator' || role === 'admin') && week.week_start >= today));
