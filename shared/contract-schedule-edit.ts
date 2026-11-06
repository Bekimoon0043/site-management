// Schedule editing in the app + resources (migration 20261103000030_schedule_editing.sql).
// Re-import rule: MS Project stays the master — the file wins; tasks/links created in the app that are not in
// the file are dropped on import. Export to MS Project XML first to keep in-app changes (UIDs are kept).
import type { LinkType } from './contract-schedule';

interface Op { op_id: string }

/** MS Project constraint types (Task.ConstraintType). */
export const CONSTRAINT_TYPES = [
  { value: 0, code: 'ASAP', label: 'As soon as possible' },
  { value: 1, code: 'ALAP', label: 'As late as possible' },
  { value: 2, code: 'MSO', label: 'Must start on' },
  { value: 3, code: 'MFO', label: 'Must finish on' },
  { value: 4, code: 'SNET', label: 'Start no earlier than' },
  { value: 5, code: 'SNLT', label: 'Start no later than' },
  { value: 6, code: 'FNET', label: 'Finish no earlier than' },
  { value: 7, code: 'FNLT', label: 'Finish no later than' },
] as const;

export interface PredecessorSpec { pred_uid?: number; pred_task_id?: string; link_type: LinkType; lag_days?: number; lag_pct?: number }

export type EditSchedulePayload = Op & { schedule_id?: string } & (
  | { action: 'add_task'; name: string; kind?: 'task' | 'milestone' | 'summary'; after_task_id?: string; parent_id?: string; duration_days?: number; start?: string; notes?: string }
  | { action: 'update_task'; task_id: string; name?: string; duration_days?: number; start?: string | null; constraint_type?: number; constraint_date?: string | null;
      deadline?: string | null; notes?: string | null; milestone?: boolean }
  | { action: 'delete_task' | 'indent' | 'outdent'; task_id: string }
  | { action: 'move'; task_id: string; direction: 'up' | 'down' }
  | { action: 'add_link' | 'update_link'; pred_task_id: string; succ_task_id: string; link_type: LinkType; lag_days?: number; lag_pct?: number }
  | { action: 'delete_link'; pred_task_id: string; succ_task_id: string; link_type?: LinkType }
  | { action: 'set_predecessors'; task_id: string; predecessors: PredecessorSpec[] }
);
export interface EditScheduleResult {
  ok: true; edit_id: string; task_id: string | null; summary: string; moved: number; planned_finish: string | null; fc_finish: string | null; critical_count: number;
}

export type ResourceKind = 'labour' | 'crew' | 'equipment' | 'material';
export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = { labour: 'Labour', crew: 'Crew', equipment: 'Equipment', material: 'Material' };

export interface ScheduleResource {
  id: string; project_id: string; code: string; name: string; kind: ResourceKind; unit: string; max_units: number;
  labour_trade_id: string | null; material_spec_id: string | null; notes: string | null; is_active: boolean;
}
export interface ScheduleResourceRate { resource_id: string; std_rate: number; cost_per_use: number }
export interface TaskAssignment { id: string; task_id: string; resource_id: string; units: number; notes: string | null }
export interface TaskResourceCost {
  assignment_id: string; task_id: string; resource_id: string; code: string; name: string; kind: ResourceKind; unit: string;
  units: number; work: number; std_rate: number | null; cost_per_use: number | null; cost: number | null;
}
export interface ScheduleEdit { id: string; action: string; task_id: string | null; summary: string; moved: number; undone_at: string | null; created_by: string; created_at: string }

export interface ResourceUsageWeek {
  week: string; demand: number; peak: number; capacity: number; working_days: number; over: boolean;
  tasks: { task_id: string; uid: number; name: string; units: number; total_float_days: number | null }[] | null;
}
export interface ResourceUsage {
  from: string; to: string; basis: 'plan' | 'forecast';
  resources: { id: string; code: string; name: string; kind: ResourceKind; unit: string; max_units: number; weeks: ResourceUsageWeek[] }[];
}

export type SaveScheduleResourcePayload = Op & {
  id?: string; project_id: string; code: string; name: string; kind: ResourceKind; unit?: string; max_units?: number;
  labour_trade_id?: string | null; material_spec_id?: string | null; notes?: string | null; is_active?: boolean;
  std_rate?: number; cost_per_use?: number;
};
export type AssignResourcesPayload = Op & { task_id: string; assignments: { resource_id: string; units: number; notes?: string }[] };

export interface RpcMapScheduleEdit {
  edit_schedule: EditSchedulePayload;                 // → EditScheduleResult
  undo_schedule_edit: Op & { schedule_id: string };   // → { ok, undone, edit_id, fc_finish }
  save_schedule_resource: SaveScheduleResourcePayload; // → { ok, id }
  assign_resources: AssignResourcesPayload;           // → { ok, task_id, assignments }
}
