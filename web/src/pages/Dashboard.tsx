import { lazy, Suspense, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Flame, RefreshCw, TriangleAlert, Info } from 'lucide-react';
import { useAuth, useProjectId } from '../lib/auth';
import { useAsync, useLookups } from '../lib/hooks';
import { check, countRows, fetchAll, supabase } from '../lib/supabase';
import { money, num, since } from '../lib/format';
import type { RollupRow } from '../lib/domain';
import { useUrlFilters } from '../lib/url';
import { loadPlanningAttention } from '../components/lookahead/attention';
import { Bar, Card, DataTable, ErrorBanner, Kpi, Loading, Page, Tabs } from '../components/ui';
import { navFor } from '../nav';
import { canPay } from '../lib/contract-payments';
import { PaymentsCard } from '../components/payments/PaymentsCard';
import { useNavCounts } from '../lib/approvals';

const SCurve = lazy(() => import('../components/charts/SCurve').then((m) => ({ default: m.SCurve })));

type Period = 'today' | '7d' | '30d';
const PERIOD_DAYS: Record<Period, number> = { today: 1, '7d': 7, '30d': 30 };
const PERIOD_LABEL: Record<Period, string> = { today: 'vs yesterday', '7d': 'vs prev 7 d', '30d': 'vs prev 30 d' };

interface VarRow { element_id: string; element_code: string; label: string; category: string; earned_qty: number | null; issued_qty: number; variance_pct: number | null }

/** A link only when the viewer can open the target page; otherwise the same content as plain text. */
function OptLink({ to, ok, children }: { to: string; ok: boolean; children: ReactNode }) {
  return ok ? <Link to={to}>{children}</Link> : <span>{children}</span>;
}

export function Dashboard() {
  const projectId = useProjectId();
  const auth = useAuth();
  const routes = navFor(auth.profile?.role, auth.can).map((n) => n.to);
  /** Link target only when this role can open the page (else the KPI / counter shows as plain text). */
  const open = (to: string) => (routes.includes(to.split(/[?#]/)[0]) ? to : undefined);
  const { settings, canSeePrices, project } = auth;
  const lk = useLookups(projectId);
  const [f, setF] = useUrlFilters({ period: '7d' });
  const period = (['today', '7d', '30d'].includes(f.period) ? f.period : '7d') as Period;
  const days = PERIOD_DAYS[period];
  const thresholds = settings?.variance_thresholds ?? {};

  const q = useAsync(async () => {
    const dayMs = 86400000;
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const start = new Date(startOfToday.getTime() - (days - 1) * dayMs);
    const prevStart = new Date(start.getTime() - days * dayMs);
    const head = (table: string) => supabase.from(table).select('*', { count: 'exact', head: true }).eq('project_id', projectId);
    const cats = Object.entries(thresholds).filter(([, t]) => Number.isFinite(Number(t)));
    const [rollup, ageing, lowStock, emergency, pendAdj, pendCnt, pendVerify, pendAck, wasteNow, wastePrev, submissions, varCounts, varTop, cost] = await Promise.all([
      supabase.from('v_progress_rollup').select('block_code, elements, completed, avg_progress_pct, delayed').eq('project_id', projectId).then(check),
      supabase.from('v_request_ageing').select('hours_waiting, priority').eq('project_id', projectId).then(check),
      countRows(() => head('v_stock_balance').eq('below_reorder', true)),
      countRows(() => head('v_overdue_emergency_issues')),
      countRows(() => head('adjustments').eq('status', 'pending')),
      countRows(() => head('stock_counts').eq('status', 'submitted')),
      countRows(() => head('progress_updates').eq('status', 'reported')),
      countRows(() => head('mivs').eq('status', 'pending_ack')),
      countRows(() => head('adjustments').eq('status', 'approved').neq('adj_type', 'count_variance').gte('created_at', start.toISOString())),
      countRows(() => head('adjustments').eq('status', 'approved').neq('adj_type', 'count_variance').gte('created_at', prevStart.toISOString()).lt('created_at', start.toISOString())),
      supabase.from('material_requests').select('submitted_at').eq('project_id', projectId).gte('submitted_at', prevStart.toISOString()).then(check),
      // Variance alerts: one HEAD count per category threshold instead of downloading the consumption view.
      Promise.all(cats.map(([c, t]) => countRows(() => head('v_element_consumption').ilike('category', c).gt('variance_pct', Number(t))))),
      Promise.all(cats.map(([c, t]) => supabase.from('v_element_consumption').select('element_id, element_code, label, category, earned_qty, issued_qty, variance_pct')
        .eq('project_id', projectId).ilike('category', c).gt('variance_pct', Number(t)).order('variance_pct', { ascending: false }).limit(10).then(check))),
      canSeePrices
        ? fetchAll<{ issued_cost: number | null; planned_cost: number | null }>((a, b) => supabase.from('v_element_cost').select('issued_cost, planned_cost').eq('project_id', projectId).range(a, b))
        : Promise.resolve([]),
    ]);
    const subs = (submissions as { submitted_at: string | null }[]).map((s) => s.submitted_at).filter(Boolean) as string[];
    const spark = Array.from({ length: Math.max(days, 7) }, (_, i) => {
      const d0 = startOfToday.getTime() - (Math.max(days, 7) - 1 - i) * dayMs;
      return subs.filter((s) => { const t = new Date(s).getTime(); return t >= d0 && t < d0 + dayMs; }).length;
    });
    return {
      at: Date.now(),
      rollup: rollup as RollupRow[], ageing: ageing as { hours_waiting: number; priority: string }[], lowStock, emergency, pendAdj, pendCnt, pendVerify, pendAck,
      wasteNow, wastePrev, subsNow: subs.filter((s) => s >= start.toISOString()).length, subsPrev: subs.filter((s) => s < start.toISOString()).length, spark,
      varCount: varCounts.reduce((s, n) => s + n, 0),
      varTop: (varTop.flat() as VarRow[]).sort((a, b) => Number(b.variance_pct) - Number(a.variance_pct)).slice(0, 10),
      cost,
    };
  }, [projectId, canSeePrices, period, JSON.stringify(thresholds)], { key: 'dashboard' });

  const d = q.data;
  // Open critical alerts (gate mismatches, loaded exits without a pass, rule breaches) — management only (alert.manage).
  // Planning: SPI / CPI critical, overdue look-ahead constraints, PPC below target.
  const planAttn = useAsync(() => loadPlanningAttention(projectId, canSeePrices), [projectId, canSeePrices], { key: 'dashboard-planning', staleTime: 5 * 60_000 });
  const crit = useAsync(() => countRows(() => supabase.from('alerts').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('severity', 'critical').eq('status', 'open')),
    [projectId], { key: 'dashboard-critical-alerts', enabled: auth.can('mr.approve') });
  const nc = useNavCounts(auth.projectId, auth.can, auth.profile?.role);
  const loading = !d && !q.error;
  const totalEl = d ? d.rollup.reduce((s, r) => s + Number(r.elements), 0) : 0;
  const overall = d && totalEl ? d.rollup.reduce((s, r) => s + Number(r.avg_progress_pct) * Number(r.elements), 0) / totalEl : 0;
  const completed = d ? d.rollup.reduce((s, r) => s + Number(r.completed), 0) : 0;
  // Projects run on the BoQ / schedule (no structural elements): overall progress = schedule earned % (v_progress_overview).
  const sched = useAsync(async () => (check(await supabase.from('v_progress_overview').select('pct_earned, pct_planned, leaf_tasks, completed_tasks')
    .eq('project_id', projectId).eq('level', 'project').limit(1)) as { pct_earned: number | null; pct_planned: number | null; leaf_tasks: number; completed_tasks: number }[])[0] ?? null,
  [projectId], { key: 'dashboard-schedule-progress', enabled: !!d && totalEl === 0, staleTime: 5 * 60_000 });
  const sp = d && totalEl === 0 ? sched.data ?? null : null;
  const delayed = d ? d.rollup.reduce((s, r) => s + Number(r.delayed), 0) : 0;
  const pending = d?.ageing.length ?? 0;
  const oldest = d ? d.ageing.reduce((m, r) => Math.max(m, Number(r.hours_waiting)), 0) : 0;
  const critical = d ? d.ageing.filter((r) => r.priority === 'critical').length : 0;
  const urgent = d ? d.ageing.filter((r) => r.priority !== 'normal').length : 0;
  const issuedCost = d ? d.cost.reduce((s, r) => s + Number(r.issued_cost ?? 0), 0) : 0;
  const plannedCost = d ? d.cost.reduce((s, r) => s + Number(r.planned_cost ?? 0), 0) : 0;

  // Needs attention — only non-zero, ordered by severity (BR-01 first).
  const attention: { sev: 'danger' | 'warning' | 'info'; text: string; to: string; cta: string }[] = [];
  if (d) {
    if (crit.data) attention.push({ sev: 'danger', text: `${crit.data} open critical alert${crit.data === 1 ? '' : 's'} (gate, theft or variance)`, to: '/alerts?severity=critical&status=open', cta: 'Review' });
    if (d.emergency) attention.push({ sev: 'danger', text: `${d.emergency} emergency issue${d.emergency === 1 ? '' : 's'} > 24 h not regularised (BR-01)`, to: '/approvals?type=emergency', cta: 'Review' });
    if (pending) attention.push({ sev: critical ? 'danger' : 'warning', text: `${pending} request${pending === 1 ? '' : 's'} waiting for approval · oldest ${num(oldest, 0)} h${critical ? ` · ${critical} critical` : urgent ? ` · ${urgent} urgent` : ''}`, to: '/approvals?type=mr', cta: 'Open inbox' });
    if (d.varCount) attention.push({ sev: 'warning', text: `${d.varCount} consumption variance alert${d.varCount === 1 ? '' : 's'} above threshold`, to: '/reports?r=consumption&over=1', cta: 'View' });
    if (d.lowStock) attention.push({ sev: 'warning', text: `${d.lowStock} item${d.lowStock === 1 ? '' : 's'} at or below reorder level`, to: '/store#low', cta: 'View' });
    if (d.pendVerify) attention.push({ sev: 'info', text: `${d.pendVerify} progress report${d.pendVerify === 1 ? '' : 's'} to verify`, to: '/approvals?type=progress', cta: 'Verify' });
    if (d.pendAdj + d.pendCnt) attention.push({ sev: 'info', text: `${d.pendAdj} adjustment${d.pendAdj === 1 ? '' : 's'} and ${d.pendCnt} stock count${d.pendCnt === 1 ? '' : 's'} to approve`, to: d.pendAdj ? '/approvals?type=adjustment' : '/approvals?type=count', cta: 'Open inbox' });
    const recv = nc.data?.byType.po_receive ?? 0, toSend = nc.data?.byType.po_send ?? 0;
    if (recv) attention.push({ sev: 'warning', text: `${recv} purchase order${recv === 1 ? '' : 's'} due to arrive — receive with a GRN`, to: '/store#incoming', cta: 'Receive' });
    if (toSend) attention.push({ sev: 'info', text: `${toSend} approved purchase order${toSend === 1 ? '' : 's'} to send to the supplier`, to: '/approvals?type=po_send', cta: 'Send' });
    for (const a of planAttn.data ?? []) attention.push(a);
    attention.sort((a, b) => ['danger', 'warning', 'info'].indexOf(a.sev) - ['danger', 'warning', 'info'].indexOf(b.sev));
    if (auth.profile?.role === 'office_engineer') attention.sort((a, b) => (a.to.includes('progress') ? -1 : b.to.includes('progress') ? 1 : 0));
  }

  const byBlock = new Map<string, { block: string; elements: number; completed: number; weighted: number; delayed: number }>();
  for (const r of d?.rollup ?? []) {
    const k = r.block_code ?? '—';
    const cur = byBlock.get(k) ?? { block: k, elements: 0, completed: 0, weighted: 0, delayed: 0 };
    cur.elements += Number(r.elements); cur.completed += Number(r.completed);
    cur.weighted += Number(r.avg_progress_pct) * Number(r.elements); cur.delayed += Number(r.delayed);
    byBlock.set(k, cur);
  }
  const buckets = [
    { label: '< 24 h', n: d?.ageing.filter((r) => Number(r.hours_waiting) < 24).length ?? 0 },
    { label: '24–48 h', n: d?.ageing.filter((r) => Number(r.hours_waiting) >= 24 && Number(r.hours_waiting) < 48).length ?? 0 },
    { label: '> 48 h', n: d?.ageing.filter((r) => Number(r.hours_waiting) >= 48).length ?? 0, warn: true },
  ];
  const maxBucket = Math.max(1, ...buckets.map((b) => b.n));

  return (
    <Page title="Dashboard" width="dash" subtitle={project ? `${project.code} · ${project.name}` : undefined}
      actions={<>
        <Tabs variant="segmented" label="Period" value={period} onChange={(p) => setF('period', p)} tabs={[{ key: 'today', label: 'Today' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }]} />
        <span className="dash-meta">{d ? `Updated ${since(d.at)}` : ''}</span>
        <button className="icon-btn" onClick={q.reload} aria-label="Refresh" title="Refresh"><RefreshCw size={16} className={q.loading ? 'spin' : ''} /></button>
      </>}>
      <ErrorBanner error={q.error} onRetry={q.reload} />

      {attention.length > 0 && (
        <section className="attention" aria-label="Needs attention">
          <div className="attention-head">Needs attention</div>
          {attention.map((a) => (
            <Link key={a.text} to={a.to} className="attention-item">
              {a.sev === 'danger' ? <Flame size={16} className="sev-danger" aria-hidden /> : a.sev === 'warning' ? <TriangleAlert size={16} className="sev-warning" aria-hidden /> : <Info size={16} className="sev-info" aria-hidden />}
              <span className="grow">{a.text}</span>
              <span className="go">{a.cta} <ArrowRight size={14} aria-hidden /></span>
            </Link>
          ))}
        </section>
      )}

      <div className="kpis">
        {sp
          ? <Kpi label="Overall progress" loading={loading} value={num(sp.pct_earned ?? 0, 1)} unit="%"
              hint={`${sp.completed_tasks} of ${sp.leaf_tasks} schedule tasks complete · planned ${num(sp.pct_planned ?? 0, 1)} %`} to={open('/evm')} />
          : <Kpi label="Overall progress" loading={loading} value={num(overall, 1)} unit="%" hint={`${completed} of ${totalEl} elements complete`} to={open('/progress#rollup')} />}
        <Kpi label="Delayed elements" loading={loading} value={delayed} status={delayed ? 'danger' : undefined} hint="Planned finish passed" to={open('/progress#delays')} />
        <Kpi label="Pending approvals" loading={loading} value={pending} status={critical ? 'danger' : pending ? 'warning' : undefined}
          hint={pending ? `Oldest ${num(oldest, 0)} h · ${urgent} urgent/critical` : 'Nothing waiting'}
          delta={d ? { value: d.subsNow - d.subsPrev, window: `submitted ${PERIOD_LABEL[period]}`, goodDirection: 'none' } : undefined}
          spark={d?.spark} to={open('/approvals?type=mr')} />
        <Kpi label="Low stock items" loading={loading} value={d?.lowStock ?? 0} status={d?.lowStock ? 'warning' : undefined} hint="At or below reorder level" to={open('/store#low')} />
        <Kpi label="Variance alerts" loading={loading} value={d?.varCount ?? 0} status={d?.varCount ? 'warning' : undefined}
          hint={Object.keys(thresholds).length ? 'Consumption above threshold' : 'No thresholds set (Project setup)'} to={open('/reports?r=consumption&over=1')} />
      </div>

      {d && (
        <div className="counters" aria-label="Other counters">
          <OptLink to="/approvals?type=adjustment" ok={!!open('/approvals?type=adjustment')}>Adjustments <strong className={d.pendAdj ? 'hot' : ''}>{d.pendAdj}</strong></OptLink>
          <OptLink to="/approvals?type=count" ok={!!open('/approvals?type=count')}>Counts <strong className={d.pendCnt ? 'hot' : ''}>{d.pendCnt}</strong></OptLink>
          <OptLink to="/approvals?type=progress" ok={!!open('/approvals?type=progress')}>To verify <strong className={d.pendVerify ? 'hot' : ''}>{d.pendVerify}</strong></OptLink>
          <OptLink to="/store?status=pending_ack#miv" ok={!!open('/store?status=pending_ack#miv')}>Awaiting receipt <strong>{d.pendAck}</strong></OptLink>
          <OptLink to="/reports?r=wastage" ok={!!open('/reports?r=wastage')}>Wastage write-offs <strong>{d.wasteNow}</strong> <span className="small-text">({d.wasteNow - d.wastePrev >= 0 ? '+' : ''}{d.wasteNow - d.wastePrev} {PERIOD_LABEL[period]})</span></OptLink>
          <OptLink to="/approvals?type=emergency" ok={!!open('/approvals?type=emergency')}>Emergency &gt; 24 h <strong className={d.emergency ? 'hot' : ''}>{d.emergency}</strong></OptLink>
          {canSeePrices && (
            <OptLink to="/reports?r=cost" ok={!!open('/reports?r=cost')}>Issued cost <strong>{money(issuedCost, project?.currency)}</strong>{plannedCost ? ` (${num((issuedCost / plannedCost) * 100, 0)} % of take-off)` : ''}</OptLink>
          )}
        </div>
      )}

      <div className="dash-grid">
        {lk.data ? (
          <Suspense fallback={<Card title="Progress: planned vs actual"><div style={{ height: 'var(--chart-h)' }}><Loading lines={5} /></div></Card>}>
            <SCurve L={lk.data} projectId={projectId} compact />
          </Suspense>
        ) : <Card title="Progress: planned vs actual"><Loading lines={5} /></Card>}
        <Card title="Progress by block" actions={open('/progress#rollup') && <Link to="/progress#rollup">Details <ArrowRight size={12} aria-hidden /></Link>}>
          <DataTable rows={[...byBlock.values()]} rowKey={(r) => r.block} loading={loading} maxHeight="none" columns={[
            { key: 'block', label: 'Block', id: true },
            { key: 'elements', label: 'Elements', align: 'right' },
            { key: 'completed', label: 'Done', align: 'right' },
            { key: 'delayed', label: 'Delayed', align: 'right', render: (r) => (r.delayed ? <span className="danger-text">{r.delayed}</span> : '0') },
            { key: 'pct', label: 'Progress', value: (r) => (r.elements ? r.weighted / r.elements : 0), render: (r) => <Bar pct={r.elements ? r.weighted / r.elements : 0} /> },
          ]} empty={{ title: 'No elements yet', body: 'Import them under Elements & BoQ.', action: open('/elements#import') && <Link to="/elements#import">Import elements</Link> }} />
        </Card>
        {canPay(auth.profile?.role, 'payment.view') && <PaymentsCard projectId={projectId} />}
        <Card title="Approvals ageing" sub={`${pending} waiting`} actions={open('/reports?r=ageing') && <Link to="/reports?r=ageing">Report <ArrowRight size={12} aria-hidden /></Link>}>
          {loading ? <Loading lines={3} /> : buckets.map((b) => (
            <div className="hbar-row" key={b.label}>
              <span className="muted">{b.label}</span>
              <div className={`bar${b.warn && b.n ? ' warn' : ''}`}><span style={{ width: `${(b.n / maxBucket) * 100}%` }} /></div>
              <span className="right tnum strong">{b.n}</span>
            </div>
          ))}
        </Card>
        <Card title="Consumption variance (top 10)" actions={open('/reports?r=consumption&over=1') && <Link to="/reports?r=consumption&over=1">All <ArrowRight size={12} aria-hidden /></Link>}>
          <DataTable rows={d?.varTop ?? []} loading={loading} maxHeight="none" rowKey={(r) => r.element_id + r.label} columns={[
            { key: 'element_code', label: 'Element', id: true },
            { key: 'label', label: 'Material' },
            { key: 'earned_qty', label: 'Earned', align: 'right', render: (r) => num(r.earned_qty) },
            { key: 'issued_qty', label: 'Issued', align: 'right', render: (r) => num(r.issued_qty) },
            { key: 'variance_pct', label: 'Var %', align: 'right', render: (r) => <span className="danger-text strong">{num(r.variance_pct, 1)}%</span> },
          ]} empty={Object.keys(thresholds).length ? 'No element is over its variance threshold.' : 'Set variance thresholds under Project setup to get alerts.'} />
        </Card>
      </div>
    </Page>
  );
}
