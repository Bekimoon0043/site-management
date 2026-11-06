import { lazy, Suspense, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarCheck, Coins, Info, Printer } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { date, num } from '../../lib/format';
import { useUrlFilters } from '../../lib/url';
import { evmBand, EVM_METRICS, EVM_THRESHOLDS_DEFAULT, type EvmBand, type EvmProject, type EvmTimeseriesRow, type ProgressOverview } from '../../lib/contract-schedule';
import { Banner, Card, DataTable, Drawer, Empty, ErrorBanner, Kpi, Loading, Page, Tabs, type Column } from '../../components/ui';
import { BandBadge, evmSummary, metricExplain, metricLabel } from '../../components/evm/copy';
import { daysBetween, idx, isAm, moneyShort, pct, planRead, tr, useSchedules, usePeriods } from '../../components/evm/data';
import '../../components/evm/evm.css';

const EvmSCurve = lazy(() => import('../../components/evm/EvmCharts').then((m) => ({ default: m.EvmSCurve })));
const EvmTrend = lazy(() => import('../../components/evm/EvmCharts').then((m) => ({ default: m.EvmTrend })));

/** Unified KPI row (live view or closed-period snapshot). */
interface Kp {
  status_date: string; bac: number; pv: number; ev: number; ac: number; sv: number | null; cv: number | null; spi: number | null; cpi: number | null;
  eac: number | null; etc: number | null; vac: number | null; tcpi: number | null; pct_planned: number | null; pct_earned: number | null;
  spi_status: EvmBand | null; cpi_status: EvmBand | null; spi_t: number | null; sv_t_days: number | null; spi_t_status: EvmBand | null;
  es_finish: string | null; fc_finish: string | null; baseline_finish: string | null; ac_coverage_pct: number | null; unbaselined_tasks: number;
  eac_fallback: boolean; ac_unallocated: number | null; cost_basis: string | null; eac_method: string | null; snapshot: boolean;
}
interface WbsRow {
  task_id: string; wbs: string | null; name: string; parent_id: string | null; outline_level: number; summary: boolean;
  bac: number | null; pct_planned: number | null; pct_earned: number | null; spi: number | null; cpi: number | null;
  eac: number | null; vac: number | null; spi_status: EvmBand | null; cpi_status: EvmBand | null;
  forecast_finish?: string | null; late_tasks?: number; leaf_tasks?: number;
}
type SnapRow = { task_id: string | null; level: 'task' | 'wbs' | 'project'; bac: number; pv: number; ev: number; ac: number; sv: number; cv: number; spi: number | null; cpi: number | null; eac: number; etc: number; vac: number; tcpi: number | null; ac_unallocated: number | null; spi_t: number | null };
type StatusRow = { task_id: string | null; level: string; pct_planned: number | null; pct_earned: number | null; spi: number | null; spi_t: number | null; sv_t_days: number | null; forecast_finish: string | null };
type TaskName = { id: string; wbs: string | null; name: string; parent_id: string | null; outline_level: number; is_summary: boolean };

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Earned value dashboard (spec §6). Price roles see money (v_evm_*); other roles get the no-money
 * progress overview (v_progress_overview). Status date = live schedule status date or a closed period snapshot.
 */
export function Evm() {
  const projectId = useProjectId();
  const auth = useAuth();
  const money = auth.canSeePrices;
  const currency = auth.project?.currency ?? 'ETB';
  const am = isAm();
  const nav = useNavigate();
  const [f, setF] = useUrlFilters({ s: '', p: '', grain: 'month', node: '' });
  const sch = useSchedules(projectId);
  const schedule = sch.data?.find((s) => s.id === f.s) ?? sch.data?.[0];
  const per = usePeriods(schedule?.id);
  const closed = (per.data ?? []).filter((p) => p.status === 'closed');
  const period = closed.find((p) => p.id === f.p) ?? null;
  const statusDate = period?.status_date ?? schedule?.status_date ?? null;
  const [why, setWhy] = useState(false);
  const grain = f.grain === 'week' ? 'week' : 'month';

  // ---- KPI + WBS (money) --------------------------------------------------
  const evm = useAsync(async (): Promise<{ kp: Kp | null; wbs: WbsRow[]; names: Map<string, TaskName> }> => {
    const sid = schedule?.id ?? '';
    if (!period) {
      const [pj, wbs] = await Promise.all([
        supabase.from('v_evm_project').select('*').eq('schedule_id', sid).maybeSingle().then(check) as Promise<EvmProject | null>,
        fetchAll<Record<string, unknown>>((a, b) => supabase.from('v_evm_wbs').select('*').eq('schedule_id', sid).order('wbs').range(a, b)),
      ]);
      const kp: Kp | null = pj && {
        ...pj, sv: n(pj.sv), cv: n(pj.cv), spi: n(pj.spi), cpi: n(pj.cpi), eac: n(pj.eac), etc: n(pj.etc), vac: n(pj.vac), tcpi: n(pj.tcpi),
        bac: Number(pj.bac), pv: Number(pj.pv), ev: Number(pj.ev), ac: Number(pj.ac), pct_planned: n(pj.pct_planned), pct_earned: n(pj.pct_earned),
        spi_t: n(pj.spi_t), sv_t_days: n(pj.sv_t_days), ac_coverage_pct: n(pj.ac_coverage_pct), ac_unallocated: n(pj.ac_unallocated), snapshot: false,
      };
      return { kp, wbs: wbs.map((w) => toWbs(w, true)), names: new Map() };
    }
    const [snaps, stat, names] = await Promise.all([
      fetchAll<SnapRow>((a, b) => supabase.from('evm_snapshots').select('task_id, level, bac, pv, ev, ac, sv, cv, spi, cpi, eac, etc, vac, tcpi, ac_unallocated, spi_t').eq('period_id', period.id).neq('level', 'task').range(a, b)),
      supabase.from('evm_task_status').select('task_id, level, pct_planned, pct_earned, spi, spi_t, sv_t_days, forecast_finish').eq('period_id', period.id).eq('level', 'project').maybeSingle().then(check) as Promise<StatusRow | null>,
      fetchAll<TaskName>((a, b) => supabase.from('schedule_tasks').select('id, wbs, name, parent_id, outline_level, is_summary').eq('schedule_id', sid).eq('is_summary', true).range(a, b)),
    ]);
    const nm = new Map(names.map((t) => [t.id, t]));
    const p = snaps.find((s) => s.level === 'project');
    const kp: Kp | null = p ? {
      status_date: period.status_date, bac: Number(p.bac), pv: Number(p.pv), ev: Number(p.ev), ac: Number(p.ac), sv: n(p.sv), cv: n(p.cv),
      spi: n(p.spi), cpi: n(p.cpi), eac: n(p.eac), etc: n(p.etc), vac: n(p.vac), tcpi: n(p.tcpi),
      pct_planned: Number(p.bac) ? (100 * Number(p.pv)) / Number(p.bac) : null, pct_earned: Number(p.bac) ? (100 * Number(p.ev)) / Number(p.bac) : null,
      spi_status: evmBand(n(p.spi)), cpi_status: evmBand(n(p.cpi)), spi_t: n(p.spi_t) ?? n(stat?.spi_t), sv_t_days: n(stat?.sv_t_days),
      spi_t_status: evmBand(n(p.spi_t)), es_finish: null, fc_finish: stat?.forecast_finish ?? null, baseline_finish: null,
      ac_coverage_pct: null, unbaselined_tasks: 0, eac_fallback: false, ac_unallocated: n(p.ac_unallocated), cost_basis: null, eac_method: null, snapshot: true,
    } : null;
    const wbs = snaps.filter((s) => s.level === 'wbs' && s.task_id && nm.has(s.task_id)).map((s): WbsRow => {
      const t = nm.get(s.task_id!)!;
      return { task_id: t.id, wbs: t.wbs, name: t.name, parent_id: t.parent_id, outline_level: t.outline_level, summary: true, bac: Number(s.bac),
        pct_planned: Number(s.bac) ? (100 * Number(s.pv)) / Number(s.bac) : null, pct_earned: Number(s.bac) ? (100 * Number(s.ev)) / Number(s.bac) : null,
        spi: n(s.spi), cpi: n(s.cpi), eac: n(s.eac), vac: n(s.vac), spi_status: evmBand(n(s.spi)), cpi_status: evmBand(n(s.cpi)) };
    });
    return { kp, wbs, names: nm };
  }, [schedule?.id, period?.id], { key: 'evm-dash', enabled: money && !!schedule });

  // ---- No-money overview ---------------------------------------------------
  const ov = useAsync(async () => fetchAll<ProgressOverview & { outline_level: number }>((a, b) => supabase.from('v_progress_overview').select('*')
    .eq('schedule_id', schedule?.id ?? '').order('wbs', { nullsFirst: true }).range(a, b)), [schedule?.id], { key: 'evm-overview', enabled: !money && !!schedule });

  // ---- Time series (money) ------------------------------------------------
  const ts = useAsync(() => planRead<EvmTimeseriesRow[]>('get_evm_timeseries', { schedule_id: schedule?.id ?? '', grain, status_date: period?.status_date }),
    [schedule?.id, grain, period?.id], { key: 'evm-ts', enabled: money && !!schedule });

  // ---- Drill-down ---------------------------------------------------------
  const allWbs: WbsRow[] = useMemo(() => {
    if (money) return evm.data?.wbs ?? [];
    return (ov.data ?? []).filter((r) => r.level === 'wbs' && r.task_id).map((r) => ({
      task_id: r.task_id!, wbs: r.wbs, name: r.name, parent_id: null, outline_level: Number(r.outline_level ?? 1), summary: true, bac: null,
      pct_planned: n(r.pct_planned), pct_earned: n(r.pct_earned), spi: n(r.spi), cpi: null, eac: null, vac: null, spi_status: r.spi_status, cpi_status: null,
      forecast_finish: r.forecast_finish, late_tasks: r.late_tasks, leaf_tasks: r.leaf_tasks,
    }));
  }, [money, evm.data, ov.data]);
  const byId = useMemo(() => new Map(allWbs.map((w) => [w.task_id, w])), [allWbs]);
  const node = f.node ? byId.get(f.node) ?? null : null;
  const childrenOf = (nd: WbsRow | null): WbsRow[] => {
    if (money) {
      if (!nd) {
        const ids = new Set(allWbs.map((w) => w.task_id));
        return allWbs.filter((w) => !w.parent_id || !ids.has(w.parent_id));
      }
      return allWbs.filter((w) => w.parent_id === nd.task_id);
    }
    // overview has no parent ids: nest by WBS code + outline level
    if (!nd) { const min = Math.min(...allWbs.map((w) => w.outline_level)); return allWbs.filter((w) => w.outline_level === min); }
    return allWbs.filter((w) => w.outline_level === nd.outline_level + 1 && !!nd.wbs && (w.wbs ?? '').startsWith(`${nd.wbs}.`));
  };
  const crumbs: WbsRow[] = [];
  if (money) for (let c = node; c; c = c.parent_id ? byId.get(c.parent_id) ?? null : null) crumbs.unshift(c);
  else for (let c = node; c; c = allWbs.find((w) => w.outline_level === c!.outline_level - 1 && !!w.wbs && (c!.wbs ?? '').startsWith(`${w.wbs}.`)) ?? null) crumbs.unshift(c);
  const kids = childrenOf(node);
  const leaves = useAsync(async () => {
    if (period) {
      const [s, t] = await Promise.all([
        fetchAll<SnapRow>((a, b) => supabase.from('evm_snapshots').select('task_id, level, bac, pv, ev, ac, sv, cv, spi, cpi, eac, etc, vac, tcpi, ac_unallocated, spi_t').eq('period_id', period.id).eq('level', 'task').range(a, b)),
        fetchAll<TaskName>((a, b) => supabase.from('schedule_tasks').select('id, wbs, name, parent_id, outline_level, is_summary').eq('parent_id', node!.task_id).eq('is_summary', false).range(a, b)),
      ]);
      const snap = new Map(s.map((x) => [x.task_id, x]));
      return t.filter((x) => snap.has(x.id)).map((x): WbsRow => {
        const r = snap.get(x.id)!;
        return { task_id: x.id, wbs: x.wbs, name: x.name, parent_id: x.parent_id, outline_level: x.outline_level, summary: false, bac: Number(r.bac),
          pct_planned: Number(r.bac) ? (100 * Number(r.pv)) / Number(r.bac) : null, pct_earned: Number(r.bac) ? (100 * Number(r.ev)) / Number(r.bac) : null,
          spi: n(r.spi), cpi: n(r.cpi), eac: n(r.eac), vac: n(r.vac), spi_status: evmBand(n(r.spi)), cpi_status: evmBand(n(r.cpi)) };
      });
    }
    const rows = check(await supabase.from('v_evm_task').select('*').eq('schedule_id', schedule?.id ?? '').eq('parent_id', node!.task_id).order('wbs').limit(1000)) as Record<string, unknown>[];
    return rows.map((r) => toWbs(r, false));
  }, [schedule?.id, node?.task_id, period?.id], { key: 'evm-leaves', enabled: money && !!node && !!schedule });
  const tableRows = [...kids, ...(money && node ? leaves.data ?? [] : [])];

  // ---- Render --------------------------------------------------------------
  const kp = evm.data?.kp ?? null;
  const ovp = (ov.data ?? []).find((r) => r.level === 'project') ?? null;
  const sum = kp ? evmSummary({ ...kp, bac: kp.bac }, currency) : null;
  const fcFinish = kp?.fc_finish ?? ovp?.forecast_finish ?? schedule?.fc_finish ?? null;
  const esFinish = kp?.es_finish ?? ovp?.es_finish ?? schedule?.es_finish ?? null;
  const blFinish = kp?.baseline_finish ?? ovp?.baseline_finish ?? null;
  const slip = fcFinish && blFinish ? daysBetween(blFinish, fcFinish) : null;
  const loading = money ? !evm.data && !evm.error : !ov.data && !ov.error;

  const columns: Column<WbsRow>[] = [
    { key: 'name', label: tr('WBS / name', 'የሥራ ክፍል'), render: (r) => <span className={r.summary ? 'strong' : ''}>{r.wbs ? <span className="muted">{r.wbs} </span> : null}{r.name}{r.summary ? ' ▸' : ''}</span>, value: (r) => `${r.wbs ?? ''} ${r.name}` },
    ...(money ? [{ key: 'bac', label: tr('Budget', 'በጀት'), align: 'right' as const, render: (r: WbsRow) => moneyShort(r.bac, currency), value: (r: WbsRow) => r.bac }] : []),
    { key: 'pct_planned', label: tr('% planned', 'የታቀደ %'), align: 'right', render: (r) => pct(r.pct_planned, 0) },
    { key: 'pct_earned', label: tr('% done', 'የተሰራ %'), align: 'right', render: (r) => pct(r.pct_earned, 0) },
    { key: 'spi', label: 'SPI', render: (r) => <span className="row nowrap"><span className="tnum">{idx(r.spi)}</span><BandBadge kind="schedule" band={r.spi_status} value={r.spi} /></span>, value: (r) => r.spi },
    ...(money ? [
      { key: 'cpi', label: 'CPI', render: (r: WbsRow) => <span className="row nowrap"><span className="tnum">{idx(r.cpi)}</span><BandBadge kind="cost" band={r.cpi_status} value={r.cpi} /></span>, value: (r: WbsRow) => r.cpi },
      { key: 'eac', label: 'EAC', align: 'right' as const, render: (r: WbsRow) => moneyShort(r.eac, currency), value: (r: WbsRow) => r.eac },
      { key: 'vac', label: 'VAC', align: 'right' as const, render: (r: WbsRow) => <span className={r.vac != null && r.vac < 0 ? 'danger-text' : ''}>{moneyShort(r.vac, currency)}</span>, value: (r: WbsRow) => r.vac },
    ] : [
      { key: 'forecast_finish', label: tr('Forecast finish', 'የሚጠበቅ ማጠናቀቂያ'), render: (r: WbsRow) => date(r.forecast_finish) },
      { key: 'late_tasks', label: tr('Late tasks', 'የዘገዩ'), align: 'right' as const, render: (r: WbsRow) => (r.late_tasks ? <span className="danger-text">{r.late_tasks}</span> : '0') },
    ]),
  ];

  const actions = (
    <>
      {closed.length > 0 || schedule ? (
        <select aria-label="Status date" value={period?.id ?? ''} onChange={(e) => setF('p', e.target.value)}>
          <option value="">{tr('Status date', 'የሪፖርት ቀን')} {date(schedule?.status_date) || '—'} ({tr('live', 'ቀጥታ')})</option>
          {closed.map((p) => <option key={p.id} value={p.id}>{tr('Closed', 'የተዘጋ')} #{p.period_no} · {date(p.status_date)}</option>)}
        </select>
      ) : null}
      <button onClick={() => nav(`/evm/periods${schedule ? `?s=${schedule.id}` : ''}`)}><CalendarCheck size={14} aria-hidden />{tr('Periods', 'ወቅቶች')}</button>
      {money && <button onClick={() => nav('/costs')}><Coins size={14} aria-hidden />{tr('Costs', 'ወጪዎች')}</button>}
      <button onClick={() => window.print()}><Printer size={14} aria-hidden />{tr('Print', 'አትም')}</button>
    </>
  );

  if (sch.data && !sch.data.length) {
    return <Page title={tr('Earned value', 'የተገኘ እሴት')}><Empty title={tr('No schedule yet', 'የጊዜ ሰሌዳ የለም')}>Import the MS Project schedule first, then approve a baseline.</Empty></Page>;
  }

  return (
    <Page title={tr('Earned value', 'የተገኘ እሴት')} width="dash" actions={actions}
      subtitle={schedule ? `${schedule.code} · ${schedule.name}${statusDate ? ` · ${tr('measured to', 'እስከ')} ${date(statusDate)}` : ''}${period ? ` · ${tr('closed period', 'የተዘጋ ወቅት')} #${period.period_no}` : ''}${!money ? ` · ${tr('progress only (no money)', 'ገንዘብ ሳይጨምር')}` : ''}` : undefined}>
      {(sch.data?.length ?? 0) > 1 && (
        <Tabs variant="segmented" label="Schedule" value={schedule?.id ?? ''} onChange={(v) => { setF('s', v); setF('node', ''); setF('p', ''); }}
          tabs={sch.data!.map((s) => ({ key: s.id, label: s.code }))} />
      )}
      <ErrorBanner error={sch.error ?? evm.error ?? ov.error ?? per.error} onRetry={() => { sch.reload(); evm.reload(); ov.reload(); }} />
      {money && kp && kp.ac_coverage_pct != null && kp.ac_coverage_pct < 80 && (
        <Banner tone="warn" action={<Link to="/costs#coverage">{tr('Check costs', 'ወጪዎችን ይመልከቱ')}</Link>}>
          Only {num(kp.ac_coverage_pct, 0)} % of the actual cost is linked to schedule tasks. Task-level CPI is partial.
        </Banner>
      )}
      {money && kp && kp.unbaselined_tasks > 0 && (
        <Banner tone="info">{kp.unbaselined_tasks} task{kp.unbaselined_tasks === 1 ? '' : 's'} are not in the approved baseline and earn no value until it is re-baselined.</Banner>
      )}
      {money && evm.data && !kp && !loading && <Banner tone="warn">No approved baseline with budgets yet. Earned value needs an approved baseline (Schedule › Baselines).</Banner>}

      {/* One sentence */}
      <section className="evm-summary" aria-label={tr('In one sentence', 'በአንድ ዓረፍተ ነገር')}>
        <div className="evm-summary-head">{tr('In one sentence', 'በአንድ ዓረፍተ ነገር')}</div>
        {loading ? <Loading lines={2} /> : money && sum ? (
          <>
            <p className="evm-headline"><BandBadge kind="schedule" band={kp!.spi_status} value={kp!.spi} /> {kp!.cpi != null && <BandBadge kind="cost" band={kp!.cpi_status} value={kp!.cpi} />} <strong>{sum.headline}</strong></p>
            <p className="evm-sentence">{sum.sentence} {sum.forecast}</p>
            <button className="link-btn" onClick={() => setWhy(true)}><Info size={12} aria-hidden /> {tr('Why? Show the numbers', 'ለምን? ቁጥሮቹን አሳይ')}</button>
          </>
        ) : !money && ovp ? (
          <>
            <p className="evm-headline"><BandBadge kind="schedule" band={ovp.spi_status} value={ovp.spi} /> <strong>{progressSentence(ovp)}</strong></p>
            <p className="evm-sentence muted">{ovp.completed_tasks} of {ovp.leaf_tasks} tasks complete · {ovp.in_progress_tasks} in progress · {ovp.late_tasks} late · {ovp.pending_verification} waiting for verification</p>
          </>
        ) : <p className="muted mb-0">{tr('No progress measured yet.', 'ገና መረጃ የለም።')}</p>}
      </section>

      {/* KPI cards */}
      <div className="kpis evm-kpis">
        <Kpi label={metricLabel('spi')} loading={loading} value={idx(kp?.spi ?? ovp?.spi)}
          status={sev(kp?.spi_status ?? ovp?.spi_status)} hint={<BandBadge kind="schedule" band={kp?.spi_status ?? ovp?.spi_status} value={kp?.spi ?? ovp?.spi} />} />
        {money ? (
          <>
            <Kpi label={metricLabel('cpi')} loading={loading} value={kp?.cpi == null ? '—' : idx(kp.cpi)} status={sev(kp?.cpi_status)}
              hint={kp?.cpi == null ? tr('No costs recorded yet', 'ወጪ አልተመዘገበም') : <BandBadge kind="cost" band={kp.cpi_status} value={kp.cpi} />} />
            <Kpi label={metricLabel('eac')} loading={loading} value={<span title={kp?.eac != null ? num(kp.eac) : undefined}>{moneyShort(kp?.eac, currency)}</span>}
              hint={`${tr('Budget', 'በጀት')} ${moneyShort(kp?.bac, currency)}${kp?.eac_fallback ? ` · ${tr('early: AC + remaining at budget', 'መጀመሪያ ደረጃ')}` : ''}`} />
            <Kpi label={metricLabel('vac')} loading={loading} value={<span title={kp?.vac != null ? num(kp.vac) : undefined}>{moneyShort(kp?.vac, currency)}</span>}
              status={kp?.vac != null && kp.bac ? (kp.vac / kp.bac < -0.05 ? 'danger' : kp.vac < 0 ? 'warning' : undefined) : undefined}
              hint={kp?.vac != null && kp.bac ? `${num((100 * kp.vac) / kp.bac, 1)} % ${tr('of budget', 'የበጀቱ')} · ${kp.vac < 0 ? tr('overrun', 'ብክነት') : kp.vac > 0 ? tr('saving', 'ቁጠባ') : tr('on budget', 'በበጀቱ')}` : undefined} />
          </>
        ) : (
          <Kpi label={tr('Late tasks', 'የዘገዩ ሥራዎች')} loading={loading} value={ovp?.late_tasks ?? 0} status={ovp?.late_tasks ? 'warning' : undefined}
            hint={`${ovp?.critical_tasks ?? 0} critical open · ${ovp?.negative_float_tasks ?? 0} negative float`} />
        )}
        <Kpi label={`${tr('% planned', 'የታቀደ %')} / ${tr('% complete', 'የተጠናቀቀ %')}`} loading={loading}
          value={<>{pct(kp?.pct_earned ?? ovp?.pct_earned)}<span className="unit"> / {pct(kp?.pct_planned ?? ovp?.pct_planned)}</span></>}
          hint={tr('Complete (verified) vs should be done by now', 'የተሰራ ከታቀደው ጋር')} />
        <Kpi label={tr('Forecast finish', 'የሚጠበቅ ማጠናቀቂያ')} loading={loading} value={fcFinish ? date(fcFinish) : '—'}
          status={slip != null && slip > 0 ? (slip > 20 ? 'danger' : 'warning') : undefined}
          hint={<>{slip != null ? `${slip > 0 ? '+' : ''}${slip} d ${tr('vs baseline', 'ከመነሻ')} ${date(blFinish)} · ` : ''}{tr('Earned schedule', 'በተገኘ ጊዜ')} {esFinish ? date(esFinish) : '—'}{(kp?.sv_t_days ?? ovp?.sv_t_days) != null ? ` (${num(kp?.sv_t_days ?? ovp?.sv_t_days, 0)} wd)` : ''}</>} />
      </div>
      {money && kp && (
        <p className="muted small-text">
          {tr('Money', 'ገንዘብ')}: BAC {moneyShort(kp.bac, currency)} · PV {moneyShort(kp.pv, currency)} · EV {moneyShort(kp.ev, currency)} · AC {moneyShort(kp.ac, currency)}
          {kp.cost_basis === 'materials' ? ` · ${tr('cost basis: materials only', 'ዕቃ ብቻ')}` : ''}
          {' '}<button className="link-btn" onClick={() => setWhy(true)}>{tr('More metrics: TCPI, EAC methods ▸', 'ተጨማሪ ▸')}</button>
        </p>
      )}

      {money && (
        <div className="dash-grid">
          <Card title={tr('S-curve (cumulative)', 'S-ከርቭ')} sub={currency} actions={<Tabs variant="segmented" label="Grain" value={grain} onChange={(g) => setF('grain', g)}
            tabs={[{ key: 'week', label: tr('Weekly', 'ሳምንታዊ') }, { key: 'month', label: tr('Monthly', 'ወርሃዊ') }]} />}>
            <ErrorBanner error={ts.error} onRetry={ts.reload} />
            {!ts.data ? <Loading lines={5} /> : !ts.data.length ? <p className="muted">{tr('No baseline time-phasing yet.', 'መረጃ የለም።')}</p> : (
              <Suspense fallback={<Loading lines={5} />}><EvmSCurve rows={ts.data} bac={kp?.bac ?? null} eac={kp?.eac ?? null} statusDate={statusDate} currency={currency} /></Suspense>
            )}
          </Card>
          <Card title={tr('SPI & CPI trend', 'የአፈጻጸም አዝማሚያ')} sub={tr('cumulative', 'ድምር')}>
            {!ts.data ? <Loading lines={5} /> : (
              <Suspense fallback={<Loading lines={5} />}><EvmTrend rows={ts.data} warn={EVM_THRESHOLDS_DEFAULT.idx_warn} crit={EVM_THRESHOLDS_DEFAULT.idx_crit} /></Suspense>
            )}
          </Card>
        </div>
      )}

      <Card flush title={tr('By WBS', 'በሥራ ክፍል')} sub={tr('Click a row to drill down', 'ለዝርዝር ይጫኑ')} actions={crumbs.length > 0 && (
        <nav className="evm-crumbs" aria-label="WBS path">
          <button className="link-btn" onClick={() => setF('node', '')}>{tr('Project', 'ፕሮጀክት')}</button>
          {crumbs.map((c) => <span key={c.task_id}> › <button className="link-btn" onClick={() => setF('node', c.task_id)}>{c.name}</button></span>)}
        </nav>
      )}>
        <DataTable rows={tableRows} rowKey={(r) => r.task_id} columns={columns} loading={loading || (money && !!node && !leaves.data && !leaves.error)}
          error={leaves.error} exportName="evm-wbs" maxHeight="520px"
          onRowClick={(r) => { if (r.summary) setF('node', r.task_id); }}
          empty={{ title: tr('Nothing to show', 'ምንም የለም'), body: node ? 'This WBS node has no tasks with a budget.' : 'The schedule has no summary (WBS) tasks.' }} />
      </Card>

      {why && kp && (
        <Drawer title={tr('How the numbers are calculated', 'ቁጥሮቹ እንዴት እንደተሰሉ')} subtitle={`${tr('Status date', 'የሪፖርት ቀን')} ${date(kp.status_date)}`} onClose={() => setWhy(false)} size="lg">
          <DataTable rows={EVM_METRICS} rowKey={(m) => m.key} maxHeight="none" columns={[
            { key: 'label', label: tr('Metric', 'መለኪያ'), render: (m) => <><strong>{am ? m.label_am : m.label}</strong> <span className="muted">({m.key === 'spi_t' ? 'SPI(t)' : m.key.toUpperCase()})</span></> },
            { key: 'v', label: tr('Value', 'ዋጋ'), align: 'right', render: (m) => metricValue(m.key, m.money, kp, currency) },
            { key: 'formula', label: tr('Formula', 'ቀመር'), render: (m) => <code className="small-text">{m.formula}</code> },
            { key: 'explain', label: tr('In plain words', 'በቀላል ቋንቋ'), render: (m) => metricExplain(m.key, (kp as unknown as Record<string, number | null>)[m.key]) },
          ]} />
          <h3 className="mt-4">{tr('Which EAC?', 'የትኛው EAC?')}</h3>
          <ul className="small-text">
            <li><strong>BAC ÷ CPI</strong> ({moneyShort(kp.cpi ? kp.bac / kp.cpi : null, currency)}): the cost efficiency so far continues (typical). This is the default.</li>
            <li><strong>AC + (BAC − EV)</strong> ({moneyShort(kp.ac + kp.bac - kp.ev, currency)}): the overrun so far was a one-off; the rest goes to budget.</li>
            <li>TCPI {idx(kp.tcpi)} — {metricExplain('tcpi')}</li>
          </ul>
          {kp.ac_unallocated ? <p className="muted small-text">{moneyShort(kp.ac_unallocated, currency)} of actual cost is not linked to a task; it counts at project level only.</p> : null}
        </Drawer>
      )}
    </Page>
  );
}

function toWbs(w: Record<string, unknown>, summary: boolean): WbsRow {
  return {
    task_id: String(w.task_id), wbs: (w.wbs as string) ?? null, name: String(w.name ?? ''), parent_id: (w.parent_id as string) ?? null,
    outline_level: Number(w.outline_level ?? 1), summary, bac: n(w.bac), pct_planned: n(w.pct_planned), pct_earned: n(w.pct_earned),
    spi: n(w.spi), cpi: n(w.cpi), eac: n(w.eac), vac: n(w.vac), spi_status: (w.spi_status as EvmBand) ?? null, cpi_status: (w.cpi_status as EvmBand) ?? null,
  };
}
const sev = (b: EvmBand | null | undefined) => (b === 'critical' ? 'danger' as const : b === 'warning' ? 'warning' as const : undefined);

function metricValue(key: string, isMoney: boolean, kp: Kp, currency: string) {
  const v = (kp as unknown as Record<string, number | null>)[key];
  if (v == null) return '—';
  if (isMoney) return <span title={num(v)}>{moneyShort(v, currency)}</span>;
  if (key.startsWith('pct')) return pct(v);
  if (key === 'sv_t_days') return `${num(v, 1)} d`;
  return idx(v);
}

function progressSentence(o: ProgressOverview): string {
  const am = isAm();
  const d = o.sv_t_days == null ? null : Math.round(Math.abs(Number(o.sv_t_days)));
  const p = o.pct_earned == null ? '—' : Number(o.pct_earned).toFixed(1);
  const pl = o.pct_planned == null ? '—' : Number(o.pct_planned).toFixed(1);
  if (am) return `${p}% ሥራ ተጠናቅቆ ተረጋግጧል (የታቀደው ${pl}%)${d ? `፤ ${d} የሥራ ቀን ${Number(o.sv_t_days) < 0 ? 'ወደኋላ' : 'ቀድመናል'}` : ''}።`;
  return `${p} % of the work is done and verified (planned ${pl} %)${d ? `; we are ${d} working day${d === 1 ? '' : 's'} ${Number(o.sv_t_days) < 0 ? 'behind' : 'ahead'}` : ''}.`;
}

