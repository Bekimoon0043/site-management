// SQL aggregate reads for dashboards and long lists (spec §4.3, §6.10): COUNT(*) /
// GROUP BY over the local `rows` table instead of list() + JS filtering. Read-only;
// sync / outbox semantics are untouched.
import { getDb } from './db';
import { addDays, today } from './format';
import type { MaterialRequest, MrPriority, MrStatus } from './contract';

const j = (f: string, a = '') => `json_extract(${a ? `${a}.` : ''}json, '$.${f}')`;
const n = (sql: string, args: (string | number)[] = []) => getDb().getFirstSync<{ n: number | null }>(sql, args)?.n ?? 0;
const inList = (xs: string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(',');

export const MR_TO_ISSUE: MrStatus[] = ['approved', 'partially_issued'];
export const MR_PENDING: MrStatus[] = ['submitted', 'reviewed'];

export function countMr(projectId: string, statuses: MrStatus[], extra = '', args: (string | number)[] = []): number {
  return n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'material_requests' AND project_id = ? AND deleted = 0
            AND ${j('status')} IN (${inList(statuses)}) ${extra}`, [projectId, ...args]);
}

export function lowStockCount(projectId: string): number {
  return n(`SELECT COUNT(*) AS n FROM (
      SELECT ${j('material_spec_id')} AS sid,
             SUM(CASE WHEN ${j('stock_status')} = 'available' THEN CAST(${j('qty')} AS REAL) ELSE 0 END) AS q
      FROM rows WHERE tbl = 'stock_ledger' AND project_id = ? AND deleted = 0 GROUP BY sid) b
    JOIN rows s ON s.tbl = 'material_specs' AND s.pk = b.sid AND s.deleted = 0
    WHERE ${j('is_active', 's')} = 1 AND CAST(${j('reorder_level', 's')} AS REAL) > 0 AND b.q <= CAST(${j('reorder_level', 's')} AS REAL)`, [projectId]);
}

export interface DashboardCounts {
  awaitingIssue: number; dueToday: number; pendingApproval: number; submitted: number; oldestPending: string | null;
  lowStock: number; adjustments: number; counts: number; toAck: number; emergency: number; incoming: number;
  toVerify: number; delayed: number; active: number; avgProgress: number; elements: number;
  myOpen: number; returned: number; lookahead: number; overBoq: number; toConfirm: number; failedSync: number; pendingSync: number;
}

export function dashboardCounts(projectId: string, userId: string): DashboardCounts {
  const d = today();
  const els = getDb().getFirstSync<{ total: number; avg: number | null; delayed: number; active: number }>(
    `SELECT COUNT(*) AS total, AVG(CAST(${j('progress_pct')} AS REAL)) AS avg,
            SUM(CASE WHEN ${j('planned_finish')} IS NOT NULL AND ${j('planned_finish')} < ? AND ${j('status')} != 'completed' THEN 1 ELSE 0 END) AS delayed,
            SUM(CASE WHEN ${j('status')} = 'in_progress' OR (${j('planned_start')} IS NOT NULL AND ${j('planned_start')} <= ? AND ${j('status')} != 'completed') THEN 1 ELSE 0 END) AS active
     FROM rows WHERE tbl = 'elements' AND project_id = ? AND deleted = 0`, [d, d, projectId]);
  const ob = getDb().getFirstSync<{ f: number | null; p: number | null }>(
    `SELECT SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS f, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS p FROM outbox`);
  const oldest = getDb().getFirstSync<{ m: string | null }>(
    `SELECT MIN(${j('submitted_at')}) AS m FROM rows WHERE tbl = 'material_requests' AND project_id = ? AND deleted = 0
     AND ${j('status')} IN (${inList(MR_PENDING)})`, [projectId])?.m ?? null;
  return {
    awaitingIssue: countMr(projectId, MR_TO_ISSUE),
    dueToday: countMr(projectId, MR_TO_ISSUE, `AND ${j('required_date')} <= ?`, [d]),
    pendingApproval: countMr(projectId, MR_PENDING),
    submitted: countMr(projectId, ['submitted']),
    oldestPending: oldest,
    lowStock: lowStockCount(projectId),
    adjustments: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'adjustments' AND project_id = ? AND deleted = 0 AND ${j('status')} = 'pending'`, [projectId]),
    counts: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'stock_counts' AND project_id = ? AND deleted = 0 AND ${j('status')} = 'submitted'`, [projectId]),
    toAck: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'mivs' AND project_id = ? AND deleted = 0 AND ${j('issued_to')} = ? AND ${j('status')} = 'pending_ack'`, [projectId, userId]),
    emergency: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'mivs' AND project_id = ? AND deleted = 0 AND ${j('is_emergency')} = 1
                  AND ${j('mr_id')} IS NULL AND ${j('status')} != 'reversed'`, [projectId]),
    incoming: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'transfers' AND deleted = 0 AND ${j('to_project_id')} = ? AND ${j('status')} = 'in_transit'`, [projectId]),
    toVerify: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'progress_updates' AND project_id = ? AND deleted = 0 AND ${j('status')} = 'reported'`, [projectId]),
    delayed: els?.delayed ?? 0,
    active: els?.active ?? 0,
    avgProgress: els?.avg ?? 0,
    elements: els?.total ?? 0,
    myOpen: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'material_requests' AND project_id = ? AND deleted = 0 AND ${j('requested_by')} = ?
               AND ${j('status')} NOT IN ('closed','cancelled','rejected','issued')`, [projectId, userId]),
    returned: countMr(projectId, ['returned'], `AND ${j('requested_by')} = ?`, [userId]),
    lookahead: countMr(projectId, ['submitted', 'reviewed', 'approved', 'partially_issued'], `AND ${j('required_date')} <= ?`, [addDays(d, 14)]),
    overBoq: countMr(projectId, MR_PENDING, `AND EXISTS (SELECT 1 FROM rows l WHERE l.tbl = 'mr_lines' AND l.parent = rows.pk
               AND (${j('exceeds_boq', 'l')} = 1 OR COALESCE(${j('over_boq_reason', 'l')}, '') != ''))`),
    toConfirm: toConfirmCount(projectId, userId),
    failedSync: ob?.f ?? 0,
    pendingSync: ob?.p ?? 0,
  };
}

/** GRNs against my requests that I have not confirmed yet. */
function toConfirmCount(projectId: string, userId: string): number {
  return n(`SELECT COUNT(*) AS n FROM rows g WHERE g.tbl = 'grns' AND g.project_id = ? AND g.deleted = 0
      AND ${j('status', 'g')} = 'posted' AND ${j('confirmed_by', 'g')} IS NULL
      AND g.pk IN (SELECT ${j('grn_id', 'gl')} FROM rows gl WHERE gl.tbl = 'grn_lines' AND gl.project_id = ?
        AND ${j('mr_line_id', 'gl')} IN (SELECT ml.pk FROM rows ml WHERE ml.tbl = 'mr_lines' AND ml.project_id = ?
          AND ml.parent IN (SELECT r.pk FROM rows r WHERE r.tbl = 'material_requests' AND r.project_id = ? AND ${j('requested_by', 'r')} = ?)))`,
  [projectId, projectId, projectId, projectId, userId]);
}

// ---------------------------------------------------------------------------
// Request rows with line summary in one query (lists, approvals, home tasks)
// ---------------------------------------------------------------------------

export interface MrRow extends MaterialRequest { _pending?: string; lineCount: number; specIds: string[]; overBoq: boolean }

export function mrRows(projectId: string, where = '', args: (string | number)[] = [], order = `${j('created_at', 'r')} DESC`, limit?: number): MrRow[] {
  const rs = getDb().getAllSync<{ json: string; pending: string | null; n: number; sids: string | null; over: number }>(
    `SELECT r.json AS json, r.pending AS pending,
       (SELECT COUNT(*) FROM rows l WHERE l.tbl = 'mr_lines' AND l.parent = r.pk AND l.deleted = 0) AS n,
       (SELECT group_concat(sid) FROM (SELECT ${j('material_spec_id', 'l')} AS sid FROM rows l
          WHERE l.tbl = 'mr_lines' AND l.parent = r.pk AND l.deleted = 0 ORDER BY CAST(${j('line_no', 'l')} AS INTEGER) LIMIT 3)) AS sids,
       EXISTS (SELECT 1 FROM rows l WHERE l.tbl = 'mr_lines' AND l.parent = r.pk AND l.deleted = 0
          AND (${j('exceeds_boq', 'l')} = 1 OR COALESCE(${j('over_boq_reason', 'l')}, '') != '')) AS over
     FROM rows r WHERE r.tbl = 'material_requests' AND r.project_id = ? AND r.deleted = 0 ${where}
     ORDER BY ${order}${limit ? ` LIMIT ${Math.floor(limit)}` : ''}`, [projectId, ...args]);
  return rs.map((x) => {
    const o = JSON.parse(x.json) as MrRow;
    if (x.pending) o._pending = x.pending;
    o.lineCount = x.n;
    o.specIds = x.sids ? x.sids.split(',') : [];
    o.overBoq = !!x.over;
    return o;
  });
}
export const mrStatusIn = (statuses: string[]) => `AND ${j('status', 'r')} IN (${inList(statuses)})`;
export const mrField = (f: string) => j(f, 'r');

// ---------------------------------------------------------------------------
// Sync status for many entities in one read (list rows show a 16 dp icon)
// ---------------------------------------------------------------------------

export function syncStatusMap(): Map<string, 'pending' | 'failed'> {
  const m = new Map<string, 'pending' | 'failed'>();
  for (const r of getDb().getAllSync<{ entity_id: string; status: 'pending' | 'failed' }>(
    `SELECT entity_id, status FROM outbox WHERE status IN ('pending','failed') AND entity_id IS NOT NULL ORDER BY seq`)) {
    if (m.get(r.entity_id) !== 'failed') m.set(r.entity_id, r.status);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Stock balances via GROUP BY (stock list)
// ---------------------------------------------------------------------------

export interface BalanceSql { store_id: string; material_spec_id: string; available: number; quarantine: number; last: string }
export function stockBalancesSql(projectId: string): BalanceSql[] {
  return getDb().getAllSync<BalanceSql>(
    `SELECT ${j('store_id')} AS store_id, ${j('material_spec_id')} AS material_spec_id,
       SUM(CASE WHEN ${j('stock_status')} = 'available' THEN CAST(${j('qty')} AS REAL) ELSE 0 END) AS available,
       SUM(CASE WHEN ${j('stock_status')} = 'quarantine' THEN CAST(${j('qty')} AS REAL) ELSE 0 END) AS quarantine,
       COALESCE(MAX(${j('txn_at')}), '') AS last
     FROM rows WHERE tbl = 'stock_ledger' AND project_id = ? AND deleted = 0 GROUP BY 1, 2`, [projectId]);
}

/** Last progress report date per element. */
export function lastReportByElement(projectId: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of getDb().getAllSync<{ e: string; d: string }>(
    `SELECT parent AS e, MAX(${j('report_date')}) AS d FROM rows WHERE tbl = 'progress_updates' AND project_id = ? AND deleted = 0 GROUP BY parent`, [projectId])) {
    if (r.e) m.set(r.e, r.d);
  }
  return m;
}

/** Accepted quantity received so far against an MR line (non-reversed GRNs). */
export function receivedForLine(projectId: string, lineId: string): number {
  return n(`SELECT SUM(CAST(${j('qty_accepted', 'l')} AS REAL)) AS n FROM rows l
      JOIN rows g ON g.tbl = 'grns' AND g.pk = ${j('grn_id', 'l')}
      WHERE l.tbl = 'grn_lines' AND l.project_id = ? AND l.deleted = 0 AND ${j('mr_line_id', 'l')} = ? AND ${j('status', 'g')} != 'reversed'`, [projectId, lineId]);
}

export type { MrPriority };

/** Generic filtered read: `rowsWhere<Miv>('mivs', pid, "AND json_extract(json,'$.status') = ?", ['pending_ack'])`. */
export function rowsWhere<T>(tbl: string, projectId: string | null, where = '', args: (string | number)[] = [], order = '', limit?: number): (T & { _pending?: string })[] {
  const rs = getDb().getAllSync<{ json: string; pending: string | null }>(
    `SELECT json, pending FROM rows WHERE tbl = ? ${projectId ? 'AND project_id = ?' : ''} AND deleted = 0 ${where}
     ${order ? `ORDER BY ${order}` : ''}${limit ? ` LIMIT ${Math.floor(limit)}` : ''}`,
    [tbl, ...(projectId ? [projectId] : []), ...args]);
  return rs.map((r) => {
    const o = JSON.parse(r.json) as T & { _pending?: string };
    if (r.pending) o._pending = r.pending;
    return o;
  });
}
/** json_extract(json, '$.<field>') for rowsWhere clauses. */
export const jf = (f: string) => j(f);

// ---------------------------------------------------------------------------
// Field & quality badges (contract-field.ts tables)
// ---------------------------------------------------------------------------

export interface FieldCounts {
  cubesDue: number; snagsMine: number; snagsOpen: number; snagsOverdue: number; snagsToReview: number;
  diaryToday: 'none' | 'draft' | 'submitted' | 'signed'; diariesToSign: number; inspectionsRequested: number;
  trucksAwaiting: number; poursActive: number;
}

const SNAG_OPEN = `('open','in_progress','reopened','ready_for_review')`;

export function fieldCounts(projectId: string, userId: string): FieldCounts {
  const d = today();
  const diary = getDb().getFirstSync<{ s: string | null }>(
    `SELECT ${j('status')} AS s FROM rows WHERE tbl = 'site_diaries' AND project_id = ? AND deleted = 0 AND ${j('diary_date')} = ?
     ORDER BY CASE ${j('status')} WHEN 'signed' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END LIMIT 1`, [projectId, d])?.s ?? null;
  return {
    // one per set and test age without results, due today or overdue (v_cubes_due)
    cubesDue: n(`SELECT COUNT(*) AS n FROM rows c, json_each(${j('test_ages', 'c')}) a
        WHERE c.tbl = 'cube_sets' AND c.project_id = ? AND c.deleted = 0
          AND date(${j('sampled_at', 'c')}, 'localtime', '+' || a.value || ' days') <= ?
          AND NOT EXISTS (SELECT 1 FROM rows r WHERE r.tbl = 'cube_results' AND r.parent = c.pk AND r.deleted = 0
                          AND CAST(${j('age_days', 'r')} AS INTEGER) = CAST(a.value AS INTEGER))`, [projectId, d]),
    snagsMine: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'snags' AND project_id = ? AND deleted = 0 AND ${j('assignee_user_id')} = ?
                  AND ${j('status')} IN ('open','in_progress','reopened')`, [projectId, userId]),
    snagsOpen: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'snags' AND project_id = ? AND deleted = 0 AND ${j('status')} IN ${SNAG_OPEN}`, [projectId]),
    snagsOverdue: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'snags' AND project_id = ? AND deleted = 0 AND ${j('status')} IN ${SNAG_OPEN}
                     AND ${j('due_date')} IS NOT NULL AND ${j('due_date')} < ?`, [projectId, d]),
    snagsToReview: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'snags' AND project_id = ? AND deleted = 0 AND ${j('status')} = 'ready_for_review'`, [projectId]),
    diaryToday: (diary as FieldCounts['diaryToday'] | null) ?? 'none',
    diariesToSign: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'site_diaries' AND project_id = ? AND deleted = 0 AND ${j('status')} = 'submitted'
                      AND ${j('created_by')} != ?`, [projectId, userId]),
    inspectionsRequested: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'inspections' AND project_id = ? AND deleted = 0 AND ${j('status')} = 'requested'`, [projectId]),
    trucksAwaiting: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'pour_trucks' AND project_id = ? AND deleted = 0 AND ${j('status')} = 'awaiting_receipt'`, [projectId]),
    poursActive: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'pours' AND project_id = ? AND deleted = 0 AND ${j('status')} IN ('planned','in_progress')`, [projectId]),
  };
}

// ---------------------------------------------------------------------------
// Schedule progress + look-ahead badges (contract-schedule.ts, contract-lookahead.ts)
// ---------------------------------------------------------------------------

export interface ScheduleCounts {
  /** My (look-ahead responsible) leaf tasks past their finish and not 100 %. */
  myOverdue: number;
  /** Ready look-ahead items (mine or unassigned) with no commitment for next week while it can still be committed. */
  uncommittedReady: number;
  /** Open / in-progress / blocked constraints I own. */
  constraintsMine: number;
  /** Task progress reports waiting for verification (not mine). */
  tasksToVerify: number;
}

export function scheduleCounts(projectId: string, userId: string): ScheduleCounts {
  const d = today();
  const plans = getDb().getAllSync<{ pk: string; s: string; st: string; e: string }>(
    `SELECT pk, ${j('status')} AS st, ${j('period_start')} AS s, ${j('period_end')} AS e FROM rows
     WHERE tbl = 'lookahead_plans' AND project_id = ? AND deleted = 0`, [projectId]);
  const cur = plans.filter((p) => p.s <= d && p.e >= d || p.s > d);
  const planIn = inList(cur.map((p) => p.pk));
  const pubIn = inList(cur.filter((p) => p.st === 'published').map((p) => p.pk));
  const mine = cur.length ? n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'lookahead_items' AND project_id = ? AND deleted = 0
      AND ${j('plan_id')} IN (${planIn}) AND ${j('responsible_id')} = ?`, [projectId, userId]) : 0;
  const leaf = `t.tbl = 'schedule_tasks' AND t.project_id = ? AND t.deleted = 0 AND COALESCE(${j('is_summary', 't')}, 0) = 0
      AND COALESCE(${j('source_state', 't')}, 'active') = 'active' AND CAST(COALESCE(${j('pct_complete', 't')}, 0) AS REAL) < 100
      AND COALESCE(${j('forecast_finish', 't')}, ${j('planned_finish', 't')}) < ?
      AND ${j('schedule_id', 't')} IN (SELECT s.pk FROM rows s WHERE s.tbl = 'schedules' AND s.project_id = t.project_id AND s.deleted = 0
        AND ${j('status', 's')} != 'archived')`;
  const myOverdue = mine
    ? n(`SELECT COUNT(*) AS n FROM rows t WHERE ${leaf} AND t.pk IN (SELECT ${j('schedule_task_id', 'i')} FROM rows i
          WHERE i.tbl = 'lookahead_items' AND i.project_id = ? AND ${j('plan_id', 'i')} IN (${planIn}) AND ${j('responsible_id', 'i')} = ?)`,
      [projectId, d, projectId, userId])
    : 0;
  // next week = first look-ahead week starting after today that is still open
  const nextWeek = pubIn !== '' ? getDb().getFirstSync<{ pk: string }>(
    `SELECT pk FROM rows WHERE tbl = 'lookahead_weeks' AND project_id = ? AND ${j('plan_id')} IN (${pubIn})
       AND ${j('week_start')} > ? AND ${j('status')} = 'open' ORDER BY ${j('week_start')} LIMIT 1`, [projectId, d])?.pk ?? null : null;
  const uncommittedReady = nextWeek ? n(`SELECT COUNT(*) AS n FROM rows i WHERE i.tbl = 'lookahead_items' AND i.project_id = ? AND i.deleted = 0
      AND ${j('plan_id', 'i')} IN (${pubIn}) AND ${j('status', 'i')} = 'active' AND ${j('readiness', 'i')} = 'ready'
      AND (${j('responsible_id', 'i')} = ? OR ${j('responsible_id', 'i')} IS NULL)
      AND NOT EXISTS (SELECT 1 FROM rows c WHERE c.tbl = 'weekly_commitments' AND c.parent = i.pk AND ${j('week_id', 'c')} = ?
                      AND ${j('kind', 'c')} = 'commitment')
      AND COALESCE(${j('planned_start', 'i')}, '0000') <= (SELECT ${j('week_end', 'w')} FROM rows w WHERE w.tbl = 'lookahead_weeks' AND w.pk = ?)
      AND COALESCE(${j('planned_finish', 'i')}, '9999') >= (SELECT ${j('week_start', 'w')} FROM rows w WHERE w.tbl = 'lookahead_weeks' AND w.pk = ?)`,
  [projectId, userId, nextWeek, nextWeek, nextWeek]) : 0;
  return {
    myOverdue,
    uncommittedReady,
    constraintsMine: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'lookahead_constraints' AND project_id = ? AND deleted = 0
        AND ${j('owner_id')} = ? AND ${j('status')} IN ('open','in_progress','blocked')`, [projectId, userId]),
    tasksToVerify: n(`SELECT COUNT(*) AS n FROM rows WHERE tbl = 'task_progress' AND project_id = ? AND ${j('status')} = 'reported'
        AND ${j('reported_by')} != ?`, [projectId, userId]),
  };
}

// ---------------------------------------------------------------------------
// Material procurement flow inbox (mirrors app.approvals_for kinds; contract-flows.ts FLOW_INBOX)
// ---------------------------------------------------------------------------

export type FlowInboxKind = 'mr_review' | 'mr_approve' | 'sur_issue' | 'pr_review' | 'pr_approve' | 'pr_accept' | 'delivery_ack' | 'miv_ack';
export const FLOW_INBOX_KINDS: FlowInboxKind[] = ['pr_review', 'pr_approve', 'pr_accept', 'mr_review', 'mr_approve', 'sur_issue', 'delivery_ack', 'miv_ack'];
export interface FlowInboxItem {
  kind: FlowInboxKind; entity: 'material_request' | 'delivery_notice' | 'miv'; id: string; number: string; at: string | null;
  urgent: boolean; required: string | null; lines: number; requestedBy: string | null; poId: string | null;
}

/** Request type of a material_requests row (rows pulled before the flows migration: PR numbers are purchases). */
const rtype = (a = '') => `COALESCE(${j('request_type', a)}, CASE WHEN ${j('number', a)} LIKE '%-PR-%' THEN 'purchase' ELSE 'site_use' END)`;

function flowQuery(kind: FlowInboxKind, projectId: string, userId: string, role: string): { sql: string; args: (string | number)[] } | null {
  const s = getDb().getFirstSync<{ rr: number | null; cr: number | null }>(
    `SELECT ${j('require_review')} AS rr, ${j('pr_require_coordinator_review')} AS cr FROM rows WHERE tbl = 'project_settings' AND pk = ?`, [projectId]);
  const requireReview = s?.rr == null ? true : !!s.rr;
  const requireCoord = s?.cr == null ? true : !!s.cr;
  const mr = (where: string, at: string, args: (string | number)[] = []) => ({
    sql: `SELECT '${kind}' AS kind, 'material_request' AS entity, r.pk AS id, ${j('number', 'r')} AS number, ${at} AS at,
            ${j('priority', 'r')} != 'normal' AS urgent, COALESCE(${j('issue_by', 'r')}, ${j('required_date', 'r')}) AS required,
            (SELECT COUNT(*) FROM rows l WHERE l.tbl = 'mr_lines' AND l.parent = r.pk AND l.deleted = 0) AS lines,
            ${j('requested_by', 'r')} AS requestedBy, NULL AS poId
          FROM rows r WHERE r.tbl = 'material_requests' AND r.project_id = ? AND r.deleted = 0 ${where}`,
    args: [projectId, ...args],
  });
  const st = (xs: string[]) => `AND ${j('status', 'r')} IN (${inList(xs)})`;
  const notMine = `AND COALESCE(${j('requested_by', 'r')}, '') != ?`;
  switch (kind) {
    case 'mr_review':
      if (role !== 'office_engineer' || !requireReview) return null;
      return mr(`AND ${rtype('r')} = 'site_use' ${st(['submitted'])}`, j('submitted_at', 'r'));
    case 'mr_approve':
      if (!['coordinator', 'manager', 'admin'].includes(role)) return null;
      return mr(`AND ${rtype('r')} = 'site_use' ${st(requireReview ? ['reviewed'] : ['reviewed', 'submitted'])} ${notMine}`,
        `COALESCE(${j('reviewed_at', 'r')}, ${j('submitted_at', 'r')})`, [userId]);
    case 'sur_issue':
      if (role !== 'store_keeper') return null;
      return mr(`AND ${rtype('r')} = 'site_use' ${st(['approved', 'partially_issued', 'sourced', 'ordered'])}`, j('approved_at', 'r'));
    case 'pr_review':
      if (role !== 'coordinator' || !requireCoord) return null;
      return mr(`AND ${rtype('r')} = 'purchase' ${st(['submitted'])} ${notMine}`, j('submitted_at', 'r'), [userId]);
    case 'pr_approve':
      if (!['manager', 'admin'].includes(role)) return null;
      return mr(`AND ${rtype('r')} = 'purchase' ${st(requireCoord ? ['reviewed_by_coordinator', 'reviewed'] : ['reviewed_by_coordinator', 'reviewed', 'submitted'])} ${notMine}
          AND NOT EXISTS (SELECT 1 FROM rows a WHERE a.tbl = 'mr_approvals' AND a.parent = r.pk AND a.deleted = 0
            AND ${j('actor', 'a')} = ? AND ${j('step', 'a')} = 'endorse' AND COALESCE(${j('superseded', 'a')}, 0) = 0)`,
        `COALESCE(${j('coordinator_reviewed_at', 'r')}, ${j('submitted_at', 'r')})`, [userId, userId]);
    case 'pr_accept':
      if (role !== 'procurement') return null;
      return mr(`AND ${rtype('r')} = 'purchase' ${st(['approved_by_management', 'approved'])}`, j('approved_at', 'r'));
    case 'delivery_ack':
      if (role !== 'store_keeper') return null;
      return {
        sql: `SELECT 'delivery_ack' AS kind, 'delivery_notice' AS entity, d.pk AS id, COALESCE(${j('number', 'po')}, 'PO') AS number,
                ${j('created_at', 'd')} AS at, ${j('expected_date', 'd')} <= ? AS urgent, ${j('expected_date', 'd')} AS required,
                json_array_length(${j('lines', 'd')}) AS lines, ${j('created_by', 'd')} AS requestedBy, ${j('po_id', 'd')} AS poId
              FROM rows d LEFT JOIN rows po ON po.tbl = 'purchase_orders' AND po.pk = ${j('po_id', 'd')}
              WHERE d.tbl = 'delivery_notices' AND d.project_id = ? AND d.deleted = 0 AND ${j('status', 'd')} = 'notified'`,
        args: [addDays(today(), 1), projectId],
      };
    case 'miv_ack':
      return {
        sql: `SELECT 'miv_ack' AS kind, 'miv' AS entity, m.pk AS id, ${j('number', 'm')} AS number, ${j('issued_at', 'm')} AS at, 0 AS urgent,
                NULL AS required, (SELECT COUNT(*) FROM rows l WHERE l.tbl = 'miv_lines' AND l.parent = m.pk AND l.deleted = 0) AS lines,
                ${j('issued_by', 'm')} AS requestedBy, NULL AS poId
              FROM rows m WHERE m.tbl = 'mivs' AND m.project_id = ? AND m.deleted = 0 AND ${j('status', 'm')} = 'pending_ack' AND ${j('issued_to', 'm')} = ?`,
        args: [projectId, userId],
      };
    default:
      return null;
  }
}

/** Per-kind counts of the flow inbox for this user (badges, "Needs you"). */
export function flowInboxCounts(projectId: string, userId: string, role: string): Record<FlowInboxKind, number> & { total: number } {
  const out = { total: 0 } as Record<FlowInboxKind, number> & { total: number };
  for (const k of FLOW_INBOX_KINDS) {
    const q = flowQuery(k, projectId, userId, role);
    out[k] = q ? n(`SELECT COUNT(*) AS n FROM (${q.sql})`, q.args) : 0;
    out.total += out[k];
  }
  return out;
}

/** Inbox items, urgent first then oldest. */
export function flowInboxItems(projectId: string, userId: string, role: string, kinds: FlowInboxKind[] = FLOW_INBOX_KINDS, limit = 200): FlowInboxItem[] {
  const out: FlowInboxItem[] = [];
  for (const k of kinds) {
    const q = flowQuery(k, projectId, userId, role);
    if (!q) continue;
    const rs = getDb().getAllSync<Omit<FlowInboxItem, 'urgent'> & { urgent: number }>(`SELECT * FROM (${q.sql}) ORDER BY urgent DESC, at ASC LIMIT ${Math.floor(limit)}`, q.args);
    for (const r of rs) out.push({ ...r, urgent: !!r.urgent });
  }
  return out;
}
