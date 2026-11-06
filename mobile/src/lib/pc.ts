// Read helpers for procurement (POs, expected deliveries, reorder) and site control
// (gate passes, vehicles, alerts). Everything reads the local store and works offline;
// reorder suggestions come from v_reorder_suggestions when online (cached) with a local fallback.
import { can, type AppRole, type MaterialSpec, type Store, type Supplier } from './contract';
import type { PoLine, PoStatus, PoTotals, PurchaseOrder, ReorderSuggestionRow, Rfq } from './contract-procurement';
import type { Alert, GatePass, GatePassLine, VehicleMovement } from './contract-control';
import { get, kvGet, kvSet, list } from './db';
import { jf, rowsWhere, stockBalancesSql } from './counts';
import { specMap } from './queries';
import { supabase } from './supabase';
import { today } from './format';

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/** app_settings.price_roles is authoritative (admin always); falls back to the default role list. */
export function canSeePrices(role: AppRole | null | undefined): boolean {
  if (!role) return false;
  if (role === 'admin') return true;
  try {
    const s = get<{ price_roles?: string[] | null }>('app_settings', '1');
    if (s && Array.isArray(s.price_roles)) return s.price_roles.includes(role);
  } catch { /* db not open */ }
  return can(role, 'prices.view');
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export const PO_OPEN: PoStatus[] = ['approved', 'sent', 'partially_received'];
const inList = (xs: string[]) => xs.map((x) => `'${x}'`).join(',');

export const supplierName = (id: string | null | undefined) => (id ? get<Supplier>('suppliers', id)?.name ?? 'Supplier' : '—');
export const storeName = (id: string | null | undefined) => (id ? get<Store>('stores', id)?.name ?? 'Store' : '—');

export const poLines = (poId: string) =>
  list<PoLine>('po_lines', { parent: poId }).filter((l) => !l.deleted_at).sort((a, b) => a.line_no - b.line_no);

export function outstandingQty(po: Pick<PurchaseOrder, 'status'>, l: PoLine): number {
  if (l.closed || !PO_OPEN.includes(po.status)) return 0;
  return Math.max(Number(l.qty) - Number(l.qty_accepted ?? 0), 0);
}

export const poExpected = (po: PurchaseOrder) => po.eta ?? po.expected_date ?? null;
export function poDelayed(po: PurchaseOrder, d = today()): boolean {
  if (!PO_OPEN.includes(po.status)) return false;
  const e = poExpected(po);
  return po.delivery_status === 'delayed' || (!!e && e.slice(0, 10) < d);
}

export interface ExpectedPo {
  id: string; number: string; supplier: string; storeId: string; expected: string | null; delayed: boolean;
  lines: number; outstandingLines: number; summary: string; status: PoStatus; deliveryStatus: string;
}

/** Open POs with outstanding quantity (v_expected_deliveries, offline). Delayed first, then by date. */
export function expectedDeliveries(projectId: string, version: number, storeId?: string | null): ExpectedPo[] {
  const sm = specMap(version);
  const d = today();
  const pos = rowsWhere<PurchaseOrder>('purchase_orders', projectId, `AND ${jf('status')} IN (${inList(PO_OPEN)})`);
  const out: ExpectedPo[] = [];
  for (const po of pos) {
    if (storeId && po.delivery_store_id !== storeId) continue;
    const ls = poLines(po.id);
    const open = ls.filter((l) => outstandingQty(po, l) > 0.0005);
    if (!open.length) continue;
    out.push({
      id: po.id, number: po.number, supplier: supplierName(po.supplier_id), storeId: po.delivery_store_id,
      expected: poExpected(po), delayed: poDelayed(po, d), lines: ls.length, outstandingLines: open.length,
      summary: open.slice(0, 3).map((l) => sm.get(l.material_spec_id)?.label ?? 'Material').join(', ') + (open.length > 3 ? ` +${open.length - 3}` : ''),
      status: po.status, deliveryStatus: po.delivery_status,
    });
  }
  return out.sort((a, b) => Number(b.delayed) - Number(a.delayed) || (a.expected ?? '9999').localeCompare(b.expected ?? '9999'));
}

export const purchaseOrders = (projectId: string, statuses?: PoStatus[]) =>
  rowsWhere<PurchaseOrder>('purchase_orders', projectId, statuses ? `AND ${jf('status')} IN (${inList(statuses)})` : '', [], `${jf('created_at')} DESC`);

export const rfqs = (projectId: string) => rowsWhere<Rfq>('rfqs', projectId, '', [], `${jf('created_at')} DESC`);

export const poTotals = (poId: string) => get<PoTotals>('po_totals', poId);

/** Received % of a PO by accepted quantity. */
export function receivedPct(poId: string): number {
  let q = 0, a = 0;
  for (const l of poLines(poId)) { q += Number(l.qty); a += Math.min(Number(l.qty_accepted ?? 0), Number(l.qty)); }
  return q > 0 ? Math.round((a / q) * 1000) / 10 : 0;
}

// ---------------------------------------------------------------------------
// Reorder suggestions
// ---------------------------------------------------------------------------

export interface ReorderCache { at: string | null; rows: ReorderSuggestionRow[]; source: 'server' | 'local' }

/** Local estimate when offline: available ≤ reorder level, minus open PO quantity, rounded up to pack size. */
function localReorder(projectId: string, version: number): ReorderSuggestionRow[] {
  const sm = specMap(version);
  const onOrder = new Map<string, number>();
  for (const po of rowsWhere<PurchaseOrder>('purchase_orders', projectId, `AND ${jf('status')} IN (${inList(PO_OPEN)})`)) {
    for (const l of poLines(po.id)) {
      const k = `${po.delivery_store_id}|${l.material_spec_id}`;
      onOrder.set(k, (onOrder.get(k) ?? 0) + outstandingQty(po, l));
    }
  }
  const out: ReorderSuggestionRow[] = [];
  for (const b of stockBalancesSql(projectId)) {
    const s = sm.get(b.material_spec_id) as (MaterialSpec & { label: string; category: string; pack_size?: number; safety_days?: number }) | undefined;
    if (!s || !(Number(s.reorder_level) > 0)) continue;
    const open = onOrder.get(`${b.store_id}|${b.material_spec_id}`) ?? 0;
    const short = Number(s.reorder_level) - b.available - open;
    if (short <= 0.0005) continue;
    const pack = Number(s.pack_size ?? 1) || 1;
    out.push({
      project_id: projectId, store_id: b.store_id, store_name: storeName(b.store_id), material_spec_id: b.material_spec_id,
      label: s.label, category: s.category, uom: s.uom, available: b.available, reorder_level: Number(s.reorder_level),
      min_level: Number(s.min_level), lead_time_days: Number(s.lead_time_days), safety_days: Number(s.safety_days ?? 0), pack_size: pack,
      avg_daily_issue_30d: 0, days_cover: null, stockout_date: null, pending_mr_qty: 0, open_po_qty: open, next_eta: null,
      suggested_qty: Math.ceil(short / pack) * pack, stockout_before_lead_time: b.available <= Number(s.min_level),
    });
  }
  return out;
}

export function cachedReorder(projectId: string, version: number): ReorderCache {
  try {
    const raw = kvGet(`cache:reorder:${projectId}`);
    if (raw) return { ...(JSON.parse(raw) as { at: string; rows: ReorderSuggestionRow[] }), source: 'server' };
  } catch { /* ignore */ }
  return { at: null, rows: localReorder(projectId, version), source: 'local' };
}

/** Fetch v_reorder_suggestions (online) and cache it. Returns false when offline / unavailable. */
export async function refreshReorder(projectId: string): Promise<boolean> {
  const { data, error } = await supabase.from('v_reorder_suggestions').select('*').eq('project_id', projectId);
  if (error || !data) return false;
  kvSet(`cache:reorder:${projectId}`, JSON.stringify({ at: new Date().toISOString(), rows: data }));
  return true;
}

// ---------------------------------------------------------------------------
// Gate passes, vehicles, alerts
// ---------------------------------------------------------------------------

export type GateFilter = 'pending_exit' | 'on_loan' | 'overdue' | 'to_approve' | 'mine' | 'all';

export const gatePassLines = (id: string) =>
  list<GatePassLine>('gate_pass_lines', { parent: id }).filter((l) => !l.deleted_at).sort((a, b) => a.line_no - b.line_no);

export const isOnLoan = (g: GatePass) => g.pass_type === 'returnable' && (g.status === 'exited' || g.status === 'partially_returned');
export const isOverdue = (g: GatePass, d = today()) => isOnLoan(g) && !!g.expected_return && g.expected_return.slice(0, 10) < d;

export function gatePasses(projectId: string, filter: GateFilter, userId?: string): (GatePass & { _pending?: string })[] {
  const all = rowsWhere<GatePass>('gate_passes', projectId, '', [], `${jf('created_at')} DESC`);
  const d = today();
  switch (filter) {
    case 'pending_exit': return all.filter((g) => g.status === 'approved');
    case 'on_loan': return all.filter((g) => isOnLoan(g));
    case 'overdue': return all.filter((g) => isOverdue(g, d));
    case 'to_approve': return all.filter((g) => g.status === 'pending');
    case 'mine': return all.filter((g) => g.requested_by === userId);
    default: return all;
  }
}

export function gateCounts(projectId: string) {
  const all = rowsWhere<GatePass>('gate_passes', projectId);
  const d = today();
  return {
    pendingExit: all.filter((g) => g.status === 'approved').length,
    onLoan: all.filter((g) => isOnLoan(g)).length,
    overdue: all.filter((g) => isOverdue(g, d)).length,
    toApprove: all.filter((g) => g.status === 'pending').length,
  };
}

export const vehicleLog = (projectId: string, limit = 50) =>
  rowsWhere<VehicleMovement>('vehicle_movements', projectId, '', [], `${jf('at')} DESC`, limit);

export const alerts = (projectId: string, open: boolean) =>
  rowsWhere<Alert>('alerts', projectId, open ? `AND ${jf('status')} != 'closed'` : '', [],
    `CASE ${jf('severity')} WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, ${jf('created_at')} DESC`);

export const criticalOpenAlerts = (projectId: string) =>
  rowsWhere<Alert>('alerts', projectId, `AND ${jf('status')} = 'open' AND ${jf('severity')} = 'critical'`, [], `${jf('created_at')} DESC`);

/** Normalised plate for comparisons (same as app.norm_plate: letters and digits only, upper case). */
export const normPlate = (p: string | null | undefined) => (p ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** Dashboard / badge counts for procurement + control (one pass over small tables). */
export function pcCounts(projectId: string, version: number) {
  const g = gateCounts(projectId);
  const exp = expectedDeliveries(projectId, version);
  return {
    posToApprove: rowsWhere<PurchaseOrder>('purchase_orders', projectId, `AND ${jf('status')} = 'submitted'`).length,
    gateToApprove: g.toApprove, pendingExit: g.pendingExit, onLoan: g.onLoan, overdue: g.overdue,
    criticalAlerts: criticalOpenAlerts(projectId).length,
    openAlerts: rowsWhere<Alert>('alerts', projectId, `AND ${jf('status')} = 'open'`).length,
    expected: exp.length, expectedDelayed: exp.filter((e) => e.delayed).length,
  };
}
