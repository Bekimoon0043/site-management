// /daily-progress — the site engineer picks an activity from the schedule (searchable drop-down), records the day's
// output, manpower, equipment and remarks (DailyOutputForm → report_daily_output). Every entry updates the task's
// progress and becomes a line of that day's site diary; the day's entries are listed below.
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Search, X } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { fetchAll, supabase } from '../../lib/supabase';
import { num } from '../../lib/format';
import type { DiaryActivity } from '../../lib/contract-schedule';
import { DELAY_CAUSE_LABELS, type DelayCause } from '../../lib/contract-field';
import { Badge, Banner, Card, DataTable, Empty, ErrorBanner, Field, Loading, Page } from '../../components/ui';
import { DailyOutputForm } from '../../components/schedule/DailyOutputForm';
import {
  DERIVED_METHODS, PROGRESS_REPORT_ROLES, d2, dayNo, loadSchedules, loadTasks, outputText, taskState, todayStr, type SchedTask,
} from '../../components/schedule/data';
import '../../components/schedule/schedule.css';

type Entry = DiaryActivity & {
  schedule_tasks: { wbs: string | null; name: string } | null;
  task_progress: { status: string } | null;
  site_diaries: { number: string; status: string; block_id: string | null } | null;
};

export function DailyProgress() {
  const auth = useAuth();
  const projectId = useProjectId();
  const role = auth.profile?.role;
  const lk = useLookups(projectId);
  const [day, setDay] = useState(todayStr());
  const [blockId, setBlockId] = useState('');
  const [sid, setSid] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);

  const sq = useAsync(() => loadSchedules(projectId), [projectId], { key: 'schedules', staleTime: 5 * 60_000 });
  const schedules = sq.data?.schedules ?? [];
  const schedule = schedules.find((s) => s.id === sid) ?? schedules[0];
  const tq = useAsync(() => loadTasks(schedule?.id ?? ''), [schedule?.id], { key: 'sched-tasks', enabled: !!schedule, staleTime: 60_000 });
  const eq = useAsync(() => fetchAll<Entry>((a, b) => supabase.from('diary_activities')
    .select('*, schedule_tasks(wbs, name), task_progress(status), site_diaries(number, status, block_id)' as '*')
    .eq('project_id', projectId).eq('activity_date', day).is('deleted_at', null).order('created_at', { ascending: false }).range(a, b)),
  [projectId, day], { key: 'daily-entries' });

  const tasks = tq.data ?? [];
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const selected = taskId ? byId.get(taskId) : undefined;
  const entries = (eq.data ?? []).filter((e) => (blockId ? e.site_diaries?.block_id === blockId : !e.site_diaries?.block_id));
  const diary = entries.find((e) => e.site_diaries)?.site_diaries;
  const diaryId = entries[0]?.diary_id;
  const people = entries.reduce((s, e) => s + Number(e.headcount ?? 0), 0);

  if (!role || !PROGRESS_REPORT_ROLES.includes(role)) {
    return <Page title="Daily progress"><Empty title="No access">Site engineers, office engineers and management record daily progress.</Empty></Page>;
  }
  const L = lk.data;

  return (
    <Page title="Daily progress" width="form"
      subtitle="Pick an activity from the schedule and record what was done. Each entry updates the progress and the site diary of the day.">
      <div className="stack">
        <Card>
          <div className="form-grid">
            <Field label="Date"><input type="date" value={day} max={todayStr()} onChange={(e) => { if (e.target.value) setDay(e.target.value); }} /></Field>
            <Field label="Site diary for" hint="One diary per day for the whole site or per block">
              <select value={blockId} onChange={(e) => setBlockId(e.target.value)}>
                <option value="">Whole site</option>
                {(L?.blocks ?? []).map((b) => <option key={b.id} value={b.id}>Block {b.code}{b.name ? ` · ${b.name}` : ''}</option>)}
              </select>
            </Field>
            {schedules.length > 1 && (
              <Field label="Schedule">
                <select value={schedule?.id ?? ''} onChange={(e) => { setSid(e.target.value); setTaskId(null); }}>
                  {schedules.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
                </select>
              </Field>
            )}
          </div>
          <div className="row mt-2 small-text" style={{ flexWrap: 'wrap', gap: 8 }}>
            {diary && diaryId
              ? <>Site diary <Link to={`/diary/${diaryId}`} className="strong">{diary.number}</Link> <Badge value={diary.status} label={diary.status === 'submitted' ? 'Awaiting sign-off' : undefined} /></>
              : <span className="muted">The site diary for {d2(day)} is opened with your first entry.</span>}
            <span className="muted">{diary && diaryId ? '· ' : ''}{entries.length} entr{entries.length === 1 ? 'y' : 'ies'} · {people} people</span>
          </div>
        </Card>

        <ErrorBanner error={sq.error ?? tq.error} onRetry={() => { sq.reload(); tq.reload(); }} />
        {sq.data && !schedules.length ? (
          <Empty title="No schedule yet">Import the MS Project schedule first (Planning › Import schedule) — activities are picked from it.</Empty>
        ) : !tq.data ? <Loading lines={4} /> : (
          <Card title="Activity">
            <ActivityPicker tasks={tasks} day={day} value={selected ?? null} onChange={(t) => setTaskId(t?.id ?? null)} />
            {selected && (
              <div className="mt-3">
                <DailyOutputForm key={`${selected.id}:${day}:${blockId}`} taskId={selected.id} date={day} blockId={blockId || null}
                  title={`${selected.wbs ? `${selected.wbs} ` : ''}${selected.name}`} onDone={() => eq.reload()} />
              </div>
            )}
          </Card>
        )}

        <Card title={`Entries on ${d2(day)}`} sub={blockId ? `Block ${L?.block(blockId) ?? ''}` : 'Whole site'} flush>
          {eq.error ? <div className="pad"><ErrorBanner error={eq.error} onRetry={eq.reload} /></div> : (
            <DataTable rows={entries} rowKey={(e) => e.id} maxHeight="none" loading={!eq.data}
              empty={{ title: 'Nothing recorded yet', body: 'Pick an activity above and save its output.' }}
              onRowClick={(e) => setTaskId(e.task_id)}
              columns={[
                { key: 'task', label: 'Activity', value: (e) => `${e.schedule_tasks?.wbs ?? ''} ${e.schedule_tasks?.name ?? ''}`,
                  render: (e) => <span>{e.schedule_tasks?.wbs && <span className="muted">{e.schedule_tasks.wbs} </span>}{e.schedule_tasks?.name}</span> },
                { key: 'output', label: 'Output', value: (e) => outputText(e) },
                { key: 'pct', label: 'To date', align: 'right', value: (e) => Number(e.pct_to_date ?? 0), render: (e) => `${num(e.pct_to_date, 1)} %` },
                { key: 'people', label: 'People', align: 'right', value: (e) => e.headcount ?? 0, render: (e) => (e.headcount == null ? '—' : `${e.headcount}${e.labour_hours ? ` · ${num(e.labour_hours, 1)} h` : ''}`) },
                { key: 'equipment', label: 'Equipment', value: (e) => e.equipment ?? '' },
                { key: 'notes', label: 'Delay / remarks', value: (e) => [e.delay_cause ? DELAY_CAUSE_LABELS[e.delay_cause as DelayCause] ?? e.delay_cause : '', e.remarks ?? ''].filter(Boolean).join(' — ') },
                { key: 'status', label: 'Status', value: (e) => e.task_progress?.status ?? '', render: (e) => <span className="row" style={{ gap: 4 }}><Badge value={e.task_progress?.status ?? 'reported'} />{e.after_signoff && <Badge tone="warning" label="after sign-off" icon={null} />}</span> },
                { key: 'by', label: 'By', value: (e) => L?.person(e.created_by) ?? '' },
              ]} />
          )}
        </Card>
      </div>
    </Page>
  );
}

type Group = { label: string; tasks: SchedTask[] };

/** Searchable drop-down of reportable activities: in progress, then planned this month, then everything else. */
function ActivityPicker({ tasks, day, value, onChange }: { tasks: SchedTask[]; day: string; value: SchedTask | null; onChange: (t: SchedTask | null) => void }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const parents = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const groups: Group[] = useMemo(() => {
    const d = dayNo(day);
    const m0 = dayNo(`${day.slice(0, 7)}-01`);
    const next = new Date(`${day.slice(0, 7)}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
    const m1 = dayNo(next.toISOString().slice(0, 10)) - 1;
    const tl = term.trim().toLowerCase();
    const ok = tasks.filter((t) => !t.is_summary && !DERIVED_METHODS.includes(t.ev_method) && t.source_state !== 'removed_in_source' && taskState(t) !== 'completed'
      && (!tl || t.name.toLowerCase().includes(tl) || (t.wbs ?? '').toLowerCase().startsWith(tl) || (parents.get(t.parent_id ?? '')?.name.toLowerCase().includes(tl) ?? false)));
    const started: SchedTask[] = [], month: SchedTask[] = [], rest: SchedTask[] = [];
    for (const t of ok) {
      const s = dayNo(t.baseline_start ?? t.planned_start), f = dayNo(t.baseline_finish ?? t.planned_finish);
      if (t.actual_start || Number(t.reported_pct) > 0) started.push(t);
      else if (!Number.isNaN(s) && !Number.isNaN(f) && s <= Math.max(m1, d) && f >= m0) month.push(t);
      else rest.push(t);
    }
    return [{ label: 'In progress', tasks: started }, { label: `Planned in ${new Date(`${day}T00:00:00`).toLocaleString('en', { month: 'long' })}`, tasks: month },
      { label: 'Other activities', tasks: rest }].filter((g) => g.tasks.length);
  }, [tasks, day, term, parents]);
  const flat = groups.flatMap((g) => g.tasks);
  const shown = flat.slice(0, 200);
  const pick = (t: SchedTask) => { onChange(t); setOpen(false); setTerm(''); };

  return (
    <div className="act-picker" ref={box} onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      {value && !open ? (
        <button className="act-current" onClick={() => setOpen(true)} aria-haspopup="listbox">
          <span className="grow">{value.wbs && <span className="muted">{value.wbs} </span>}<b>{value.name}</b>
            <span className="small-text muted"> · {parents.get(value.parent_id ?? '')?.name ?? 'Top level'} · {d2(value.baseline_start ?? value.planned_start)} → {d2(value.baseline_finish ?? value.planned_finish)}</span></span>
          <ChevronDown size={16} aria-hidden />
        </button>
      ) : (
        <div className="act-search">
          <Search size={15} aria-hidden />
          <input autoFocus={!!value} role="combobox" aria-expanded={open} aria-controls="act-list" aria-label="Choose an activity"
            placeholder="Choose an activity — type a name or WBS…" value={term}
            onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onChange={(e) => { setTerm(e.target.value); setOpen(true); setHi(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, shown.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
              else if (e.key === 'Enter' && shown[hi]) { e.preventDefault(); pick(shown[hi]); }
              else if (e.key === 'Escape') setOpen(false);
            }} />
          {value && <button className="icon-btn" aria-label="Keep the current activity" onClick={() => { setOpen(false); setTerm(''); }}><X size={14} /></button>}
        </div>
      )}
      {open && (
        <div className="act-list" id="act-list" role="listbox">
          {!flat.length ? <div className="pad muted small-text">No open activity matches “{term}”.</div> : groups.map((g) => {
            const list = g.tasks.filter((t) => shown.includes(t));
            if (!list.length) return null;
            return (
              <div key={g.label}>
                <div className="act-group">{g.label} <span className="muted">({g.tasks.length})</span></div>
                {list.map((t) => {
                  const i = shown.indexOf(t);
                  return (
                    <button key={t.id} role="option" aria-selected={value?.id === t.id} className={`act-opt${i === hi ? ' hi' : ''}`}
                      onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(t)}>
                      <span className="grow">
                        <span>{t.wbs && <span className="muted">{t.wbs} </span>}{t.name}</span>
                        <span className="small-text muted">{parents.get(t.parent_id ?? '')?.name ?? 'Top level'} · {d2(t.baseline_start ?? t.planned_start)} → {d2(t.baseline_finish ?? t.planned_finish)}</span>
                      </span>
                      <span className="small-text">{num(t.reported_pct, 0)} %</span>
                      {t.is_critical && <Badge tone="danger" label="critical" icon={null} />}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {flat.length > shown.length && <div className="pad muted small-text">{flat.length - shown.length} more — type to narrow the list.</div>}
        </div>
      )}
      {!value && !open && <Banner tone="info">Choose the activity you worked on. In-progress activities and those planned this month are listed first.</Banner>}
    </div>
  );
}
