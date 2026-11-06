// Approval queue sources (inbox, sidebar badges, dashboard). One place decides
// "what is waiting for whom" so the badge count and the inbox always agree.
import type { Action, Adjustment, AdjustmentLine, MaterialRequest, Miv, MivLine, ProgressUpdate, StockCount, StockCountLine } from './contract';
import { check, countRows, supabase } from './supabase';
import { useAsync } from './hooks';
import type { PurchaseOrder } from './contract-procurement';
import type { GatePass, GatePassLine } from './contract-control';
import type { SiteDiary } from './contract-field';
import type { TaskProgress } from './contract-schedule';

export type QueueType = 'mr' | 'pr' | 'issue' | 'delivery' | 'adjustment' | 'count' | 'progress' | 'emergency' | 'po' | 'gate_pass' | 'diary' | 'task_progress' | 'baseline'
  | 'lookahead_constraint' | 'lookahead_week_close' | 'period_close' | 'rfq_award' | 'po_send' | 'po_receive' | 'client_ipc' | 'variation' | 'payment'
  | 'holiday' | 'tool_overdue' | 'stock_expiry' | 'site_ops' | 'office';

export const QUEUE_LABEL: Record<QueueType, string> = {
  mr: 'Site-use requests', pr: 'Purchase requests', issue: 'Store orders', delivery: 'Deliveries',
  adjustment: 'Adjustments', count: 'Counts', progress: 'Progress', emergency: 'Emergency issues', po: 'Purchase orders',
  gate_pass: 'Gate passes', diary: 'Site diaries', task_progress: 'Task progress', baseline: 'Baselines',
  lookahead_constraint: 'Constraints', lookahead_week_close: 'Week close', period_close: 'Period close', rfq_award: 'RFQs to award', po_send: 'POs to send', po_receive: 'Deliveries due',
  client_ipc: 'Payment certificates', variation: 'Variations', payment: 'Payments & invoices',
  holiday: 'Holidays: work or not',
  tool_overdue: 'Tools to get back', stock_expiry: 'Expiring stock',
  site_ops: 'Safety & permits', office: 'Office tasks & registers',
};

/** Flow inbox rows (v_my_approvals kinds from 20261030000002_mr_flows.sql). */
export const FLOW_QUEUE_KINDS = { pr: ['pr_review', 'pr_approve', 'pr_accept'], issue: ['sur_issue'], delivery: ['delivery_ack'] } as const;
export interface FlowQueueRow {
  kind: 'pr_review' | 'pr_approve' | 'pr_accept' | 'sur_issue' | 'delivery_ack'; entity_type: string; entity_id: string; project_id: string;
  number: string; title: string; status: string; requested_by: string | null; requested_at: string | null; is_urgent: boolean; actions: string[]; age_hours: number;
}
/** Roles whose inbox can hold flow items (delegates of these roles get them via v_my_approvals too). */
const FLOW_ROLES: Record<'pr' | 'issue' | 'delivery', string[]> = {
  pr: ['coordinator', 'manager', 'admin', 'procurement'], issue: ['store_keeper'], delivery: ['store_keeper'],
};

export type MrQueueRow = Pick<MaterialRequest, 'id' | 'number' | 'status' | 'priority' | 'submitted_at' | 'created_at' | 'requested_by' | 'block_id' | 'required_date' | 'purpose' | 'version'>
  & { mr_lines: { id: string; material_spec_id: string; qty: number; exceeds_boq: boolean; deleted_at: string | null }[] };
export type AdjQueueRow = Adjustment & { adjustment_lines: AdjustmentLine[] };
export type CountQueueRow = StockCount & { stock_count_lines: StockCountLine[]; remarks?: string | null };
export type ProgressQueueRow = ProgressUpdate & { element_activities: { name: string; seq: number; is_hold_point: boolean } | null };
export type EmergencyQueueRow = Miv & { miv_lines: MivLine[] };
export type PoQueueRow = Pick<PurchaseOrder, 'id' | 'number' | 'status' | 'supplier_id' | 'delivery_store_id' | 'order_date' | 'expected_date' | 'submitted_at' | 'created_at' | 'created_by' | 'revision' | 'approved_at'>
  & { suppliers: { name: string } | null };
export type GatePassQueueRow = GatePass & { gate_pass_lines: GatePassLine[] };
export type DiaryQueueRow = SiteDiary;
/** Schedule task progress to verify (verify_task_progress) and baselines to approve (approve_baseline). */
export type TaskProgressQueueRow = TaskProgress & {
  delay_cause: string | null;
  /** % the task stood at before this report: the previous pending report of the same task, else the verified %. Set by the inbox. */
  prev_pct?: number;
  schedule_tasks: { name: string; wbs: string | null; msp_uid: number; ev_method: string; is_critical: boolean; pct_complete: number; planned_finish: string | null } | null;
};
export type BaselineQueueRow = {
  id: string; schedule_id: string; baseline_no: number; name: string; source: 'msp_baseline' | 'current_plan'; msp_baseline_number: number | null; effective_from: string;
  reason: string | null; status: string; task_count: number; proposed_by: string | null; proposed_at: string; schedules: { code: string; name: string } | null;
};
/** Planning inbox rows from v_my_approvals (20261030000003 period_close, 20261030000004 lookahead_*); the server decides per user. */
export const PLAN_QUEUE_KINDS = ['lookahead_constraint', 'lookahead_week_close', 'period_close', 'rfq_award', 'po_send', 'po_receive', 'client_ipc', 'variation', 'payment', 'holiday', 'tool_overdue', 'stock_expiry', 'site_ops', 'office'] as const;
export type PlanQueueKind = (typeof PLAN_QUEUE_KINDS)[number];
export interface PlanQueueRow {
  kind: PlanQueueKind; entity_type: string; entity_id: string; project_id: string; number: string; title: string; status: string;
  requested_by: string | null; requested_at: string | null; is_urgent: boolean; actions: string[]; age_hours: number;
}
const LA_CONSTRAINT_ROLES = ['site_engineer', 'office_engineer', 'coordinator', 'procurement', 'manager', 'admin'];
const PLAN_CLOSE_ROLES = ['coordinator', 'manager', 'admin'];
const SCHED_VERIFY_ROLES = ['office_engineer', 'coordinator', 'manager', 'admin'];
const BASELINE_APPROVE_ROLES = ['coordinator', 'manager', 'admin'];

/** Which MR statuses this user acts on. */
export function mrStatusesFor(can: (a: Action) => boolean): string[] {
  if (can('mr.approve')) return ['submitted', 'reviewed'];
  if (can('mr.review')) return ['submitted'];
  return [];
}

export function queueTypesFor(can: (a: Action) => boolean, role?: string | null): QueueType[] {
  const t: QueueType[] = [];
  if (mrStatusesFor(can).length) t.push('mr');
  for (const k of ['pr', 'issue', 'delivery'] as const) if (role && FLOW_ROLES[k].includes(role)) t.push(k);
  if (can('adjustment.decide')) t.push('adjustment');
  if (can('count.decide')) t.push('count');
  if (can('progress.verify')) t.push('progress');
  if (can('miv.post') && (can('mr.approve') || can('adjustment.decide'))) t.push('emergency');
  if (can('mr.approve')) t.push('po'); // po.approve = coordinator/manager/admin (contract-procurement)
  if (can('mr.approve')) t.push('gate_pass'); // gatepass.approve = coordinator/manager/admin (canControl)
  if (can('mr.review')) t.push('diary'); // diary.sign = office_engineer + management (canField)
  if (role ? SCHED_VERIFY_ROLES.includes(role) : can('progress.verify')) t.push('task_progress'); // progress.verify (contract-schedule)
  if (role ? BASELINE_APPROVE_ROLES.includes(role) : can('mr.approve')) t.push('baseline'); // baseline.approve
  if (role && LA_CONSTRAINT_ROLES.includes(role)) t.push('lookahead_constraint'); // constraints owned by me / my role
  if (role ? PLAN_CLOSE_ROLES.includes(role) : can('mr.approve')) t.push('lookahead_week_close', 'period_close'); // close_week / close_period
  if (role ? PLAN_CLOSE_ROLES.includes(role) : can('mr.approve')) t.push('rfq_award'); // rfq.award = management with price access (server filters)
  if (role === 'procurement' || role === 'admin') t.push('po_send'); // approved POs not yet sent to the supplier
  if (role === 'store_keeper' || role === 'admin') t.push('po_receive'); // sent POs due within 2 days or late
  if (role === 'store_keeper' || role === 'admin') t.push('tool_overdue', 'stock_expiry'); // 20261105000051/53: tools not returned, expired / expiring lots
  // client billing (20261103000060): check / approve / payment of IPCs, variation approval — price roles only
  if (role && can('prices.view') && ['coordinator', 'manager', 'finance', 'admin'].includes(role)) t.push('client_ipc');
  if (role && can('prices.view') && ['manager', 'admin'].includes(role)) t.push('variation');
  // The server filters payment steps and returned documents; preparers also include procurement and petty-cash custodians.
  if (role) t.push('payment');
  // project calendar (20261105000010): manager decides, coordinator / office engineer propose — holidays within 30 days
  if (role && ['office_engineer', 'coordinator', 'manager', 'admin'].includes(role)) t.push('holiday');
  // Site operations and office registers include personally owned actions for every role.
  if (role) t.push('site_ops', 'office');
  return t;
}

export const loadQueue = {
  mr: async (projectId: string, statuses: string[]) => check(await supabase.from('material_requests')
    .select('id, number, status, priority, submitted_at, created_at, requested_by, block_id, required_date, purpose, version, mr_lines(id, material_spec_id, qty, exceeds_boq, deleted_at)')
    .eq('project_id', projectId).eq('request_type', 'site_use').in('status', statuses).order('submitted_at', { ascending: true }).limit(500)) as unknown as MrQueueRow[],
  /** Purchase-request review / approve / accept, store orders to issue, delivery notices to accept (server decides per user). */
  flow: async (projectId: string, kinds: readonly string[]) => check(await supabase.from('v_my_approvals').select('*')
    .eq('project_id', projectId).in('kind', kinds as string[]).order('requested_at', { ascending: true }).limit(500)) as FlowQueueRow[],
  adjustment: async (projectId: string) => check(await supabase.from('adjustments').select('*, adjustment_lines(*)')
    .eq('project_id', projectId).eq('status', 'pending').order('created_at').limit(500)) as AdjQueueRow[],
  count: async (projectId: string) => check(await supabase.from('stock_counts').select('*, stock_count_lines(*)')
    .eq('project_id', projectId).eq('status', 'submitted').order('counted_at').limit(500)) as CountQueueRow[],
  progress: async (projectId: string) => check(await supabase.from('progress_updates').select('*, element_activities(name, seq, is_hold_point)')
    .eq('project_id', projectId).eq('status', 'reported').order('created_at').limit(500)) as ProgressQueueRow[],
  emergency: async (projectId: string) => check(await supabase.from('mivs').select('*, miv_lines(*)')
    .eq('project_id', projectId).eq('is_emergency', true).is('mr_id', null).neq('status', 'reversed').order('issued_at').limit(500)) as EmergencyQueueRow[],
  po: async (projectId: string) => check(await supabase.from('purchase_orders')
    .select('id, number, status, supplier_id, delivery_store_id, order_date, expected_date, submitted_at, created_at, created_by, revision, approved_at, suppliers(name)')
    .eq('project_id', projectId).eq('status', 'submitted').order('submitted_at').limit(500)) as unknown as PoQueueRow[],
  gate_pass: async (projectId: string) => check(await supabase.from('gate_passes').select('*, gate_pass_lines(*)')
    .eq('project_id', projectId).eq('status', 'pending').order('submitted_at').limit(500)) as GatePassQueueRow[],
  /** Submitted diaries the user may sign (authors can't sign their own). */
  diary: async (projectId: string) => {
    const me = (await supabase.auth.getSession()).data.session?.user.id ?? '';
    return check(await supabase.from('site_diaries').select('*').eq('project_id', projectId).eq('status', 'submitted').neq('created_by', me)
      .order('submitted_at').limit(500)) as DiaryQueueRow[];
  },
  /** Schedule task progress reported by someone else (reporters can't verify their own). */
  task_progress: async (projectId: string) => {
    const me = (await supabase.auth.getSession()).data.session?.user.id ?? '';
    return check(await supabase.from('task_progress')
      .select('*, schedule_tasks(name, wbs, msp_uid, ev_method, is_critical, pct_complete, planned_finish)')
      .eq('project_id', projectId).eq('status', 'reported').neq('reported_by', me).order('created_at').limit(500)) as unknown as TaskProgressQueueRow[];
  },
  baseline: async (projectId: string) => {
    const me = (await supabase.auth.getSession()).data.session?.user.id ?? '';
    return check(await supabase.from('schedule_baselines').select('*, schedules!schedule_baselines_schedule_id_fkey(code, name)')
      .eq('project_id', projectId).eq('status', 'proposed').neq('proposed_by', me).order('proposed_at').limit(100)) as unknown as BaselineQueueRow[];
  },
  /** Look-ahead constraints due ≤ 7 days, weeks to close, prepared EVM periods (v_my_approvals). */
  plan: async (projectId: string, kind: PlanQueueKind) => {
    const { data, error } = await supabase.from('v_my_approvals').select('*').eq('project_id', projectId).eq('kind', kind).order('requested_at', { ascending: true }).limit(500);
    if (error) return [] as PlanQueueRow[]; // view not extended yet → empty queue
    return (data ?? []) as PlanQueueRow[];
  },
};

export interface NavCounts { approvals: number; byType: Record<QueueType, number>; store: number; progress: number; emergencyOverdue: number; /** Delayed open POs. */ procurement: number; /** Open (unacknowledged) alerts — management. */ alerts: number }

/** Head-only count queries (no rows downloaded). */
async function loadCounts(projectId: string, can: (a: Action) => boolean, role?: string): Promise<NavCounts> {
  const types = queueTypesFor(can, role);
  const statuses = mrStatusesFor(can);
  const zero = Promise.resolve(0);
  const flowCount = (k: 'pr' | 'issue' | 'delivery') => (types.includes(k)
    ? countRows(() => supabase.from('v_my_approvals').select('entity_id', { count: 'exact', head: true }).eq('project_id', projectId).in('kind', FLOW_QUEUE_KINDS[k] as unknown as string[])).catch(() => 0)
    : zero);
  const [pr, issue, delivery] = await Promise.all([flowCount('pr'), flowCount('issue'), flowCount('delivery')]);
  const [mr, adjustment, count, progress, emergency, emergencyOverdue, po, procurement] = await Promise.all([
    types.includes('mr') ? countRows(() => supabase.from('material_requests').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('request_type', 'site_use').in('status', statuses)) : zero,
    types.includes('adjustment') ? countRows(() => supabase.from('adjustments').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'pending')) : zero,
    types.includes('count') ? countRows(() => supabase.from('stock_counts').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'submitted')) : zero,
    types.includes('progress') ? countRows(() => supabase.from('progress_updates').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'reported')) : zero,
    types.includes('emergency') ? countRows(() => supabase.from('mivs').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('is_emergency', true).is('mr_id', null).neq('status', 'reversed')) : zero,
    countRows(() => supabase.from('v_overdue_emergency_issues').select('*', { count: 'exact', head: true }).eq('project_id', projectId)),
    types.includes('po') ? countRows(() => supabase.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'submitted')) : zero,
    can('mr.viewAll') ? countRows(() => supabase.from('v_po_status').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('is_delayed', true)) : zero,
  ]);
  // Field & control: gate passes from v_my_approvals, diaries awaiting a signer other than the author, open alerts.
  const me = (await supabase.auth.getSession()).data.session?.user.id ?? '';
  const [gate_pass, diary, alerts] = await Promise.all([
    types.includes('gate_pass') ? countRows(() => supabase.from('v_my_approvals').select('entity_id', { count: 'exact', head: true }).eq('project_id', projectId).eq('kind', 'gate_pass_approve')) : zero,
    types.includes('diary') ? countRows(() => supabase.from('site_diaries').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'submitted').neq('created_by', me)) : zero,
    can('mr.approve') ? countRows(() => supabase.from('alerts').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'open')) : zero,
  ]);
  // Schedule: task progress to verify, baselines to approve (tables absent before the schedule migration → 0).
  const [task_progress, baseline] = await Promise.all([
    types.includes('task_progress') ? countRows(() => supabase.from('task_progress').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'reported').neq('reported_by', me)).catch(() => 0) : zero,
    types.includes('baseline') ? countRows(() => supabase.from('schedule_baselines').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'proposed').neq('proposed_by', me)).catch(() => 0) : zero,
  ]);
  // Planning: look-ahead constraints, week close, period close (v_my_approvals kinds).
  const planCount = (k: PlanQueueKind) => (types.includes(k)
    ? countRows(() => supabase.from('v_my_approvals').select('entity_id', { count: 'exact', head: true }).eq('project_id', projectId).eq('kind', k)).catch(() => 0) : zero);
  const [lookahead_constraint, lookahead_week_close, period_close, rfq_award, po_send, po_receive, client_ipc, variation, payment, holiday, tool_overdue, stock_expiry, site_ops, office] = await Promise.all(PLAN_QUEUE_KINDS.map(planCount));
  const byType = { mr, pr, issue, delivery, adjustment, count, progress, emergency, po, gate_pass, diary, task_progress, baseline, lookahead_constraint, lookahead_week_close, period_close, rfq_award, po_send, po_receive, client_ipc, variation, payment, holiday, tool_overdue, stock_expiry, site_ops, office };
  return { approvals: mr + pr + issue + delivery + adjustment + count + progress + emergency + po + gate_pass + diary + task_progress + baseline + lookahead_constraint + lookahead_week_close + period_close + rfq_award + po_send + po_receive + client_ipc + variation + payment + holiday + tool_overdue + stock_expiry + site_ops + office, byType, store: emergencyOverdue, progress, emergencyOverdue, procurement, alerts };
}

/** Sidebar/inbox badge counts, polled every 60 s while the tab is visible; refreshed after any RPC. */
export function useNavCounts(projectId: string | null, can: (a: Action) => boolean, role: string | undefined) {
  return useAsync(() => loadCounts(projectId!, can, role), [projectId, role], { key: 'navcounts', enabled: !!projectId, refetchInterval: 60_000, staleTime: 30_000 });
}
