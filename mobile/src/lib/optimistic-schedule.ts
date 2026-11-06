// Optimistic local apply for the schedule-progress and look-ahead outbox RPCs
// (OUTBOX_RPCS_SCHEDULE + the look-ahead site RPCs), mirroring
// 20261030000003_schedule_evm.sql / 20261030000004_lookahead.sql closely enough for offline use.
// Rows are tagged with the op id and replaced by server copies on pull.
import type { RpcMapSchedule, ScheduleTask, TaskBoqLink, TaskProgress } from './contract-schedule';
import {
  readinessOf, type LookaheadConstraint, type LookaheadItem, type LookaheadWeek, type RpcMapLookahead, type WeeklyCommitment,
} from './contract-lookahead';
import { get, list, putPending, type Row } from './db';
import { myId } from './me';
import { today } from './format';

export type RpcMapSL =
  Pick<RpcMapSchedule, 'report_task_progress' | 'verify_task_progress' | 'record_resource_usage'>
  & Pick<RpcMapLookahead, 'commit_lookahead_item' | 'report_commitment' | 'update_constraint'>;
type Name = keyof RpcMapSL;
const NAMES: Record<Name, true> = {
  report_task_progress: true, verify_task_progress: true, record_resource_usage: true,
  commit_lookahead_item: true, report_commitment: true, update_constraint: true,
};
export const SL_RPCS = new Set<string>(Object.keys(NAMES));

const now = () => new Date().toISOString();

function patch<T extends object>(tbl: string, id: string, changes: Partial<T>, op: string) {
  const cur = get<T>(tbl, id);
  if (!cur) return;
  const { _pending: _, ...rest } = cur as T & { _pending?: string };
  putPending(tbl, { ...rest, ...changes, updated_at: now() } as Row, op);
}

/** Same as app.units_pct with equal BoQ weights (rates are not on the phone). */
export function unitsPct(taskId: string, qty: { boq_item_id: string; qty_to_date: number }[] | null | undefined): number {
  const links = list<TaskBoqLink>('task_boq_links', { parent: taskId }).filter((l) => !l.deleted_at);
  const m = new Map((qty ?? []).map((q) => [q.boq_item_id, Number(q.qty_to_date)]));
  let done = 0, total = 0;
  for (const l of links) {
    const share = Number(l.qty_share);
    const q = m.get(l.boq_item_id) ?? Number(l.verified_qty);
    done += Math.min(Math.max(q, 0), share);
    total += share;
  }
  return total > 0 ? Math.round((10000 * done) / total) / 100 : 0;
}

function refreshItemReadiness(itemId: string, op: string) {
  const cs = list<LookaheadConstraint>('lookahead_constraints', { parent: itemId });
  const r = readinessOf(cs, today());
  const it = get<LookaheadItem>('lookahead_items', itemId);
  if (it && it.readiness !== r) patch<LookaheadItem>('lookahead_items', itemId, { readiness: r }, op);
}

export function applyOptimisticSchedule<N extends Name>(rpc: N, payload: RpcMapSL[N], op: string): void {
  const t = now();
  switch (rpc) {
    case 'report_task_progress': {
      const x = payload as RpcMapSL['report_task_progress'];
      const task = get<ScheduleTask>('schedule_tasks', x.task_id);
      if (!task) break;
      let qty = x.qty ?? null;
      if (!qty && x.qty_done != null) {
        const l = list<TaskBoqLink>('task_boq_links', { parent: x.task_id }).find((b) => !b.deleted_at);
        if (l) qty = [{ boq_item_id: l.boq_item_id, qty_to_date: x.qty_done }];
      }
      const pct = task.ev_method === 'units' ? unitsPct(x.task_id, qty) : Number(x.pct_complete ?? 0);
      const row: TaskProgress & { steps: unknown; delay_cause: string | null; updated_at: string } = {
        id: x.id, project_id: task.project_id, task_id: x.task_id, status_date: x.status_date ?? today(), original_status_date: null,
        method: task.ev_method, pct_complete: pct, qty_done: qty ? qty.reduce((s, q) => s + Number(q.qty_to_date), 0) : null, qty,
        steps: x.steps ?? null, remaining_days: x.remaining_days ?? null, actual_start: x.actual_start ?? null,
        actual_finish: x.actual_finish ?? null, remarks: x.remarks ?? null, delay_cause: x.delay_cause ?? null, status: 'reported',
        verified_pct: null, reported_by: myId(), verified_by: null, created_at: t, updated_at: t,
      };
      putPending('task_progress', row as unknown as Row, op);
      patch<ScheduleTask>('schedule_tasks', x.task_id, { reported_pct: pct }, op);
      for (const q of qty ?? []) {
        const l = list<TaskBoqLink>('task_boq_links', { parent: x.task_id }).find((b) => b.boq_item_id === q.boq_item_id);
        if (l) patch<TaskBoqLink>('task_boq_links', l.id, { reported_qty: q.qty_to_date }, op);
      }
      for (const s of x.steps ?? []) patch<{ reported_pct: number }>('task_steps', s.step_id, { reported_pct: s.done_pct }, op);
      break;
    }
    case 'verify_task_progress': {
      const x = payload as RpcMapSL['verify_task_progress'];
      const items = 'items' in x ? x.items : [x];
      for (const it of items) {
        const u = get<TaskProgress>('task_progress', it.progress_id);
        if (!u) continue;
        const task = get<ScheduleTask>('schedule_tasks', u.task_id);
        const pct = !it.approve ? null
          : task?.ev_method === 'units' ? unitsPct(u.task_id, it.verified_qty ?? u.qty)
            : Number(it.verified_pct ?? u.pct_complete ?? 0);
        const adjusted = it.approve && pct !== Number(u.pct_complete);
        patch<TaskProgress & { verify_comment: string | null }>('task_progress', u.id, {
          status: !it.approve ? 'rejected' : adjusted ? 'adjusted' : 'verified', verified_pct: pct, verified_by: myId(),
          verify_comment: it.comment ?? null,
        }, op);
        if (it.approve && task && pct != null) {
          patch<ScheduleTask>('schedule_tasks', task.id, {
            pct_complete: pct, actual_start: task.actual_start ?? u.actual_start ?? (pct > 0 ? u.status_date : null),
            actual_finish: pct >= 100 ? (u.actual_finish ?? u.status_date) : task.actual_finish,
          }, op);
          for (const q of it.verified_qty ?? u.qty ?? []) {
            const l = list<TaskBoqLink>('task_boq_links', { parent: task.id }).find((b) => b.boq_item_id === q.boq_item_id);
            if (l) patch<TaskBoqLink>('task_boq_links', l.id, { verified_qty: q.qty_to_date }, op);
          }
        }
      }
      break;
    }
    case 'record_resource_usage': {
      const x = payload as RpcMapSL['record_resource_usage'];
      putPending('resource_usage', { ...x, usage_date: x.usage_date ?? today(), created_by: myId(), created_at: t, updated_at: t } as unknown as Row, op);
      break;
    }
    case 'commit_lookahead_item': {
      const x = payload as RpcMapSL['commit_lookahead_item'];
      const item = get<LookaheadItem>('lookahead_items', x.item_id);
      if (!item) break;
      const week = x.week_id ? get<LookaheadWeek>('lookahead_weeks', x.week_id)
        : list<LookaheadWeek>('lookahead_weeks', { parent: item.plan_id }).find((w) => w.week_start === x.week_start) ?? null;
      if (!week) break;
      const ready = readinessOf(list<LookaheadConstraint>('lookahead_constraints', { parent: item.id }), today());
      const existing = get<WeeklyCommitment>('weekly_commitments', x.id);
      if (existing) {
        patch<WeeklyCommitment>('weekly_commitments', x.id, {
          kind: 'commitment', week_id: week.id, description: x.description?.trim() || existing.description,
          target_pct: x.target_pct ?? existing.target_pct, committed_by: myId(), committed_at: t, readiness_at_commit: ready,
          override_reason: ready !== 'ready' ? x.override_reason ?? null : null,
        }, op);
      } else {
        const row: WeeklyCommitment = {
          id: x.id, item_id: item.id, week_id: week.id, plan_id: item.plan_id, project_id: item.project_id, kind: 'commitment',
          description: x.description?.trim() || item.name, target_pct: x.target_pct ?? null, target_qty: x.target_qty ?? null,
          target_uom: x.target_uom ?? null, committed_by: myId(), committed_at: t, readiness_at_commit: ready,
          override_reason: ready !== 'ready' ? x.override_reason ?? null : null, outcome: 'pending', actual_pct: null, actual_qty: null,
          rnc_code: null, rnc_note: null, reported_by: null, reported_at: null, rolled_from_id: null, rolled_to_id: null,
          closed_by: null, closed_at: null, updated_at: t,
        };
        putPending('weekly_commitments', row as unknown as Row, op);
      }
      break;
    }
    case 'report_commitment': {
      const x = payload as RpcMapSL['report_commitment'];
      patch<WeeklyCommitment>('weekly_commitments', x.commitment_id, {
        outcome: x.outcome, actual_pct: x.actual_pct ?? null, actual_qty: x.actual_qty ?? null,
        rnc_code: x.outcome === 'not_completed' ? x.rnc_code ?? null : null, rnc_note: x.outcome === 'not_completed' ? x.rnc_note ?? null : null,
        reported_by: myId(), reported_at: t,
      }, op);
      break;
    }
    case 'update_constraint': {
      const x = payload as RpcMapSL['update_constraint'];
      const cur = get<LookaheadConstraint>('lookahead_constraints', x.id);
      const closing = x.status === 'cleared' || x.status === 'waived';
      if (cur) {
        patch<LookaheadConstraint>('lookahead_constraints', x.id, {
          ...(x.description && !cur.auto ? { description: x.description.trim() } : null),
          ...('owner_id' in x ? { owner_id: x.owner_id ?? null } : null),
          ...(x.due_date ? { due_date: x.due_date } : null),
          ...(x.status ? { status: x.status, cleared_at: closing ? t : null, cleared_on: closing ? today() : null, cleared_by: closing ? myId() : null } : null),
        }, op);
        refreshItemReadiness(cur.item_id, op);
      } else if (x.item_id && x.ctype && x.description) {
        const item = get<LookaheadItem>('lookahead_items', x.item_id);
        if (!item) break;
        const row: LookaheadConstraint = {
          id: x.id, item_id: item.id, project_id: item.project_id, ctype: x.ctype, description: x.description.trim(), auto: false,
          advisory: false, source_type: null, source_id: null, material_spec_id: x.material_spec_id ?? null, qty_short: x.qty_short ?? null,
          linked_mr_id: null, owner_id: x.owner_id ?? null, owner_role: x.owner_role ?? null, due_date: x.due_date ?? item.planned_start ?? null,
          status: x.status ?? 'open', cleared_at: closing ? t : null, cleared_on: closing ? today() : null, cleared_by: closing ? myId() : null,
          created_by: myId(), updated_at: t,
        };
        putPending('lookahead_constraints', row as unknown as Row, op);
        refreshItemReadiness(item.id, op);
      }
      break;
    }
    default:
      break;
  }
}
