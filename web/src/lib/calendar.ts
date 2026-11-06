// Per-user date display preference (profiles.locale / profiles.calendar, set via set_my_locale).
// Dates are always stored Gregorian; lib/format's date/dateTime/shortDate consult this so every
// page (old and new) shows Ethiopian dates when the user picked that calendar.
// The converter (formatEthiopian from contract-control) is loaded only for Ethiopian-calendar users,
// keeping contract-control (QR crypto tables) out of the initial bundle.
import type { ProfileLocale } from './contract-control';

let pref: ProfileLocale = { locale: 'en', calendar: 'gregorian' };
let fmt: ((d: Date | string, lang: 'en' | 'am') => string) | null = null;

/** Called by auth after the profile loads (and again after set_my_locale → auth.reload()). Await it before rendering. */
export async function setCalendarPref(p: { locale?: string | null; calendar?: string | null } | null | undefined): Promise<void> {
  pref = {
    locale: p?.locale === 'am' ? 'am' : 'en',
    calendar: p?.calendar === 'ethiopian' ? 'ethiopian' : 'gregorian',
  };
  if (pref.calendar === 'ethiopian' && !fmt) {
    try { fmt = (await import('./contract-control')).formatEthiopian; } catch { /* stay Gregorian if the chunk fails */ }
  }
}

export const calendarPref = (): ProfileLocale => pref;

/**
 * Ethiopian label ("Tikimt 20, 2019") for a stored date or timestamp when the user prefers the
 * Ethiopian calendar; null otherwise (caller falls back to Gregorian formatting).
 */
export function ethiopianLabel(v: unknown, withTime = false): string | null {
  if (pref.calendar !== 'ethiopian' || !fmt || !v) return null;
  const s = v instanceof Date ? '' : String(v);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const d = dateOnly ? null : v instanceof Date ? v : new Date(s);
  if (d && Number.isNaN(d.getTime())) return null;
  const label = fmt(dateOnly ? s : d!, pref.locale);
  return withTime && d ? `${label} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : label;
}
