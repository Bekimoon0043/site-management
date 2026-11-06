import { useMemo } from 'react';
import { ChevronLeft, ChevronRight, Printer, RefreshCw, Send, WandSparkles } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { date, num } from '../../lib/format';
import { useUrlFilters, useUrlParam } from '../../lib/url';
import type { CalendarMode, LookaheadPlan, LookaheadWeek, PpcWeek } from '../../lib/contract-lookahead';
import { Badge, Banner, DataTable, Empty, ErrorBanner, FilterBar, FilterToggle, Loading, Page, SearchInput, Tabs, toast, useBusy, useHashTab } from '../../components/ui';
import { eatToday, planRead, planRpc, tr } from '../../components/evm/data';
import { MonthGrid, type Holiday } from '../../components/lookahead/MonthGrid';
import { ItemDrawer } from '../../components/lookahead/ItemDrawer';
import { LookaheadGantt } from '../../components/lookahead/LookaheadGantt';
import { MaterialNeeds } from '../../components/lookahead/MaterialNeeds';
import { WeeklyPlan } from '../../components/lookahead/WeeklyPlan';
import { Reliability } from '../../components/lookahead/Reliability';
import { ReadyBadge } from '../../components/lookahead/chips';
import { can, fromCandidate, fromPlanRow, monthKey, monthOf, monthRange, monthTitle, parseMonth, planMatches, roleLabel, shiftMonth, type LaWeek, type MonthSel } from '../../components/lookahead/la';
import '../../components/evm/evm.css';
import '../../components/lookahead/lookahead.css';

const TABS = ['plan', 'materials', 'weekly', 'reliability'] as const;
interface Preview {
  period_label: string; period_label_am: string | null; period_start: string; period_end: string; horizon_end: string; working_days: number;
  schedule_id: string | null; weeks: { week_no: number; week_start: string; week_end: string; working_days: number; in_buffer: boolean }[];
  items: Record<string, unknown>[]; plan_id: string | null;
}

/**
 * Monthly Tasks Window (spec §8.1): month calendar with task bars, readiness constraints, material needs,
 * weekly commitments + PPC. Before a plan exists the month is previewed live from the schedule.
 */
export function Lookahead() {
  const projectId = useProjectId();
  const auth = useAuth();
  const role = auth.profile?.role;
  const today = eatToday();
  const lk = useLookups(projectId);
  const settings = auth.settings as unknown as { lookahead_calendar_mode?: CalendarMode; ppc_target?: number } | null;
  const [f, setF, { active, clear }] = useUrlFilters({ m: '', mode: '', view: 'calendar', mine: '', crit: '', nr: '', q: '' });
  const [tab, setTab] = useHashTab(TABS, 'plan');
  const [peek, setPeek] = useUrlParam('peek');
  const mode: CalendarMode = f.mode === 'ethiopian' || f.mode === 'gregorian' ? f.mode : settings?.lookahead_calendar_mode ?? 'gregorian';
  const target = Number(settings?.ppc_target ?? 80);

  const plans = useAsync(async () => check(await supabase.from('lookahead_plans').select('*').eq('project_id', projectId).order('period_start', { ascending: false })) as LookaheadPlan[],
    [projectId], { key: 'la-plans' });
  const month: MonthSel = useMemo(() => {
    const p = parseMonth(f.m, mode);
    if (p) return p;
    const cur = (plans.data ?? []).find((x) => x.calendar_mode === mode && x.period_start <= today && x.period_end >= today);
    return cur ? { mode, year: cur.period_year, month: cur.period_month } : monthOf(today, mode);
  }, [f.m, mode, plans.data, today]);
  const plan = (plans.data ?? []).find((p) => planMatches(p, month)) ?? null;
  const range = monthRange(month);
  const title = monthTitle(month);

  const data = useAsync(async () => {
    if (plan) {
      const [items, weeks, ppc] = await Promise.all([
        fetchAll<Record<string, unknown>>((a, b) => supabase.from('v_monthly_lookahead').select('*').eq('plan_id', plan.id).order('sort_key').range(a, b)),
        supabase.from('lookahead_weeks').select('*').eq('plan_id', plan.id).order('week_start').then(check) as Promise<LookaheadWeek[]>,
        supabase.from('v_ppc').select('*').eq('plan_id', plan.id).order('week_start').then(check) as Promise<PpcWeek[]>,
      ]);
      return { items: items.map(fromPlanRow), weeks: weeks.map((w): LaWeek => ({ ...w, working_days: Number(w.working_days) })), ppc, start: plan.period_start, end: plan.period_end, horizon: plan.horizon_end, preview: null as Preview | null };
    }
    const pv = await planRead<Preview>('get_lookahead_preview', { project_id: projectId, calendar_mode: mode, year: month.year, month: month.month });
    return { items: (pv.items ?? []).map(fromCandidate), weeks: (pv.weeks ?? []).map((w): LaWeek => ({ id: null, status: 'open', ...w, working_days: Number(w.working_days) })),
      ppc: [] as PpcWeek[], start: pv.period_start, end: pv.period_end, horizon: pv.horizon_end, preview: pv };
  }, [projectId, plan?.id, mode, monthKey(month)], { key: 'la-month', enabled: !!plans.data });

  const d = data.data;
  // Refresh only syncs progress / constraints; task dates come from the forecast at generation — flag a newer forecast.
  const fcRun = useAsync(async () => (plan?.schedule_id
    ? (check(await supabase.from('schedules').select('forecast_run_at').eq('id', plan.schedule_id).maybeSingle()) as { forecast_run_at: string | null } | null)?.forecast_run_at ?? null
    : null), [plan?.schedule_id, plan?.generated_at], { key: 'la-forecast-run', enabled: !!plan?.schedule_id });
  const staleDates = !!plan && plan.status !== 'closed' && !!fcRun.data && !!plan.generated_at && fcRun.data > plan.generated_at;
  const gridStart = d?.start ?? range.start, gridEnd = d?.horizon ?? range.end;
  const hol = useAsync(async () => {
    const [ph, ex] = await Promise.all([
      supabase.from('public_holidays').select('on_date, name, name_am, is_tentative').gte('on_date', gridStart).lte('on_date', gridEnd).then(check) as Promise<Holiday[]>,
      supabase.from('calendar_exceptions').select('on_date, name, is_working').eq('project_id', projectId).is('deleted_at', null).gte('on_date', gridStart).lte('on_date', gridEnd).then(check) as Promise<{ on_date: string; name: string | null; is_working: boolean }[]>,
    ]);
    const m = new Map(ph.map((h) => [h.on_date, h]));
    for (const e of ex) {
      const h = m.get(e.on_date);
      if (e.is_working && h) m.set(e.on_date, { ...h, working: true, name: `${h.name} (site works)` });
      else if (!e.is_working) m.set(e.on_date, { on_date: e.on_date, name: e.name ?? h?.name ?? 'Non-working day', name_am: h?.name_am ?? null, is_tentative: false });
    }
    return [...m.values()];
  }, [projectId, gridStart, gridEnd], { key: 'la-holidays', staleTime: 10 * 60_000 });

  const me = auth.profile?.id;
  const items = (d?.items ?? []).filter((it) => (!f.mine || it.responsible_id === me) && (!f.crit || it.is_critical) && (!f.nr || it.readiness === 'not_ready' || it.readiness === 'at_risk')
    && (!f.q || `${it.name} ${it.wbs ?? ''} ${it.element_code ?? ''}`.toLowerCase().includes(f.q.toLowerCase())));
  const all = d?.items ?? [];
  const counts = { ready: all.filter((i) => i.readiness === 'ready').length, at_risk: all.filter((i) => i.readiness === 'at_risk').length, not_ready: all.filter((i) => i.readiness === 'not_ready').length };
  const current = peek ? all.find((i) => i.id === peek) ?? null : null;

  const { busy, error, run } = useBusy();
  const summaryToast = (verb: string, r: Record<string, unknown>) => toast.success(`${verb} · ${num(r.items ?? 0, 0)} tasks · ${num(r.not_ready ?? 0, 0)} not ready · ${num(r.raise_pr_now ?? 0, 0)} material${Number(r.raise_pr_now) === 1 ? '' : 's'} to order now`);
  const generate = () => run(async () => {
    const r = await planRpc('generate_lookahead', plan ? { project_id: projectId, plan_id: plan.id } : { project_id: projectId, calendar_mode: mode, year: month.year, month: month.month });
    summaryToast(`${title.title} ${plan ? 'regenerated' : 'generated'}`, r);
  });
  const refresh = () => run(async () => { const r = await planRpc('refresh_lookahead', { plan_id: plan!.id }); summaryToast('Refreshed', r); });
  const publish = () => run(async () => { await planRpc('publish_lookahead', { plan_id: plan!.id }); toast.success(`${title.title} published — site engineers can now commit weekly work`); });

  const editable = !plan || plan.status !== 'closed';
  const canGen = editable && can(role, 'lookahead.generate');
  const canPub = !!plan && plan.status === 'draft' && can(role, 'lookahead.publish');
  const canRef = !!plan && plan.status !== 'closed' && can(role, 'lookahead.refresh');
  const go = (n: number) => { setF('m', monthKey(shiftMonth(month, n))); setPeek(null); };

  return (
    <Page title={tr('Monthly tasks window', 'የወር የሥራ ዕቅድ')} width="dash"
      titleExtra={plan ? <Badge value={plan.status === 'published' ? 'approved' : plan.status} label={plan.status === 'draft' ? tr('Draft', 'ረቂቅ') : plan.status === 'published' ? tr('Published', 'ታትሟል') : tr('Closed', 'ተዘግቷል')} /> : <Badge tone="neutral" label={tr('Preview', 'ቅድመ እይታ')} icon={null} outline />}
      subtitle={plan ? `${plan.generated_at ? `Generated ${date(plan.generated_at)}` : ''}${plan.refreshed_at ? ` · refreshed ${date(plan.refreshed_at)}` : ''}${plan.published_at ? ` · published ${date(plan.published_at)} by ${lk.data?.person(plan.published_by) ?? ''}` : ''}` : tr('Not generated yet — showing the schedule live', 'ገና አልተዘጋጀም — ከጊዜ ሰሌዳው በቀጥታ')}
      actions={<>
        <button onClick={() => window.print()}><Printer size={14} aria-hidden />{tr('Print', 'አትም')}</button>
        {canRef && <button disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden className={busy ? 'spin' : ''} />{tr('Refresh', 'አድስ')}</button>}
        {canGen && <button className={plan ? '' : 'primary'} disabled={busy} onClick={() => void generate()}><WandSparkles size={14} aria-hidden />{plan ? tr('Regenerate', 'እንደገና አዘጋጅ') : tr('Generate', 'አዘጋጅ')}</button>}
        {canPub && <button className="primary" disabled={busy} onClick={() => void publish()}><Send size={14} aria-hidden />{tr('Publish', 'አትም / አሳውቅ')}</button>}
      </>}>
      <div className="row">
        <div className="la-monthnav">
          <button className="icon-btn" aria-label="Previous month" onClick={() => go(-1)}><ChevronLeft size={16} /></button>
          <div className="title"><strong>{title.title}</strong><span>{title.other}</span></div>
          <button className="icon-btn" aria-label="Next month" onClick={() => go(1)}><ChevronRight size={16} /></button>
        </div>
        <Tabs variant="segmented" label="Calendar" value={mode} onChange={(v) => { setF('mode', v); setF('m', ''); }}
          tabs={[{ key: 'gregorian', label: tr('Gregorian', 'ግሪጎሪያን') }, { key: 'ethiopian', label: tr('Ethiopian', 'ኢትዮጵያ') }]} />
        <span className="grow" />
        <div className="la-stats" aria-label="Readiness summary">
          <Badge tone="success" label={`${counts.ready} ${tr('ready', 'ዝግጁ')}`} />
          <Badge tone="warning" label={`${counts.at_risk} ${tr('at risk', 'ስጋት')}`} />
          <Badge tone="danger" label={`${counts.not_ready} ${tr('not ready', 'ዝግጁ ያልሆኑ')}`} />
        </div>
      </div>
      <ErrorBanner error={plans.error ?? data.error ?? error} onRetry={() => { plans.reload(); data.reload(); }} />
      {!plan && d && !d.preview?.schedule_id && <Banner tone="warn">No active schedule for this project. Import the MS Project schedule first.</Banner>}
      {!plan && d?.preview?.schedule_id && <Banner tone="info" action={canGen ? <button className="small" onClick={() => void generate()} disabled={busy}>Generate</button> : undefined}>
        Preview of {title.title} from the schedule. Generate it to check constraints and material needs; publish it so site engineers can commit weekly work.</Banner>}
      {plan?.status === 'draft' && <Banner tone="attention">Draft: review constraints and material needs, raise purchase requests, then publish.</Banner>}
      {staleDates && (
        <Banner tone="warn" action={canGen ? <button className="small" disabled={busy} onClick={() => void generate()}>{tr('Regenerate', 'እንደገና አዘጋጅ')}</button> : undefined}>
          The forecast was re-run on {date(fcRun.data)} after this plan was generated — task dates and weeks may be out of date.
          {canGen ? ' Regenerate to update them (commitments, owners and constraints are kept).' : ' Ask the office engineer or coordinator to regenerate it.'}
        </Banner>
      )}

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'plan', label: tr('Month', 'ወር'), count: all.length },
        { key: 'materials', label: tr('Material needs', 'የግብዓት ፍላጎት') },
        { key: 'weekly', label: tr('Weekly plan', 'ሳምንታዊ ዕቅድ') },
        { key: 'reliability', label: tr('Reliability (PPC)', 'የዕቅድ አፈጻጸም') },
      ]} />

      {tab === 'plan' && (
        <>
          <FilterBar active={active - (f.m ? 1 : 0) - (f.mode ? 1 : 0) - (f.view !== 'calendar' ? 1 : 0)} onClear={() => { clear(); setF('m', monthKey(month)); }}
            right={<Tabs variant="segmented" label="View" value={f.view === 'list' ? 'list' : 'calendar'} onChange={(v) => setF('view', v)} tabs={[{ key: 'calendar', label: tr('Calendar', 'ቀን መቁጠሪያ') }, { key: 'list', label: tr('List', 'ዝርዝር') }]} />}>
            <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder={tr('Task, WBS, element…', 'ሥራ…')} />
            <FilterToggle label={tr('My tasks', 'የእኔ')} checked={!!f.mine} onChange={(v) => setF('mine', v ? '1' : '')} />
            <FilterToggle label={tr('Critical', 'ወሳኝ')} checked={!!f.crit} onChange={(v) => setF('crit', v ? '1' : '')} />
            <FilterToggle label={`${tr('Not ready', 'ዝግጁ ያልሆኑ')} (${counts.at_risk + counts.not_ready})`} checked={!!f.nr} onChange={(v) => setF('nr', v ? '1' : '')} />
          </FilterBar>
          {!d ? <Loading lines={10} /> : !all.length ? (
            <Empty title={tr('No tasks in this window', 'በዚህ ወር ሥራ የለም')}>No unfinished schedule tasks overlap {title.title} or the following weeks.</Empty>
          ) : f.view === 'list' ? (
            <>
            <LookaheadGantt items={items} weeks={d.weeks} periodStart={d.start} periodEnd={d.end} horizonEnd={d.horizon} holidays={hol.data ?? []}
              today={today} activeId={peek} onOpen={(it) => setPeek(it.id, true)} />
            <DataTable rows={items} rowKey={(it) => it.id} onRowClick={(it) => setPeek(it.id, true)} activeKey={peek} exportName={`lookahead-${monthKey(month)}`} stickyFirst
              filtered={!!(f.q || f.mine || f.crit || f.nr)} columns={[
                { key: 'name', label: tr('Task', 'ሥራ'), render: (it) => <>{it.is_critical && <span className="danger-text" title="Critical">● </span>}{it.name}{it.wbs ? <div className="xs-text muted">{it.wbs}{it.group_name ? ` · ${it.group_name}` : ''}</div> : null}</> },
                { key: 'window_role', label: tr('Class', 'ክፍል'), render: (it) => <span className={`la-chip role-${it.window_role}`}>{roleLabel(it.window_role)}</span>, value: (it) => roleLabel(it.window_role) },
                { key: 'start', label: tr('Start', 'መጀመሪያ'), render: (it) => date(it.start) },
                { key: 'finish', label: tr('Finish', 'ማጠናቀቂያ'), render: (it) => date(it.finish) },
                { key: 'pct', label: '%', align: 'right', render: (it) => `${num(it.pct, 0)}${it.target_pct != null ? ` → ${num(it.target_pct, 0)}` : ''}` },
                { key: 'readiness', label: tr('Readiness', 'ዝግጁነት'), render: (it) => <ReadyBadge item={it} />, value: (it) => it.readiness },
                { key: 'earliest_due', label: tr('Next due', 'ቀጣይ ቀን'), render: (it) => <span className={it.earliest_due && it.earliest_due < today ? 'danger-text' : ''}>{date(it.earliest_due)}</span> },
                { key: 'responsible_name', label: tr('Responsible', 'ኃላፊ') },
                { key: 'commit', label: tr('Committed', 'ቃል'), render: (it) => it.commitments.filter((c) => c.kind === 'commitment').map((c) => `W${c.week_no}`).join(', ') },
              ]} />
            </>
          ) : (
            <MonthGrid items={items} weeks={d.weeks} periodStart={d.start} periodEnd={d.end} horizonEnd={d.horizon} holidays={hol.data ?? []} ppc={d.ppc}
              mode={mode} today={today} ppcTarget={target} onOpen={(it) => setPeek(it.id, true)} />
          )}
        </>
      )}
      {tab === 'materials' && (plan ? <MaterialNeeds plan={plan} /> : <Empty title={tr('Generate the look-ahead first', 'መጀመሪያ ያዘጋጁ')}>Material needs are calculated from the generated plan (take-off × remaining work − stock − open orders).</Empty>)}
      {tab === 'weekly' && (plan && d && lk.data ? (plan.status === 'draft' ? <Banner tone="info">Publish the look-ahead to open weekly commitments.</Banner>
        : <WeeklyPlan plan={plan} weeks={d.weeks} items={all} ppc={d.ppc} L={lk.data} onOpen={(it) => setPeek(it.id, true)} />)
        : !plan ? <Empty title={tr('Generate the look-ahead first', 'መጀመሪያ ያዘጋጁ')} /> : <Loading lines={6} />)}
      {tab === 'reliability' && <Reliability projectId={projectId} plan={plan} mode={mode} target={target} />}

      {current && lk.data && d && <ItemDrawer key={current.id} item={current} plan={plan} weeks={d.weeks} L={lk.data} onClose={() => setPeek(null)} />}
    </Page>
  );
}

