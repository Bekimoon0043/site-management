// Schedule progress + look-ahead sync tables (contract-schedule.ts, contract-lookahead.ts).
// Pure module (no db import) so db.ts can use it for primary keys / parent columns.
// Money tables (PRICE_TABLES_SCHEDULE) are never synced to the phone.
import type { SyncTable } from './contract';
import { SYNC_TABLES_SCHEDULE } from './contract-schedule';
import { SYNC_TABLES_LOOKAHEAD } from './contract-lookahead';

export const SL_TABLES: SyncTable[] = [...SYNC_TABLES_SCHEDULE, ...SYNC_TABLES_LOOKAHEAD];

export const SL_PARENT_COLUMN: Record<string, string> = {
  calendar_exceptions: 'calendar_id', schedule_versions: 'schedule_id', schedule_tasks: 'schedule_id',
  schedule_links: 'succ_task_id', schedule_baseline_tasks: 'baseline_id',
  task_boq_links: 'task_id', task_element_links: 'task_id', task_steps: 'task_id', task_progress: 'task_id',
  evm_task_status: 'task_id', evm_variance_notes: 'period_id', resource_usage: 'task_id',
  lookahead_weeks: 'plan_id', lookahead_items: 'plan_id', lookahead_constraints: 'item_id',
  constraint_events: 'constraint_id', weekly_commitments: 'item_id',
};

/** Look-ahead tables filtered to the current + next plan of each project (by plan_id). */
export const LA_PLAN_FILTERED = new Set(['lookahead_weeks', 'lookahead_items', 'weekly_commitments']);
