// Small domain helpers shared by several pages (kept out of page modules so
// importing them doesn't drag a whole page — or recharts — into another chunk).
import type { Lookups } from './hooks';
import { today } from './format';

export interface RollupRow {
  project_id: string; block_id: string | null; block_code: string | null; level_id: string | null; level_code: string | null;
  elements: number; completed: number; avg_progress_pct: number; delayed: number;
}
export interface ConsumptionRow {
  project_id: string; element_id: string; element_code: string; element_type: string; block_id: string | null; level_id: string | null;
  progress_pct: number; material_spec_id: string; label: string; category: string; uom: string; planned_qty: number | null;
  allowed_qty: number | null; issued_qty: number; wasted_qty: number; earned_qty: number | null; variance_pct: number | null;
}
export interface BalanceRow {
  project_id: string; store_id: string; store_name: string; material_spec_id: string; label: string; category: string; uom: string;
  stock_status: 'available' | 'quarantine'; qty: number; last_txn_at: string; min_level: number; reorder_level: number; below_reorder: boolean;
}

/** Variance threshold (%) for a material category, from project settings (FR-CC-02). */
export function thresholdFor(thresholds: Record<string, number> | undefined, category: string): number | null {
  if (!thresholds) return null;
  const k = Object.keys(thresholds).find((x) => x.toLowerCase() === category.toLowerCase());
  return k ? Number(thresholds[k]) : null;
}

const daysBetween = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);

/** Elements behind plan (FR-PG-04), computed from cached lookups. */
export function delayedElements(L: Lookups) {
  const t = today();
  return L.elements.map((e) => {
    let reason = '';
    let days = 0;
    if (e.status !== 'completed' && e.planned_finish && e.planned_finish < t) { reason = 'Finish overdue'; days = daysBetween(e.planned_finish, t); }
    else if (e.status === 'not_started' && e.planned_start && e.planned_start < t) { reason = 'Start overdue'; days = daysBetween(e.planned_start, t); }
    else if (e.actual_finish && e.planned_finish && e.actual_finish > e.planned_finish) { reason = 'Finished late'; days = daysBetween(e.planned_finish, e.actual_finish); }
    return { ...e, reason, days };
  }).filter((e) => e.reason);
}

/** Emergency issue still not linked to a request after 24 h (BR-01). */
export const isOverdueEmergency = (m: { is_emergency: boolean; mr_id: string | null; status: string; issued_at: string }) =>
  m.is_emergency && !m.mr_id && m.status !== 'reversed' && Date.now() - new Date(m.issued_at).getTime() > 24 * 3600 * 1000;
