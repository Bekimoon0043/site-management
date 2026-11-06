// Contract for the project calendar (migration 20261105000010_project_calendar.sql): Ethiopian public holidays,
// work / no-work decision per project and holiday, and calendar day edits. Copy next to contract.ts in each app
// (npm run sync:contract).
//
// Holiday decision: pending → (proposed by site engineer / office engineer / coordinator) → decided by the project
// manager (work | half_day | no_work); reopen goes back. Undecided = no work (calendar default). Pending holidays within
// 30 days are in the Approvals inbox (kind 'holiday', entity_type 'holiday_decision').

export interface Op { op_id?: string }

export type HolidayChoice = 'work' | 'half_day' | 'no_work';
export type HolidayDecisionStatus = 'pending' | 'proposed' | 'decided';
export type HolidayKind = 'national' | 'religious_orthodox' | 'religious_muslim' | 'other';
export type DayKind = 'normal' | 'non_working' | 'working' | 'half_day';
export type DayCategory = 'rain' | 'shutdown' | 'overtime' | 'half_day' | 'holiday_work' | 'holiday_off' | 'other';

export const HOLIDAY_CHOICE_LABELS: Record<HolidayChoice, string> = { work: 'Work (full day)', half_day: 'Half day', no_work: 'No work' };
export const DAY_CATEGORY_LABELS: Record<DayCategory, string> = {
  rain: 'Rain day', shutdown: 'Site shutdown', overtime: 'Overtime working day', half_day: 'Half day',
  holiday_work: 'Working on a holiday', holiday_off: 'Holiday — no work', other: 'Other',
};

export interface CalendarSettings {
  id: string; name: string; working_weekdays: number[]; saturday_factor: number; hours_per_day: number;
  use_public_holidays: boolean; holiday_country: string; source: 'manual' | 'msp_import';
}
export interface CalendarHoliday { id: string; name: string; name_am: string | null; kind: HolidayKind; is_tentative: boolean }
export interface CalendarException {
  id: string; is_working: boolean; factor: number | null; name: string | null; category: DayCategory | null; note: string | null;
  source: 'project' | 'msp_import'; holiday_decision_id: string | null;
}
/** One day of get_project_calendar. isodow 1 = Monday … 7 = Sunday; eth_* = Ethiopian date. */
export interface CalendarDay {
  date: string; isodow: number; eth_y: number; eth_m: number; eth_d: number; working: boolean; capacity: number;
  holiday: CalendarHoliday | null; exception: CalendarException | null; decision_id: string | null;
}
export interface HolidayDecision {
  id: string; holiday_id: string; on_date: string; status: HolidayDecisionStatus; name: string; name_am: string | null; kind: HolidayKind;
  is_tentative: boolean; proposed_choice: HolidayChoice | null; proposed_note: string | null; proposed_by: string | null; proposed_at: string | null;
  decision: HolidayChoice | null; decision_note: string | null; decided_by: string | null; decided_at: string | null; days_to_go: number;
}
export interface ProjectCalendarView { calendar: CalendarSettings | null; today: string; days: CalendarDay[]; decisions: HolidayDecision[] }

export interface CalendarSyncPayload { project_id: string }
export interface GetProjectCalendarPayload { project_id: string; from: string; to: string }
export interface ProposeHolidayPayload extends Op { decision_id: string; choice: HolidayChoice; note?: string }
export type DecideHolidayPayload = Op & { decision_id: string; note?: string } & ({ choice: HolidayChoice } | { action: 'reopen' });
export interface EditCalendarDaysPayload extends Op {
  project_id: string; dates: string[]; kind: DayKind; category?: 'rain' | 'shutdown' | 'overtime' | 'half_day' | 'other'; name?: string; note?: string;
}
export interface SaveProjectCalendarPayload extends Op {
  project_id: string; working_weekdays?: number[]; saturday_factor?: number; hours_per_day?: number; use_public_holidays?: boolean; name?: string;
}
export interface SavePublicHolidayPayload extends Op {
  id?: string; on_date?: string; name?: string; name_am?: string; kind?: HolidayKind; is_tentative?: boolean; delete?: boolean;
}

export interface RpcMapCalendar {
  calendar_sync: CalendarSyncPayload;                 // → { ok, notified }
  get_project_calendar: GetProjectCalendarPayload;   // → ProjectCalendarView
  propose_holiday_decision: ProposeHolidayPayload;   // → { ok, id, status }
  decide_holiday: DecideHolidayPayload;              // → { ok, id, status, moved }
  edit_calendar_days: EditCalendarDaysPayload;       // → { ok, days, moved }
  save_project_calendar: SaveProjectCalendarPayload; // → { ok, moved }
  save_public_holiday: SavePublicHolidayPayload;     // → { ok, id, on_date | deleted }
  generate_public_holidays: { from_year: number; to_year: number }; // → { ok, added }
}

/** Who may do what (the server re-checks). Reasoning in the migration header. */
export const CALENDAR_ROLES = {
  propose: ['site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin'],
  decide: ['manager', 'admin'],
  editDays: ['office_engineer', 'coordinator', 'manager', 'admin'],
  week: ['coordinator', 'manager', 'admin'],
  holidays: ['admin'],
} as const;
export const canCalendar = (role: string | null | undefined, action: keyof typeof CALENDAR_ROLES) =>
  !!role && (CALENDAR_ROLES[action] as readonly string[]).includes(role);
