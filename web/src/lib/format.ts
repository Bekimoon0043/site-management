import { ethiopianLabel } from './calendar';

// SheetJS is loaded on demand so it stays out of the main bundle.
const xlsx = () => import('xlsx');

export const num = (v: unknown, digits = 2): string => {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
};

export const money = (v: unknown, currency = 'ETB'): string => {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return `${currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const date = (v: unknown): string => {
  if (!v) return '';
  const eth = ethiopianLabel(v); if (eth) return eth; // user prefers the Ethiopian calendar
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const dateTime = (v: unknown): string => {
  if (!v) return '';
  const eth = ethiopianLabel(v, true); if (eth) return eth;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const today = () => new Date().toISOString().slice(0, 10);

export const humanize = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');

/** Writes rows (array of plain objects) to an .xlsx download (FR-RP-02). */
export async function exportExcel(filename: string, rows: Record<string, unknown>[], sheet = 'Report') {
  const XLSX = await xlsx();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 31));
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

/** CSV is decoded as UTF-8 (else Windows-1252, as older Excel saves it): SheetJS would read UTF-8 "Ø" / Amharic as Windows-1252. */
async function readBook(XLSX: Awaited<ReturnType<typeof xlsx>>, file: File) {
  const buf = await file.arrayBuffer();
  if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') return XLSX.read(buf, { cellDates: true });
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
  return XLSX.read(text.replace(/^\uFEFF/, ''), { type: 'string', cellDates: true });
}

/** Reads the first sheet of an Excel/CSV file into objects keyed by header. */
export async function readSheet(file: File): Promise<Record<string, unknown>[]> {
  const XLSX = await xlsx();
  const wb = await readBook(XLSX, file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: true });
}

export async function downloadTemplate(filename: string, headers: string[], example?: unknown[]) {
  const XLSX = await xlsx();
  const ws = XLSX.utils.aoa_to_sheet(example ? [headers, example] : [headers]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  XLSX.writeFile(wb, filename);
}

/** Normalises a spreadsheet cell to an ISO date (yyyy-mm-dd) or null. */
export function cellDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (typeof v === 'number') {
    // Excel serial date (days since 1899-12-30)
    const d = new Date(Math.round((v - 25569) * 86400000));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export const cellStr = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
export const cellNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Case/space-insensitive header lookup for imported rows. */
export function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  const keys = Object.keys(row);
  for (const n of names) {
    const want = n.toLowerCase().replace(/[^a-z0-9]/g, '');
    const k = keys.find((key) => key.toLowerCase().replace(/[^a-z0-9]/g, '') === want);
    if (k !== undefined) return row[k];
  }
  return undefined;
}

/** "3 h", "2 d", "5 min" — compact relative age for queues and notifications. */
export function ago(v: unknown): string {
  if (!v) return '';
  const t = typeof v === 'number' || v instanceof Date ? new Date(v).getTime() : new Date(String(v)).getTime();
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** "just now" / "5 min ago" / "3 d ago" (ago() + suffix, without "now ago"). */
export function since(v: unknown): string {
  const a = ago(v);
  return !a ? '' : a === 'now' ? 'just now' : `${a} ago`;
}

/** Hours since a timestamp. */
export const hoursSince = (v: unknown) => (v ? (Date.now() - new Date(String(v)).getTime()) / 3600000 : 0);

/** "in 3 d" / "2 d late" / "today" relative to a yyyy-mm-dd due date. */
export function dueIn(d: string | null | undefined): { text: string; late: boolean } {
  if (!d) return { text: '', late: false };
  const days = Math.round((new Date(d.slice(0, 10)).getTime() - new Date(today()).getTime()) / 86400000);
  if (days === 0) return { text: 'today', late: false };
  return days > 0 ? { text: `in ${days} d`, late: false } : { text: `${-days} d late`, late: true };
}

/** Short date: "29 Oct" this year, "29 Oct 2025" otherwise. */
export function shortDate(v: unknown): string {
  if (!v) return '';
  const eth = ethiopianLabel(v); if (eth) return eth;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', sameYear ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Decimals driven by unit of measure, not by the column (spec §2.2). */
export function uomDigits(uom: string | null | undefined): number {
  const u = (uom ?? '').toLowerCase();
  if (/^(pcs?|nos?|no\.|bags?|each|ea|bar|bundles?|trucks?)/.test(u)) return 0;
  if (/^(t|ton|tons|tonne)/.test(u)) return 3;
  return 2;
}
export const qty = (v: unknown, uom?: string | null) => num(v, uomDigits(uom));

/** Workbook reader for the import wizard: sheet names + rows of a sheet from a given header row (1-based). */
export async function readWorkbook(file: File): Promise<{ sheets: string[]; rows: (sheet: string, headerRow: number) => Record<string, unknown>[] }> {
  const XLSX = await xlsx();
  const wb = await readBook(XLSX, file);
  return {
    sheets: wb.SheetNames,
    rows: (sheet, headerRow) => XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheet], { defval: '', raw: true, range: Math.max(0, headerRow - 1) }),
  };
}

/** Normalises a header for matching ("Element ID" → "elementid"). */
export const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
