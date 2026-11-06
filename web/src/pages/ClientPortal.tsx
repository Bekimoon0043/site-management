import { useMemo, useState } from 'react';
import { Download, Image as ImageIcon, ShieldCheck } from 'lucide-react';
import { useAuth, useProjectId } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { check, fetchAll, supabase } from '../lib/supabase';
import { date, dateTime, humanize, money, num } from '../lib/format';
import { useUrlFilters } from '../lib/url';
import type { EvmBand, ProgressOverview } from '../lib/contract-schedule';
import { Badge, Banner, Bar, Card, DataTable, Empty, ErrorBanner, Kpi, Loading, Page, Tabs, useHashTab } from '../components/ui';
import { ClientProgressChart, ClientProgressPrintChart, type ClientProgressPoint } from '../components/client/ClientProgressChart';

interface ClientSchedule {
  id: string; project_id: string; code: string; name: string; status: string;
  planned_start: string | null; planned_finish: string | null; status_date: string | null;
  fc_finish: string | null; es_finish: string | null;
}

interface ClientTask {
  task_no: number; id: string; project_id: string; schedule_id: string; wbs: string | null;
  outline_level: number; parent_id: string | null; name: string; is_summary: boolean; is_milestone: boolean;
  planned_start: string | null; planned_finish: string | null; baseline_start: string | null; baseline_finish: string | null;
  forecast_start: string | null; forecast_finish: string | null; actual_start: string | null; actual_finish: string | null;
  duration_days: number | null; pct_complete: number; is_critical: boolean; total_float_days: number | null;
}

interface ClientRollup {
  project_id: string; block_code: string | null; level_code: string | null;
  elements: number; completed: number; avg_progress_pct: number; delayed: number;
}

interface ClientEvm {
  project_id: string; schedule_id: string; status_date: string | null; contract_value: number;
  pct_planned: number | null; pct_earned: number | null; spi: number | null; spi_status: EvmBand | null;
  spi_t: number | null; sv_t_days: number | null; forecast_finish: string | null; baseline_finish: string | null;
  late_tasks: number; critical_tasks: number; planned_value: number; earned_value: number;
  schedule_variance_value: number; schedule_variance_points: number;
}

interface ClientFinance {
  project_id: string; contract_no: string | null; original_contract_value: number; approved_variations: number;
  approved_variation_count: number; current_contract_value: number; certified_to_date: number;
  total_payable: number; total_paid: number; payment_outstanding: number;
  latest_ipc_no: number | null; latest_certificate_date: string | null;
}

interface ClientDailyUpdate {
  id: string; project_id: string; number: string; diary_date: string; block_code: string | null;
  weather_am: string | null; weather_pm: string | null; rain_hours: number | null;
  temp_min: number | null; temp_max: number | null; work_summary: string | null;
  status: 'submitted' | 'signed'; activities: number; delay_events: number; hours_lost: number;
}

interface ClientPhoto {
  id: string; project_id: string; storage_path: string; mime_type: string; caption: string; tag: string | null;
  block_id: string | null; block_code: string | null; level_id: string | null; level_code: string | null;
  captured_at: string | null; client_approved_at: string; approved_by_role: string | null; url?: string | null;
}

interface ClientRisk {
  id: string; project_id: string; number: string; kind: 'risk' | 'issue'; category: string; summary: string;
  mitigation: string | null; rating: 'watch' | 'attention' | 'critical'; status: 'open' | 'occurred' | 'closed';
  review_by: string | null; updated_at: string; client_approved_at: string | null; approved_by_role: string | null;
}

interface ClientVariation {
  id: string; project_id: string; number: string; title: string; instruction_ref: string | null; instruction_date: string | null;
  amount: number; client_ref: string | null; decided_at: string; completion_date_impact_days: number | null; revised_completion_date: string | null;
  approved_by_role: string | null;
}

interface ClientMilestone {
  milestone_no: number; id: string; project_id: string; schedule_id: string; name: string; wbs: string | null;
  baseline_date: string | null; forecast_date: string | null; variance_days: number | null; is_critical: boolean;
  actual_finish: string | null; recovery_action: string | null; client_recovery_updated_at: string | null; recovery_updated_by_role: string | null;
}

interface ClientPublicationStatus {
  project_id: string; schedule_id: string; last_updated: string | null; verified_through: string | null;
}

type Health = 'on_track' | 'attention' | 'critical';
const HEALTH: Record<Health, { label: string; text: string }> = {
  on_track: { label: 'On track', text: 'Progress is broadly following the approved plan.' },
  attention: { label: 'Needs attention', text: 'Some delay or milestone pressure needs active follow-up.' },
  critical: { label: 'Critical', text: 'The current programme has a significant delay or critical milestone exposure.' },
};
const CLIENT_TABS = ['overview', 'progress', 'milestones', 'commercial', 'updates', 'programme'] as const;
type ClientTab = (typeof CLIENT_TABS)[number];

const taskStatus = (t: ClientTask) => Number(t.pct_complete) >= 100 || t.actual_finish
  ? 'completed' : Number(t.pct_complete) > 0 || t.actual_start ? 'in_progress' : 'not_started';

function spiLabel(band: EvmBand | null, spi: number | null) {
  if (spi == null) return 'No baseline';
  if (band === 'critical') return 'Significantly behind';
  if (band === 'warning') return 'Behind plan';
  if (band === 'info') return 'Ahead of plan';
  return 'On track';
}

function healthMessage(evm: ClientEvm | null, project: ProgressOverview | null) {
  if (!evm && !project) return 'The first verified progress update has not been published yet.';
  const done = Number(evm?.pct_earned ?? project?.pct_earned ?? 0);
  const planned = Number(evm?.pct_planned ?? project?.pct_planned ?? 0);
  const gap = done - planned;
  const pace = evm?.spi ?? project?.spi;
  if (pace == null) return `${num(done, 1)}% of the project is verified complete. A baseline comparison is not available yet.`;
  if (gap < -0.5) return `${num(done, 1)}% is complete versus ${num(planned, 1)}% planned. The project is ${num(Math.abs(gap), 1)} percentage points behind plan.`;
  if (gap > 0.5) return `${num(done, 1)}% is complete versus ${num(planned, 1)}% planned. The project is ${num(gap, 1)} percentage points ahead of plan.`;
  return `${num(done, 1)}% is complete versus ${num(planned, 1)}% planned. Progress is broadly on plan.`;
}

const daysBetween = (a: string | null, b: string | null) => a && b ? Math.round((Date.parse(a) - Date.parse(b)) / 86400000) : null;
const approvalLabel = (role: string | null | undefined) => role ? `Approved by ${humanize(role)}` : 'Approved for client viewing';

function CompactEmpty({ children }: { children: React.ReactNode }) {
  return <div className="client-compact-empty">{children}</div>;
}

function OptionalError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (!error) return null;
  return <div className="client-optional-error"><span>This optional section is temporarily unavailable.</span><button className="small" onClick={onRetry}>Try again</button></div>;
}
const signedClientPhotos = async (rows: ClientPhoto[]) => {
  if (!rows.length) return rows;
  const { data, error } = await supabase.storage.from('attachments').createSignedUrls(rows.map((r) => r.storage_path), 3600);
  if (error) throw new Error(error.message);
  const urls = new Map((data ?? []).map((r) => [r.path, r.signedUrl]));
  return rows.map((r) => ({ ...r, url: urls.get(r.storage_path) ?? null }));
};

/**
 * External client view. Every query targets a narrow database view created for
 * client accounts; it never reads operational, procurement, people or cost tables.
 */
export function ClientPortal() {
  const auth = useAuth();
  const projectId = useProjectId();
  const currency = auth.project?.currency ?? 'ETB';
  const [f, setF] = useUrlFilters({ s: '' });
  const [tab, setTab] = useHashTab<ClientTab>(CLIENT_TABS, 'overview');
  const [grain, setGrain] = useState<'day' | 'week'>('week');
  const [reportKind, setReportKind] = useState<'weekly' | 'monthly'>('weekly');
  const [reportGeneratedAt, setReportGeneratedAt] = useState('');
  const schedulesQ = useAsync(async () => check(await supabase.from('v_client_schedules').select('*')
    .eq('project_id', projectId).order('code')) as ClientSchedule[], [projectId], { key: 'client-schedules' });
  const schedule = schedulesQ.data?.find((s) => s.id === f.s) ?? schedulesQ.data?.[0];

  const overviewQ = useAsync(async () => fetchAll<ProgressOverview>((a, b) => supabase.from('v_client_progress_overview').select('*')
    .eq('schedule_id', schedule?.id ?? '').order('wbs', { nullsFirst: true }).range(a, b)),
  [schedule?.id], { key: 'client-progress-overview', enabled: !!schedule });
  const tasksQ = useAsync(async () => fetchAll<ClientTask>((a, b) => supabase.from('v_client_schedule_tasks').select('*')
    .eq('schedule_id', schedule?.id ?? '').order('task_no').range(a, b)),
  [schedule?.id], { key: 'client-schedule-tasks', enabled: !!schedule });
  const rollupQ = useAsync(async () => fetchAll<ClientRollup>((a, b) => supabase.from('v_client_progress_rollup').select('*')
    .eq('project_id', projectId).order('block_code').order('level_code').range(a, b)),
  [projectId], { key: 'client-progress-rollup' });
  const evmQ = useAsync(async () => check(await supabase.from('v_client_dashboard_evm').select('*')
    .eq('schedule_id', schedule?.id ?? '').maybeSingle()) as ClientEvm | null,
  [schedule?.id], { key: 'client-dashboard-evm', enabled: !!schedule });
  const financeQ = useAsync(async () => check(await supabase.from('v_client_financial_summary').select('*')
    .eq('project_id', projectId).maybeSingle()) as ClientFinance | null,
  [projectId], { key: 'client-financial-summary' });
  const dailyQ = useAsync(async () => check(await supabase.from('v_client_daily_updates').select('*')
    .eq('project_id', projectId).order('diary_date', { ascending: false }).limit(14)) as ClientDailyUpdate[],
  [projectId], { key: 'client-daily-updates' });
  const historyQ = useAsync(async () => {
    const value = check(await supabase.rpc('client_progress_history', {
      p_schedule: schedule?.id ?? '', p_grain: grain, p_points: grain === 'day' ? 31 : 27,
    })) as ClientProgressPoint[] | ClientProgressPoint | null;
    return Array.isArray(value) ? value : value ? [value] : [];
  }, [schedule?.id, grain], { key: `client-progress-history-${grain}`, enabled: !!schedule });
  const photosQ = useAsync(async () => {
    const rows = check(await supabase.from('v_client_photos').select('*').eq('project_id', projectId)
      .order('captured_at', { ascending: false, nullsFirst: false }).limit(12)) as ClientPhoto[];
    return signedClientPhotos(rows);
  }, [projectId], { key: 'client-photos' });
  const risksQ = useAsync(async () => check(await supabase.from('v_client_risks').select('*').eq('project_id', projectId)
    .neq('status', 'closed').order('updated_at', { ascending: false })) as ClientRisk[], [projectId], { key: 'client-risks' });
  const variationsQ = useAsync(async () => check(await supabase.from('v_client_variations').select('*').eq('project_id', projectId)
    .order('decided_at', { ascending: false })) as ClientVariation[], [projectId], { key: 'client-variations' });
  const milestonesQ = useAsync(async () => check(await supabase.from('v_client_milestones').select('*')
    .eq('schedule_id', schedule?.id ?? '').is('actual_finish', null).order('forecast_date').limit(12)) as ClientMilestone[],
  [schedule?.id], { key: 'client-milestones', enabled: !!schedule });
  const publicationQ = useAsync(async () => check(await supabase.from('v_client_publication_status').select('*')
    .eq('schedule_id', schedule?.id ?? '').maybeSingle()) as ClientPublicationStatus | null,
  [schedule?.id], { key: 'client-publication-status', enabled: !!schedule });

  const project = overviewQ.data?.find((r) => r.level === 'project') ?? null;
  const evm = evmQ.data ?? null;
  const finance = financeQ.data ?? null;
  const latestDaily = dailyQ.data?.[0] ?? null;
  const wbs = (overviewQ.data ?? []).filter((r) => r.level === 'wbs');
  const milestones = useMemo(() => milestonesQ.data ?? [], [milestonesQ.data]);
  const rollup = useMemo(() => {
    const out = new Map<string, { block: string; elements: number; completed: number; delayed: number; weighted: number }>();
    for (const r of rollupQ.data ?? []) {
      const block = r.block_code ?? 'Unassigned';
      const cur = out.get(block) ?? { block, elements: 0, completed: 0, delayed: 0, weighted: 0 };
      cur.elements += Number(r.elements); cur.completed += Number(r.completed); cur.delayed += Number(r.delayed);
      cur.weighted += Number(r.avg_progress_pct) * Number(r.elements);
      out.set(block, cur);
    }
    return [...out.values()].map((r) => ({ ...r, progress: r.elements ? r.weighted / r.elements : 0 }));
  }, [rollupQ.data]);

  const health = useMemo<Health>(() => {
    const band = evm?.spi_status ?? project?.spi_status;
    const gap = Number(evm?.pct_earned ?? project?.pct_earned ?? 0) - Number(evm?.pct_planned ?? project?.pct_planned ?? 0);
    const milestoneSlip = milestones.some((m) => Number(m.variance_days ?? 0) > 14 && m.is_critical);
    if (band === 'critical' || gap <= -10 || milestoneSlip) return 'critical';
    if (band === 'warning' || gap <= -2 || milestones.some((m) => Number(m.variance_days ?? 0) > 0)) return 'attention';
    return 'on_track';
  }, [evm, project, milestones]);
  const changes = useMemo(() => {
    const rows = historyQ.data ?? [];
    const now = rows.at(-1), before = rows.at(-2);
    const since = before?.period_end ?? '';
    const out: string[] = [];
    if (now && before) {
      const delta = Number(now.pct_verified ?? 0) - Number(before.pct_verified ?? 0);
      out.push(`Verified work ${delta >= 0 ? 'increased' : 'changed'} by ${num(Math.abs(delta), 1)} percentage points to ${num(now.pct_verified, 1)}%.`);
      const finishDelta = daysBetween(now.forecast_finish, before.forecast_finish);
      if (finishDelta) out.push(`The expected completion date moved ${Math.abs(finishDelta)} day${Math.abs(finishDelta) === 1 ? '' : 's'} ${finishDelta > 0 ? 'later' : 'earlier'}.`);
    }
    const newPhotos = (photosQ.data ?? []).filter((p) => !since || p.client_approved_at >= since).length;
    const newVariations = (variationsQ.data ?? []).filter((v) => !since || v.decided_at >= since).length;
    const changedRisks = (risksQ.data ?? []).filter((r) => !since || r.updated_at >= since).length;
    if (newPhotos) out.push(`${newPhotos} new approved progress photo${newPhotos === 1 ? '' : 's'} published.`);
    if (newVariations) out.push(`${newVariations} approved variation${newVariations === 1 ? '' : 's'} added to the client position.`);
    if (changedRisks) out.push(`${changedRisks} client-visible risk${changedRisks === 1 ? '' : 's'} updated.`);
    return out.length ? out : ['No material client-facing change has been published since the previous update.'];
  }, [historyQ.data, photosQ.data, variationsQ.data, risksQ.data]);
  const reportHistory = useMemo(() => {
    const rows = historyQ.data ?? [];
    const days = reportKind === 'weekly' ? 7 : 31;
    const cutoff = Date.parse(rows.at(-1)?.period_end ?? '') - days * 86400000;
    return rows.filter((r) => Date.parse(r.period_end) >= cutoff);
  }, [historyQ.data, reportKind]);
  const printReport = (kind: 'weekly' | 'monthly') => {
    setReportKind(kind);
    setReportGeneratedAt(new Date().toISOString());
    window.setTimeout(() => window.print(), 80);
  };

  const coreError = overviewQ.error ?? evmQ.error;
  const optionalErrorCount = [tasksQ.error, rollupQ.error, financeQ.error, dailyQ.error, historyQ.error, photosQ.error,
    risksQ.error, variationsQ.error, milestonesQ.error, publicationQ.error].filter(Boolean).length;
  if (!schedulesQ.data && !schedulesQ.error) return <Page title="Client portal"><Loading lines={8} /></Page>;
  if (schedulesQ.error) return <Page title="Client portal"><ErrorBanner error={schedulesQ.error} onRetry={schedulesQ.reload} /></Page>;
  if (schedulesQ.data && !schedulesQ.data.length) return <Page title="Client portal"><Empty title="No published schedule">A project schedule has not been made available yet.</Empty></Page>;

  return (
    <Page title="Client portal" width="dash"
      subtitle={schedule ? `${schedule.code} · ${schedule.name}${schedule.status_date ? ` · status date ${date(schedule.status_date)}` : ''}` : undefined}
      actions={<div className="row client-report-actions">
        <button onClick={() => printReport('weekly')}><Download size={14} aria-hidden />Weekly PDF</button>
        <button onClick={() => printReport('monthly')}><Download size={14} aria-hidden />Monthly PDF</button>
        {(schedulesQ.data?.length ?? 0) > 1 && <select aria-label="Schedule" value={schedule?.id ?? ''} onChange={(e) => setF('s', e.target.value)}>
          {schedulesQ.data!.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
        </select>}
      </div>}>
      <div className="client-portal-live">
        <ErrorBanner error={coreError} onRetry={() => { overviewQ.reload(); evmQ.reload(); }} />
        {optionalErrorCount > 0 && <div className="client-supporting-warning">The main progress summary is available. {optionalErrorCount} supporting section{optionalErrorCount === 1 ? ' is' : 's are'} temporarily unavailable.</div>}

        <section className={`client-health ${health}`} aria-label={`Project status: ${HEALTH[health].label}`}>
          <div className="client-health-light" aria-hidden />
          <div><div className="client-health-label">{HEALTH[health].label}</div><div>{HEALTH[health].text}</div></div>
          <div className="client-health-times"><span>Last published <strong>{dateTime(publicationQ.data?.last_updated) || 'Not available'}</strong></span><span><ShieldCheck size={13} aria-hidden /> Progress verified through <strong>{date(publicationQ.data?.verified_through) || date(schedule?.status_date) || 'Not available'}</strong></span></div>
        </section>

        <Tabs label="Client dashboard sections" value={tab} onChange={setTab} tabs={[
          { key: 'overview', label: 'Overview' }, { key: 'progress', label: 'Progress' },
          { key: 'milestones', label: 'Milestones', count: milestones.length || undefined, hot: milestones.some((m) => Number(m.variance_days ?? 0) > 0) },
          { key: 'commercial', label: 'Commercial' }, { key: 'updates', label: 'Updates & photos', count: photosQ.data?.length || undefined },
          { key: 'programme', label: 'Detailed programme' },
        ]} />

        {tab === 'overview' && <div className="stack client-tab-panel">
          <Banner tone={health === 'critical' ? 'warn' : 'info'}>
            {healthMessage(evm, project)}{(evm?.forecast_finish ?? project?.forecast_finish) && <> Current expected completion: <strong>{date(evm?.forecast_finish ?? project?.forecast_finish)}</strong>.</>}
          </Banner>
          <div className="kpis client-primary-kpis">
            <Kpi label="Verified complete" value={num(evm?.pct_earned ?? project?.pct_earned ?? 0, 1)} unit="%" hint="Work checked and accepted in the progress system" />
            <Kpi label="Planned by now" value={num(evm?.pct_planned ?? project?.pct_planned ?? 0, 1)} unit="%" hint={project?.status_date ? `Approved plan at ${date(project.status_date)}` : 'Approved programme position'} />
            <Kpi label="Schedule position" value={spiLabel(evm?.spi_status ?? project?.spi_status ?? null, evm?.spi ?? project?.spi ?? null)} hint={(evm?.spi ?? project?.spi) == null ? 'Comparison starts after a baseline is published' : `Technical schedule index: ${num(evm?.spi ?? project?.spi, 2)}`}
              status={health === 'critical' ? 'danger' : health === 'attention' ? 'warning' : 'ok'} />
            <Kpi label="Expected completion" value={date(evm?.forecast_finish ?? project?.forecast_finish) || 'Not available'} hint={project?.late_tasks ? `${project.late_tasks} late activities are being monitored` : 'No late activities reported'} status={project?.late_tasks ? 'warning' : 'ok'} />
          </div>
          <div className="dash-grid">
            <Card title="Progress trend" sub="The solid line is verified work; the dotted line is the approved plan"
              actions={<div className="row"><button className={grain === 'day' ? 'primary small' : 'small'} onClick={() => setGrain('day')}>Daily</button><button className={grain === 'week' ? 'primary small' : 'small'} onClick={() => setGrain('week')}>Weekly</button></div>}>
              <OptionalError error={historyQ.error} onRetry={historyQ.reload} />
              {!historyQ.data ? <Loading lines={5} /> : historyQ.data.length < 2 ? <CompactEmpty>A progress trend will appear after at least two verified reporting dates.</CompactEmpty> : <ClientProgressChart rows={historyQ.data} />}
            </Card>
            <Card title="What changed" sub={`Compared with the previous ${grain === 'day' ? 'daily' : 'weekly'} reporting point`}>
              <ul className="client-change-list">{changes.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </Card>
          </div>
          {(latestDaily || (photosQ.data?.length ?? 0) > 0) ? <div className="dash-grid">
            {latestDaily && <Card title="Latest approved site update" sub={`${date(latestDaily.diary_date)} · ${latestDaily.number}`}>
              <p>{latestDaily.work_summary || 'No public work summary was entered.'}</p>
              <p className="muted small-text">{latestDaily.activities} activities reported{latestDaily.delay_events ? ` · ${latestDaily.delay_events} delay event(s) · ${num(latestDaily.hours_lost, 1)} hours reported lost` : ' · no delay event reported'}.</p>
            </Card>}
            {(photosQ.data?.length ?? 0) > 0 && <Card title="Latest approved photos" sub="Reviewed for client viewing">
              <div className="client-photo-grid compact">{photosQ.data!.slice(0, 3).map((p) => <a key={p.id} className="client-photo" href={p.url ?? undefined} target="_blank" rel="noreferrer">{p.url ? <img src={p.url} alt={p.caption} /> : <div className="client-photo-empty"><ImageIcon aria-hidden /></div>}<span><strong>{p.caption}</strong><small>{date(p.captured_at)} · {approvalLabel(p.approved_by_role)}</small></span></a>)}</div>
            </Card>}
          </div> : <CompactEmpty>No client-facing site update or progress photos have been published yet. Verified progress figures above remain available.</CompactEmpty>}
          <details className="client-method-details"><summary>How are these figures calculated?</summary>
            <div className="dash-grid"><p><strong>Planned by now</strong> is the share of approved work scheduled by the reporting date. <strong>Verified complete</strong> is work checked and accepted in the progress system; it is not cash paid.</p><p><strong>Schedule position</strong> uses the technical SPI measure. 1.00 means progress matches the plan; below 1.00 is slower and above 1.00 is faster. The detailed index is shown only as supporting information.</p></div>
          </details>
        </div>}

        {tab === 'progress' && <div className="stack client-tab-panel">
          <Card title="Planned versus verified progress" sub="Switch between the last 31 daily points and 27 weekly points" actions={<div className="row"><button className={grain === 'day' ? 'primary small' : 'small'} onClick={() => setGrain('day')}>Daily</button><button className={grain === 'week' ? 'primary small' : 'small'} onClick={() => setGrain('week')}>Weekly</button></div>}>
            <OptionalError error={historyQ.error} onRetry={historyQ.reload} />{historyQ.data && historyQ.data.length >= 2 ? <ClientProgressChart rows={historyQ.data} /> : <CompactEmpty>At least two verified reporting dates are needed for a trend.</CompactEmpty>}
          </Card>
          <div className="dash-grid">
            <Card title="Progress by work section" sub="Verified physical progress compared with the approved plan"><DataTable rows={wbs} rowKey={(r) => r.task_id ?? r.wbs ?? r.name} loading={!overviewQ.data} maxHeight="520px" exportName="client-progress-by-wbs" columns={[
              { key: 'name', label: 'Work section', id: true, value: (r) => `${r.wbs ?? ''} ${r.name}`, render: (r) => <><span className="muted">{r.wbs} </span>{r.name}</> },
              { key: 'planned', label: 'Planned', align: 'right', value: (r) => r.pct_planned, render: (r) => `${num(r.pct_planned, 1)}%` },
              { key: 'done', label: 'Verified', value: (r) => r.pct_earned, render: (r) => <Bar pct={Number(r.pct_earned ?? 0)} /> },
              { key: 'late', label: 'Late activities', align: 'right', value: (r) => r.late_tasks, render: (r) => r.late_tasks ? <span className="danger-text strong">{r.late_tasks}</span> : '0' },
              { key: 'forecast', label: 'Expected finish', render: (r) => date(r.forecast_finish) },
            ]} empty="No work-section progress has been published." /></Card>
            <Card title="Progress by block" sub="Verified element progress only"><OptionalError error={rollupQ.error} onRetry={rollupQ.reload} /><DataTable rows={rollup} rowKey={(r) => r.block} loading={!rollupQ.data} maxHeight="520px" exportName="client-progress-by-block" columns={[
              { key: 'block', label: 'Block', id: true }, { key: 'elements', label: 'Elements', align: 'right' }, { key: 'completed', label: 'Completed', align: 'right' },
              { key: 'delayed', label: 'Delayed', align: 'right', render: (r) => r.delayed ? <span className="danger-text strong">{r.delayed}</span> : '0' }, { key: 'progress', label: 'Verified', render: (r) => <Bar pct={r.progress} /> },
            ]} empty="No block-level progress has been published." /></Card>
          </div>
        </div>}

        {tab === 'milestones' && <div className="stack client-tab-panel"><OptionalError error={milestonesQ.error} onRetry={milestonesQ.reload} />
          {!milestonesQ.data ? <Loading lines={5} /> : !milestones.length ? <CompactEmpty>No unfinished milestones are currently published.</CompactEmpty> : <Card title="Upcoming milestones" sub="Approved dates, current expected dates and published recovery actions"><DataTable rows={milestones} rowKey={(r) => r.id} columns={[
            { key: 'name', label: 'Milestone', id: true }, { key: 'planned', label: 'Approved date', value: (r) => r.baseline_date, render: (r) => date(r.baseline_date) },
            { key: 'forecast', label: 'Expected date', value: (r) => r.forecast_date, render: (r) => date(r.forecast_date) },
            { key: 'variance', label: 'Position', value: (r) => Number(r.variance_days ?? 0), render: (r) => r.variance_days == null || r.variance_days === 0 ? 'On date' : <span className={r.variance_days > 0 ? 'danger-text strong' : 'success-text strong'}>{Math.abs(r.variance_days)} days {r.variance_days > 0 ? 'behind' : 'ahead'}</span> },
            { key: 'recovery', label: 'Recovery / protection action', value: (r) => r.recovery_action ?? '', render: (r) => <div>{r.recovery_action || <span className="muted">No action published</span>}{r.recovery_action && <div className="xs-text muted">{approvalLabel(r.recovery_updated_by_role)} · {date(r.client_recovery_updated_at)}</div>}</div> },
          ]} /></Card>}
        </div>}

        {tab === 'commercial' && <div className="stack client-tab-panel"><OptionalError error={financeQ.error} onRetry={financeQ.reload} />
          <Card title="Client commercial position" sub="Contract, certified work and recorded payments only; contractor internal costs are excluded">
            {!finance ? <CompactEmpty>No client contract figures have been published.</CompactEmpty> : <div className="kpis"><Kpi compact label="Current contract value" value={money(finance.current_contract_value, currency)} hint={`Original ${money(finance.original_contract_value, currency)} · approved changes ${money(finance.approved_variations, currency)}`} /><Kpi compact label="Work certified" value={money(finance.certified_to_date, currency)} hint={finance.latest_ipc_no ? `Latest IPC ${finance.latest_ipc_no} · ${date(finance.latest_certificate_date)}` : 'No certificate published'} /><Kpi compact label="Payments recorded" value={money(finance.total_paid, currency)} hint={`Total certified payable ${money(finance.total_payable, currency)}`} /><Kpi compact label="Certified but unpaid" value={money(finance.payment_outstanding, currency)} hint="Certified payable less recorded payments" status={finance.payment_outstanding > 0 ? 'warning' : 'ok'} /></div>}
          </Card>
          <OptionalError error={variationsQ.error} onRetry={variationsQ.reload} />
          {!variationsQ.data ? <Loading lines={3} /> : !variationsQ.data.length ? <CompactEmpty>No approved variations have been published. The current contract value above remains the client reference.</CompactEmpty> : <Card title="Approved variations" sub="Changes already approved and included in the client position"><DataTable rows={variationsQ.data} rowKey={(r) => r.id} columns={[
            { key: 'number', label: 'Variation', id: true }, { key: 'title', label: 'Approved change' }, { key: 'amount', label: 'Contract effect', align: 'right', value: (r) => Number(r.amount), render: (r) => money(r.amount, currency) },
            { key: 'time', label: 'Completion effect', value: (r) => r.completion_date_impact_days ?? 0, render: (r) => r.revised_completion_date ? `${date(r.revised_completion_date)}${r.completion_date_impact_days != null ? ` (${r.completion_date_impact_days >= 0 ? '+' : ''}${r.completion_date_impact_days} days)` : ''}` : r.completion_date_impact_days != null ? `${r.completion_date_impact_days >= 0 ? '+' : ''}${r.completion_date_impact_days} days` : 'No date effect recorded' },
            { key: 'approved', label: 'Verification', render: (r) => approvalLabel(r.approved_by_role) },
          ]} /></Card>}
        </div>}

        {tab === 'updates' && <div className="stack client-tab-panel">
          <div className="dash-grid"><Card title="Published site updates" sub="Submitted or signed daily summaries"><OptionalError error={dailyQ.error} onRetry={dailyQ.reload} />
            {!dailyQ.data ? <Loading lines={4} /> : !dailyQ.data.length ? <CompactEmpty>No client-facing daily update has been published yet. This does not mean no work was performed.</CompactEmpty> : <DataTable rows={dailyQ.data} rowKey={(r) => r.id} columns={[
              { key: 'date', label: 'Date', id: true, value: (r) => r.diary_date, render: (r) => date(r.diary_date) }, { key: 'summary', label: 'Published summary', value: (r) => r.work_summary ?? '', render: (r) => r.work_summary || 'No summary entered' },
              { key: 'activities', label: 'Activities', align: 'right' }, { key: 'delays', label: 'Reported delay', render: (r) => r.delay_events ? `${r.delay_events} event(s) · ${num(r.hours_lost, 1)} hours` : 'None reported' },
            ]} />}</Card>
            <Card title="Client-safe risks and issues" sub="Only summaries approved for external viewing"><OptionalError error={risksQ.error} onRetry={risksQ.reload} />
              {!risksQ.data ? <Loading lines={4} /> : !risksQ.data.length ? <CompactEmpty>No client-visible risks are currently open. This means none are published here; it is not a guarantee that the project has no risk.</CompactEmpty> : <DataTable rows={risksQ.data} rowKey={(r) => r.id} columns={[
                { key: 'summary', label: 'Risk / issue', id: true }, { key: 'rating', label: 'Attention', render: (r) => <Badge tone={r.rating === 'critical' ? 'danger' : r.rating === 'attention' ? 'warning' : 'neutral'} label={r.rating === 'attention' ? 'Needs attention' : humanize(r.rating)} icon={null} /> },
                { key: 'mitigation', label: 'Action', render: (r) => <div>{r.mitigation || 'Monitoring'}<div className="xs-text muted">{approvalLabel(r.approved_by_role)}{r.client_approved_at ? ` · ${date(r.client_approved_at)}` : ''}</div></div> },
              ]} />}</Card></div>
          <Card title="Approved progress photos" sub="Only reviewed photos approved for client viewing"><OptionalError error={photosQ.error} onRetry={photosQ.reload} />
            {!photosQ.data ? <Loading lines={4} /> : !photosQ.data.length ? <CompactEmpty>No progress photos have been approved for client viewing yet.</CompactEmpty> : <div className="client-photo-grid">{photosQ.data.map((p) => <a key={p.id} className="client-photo" href={p.url ?? undefined} target="_blank" rel="noreferrer">{p.url ? <img src={p.url} alt={p.caption} loading="lazy" /> : <div className="client-photo-empty"><ImageIcon aria-hidden /></div>}<span><strong>{p.caption}</strong><small>{[p.block_code, p.level_code, date(p.captured_at), p.tag && humanize(p.tag)].filter(Boolean).join(' · ')}</small><small>{approvalLabel(p.approved_by_role)} · {date(p.client_approved_at)}</small></span></a>)}</div>}
          </Card>
        </div>}

        {tab === 'programme' && <div className="stack client-tab-panel"><OptionalError error={tasksQ.error} onRetry={tasksQ.reload} />
          <Banner tone="info">This is the detailed programme for readers who need activity-level information. Task ID is a simple 1-N row number; WBS shows where each activity sits in the project structure.</Banner>
          <Card title="Detailed programme" sub={`${tasksQ.data?.length ?? 0} published rows`}><DataTable rows={tasksQ.data ?? []} rowKey={(r) => r.id} loading={!tasksQ.data} maxHeight="680px" exportName="client-programme" stickyFirst columns={[
            { key: 'task_no', label: 'Task ID', id: true, align: 'right' }, { key: 'wbs', label: 'WBS' }, { key: 'name', label: 'Activity', render: (r) => <span className={r.is_summary ? 'strong' : ''} style={{ paddingLeft: Math.max(0, r.outline_level - 1) * 14 }}>{r.is_milestone ? '◆ ' : ''}{r.name}</span> },
            { key: 'status', label: 'Status', value: taskStatus, render: (r) => r.is_summary ? null : <Badge value={taskStatus(r)} /> }, { key: 'finish', label: 'Approved finish', value: (r) => r.baseline_finish ?? r.planned_finish, render: (r) => date(r.baseline_finish ?? r.planned_finish) },
            { key: 'forecast', label: 'Expected finish', value: (r) => r.forecast_finish, render: (r) => date(r.forecast_finish) }, { key: 'progress', label: 'Verified', value: (r) => Number(r.pct_complete), render: (r) => <Bar pct={Number(r.pct_complete)} /> },
            { key: 'critical', label: 'Attention', value: (r) => r.is_critical ? 'Critical' : '', render: (r) => r.is_critical ? <Badge tone="danger" label="Critical" /> : null },
          ]} empty="No programme activities have been published." /></Card>
        </div>}

        <p className="muted small-text client-privacy-note">Read-only client view. It contains verified progress and approved client-facing information only. Contractor internal costs, supplier rates, payroll, procurement, internal notes, staff details and workflow records are excluded.</p>
      </div>

      <section className="client-report print-only print-doc">
        <header className="client-report-head">
          <div><strong>{auth.project?.name ?? 'Project'}</strong><span>{reportKind === 'weekly' ? 'Weekly' : 'Monthly'} client progress report</span></div>
          <div className={`client-report-status ${health}`}>{HEALTH[health].label}</div>
        </header>
        <div className="client-report-meta">
          <span>Programme: <strong>{schedule?.code} · {schedule?.name}</strong></span>
          <span>Report generated: <strong>{dateTime(reportGeneratedAt || publicationQ.data?.last_updated) || '—'}</strong></span>
          <span>Progress verified through: <strong>{date(publicationQ.data?.verified_through) || date(schedule?.status_date) || '—'}</strong></span>
          <span>Last published update: <strong>{dateTime(publicationQ.data?.last_updated) || '—'}</strong></span>
        </div>
        <div className="client-report-kpis">
          <div><span>Verified complete</span><strong>{num(evm?.pct_earned ?? project?.pct_earned ?? 0, 1)}%</strong></div>
          <div><span>Planned by now</span><strong>{num(evm?.pct_planned ?? project?.pct_planned ?? 0, 1)}%</strong></div>
          <div><span>Schedule position</span><strong>{spiLabel(evm?.spi_status ?? project?.spi_status ?? null, evm?.spi ?? project?.spi ?? null)}</strong><small>{(evm?.spi ?? project?.spi) == null ? 'Baseline comparison unavailable' : `Technical index ${num(evm?.spi ?? project?.spi, 2)}`}</small></div>
          <div><span>Expected finish</span><strong>{date(evm?.forecast_finish ?? project?.forecast_finish) || '—'}</strong></div>
        </div>
        <h2>Progress trend</h2>
        <ClientProgressPrintChart rows={reportHistory.length >= 2 ? reportHistory : historyQ.data ?? []} />
        <div className="client-report-cols">
          <div><h2>What changed</h2><ul>{changes.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
          <div><h2>Latest site update</h2><p><strong>{date(latestDaily?.diary_date) || 'No update'}</strong></p><p>{latestDaily?.work_summary || 'No public site update has been published.'}</p></div>
        </div>
        <h2>Upcoming milestones</h2>
        <table><thead><tr><th>Milestone</th><th>Approved</th><th>Expected</th><th>Variance</th><th>Recovery / protection action</th></tr></thead><tbody>
          {!milestones.length && <tr><td colSpan={5}>No unfinished milestones are currently published.</td></tr>}
          {milestones.slice(0, 8).map((m) => <tr key={m.id}><td>{m.name}</td><td>{date(m.baseline_date)}</td><td>{date(m.forecast_date)}</td><td>{m.variance_days == null || m.variance_days === 0 ? 'On date' : `${Math.abs(m.variance_days)} days ${m.variance_days > 0 ? 'behind' : 'ahead'}`}</td><td>{m.recovery_action || 'No action published'}{m.recovery_action && <small> · {approvalLabel(m.recovery_updated_by_role)}</small>}</td></tr>)}
        </tbody></table>
        <div className="client-report-cols">
          <div><h2>Approved variations</h2>{!(variationsQ.data?.length) ? <p>No approved variations have been published.</p> : <ul>{variationsQ.data.slice(0, 6).map((v) => <li key={v.id}><strong>{v.number}</strong> {v.title}: {money(v.amount, currency)}{v.revised_completion_date ? ` · completion ${date(v.revised_completion_date)}` : ''} · {approvalLabel(v.approved_by_role)}</li>)}</ul>}</div>
          <div><h2>Client-visible risks</h2>{!(risksQ.data?.length) ? <p>No client-visible risks are currently published; this is not a guarantee that the project has no risk.</p> : <ul>{risksQ.data.slice(0, 6).map((r) => <li key={r.id}><strong>{r.rating === 'attention' ? 'Needs attention' : humanize(r.rating)}:</strong> {r.summary}{r.mitigation ? ` — ${r.mitigation}` : ''} · {approvalLabel(r.approved_by_role)}</li>)}</ul>}</div>
        </div>
        {!!photosQ.data?.length && <><h2>Approved progress photos</h2><div className="client-report-photos">{photosQ.data.slice(0, 4).map((p) => <figure key={p.id}>{p.url && <img src={p.url} alt={p.caption} />}<figcaption>{p.caption}<br /><span>{date(p.captured_at)}</span></figcaption></figure>)}</div></>}
        <footer>Client-facing report. Contractor internal costs, supplier rates, payroll, procurement and internal notes are excluded.</footer>
      </section>
    </Page>
  );
}
