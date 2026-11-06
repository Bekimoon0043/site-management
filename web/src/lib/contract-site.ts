// Contract for site operations (migration 20261105000030_site_ops.sql): HSE incidents & near misses, toolbox talks,
// permits to work, plant & equipment register and daily plant log. Copy next to contract.ts in each app
// (npm run sync:contract). RFIs / site instructions: contract-administration register (20261105000040).
import type { AppRole, SyncTable } from './contract';

export interface Op { op_id?: string }

// ---------------------------------------------------------------------------
// HSE
// ---------------------------------------------------------------------------
export type IncidentKind = 'injury' | 'near_miss' | 'property_damage' | 'environmental' | 'dangerous_occurrence';
export type IncidentSeverity = 'minor' | 'moderate' | 'serious' | 'fatal';
export type IncidentStatus = 'reported' | 'action' | 'closed';
export type InjuredParty = 'own' | 'subcontractor' | 'visitor' | 'public';

export const INCIDENT_KIND_LABELS: Record<IncidentKind, string> = {
  injury: 'Injury', near_miss: 'Near miss', property_damage: 'Property damage', environmental: 'Environmental', dangerous_occurrence: 'Dangerous occurrence',
};
export const SEVERITY_LABELS: Record<IncidentSeverity, string> = { minor: 'Minor (first aid)', moderate: 'Moderate (medical treatment)', serious: 'Serious', fatal: 'Fatal' };
export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = { reported: 'To investigate', action: 'Corrective action', closed: 'Closed' };

export interface HseIncident {
  id: string; project_id: string; number: string; kind: IncidentKind; severity: IncidentSeverity; occurred_at: string;
  location_text: string | null; element_id: string | null; description: string; immediate_action: string | null;
  injured_name: string | null; injured_trade: string | null; injured_party: InjuredParty | null; body_part: string | null;
  first_aid: boolean; hospital: boolean; lost_time: boolean; days_lost: number;
  root_cause: string | null; corrective_action: string | null; action_owner: string | null; action_due: string | null;
  reported_to_authority: boolean; authority_ref: string | null; status: IncidentStatus; close_note: string | null;
  reported_by: string; investigated_by: string | null; investigated_at: string | null; closed_by: string | null; closed_at: string | null;
  created_at: string; updated_at: string;
}

export interface ToolboxTalk {
  id: string; project_id: string; number: string; held_on: string; topic: string; hazards: string | null; presenter_name: string | null;
  attendees_count: number; attendee_names: string | null; trades: string[]; duration_min: number | null; ppe_checked: boolean;
  ppe_issues: string | null; notes: string | null; created_by: string; created_at: string; updated_at: string;
}
/** Common toolbox-talk topics on building sites (quick picks). */
export const TOOLBOX_TOPICS = [
  'Working at height & scaffolds', 'Excavation & trench safety', 'Housekeeping & access', 'Manual handling', 'PPE use',
  'Concrete pouring & vibrators', 'Rebar handling & cutting', 'Formwork & propping', 'Electrical safety & temporary power',
  'Lifting & signalling', 'Hot work & fire', 'Heat, dust & hygiene', 'Khat, alcohol & fitness for work',
];

export type PermitType = 'hot_work' | 'work_at_height' | 'excavation' | 'confined_space' | 'lifting' | 'electrical' | 'other';
export type PermitStatus = 'requested' | 'approved' | 'rejected' | 'closed' | 'cancelled';
export interface Precaution { text: string; done: boolean }
export const PERMIT_TYPE_LABELS: Record<PermitType, string> = {
  hot_work: 'Hot work (welding, cutting)', work_at_height: 'Work at height', excavation: 'Excavation', confined_space: 'Confined space',
  lifting: 'Lifting operation', electrical: 'Electrical isolation', other: 'Other',
};
/** Default precaution checklist per permit type; the issuer ticks each one after checking it on site. */
export const PERMIT_PRECAUTIONS: Record<PermitType, string[]> = {
  hot_work: ['Fire extinguisher at the work place', 'Combustibles removed or covered within 10 m', 'Welding screen / shield in place',
    'Gas cylinders upright, chained, flashback arrestors fitted', 'Fire watch for 30 min after the work'],
  work_at_height: ['Scaffold inspected and tagged', 'Guard rails and toe boards in place', 'Full-body harness worn and anchored',
    'Area below barricaded', 'Ladders secured'],
  excavation: ['Underground services located', 'Sides shored / battered to a safe slope', 'Spoil and plant ≥ 1 m from the edge',
    'Safe access ladder every 15 m', 'Barriers around the excavation'],
  confined_space: ['Atmosphere tested (O₂, gas)', 'Ventilation in place', 'Standby person at the entry', 'Rescue equipment ready', 'Entry log kept'],
  lifting: ['Lifting plan prepared', 'Crane / hoist inspection certificate valid', 'Slings and shackles inspected', 'Exclusion zone set',
    'Trained signaller assigned'],
  electrical: ['Circuit isolated and locked off', 'Tested dead', 'Warning tags fixed', 'Earthing applied', 'Competent electrician on the job'],
  other: ['Risk assessment done', 'Workers briefed', 'PPE checked'],
};
export const PERMIT_STATUS_LABELS: Record<PermitStatus, string> = {
  requested: 'To approve', approved: 'Approved', rejected: 'Rejected', closed: 'Closed', cancelled: 'Cancelled',
};
export interface WorkPermit {
  id: string; project_id: string; number: string; permit_type: PermitType; description: string; location_text: string | null;
  element_id: string | null; valid_from: string; valid_to: string; crew_size: number | null; supervisor_name: string | null;
  precautions: Precaution[]; status: PermitStatus; decision_comment: string | null; requested_by: string; approved_by: string | null;
  approved_at: string | null; closed_by: string | null; closed_at: string | null; close_note: string | null; created_at: string; updated_at: string;
}
/** Approved and past its end time — the work must stop and the permit be closed. */
export const permitExpired = (w: Pick<WorkPermit, 'status' | 'valid_to'>, now = Date.now()) => w.status === 'approved' && new Date(w.valid_to).getTime() < now;
/** Approved and within its window. */
export const permitLive = (w: Pick<WorkPermit, 'status' | 'valid_from' | 'valid_to'>, now = Date.now()) =>
  w.status === 'approved' && new Date(w.valid_from).getTime() <= now && new Date(w.valid_to).getTime() >= now;

// ---------------------------------------------------------------------------
// Plant & equipment
// ---------------------------------------------------------------------------
export type PlantCategory = 'excavator' | 'loader' | 'crane' | 'mixer' | 'vibrator' | 'generator' | 'truck' | 'pump' | 'compactor' | 'other';
export type PlantStatus = 'active' | 'under_repair' | 'off_hire';
export type PlantLogStatus = 'working' | 'idle' | 'breakdown';
export const PLANT_CATEGORY_LABELS: Record<PlantCategory, string> = {
  excavator: 'Excavator', loader: 'Loader', crane: 'Crane / hoist', mixer: 'Concrete mixer', vibrator: 'Vibrator', generator: 'Generator',
  truck: 'Truck / tipper', pump: 'Pump', compactor: 'Compactor / roller', other: 'Other',
};
export const PLANT_STATUS_LABELS: Record<PlantStatus, string> = { active: 'Active', under_repair: 'Under repair', off_hire: 'Off hire / left site' };
export interface PlantItem {
  id: string; project_id: string; code: string; name: string; category: PlantCategory; ownership: 'owned' | 'hired'; supplier: string | null;
  plate_no: string | null; meter_unit: 'hours' | 'km' | 'none'; last_meter: number | null; status: PlantStatus; on_site_from: string | null;
  notes: string | null; created_by: string | null; created_at: string; updated_at: string;
}
export interface PlantLog {
  id: string; project_id: string; plant_id: string; log_date: string; operator_name: string | null; meter_start: number | null; meter_end: number | null;
  hours_worked: number; hours_idle: number; hours_breakdown: number; fuel_litres: number; status: PlantLogStatus; idle_reason: string | null;
  breakdown_note: string | null; work_done: string | null; element_id: string | null; created_by: string; created_at: string; updated_at: string;
}
/** public.plant_utilisation(project, from, to) */
export interface PlantUtilisation {
  plant_id: string; code: string; name: string; category: PlantCategory; ownership: 'owned' | 'hired'; status: PlantStatus; days_logged: number;
  hours_worked: number; hours_idle: number; hours_breakdown: number; fuel_litres: number; utilisation_pct: number | null; litres_per_hour: number | null;
}
export const IDLE_REASONS = ['No operator', 'No work front', 'Waiting for material', 'Rain', 'No fuel', 'Standby'];

// ---------------------------------------------------------------------------
// RPCs
// ---------------------------------------------------------------------------
export interface ReportIncidentPayload extends Op {
  id: string; project_id: string; number?: string; kind: IncidentKind; severity?: IncidentSeverity; occurred_at: string;
  location_text?: string; element_id?: string; description: string; immediate_action?: string; injured_name?: string; injured_trade?: string;
  injured_party?: InjuredParty; body_part?: string; first_aid?: boolean; hospital?: boolean; lost_time?: boolean; days_lost?: number;
}
export interface IncidentActionPayload extends Op {
  incident_id: string; action: 'investigate' | 'close' | 'update'; root_cause?: string; corrective_action?: string; action_owner?: string;
  action_due?: string; reported_to_authority?: boolean; authority_ref?: string; close_note?: string; days_lost?: number; lost_time?: boolean;
}
export interface SaveToolboxTalkPayload extends Op {
  id: string; project_id: string; number?: string; held_on: string; topic: string; hazards?: string; presenter_name?: string;
  attendees_count: number; attendee_names?: string; trades?: string[]; duration_min?: number; ppe_checked?: boolean; ppe_issues?: string; notes?: string;
}
export interface RequestPermitPayload extends Op {
  id: string; project_id: string; number?: string; permit_type: PermitType; description: string; location_text?: string; element_id?: string;
  valid_from: string; valid_to: string; crew_size?: number; supervisor_name?: string; precautions: Precaution[];
}
export interface PermitActionPayload extends Op {
  permit_id: string; action: 'approve' | 'reject' | 'close' | 'cancel'; precautions?: Precaution[]; comment?: string;
}
export interface SavePlantPayload extends Op {
  id: string; project_id: string; code: string; name: string; category?: PlantCategory; ownership?: 'owned' | 'hired'; supplier?: string;
  plate_no?: string; meter_unit?: 'hours' | 'km' | 'none'; last_meter?: number; status?: PlantStatus; on_site_from?: string; notes?: string;
}
export interface LogPlantPayload extends Op {
  id: string; plant_id: string; log_date: string; operator_name?: string; meter_start?: number; meter_end?: number; hours_worked?: number;
  hours_idle?: number; hours_breakdown?: number; fuel_litres?: number; status?: PlantLogStatus; idle_reason?: string; breakdown_note?: string;
  work_done?: string; element_id?: string;
}

export interface RpcMapSite {
  report_incident: ReportIncidentPayload;      // → { ok, id, number, status }
  incident_action: IncidentActionPayload;      // → { ok, id, number, status }
  save_toolbox_talk: SaveToolboxTalkPayload;   // → { ok, id, number }
  request_permit: RequestPermitPayload;        // → { ok, id, number, status }
  permit_action: PermitActionPayload;          // → { ok, id, number, status }
  save_plant: SavePlantPayload;                // → { ok, id }
  log_plant: LogPlantPayload;                  // → { ok, id, hours_worked }
}

/** Tables synced to the phone (no money). */
export const SYNC_TABLES_SITE: SyncTable[] = [
  { name: 'hse_incidents', pk: ['id'] },
  { name: 'toolbox_talks', pk: ['id'] },
  { name: 'work_permits', pk: ['id'] },
  { name: 'plant_items', pk: ['id'] },
  { name: 'plant_logs', pk: ['id'] },
];

// ---------------------------------------------------------------------------
// Permissions (the server re-checks each one)
// ---------------------------------------------------------------------------
export type SiteAction =
  | 'incident.report' | 'incident.investigate' | 'toolbox.record' | 'permit.request' | 'permit.approve' | 'permit.close'
  | 'plant.edit' | 'plant.log';
const SITE: AppRole[] = ['site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin'];
export const SITE_PERMS: Record<SiteAction, AppRole[]> = {
  'incident.report': ['store_keeper', 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'procurement', 'security', 'finance', 'admin'],
  'incident.investigate': ['coordinator', 'manager', 'admin'],
  'toolbox.record': SITE,
  'permit.request': SITE,
  'permit.approve': ['coordinator', 'manager', 'admin'],
  'permit.close': ['site_engineer', 'coordinator', 'manager', 'admin'],
  'plant.edit': SITE,
  'plant.log': ['site_engineer', 'store_keeper', 'office_engineer', 'coordinator', 'manager', 'admin'],
};
export const canSite = (role: AppRole | null | undefined, a: SiteAction) => !!role && SITE_PERMS[a].includes(role);
