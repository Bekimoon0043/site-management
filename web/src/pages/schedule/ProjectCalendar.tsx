// /calendar — project calendar: this month and next side by side (Ethiopian or Gregorian months), Ethiopian public
// holidays with the work / no-work decision, day edits (rain day, shutdown, overtime, half day) and the working week.
// Server: 20261105000010_project_calendar.sql (role split in its header and contract-calendar CALENDAR_ROLES).
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CalendarDays } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { calendarPref } from '../../lib/calendar';
import { date } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import {
  canCalendar, DAY_CATEGORY_LABELS, HOLIDAY_CHOICE_LABELS, type CalendarDay, type CalendarSettings, type DayKind, type HolidayDecision,
} from '../../lib/contract-calendar';
import { Banner, Card, Drawer, Empty, ErrorBanner, Field, Loading, Modal, Page, Tabs, toast, useBusy } from '../../components/ui';
import { calRpc, ethLabel, holidayName, loadCalendar, monthSpan, type MonthMode, type MonthSpan } from '../../components/calendar/data';
import { decisionBadge, HolidayPanel } from '../../components/calendar/HolidayPanel';
import { addDays, daysBetween, eatToday, isAm, isoDow } from '../../components/evm/data';
import { ETHIOPIAN_MONTHS, toEthiopian } from '../../lib/contract-control';
import '../../components/calendar/calendar.css';

const DOW_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DOW_AM = ['ሰኞ', 'ማክሰኞ', 'ረቡዕ', 'ሐሙስ', 'ዓርብ', 'ቅዳሜ', 'እሑድ'];

export function ProjectCalendar() {
  const projectId = useProjectId();
  const auth = useAuth();
  const role = auth.profile?.role;
  const lk = useLookups(projectId);
  const [sp, setSp] = useSearchParams();
  const [offset, setOffset] = useState(0);
  const [mode, setMode] = useState<MonthMode>(calendarPref().calendar === 'ethiopian' ? 'ethiopian' : 'gregorian');
  const [open, setOpen] = useState<string | null>(null);
  const [addHoliday, setAddHoliday] = useState(false);
  const today = eatToday();
  const m1 = monthSpan(today, offset, mode), m2 = monthSpan(today, offset + 1, mode);
  const q = useAsync(() => loadCalendar(projectId, m1.from, m2.to), [projectId, m1.from, m2.to], { key: 'project-calendar' });

  // Upcoming holidays get their decision rows and reminders whenever the calendar opens.
  const [synced, setSynced] = useState('');
  useEffect(() => {
    if (synced === projectId) return;
    setSynced(projectId);
    void supabase.rpc('calendar_sync', { p: { project_id: projectId } }).then(({ error }) => { if (!error) q.reload(); });
  }, [projectId, synced, q]);

  // ?decision=<id> (notification / inbox link) opens that holiday.
  const deepLink = sp.get('decision');
  useEffect(() => {
    if (!deepLink || !q.data) return;
    const d = q.data.decisions.find((x) => x.id === deepLink);
    if (d) setOpen(d.on_date);
    else void supabase.from('holiday_decisions').select('on_date').eq('id', deepLink).maybeSingle().then(({ data }) => { if (data) setOpen((data as { on_date: string }).on_date); });
    setSp((p) => { p.delete('decision'); return p; }, { replace: true });
  }, [deepLink, q.data, setSp]);

  const days = useMemo(() => new Map((q.data?.days ?? []).map((d) => [d.date, d])), [q.data]);
  const decisions = q.data?.decisions ?? [];
  const decisionById = useMemo(() => new Map(decisions.map((d) => [d.id, d])), [decisions]);
  const upcoming = decisions.filter((d) => d.days_to_go >= 0);
  const needing = upcoming.filter((d) => d.status !== 'decided' && d.days_to_go <= 30);
  const changed = () => q.reload();

  return (
    <Page title="Project calendar" subtitle="Working days, Ethiopian public holidays and site days off — the schedule follows every change"
      actions={canCalendar(role, 'holidays') ? <button onClick={() => setAddHoliday(true)}>Add public holiday</button> : undefined}>
      <div className="stack">
        <div className="cal-toolbar">
          <button className="small" aria-label="Previous month" onClick={() => setOffset(offset - 1)}><ArrowLeft size={14} aria-hidden /></button>
          <button className="small" disabled={offset === 0} onClick={() => setOffset(0)}><CalendarDays size={14} aria-hidden />This month</button>
          <button className="small" aria-label="Next month" onClick={() => setOffset(offset + 1)}><ArrowRight size={14} aria-hidden /></button>
          <Tabs variant="segmented" label="Months" value={mode} onChange={(v) => { setMode(v); setOffset(0); }}
            tabs={[{ key: 'ethiopian', label: isAm() ? 'የኢትዮጵያ ወራት' : 'Ethiopian months' }, { key: 'gregorian', label: 'Gregorian months' }]} />
          <span className="grow" />
          <div className="cal-legend" aria-hidden>
            <span><i style={{ background: 'var(--surface)' }} />Working</span>
            <span><i style={{ background: 'var(--surface-2)' }} />Not working</span>
            <span><i style={{ background: 'var(--warning-soft)', borderColor: 'var(--warning)' }} />Holiday</span>
            <span><i style={{ background: 'var(--success-soft)', borderColor: 'var(--success)' }} />Holiday — working</span>
            <span><i style={{ background: 'var(--info-soft)', borderColor: 'var(--info)' }} />Extra working day</span>
          </div>
        </div>
        <ErrorBanner error={q.error} onRetry={q.reload} />
        {needing.length > 0 && (
          <Banner tone="warn">
            {needing.length === 1 ? '1 public holiday' : `${needing.length} public holidays`} in the next 30 days need a decision:{' '}
            {needing.map((d, i) => <span key={d.id}>{i ? ', ' : ''}<a href="#" onClick={(e) => { e.preventDefault(); setOpen(d.on_date); }}>{holidayName(d)} ({date(d.on_date)})</a></span>)}.
            {canCalendar(role, 'decide') ? ' You decide.' : canCalendar(role, 'propose') ? ' Propose work or no work; the project manager decides.' : ''} Undecided = no work.
          </Banner>
        )}
        {!q.data ? <Loading lines={10} /> : !q.data.calendar ? <Empty title="This project has no calendar yet">Import a schedule or ask a coordinator to set the working week.</Empty> : (
          <div className="cal-months">
            <MonthView span={m1} mode={mode} days={days} decisions={decisionById} today={q.data.today} onOpen={setOpen} />
            <MonthView span={m2} mode={mode} days={days} decisions={decisionById} today={q.data.today} onOpen={setOpen} />
          </div>
        )}
        {q.data?.calendar && (
          <div className="cal-side">
            <Card title="Public holidays — next 4 months" sub="Ethiopian national and religious holidays. Lunar (Islamic) dates are confirmed when announced." flush>
              {upcoming.length === 0 ? <div className="card-body muted small-text">No public holidays on working days in the next 4 months.</div> : (
                <div className="cal-hol-list">
                  {upcoming.map((d) => (
                    <button key={d.id} className="cal-hol-row" onClick={() => setOpen(d.on_date)}>
                      <span><b>{date(d.on_date)}</b><br /><span className="small-text">{ethLabel(d.on_date)}</span></span>
                      <span>{holidayName(d)}{d.is_tentative ? <span className="small-text"> · tentative</span> : null}<br /><span className="small-text">in {d.days_to_go} day{d.days_to_go === 1 ? '' : 's'}</span></span>
                      {decisionBadge(d)}
                    </button>
                  ))}
                </div>
              )}
            </Card>
            <WeekCard projectId={projectId} cal={q.data.calendar} onChanged={changed} />
          </div>
        )}
      </div>
      {open && <DayDrawer key={open} projectId={projectId} on={open} onClose={() => setOpen(null)} onChanged={changed} L={lk.data} />}
      {addHoliday && <AddHolidayModal onClose={() => setAddHoliday(false)} onDone={() => { setAddHoliday(false); changed(); }} />}
    </Page>
  );
}

function MonthView({ span, mode, days, decisions, today, onOpen }: {
  span: MonthSpan; mode: MonthMode; days: Map<string, CalendarDay>; decisions: Map<string, HolidayDecision>; today: string; onOpen: (d: string) => void;
}) {
  const am = isAm();
  const lead = isoDow(span.from) - 1;
  const n = daysBetween(span.from, span.to) + 1;
  const ethShort = (d: string) => { const e = toEthiopian(d); return `${ETHIOPIAN_MONTHS[am ? 'am' : 'en'][e.month - 1].slice(0, am ? 3 : 4)} ${e.day}`; };
  const gregShort = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return (
    <section className="cal-month" aria-label={span.title}>
      <div className="cal-month-head"><h2>{span.title}</h2><span className="muted">{span.sub}</span></div>
      <div className="cal-grid" role="grid">
        {(am ? DOW_AM : DOW_EN).map((w) => <div key={w} className="cal-dow" role="columnheader">{w}</div>)}
        {Array.from({ length: lead }, (_, i) => <div key={`b${i}`} className="cal-day blank" aria-hidden />)}
        {Array.from({ length: n }, (_, i) => {
          const d = addDays(span.from, i);
          const day = days.get(d);
          const dec = day?.decision_id ? decisions.get(day.decision_id) : undefined;
          const x = day?.exception;
          const weekendDefault = day && (day.isodow === 7);
          const cls = ['cal-day',
            day && !day.working ? 'off' : '',
            day?.holiday ? 'hol' : '',
            day?.holiday && day.working ? 'work' : '',
            day && day.working && day.capacity < 1 && day.capacity > 0 ? 'half' : '',
            x?.is_working && !day?.holiday && (weekendDefault || x.category === 'overtime') ? 'extra' : '',
            x?.category === 'rain' ? 'rain' : '',
            d === today ? 'today' : '',
            dec && dec.status !== 'decided' ? 'pending' : '',
          ].filter(Boolean).join(' ');
          const primary = mode === 'ethiopian' ? String(day?.eth_d ?? toEthiopian(d).day) : String(Number(d.slice(8)));
          const label = day?.holiday ? holidayName(day.holiday) : x?.name ?? '';
          const chip = dec ? (dec.status === 'decided' ? HOLIDAY_CHOICE_LABELS[dec.decision!] : dec.status === 'proposed' ? 'Proposed' : 'Decide?')
            : x && !day?.holiday ? (x.category ? DAY_CATEGORY_LABELS[x.category] : x.is_working ? 'Working' : 'Off') : '';
          return (
            <button key={d} className={cls} onClick={() => onOpen(d)}
              aria-label={`${date(d)}, ${ethLabel(d)}${label ? `, ${label}` : ''}, ${day?.working ? 'working day' : 'not a working day'}`}>
              <span className="top"><span className="n">{primary}</span><span className="alt">{mode === 'ethiopian' ? gregShort(d) : ethShort(d)}</span></span>
              {label && <span className="lbl">{label}</span>}
              {chip && chip !== label && <span className="chip">{chip}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function DayDrawer({ projectId, on, onClose, onChanged, L }: { projectId: string; on: string; onClose: () => void; onChanged: () => void; L?: ReturnType<typeof useLookups>['data'] }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const q = useAsync(() => loadCalendar(projectId, on, on), [projectId, on], { key: 'project-calendar-day' });
  const day = q.data?.days[0];
  const dec = day?.decision_id ? q.data?.decisions.find((d) => d.id === day.decision_id) : undefined;
  const done = () => { q.reload(); onChanged(); };
  const dow = new Date(`${on}T00:00:00Z`).toLocaleString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  return (
    <Drawer title={date(on)} subtitle={`${dow} · ${ethLabel(on)}`} onClose={onClose}>
      {!day ? (q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={4} />) : (
        <div className="stack">
          <p className="mb-0">
            {day.working ? (day.capacity < 1 ? <b>Working — {Math.round(day.capacity * 100)} % of a day</b> : <b>Working day</b>) : <b>Not a working day</b>}
            {day.exception?.name && !day.holiday ? ` · ${day.exception.name}` : ''}
            {day.exception?.note ? <span className="muted"> — “{day.exception.note}”</span> : null}
          </p>
          {dec ? <HolidayPanel d={dec} L={L} onChanged={done} />
            : day.holiday ? <Banner tone="info">{holidayName(day.holiday)} falls on a day the site does not normally work, so no decision is needed.{canCalendar(role, 'decide') ? ' You can still make it a working day below.' : ''}</Banner>
            : null}
          {!dec && (!day.holiday || canCalendar(role, 'decide')) && canCalendar(role, 'editDays') && <DayEditForm projectId={projectId} day={day} onDone={done} />}
          {!dec && !canCalendar(role, 'editDays') && <p className="muted small-text mb-0">The office engineer, coordinator or project manager changes calendar days.</p>}
        </div>
      )}
    </Drawer>
  );
}

const KINDS: { key: DayKind; label: string; hint: string }[] = [
  { key: 'normal', label: 'Normal', hint: 'Follow the working week' },
  { key: 'non_working', label: 'No work', hint: 'Rain, shutdown, other' },
  { key: 'working', label: 'Working day', hint: 'Overtime / extra day' },
  { key: 'half_day', label: 'Half day', hint: 'Half the usual output' },
];

function DayEditForm({ projectId, day, onDone }: { projectId: string; day: CalendarDay; onDone: () => void }) {
  const x = day.exception;
  const [kind, setKind] = useState<DayKind>(!x ? 'normal' : !x.is_working ? 'non_working' : x.factor != null && x.factor < 1 ? 'half_day' : 'working');
  const [category, setCategory] = useState<'rain' | 'shutdown' | 'other'>(x?.category === 'rain' || x?.category === 'shutdown' ? x.category : 'other');
  const [name, setName] = useState(x?.name ?? '');
  const [note, setNote] = useState(x?.note ?? '');
  const [until, setUntil] = useState('');
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    const last = until && until > day.date ? until : day.date;
    const n = daysBetween(day.date, last) + 1;
    if (n > 366) throw new Error('Pick at most 366 days');
    const dates = Array.from({ length: n }, (_, i) => addDays(day.date, i));
    const r = await calRpc('edit_calendar_days', { project_id: projectId, dates, kind, category: kind === 'non_working' ? category : undefined,
      name: kind === 'normal' ? undefined : name || undefined, note: note || undefined });
    const moved = Number(r.moved ?? 0);
    toast.success(`${n === 1 ? date(day.date) : `${n} days`} saved${moved ? ` · ${moved} task${moved === 1 ? '' : 's'} re-dated` : ''}`);
    onDone();
  });
  return (
    <div className="stack">
      <h3 className="mb-0">Change this day</h3>
      <ErrorBanner error={error} />
      <div className="cal-kinds" role="radiogroup" aria-label="Day type">
        {KINDS.map((k) => (
          <label key={k.key} className={`choice-card${kind === k.key ? ' active' : ''}`}>
            <span className="row" style={{ gap: 6 }}><input type="radio" name="day-kind" checked={kind === k.key} onChange={() => setKind(k.key)} /><strong>{k.label}</strong></span>
            <span className="muted">{k.hint}</span>
          </label>
        ))}
      </div>
      {kind === 'non_working' && (
        <Field label="Reason">
          <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
            <option value="rain">Rain day</option><option value="shutdown">Site shutdown (client, authority, strike…)</option><option value="other">Other</option>
          </select>
        </Field>
      )}
      {kind !== 'normal' && <Field label="Name shown on the calendar"><input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'non_working' ? DAY_CATEGORY_LABELS[category] : kind === 'working' ? 'Overtime working day' : 'Half day'} /></Field>}
      <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <Field label="Apply until (optional)" hint="Same change for every day up to this date"><input type="date" min={day.date} value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
      <div className="row"><button className="primary" disabled={busy} onClick={save}>{busy && <span className="spinner" />}Save</button></div>
      <p className="muted small-text mb-0">Not-started tasks over the changed days are re-planned and the forecast is updated.</p>
    </div>
  );
}

function WeekCard({ projectId, cal, onChanged }: { projectId: string; cal: CalendarSettings; onChanged: () => void }) {
  const auth = useAuth();
  const edit = canCalendar(auth.profile?.role, 'week');
  const [wd, setWd] = useState<number[]>(cal.working_weekdays);
  const [sat, setSat] = useState(String(cal.saturday_factor));
  const [hours, setHours] = useState(String(cal.hours_per_day));
  const [hol, setHol] = useState(cal.use_public_holidays);
  const { busy, error, run } = useBusy();
  const dirty = wd.join() !== cal.working_weekdays.join() || Number(sat) !== Number(cal.saturday_factor) || Number(hours) !== Number(cal.hours_per_day) || hol !== cal.use_public_holidays;
  const save = () => void run(async () => {
    const r = await calRpc('save_project_calendar', { project_id: projectId, working_weekdays: wd, saturday_factor: Number(sat), hours_per_day: Number(hours), use_public_holidays: hol });
    toast.success(`Working week saved${Number(r.moved ?? 0) ? ` · ${String(r.moved)} tasks re-dated` : ''}`);
    onChanged();
  });
  return (
    <Card title="Working week" sub={`${cal.name}${cal.source === 'msp_import' ? ' (from MS Project)' : ''}`}>
      <ErrorBanner error={error} />
      <fieldset disabled={!edit || busy} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="cal-week">
          {DOW_EN.map((w, i) => (
            <label key={w}><input type="checkbox" checked={wd.includes(i + 1)} onChange={(e) => setWd(e.target.checked ? [...wd, i + 1].sort() : wd.filter((x) => x !== i + 1))} />{w}</label>
          ))}
        </div>
        <div className="form-grid">
          <Field label="Saturday output" hint="1 = full day, 0.5 = half day"><input type="number" min={0} max={1} step={0.05} value={sat} onChange={(e) => setSat(e.target.value)} /></Field>
          <Field label="Hours per day"><input type="number" min={1} max={24} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
        </div>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={hol} onChange={(e) => setHol(e.target.checked)} />Ethiopian public holidays are days off unless decided otherwise</label>
      </fieldset>
      {edit ? <div className="row mt-2"><button className="primary" disabled={busy || !dirty || !wd.length} onClick={save}>{busy && <span className="spinner" />}Save working week</button></div>
        : <p className="muted small-text mb-0">Coordinators and the project manager set the working week.</p>}
    </Card>
  );
}

function AddHolidayModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [on, setOn] = useState('');
  const [name, setName] = useState('');
  const [nameAm, setNameAm] = useState('');
  const [kind, setKind] = useState<'national' | 'religious_orthodox' | 'religious_muslim' | 'other'>('national');
  const [tentative, setTentative] = useState(false);
  const [years, setYears] = useState({ from: String(new Date().getFullYear() + 10), to: String(new Date().getFullYear() + 12) });
  const { busy, error, run } = useBusy();
  return (
    <Modal title="Public holidays" onClose={onClose}
      footer={<><button onClick={onClose}>Close</button><button className="primary" disabled={busy || !on || !name.trim()} onClick={() => void run(async () => {
        await calRpc('save_public_holiday', { on_date: on, name: name.trim(), name_am: nameAm || undefined, kind, is_tentative: tentative });
        toast.success(`${name.trim()} added for every project`);
        onDone();
      })}>{busy && <span className="spinner" />}Add holiday</button></>}>
      <ErrorBanner error={error} />
      <p className="small-text muted">For a newly declared national holiday. Every project's calendar treats it as a day off until its manager decides otherwise.</p>
      <div className="form-grid">
        <Field label="Date" required><input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
        <Field label="Kind"><select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="national">National</option><option value="religious_orthodox">Orthodox</option><option value="religious_muslim">Muslim</option><option value="other">Other</option>
        </select></Field>
        <Field label="Name (English)" required><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Name (Amharic)"><input value={nameAm} onChange={(e) => setNameAm(e.target.value)} lang="am" /></Field>
        <Field label="Date not yet confirmed" check><input type="checkbox" checked={tentative} onChange={(e) => setTentative(e.target.checked)} /></Field>
      </div>
      <h3>Holidays for more years</h3>
      <p className="small-text muted">Holidays are generated up to 2035. Add later years when needed (lunar dates are tentative).</p>
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="From year"><input type="number" value={years.from} onChange={(e) => setYears({ ...years, from: e.target.value })} style={{ width: 100 }} /></Field>
        <Field label="To year"><input type="number" value={years.to} onChange={(e) => setYears({ ...years, to: e.target.value })} style={{ width: 100 }} /></Field>
        <button disabled={busy} onClick={() => void run(async () => {
          const r = await calRpc('generate_public_holidays', { from_year: Number(years.from), to_year: Number(years.to) });
          toast.success(`${String(r.added)} holidays added`);
        })}>Generate</button>
      </div>
    </Modal>
  );
}
