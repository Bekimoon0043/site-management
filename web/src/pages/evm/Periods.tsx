import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { fetchAll, supabase } from '../../lib/supabase';
import { date, dateTime, num } from '../../lib/format';
import { useUrlFilters, useUrlParam } from '../../lib/url';
import { Card, DataTable, Drawer, Empty, ErrorBanner, Field, Loading, Modal, Page, Tabs, toast, useBusy } from '../../components/ui';
import { PeriodPanel, PeriodStatusBadge } from '../../components/evm/PeriodPanel';
import { addDays, has, idx, moneyShort, PERIOD_OPEN_ROLES, planRpc, tr, useSchedules, usePeriods, type PeriodRow } from '../../components/evm/data';
import '../../components/evm/evm.css';

type Hist = { period_id: string; pct_planned: number | null; pct_earned: number | null; spi: number | null; spi_t: number | null; sv_t_days: number | null; forecast_finish: string | null };
type HistMoney = { period_id: string; bac: number; ev: number; ac: number; cpi: number | null; eac: number | null; vac: number | null };

/** Progress periods: open → prepare close (checklist, variance notes) → close (coordinator/manager) → reopen (manager). */
export function EvmPeriods() {
  const projectId = useProjectId();
  const auth = useAuth();
  const role = auth.profile?.role;
  const money = auth.canSeePrices;
  const currency = auth.project?.currency ?? 'ETB';
  const lk = useLookups(projectId);
  const [f, setF] = useUrlFilters({ s: '' });
  const [openId, setOpenId] = useUrlParam('open');
  const [creating, setCreating] = useState(false);
  const sch = useSchedules(projectId);
  const schedule = sch.data?.find((s) => s.id === f.s) ?? sch.data?.[0];
  const per = usePeriods(schedule?.id);
  const periods = per.data ?? [];
  const closed = periods.filter((p) => p.status === 'closed');
  const latestClosed = [...closed].sort((a, b) => b.status_date.localeCompare(a.status_date))[0];
  const current = periods.find((p) => p.id === openId) ?? null;

  const hist = useAsync(async () => {
    const ids = closed.map((p) => p.id);
    if (!ids.length) return { s: [] as Hist[], m: [] as HistMoney[] };
    const [s, m] = await Promise.all([
      fetchAll<Hist>((a, b) => supabase.from('evm_task_status').select('period_id, pct_planned, pct_earned, spi, spi_t, sv_t_days, forecast_finish').in('period_id', ids).eq('level', 'project').range(a, b)),
      money ? fetchAll<HistMoney>((a, b) => supabase.from('evm_snapshots').select('period_id, bac, ev, ac, cpi, eac, vac').in('period_id', ids).eq('level', 'project').range(a, b)) : Promise.resolve([]),
    ]);
    return { s, m };
  }, [closed.map((p) => p.id).join(), money], { key: 'evm-period-history', enabled: closed.length > 0 });
  const hs = new Map((hist.data?.s ?? []).map((r) => [r.period_id, r]));
  const hm = new Map((hist.data?.m ?? []).map((r) => [r.period_id, r]));
  const openKinds = new Set(periods.filter((p) => p.status !== 'closed').map((p) => p.kind));

  return (
    <Page title={tr('Progress periods', 'የሂደት ወቅቶች')} breadcrumbs={[{ label: tr('Earned value', 'የተገኘ እሴት'), to: '/evm' }, { label: tr('Periods', 'ወቅቶች') }]}
      subtitle={schedule ? `${schedule.code} · ${schedule.name} · Close each month so the numbers are frozen for reporting` : undefined}
      actions={has(PERIOD_OPEN_ROLES, role) && schedule && <button className="primary" onClick={() => setCreating(true)} disabled={openKinds.has('monthly') && openKinds.has('weekly')}><Plus size={14} aria-hidden />{tr('Open period', 'ወቅት ክፈት')}</button>}>
      {(sch.data?.length ?? 0) > 1 && <Tabs variant="segmented" label="Schedule" value={schedule?.id ?? ''} onChange={(v) => setF('s', v)} tabs={sch.data!.map((s) => ({ key: s.id, label: s.code }))} />}
      <ErrorBanner error={sch.error ?? per.error} onRetry={per.reload} />
      {sch.data && !sch.data.length ? <Empty title="No schedule yet">Import the MS Project schedule first.</Empty> : (
        <>
          <Card flush title={tr('Periods', 'ወቅቶች')}>
            <DataTable rows={periods} loading={!per.data && !per.error} rowKey={(r) => r.id} activeKey={openId} onRowClick={(r) => setOpenId(r.id, true)} exportName="evm-periods"
              empty={{ title: 'No periods yet', body: 'Open the first monthly period with its cut-off (status) date.', action: has(PERIOD_OPEN_ROLES, role) ? <button onClick={() => setCreating(true)}>Open period</button> : undefined }}
              columns={[
                { key: 'period_no', label: '#', id: true, render: (r) => `${r.kind === 'weekly' ? 'W' : 'M'}-${r.period_no}` },
                { key: 'period_start', label: tr('From', 'ከ'), render: (r) => date(r.period_start) },
                { key: 'status_date', label: tr('Cut-off', 'መቁረጫ'), render: (r) => date(r.status_date) },
                { key: 'status', label: tr('Status', 'ሁኔታ'), render: (r) => <PeriodStatusBadge status={r.status} /> },
                { key: 'pp', label: tr('Planned', 'የታቀደ'), align: 'right', render: (r) => (hs.get(r.id) ? `${num(hs.get(r.id)!.pct_planned, 1)} %` : r.prepared_summary?.pct_planned != null ? `${num(r.prepared_summary.pct_planned, 1)} %` : '') },
                { key: 'pe', label: tr('Earned', 'የተሰራ'), align: 'right', render: (r) => (hs.get(r.id) ? `${num(hs.get(r.id)!.pct_earned, 1)} %` : r.prepared_summary?.pct_earned != null ? `${num(r.prepared_summary.pct_earned, 1)} %` : '') },
                { key: 'spi', label: 'SPI', align: 'right', render: (r) => idx(hs.get(r.id)?.spi ?? r.prepared_summary?.spi) },
                ...(money ? [{ key: 'cpi', label: 'CPI', align: 'right' as const, render: (r: PeriodRow) => idx(hm.get(r.id)?.cpi ?? r.prepared_summary?.cpi) }] : []),
                { key: 'closed_at', label: tr('Closed', 'የተዘጋ'), render: (r) => (r.closed_at ? `${dateTime(r.closed_at)} · ${lk.data?.person(r.closed_by) ?? ''}` : '') },
              ]} />
          </Card>
          {closed.length > 0 && (
            <Card flush title={tr('Snapshot history', 'የቅጽበታዊ ታሪክ')} sub={tr('Frozen at each close', 'በእያንዳንዱ መዝጊያ የተቀመጠ')}>
              <DataTable rows={closed} rowKey={(r) => r.id} loading={!hist.data && !hist.error} error={hist.error} exportName="evm-snapshots" maxHeight="none"
                onRowClick={(r) => setOpenId(r.id, true)}
                columns={[
                  { key: 'status_date', label: tr('Cut-off', 'መቁረጫ'), id: true, render: (r) => date(r.status_date) },
                  { key: 'pp', label: tr('% planned', 'የታቀደ %'), align: 'right', render: (r) => num(hs.get(r.id)?.pct_planned, 1), value: (r) => hs.get(r.id)?.pct_planned },
                  { key: 'pe', label: tr('% earned', 'የተሰራ %'), align: 'right', render: (r) => num(hs.get(r.id)?.pct_earned, 1), value: (r) => hs.get(r.id)?.pct_earned },
                  { key: 'spi', label: 'SPI', align: 'right', render: (r) => idx(hs.get(r.id)?.spi) },
                  { key: 'spi_t', label: 'SPI(t)', align: 'right', render: (r) => idx(hs.get(r.id)?.spi_t) },
                  { key: 'svt', label: tr('Days ±', 'ቀን ±'), align: 'right', render: (r) => num(hs.get(r.id)?.sv_t_days, 0) },
                  { key: 'ff', label: tr('Forecast finish', 'የሚጠበቅ ማጠናቀቂያ'), render: (r) => date(hs.get(r.id)?.forecast_finish) },
                  ...(money ? [
                    { key: 'ev', label: 'EV', align: 'right' as const, render: (r: PeriodRow) => moneyShort(hm.get(r.id)?.ev, currency), value: (r: PeriodRow) => hm.get(r.id)?.ev },
                    { key: 'ac', label: 'AC', align: 'right' as const, render: (r: PeriodRow) => moneyShort(hm.get(r.id)?.ac, currency), value: (r: PeriodRow) => hm.get(r.id)?.ac },
                    { key: 'cpi', label: 'CPI', align: 'right' as const, render: (r: PeriodRow) => idx(hm.get(r.id)?.cpi) },
                    { key: 'eac', label: 'EAC', align: 'right' as const, render: (r: PeriodRow) => moneyShort(hm.get(r.id)?.eac, currency), value: (r: PeriodRow) => hm.get(r.id)?.eac },
                  ] : []),
                ]} />
            </Card>
          )}
        </>
      )}

      {current && (
        <Drawer title={`${current.kind === 'weekly' ? 'Week' : 'Period'} ${current.period_no}`} subtitle={`${date(current.period_start)} – ${date(current.status_date)}`} onClose={() => setOpenId(null)} size="lg">
          {lk.data ? <PeriodPanel period={current} L={lk.data} latestClosedId={latestClosed?.id ?? null} /> : <Loading lines={6} />}
        </Drawer>
      )}
      {creating && schedule && <OpenPeriodModal scheduleId={schedule.id} periods={periods} defaultStart={schedule.planned_start} onClose={() => setCreating(false)} onOpened={(id) => setOpenId(id, true)} />}
    </Page>
  );
}

function OpenPeriodModal({ scheduleId, periods, defaultStart, onClose, onOpened }: {
  scheduleId: string; periods: PeriodRow[]; defaultStart: string | null; onClose: () => void; onOpened: (id: string) => void;
}) {
  const [kind, setKind] = useState<'monthly' | 'weekly'>('monthly');
  const last = periods.filter((p) => p.kind === kind).sort((a, b) => b.period_no - a.period_no)[0];
  const start = last ? addDays(last.status_date, 1) : defaultStart ?? '';
  const monthEnd = (d: string) => { if (!d) return ''; const t = new Date(`${d}T00:00:00Z`); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };
  const [cut, setCut] = useState(kind === 'monthly' ? monthEnd(start) : start ? addDays(start, 6) : '');
  const { busy, error, run } = useBusy();
  const blocked = periods.some((p) => p.kind === kind && p.status !== 'closed');
  const save = () => run(async () => {
    const id = crypto.randomUUID();
    const r = await planRpc('open_period', { id, schedule_id: scheduleId, kind, status_date: cut });
    toast.success(`Period ${String(r.period_no ?? '')} opened (cut-off ${date(cut)})`);
    onClose(); onOpened(id);
  });
  return (
    <Modal title="Open progress period" onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !cut || blocked} onClick={() => void save()}>{busy && <span className="spinner" />}Open period</button>
    </>}>
      <ErrorBanner error={error ?? (blocked ? `Close the current ${kind} period before opening the next one.` : null)} />
      <div className="form-grid">
        <Field label="Kind"><select value={kind} onChange={(e) => { const k = e.target.value as 'monthly' | 'weekly'; setKind(k); setCut(''); }}>
          <option value="monthly">Monthly</option><option value="weekly">Weekly</option>
        </select></Field>
        <Field label="Starts" hint={last ? 'Periods are contiguous' : 'First period starts at the schedule start'}><input value={start ? date(start) : '—'} disabled /></Field>
        <Field label="Cut-off (status) date" required hint="Progress and costs are measured up to this day."><input type="date" value={cut} min={start || undefined} data-autofocus onChange={(e) => setCut(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
