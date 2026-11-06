import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CalendarDays, Check, ChevronLeft, ChevronRight, List, Pencil, Plus, Printer, Trash2 } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { calendarPref } from '../../lib/calendar';
import { toEthiopian } from '../../lib/contract-control';
import {
  DELAY_CAUSE_LABELS, WEATHER_OPTIONS, canField, type DelayCause, type EquipmentStatus, type Weather, type DiaryActivityRow, type DiaryAddendum, type DiaryDelay, type DiaryElement, type DiaryEquipment,
  type DiaryInstruction, type DiaryLabour, type DiarySummary, type DiaryVisitor, type SiteDiary,
} from '../../lib/contract-field';
import { rpcRead, rpcx, uuid } from '../../lib/fieldx';
import { date, dateTime, humanize, num, today, since } from '../../lib/format';
import { pushRecent } from '../../lib/prefs';
import { useUrlFilters } from '../../lib/url';
import type { DiaryActivity } from '../../lib/contract-schedule';
import { outputText } from '../../components/schedule/data';
import { Attachments } from '../../components/Attachments';
import { SBadge } from '../../components/field/StatusBadge';
import {
  Banner, Card, DataTable, Empty, ErrorBanner, Field, FilterBar, FilterSelect, Loading, Modal, Page, PrintHeader, ReasonModal, Signatures, Tabs, toast, useBusy,
} from '../../components/ui';
import '../../components/field/field.css';

type DiaryRow = Pick<SiteDiary, 'id' | 'number' | 'diary_date' | 'block_id' | 'status' | 'created_by' | 'submitted_at' | 'signed_by' | 'signed_at' | 'weather_am' | 'weather_pm' | 'rain_hours' | 'work_summary'>;

const STATUS_OPTS = [{ value: 'draft', label: 'Draft' }, { value: 'submitted', label: 'Awaiting sign-off' }, { value: 'signed', label: 'Signed' }];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Monday-first 6-week grid for a 'YYYY-MM' month. */
function monthGrid(month: string): { day: string; inMonth: boolean }[] {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return { day: iso(d), inMonth: d.getMonth() === m - 1 };
  });
}
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** Site diary register: month calendar (default) or list, per day and block (P1-6). */
export function SiteDiaries() {
  const projectId = useProjectId();
  const auth = useAuth();
  const nav = useNavigate();
  const lk = useLookups(projectId);
  const [f, setF, { active, clear }] = useUrlFilters({ view: 'calendar', month: today().slice(0, 7), block: '', status: '' });
  const q = useAsync(() => fetchAll<DiaryRow>((a, b) => supabase.from('site_diaries')
    .select('id, number, diary_date, block_id, status, created_by, submitted_at, signed_by, signed_at, weather_am, weather_pm, rain_hours, work_summary')
    .eq('project_id', projectId).order('diary_date', { ascending: false }).range(a, b)), [projectId], { key: 'site-diaries' });
  const L = lk.data;
  const rows = useMemo(() => (q.data ?? []).filter((r) => (!f.block || (f.block === 'site' ? !r.block_id : r.block_id === f.block)) && (!f.status || r.status === f.status)),
    [q.data, f.block, f.status]);
  const byDay = useMemo(() => {
    const m = new Map<string, DiaryRow[]>();
    for (const r of rows) m.set(r.diary_date, [...(m.get(r.diary_date) ?? []), r]);
    return m;
  }, [rows]);
  const awaiting = (q.data ?? []).filter((r) => r.status === 'submitted').length;
  const view = f.view === 'list' ? 'list' : 'calendar';
  const filterActive = active - (f.view !== 'calendar' ? 1 : 0) - (f.month !== today().slice(0, 7) ? 1 : 0);
  const eth = calendarPref().calendar === 'ethiopian';
  const t = today();
  const [y, m] = f.month.split('-').map(Number);
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  return (
    <Page title="Site diary" subtitle="Daily site reports per day and block — weather, labour, equipment, delays and the day's documents"
      actions={<Tabs variant="segmented" label="View" value={view} onChange={(v) => setF('view', v)}
        tabs={[{ key: 'calendar', label: <><CalendarDays size={14} aria-hidden /> Calendar</> }, { key: 'list', label: <><List size={14} aria-hidden /> List</> }]} />}>
      {awaiting > 0 && canField(auth.profile?.role, 'diary.sign') && (
        <Banner tone="attention" action={<button className="small" onClick={() => setF('status', 'submitted')}>Show</button>}>
          {awaiting} diar{awaiting === 1 ? 'y is' : 'ies are'} waiting for sign-off.
        </Banner>
      )}
      <ErrorBanner error={q.error ?? lk.error} onRetry={q.reload} />
      <FilterBar active={filterActive} onClear={() => { clear(); setF('view', view); }}
        right={view === 'calendar' && (
          <div className="cal-nav">
            <button className="icon-btn" aria-label="Previous month" onClick={() => setF('month', shiftMonth(f.month, -1))}><ChevronLeft size={16} /></button>
            <span className="title">{monthLabel}</span>
            <button className="icon-btn" aria-label="Next month" onClick={() => setF('month', shiftMonth(f.month, 1))}><ChevronRight size={16} /></button>
            <button className="small" onClick={() => setF('month', t.slice(0, 7))}>Today</button>
          </div>
        )}>
        <FilterSelect label="Block" value={f.block} onChange={(v) => setF('block', v)} options={[{ value: 'site', label: 'Whole site' }, ...(L?.blocks ?? []).map((b) => ({ value: b.id, label: b.code }))]} />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={STATUS_OPTS} />
      </FilterBar>

      {view === 'calendar' ? (
        !q.data || !L ? <Loading lines={8} /> : (
          <div className="cal-grid" role="grid" aria-label={`Diaries in ${monthLabel}`}>
            {WEEKDAYS.map((w) => <div key={w} className="cal-head" role="columnheader">{w}</div>)}
            {monthGrid(f.month).map(({ day, inMonth }) => {
              const list = byDay.get(day) ?? [];
              const e = eth ? toEthiopian(day) : null;
              return (
                <div key={day} role="gridcell" className={`cal-day${inMonth ? '' : ' out'}${day === t ? ' today' : ''}`}>
                  <div className="cal-num"><span>{Number(day.slice(8))}</span>{e && <span className="eth">{e.day}/{e.month}</span>}</div>
                  {list.map((r) => (
                    <button key={r.id} className="cal-entry" title={`${r.number} · ${humanize(r.status)}`} onClick={() => nav(`/diary/${r.id}`)}>
                      <SBadge value={r.status} label={r.block_id ? L.block(r.block_id) : 'Site'} />
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )
      ) : (
        <DataTable rows={rows} loading={!q.data || !L} error={q.error} onRetry={q.reload} urlKey="" stickyFirst exportName="site-diaries"
          filtered={filterActive > 0} onClearFilters={clear} onRowClick={(r) => nav(`/diary/${r.id}`)} viewKey="site-diaries"
          empty={{ title: 'No site diaries yet', body: 'Diaries written on site (mobile app) appear here for review and sign-off.' }}
          columns={[
            { key: 'number', label: 'Diary', id: true },
            { key: 'diary_date', label: 'Date', value: (r) => r.diary_date, render: (r) => date(r.diary_date) },
            { key: 'block', label: 'Block', value: (r) => (r.block_id ? L?.block(r.block_id) : 'Whole site') },
            { key: 'status', label: 'Status', render: (r) => <SBadge value={r.status} label={r.status === 'submitted' ? 'Awaiting sign-off' : undefined} /> },
            { key: 'weather', label: 'Weather', value: (r) => [r.weather_am, r.weather_pm].filter(Boolean).map((w) => humanize(w)).join(' / ') },
            { key: 'rain_hours', label: 'Rain', align: 'right', render: (r) => (r.rain_hours ? <>{num(r.rain_hours, 1)}<span className="unit">h</span></> : '') },
            { key: 'created_by', label: 'Author', value: (r) => L?.person(r.created_by) },
            { key: 'signed_by', label: 'Signed by', value: (r) => (r.signed_by ? `${L?.person(r.signed_by)} · ${date(r.signed_at)}` : '') },
            { key: 'work_summary', label: 'Work summary', hidden: true },
          ]} />
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------

interface DiaryDetailData {
  d: SiteDiary;
  labour: (DiaryLabour & { labour_trades: { name: string } | null })[];
  equipment: DiaryEquipment[]; delays: DiaryDelay[]; visitors: DiaryVisitor[]; instructions: DiaryInstruction[]; elements: DiaryElement[];
  addenda: DiaryAddendum[]; summary: DiarySummary;
  activities: (DiaryActivity & { schedule_tasks: { wbs: string | null; name: string } | null; task_progress: { status: string } | null })[];
}

async function loadDiary(id: string): Promise<DiaryDetailData> {
  const d = check(await supabase.from('site_diaries').select('*').eq('id', id).single()) as SiteDiary;
  const child = <T,>(t: string, sel = '*') => supabase.from(t).select(sel).eq('diary_id', id).is('deleted_at', null).then(check) as unknown as Promise<T[]>;
  const [labour, equipment, delays, visitors, instructions, elements, addenda, summary, activities] = await Promise.all([
    child<DiaryDetailData['labour'][number]>('diary_labour', '*, labour_trades(name)'),
    child<DiaryEquipment>('diary_equipment'), child<DiaryDelay>('diary_delays'), child<DiaryVisitor>('diary_visitors'),
    child<DiaryInstruction>('diary_instructions'), child<DiaryElement>('diary_elements'),
    supabase.from('diary_addenda').select('*').eq('diary_id', id).order('created_at').then(check) as Promise<DiaryAddendum[]>,
    rpcRead<DiarySummary>('get_diary_summary', { project_id: d.project_id, diary_date: d.diary_date, ...(d.block_id ? { block_id: d.block_id } : {}) }),
    supabase.from('diary_activities').select('*, schedule_tasks(wbs, name), task_progress(status)').eq('diary_id', id).is('deleted_at', null)
      .order('created_at').then(check) as unknown as Promise<DiaryDetailData['activities']>,
  ]);
  return { d, labour, equipment, delays, visitors, instructions, elements, addenda, summary: summary ?? {}, activities };
}

const KIND_LABEL: Record<DiaryActivityRow['kind'], string> = {
  progress: 'Progress reported', pour: 'Concrete pours', inspection: 'Inspections', snag: 'Snags raised', grn: 'Materials received (GRN)', miv: 'Materials issued (MIV)',
};
const kindLink = (k: DiaryActivityRow['kind'], id: string) => ({
  grn: `/store?open=${id}#grn`, miv: `/store?open=${id}#miv`, progress: '/progress#verify', pour: `/concrete/pours/${id}`,
  inspection: `/quality/inspections/${id}`, snag: `/quality?peek=${id}#snags`,
}[k]);

/** Diary detail: sections, auto day summary, sign-off, addenda; prints as an A4 daily report. */
export function SiteDiaryDetail() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const fromInbox = params.get('from') === 'approvals';
  const nav = useNavigate();
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const q = useAsync(() => loadDiary(id), [id], { key: 'diary-detail' });
  const [dialog, setDialog] = useState<'return' | 'addendum' | 'edit' | null>(null);
  const { busy, error, run } = useBusy();

  useEffect(() => { if (q.data) pushRecent({ label: q.data.d.number, hint: 'Site diary', to: `/diary/${id}` }); }, [q.data, id]);

  if (!q.data || !lk.data) {
    return <Page title="Site diary" breadcrumbs={[{ label: 'Site diary', to: '/diary' }, { label: '…' }]}>{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={8} />}</Page>;
  }
  const { d, labour, equipment, delays, visitors, instructions, elements, addenda, summary, activities } = q.data;
  const L = lk.data;
  const role = auth.profile?.role;
  const me = auth.profile?.id;
  const isAuthor = d.created_by === me;
  const canSign = canField(role, 'diary.sign') && d.status === 'submitted' && (!isAuthor || role === 'admin');
  const canAddendum = canField(role, 'diary.write') && d.status !== 'draft';
  // save_site_diary: the author, or office engineer / coordinator / manager / admin; signed diaries take addenda instead.
  const canEdit = canField(role, 'diary.write') && d.status !== 'signed' && (isAuthor || ['office_engineer', 'coordinator', 'manager', 'admin'].includes(role ?? ''));
  const done = (msg: string) => {
    toast.success(msg);
    if (fromInbox) nav('/approvals?type=diary');
  };
  const sign = () => run(async () => { await rpcx('sign_site_diary', { diary_id: d.id, approve: true }); done(`${d.number} signed`); });
  const headcount = labour.reduce((s, l) => s + Number(l.headcount), 0);
  const hoursLost = delays.reduce((s, l) => s + Number(l.hours_lost ?? 0), 0);
  const kinds = (Object.keys(KIND_LABEL) as DiaryActivityRow['kind'][]).filter((k) => summary[k]?.length);

  return (
    <Page width="form" title={d.number} titleExtra={<SBadge value={d.status} label={d.status === 'submitted' ? 'Awaiting sign-off' : undefined} />}
      breadcrumbs={[{ label: 'Site diary', to: '/diary' }, { label: d.number }]}
      subtitle={<>{date(d.diary_date)} · {d.block_id ? `Block ${L.block(d.block_id)}` : 'Whole site'} · by {L.person(d.created_by)}{d.submitted_at ? ` · submitted ${dateTime(d.submitted_at)}` : ''}</>}
      actions={<>
        <button onClick={() => window.print()}><Printer size={14} aria-hidden />Print</button>
        {canEdit && <button className={d.status === 'draft' ? 'primary' : undefined} onClick={() => setDialog('edit')}><Pencil size={14} aria-hidden />{d.status === 'draft' ? 'Complete & submit…' : 'Edit…'}</button>}
        {canAddendum && <button onClick={() => setDialog('addendum')}><Plus size={14} aria-hidden />Addendum…</button>}
        {canSign && <button disabled={busy} onClick={() => setDialog('return')}>Return…</button>}
        {canSign && <button className="primary" disabled={busy} onClick={() => void sign()}>{busy && <span className="spinner" />}<Check size={14} aria-hidden />Sign diary</button>}
      </>}>
      <div className="print-doc">
        <PrintHeader title={`Daily site report ${d.number} — ${date(d.diary_date)}`} />
        <ErrorBanner error={error} />
        {d.status === 'submitted' && isAuthor && role !== 'admin' && <Banner tone="info">Waiting for an office engineer or coordinator to sign — authors can't sign their own diary.</Banner>}
        {d.sign_comment && <Banner tone={d.status === 'draft' ? 'warn' : 'info'}>{d.status === 'draft' ? 'Returned for correction' : 'Sign-off comment'}: “{d.sign_comment}”</Banner>}
        <div className="detail-layout mt-3">
          <div className="stack">
            <Card title="Weather">
              <dl className="kv">
                <dt>Morning</dt><dd>{humanize(d.weather_am) || '—'}</dd>
                <dt>Afternoon</dt><dd>{humanize(d.weather_pm) || '—'}</dd>
                <dt>Rain</dt><dd>{d.rain_hours !== null ? `${num(d.rain_hours, 1)} h` : '—'}</dd>
                <dt>Temperature</dt><dd>{d.temp_min !== null || d.temp_max !== null ? `${num(d.temp_min, 1) || '?'}–${num(d.temp_max, 1) || '?'} °C` : '—'}</dd>
              </dl>
            </Card>
            <Card title="Work done">
              <p className="mb-0" style={{ whiteSpace: 'pre-wrap' }}>{d.work_summary || <span className="muted">No summary written.</span>}</p>
            </Card>
            <Card title="Daily output" sub={`${activities.length} activit${activities.length === 1 ? 'y' : 'ies'} from Daily progress · ${activities.reduce((n, a) => n + Number(a.headcount ?? 0), 0)} people`} flush
              actions={canField(role, 'diary.write') ? <Link to="/daily-progress" className="small">Record output</Link> : undefined}>
              <DataTable rows={activities} maxHeight="none" empty="No activity output recorded for this day" columns={[
                { key: 'task', label: 'Activity', value: (a) => `${a.schedule_tasks?.wbs ?? ''} ${a.schedule_tasks?.name ?? ''}`,
                  render: (a) => <span>{a.schedule_tasks?.wbs && <span className="muted">{a.schedule_tasks.wbs} </span>}{a.schedule_tasks?.name}{a.after_signoff && <span className="muted small-text"> (added after sign-off)</span>}</span> },
                { key: 'output', label: 'Output', value: (a) => outputText(a) },
                { key: 'people', label: 'People', align: 'right', value: (a) => a.headcount ?? 0, render: (a) => (a.headcount == null ? '—' : `${a.headcount}${a.labour_hours ? ` · ${num(a.labour_hours, 1)} h` : ''}`) },
                { key: 'equipment', label: 'Equipment', value: (a) => a.equipment ?? '' },
                { key: 'remarks', label: 'Delay / remarks', value: (a) => [a.delay_cause ? DELAY_CAUSE_LABELS[a.delay_cause as keyof typeof DELAY_CAUSE_LABELS] ?? a.delay_cause : '', a.remarks ?? ''].filter(Boolean).join(' — ') },
                { key: 'status', label: 'Progress', value: (a) => a.task_progress?.status ?? '', render: (a) => <SBadge value={a.task_progress?.status ?? 'reported'} /> },
              ]} />
            </Card>
            <Card title="Day summary (automatic)" sub="Everything recorded in the system on this date for this block">
              {!kinds.length ? <Empty inline>No receipts, issues, progress, pours, inspections or snags recorded on this day.</Empty> : kinds.map((k) => (
                <div key={k} className="mt-2">
                  <h3>{KIND_LABEL[k]} <span className="muted small-text">({summary[k]!.length})</span></h3>
                  <ul className="summary-list">
                    {summary[k]!.map((it) => (
                      <li key={it.id}>
                        <Link className="no" to={kindLink(k, it.id)}>{it.number}</Link>
                        <span className="grow">{it.summary}</span>
                        <SBadge value={it.status} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </Card>
            <Card title="Labour" sub={`${headcount} people`} flush>
              <DataTable rows={labour} maxHeight="none" empty="No labour recorded" columns={[
                { key: 'trade', label: 'Trade', value: (r) => r.labour_trades?.name ?? r.trade_name },
                { key: 'subcontractor', label: 'Own / subcontractor', value: (r) => r.subcontractor || 'Own' },
                { key: 'headcount', label: 'Headcount', align: 'right' },
                { key: 'hours', label: 'Hours', align: 'right', render: (r) => num(r.hours, 1) },
              ]} />
            </Card>
            <Card title="Equipment" flush>
              <DataTable rows={equipment} maxHeight="none" empty="No equipment recorded" columns={[
                { key: 'equipment', label: 'Equipment' },
                { key: 'qty', label: 'Qty', align: 'right' },
                { key: 'hours_worked', label: 'Worked', align: 'right', render: (r) => num(r.hours_worked, 1) },
                { key: 'hours_idle', label: 'Idle', align: 'right', render: (r) => num(r.hours_idle, 1) },
                { key: 'status', label: 'Status', render: (r) => <SBadge value={r.status === 'breakdown' ? 'rejected' : r.status === 'idle' ? 'pending' : 'active'} label={humanize(r.status)} /> },
                { key: 'idle_reason', label: 'Idle reason / note', value: (r) => [r.idle_reason, r.note].filter(Boolean).join(' · ') },
              ]} />
            </Card>
            <Card title="Delays & issues" sub={hoursLost ? `${num(hoursLost, 1)} h lost` : undefined} flush>
              <DataTable rows={delays} maxHeight="none" empty="No delays recorded" columns={[
                { key: 'cause', label: 'Cause', value: (r) => DELAY_CAUSE_LABELS[r.cause] ?? humanize(r.cause) },
                { key: 'hours_lost', label: 'Hours lost', align: 'right', render: (r) => num(r.hours_lost, 1) },
                { key: 'element', label: 'Element', value: (r) => L.element(r.element_id) },
                { key: 'description', label: 'Description' },
              ]} />
            </Card>
            <Card title="Visitors & instructions" flush>
              <DataTable rows={visitors} maxHeight="none" empty="No visitors recorded" columns={[
                { key: 'name', label: 'Visitor' }, { key: 'organisation', label: 'Organisation' }, { key: 'purpose', label: 'Purpose' },
                { key: 'time', label: 'Time', value: (r) => [r.time_in, r.time_out].filter(Boolean).map((x) => String(x).slice(0, 5)).join('–') },
              ]} />
              {instructions.length > 0 && (
                <DataTable rows={instructions} maxHeight="none" columns={[
                  { key: 'instruction', label: 'Instruction' }, { key: 'given_by', label: 'Given by', value: (r) => [r.given_by, r.organisation].filter(Boolean).join(', ') },
                  { key: 'element', label: 'Element', value: (r) => L.element(r.element_id) },
                ]} />
              )}
            </Card>
            {(d.safety_notes || d.notes) && (
              <Card title="Safety & notes">
                <dl className="kv"><dt>Safety</dt><dd>{d.safety_notes || '—'}</dd><dt>Notes</dt><dd>{d.notes || '—'}</dd></dl>
              </Card>
            )}
          </div>
          <div className="side-panel">
            <Card title="Details">
              <dl className="kv">
                <dt>Date</dt><dd>{date(d.diary_date)}</dd>
                <dt>Block</dt><dd>{d.block_id ? L.block(d.block_id) : 'Whole site'}</dd>
                <dt>Author</dt><dd>{L.person(d.created_by)}</dd>
                <dt>Signed</dt><dd>{d.signed_by ? `${L.person(d.signed_by)} · ${dateTime(d.signed_at)}` : '—'}</dd>
                <dt>Elements</dt><dd>{elements.length ? elements.map((e) => L.element(e.element_id)).join(', ') : '—'}</dd>
                <dt>Version</dt><dd>{d.version}</dd>
              </dl>
            </Card>
            <Card title="Addenda" sub="Later changes to a submitted or signed diary">
              {!addenda.length ? <Empty inline>No addenda.</Empty> : (
                <ul className="timeline">
                  {addenda.map((a) => (
                    <li key={a.id}>
                      <div className="t-comment" style={{ whiteSpace: 'pre-wrap' }}>{a.text}</div>
                      <div className="t-meta">{L.person(a.created_by)} · <span title={dateTime(a.created_at)}>{since(a.created_at)}</span></div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Photos"><Attachments entityType="site_diary" entityId={d.id} canAdd={canField(role, 'diary.write')} kinds={['photo', 'diary', 'document']} tags={['progress', 'issue', 'other']} /></Card>
          </div>
        </div>
        <Signatures />
      </div>
      {dialog === 'return' && <ReasonModal title={`Return ${d.number}`} label="What needs correcting?" confirm="Return to author" onClose={() => setDialog(null)}
        onSubmit={async (c) => { await rpcx('sign_site_diary', { diary_id: d.id, approve: false, comment: c }); done(`${d.number} returned`); }} />}
      {dialog === 'addendum' && <AddendumModal diaryId={d.id} number={d.number} onClose={() => setDialog(null)} />}
      {dialog === 'edit' && <DiaryEditModal data={q.data} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); q.reload(); }} />}
    </Page>
  );
}

function AddendumModal({ diaryId, number, onClose }: { diaryId: string; number: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useBusy();
  const save = () => run(async () => {
    await rpcx('add_diary_addendum', { id: uuid(), diary_id: diaryId, text: text.trim() });
    toast.success(`Addendum added to ${number}`);
    onClose();
  });
  return (
    <Modal title={`Addendum to ${number}`} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !text.trim()} onClick={() => void save()}>{busy && <span className="spinner" />}Add addendum</button>
    </>}>
      <ErrorBanner error={error} />
      <Field label="Text" required hint="Addenda are permanent; the diary itself stays unchanged."><textarea data-autofocus rows={5} value={text} onChange={(e) => setText(e.target.value)} /></Field>
    </Modal>
  );
}

type LabourRow = { id: string; trade_id: string; trade_name: string; subcontractor: string; headcount: string; hours: string };
type EquipRow = { id: string; equipment: string; qty: string; hours_worked: string; hours_idle: string; status: EquipmentStatus };
type DelayRow = { id: string; cause: DelayCause | ''; hours_lost: string; description: string };
const numOrUndef = (v: string) => (v.trim() === '' ? undefined : Number(v));

/** Web editor for a draft (or submitted, which goes back to draft) diary: weather, work done, labour, equipment, delays → save_site_diary. */
function DiaryEditModal({ data, onClose, onSaved }: { data: DiaryDetailData; onClose: () => void; onSaved: () => void }) {
  const { d, labour, equipment, delays, activities } = data;
  const trades = useAsync(async () => check(await supabase.from('labour_trades').select('id, name').is('deleted_at', null).order('sort_order')) as { id: string; name: string }[],
    [], { key: 'labour-trades', staleTime: 30 * 60_000 });
  const [wAm, setWAm] = useState<string>(d.weather_am ?? '');
  const [wPm, setWPm] = useState<string>(d.weather_pm ?? '');
  const [rain, setRain] = useState(d.rain_hours == null ? '' : String(d.rain_hours));
  const [tMin, setTMin] = useState(d.temp_min == null ? '' : String(d.temp_min));
  const [tMax, setTMax] = useState(d.temp_max == null ? '' : String(d.temp_max));
  const [summary, setSummary] = useState(d.work_summary ?? '');
  const [safety, setSafety] = useState(d.safety_notes ?? '');
  const [notes, setNotes] = useState(d.notes ?? '');
  const [lab, setLab] = useState<LabourRow[]>(labour.map((l) => ({ id: l.id, trade_id: l.trade_id ?? '', trade_name: l.trade_id ? '' : l.trade_name ?? '', subcontractor: l.subcontractor ?? '', headcount: String(l.headcount), hours: l.hours == null ? '' : String(l.hours) })));
  const [eq, setEq] = useState<EquipRow[]>(equipment.map((e) => ({ id: e.id, equipment: e.equipment, qty: String(e.qty), hours_worked: e.hours_worked == null ? '' : String(e.hours_worked), hours_idle: e.hours_idle == null ? '' : String(e.hours_idle), status: e.status })));
  const [dl, setDl] = useState<DelayRow[]>(delays.map((x) => ({ id: x.id, cause: x.cause, hours_lost: x.hours_lost == null ? '' : String(x.hours_lost), description: x.description ?? '' })));
  const { busy, error, run } = useBusy();
  const outPeople = activities.reduce((n, a) => n + Number(a.headcount ?? 0), 0);
  const outHours = activities.reduce((n, a) => n + Number(a.labour_hours ?? 0), 0);

  const fillSummary = () => setSummary((cur) => [cur.trim(), ...activities.map((a) => `${a.schedule_tasks?.wbs ? `${a.schedule_tasks.wbs} ` : ''}${a.schedule_tasks?.name ?? ''}: ${outputText(a)}${a.remarks ? ` (${a.remarks})` : ''}`)].filter(Boolean).join('\n'));
  const fillLabour = () => setLab((rows) => [...rows, { id: uuid(), trade_id: '', trade_name: 'Crews from daily output', subcontractor: '', headcount: String(outPeople), hours: outHours ? String(outHours) : '' }]);
  const fillEquipment = () => setEq((rows) => [...rows, ...activities.filter((a) => a.equipment).map((a) => ({ id: uuid(), equipment: a.equipment ?? '', qty: '1', hours_worked: '', hours_idle: '', status: 'working' as const }))]);

  const save = (submit: boolean) => run(async () => {
    const p = {
      id: d.id, project_id: d.project_id, number: d.number, diary_date: d.diary_date, block_id: d.block_id,
      weather_am: (wAm || undefined) as Weather | undefined, weather_pm: (wPm || undefined) as Weather | undefined,
      rain_hours: numOrUndef(rain), temp_min: numOrUndef(tMin), temp_max: numOrUndef(tMax),
      work_summary: summary.trim() || undefined, safety_notes: safety.trim() || undefined, notes: notes.trim() || undefined, submit,
      labour: lab.filter((l) => l.headcount.trim() !== '').map((l) => ({ id: l.id, trade_id: l.trade_id || null, trade_name: l.trade_id ? undefined : l.trade_name.trim() || 'Labour',
        subcontractor: l.subcontractor.trim() || undefined, headcount: Number(l.headcount), hours: numOrUndef(l.hours) })),
      equipment: eq.filter((e) => e.equipment.trim()).map((e) => ({ id: e.id, equipment: e.equipment.trim(), qty: Number(e.qty || 1), hours_worked: numOrUndef(e.hours_worked), hours_idle: numOrUndef(e.hours_idle), status: e.status })),
      delays: dl.filter((x) => x.cause).map((x) => ({ id: x.id, cause: x.cause as DelayCause, hours_lost: numOrUndef(x.hours_lost), description: x.description.trim() || undefined })),
    };
    const r = await rpcx('save_site_diary', p);
    toast.success(submit ? `${d.number} submitted for sign-off` : `${d.number} saved (${String(r.status ?? 'draft')})`);
    onSaved();
  });

  const tradeOpts = trades.data ?? [];
  const setL = (i: number, patch: Partial<LabourRow>) => setLab(lab.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setE = (i: number, patch: Partial<EquipRow>) => setEq(eq.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setD = (i: number, patch: Partial<DelayRow>) => setDl(dl.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Modal size="lg" title={`Site diary ${d.number}`} subtitle={`${date(d.diary_date)} · complete the day and submit it for sign-off`} onClose={onClose} footer={<>
      <button onClick={onClose} disabled={busy}>Cancel</button>
      <button disabled={busy} onClick={() => void save(false)}>Save draft</button>
      <button className="primary" disabled={busy} onClick={() => void save(true)}>{busy && <span className="spinner" />}Submit for sign-off</button>
    </>}>
      <div className="stack">
        <ErrorBanner error={error ?? trades.error} />
        <div className="form-grid">
          <Field label="Weather morning" required>
            <select value={wAm} onChange={(e) => setWAm(e.target.value)}><option value="">—</option>{WEATHER_OPTIONS.map((w) => <option key={w} value={w}>{humanize(w)}</option>)}</select>
          </Field>
          <Field label="Weather afternoon">
            <select value={wPm} onChange={(e) => setWPm(e.target.value)}><option value="">—</option>{WEATHER_OPTIONS.map((w) => <option key={w} value={w}>{humanize(w)}</option>)}</select>
          </Field>
          <Field label="Rain (hours)"><input type="number" min={0} max={24} step="0.5" value={rain} onChange={(e) => setRain(e.target.value)} /></Field>
          <Field label="Temperature min (°C)"><input type="number" value={tMin} onChange={(e) => setTMin(e.target.value)} /></Field>
          <Field label="Temperature max (°C)"><input type="number" value={tMax} onChange={(e) => setTMax(e.target.value)} /></Field>
        </div>
        <Field label="Work done" wide hint={activities.length ? `${activities.length} daily output entr${activities.length === 1 ? 'y' : 'ies'} recorded for this day` : undefined}>
          <textarea rows={5} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
        {activities.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="small" onClick={fillSummary}>Add daily output to the work done</button>
            {outPeople > 0 && <button className="small" onClick={fillLabour}>Add {outPeople} people from daily output</button>}
            {activities.some((a) => a.equipment) && <button className="small" onClick={fillEquipment}>Add equipment from daily output</button>}
          </div>
        )}

        <h3 className="mb-0">Labour</h3>
        {lab.map((l, i) => (
          <div key={l.id} className="form-grid diary-edit-row">
            <Field label="Trade">
              <select value={l.trade_id} onChange={(e) => setL(i, { trade_id: e.target.value })}>
                <option value="">Other…</option>{tradeOpts.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            {!l.trade_id && <Field label="Trade name"><input value={l.trade_name} onChange={(e) => setL(i, { trade_name: e.target.value })} /></Field>}
            <Field label="Subcontractor"><input value={l.subcontractor} placeholder="Own" onChange={(e) => setL(i, { subcontractor: e.target.value })} /></Field>
            <Field label="Headcount"><input type="number" min={0} value={l.headcount} onChange={(e) => setL(i, { headcount: e.target.value })} /></Field>
            <Field label="Hours"><input type="number" min={0} step="0.5" value={l.hours} onChange={(e) => setL(i, { hours: e.target.value })} /></Field>
            <button className="icon-btn" aria-label="Remove labour row" onClick={() => setLab(lab.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
          </div>
        ))}
        <div><button className="small" onClick={() => setLab([...lab, { id: uuid(), trade_id: '', trade_name: '', subcontractor: '', headcount: '', hours: '' }])}><Plus size={14} aria-hidden />Add labour</button></div>

        <h3 className="mb-0">Equipment</h3>
        {eq.map((e, i) => (
          <div key={e.id} className="form-grid diary-edit-row">
            <Field label="Equipment"><input value={e.equipment} onChange={(ev) => setE(i, { equipment: ev.target.value })} /></Field>
            <Field label="Qty"><input type="number" min={1} value={e.qty} onChange={(ev) => setE(i, { qty: ev.target.value })} /></Field>
            <Field label="Hours worked"><input type="number" min={0} step="0.5" value={e.hours_worked} onChange={(ev) => setE(i, { hours_worked: ev.target.value })} /></Field>
            <Field label="Hours idle"><input type="number" min={0} step="0.5" value={e.hours_idle} onChange={(ev) => setE(i, { hours_idle: ev.target.value })} /></Field>
            <Field label="Status">
              <select value={e.status} onChange={(ev) => setE(i, { status: ev.target.value as EquipmentStatus })}>
                <option value="working">Working</option><option value="idle">Idle</option><option value="breakdown">Breakdown</option>
              </select>
            </Field>
            <button className="icon-btn" aria-label="Remove equipment row" onClick={() => setEq(eq.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
          </div>
        ))}
        <div><button className="small" onClick={() => setEq([...eq, { id: uuid(), equipment: '', qty: '1', hours_worked: '', hours_idle: '', status: 'working' }])}><Plus size={14} aria-hidden />Add equipment</button></div>

        <h3 className="mb-0">Delays &amp; issues</h3>
        {dl.map((x, i) => (
          <div key={x.id} className="form-grid diary-edit-row">
            <Field label="Cause">
              <select value={x.cause} onChange={(ev) => setD(i, { cause: ev.target.value as DelayCause })}>
                <option value="">—</option>{Object.entries(DELAY_CAUSE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Hours lost"><input type="number" min={0} step="0.5" value={x.hours_lost} onChange={(ev) => setD(i, { hours_lost: ev.target.value })} /></Field>
            <Field label="Description" wide><input value={x.description} onChange={(ev) => setD(i, { description: ev.target.value })} /></Field>
            <button className="icon-btn" aria-label="Remove delay row" onClick={() => setDl(dl.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
          </div>
        ))}
        <div><button className="small" onClick={() => setDl([...dl, { id: uuid(), cause: '', hours_lost: '', description: '' }])}><Plus size={14} aria-hidden />Add delay</button></div>

        <div className="form-grid">
          <Field label="Safety" wide><textarea rows={2} value={safety} onChange={(e) => setSafety(e.target.value)} /></Field>
          <Field label="Notes" wide><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}
