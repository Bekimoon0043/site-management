// Pull for schedule progress (SYNC_TABLES_SCHEDULE — no money) and the look-ahead
// (SYNC_TABLES_LOOKAHEAD, filtered to the current + next plan of each project), plus
// online-only views cached in kv for offline display: v_progress_overview,
// v_lookahead_material_needs and v_ppc.
import { SYNC_TABLES_SCHEDULE, type ProgressOverview } from './contract-schedule';
import type { LookaheadMaterialNeed, LookaheadPlan, PpcWeek } from './contract-lookahead';
import { SYNC_TABLES_LOOKAHEAD } from './contract-lookahead';
import { getDb, kvGet, kvSet, upsertServerRows, type Row } from './db';
import { supabase } from './supabase';
import { LA_PLAN_FILTERED } from './tables-schedule';
import { skipMissingTable } from './tables-pc';
import { today } from './format';

const PAGE = 1000;
const OVERLAP_MS = 2 * 60 * 1000;

type Filter = { col: string; ids: string[]; select?: string; strip?: string } | null;

async function pull(name: string, filter: Filter = null, cursorSuffix = ''): Promise<void> {
  const cursorKey = `cursor:${name}${cursorSuffix}`;
  const cursor = kvGet(cursorKey);
  const since = cursor ? new Date(new Date(cursor).getTime() - OVERLAP_MS).toISOString() : '1970-01-01T00:00:00Z';
  let maxSeen = cursor;
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase.from(name).select(filter?.select ?? '*').gt('updated_at', since);
    if (filter) q = q.in(filter.col, filter.ids);
    const { data, error } = await q.order('updated_at', { ascending: true }).range(offset, offset + PAGE - 1);
    if (error) throw new Error(`${name}: ${error.message}`);
    let rows = (data ?? []) as unknown as Row[];
    if (filter?.strip) rows = rows.map((r) => { const { [filter.strip!]: _, ...rest } = r; return rest; });
    if (rows.length) {
      upsertServerRows(name, rows);
      const last = rows[rows.length - 1].updated_at as string;
      if (!maxSeen || last > maxSeen) maxSeen = last;
    }
    if (rows.length < PAGE) break;
  }
  if (maxSeen) kvSet(cursorKey, maxSeen);
}

const j = (f: string) => `json_extract(json, '$.${f}')`;

/** Current + next plan of each project / calendar mode (from the local lookahead_plans copy). */
export function activePlanIds(projectId?: string): string[] {
  const d = today();
  const plans = getDb().getAllSync<{ json: string }>(
    `SELECT json FROM rows WHERE tbl = 'lookahead_plans' AND deleted = 0 ${projectId ? 'AND project_id = ?' : ''}`,
    projectId ? [projectId] : []).map((r) => JSON.parse(r.json) as LookaheadPlan);
  const ids = new Set<string>();
  const groups = new Map<string, LookaheadPlan[]>();
  for (const p of plans) {
    const k = `${p.project_id}|${p.calendar_mode}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  for (const ps of groups.values()) {
    const cur = ps.find((p) => p.period_start <= d && p.period_end >= d);
    if (cur) ids.add(cur.id);
    const next = ps.filter((p) => p.period_start > d).sort((a, b) => a.period_start.localeCompare(b.period_start))[0];
    if (next) ids.add(next.id);
    // between plans (no current one yet): keep the latest past plan so outcomes can still be reported
    if (!cur) {
      const last = ps.filter((p) => p.period_end < d).sort((a, b) => b.period_end.localeCompare(a.period_end))[0];
      if (last) ids.add(last.id);
    }
  }
  return [...ids].sort();
}

function prune(ids: string[]) {
  const d = getDb();
  const keep = ids.map((x) => `'${x.replace(/'/g, "''")}'`).join(',') || "''";
  d.withTransactionSync(() => {
    for (const t of LA_PLAN_FILTERED) {
      d.runSync(`DELETE FROM rows WHERE tbl = ? AND pending IS NULL AND ${j('plan_id')} NOT IN (${keep})`, [t]);
    }
    d.runSync(`DELETE FROM rows WHERE tbl = 'lookahead_constraints' AND pending IS NULL
               AND parent NOT IN (SELECT pk FROM rows WHERE tbl = 'lookahead_items')`);
    d.runSync(`DELETE FROM rows WHERE tbl = 'constraint_events' AND pending IS NULL
               AND parent NOT IN (SELECT pk FROM rows WHERE tbl = 'lookahead_constraints')`);
  });
}

async function pullLookahead(): Promise<void> {
  await pull('lookahead_plans');
  await pull('rnc_reasons');
  const ids = activePlanIds();
  if (!ids.length) { prune([]); return; }
  const suffix = `:${ids.map((x) => x.slice(0, 8)).join('.')}`;
  for (const t of SYNC_TABLES_LOOKAHEAD) {
    if (t.name === 'lookahead_plans' || t.name === 'rnc_reasons') continue;
    if (LA_PLAN_FILTERED.has(t.name)) { await pull(t.name, { col: 'plan_id', ids }, suffix); continue; }
    // children without plan_id: filter through an inner embed; fall back to the member-scoped table.
    const f: Filter = t.name === 'lookahead_constraints'
      ? { col: 'lookahead_items.plan_id', ids, select: '*, lookahead_items!inner(plan_id)', strip: 'lookahead_items' }
      : t.name === 'constraint_events'
        ? { col: 'lookahead_constraints.lookahead_items.plan_id', ids, select: '*, lookahead_constraints!inner(lookahead_items!inner(plan_id))', strip: 'lookahead_constraints' }
        : null;
    try { await pull(t.name, f, f ? suffix : ''); }
    catch (e) { if (f) await pull(t.name); else throw e; }
  }
  prune(ids);
}

/** Pull every schedule / look-ahead table. Tolerates servers without the 0003/0004 migrations. */
export async function pullScheduleTables(): Promise<void> {
  for (const t of SYNC_TABLES_SCHEDULE) await pull(t.name).catch(skipMissingTable);
  await pullLookahead().catch(skipMissingTable);
}

// ---------------------------------------------------------------------------
// Online views cached in kv (read on screens with the cached copy offline)
// ---------------------------------------------------------------------------

interface Cached<T> { at: string; rows: T[] }
const readCache = <T>(k: string): Cached<T> | null => {
  try { const v = kvGet(k); return v ? (JSON.parse(v) as Cached<T>) : null; } catch { return null; }
};
const writeCache = <T>(k: string, rows: T[]) => kvSet(k, JSON.stringify({ at: new Date().toISOString(), rows }));

export const cachedOverview = (projectId: string) => readCache<ProgressOverview>(`v:overview:${projectId}`);
export const cachedNeeds = (planId: string) => readCache<LookaheadMaterialNeed>(`v:la-needs:${planId}`);
export const cachedPpc = (projectId: string) => readCache<PpcWeek>(`v:ppc:${projectId}`);

export async function fetchOverview(projectId: string): Promise<void> {
  const { data, error } = await supabase.from('v_progress_overview').select('*').eq('project_id', projectId).eq('level', 'project');
  if (!error && data) writeCache(`v:overview:${projectId}`, data as ProgressOverview[]);
}
export async function fetchNeeds(planId: string): Promise<void> {
  const { data, error } = await supabase.from('v_lookahead_material_needs').select('*').eq('plan_id', planId);
  if (!error && data) writeCache(`v:la-needs:${planId}`, data as LookaheadMaterialNeed[]);
}
export async function fetchPpc(projectId: string): Promise<void> {
  const { data, error } = await supabase.from('v_ppc').select('*').eq('project_id', projectId)
    .lte('week_start', today()).order('week_start', { ascending: false }).limit(8);
  if (!error && data) writeCache(`v:ppc:${projectId}`, data as PpcWeek[]);
}

/** After each sync: refresh the cached views of the current project (best effort, never fails the sync). */
export async function refreshScheduleViews(projectId: string | null): Promise<void> {
  if (!projectId) return;
  await Promise.all([
    fetchOverview(projectId).catch(() => undefined),
    fetchPpc(projectId).catch(() => undefined),
    ...activePlanIds(projectId).map((id) => fetchNeeds(id).catch(() => undefined)),
  ]);
}
