// Optimistic local apply for the site-operations outbox RPCs (contract-site.ts, 20261105000030_site_ops.sql):
// incidents, toolbox talks, permits to work, plant register and daily plant log. Numbers are given by the server
// (shown as "pending" until the next sync); rows are replaced by the server copies on pull.
import type {
  HseIncident, PlantItem, PlantLog, RpcMapSite, ToolboxTalk, WorkPermit,
} from './contract-site';
import { get, putPending, type Row } from './db';
import { myId } from './me';

type Name = keyof RpcMapSite;
const NAMES: Record<Name, true> = {
  report_incident: true, incident_action: true, save_toolbox_talk: true, request_permit: true, permit_action: true, save_plant: true, log_plant: true,
};
export const SITE_RPCS = new Set<string>(Object.keys(NAMES));

const now = () => new Date().toISOString();
const PENDING_NO = 'pending';

function patch<T extends object>(tbl: string, id: string, changes: Partial<T>, op: string) {
  const cur = get<T>(tbl, id);
  if (!cur) return;
  const { _pending: _, ...rest } = cur as T & { _pending?: string };
  putPending(tbl, { ...rest, ...changes, updated_at: now() } as Row, op);
}

export function applyOptimisticSite<N extends Name>(rpc: N, payload: RpcMapSite[N], op: string): void {
  const t = now();
  switch (rpc) {
    case 'report_incident': {
      const x = payload as RpcMapSite['report_incident'];
      const cur = get<HseIncident>('hse_incidents', x.id);
      const row: HseIncident = {
        id: x.id, project_id: x.project_id, number: cur?.number ?? x.number ?? PENDING_NO, kind: x.kind, severity: x.severity ?? 'minor',
        occurred_at: x.occurred_at, location_text: x.location_text ?? null, element_id: x.element_id ?? null, description: x.description,
        immediate_action: x.immediate_action ?? null, injured_name: x.injured_name ?? null, injured_trade: x.injured_trade ?? null,
        injured_party: x.injured_party ?? null, body_part: x.body_part ?? null, first_aid: !!x.first_aid, hospital: !!x.hospital,
        lost_time: !!x.lost_time, days_lost: x.days_lost ?? 0, root_cause: cur?.root_cause ?? null, corrective_action: cur?.corrective_action ?? null,
        action_owner: cur?.action_owner ?? null, action_due: cur?.action_due ?? null, reported_to_authority: cur?.reported_to_authority ?? false,
        authority_ref: cur?.authority_ref ?? null, status: cur?.status ?? 'reported', close_note: null, reported_by: cur?.reported_by ?? myId(),
        investigated_by: null, investigated_at: null, closed_by: null, closed_at: null, created_at: cur?.created_at ?? t, updated_at: t,
      };
      putPending('hse_incidents', row as unknown as Row, op);
      break;
    }
    case 'incident_action': {
      const x = payload as RpcMapSite['incident_action'];
      patch<HseIncident>('hse_incidents', x.incident_id, x.action === 'investigate'
        ? { status: 'action', root_cause: x.root_cause ?? null, corrective_action: x.corrective_action ?? null, action_owner: x.action_owner ?? null, action_due: x.action_due ?? null }
        : x.action === 'close' ? { status: 'closed', closed_by: myId(), closed_at: t } : {}, op);
      break;
    }
    case 'save_toolbox_talk': {
      const x = payload as RpcMapSite['save_toolbox_talk'];
      const cur = get<ToolboxTalk>('toolbox_talks', x.id);
      const row: ToolboxTalk = {
        id: x.id, project_id: x.project_id, number: cur?.number ?? x.number ?? PENDING_NO, held_on: x.held_on, topic: x.topic, hazards: x.hazards ?? null,
        presenter_name: x.presenter_name ?? null, attendees_count: x.attendees_count, attendee_names: x.attendee_names ?? null, trades: x.trades ?? [],
        duration_min: x.duration_min ?? null, ppe_checked: !!x.ppe_checked, ppe_issues: x.ppe_issues ?? null, notes: x.notes ?? null,
        created_by: cur?.created_by ?? myId(), created_at: cur?.created_at ?? t, updated_at: t,
      };
      putPending('toolbox_talks', row as unknown as Row, op);
      break;
    }
    case 'request_permit': {
      const x = payload as RpcMapSite['request_permit'];
      const cur = get<WorkPermit>('work_permits', x.id);
      const row: WorkPermit = {
        id: x.id, project_id: x.project_id, number: cur?.number ?? x.number ?? PENDING_NO, permit_type: x.permit_type, description: x.description,
        location_text: x.location_text ?? null, element_id: x.element_id ?? null, valid_from: x.valid_from, valid_to: x.valid_to, crew_size: x.crew_size ?? null,
        supervisor_name: x.supervisor_name ?? null, precautions: x.precautions, status: 'requested', decision_comment: null,
        requested_by: cur?.requested_by ?? myId(), approved_by: null, approved_at: null, closed_by: null, closed_at: null, close_note: null,
        created_at: cur?.created_at ?? t, updated_at: t,
      };
      putPending('work_permits', row as unknown as Row, op);
      break;
    }
    case 'permit_action': {
      const x = payload as RpcMapSite['permit_action'];
      const status = ({ approve: 'approved', reject: 'rejected', close: 'closed', cancel: 'cancelled' } as const)[x.action];
      patch<WorkPermit>('work_permits', x.permit_id, {
        status, ...(x.precautions ? { precautions: x.precautions } : {}),
        ...(x.action === 'close' ? { closed_by: myId(), closed_at: t, close_note: x.comment ?? null } : {}),
        ...(x.action === 'approve' || x.action === 'reject' ? { approved_by: myId(), approved_at: t, decision_comment: x.comment ?? null } : {}),
      }, op);
      break;
    }
    case 'save_plant': {
      const x = payload as RpcMapSite['save_plant'];
      const cur = get<PlantItem>('plant_items', x.id);
      const row: PlantItem = {
        id: x.id, project_id: x.project_id, code: x.code, name: x.name, category: x.category ?? 'other', ownership: x.ownership ?? 'owned',
        supplier: x.supplier ?? null, plate_no: x.plate_no ?? null, meter_unit: x.meter_unit ?? 'hours', last_meter: x.last_meter ?? cur?.last_meter ?? null,
        status: x.status ?? 'active', on_site_from: x.on_site_from ?? null, notes: x.notes ?? null, created_by: cur?.created_by ?? myId(),
        created_at: cur?.created_at ?? t, updated_at: t,
      };
      putPending('plant_items', row as unknown as Row, op);
      break;
    }
    case 'log_plant': {
      const x = payload as RpcMapSite['log_plant'];
      const plant = get<PlantItem>('plant_items', x.plant_id);
      if (!plant) break;
      const cur = get<PlantLog>('plant_logs', x.id);
      const worked = x.hours_worked ?? (plant.meter_unit === 'hours' && x.meter_start != null && x.meter_end != null ? x.meter_end - x.meter_start : 0);
      const row: PlantLog = {
        id: x.id, project_id: plant.project_id, plant_id: x.plant_id, log_date: x.log_date, operator_name: x.operator_name ?? null,
        meter_start: x.meter_start ?? null, meter_end: x.meter_end ?? null, hours_worked: worked, hours_idle: x.hours_idle ?? 0,
        hours_breakdown: x.hours_breakdown ?? 0, fuel_litres: x.fuel_litres ?? 0, status: x.status ?? 'working', idle_reason: x.idle_reason ?? null,
        breakdown_note: x.breakdown_note ?? null, work_done: x.work_done ?? null, element_id: x.element_id ?? null,
        created_by: cur?.created_by ?? myId(), created_at: cur?.created_at ?? t, updated_at: t,
      };
      putPending('plant_logs', row as unknown as Row, op);
      const meter = x.meter_end ?? x.meter_start;
      patch<PlantItem>('plant_items', plant.id, {
        last_meter: meter != null ? Math.max(Number(plant.last_meter ?? 0), meter) : plant.last_meter,
        status: x.status === 'breakdown' ? 'under_repair' : plant.status === 'under_repair' && (x.status ?? 'working') === 'working' ? 'active' : plant.status,
      }, op);
      break;
    }
  }
}
