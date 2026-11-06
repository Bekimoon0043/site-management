// Read helpers over the local store. Everything here works offline.
import { get, list } from './db';
import type {
  AppRole, Element, ElementTakeoff, Material, MaterialRequest, MaterialSpec, MivLine, Miv, MrLine, MrLineElement,
  Profile, Project, SpecConversion, StockLedgerEntry, StockStatus, Store, Block, Level, Supplier,
} from './contract';

export interface SpecInfo extends MaterialSpec { label: string; category: string; material_name: string }

export function specs(): SpecInfo[] {
  const mats = new Map(list<Material>('materials').map((m) => [m.id, m]));
  return list<MaterialSpec>('material_specs')
    .filter((s) => s.is_active && mats.has(s.material_id))
    .map((s) => {
      const m = mats.get(s.material_id)!;
      return { ...s, label: `${m.name} ${s.grade}`.trim(), category: m.category, material_name: m.name };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

let specCache: { v: number; map: Map<string, SpecInfo> } | null = null;
export function specMap(version: number): Map<string, SpecInfo> {
  if (!specCache || specCache.v !== version) specCache = { v: version, map: new Map(specs().map((s) => [s.id, s])) };
  return specCache.map;
}
export function specLabel(id: string | null | undefined): string {
  if (!id) return '—';
  const s = get<MaterialSpec>('material_specs', id);
  if (!s) return 'Unknown material';
  const m = get<Material>('materials', s.material_id);
  return `${m?.name ?? ''} ${s.grade}`.trim();
}
export const specUom = (id: string) => get<MaterialSpec>('material_specs', id)?.uom ?? '';

export const conversions = (specId: string) => list<SpecConversion>('spec_conversions', { parent: specId });

export const projects = () => list<Project>('projects').filter((p) => p.is_active).sort((a, b) => a.name.localeCompare(b.name));
export const project = (id: string | null) => get<Project>('projects', id);
export const stores = (projectId: string) => list<Store>('stores', { project: projectId }).sort((a, b) => a.name.localeCompare(b.name));
export const blocks = (projectId: string) => list<Block>('blocks', { project: projectId }).sort((a, b) => a.code.localeCompare(b.code));
export const levels = (projectId: string) => list<Level>('levels', { project: projectId }).sort((a, b) => a.sort_order - b.sort_order);
export const elements = (projectId: string) => list<Element>('elements', { project: projectId }).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
export const suppliers = () => list<Supplier>('suppliers').sort((a, b) => a.name.localeCompare(b.name));

export function elementLabel(id: string | null | undefined): string {
  const e = get<Element>('elements', id);
  if (!e) return '—';
  const lv = get<Level>('levels', e.level_id);
  return lv ? `${e.code} (${lv.code})` : e.code;
}

export function members(projectId: string, roles?: AppRole[]): Profile[] {
  const ids = new Set(list<{ project_id: string; user_id: string }>('project_members', { project: projectId }).map((m) => m.user_id));
  return list<Profile>('profiles')
    .filter((p) => p.is_active && (ids.has(p.id) || p.role === 'admin') && (!roles || roles.includes(p.role)))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}
export const personName = (id: string | null | undefined) => (id ? get<Profile>('profiles', id)?.full_name || 'Unknown user' : '—');

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

export function ledger(projectId: string): StockLedgerEntry[] {
  return list<StockLedgerEntry>('stock_ledger', { project: projectId });
}

export function stockQty(projectId: string, specId: string, storeId?: string | null, status: StockStatus = 'available'): number {
  return list<StockLedgerEntry>('stock_ledger', { parent: specId })
    .filter((l) => l.project_id === projectId && l.stock_status === status && (!storeId || l.store_id === storeId))
    .reduce((s, l) => s + Number(l.qty), 0);
}

export interface BalanceRow { store_id: string; material_spec_id: string; available: number; quarantine: number; last: string }
export function stockBalances(projectId: string): BalanceRow[] {
  const m = new Map<string, BalanceRow>();
  for (const l of ledger(projectId)) {
    const k = `${l.store_id}|${l.material_spec_id}`;
    const r = m.get(k) ?? { store_id: l.store_id, material_spec_id: l.material_spec_id, available: 0, quarantine: 0, last: '' };
    if (l.stock_status === 'available') r.available += Number(l.qty); else if (l.stock_status === 'quarantine') r.quarantine += Number(l.qty); // on_loan (gate passes) is neither
    if (l.txn_at > r.last) r.last = l.txn_at;
    m.set(k, r);
  }
  return [...m.values()];
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const requests = (projectId: string) =>
  list<MaterialRequest>('material_requests', { project: projectId }).sort((a, b) => b.created_at.localeCompare(a.created_at));
export const mrLines = (mrId: string) => list<MrLine>('mr_lines', { parent: mrId }).sort((a, b) => a.line_no - b.line_no);
export const lineElements = (lineId: string) => list<MrLineElement>('mr_line_elements', { parent: lineId });

/** Issued so far against an MR line (non-reversed issues). */
export function issuedForLine(projectId: string, lineId: string): number {
  const mivs = new Map(list<Miv>('mivs', { project: projectId }).map((m) => [m.id, m]));
  return list<MivLine>('miv_lines', { project: projectId })
    .filter((l) => l.mr_line_id === lineId && mivs.get(l.miv_id)?.status !== 'reversed')
    .reduce((s, l) => s + Number(l.qty), 0);
}

const INACTIVE = new Set(['draft', 'rejected', 'cancelled', 'returned']);

/** FR-MR-03: take-off planned (incl. wastage), already requested, balance for element+spec. */
export function boqBalance(projectId: string, elementId: string, specId: string, excludeMr?: string) {
  const spec = get<MaterialSpec>('material_specs', specId);
  const t = list<ElementTakeoff>('element_takeoffs', { parent: elementId }).find((x) => x.material_spec_id === specId);
  const planned = t ? Number(t.planned_qty) * (1 + Number(spec?.wastage_pct ?? 0) / 100) : null;
  const mrs = new Map(requests(projectId).map((r) => [r.id, r]));
  const lines = new Map(list<MrLine>('mr_lines', { project: projectId }).map((l) => [l.id, l]));
  let requested = 0;
  for (const le of list<MrLineElement>('mr_line_elements', { project: projectId })) {
    if (le.element_id !== elementId) continue;
    const l = lines.get(le.mr_line_id);
    if (!l || l.deleted_at || l.material_spec_id !== specId) continue;
    const r = mrs.get(l.mr_id);
    if (!r || r.id === excludeMr || INACTIVE.has(r.status)) continue;
    requested += Number(le.qty) * (l.approved_qty != null ? Number(l.approved_qty) / Number(l.qty) : 1);
  }
  return { planned, requested, balance: planned == null ? null : planned - requested };
}

/** Planned vs issued for an element (FR-PG-07). */
export function elementConsumption(projectId: string, elementId: string) {
  const out = new Map<string, { planned: number | null; issued: number }>();
  for (const t of list<ElementTakeoff>('element_takeoffs', { parent: elementId })) {
    out.set(t.material_spec_id, { planned: Number(t.planned_qty), issued: 0 });
  }
  for (const l of ledger(projectId)) {
    if (l.element_id !== elementId || !['miv', 'mrn'].includes(l.doc_type)) continue;
    const r = out.get(l.material_spec_id) ?? { planned: null, issued: 0 };
    r.issued -= Number(l.qty);
    out.set(l.material_spec_id, r);
  }
  return [...out.entries()].map(([specId, v]) => ({ specId, ...v }));
}
