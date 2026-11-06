import { formatEthiopian } from './contract-control';
import { getCalendar, getLocale, t } from './i18n';

export const fmtQty = (n: number | string | null | undefined, digits = 3) => {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
};

export const fmtMoney = (n: number | null | undefined, currency = 'ETB') =>
  n == null ? '—' : `${currency} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Shared date formatter: Ethiopian calendar when that is the user's preference (formatEthiopian). */
export const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
  if (Number.isNaN(d.getTime())) return s;
  if (getCalendar() === 'ethiopian') return formatEthiopian(s.length === 10 ? s : d, getLocale());
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

export const fmtDateTime = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${fmtDate(s)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const ago = (s: string | null | undefined) => {
  if (!s) return t('common.never');
  const mins = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (mins < 1) return t('common.justNow');
  if (mins < 60) return t('common.minAgo', { n: mins });
  const h = Math.round(mins / 60);
  if (h < 48) return t('common.hAgo', { n: h });
  return t('common.daysAgo', { n: Math.round(h / 24) });
};

export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const today = () => isoDate(new Date());
export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};

export const num = (s: string) => {
  const v = Number(s.replace(/,/g, '').trim());
  return Number.isFinite(v) ? v : NaN;
};

export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
