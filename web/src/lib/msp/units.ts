// Unit conversions for MSPDI / Excel schedules (docs/research/progress-evm.md §1.3). Pure functions, no DOM.
import type { ConstraintCode, ImportCalendar, LinkType } from './types';

/** ISO-8601 duration → minutes. MSP writes PTnHnMnS; also accepts PnDTnH… (D = 24 h, as MPXJ does). */
export function isoDurMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m) return null;
  const n = (i: number) => (m[i] === undefined ? 0 : Number(m[i]));
  const min = n(2) * 525600 + n(3) * 43200 + n(4) * 10080 + n(5) * 1440 + n(6) * 60 + n(7) + n(8) / 60;
  return m[1] ? -min : min;
}

/** DurationFormat / LagFormat codes that are elapsed (calendar) time. */
export const ELAPSED_FORMATS = new Set([4, 6, 8, 10, 12, 20, 36, 38, 40, 42, 44, 52]);
export const PERCENT_FORMATS = new Set([19, 20, 51, 52]);
export const isElapsed = (fmt: number | null | undefined) => fmt != null && ELAPSED_FORMATS.has(fmt);

/** Minutes → working days (calendar days when the format is elapsed). */
export const toDays = (minutes: number, fmt: number | null | undefined, minPerDay: number) =>
  isElapsed(fmt) ? minutes / 1440 : minutes / minPerDay;

/** LinkLag / TotalSlack / FreeSlack are integers in tenths of a minute. */
export const tenthsToDays = (v: number, fmt: number | null | undefined, minPerDay: number) => toDays(v / 10, fmt, minPerDay);

export const round2 = (v: number) => Math.round(v * 100) / 100;

/** 'YYYY-MM-DDThh:mm:ss' → 'YYYY-MM-DD'. Never `new Date(s)` (browser time zone would shift it). */
export const datePart = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
export const timePart = (s: string | null | undefined) => (s && s.length >= 16 ? s.slice(11, 16) : null);

export const MSP_LINK_TYPES: Record<number, LinkType> = { 0: 'FF', 1: 'FS', 2: 'SF', 3: 'SS' };
export const MSP_CONSTRAINTS: ConstraintCode[] = ['ASAP', 'ALAP', 'MSO', 'MFO', 'SNET', 'SNLT', 'FNET', 'FNLT'];
/** ConstraintType codes that fix dates regardless of logic (DCMA "hard constraints": MSO, MFO, SNLT, FNLT). */
export const HARD_CONSTRAINTS = new Set<number>([2, 3, 5, 7]);

// ---------------------------------------------------------------------------------------------------------------
// Naive date arithmetic (UTC-backed, so no DST / zone shifts)

const toUtc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromUtc = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fromUtc(toUtc(d) + n * 86400000);
/** ISO weekday 1 = Monday … 7 = Sunday. */
export const isoWeekday = (d: string) => ((new Date(toUtc(d)).getUTCDay() + 6) % 7) + 1;
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / 86400000);

export type WorkCalendar = Pick<ImportCalendar, 'working_weekdays' | 'exceptions'>;

export function isWorkingDay(d: string, cal: WorkCalendar): boolean {
  for (const e of cal.exceptions) if (d >= e.from && d <= e.to) return e.is_working;
  return cal.working_weekdays.includes(isoWeekday(d));
}

export function prevWorkingDay(d: string, cal: WorkCalendar): string {
  let x = addDays(d, -1);
  for (let i = 0; i < 366 && !isWorkingDay(x, cal); i++) x = addDays(x, -1);
  return x;
}

/** Inclusive count of working days from `start` to `finish`. */
export function workingDaysInclusive(start: string, finish: string, cal: WorkCalendar): number {
  if (finish < start) return 0;
  let n = 0;
  for (let d = start, i = 0; d <= finish && i < 20000; d = addDays(d, 1), i++) if (isWorkingDay(d, cal)) n++;
  return n;
}

/** Date `n` working days after `start` counting `start` as day 1 (so n = 1 → start when it is a working day). */
export function addWorkingDays(start: string, n: number, cal: WorkCalendar): string {
  let d = start;
  let left = Math.max(1, Math.ceil(n));
  for (let i = 0; i < 20000; i++) {
    if (isWorkingDay(d, cal) && --left === 0) return d;
    d = addDays(d, 1);
  }
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// "Unique ID Predecessors" syntax: `12FS+2d;15SS;18FF-1d;20SF+3ed`, separators `,` or `;`, default FS+0.

export interface PredToken {
  uid: number;
  type: LinkType;
  lag: number;
  unit: 'd' | 'w' | 'ed' | 'ew' | 'h' | 'eh' | 'mo' | '%';
}

const PRED_RE = /^(\d+)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(\d+(?:\.\d+)?)\s*(d|days?|w|wks?|weeks?|ed|edays?|ew|ewks?|h|hrs?|eh|mo|mons?|%)?)?$/i;

export function parsePredecessors(s: string | number | null | undefined): { links: PredToken[]; errors: string[] } {
  const links: PredToken[] = [];
  const errors: string[] = [];
  if (s == null || s === '') return { links, errors };
  for (const raw of String(s).split(/[;,]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = PRED_RE.exec(part);
    if (!m) { errors.push(`Cannot read predecessor "${part}"`); continue; }
    const u = (m[5] ?? 'd').toLowerCase();
    const unit: PredToken['unit'] = u === '%' ? '%' : u.startsWith('ed') ? 'ed' : u.startsWith('ew') ? 'ew' : u === 'eh' ? 'eh'
      : u.startsWith('h') ? 'h' : u.startsWith('w') ? 'w' : u.startsWith('mo') ? 'mo' : 'd';
    const lag = m[4] ? Number(m[4]) * (m[3] === '-' ? -1 : 1) : 0;
    links.push({ uid: Number(m[1]), type: (m[2]?.toUpperCase() as LinkType) ?? 'FS', lag, unit });
  }
  return { links, errors };
}

/** Lag token → working days for a calendar of `workdaysPerWeek` × `hoursPerDay`. `%` uses `predDurationDays`. */
export function lagTokenDays(t: Pick<PredToken, 'lag' | 'unit'>, workdaysPerWeek: number, hoursPerDay: number, predDurationDays = 0): number {
  const perCal = workdaysPerWeek / 7;
  switch (t.unit) {
    case 'd': return t.lag;
    case 'w': return t.lag * workdaysPerWeek;
    case 'mo': return t.lag * workdaysPerWeek * 4.33;
    case 'h': return t.lag / hoursPerDay;
    case 'ed': return t.lag * perCal;
    case 'ew': return t.lag * 7 * perCal;
    case 'eh': return (t.lag / 24) * perCal;
    case '%': return (t.lag / 100) * predDurationDays;
  }
}

const fmtNum = (v: number) => String(round2(v));

/** Links of one successor → "Unique ID Predecessors" text (`12`, `15SS+2d`, `18FF-1d`). */
export function formatPredecessors(links: { pred_uid: number; type: LinkType; lag_days: number }[]): string {
  return links.map((l) => {
    const lag = round2(l.lag_days);
    if (l.type === 'FS' && lag === 0) return String(l.pred_uid);
    return `${l.pred_uid}${l.type}${lag === 0 ? '' : `${lag > 0 ? '+' : '-'}${fmtNum(Math.abs(lag))}d`}`;
  }).join(',');
}

// ---------------------------------------------------------------------------------------------------------------
// BoQ code in a task name: "BOQ 3.2.1", "BoQ: 02.03", "[3.2.1]", "(BoQ 3.2)".

const BOQ_NAME_RES = [/\bBO?Q\s*(?:item|no\.?|#)?\s*[:#-]?\s*(\d+(?:\.\d+)+|\d+)\b/i, /\[\s*(\d+(?:\.\d+)+)\s*\]/];

export function boqCodeFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  for (const re of BOQ_NAME_RES) {
    const m = re.exec(name);
    if (m) return m[1];
  }
  return null;
}

/** Normalise a BoQ cell: trims, drops empty, keeps `02.03;02.04=45.5` lists as typed. */
export const cleanBoq = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};
