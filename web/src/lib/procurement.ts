// Procurement data access + pure helpers shared by the procurement pages, the PO approval
// preview and the command palette. Prices are only fetched when `withPrices` (auth.canSeePrices);
// the database returns nothing for other roles anyway (RLS), this just avoids empty round-trips.
import type { Grn, Supplier } from './contract';
import type {
  BudgetLine, PoDeliveryUpdate, PoEvent, PoLine, PoLineInput, PoLinePrice, PoLineStatusRow, PoRevision, PoStatus, PoTotals,
  PurchaseOrder, Quotation, QuotationComparisonRow, QuotationLine, QuotationLinePrice, Rfq, RfqAward, RfqLine, RfqSupplier,
  RpcMapProcurement, RpcNameProcurement, SupplierProcurementFields, TaxSettings,
} from './contract-procurement';
import { invalidateAfterWrite } from './query';
import { useAsync } from './hooks';
import { check, supabase } from './supabase';
import { date, money, num } from './format';

type Payload<N extends RpcNameProcurement> = Omit<RpcMapProcurement[N], 'op_id'> & { op_id?: string };

/** Procurement RPC with a fresh op_id; invalidates cached lists on success (same as lib/supabase rpc). */
export async function procRpc<N extends RpcNameProcurement>(name: N, payload: Payload<N>): Promise<Record<string, unknown>> {
  const p = { op_id: crypto.randomUUID(), ...payload };
  const { data, error } = await supabase.rpc(name, { p });
  if (error) throw new Error(error.message);
  invalidateAfterWrite();
  return data as Record<string, unknown>;
}

export type SupplierRow = Supplier & Partial<SupplierProcurementFields>;

// ---------------------------------------------------------------------------
// Tax (mirrors app.po_recompute_totals)
// ---------------------------------------------------------------------------

export function useTaxSettings() {
  return useAsync(async () => check(await supabase.from('tax_settings').select('*').order('effective_from', { ascending: false })) as TaxSettings[],
    [], { key: 'tax-settings', staleTime: 10 * 60_000 });
}

/** Tax row effective on `on` (yyyy-mm-dd); list sorted newest first. */
export function taxFor(list: TaxSettings[] | undefined, on: string | null | undefined): TaxSettings | null {
  const d = (on || new Date().toISOString()).slice(0, 10);
  return (list ?? []).find((t) => t.effective_from <= d) ?? null;
}

const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export interface Totals { subtotal: number; vat_rate: number; vat: number; total: number; withholding_rate: number; withholding: number; net_payable: number; noTin: boolean }

/** Same arithmetic as the server: line totals rounded to cents, VAT on VAT-able lines, WHT on the subtotal at/above the threshold. */
export function computeTotals(lines: { qty: number; unit_price: number; vat_applicable: boolean }[], tax: TaxSettings | null, supplierTin: string | null | undefined): Totals {
  let sub = 0, vatable = 0;
  for (const l of lines) {
    const t = r2((Number(l.qty) || 0) * (Number(l.unit_price) || 0));
    sub += t;
    if (l.vat_applicable) vatable += t;
  }
  sub = r2(sub);
  const vatRate = Number(tax?.vat_rate ?? 0);
  const vat = r2((vatable * vatRate) / 100);
  const noTin = !(supplierTin ?? '').trim();
  const wRate = sub >= Number(tax?.wht_goods_threshold ?? 0) ? Number(noTin ? tax?.wht_no_tin_rate ?? 0 : tax?.wht_goods_rate ?? 0) : 0;
  const wht = r2((sub * wRate) / 100);
  return { subtotal: sub, vat_rate: vatRate, vat, total: r2(sub + vat), withholding_rate: wRate, withholding: wht, net_payable: r2(sub + vat - wht), noTin };
}

// ---------------------------------------------------------------------------
// RFQ detail
// ---------------------------------------------------------------------------

export async function loadRfqDetail(id: string, withPrices: boolean) {
  const rfq = check(await supabase.from('rfqs').select('*').eq('id', id).maybeSingle()) as Rfq | null;
  if (!rfq) throw new Error('RFQ not found or not in your projects');
  const [lines, suppliers, quotations, awards, comparison] = await Promise.all([
    supabase.from('rfq_lines').select('*').eq('rfq_id', id).is('deleted_at', null).order('line_no').then(check),
    supabase.from('rfq_suppliers').select('*').eq('rfq_id', id).is('deleted_at', null).then(check),
    supabase.from('quotations').select('*').eq('rfq_id', id).order('created_at').then(check),
    supabase.from('rfq_awards').select('*').eq('rfq_id', id).then(check),
    withPrices ? supabase.from('v_quotation_comparison').select('*').eq('rfq_id', id).then(check) : Promise.resolve([]),
  ]);
  const qIds = (quotations as Quotation[]).map((q) => q.id);
  const qLines = qIds.length ? check(await supabase.from('quotation_lines').select('*').in('quotation_id', qIds)) as QuotationLine[] : [];
  // Prices keyed by quotation line (price-restricted; second query once the line ids are known).
  const qlIds = qLines.map((l) => l.id);
  const prices = withPrices && qlIds.length
    ? check(await supabase.from('quotation_line_prices').select('*').in('quotation_line_id', qlIds)) as QuotationLinePrice[] : [];
  return {
    rfq, lines: lines as RfqLine[], suppliers: suppliers as RfqSupplier[], quotations: quotations as Quotation[],
    qLines, prices: new Map(prices.map((p) => [p.quotation_line_id, p])),
    awards: awards as RfqAward[], comparison: comparison as QuotationComparisonRow[],
  };
}
export type RfqDetail = Awaited<ReturnType<typeof loadRfqDetail>>;

// ---------------------------------------------------------------------------
// PO detail
// ---------------------------------------------------------------------------

export type GrnRow = Pick<Grn, 'id' | 'number' | 'received_at' | 'status' | 'delivery_note_no'> & { grn_lines: { po_line_id: string | null; qty_accepted: number; qty_rejected: number }[] };

export async function loadPoDetail(id: string, withPrices: boolean) {
  const po = check(await supabase.from('purchase_orders').select('*').eq('id', id).maybeSingle()) as PurchaseOrder | null;
  if (!po) throw new Error('Purchase order not found or not in your projects');
  const [lines, status, events, deliveries, grns, supplier] = await Promise.all([
    supabase.from('po_lines').select('*').eq('po_id', id).is('deleted_at', null).order('line_no').then(check),
    supabase.from('v_po_line_status').select('*').eq('po_id', id).order('line_no').then(check),
    supabase.from('po_events').select('*').eq('po_id', id).order('created_at', { ascending: false }).then(check),
    supabase.from('po_delivery_updates').select('*').eq('po_id', id).order('created_at', { ascending: false }).then(check),
    supabase.from('grns').select('id, number, received_at, status, delivery_note_no, grn_lines(po_line_id, qty_accepted, qty_rejected)').eq('po_id', id).order('received_at', { ascending: false }).then(check),
    supabase.from('suppliers').select('*').eq('id', po.supplier_id).maybeSingle().then(check),
  ]);
  const lineIds = (lines as PoLine[]).map((l) => l.id);
  const [prices, totals, revisions] = withPrices ? await Promise.all([
    lineIds.length ? supabase.from('po_line_prices').select('*').in('po_line_id', lineIds).then(check) : Promise.resolve([]),
    supabase.from('po_totals').select('*').eq('po_id', id).maybeSingle().then(check),
    supabase.from('po_revisions').select('*').eq('po_id', id).order('revision', { ascending: false }).then(check),
  ]) : [[], null, []];
  return {
    po, lines: lines as PoLine[], status: new Map((status as PoLineStatusRow[]).map((s) => [s.po_line_id, s])),
    events: events as PoEvent[], deliveries: deliveries as PoDeliveryUpdate[], grns: grns as unknown as GrnRow[],
    supplier: supplier as SupplierRow | null,
    prices: new Map((prices as PoLinePrice[]).map((p) => [p.po_line_id, p])), totals: totals as PoTotals | null,
    revisions: revisions as PoRevision[],
  };
}
export type PoDetail = Awaited<ReturnType<typeof loadPoDetail>>;

/** Editable PO line in the form (strings for inputs). */
export interface PoFormLine {
  id: string; material_spec_id: string; qty: string; unit_price: string; vat_applicable: boolean; expected_date: string;
  mr_line_id?: string | null; quotation_line_id?: string | null; uom?: string | null; remarks?: string | null;
  /** Already accepted against this line (amendments can't go below it). */
  accepted?: number; label?: string;
}

export const toLineInput = (l: PoFormLine): PoLineInput => ({
  id: l.id, material_spec_id: l.material_spec_id, qty: Number(l.qty), unit_price: Number(l.unit_price), vat_applicable: l.vat_applicable,
  uom: l.uom ?? undefined, mr_line_id: l.mr_line_id ?? undefined, quotation_line_id: l.quotation_line_id ?? undefined,
  expected_date: l.expected_date || undefined, remarks: l.remarks ?? undefined,
});

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/** Plain-text PO summary for Telegram / WhatsApp / clipboard. Prices only when the user may see them. */
export function poSummary(d: PoDetail, opts: { company: string; projectName: string; specLabel: (id: string) => string; specUom: (id: string) => string; storeName: string; currency: string; withPrices: boolean }) {
  const { po } = d;
  const out: string[] = [];
  out.push(`PURCHASE ORDER ${po.number}${po.revision ? ` (Rev ${po.revision})` : ''}`);
  out.push(`${opts.company} — ${opts.projectName}`);
  out.push(`Supplier: ${d.supplier?.name ?? ''}${d.supplier?.tin ? ` (TIN ${d.supplier.tin})` : ''}`);
  out.push(`Order date: ${date(po.order_date)}${po.expected_date ? ` · Deliver by: ${date(po.eta ?? po.expected_date)}` : ''}`);
  out.push(`Deliver to: ${opts.storeName}`);
  out.push('');
  d.lines.forEach((l, i) => {
    const p = d.prices.get(l.id);
    const uom = l.uom || opts.specUom(l.material_spec_id);
    const price = opts.withPrices && p ? ` @ ${money(p.unit_price, opts.currency)} = ${money(Number(l.qty) * Number(p.unit_price), opts.currency)}${p.vat_applicable ? '' : ' (no VAT)'}` : '';
    out.push(`${i + 1}. ${opts.specLabel(l.material_spec_id)} — ${num(l.qty, 3)} ${uom}${price}`);
  });
  if (opts.withPrices && d.totals) {
    const t = d.totals;
    out.push('');
    out.push(`Subtotal: ${money(t.subtotal, opts.currency)}`);
    out.push(`VAT ${num(t.vat_rate)}%: ${money(t.vat, opts.currency)}`);
    out.push(`Total: ${money(t.total, opts.currency)}`);
    if (Number(t.withholding) > 0) out.push(`Withholding ${num(t.withholding_rate)}%: −${money(t.withholding, opts.currency)}`);
    out.push(`Net payable: ${money(t.net_payable, opts.currency)}`);
  }
  if (po.payment_terms) out.push(`Payment terms: ${po.payment_terms}${po.advance_pct ? ` (advance ${num(po.advance_pct)}%)` : ''}`);
  if (po.delivery_terms) out.push(`Delivery terms: ${po.delivery_terms}`);
  if (po.remarks) out.push(`Remarks: ${po.remarks}`);
  return out.join('\n');
}

export const telegramShare = (text: string) => `https://t.me/share/url?url=${encodeURIComponent(' ')}&text=${encodeURIComponent(text)}`;
export const whatsappShare = (text: string, phone?: string | null) => {
  const digits = (phone ?? '').replace(/\D/g, '');
  return `https://wa.me/${digits.length >= 9 ? digits : ''}?text=${encodeURIComponent(text)}`;
};

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export const OPEN_PO: PoStatus[] = ['approved', 'sent', 'partially_received'];
export const PO_EDITABLE: PoStatus[] = ['draft', 'rejected'];
export const PO_AMENDABLE: PoStatus[] = ['approved', 'sent', 'partially_received'];

export async function loadBudgetLines(projectId: string) {
  return check(await supabase.from('budget_lines').select('*').eq('project_id', projectId).is('deleted_at', null).order('created_at')) as BudgetLine[];
}

/** Copies text, falling back to a hidden textarea where the async clipboard API is blocked. */
export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fallback */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  document.execCommand('copy');
  ta.remove();
}
