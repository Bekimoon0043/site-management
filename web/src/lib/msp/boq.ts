// "The schedule IS the BoQ": MS Project files whose leaf tasks are BoQ items, with Unit / Qty / Rate / Amount in custom
// fields (e.g. Text1 "Unit", Number1 "Qty", Number2 "Rate" ex-VAT, Cost1 "Amount" incl. 15 % VAT). The detector finds
// those columns; `embeddedBoqRows` previews what create_boq_from_schedule (migration 20261030000005) will create —
// the item number / description / unit rules here mirror app.norm_unit and the RPC.
import type { CustomFieldDef, ImportTask } from './types';

/** What BoQ detection needs: a parsed file, or the tasks of an imported schedule read back from the database. */
export type BoqTask = Pick<ImportTask, 'uid' | 'name' | 'wbs' | 'outline_number' | 'parent_uid' | 'is_summary' | 'custom'>;
export interface BoqSource { tasks: BoqTask[]; custom_fields: CustomFieldDef[] }

export type BoqColumn = 'unit' | 'qty' | 'rate' | 'amount';
export type BoqConfidence = 'high' | 'medium' | 'low' | 'none';

export interface EmbeddedBoqDetection {
  /** FieldName (e.g. `Text1`) of each column, null when not found. */
  unitField: string | null;
  qtyField: string | null;
  rateField: string | null;
  amountField: string | null;
  /** Leaf (non-summary) tasks with Qty > 0 — the BoQ items. */
  leafWithQty: number;
  /** Leaf tasks with Qty > 0 whose name starts with a sub-item marker ("a)", "(b)", "iv)"). */
  subItems: number;
  /** Median Amount ÷ (Qty × Rate) over leaves (1.15 = 15 % VAT included); null without amount/rate. */
  vatFactor: number | null;
  vatIncluded: boolean;
  /** (vatFactor − 1) × 100, rounded to 2 decimals; null when VAT is not included / unknown. */
  vatPct: number | null;
  /** Share (0..1) of leaves where Amount = Qty × Rate × vatFactor within 0.5 %. */
  consistency: number | null;
  /** Σ Qty × Rate over leaves (ex-VAT) and Σ Amount (as in the file). */
  totalExVat: number | null;
  totalAmount: number | null;
  confidence: BoqConfidence;
}

export interface EmbeddedBoqFields { unitField: string | null; qtyField: string | null; rateField: string | null; amountField: string | null }

const ALIASES: Record<BoqColumn, RegExp> = {
  unit: /^(unit|units|uom|u ?o ?m|unit of measure(ment)?|measure(ment)? unit|meas(ure)?|መለኪያ|መለኪያ አሃድ|አሃድ)$/,
  qty: /^(qty|qtys|quantity|quantities|boq qty|boq quantity|contract qty|contract quantity|መጠን|ብዛት)$/,
  rate: /^(rate|rates|unit rate|unit price|unit cost|price|rate ex vat|unit rate ex vat|ነጠላ ዋጋ|የአንዱ ዋጋ|ዋጋ)$/,
  amount: /^(amount|amounts|total|total amount|total price|total cost|amount incl vat|total incl vat|ጠቅላላ ዋጋ|ጠቅላላ|ድምር)$/,
};
/** Field kinds that make sense for each column (by FieldName prefix). */
const KINDS: Record<BoqColumn, RegExp> = {
  unit: /^text\d+$/i, qty: /^(number|cost)\d+$/i, rate: /^(number|cost)\d+$/i, amount: /^(cost|number)\d+$/i,
};

/** Lower-case, drop "(…)" / punctuation, collapse spaces: "Unit rate (ETB, ex. VAT)" → "unit rate ex vat". */
export const normAlias = (s: string) =>
  s.toLowerCase().replace(/\([^)]*?\b(ex|excl|incl)\b[^)]*\)/g, ' $1 vat ').replace(/\([^)]*\)/g, ' ')
    .replace(/\b(excl|excluding)\b/g, 'ex').replace(/\b(including)\b/g, 'incl').replace(/\bvat\s+vat\b/g, 'vat')
    .replace(/[._:/\\,-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Which BoQ column an alias names, if any. */
export function boqColumnOf(alias: string | null | undefined): BoqColumn | null {
  if (!alias) return null;
  const a = normAlias(alias);
  for (const c of ['unit', 'qty', 'rate', 'amount'] as BoqColumn[]) if (ALIASES[c].test(a)) return c;
  return null;
}

/** Numeric custom value ("1,234.50" → 1234.5); null when empty / not a number. */
export function customNumber(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).replace(/[\s,]/g, '').replace(/[^0-9.eE+-]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const SUP: Record<string, string> = { '²': '2', '³': '3', '¹': '1' };
const UNIT_MAP: Record<string, string> = {
  m2: 'm2', sqm: 'm2', sqmt: 'm2', msq: 'm2', 'sq m': 'm2', 'sq.m': 'm2', 'sq. m': 'm2',
  m3: 'm3', cum: 'm3', cumt: 'm3', 'cu m': 'm3', 'cu.m': 'm3', 'cu. m': 'm3',
  m: 'm', mt: 'm', mtr: 'm', meter: 'm', metre: 'm',
  ml: 'ml', lm: 'ml', rm: 'ml', 'l.m': 'ml', 'm.l': 'ml', 'lin m': 'ml', 'lin.m': 'ml', 'running m': 'ml',
  kg: 'kg', kgs: 'kg', kilogram: 'kg', ton: 'ton', tons: 'ton', tonne: 'ton', t: 'ton', qtl: 'qtl', quintal: 'qtl',
  no: 'No', 'no.': 'No', nos: 'No', 'nos.': 'No', nr: 'No', number: 'No', pcs: 'pcs', pc: 'pcs', each: 'No', ea: 'No',
  ls: 'LS', 'l.s': 'LS', 'l.s.': 'LS', 'lump sum': 'LS', lumpsum: 'LS', set: 'set', sets: 'set', pair: 'pair',
  l: 'l', lt: 'l', ltr: 'l', litre: 'l', liter: 'l', hr: 'hr', hrs: 'hr', day: 'day', days: 'day', month: 'month',
};
/**
 * Unit normaliser (same rules as app.norm_unit in the DB): case-insensitive, superscripts and "^" removed
 * ("m³" / "M^3" / "cu.m" → "m3", "Kg" → "kg", "no." / "Nos" → "No", "lump sum" → "LS"). Unknown units are trimmed as written.
 */
export function normalizeUnit(u: string | null | undefined): string | null {
  if (u == null) return null;
  const raw = String(u).trim();
  if (!raw) return null;
  const k = raw.replace(/[²³¹]/g, (c) => SUP[c]).replace(/\^/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return UNIT_MAP[k] ?? UNIT_MAP[k.replace(/[\s.]/g, '')] ?? raw.replace(/\s+/g, ' ');
}

/** "a) In Flat Mat slab", "(b) …", "iv) …" — a sub-item that only makes sense with its parent's name. */
export const SUB_ITEM_RE = /^\s*\(?(?:[a-z]{1,2}|[ivx]{1,5}|\d{1,2})\)\s*/i;
export const isSubItemName = (name: string) => SUB_ITEM_RE.test(name);

function pickField(fields: CustomFieldDef[], used: Map<string, number>, col: BoqColumn): string | null {
  const hits = fields.filter((f) => boqColumnOf(f.alias) === col);
  const ok = hits.filter((f) => KINDS[col].test(f.field_name));
  const pool = ok.length ? ok : hits;
  // Prefer the field most often filled on tasks.
  pool.sort((a, b) => (used.get(b.field_name) ?? 0) - (used.get(a.field_name) ?? 0));
  return pool[0]?.field_name ?? null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Finds Unit / Qty / Rate / Amount custom fields (by alias, English + common variants + Amharic) and measures VAT. */
export function detectEmbeddedBoq(s: BoqSource, override?: Partial<EmbeddedBoqFields>): EmbeddedBoqDetection {
  const used = new Map<string, number>();
  for (const t of s.tasks) for (const [k, v] of Object.entries(t.custom ?? {})) if (v != null && v !== '') used.set(k, (used.get(k) ?? 0) + 1);
  const pick = (col: BoqColumn, key: keyof EmbeddedBoqFields) =>
    override && key in override ? override[key] ?? null : pickField(s.custom_fields, used, col);
  const f: EmbeddedBoqFields = {
    unitField: pick('unit', 'unitField'), qtyField: pick('qty', 'qtyField'),
    rateField: pick('rate', 'rateField'), amountField: pick('amount', 'amountField'),
  };
  const leaves = s.tasks.filter((t) => !t.is_summary);
  const rows = f.qtyField ? leaves.map((t) => ({ t, ...leafValues(t, f) })).filter((x) => (x.qty ?? 0) > 0) : [];
  const ratios: number[] = [];
  let exVat = 0, amt = 0, haveEx = false, haveAmt = false;
  for (const x of rows) {
    if (x.rate != null && x.rate > 0) { exVat += x.qty! * x.rate; haveEx = true; }
    if (x.amount != null) { amt += x.amount; haveAmt = true; }
    if (x.rate != null && x.rate > 0 && x.amount != null && x.amount > 0) ratios.push(x.amount / (x.qty! * x.rate));
  }
  const med = median(ratios);
  const vatFactor = med == null ? null : Math.round(med * 10000) / 10000;
  const vatIncluded = vatFactor != null && vatFactor > 1.01 && vatFactor < 1.35;
  const consistency = vatFactor == null ? null : ratios.filter((r) => Math.abs(r / vatFactor - 1) <= 0.005).length / ratios.length;
  const found = [f.unitField, f.qtyField, f.rateField, f.amountField].filter(Boolean).length;
  let confidence: BoqConfidence = 'none';
  if (f.qtyField && rows.length) {
    if (f.unitField && (f.rateField || f.amountField) && rows.length >= 3 && (consistency == null || consistency >= 0.8)) confidence = 'high';
    else if (found >= 2) confidence = 'medium';
    else confidence = 'low';
  }
  return {
    ...f, leafWithQty: rows.length, subItems: rows.filter((x) => isSubItemName(x.t.name)).length,
    vatFactor, vatIncluded, vatPct: vatIncluded && vatFactor != null ? r2((vatFactor - 1) * 100) : null,
    consistency: consistency == null ? null : Math.round(consistency * 1000) / 1000,
    totalExVat: haveEx ? r2(exVat) : null, totalAmount: haveAmt ? r2(amt) : null, confidence,
  };
}

function leafValues(t: BoqTask, f: EmbeddedBoqFields) {
  const c = t.custom ?? {};
  return {
    unit: f.unitField ? normalizeUnit(c[f.unitField]) : null,
    qty: f.qtyField ? customNumber(c[f.qtyField]) : null,
    rate: f.rateField ? customNumber(c[f.rateField]) : null,
    amount: f.amountField ? customNumber(c[f.amountField]) : null,
  };
}

export type BoqDescriptionMode = 'auto' | 'name' | 'parent_and_name';
export type BoqItemNoFrom = 'wbs' | 'outline_number';
export interface EmbeddedBoqRow {
  uid: number; item_no: string; description: string; unit: string | null; qty: number; rate_ex_vat: number | null;
  amount_ex_vat: number | null; amount_incl_vat: number | null; sub_item: boolean;
}

/** Preview of the BoQ items create_boq_from_schedule will create (same rules as the RPC). */
export function embeddedBoqRows(s: Pick<BoqSource, 'tasks'>, f: EmbeddedBoqFields, o: {
  itemNoFrom?: BoqItemNoFrom; descriptionMode?: BoqDescriptionMode; vatIncluded?: boolean; vatPct?: number;
} = {}): EmbeddedBoqRow[] {
  const byUid = new Map(s.tasks.map((t) => [t.uid, t]));
  const vat = 1 + (o.vatPct ?? 15) / 100;
  const seen = new Set<string>();
  const out: EmbeddedBoqRow[] = [];
  for (const t of s.tasks) {
    if (t.is_summary) continue;
    const v = leafValues(t, f);
    if (!v.qty || v.qty <= 0) continue;
    let no = ((o.itemNoFrom === 'outline_number' ? t.outline_number ?? t.wbs : t.wbs ?? t.outline_number) ?? `T${t.uid}`).trim();
    if (seen.has(no.toLowerCase())) no = `${no}/${t.uid}`;
    seen.add(no.toLowerCase());
    const sub = isSubItemName(t.name);
    const parent = t.parent_uid != null ? byUid.get(t.parent_uid) : undefined;
    const mode = o.descriptionMode ?? 'auto';
    const withParent = parent && (mode === 'parent_and_name' || (mode === 'auto' && sub));
    let rate = v.rate;
    if ((rate == null || rate <= 0) && v.amount != null) rate = v.amount / v.qty / (o.vatIncluded ? vat : 1);
    const ex = rate != null ? r2(v.qty * rate) : null;
    out.push({
      uid: t.uid, item_no: no, description: withParent ? `${parent!.name.trim()} – ${t.name.trim()}` : t.name.trim(),
      unit: v.unit, qty: v.qty, rate_ex_vat: rate == null ? null : r2(rate), amount_ex_vat: ex,
      // same rule as create_boq_from_schedule: the file's Amount when it already includes VAT
      amount_incl_vat: o.vatIncluded && v.amount != null ? r2(v.amount) : ex == null ? null : r2(ex * vat), sub_item: sub,
    });
  }
  return out;
}
