// Site operations data layer (contract: lib/contract-site.ts, migration 20261105000030_site_ops.sql).
import { check, fetchAll, supabase } from '../../lib/supabase';
import { invalidateAfterWrite } from '../../lib/query';
import type { HseIncident, PlantItem, PlantLog, PlantUtilisation, RpcMapSite, ToolboxTalk, WorkPermit } from '../../lib/contract-site';

export async function siteRpc<N extends keyof RpcMapSite>(name: N, payload: Omit<RpcMapSite[N], 'op_id'>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc(name, { p: { op_id: crypto.randomUUID(), ...payload } });
  if (error) throw new Error(error.message);
  invalidateAfterWrite();
  return (data ?? {}) as Record<string, unknown>;
}

export const loadIncidents = (projectId: string) => fetchAll<HseIncident>((a, b) => supabase.from('hse_incidents').select('*')
  .eq('project_id', projectId).order('occurred_at', { ascending: false }).range(a, b));
export const loadPermits = (projectId: string) => fetchAll<WorkPermit>((a, b) => supabase.from('work_permits').select('*')
  .eq('project_id', projectId).order('valid_from', { ascending: false }).range(a, b));
export const loadToolboxTalks = (projectId: string) => fetchAll<ToolboxTalk>((a, b) => supabase.from('toolbox_talks').select('*')
  .eq('project_id', projectId).order('held_on', { ascending: false }).range(a, b));
export const loadPlant = (projectId: string) => fetchAll<PlantItem>((a, b) => supabase.from('plant_items').select('*')
  .eq('project_id', projectId).order('code').range(a, b));
export async function loadPlantLogs(projectId: string, from: string, to: string) {
  return fetchAll<PlantLog>((a, b) => supabase.from('plant_logs').select('*').eq('project_id', projectId)
    .gte('log_date', from).lte('log_date', to).order('log_date', { ascending: false }).range(a, b));
}
export async function loadUtilisation(projectId: string, from: string, to: string) {
  const { data, error } = await supabase.rpc('plant_utilisation', { p_project: projectId, p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return (data ?? []) as PlantUtilisation[];
}
export const loadIncident = async (id: string) => check(await supabase.from('hse_incidents').select('*').eq('id', id).maybeSingle()) as HseIncident | null;
export const loadPermit = async (id: string) => check(await supabase.from('work_permits').select('*').eq('id', id).maybeSingle()) as WorkPermit | null;

/** yyyy-mm-dd in Ethiopia (UTC+3). */
export const etToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400_000).toISOString().slice(0, 10);
/** datetime-local value (local clock) ↔ ISO. */
export const toLocalInput = (iso: string) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export const fromLocalInput = (v: string) => new Date(v).toISOString();
