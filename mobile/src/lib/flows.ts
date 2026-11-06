// Material procurement flows on the phone (contract-flows.ts): request type, ball in court,
// "your turn", PR numbers, stock available to issue (local reservations or v_stock_available_to_issue
// online) and labels. Everything reads the local store and works offline.
import type { AppRole, MaterialRequest, MrLine, ProjectSettings } from './contract';
import {
  flowStatusLabel, flowSteps, flowDocNumber, isTerminal, nextActor, stepIndex,
  type DeliveryNotice, type FlowActor, type FlowMrStatus, type MaterialRequestFlowFields, type MrApproval,
  type MrLineFlowFields, type ProjectSettingsFlowFields, type RequestType,
} from './contract-flows';
import { get, getDb, kvGet, kvSet, list } from './db';
import { devicePrefix } from './device';
import { jf, rowsWhere } from './counts';
import { issuedForLine, mrLines, stockQty, stores } from './queries';
import { supabase } from './supabase';
import { ft, ftx } from './flows-i18n';
import type { PoLine, PurchaseOrder } from './contract-procurement';

export type FlowMr = Omit<MaterialRequest, 'status'> & Partial<MaterialRequestFlowFields> & { status: FlowMrStatus; _pending?: string };
export type FlowLine = MrLine & Partial<MrLineFlowFields>;

/** request_type with fallbacks for rows pulled before the flows migration (PR numbers / reorder rows are purchases). */
export function requestTypeOf(mr: { request_type?: RequestType | null; number?: string | null; purpose?: string | null } | null | undefined): RequestType {
  if (!mr) return 'site_use';
  if (mr.request_type) return mr.request_type;
  return /(^|-)PR-/.test(mr.number ?? '') ? 'purchase' : 'site_use';
}

/** SQL expression for the request type of a material_requests row (alias optional). */
export const sqlRequestType = (a = '') => {
  const f = (x: string) => `json_extract(${a ? `${a}.` : ''}json, '$.${x}')`;
  return `COALESCE(${f('request_type')}, CASE WHEN ${f('number')} LIKE '%-PR-%' THEN 'purchase' ELSE 'site_use' END)`;
};

export interface FlowSettings { requireReview: boolean; requireCoordinatorReview: boolean; coordinatorFinalLimit: number | null }
export function flowSettings(projectId: string): FlowSettings {
  const s = get<ProjectSettings & Partial<ProjectSettingsFlowFields>>('project_settings', projectId);
  return {
    requireReview: s?.require_review ?? true,
    requireCoordinatorReview: s?.pr_require_coordinator_review ?? true,
    coordinatorFinalLimit: s?.pr_coordinator_final_limit ?? null,
  };
}

/** Ball in court: server value, else derived from status (also used for optimistic rows). */
export function ownerOf(mr: FlowMr, s: FlowSettings): FlowActor | null {
  const type = requestTypeOf(mr);
  if (mr.current_owner_role && !mr._pending) return mr.current_owner_role;
  return nextActor(mr.status, type, s);
}

export const actorLabel = (a: FlowActor | null | undefined) => (a ? ftx(`flow.actor.${a}`, a) : '—');
export const typeLabel = (type: RequestType) => ft(type === 'purchase' ? 'flow.type.purchase' : 'flow.type.site_use');

/** Translated flow status ("Approved by management", "Store order issued", …). */
export function flowLabel(status: FlowMrStatus, type: RequestType): string {
  return ftx(`flow.${type === 'purchase' ? 'pr' : 'sur'}.${status}`, flowStatusLabel(status, type));
}
export const stepLabel = (type: RequestType, key: string, fallback: string) => ftx(`flow.step.${type === 'purchase' ? 'pr' : 'sur'}.${key}`, fallback);

/** Compact row chip: "3/8 · Management approval". */
export function flowProgress(status: FlowMrStatus, type: RequestType): { k: number; n: number } {
  const steps = flowSteps(type);
  const i = stepIndex(status, type);
  return { k: i < 0 ? steps.length : i + 1, n: steps.length };
}

export const approvalsOf = (mrId: string) =>
  list<MrApproval>('mr_approvals', { parent: mrId }).sort((a, b) => a.created_at.localeCompare(b.created_at));

export interface Me { id: string; role: AppRole }

/** True when the current user is the one to act now (site of the "Your turn" banner). */
export function isMyTurn(mr: FlowMr, me: Me, s: FlowSettings, approvals: MrApproval[] = approvalsOf(mr.id)): boolean {
  if (isTerminal(mr.status)) return false;
  const type = requestTypeOf(mr);
  const actor = ownerOf(mr, s);
  if (!actor) return false;
  if (actor === 'requester') {
    if (type === 'purchase' && mr.status === 'received') return false;   // informed only
    return mr.requested_by === me.id;
  }
  if (me.role !== actor && me.role !== 'admin') return false;
  // no self-review / self-approval
  if (['review', 'approve'].some((k) => flowSteps(type).find((x) => x.key === k)?.statuses.includes(mr.status)) && mr.requested_by === me.id) return false;
  if (type === 'purchase' && approvals.some((a) => a.actor === me.id && a.step === 'endorse' && !a.superseded)) return false;
  return true;
}

export function endorsedByMe(mr: FlowMr, meId: string, approvals: MrApproval[]): boolean {
  return requestTypeOf(mr) === 'purchase' && approvals.some((a) => a.actor === meId && a.step === 'endorse' && !a.superseded);
}

// ---------------------------------------------------------------------------
// Document numbers: <PROJ>-PR-<DEV>-<SEQ> (purchase) / <PROJ>-MR-… (site use)
// ---------------------------------------------------------------------------

export function nextFlowNumber(projectCode: string, type: RequestType): string {
  const prefix = devicePrefix();
  if (!prefix) throw new Error('This device is not registered yet. Connect to the internet once to register it.');
  const key = `seq:${projectCode}:${type === 'purchase' ? 'PR' : 'MR'}`;
  let n = 0;
  getDb().withTransactionSync(() => {
    n = Number(kvGet(key) ?? '0') + 1;
    kvSet(key, String(n));
  });
  return flowDocNumber(projectCode, type, prefix, n);
}

// ---------------------------------------------------------------------------
// Stock available to issue (§5.1): available − unissued approved site-use qty of other store orders
// ---------------------------------------------------------------------------

const RESERVING: FlowMrStatus[] = ['approved', 'sourced', 'ordered', 'partially_issued'];

export const mainStoreId = (projectId: string): string | null => {
  const ss = stores(projectId).filter((s) => !(s as { deleted_at?: string | null }).deleted_at);
  return (ss.find((s) => s.store_type === 'main') ?? ss[0])?.id ?? null;
};

/** Local reservation per store × spec (other site-use store orders; FIFO by approved_at when `before` is set). */
export function reservedQty(projectId: string, storeId: string, specId: string, excludeMr?: string | null, before?: string | null): number {
  const main = mainStoreId(projectId);
  const mrs = rowsWhere<FlowMr>('material_requests', projectId,
    `AND ${jf('status')} IN (${RESERVING.map((x) => `'${x}'`).join(',')}) AND ${sqlRequestType()} = 'site_use'`);
  let res = 0;
  for (const r of mrs) {
    if (r.id === excludeMr) continue;
    if ((r.store_id ?? main) !== storeId) continue;
    if (before && r.approved_at && r.approved_at > before) continue;
    for (const l of mrLines(r.id) as FlowLine[]) {
      if (l.deleted_at || l.material_spec_id !== specId || !(Number(l.approved_qty) > 0) || (l.line_status && l.line_status !== 'open')) continue;
      res += Math.max(Number(l.approved_qty) - issuedForLine(projectId, l.id), 0);
    }
  }
  return res;
}

export interface AtiLine {
  lineId: string; specId: string; storeId: string | null; requested: number; issued: number;
  available: number; reserved: number; ati: number; shortfall: number;
  otherStores: { storeId: string; name: string; qty: number }[];
  onOrder: { number: string; qty: number; eta: string | null }[];
}

/** Stock check per line, computed on the phone (mirrors app.stock_check). */
export function stockCheckLocal(projectId: string, mr: FlowMr): AtiLine[] {
  const store = mr.store_id ?? mainStoreId(projectId);
  const fifo = RESERVING.includes(mr.status) ? mr.approved_at : null;
  const all = stores(projectId);
  const openPos = rowsWhere<PurchaseOrder>('purchase_orders', projectId, `AND ${jf('status')} IN ('approved','sent','partially_received')`);
  return (mrLines(mr.id) as FlowLine[]).filter((l) => !l.deleted_at).map((l) => {
    const requested = Number(l.approved_qty ?? l.reviewed_qty ?? l.qty);
    const issued = issuedForLine(projectId, l.id);
    const available = store ? stockQty(projectId, l.material_spec_id, store) : 0;
    const reserved = store ? reservedQty(projectId, store, l.material_spec_id, mr.id, fifo) : 0;
    const ati = Math.max(available - reserved, 0);
    const otherStores = all.filter((s) => s.id !== store).map((s) => ({
      storeId: s.id, name: s.name,
      qty: Math.max(stockQty(projectId, l.material_spec_id, s.id) - reservedQty(projectId, s.id, l.material_spec_id, mr.id), 0),
    })).filter((x) => x.qty > 0.0005);
    const onOrder: AtiLine['onOrder'] = [];
    for (const po of openPos) {
      if (store && po.delivery_store_id && po.delivery_store_id !== store) continue;
      for (const pl of list<PoLine>('po_lines', { parent: po.id })) {
        if (pl.deleted_at || pl.closed || pl.material_spec_id !== l.material_spec_id) continue;
        const out = Number(pl.qty) - Number(pl.qty_accepted ?? 0);
        if (out > 0.0005) onOrder.push({ number: po.number, qty: out, eta: po.eta ?? po.expected_date ?? null });
      }
    }
    return {
      lineId: l.id, specId: l.material_spec_id, storeId: store, requested, issued, available, reserved, ati,
      shortfall: Math.max(requested - issued - ati, 0), otherStores, onOrder,
    };
  });
}

/** Live v_stock_available_to_issue for the request's store when online; null offline / on error. */
export async function fetchAtiServer(projectId: string, storeId: string | null, specIds: string[]): Promise<Map<string, { ati: number; reserved: number; available: number }> | null> {
  if (!storeId || !specIds.length) return null;
  try {
    const { data, error } = await supabase.from('v_stock_available_to_issue')
      .select('store_id, material_spec_id, available, reserved, ati')
      .eq('project_id', projectId).eq('store_id', storeId).in('material_spec_id', specIds);
    if (error || !data) return null;
    const m = new Map<string, { ati: number; reserved: number; available: number }>();
    for (const r of data as { material_spec_id: string; available: number; reserved: number; ati: number }[]) {
      m.set(r.material_spec_id, { ati: Number(r.ati), reserved: Number(r.reserved), available: Number(r.available) });
    }
    return m;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Purchase requests converted from a site-use request. */
export const linkedPrs = (projectId: string, mrId: string) =>
  rowsWhere<FlowMr>('material_requests', projectId, `AND ${jf('source_mr_id')} = ?`, [mrId], `${jf('created_at')} ASC`);

/** POs that carry lines of this request. */
export function posForMr(mrId: string): PurchaseOrder[] {
  const lineIds = new Set(mrLines(mrId).map((l) => l.id));
  const ids = new Set<string>();
  const mr = get<FlowMr>('material_requests', mrId);
  if (!mr) return [];
  for (const pl of list<PoLine>('po_lines', { project: mr.project_id })) {
    if (!pl.deleted_at && pl.mr_line_id && lineIds.has(pl.mr_line_id)) ids.add(pl.po_id);
  }
  return [...ids].map((id) => get<PurchaseOrder>('purchase_orders', id)).filter((x): x is PurchaseOrder => !!x);
}

export const noticesForPo = (poId: string) =>
  list<DeliveryNotice>('delivery_notices', { parent: poId }).sort((a, b) => a.expected_date.localeCompare(b.expected_date));

export const noticeLabel = (s: DeliveryNotice['status']) => ftx(`flow.notice.${s}`, s);
