// Project calendar data layer (contract: lib/contract-calendar.ts, migration 20261105000010_project_calendar.sql).
import { check, supabase } from '../../lib/supabase';
import { invalidateAfterWrite } from '../../lib/query';
import { fromEthiopian, toEthiopian, ETHIOPIAN_MONTHS, isEthiopianLeapYear } from '../../lib/contract-control';
import type { HolidayDecision, ProjectCalendarView, RpcMapCalendar } from '../../lib/contract-calendar';
import { addDays, eatToday, isAm } from '../evm/data';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export async function calRpc<N extends keyof RpcMapCalendar>(name: N, payload: DistOmit<RpcMapCalendar[N], 'op_id'>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc(name, { p: { op_id: crypto.randomUUID(), ...payload } });
  if (error) throw new Error(error.message);
  invalidateAfterWrite();
  return (data ?? {}) as Record<string, unknown>;
}

export async function loadCalendar(projectId: string, from: string, to: string): Promise<ProjectCalendarView> {
  const { data, error } = await supabase.rpc('get_project_calendar', { p: { project_id: projectId, from, to } });
  if (error) throw new Error(error.message);
  return data as ProjectCalendarView;
}

/** One holiday decision with its holiday (for the Approvals preview). */
export async function loadDecision(id: string): Promise<HolidayDecision> {
  const r = check(await supabase.from('holiday_decisions').select('*, public_holidays(name, name_am, kind, is_tentative)').eq('id', id).single()) as
    Omit<HolidayDecision, 'name' | 'name_am' | 'kind' | 'is_tentative' | 'days_to_go'> & { public_holidays: Pick<HolidayDecision, 'name' | 'name_am' | 'kind' | 'is_tentative'> };
  const { public_holidays: h, ...d } = r;
  return { ...d, ...h, days_to_go: Math.round((Date.parse(d.on_date) - Date.parse(eatToday())) / 86400000) };
}

export type MonthMode = 'ethiopian' | 'gregorian';
export interface MonthSpan { key: string; from: string; to: string; title: string; sub: string }

const gregTitle = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The month containing `today` shifted by `offset` months, in the chosen calendar. */
export function monthSpan(today: string, offset: number, mode: MonthMode): MonthSpan {
  const lang = isAm() ? 'am' : 'en';
  if (mode === 'ethiopian') {
    const e = toEthiopian(today);
    const idx = e.year * 13 + (e.month - 1) + offset;
    const y = Math.floor(idx / 13); const m = (idx % 13) + 1;
    const from = fromEthiopian(y, m, 1);
    const len = m === 13 ? (isEthiopianLeapYear(y) ? 6 : 5) : 30;
    const to = addDays(from, len - 1);
    const g1 = gregTitle(from), g2 = gregTitle(to);
    return { key: `e${y}-${m}`, from, to, title: `${ETHIOPIAN_MONTHS[lang][m - 1]} ${y}`, sub: g1 === g2 ? g1 : `${g1.split(' ')[0]} – ${g2}` };
  }
  const [y0, m0] = today.split('-').map(Number);
  const t = new Date(Date.UTC(y0, m0 - 1 + offset, 1));
  const from = t.toISOString().slice(0, 10);
  const to = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const e1 = toEthiopian(from), e2 = toEthiopian(to);
  const em = (e: { month: number; year: number }) => `${ETHIOPIAN_MONTHS[lang][e.month - 1]} ${e.year}`;
  return { key: `g${from}`, from, to, title: gregTitle(from), sub: e1.month === e2.month ? em(e1) : `${ETHIOPIAN_MONTHS[lang][e1.month - 1]} – ${em(e2)}` };
}

export const ethLabel = (d: string) => {
  const e = toEthiopian(d);
  return `${ETHIOPIAN_MONTHS[isAm() ? 'am' : 'en'][e.month - 1]} ${e.day}, ${e.year}`;
};
export const holidayName = (h: { name: string; name_am: string | null }) => (isAm() && h.name_am ? h.name_am : h.name);
