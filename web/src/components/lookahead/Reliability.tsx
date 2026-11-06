// Plan reliability: PPC trend (+ rolling 4 weeks, target), reasons-for-miss Pareto (plain bars), PPC by planner, constraint removal.
import { lazy, Suspense, useState } from 'react';
import { useAsync } from '../../lib/hooks';
import { fetchAll, supabase } from '../../lib/supabase';
import { num } from '../../lib/format';
import type { CalendarMode, ConstraintType, LookaheadPlan, PpcWeek, RncCode } from '../../lib/contract-lookahead';
import { DataTable } from '../DataTable';
import { Card, ErrorBanner, Loading } from '../Page';
import { Tabs } from '../Tabs';
import { isAm, tr } from '../evm/data';
import { ctypeLabel } from './la';

const PpcChart = lazy(() => import('./PpcChart').then((m) => ({ default: m.PpcChart })));

interface Pareto { rnc_code: RncCode; label: string; label_am: string | null; total: number; last_8_weeks: number; pct: number; cumulative_pct: number; rank: number }
interface Removal { plan_id: string; ctype: ConstraintType; owner_id: string | null; owner_name: string | null; owner_role: string | null; total: number; open: number; due: number; cleared_on_time: number; cleared_late: number; overdue: number; pcr: number | null; avg_open_age_days: number | null; max_open_age_days: number | null }
interface ByResp { week_id: string; plan_id: string; committed_by: string; full_name: string | null; committed: number; completed: number; ppc: number | null }

export function Reliability({ projectId, plan, mode, target }: { projectId: string; plan: LookaheadPlan | null; mode: CalendarMode; target: number }) {
  const am = isAm();
  const [win, setWin] = useState<'8w' | 'all'>('8w');
  const q = useAsync(async () => {
    const [ppc, pareto, removal, resp] = await Promise.all([
      fetchAll<PpcWeek & { calendar_mode: CalendarMode }>((a, b) => supabase.from('v_ppc').select('*').eq('project_id', projectId).eq('calendar_mode', mode).order('week_start').range(a, b)),
      fetchAll<Pareto>((a, b) => supabase.from('v_rnc_pareto').select('*').eq('project_id', projectId).order('rank').range(a, b)),
      plan ? fetchAll<Removal>((a, b) => supabase.from('v_constraint_removal').select('*').eq('plan_id', plan.id).range(a, b)) : Promise.resolve([] as Removal[]),
      plan ? fetchAll<ByResp>((a, b) => supabase.from('v_ppc_by_responsible').select('*').eq('plan_id', plan.id).range(a, b)) : Promise.resolve([] as ByResp[]),
    ]);
    return { ppc, pareto, removal, resp };
  }, [projectId, plan?.id, mode], { key: 'la-reliability' });
  const d = q.data;
  const closed = (d?.ppc ?? []).filter((w) => w.status === 'closed' && w.committed > 0);
  const last = closed[closed.length - 1];
  const pareto = (d?.pareto ?? []).map((p) => ({ ...p, n: win === '8w' ? Number(p.last_8_weeks) : Number(p.total) })).filter((p) => p.n > 0).sort((a, b) => b.n - a.n);
  const maxN = Math.max(1, ...pareto.map((p) => p.n));
  const totN = pareto.reduce((s, p) => s + p.n, 0);
  let cum = 0;
  const people = new Map<string, { name: string; committed: number; completed: number }>();
  for (const r of d?.resp ?? []) {
    const cur = people.get(r.committed_by) ?? { name: r.full_name ?? '?', committed: 0, completed: 0 };
    cur.committed += Number(r.committed); cur.completed += Number(r.completed);
    people.set(r.committed_by, cur);
  }

  return (
    <div className="stack">
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <div className="dash-grid">
        <Card title={tr('Plan reliability (PPC)', 'የዕቅድ አፈጻጸም (PPC)')} sub={last ? (am ? `ባለፈው ሳምንት ${last.completed}/${last.committed} · ${Math.round(Number(last.ppc ?? 0))}%` : `Last closed week ${last.completed}/${last.committed} · ${Math.round(Number(last.ppc ?? 0))} %`) : undefined}>
          {!d ? <Loading lines={5} /> : <Suspense fallback={<Loading lines={5} />}><PpcChart weeks={d.ppc} target={target} /></Suspense>}
          <p className="muted small-text mb-0">PPC = tasks completed ÷ tasks committed. Above {target} % means the weekly plan is reliable.</p>
        </Card>
        <Card title={tr('Why work was not finished', 'ሥራ ያልተጠናቀቀበት ምክንያት')} actions={<Tabs variant="segmented" label="Window" value={win} onChange={setWin} tabs={[{ key: '8w', label: tr('8 weeks', '8 ሳምንት') }, { key: 'all', label: tr('All', 'ሁሉም') }]} />}>
          {!d ? <Loading lines={5} /> : !pareto.length ? <p className="muted mb-0">{tr('No missed commitments recorded.', 'ያልተጠናቀቀ ቃል የለም።')}</p> : pareto.map((p) => {
            cum += p.n;
            return (
              <div className="pareto-row" key={p.rnc_code}>
                <span className="truncate" title={p.label}>{am && p.label_am ? p.label_am : p.label}</span>
                <div className="pareto-bar" role="img" aria-label={`${p.n}`}><span style={{ width: `${(p.n / maxN) * 100}%` }} /></div>
                <span className="right tnum"><strong>{p.n}</strong> <span className="muted">· {Math.round((100 * cum) / totN)} %</span></span>
              </div>
            );
          })}
        </Card>
      </div>
      {plan && (
        <div className="grid-2">
          <Card flush title={tr('Constraint removal', 'የእንቅፋት መፍታት')} sub={tr('Cleared by the due date, per owner and type', 'በጊዜው የተፈቱ')}>
            <DataTable rows={d?.removal ?? []} loading={!d} rowKey={(r) => `${r.ctype}:${r.owner_id ?? r.owner_role}`} maxHeight="none" exportName="constraint-removal"
              empty={tr('No constraints in this plan.', 'እንቅፋት የለም።')} defaultSort={{ key: 'overdue', dir: 'desc' }}
              columns={[
                { key: 'owner', label: tr('Owner', 'ኃላፊ'), render: (r) => r.owner_name ?? (r.owner_role ? r.owner_role.replace('_', ' ') : '—'), value: (r) => r.owner_name ?? r.owner_role },
                { key: 'ctype', label: tr('Type', 'ዓይነት'), render: (r) => ctypeLabel(r.ctype) },
                { key: 'open', label: tr('Open', 'ክፍት'), align: 'right' },
                { key: 'overdue', label: tr('Overdue', 'ያለፈ'), align: 'right', render: (r) => (Number(r.overdue) ? <span className="danger-text strong">{r.overdue}</span> : '0'), value: (r) => Number(r.overdue) },
                { key: 'pcr', label: tr('On time', 'በጊዜ'), align: 'right', render: (r) => (r.pcr == null ? '—' : `${Math.round(Number(r.pcr))} %`) },
                { key: 'avg_open_age_days', label: tr('Avg age', 'አማካይ ዕድሜ'), align: 'right', render: (r) => (r.avg_open_age_days == null ? '—' : `${num(r.avg_open_age_days, 0)} d`) },
              ]} />
          </Card>
          <Card flush title={tr('PPC by planner', 'PPC በኃላፊ')}>
            <DataTable rows={[...people.entries()].map(([id, v]) => ({ id, ...v }))} loading={!d} rowKey={(r) => r.id} maxHeight="none"
              empty={tr('No commitments in this plan yet.', 'ገና ቃል አልተገባም።')}
              columns={[
                { key: 'name', label: tr('Planner', 'ኃላፊ') },
                { key: 'committed', label: tr('Committed', 'ቃል'), align: 'right' },
                { key: 'completed', label: tr('Done', 'የተጠናቀቀ'), align: 'right' },
                { key: 'ppc', label: 'PPC', align: 'right', value: (r) => (r.committed ? r.completed / r.committed : null), render: (r) => (r.committed ? `${Math.round((100 * r.completed) / r.committed)} %` : '—') },
              ]} />
          </Card>
        </div>
      )}
    </div>
  );
}
