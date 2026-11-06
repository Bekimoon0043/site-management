// /schedule — WBS tree + SVG Gantt (shared vertical scroller), table view, BoQ progress, baselines; task drawer.
// docs/research/schedule-ux.md §4–5. Planners edit the plan in the app (Edit plan tab, CPM re-plan); MS Project re-imports replace those edits.
import { startTransition, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, ChevronDown, ChevronRight, Clock, Download, FileDown, Flame, Link2, ListTree, MoreHorizontal, Play, Upload } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { useUrlFilters, useUrlParam } from '../../lib/url';
import { date, dateTime, exportExcel, num } from '../../lib/format';
import {
  Badge, Banner, Bar, Card, DataTable, Empty, ErrorBanner, Field, FilterBar, FilterSelect, FilterToggle, Loading, Menu, Modal, Page, Popover,
  SearchInput, Tabs, toast, useBusy, useHashTab,
} from '../../components/ui';
import { Gantt, type GanttShow, type Zoom } from '../../components/schedule/Gantt';
import { TaskDrawer } from '../../components/schedule/TaskDrawer';
import { BaselinePanel } from '../../components/schedule/BaselinePanel';
import { BoqProgress } from '../../components/schedule/BoqProgress';
import { EditGrid } from '../../components/schedule/EditGrid';
import { ResourceSheet, ResourceUsageView } from '../../components/schedule/Resources';
import { exportScheduleXml } from '../../components/schedule/exportXml';
import { loadAssignments, loadEdits, loadResources } from '../../components/schedule/editing';
import { buildTree, flatten, type FlatRow } from '../../components/schedule/tree';
import {
  canEditSchedule, d2, dayNo, lateDays, loadLinks, loadSchedules, loadTaskFlags, loadTasks, loadWorkWeek, schedRpc, taskState, todayStr,
  type SchedHeader, type SchedTask,
} from '../../components/schedule/data';
import '../../components/schedule/schedule.css';

const TABS = ['gantt', 'table', 'edit', 'resources', 'usage', 'boq', 'baselines'] as const;
type TabKey = (typeof TABS)[number];
const SHOW_KEY = 'sc.gantt.show';
const DEFAULT_SHOW: GanttShow = { baseline: true, forecast: true, deps: false, critical: true };
function loadShow(): GanttShow {
  try { const v = localStorage.getItem(SHOW_KEY); return v ? { ...DEFAULT_SHOW, ...(JSON.parse(v) as Partial<GanttShow>) } : DEFAULT_SHOW; } catch { return DEFAULT_SHOW; }
}
function saveShow(s: GanttShow) { try { localStorage.setItem(SHOW_KEY, JSON.stringify(s)); } catch { /* private mode */ } }

export function Schedule() {
  const projectId = useProjectId();
  const auth = useAuth();
  const nav = useNavigate();
  const me = auth.session?.user.id ?? '';
  const canEdit = canEditSchedule(auth.profile?.role);
  const lk = useLookups(projectId);
  const sq = useAsync(() => loadSchedules(projectId), [projectId], { key: 'schedules', staleTime: 60_000 });
  const [f, setF, { active, clear }] = useUrlFilters({ sid: '', q: '', mine: '', month: '', crit: '', late: '', unlinked: '', block: '' });
  const [zoomParam, setZoom] = useUrlParam('zoom');
  const zoom: Zoom = zoomParam === 'day' || zoomParam === 'month' ? zoomParam : 'week';
  const [peek, setPeek] = useUrlParam('peek');
  const [show, setShowState] = useState<GanttShow>(loadShow);
  const setShow = (patch: Partial<GanttShow>) => { const n = { ...show, ...patch }; setShowState(n); saveShow(n); };
  const [todayTick, setTodayTick] = useState(0);
  const [dialog, setDialog] = useState<'forecast' | 'autolink' | null>(null);

  const schedule: SchedHeader | undefined = sq.data?.schedules.find((s) => s.id === f.sid) ?? sq.data?.schedules[0];
  const version = schedule?.current_version_id ? sq.data?.versions.get(schedule.current_version_id) : undefined;
  const tq = useAsync(() => loadTasks(schedule?.id ?? ''), [schedule?.id], { key: 'sched-tasks', enabled: !!schedule, staleTime: 5 * 60_000 });
  const flagsQ = useAsync(() => loadTaskFlags(projectId, me), [projectId, me], { key: 'sched-flags', enabled: !!schedule, staleTime: 60_000 });
  const ww = useAsync(() => loadWorkWeek(projectId), [projectId], { key: 'work-week', staleTime: 30 * 60_000 });
  const [tabRaw, setTab] = useHashTab(TABS, 'gantt');
  const tab: TabKey = tabRaw === 'edit' && !canEdit ? 'gantt' : tabRaw;
  const editing = tab === 'edit';
  const lq = useAsync(() => loadLinks(schedule?.id ?? ''), [schedule?.id], { key: 'sched-links', enabled: !!schedule && (show.deps || editing), staleTime: 5 * 60_000 });
  const resQ = useAsync(() => loadResources(projectId), [projectId], { key: 'sched-resources', enabled: editing });
  const asgQ = useAsync(() => loadAssignments(schedule?.id ?? ''), [schedule?.id], { key: 'sched-assignments', enabled: !!schedule && editing });
  const editsQ = useAsync(() => loadEdits(schedule?.id ?? ''), [schedule?.id], { key: 'sched-edits', enabled: !!schedule && editing });

  const tasks = useMemo(() => tq.data ?? [], [tq.data]);
  const today = todayStr();
  const statusDate = schedule?.status_date ?? today;
  const statusDay = dayNo(statusDate);

  const model = useMemo(() => {
    const idx = new Map(tasks.map((t, i) => [t.id, i]));
    const tree = buildTree(tasks.length, (i) => (tasks[i].parent_id ? idx.get(tasks[i].parent_id!) ?? -1 : -1));
    const taskNo = new Int32Array(tasks.length);
    flatten(tree, () => true, null).forEach((r, n) => { taskNo[r.i] = n + 1; });
    const late = new Int32Array(tasks.length);
    let lateN = 0, critN = 0, leafN = 0;
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      late[i] = lateDays(t, statusDay);
      if (!t.is_summary) { leafN++; if (late[i] > 0) lateN++; if (t.is_critical) critN++; }
    }
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return { idx, tree, taskNo, late, lateN, critN, leafN, byId };
  }, [tasks, statusDay]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const flags = flagsQ.data;
  const monthA = dayNo(`${today.slice(0, 7)}-01`), monthB = (() => { const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)); return Math.floor(d.getTime() / 86400000); })();
  const term = f.q.trim().toLowerCase();
  const filtering = !!(term || f.mine || f.month || f.crit || f.late || f.unlinked || f.block);
  const rows: FlatRow[] = useMemo(() => {
    const match = filtering ? (i: number) => {
      const t = tasks[i];
      if (term && !(t.name.toLowerCase().includes(term) || (t.wbs ?? '').toLowerCase().includes(term)
        || String(model.taskNo[i]) === term || String(t.msp_uid) === term)) return false;
      if (!(f.mine || f.month || f.crit || f.late || f.unlinked || f.block)) return true;
      if (t.is_summary) return false;
      if (f.mine && !flags?.mine.has(t.id)) return false;
      if (f.crit && !t.is_critical) return false;
      if (f.late && model.late[i] <= 0) return false;
      if (f.block && t.block_id !== f.block) return false;
      if (f.unlinked && (t.is_milestone || t.ev_method === 'loe' || flags?.boq.has(t.id) || flags?.elements.has(t.id))) return false;
      if (f.month) {
        const a = Math.min(dayNo(t.forecast_start ?? t.planned_start), dayNo(t.planned_start)), b = Math.max(dayNo(t.forecast_finish ?? t.planned_finish), dayNo(t.planned_finish));
        if (!(a <= monthB && b >= monthA)) return false;
      }
      return true;
    } : null;
    return flatten(model.tree, (i) => !collapsed.has(tasks[i].id), match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, collapsed, filtering, term, f.mine, f.month, f.crit, f.late, f.unlinked, f.block, flags, tasks]);

  const toggle = (i: number) => startTransition(() => setCollapsed((s) => { const n = new Set(s); const id = tasks[i].id; if (n.has(id)) n.delete(id); else n.add(id); return n; }));
  const collapseTo = (level: number | null) => startTransition(() => setCollapsed(level === null ? new Set()
    : new Set(tasks.filter((_, i) => model.tree.children[i].length && model.tree.depth[i] >= level - 1).map((t) => t.id))));
  const open = (id: string) => setPeek(id, true);
  const peekTask = peek ? model.byId.get(peek) : undefined;
  const pathOf = (t: SchedTask) => {
    const out: string[] = [];
    for (let p = t.parent_id, k = 0; p && k < 30; k++) { const pt = model.byId.get(p); if (!pt) break; out.unshift(pt.name); p = pt.parent_id; }
    return out.join(' › ');
  };

  const exportRows = () => void exportExcel(`schedule-${schedule?.code ?? 'master'}`, rows.map((r) => {
    const t = tasks[r.i];
    return { 'Task ID': model.taskNo[r.i], WBS: t.wbs, UID: t.msp_uid, Task: `${'  '.repeat(r.depth)}${t.name}`, Summary: t.is_summary ? 'Y' : '', Milestone: t.is_milestone ? 'Y' : '',
      'Planned start': t.planned_start, 'Planned finish': t.planned_finish, 'Baseline start': t.baseline_start, 'Baseline finish': t.baseline_finish,
      'Forecast start': t.forecast_start, 'Forecast finish': t.forecast_finish, 'Actual start': t.actual_start, 'Actual finish': t.actual_finish,
      '% verified': Number(t.pct_complete), '% reported': Number(t.reported_pct), 'Total float (d)': t.total_float_days, Critical: t.is_critical ? 'Y' : '',
      'Days late': model.late[r.i] || null, 'Measured by': t.ev_method };
  }), 'Schedule');

  if (sq.error) return <Page title="Schedule"><ErrorBanner error={sq.error} onRetry={sq.reload} /></Page>;
  if (!sq.data) return <Page title="Schedule"><Loading lines={8} /></Page>;
  if (!schedule) {
    return (
      <Page title="Schedule">
        <Empty icon={<CalendarClock size={32} className="empty-icon" aria-hidden />} title="No schedule yet"
          action={canEdit ? <button className="primary" onClick={() => nav('/schedule/import')}><Upload size={14} />Import schedule</button> : undefined}>
          <p className="mb-0">Import your MS Project schedule — in MS Project use <b>File → Save As → XML Format (*.xml)</b> and upload the .xml.</p>
          <p className="muted">No MS Project? Fill in the Excel template on the import page.{canEdit ? '' : ' Ask your office engineer to import it.'}</p>
        </Empty>
      </Page>
    );
  }

  const subtitle = <>
    {schedule.code} · {schedule.name}{version ? <> · v{version.version_no}{version.file_name ? ` (${version.file_name})` : ''} imported {dateTime(version.imported_at)}{version.imported_by ? ` by ${lk.data?.person(version.imported_by) ?? '…'}` : ''}</> : ''}
    {' · '}Status date {date(statusDate)}{schedule.fc_finish ? <> · Forecast finish <b>{date(schedule.fc_finish)}</b></> : ''}{schedule.planned_finish ? <> · Planned finish {date(schedule.planned_finish)}</> : ''}
  </>;
  const menu = (
    <Popover align="right" trigger={(p) => <button {...p} aria-label="More actions"><MoreHorizontal size={16} /></button>}>
      {(close) => <Menu items={[
        canEdit ? { label: 'Import a new revision', icon: <Upload size={14} />, onClick: () => { close(); nav('/schedule/import'); } } : null,
        canEdit ? { label: 'Auto-link BoQ / elements from a custom field…', icon: <Link2 size={14} />, onClick: () => { close(); setDialog('autolink'); } } : null,
        canEdit ? { label: 'Progress to verify', icon: <Clock size={14} />, onClick: () => { close(); nav('/approvals?type=task_progress'); } } : null,
        { label: 'Baselines', icon: <CalendarClock size={14} />, onClick: () => { close(); setTab('baselines'); } },
        { label: 'Export visible rows to Excel', icon: <Download size={14} />, onClick: () => { close(); exportRows(); } },
        { label: 'Export to MS Project (XML)', icon: <FileDown size={14} />, onClick: () => { close(); void exportScheduleXml(schedule, auth.canSeePrices).then((f) => toast.success(`Downloaded ${f} — open it in MS Project (File › Open, XML)`), (e: Error) => toast.error(e.message)); } },
      ]} />}
    </Popover>
  );
  const blocks = lk.data?.blocks ?? [];
  const L = lk.data;

  return (
    <Page title="Schedule" subtitle={subtitle}
      titleExtra={schedule.status !== 'active' ? <Badge value={schedule.status} /> : undefined}
      actions={<>{canEdit && <button className="primary" onClick={() => setDialog('forecast')}><Play size={14} />Run forecast</button>}{menu}</>}>
      {sq.data.schedules.length > 1 && (
        <div className="mb-2"><FilterSelect label="Schedule" value={schedule.id} allLabel="Master" onChange={(v) => setF('sid', v)}
          options={sq.data.schedules.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))} /></div>
      )}
      <Tabs label="Schedule view" value={tab} onChange={(k: TabKey) => setTab(k)} tabs={[
        { key: 'gantt', label: 'Gantt' }, { key: 'table', label: 'Table' }, ...(canEdit ? [{ key: 'edit' as const, label: 'Edit plan' }] : []),
        { key: 'resources', label: 'Resources' }, { key: 'usage', label: 'Resource usage' }, { key: 'boq', label: 'BoQ progress' }, { key: 'baselines', label: 'Baselines' },
      ]} />
      <ErrorBanner error={tq.error ?? flagsQ.error ?? lk.error} onRetry={() => { tq.reload(); flagsQ.reload(); }} />
      {(tab === 'gantt' || tab === 'table' || tab === 'edit') && (
        <>
          <FilterBar active={active - (f.sid ? 1 : 0)} onClear={clear}>
            <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Search tasks, Task ID, WBS or UID" />
            <FilterToggle label="My tasks" checked={!!f.mine} onChange={(v) => setF('mine', v ? '1' : '')} />
            <FilterToggle label="This month" checked={!!f.month} onChange={(v) => setF('month', v ? '1' : '')} />
            <FilterToggle label={`Critical ${model.critN}`} checked={!!f.crit} onChange={(v) => setF('crit', v ? '1' : '')} />
            <FilterToggle label={`Late ${model.lateN}`} checked={!!f.late} onChange={(v) => setF('late', v ? '1' : '')} />
            <FilterToggle label="Not linked" checked={!!f.unlinked} onChange={(v) => setF('unlinked', v ? '1' : '')} />
            {blocks.length > 0 && <FilterSelect label="Block" value={f.block} onChange={(v) => setF('block', v)} options={blocks.map((b) => ({ value: b.id, label: b.code }))} />}
            <Popover trigger={(p) => <button {...p} className="small"><ListTree size={14} />Levels<ChevronDown size={12} /></button>}>
              {(close) => <Menu items={[
                { label: 'Expand all', onClick: () => { close(); collapseTo(null); } },
                ...[1, 2, 3, 4].map((l) => ({ label: `Collapse to level ${l}`, onClick: () => { close(); collapseTo(l); } })),
              ]} />}
            </Popover>
          </FilterBar>
          {tab === 'gantt' && (
            <div className="sched-toolbar no-print">
              <div className="sched-show" role="group" aria-label="Show on the chart">
                <span>Show:</span>
                <label><input type="checkbox" checked={show.baseline} onChange={(e) => setShow({ baseline: e.target.checked })} />Baseline</label>
                <label><input type="checkbox" checked={show.forecast} onChange={(e) => setShow({ forecast: e.target.checked })} />Actual / forecast</label>
                <label><input type="checkbox" checked={show.critical} onChange={(e) => setShow({ critical: e.target.checked })} />Critical path</label>
                <label><input type="checkbox" checked={show.deps} onChange={(e) => setShow({ deps: e.target.checked })} />Dependencies{show.deps && lq.loading && !lq.data ? ' …' : ''}</label>
              </div>
              <span className="grow" />
              <div className="segmented" role="tablist" aria-label="Zoom">
                {(['day', 'week', 'month'] as Zoom[]).map((z) => <button key={z} role="tab" aria-selected={zoom === z} onClick={() => setZoom(z === 'week' ? null : z)}>{z[0].toUpperCase() + z.slice(1)}</button>)}
              </div>
              <button className="small" onClick={() => setTodayTick((n) => n + 1)}>Today</button>
            </div>
          )}
          {!tq.data ? <Loading lines={10} /> : !tasks.length ? (
            <Empty title="This schedule has no tasks" action={canEdit ? <button className="primary" onClick={() => nav('/schedule/import')}><Upload size={14} />Import schedule</button> : undefined}>
              Import your MS Project schedule — File → Save As → XML.
            </Empty>
          ) : !rows.length ? (
            <Empty title="No tasks match these filters" action={<button onClick={clear}>Clear filters</button>} />
          ) : tab === 'edit' ? (
            <EditGrid schedule={schedule} tasks={tasks} rows={rows} byId={model.byId} links={lq.data} resources={resQ.data ?? []} assignments={asgQ.data ?? []}
              edits={editsQ.data} onOpen={open} onToggle={toggle} />
          ) : tab === 'gantt' ? (
            <>
              <Gantt tasks={tasks} rows={rows} taskNo={model.taskNo} zoom={zoom} show={show} links={lq.data} statusDate={statusDate} today={today} late={model.late}
                workWeek={ww.data} activeId={peek} onOpen={open} onToggle={toggle} todayTick={todayTick} />
              <div className="sched-foot">
                <span>{num(model.leafN, 0)} tasks · {num(model.critN, 0)} critical · {num(model.lateN, 0)} late{filtering ? ` · ${num(rows.length, 0)} rows shown` : ''}</span>
                <span className="grow" />
                <span className="gantt-legend" aria-label="Legend">
                  <span><i className="lg-planned" />Planned</span><span><i className="lg-done" />Done (verified)</span>
                  {show.baseline && <span><i className="lg-base" />Baseline</span>}{show.critical && <span><i className="lg-crit" />Critical</span>}
                  <span><i className="lg-today" />Today</span>
                </span>
              </div>
              <p className="muted small-text no-print">↑↓ / J K move · Enter opens the task · ←→ collapse / expand · the Table tab is the accessible text view.</p>
            </>
          ) : (
            <ScheduleTable rows={rows} tasks={tasks} taskNo={model.taskNo} late={model.late} flags={flags} activeId={peek} onOpen={open} onToggle={toggle} />
          )}
        </>
      )}
      {tab === 'resources' && L && <ResourceSheet projectId={projectId} L={L} canEdit={canEdit} />}
      {tab === 'usage' && <ResourceUsageView schedule={schedule} onOpenTask={open} />}
      {tab === 'boq' && <BoqProgress projectId={projectId} scheduleId={schedule.id} tasks={tasks} flags={flags} onOpenTask={open} />}
      {tab === 'baselines' && L && <BaselinePanel schedule={schedule} L={L} hasFileBaseline={tasks.some((t) => !!t.baseline_start)} />}
      {peekTask && L && (
        <TaskDrawer key={peekTask.id} task={peekTask} path={pathOf(peekTask)} taskById={model.byId} L={L} statusDay={statusDay}
          late={model.late[model.idx.get(peekTask.id) ?? 0]} onOpenTask={(id) => setPeek(id)} onClose={() => setPeek(null)} />
      )}
      {peek && tq.data && !peekTask && <Banner tone="warn" action={<button className="small" onClick={() => setPeek(null)}>Close</button>}>That task is no longer in this schedule.</Banner>}
      {dialog === 'forecast' && <ForecastModal schedule={schedule} onClose={() => setDialog(null)} />}
      {dialog === 'autolink' && <AutoLinkModal schedule={schedule} tasks={tasks} onClose={() => setDialog(null)} />}
    </Page>
  );
}

function ScheduleTable({ rows, tasks, taskNo, late, flags, activeId, onOpen, onToggle }: {
  rows: FlatRow[]; tasks: SchedTask[]; taskNo: Int32Array; late: Int32Array; flags: Awaited<ReturnType<typeof loadTaskFlags>> | undefined; activeId: string | null;
  onOpen: (id: string) => void; onToggle: (i: number) => void;
}) {
  const T = (r: FlatRow) => tasks[r.i];
  return (
    <Card flush>
      <DataTable rows={rows} rowKey={(r) => tasks[r.i].id} onRowClick={(r) => onOpen(T(r).id)} activeKey={activeId} exportName="schedule" viewKey="schedule-table" stickyFirst
        rowClass={(r) => (r.ctx ? 'muted' : T(r).is_summary ? 'strong' : undefined)}
        columns={[
          { key: 'task_no', label: 'Task ID', id: true, align: 'right', sortable: false, value: (r) => taskNo[r.i] },
          { key: 'wbs', label: 'WBS', id: true, sortable: false, value: (r) => T(r).wbs ?? T(r).msp_uid },
          { key: 'name', label: 'Task', sortable: false, value: (r) => T(r).name, render: (r) => {
            const t = T(r);
            return (
              <span className={`tree-name${t.is_summary ? ' summary' : ''}`} style={{ paddingLeft: r.depth * 16 }}>
                {r.hasKids ? <button type="button" className="caret" aria-label={r.expanded ? 'Collapse' : 'Expand'} aria-expanded={r.expanded} disabled={r.ctx}
                  onClick={(e) => { e.stopPropagation(); onToggle(r.i); }}>{r.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span style={{ width: 18 }} />}
                {t.is_critical && <Flame size={12} className="danger-text" aria-label="Critical" />}
                {t.is_milestone ? `◆ ${t.name}` : t.name}
              </span>
            );
          } },
          { key: 'status', label: 'Status', sortable: false, value: (r) => (late[r.i] > 0 ? 'late' : taskState(T(r))),
            render: (r) => (T(r).is_summary ? null : late[r.i] > 0 ? <Badge tone={late[r.i] > 7 ? 'danger' : 'warning'} icon={Clock} label={`${late[r.i]} d late`} /> : <Badge value={taskState(T(r))} />) },
          { key: 'start', label: 'Start', sortable: false, value: (r) => T(r).forecast_start ?? T(r).planned_start, render: (r) => d2(T(r).planned_start) },
          { key: 'finish', label: 'Finish', sortable: false, value: (r) => T(r).planned_finish, render: (r) => d2(T(r).planned_finish) },
          { key: 'bl_finish', label: 'Baseline finish', sortable: false, value: (r) => T(r).baseline_finish, render: (r) => d2(T(r).baseline_finish) },
          { key: 'fc_finish', label: 'Forecast finish', sortable: false, value: (r) => T(r).forecast_finish, render: (r) => d2(T(r).forecast_finish) },
          { key: 'var', label: 'Variance', align: 'right', sortable: false, value: (r) => { const a = dayNo(T(r).baseline_finish), b = dayNo(T(r).forecast_finish ?? T(r).planned_finish); return Number.isNaN(a) || Number.isNaN(b) ? null : b - a; },
            render: (r) => { const a = dayNo(T(r).baseline_finish), b = dayNo(T(r).forecast_finish ?? T(r).planned_finish); if (Number.isNaN(a) || Number.isNaN(b) || a === b) return null; return <span className={b > a ? 'slip-up' : 'slip-down'}>{b > a ? '+' : ''}{b - a} d</span>; } },
          { key: 'pct', label: '% verified', sortable: false, value: (r) => Number(T(r).pct_complete), render: (r) => <Bar pct={Number(T(r).pct_complete)} /> },
          { key: 'rep', label: '% reported', align: 'right', sortable: false, value: (r) => Number(T(r).reported_pct), render: (r) => (Number(T(r).reported_pct) !== Number(T(r).pct_complete) ? <span className="muted">{num(T(r).reported_pct, 0)} %</span> : null) },
          { key: 'float', label: 'Float', align: 'right', sortable: false, value: (r) => T(r).total_float_days, render: (r) => (T(r).is_summary || T(r).total_float_days == null ? null : <span className={Number(T(r).total_float_days) < 0 ? 'danger-text' : ''}>{num(T(r).total_float_days, 1)} d</span>) },
          { key: 'linked', label: 'Linked to', sortable: false, value: (r) => { const t = T(r); const b = flags?.boq.get(t.id) ?? 0, e = flags?.elements.get(t.id) ?? 0; return t.is_summary ? '' : [b && `${b} BoQ`, e && `${e} elements`].filter(Boolean).join(' · ') || (t.is_milestone ? '' : 'not linked'); },
            render: (r) => { const t = T(r); if (t.is_summary) return null; const b = flags?.boq.get(t.id) ?? 0, e = flags?.elements.get(t.id) ?? 0; if (!b && !e) return t.is_milestone ? null : <span className="warn-text">not linked</span>; return [b && `${b} BoQ`, e && `${e} elements`].filter(Boolean).join(' · '); } },
          { key: 'pending', label: 'To verify', align: 'right', sortable: false, hidden: false, value: (r) => flags?.pending.get(T(r).id) ?? 0, render: (r) => { const n = flags?.pending.get(T(r).id); return n ? <Badge value="reported" label={String(n)} /> : null; } },
        ]} />
    </Card>
  );
}

function ForecastModal({ schedule, onClose }: { schedule: SchedHeader; onClose: () => void }) {
  const [sd, setSd] = useState(todayStr());
  const { busy, error, run } = useBusy();
  const go = () => void run(async () => {
    const r = await schedRpc('run_forecast', { schedule_id: schedule.id, status_date: sd });
    const parts = [r.fc_finish ? `forecast finish ${date(r.fc_finish)}` : null, `${num(r.critical_count, 0)} critical`,
      Number(r.negative_float_count) ? `${num(r.negative_float_count, 0)} with negative float` : null, r.spi_t != null ? `SPI(t) ${num(r.spi_t, 2)}` : null].filter(Boolean);
    toast.success(`Forecast updated · ${parts.join(' · ')}`);
    onClose();
  });
  return (
    <Modal title="Run forecast" size="sm" onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !sd} onClick={go}>{busy && <span className="spinner" />}Run forecast</button></>}>
      <ErrorBanner error={error} />
      <p className="muted">Recalculates forecast dates, float and the critical path from verified progress and the schedule logic, as of the status date.</p>
      <Field label="Status date" hint={schedule.status_date ? `Last run: ${date(schedule.status_date)}` : 'Not run yet'}>
        <input type="date" value={sd} max={todayStr()} onChange={(e) => setSd(e.target.value)} data-autofocus />
      </Field>
    </Modal>
  );
}

function AutoLinkModal({ schedule, tasks, onClose }: { schedule: SchedHeader; tasks: SchedTask[]; onClose: () => void }) {
  const fields = useMemo(() => {
    const n = new Map<string, number>();
    for (const t of tasks) for (const [k, v] of Object.entries(t.custom ?? {})) if (v) n.set(k, (n.get(k) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]);
  }, [tasks]);
  const guess = (re: RegExp) => fields.find(([k]) => re.test(k))?.[0] ?? '';
  const [boq, setBoq] = useState(guess(/boq/i));
  const [el, setEl] = useState(guess(/element/i));
  const [overwrite, setOverwrite] = useState(false);
  const [methods, setMethods] = useState(true);
  const [warnings, setWarnings] = useState<string[]>([]);
  const { busy, error, setError, run } = useBusy();
  const go = () => {
    if (!boq && !el) { setError('Choose the custom field that holds BoQ item numbers or element codes.'); return; }
    void run(async () => {
      const r = await schedRpc('auto_link_tasks', { schedule_id: schedule.id, boq_field: boq || undefined, element_field: el || undefined, overwrite, set_methods: methods });
      const w = (r.warnings as string[] | undefined) ?? [];
      toast.success(`Linked ${num(r.boq_links, 0)} BoQ item(s) and ${num(r.element_links, 0)} element(s)${w.length ? ` · ${w.length} code(s) not found` : ''}`);
      if (w.length) setWarnings(w); else onClose();
    });
  };
  const opts = fields.map(([k, n]) => <option key={k} value={k}>{k} ({n} tasks)</option>);
  return (
    <Modal title="Auto-link from MS Project custom fields" size="md" onClose={onClose}
      footer={<><button onClick={onClose}>{warnings.length ? 'Close' : 'Cancel'}</button>{!warnings.length && <button className="primary" disabled={busy} onClick={go}>{busy && <span className="spinner" />}Link tasks</button>}</>}>
      <ErrorBanner error={error} />
      {!fields.length ? <Banner tone="warn">No custom fields (Text1…Text30) have values in this schedule. Add a “BoQ code” column in MS Project, or link tasks one by one in the task drawer.</Banner> : (
        <div className="form-grid">
          <Field label="BoQ item numbers are in" hint="e.g. 02.03 or 02.03;02.04=120 (qty)"><select value={boq} onChange={(e) => setBoq(e.target.value)}><option value="">— none —</option>{opts}</select></Field>
          <Field label="Element codes are in" hint="e.g. C1;C2@GF"><select value={el} onChange={(e) => setEl(e.target.value)}><option value="">— none —</option>{opts}</select></Field>
          <Field label="Replace links made by hand" wide check><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /></Field>
          <Field label="Measure linked tasks by quantity / elements (when no progress yet)" wide check><input type="checkbox" checked={methods} onChange={(e) => setMethods(e.target.checked)} /></Field>
        </div>
      )}
      {warnings.length > 0 && (
        <Banner tone="warn"><b>{warnings.length} code(s) did not match the BoQ or element list:</b>
          <ul className="mb-0">{warnings.slice(0, 12).map((w) => <li key={w}>{w}</li>)}</ul>{warnings.length > 12 && `…and ${warnings.length - 12} more`}
        </Banner>
      )}
    </Modal>
  );
}
