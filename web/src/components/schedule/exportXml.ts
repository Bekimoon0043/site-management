// "Export to MS Project (XML)": loads the current schedule and downloads it as MSPDI.
import { check, fetchAll, supabase } from '../../lib/supabase';
import { buildMspdi, type ExportTask } from '../../lib/msp/exportMspdi';
import type { CustomFieldDef } from '../../lib/msp';
import { loadLinks, loadWorkWeek, type SchedHeader } from './data';
import { loadAssignments, loadResourceRates, loadResources } from './editing';

type Row = Omit<ExportTask, 'uid' | 'start' | 'finish'> & { id: string; msp_uid: number; planned_start: string | null; planned_finish: string | null };

export async function exportScheduleXml(schedule: SchedHeader, canSeePrices: boolean): Promise<string> {
  const [tasks, links, ww, version, resources, rates, assignments] = await Promise.all([
    fetchAll<Row>((a, b) => supabase.from('schedule_tasks')
      .select('id, msp_uid, name, wbs, outline_number, outline_level, is_summary, is_milestone, planned_start, planned_finish, duration_days, constraint_type, '
        + 'constraint_date, deadline, notes, pct_complete, actual_start, actual_finish, baseline_start, baseline_finish, custom' as '*')
      .eq('schedule_id', schedule.id).is('deleted_at', null).order('sort_order').range(a, b), 30000),
    loadLinks(schedule.id),
    loadWorkWeek(schedule.project_id),
    schedule.current_version_id
      ? supabase.from('schedule_versions').select('header').eq('id', schedule.current_version_id).maybeSingle().then(check) as Promise<{ header: { custom_fields?: CustomFieldDef[] } | null } | null>
      : Promise.resolve(null),
    loadResources(schedule.project_id),
    canSeePrices ? loadResourceRates(schedule.project_id) : Promise.resolve([]),
    loadAssignments(schedule.id),
  ]);
  const uidOf = new Map(tasks.map((t) => [t.id, t.msp_uid]));
  const durOf = new Map(tasks.map((t) => [t.id, Number(t.duration_days ?? 0)]));
  const rate = new Map(rates.map((r) => [r.resource_id, r]));
  const used = resources.filter((r) => assignments.some((a) => a.resource_id === r.id) || r.is_active);
  const resUid = new Map(used.map((r, i) => [r.id, i + 1]));
  const lo = schedule.planned_start ?? '', hi = schedule.planned_finish ?? '9999';
  const xml = buildMspdi({
    name: schedule.name, start: schedule.planned_start ?? tasks[0]?.planned_start ?? new Date().toISOString().slice(0, 10), currency: schedule.currency_code || 'ETB',
    minutesPerDay: schedule.minutes_per_day ?? 480, workingWeekdays: ww.weekdays,
    holidays: [...ww.holidays].filter(([d]) => d >= lo && d <= hi).sort().map(([date, name]) => ({ date, name })),
    customFields: version?.header?.custom_fields ?? [],
    tasks: tasks.map((t) => ({ ...t, uid: t.msp_uid, start: t.planned_start, finish: t.planned_finish })),
    links: links.flatMap((l) => {
      const p = uidOf.get(l.pred_task_id), s = uidOf.get(l.succ_task_id);
      return p != null && s != null ? [{ pred_uid: p, succ_uid: s, type: l.link_type, lag_days: Number(l.lag_days) }] : [];
    }),
    resources: used.map((r) => ({ uid: resUid.get(r.id)!, code: r.code, name: r.name, kind: r.kind, unit: r.unit, max_units: Number(r.max_units),
      std_rate: rate.has(r.id) ? Number(rate.get(r.id)!.std_rate) : null, cost_per_use: rate.has(r.id) ? Number(rate.get(r.id)!.cost_per_use) : null })),
    assignments: assignments.flatMap((a) => {
      const tu = uidOf.get(a.task_id), ru = resUid.get(a.resource_id), res = resources.find((r) => r.id === a.resource_id);
      return tu != null && ru != null && res ? [{ task_uid: tu, resource_uid: ru, units: Number(a.units), duration_days: durOf.get(a.task_id) ?? 0, kind: res.kind }] : [];
    }),
  });
  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${schedule.code}-${new Date().toISOString().slice(0, 10)}.xml`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return a.download;
}
