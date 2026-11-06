// recharts lives only in this chunk — import it with React.lazy so it never lands in the initial bundle.
import { useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import { useAsync, type Lookups } from '../../lib/hooks';
import { fetchAll, supabase } from '../../lib/supabase';
import type { ElementActivity, ProgressUpdate } from '../../lib/contract';
import { shortDate, today } from '../../lib/format';
import { DataTable } from '../DataTable';
import { Card, ErrorBanner, Loading } from '../Page';
import { Tabs } from '../Tabs';

/** Shared recharts props (spec §2.6): horizontal solid gridlines, quiet axes, ≤5 y ticks. */
export const chartTheme = {
  grid: { stroke: 'var(--chart-grid)', vertical: false },
  axis: { stroke: 'none', tick: { fill: 'var(--chart-axis)', fontSize: 11 }, tickLine: false },
  planned: { stroke: 'var(--chart-planned)', strokeDasharray: '4 4', strokeWidth: 1.5 },
  actual: { strokeWidth: 2 },
  cursor: { stroke: 'var(--border-strong)', strokeWidth: 1 },
};

/** Tooltip: surface card, x header, swatch + series name in text colour + right-aligned tabular value. */
export function ChartTooltip({ active, payload, label, unit = '', labelFormat }: Partial<TooltipContentProps<number, string>> & { unit?: string; labelFormat?: (l: unknown) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="ct-head">{labelFormat ? labelFormat(label) : String(label)}</div>
      {payload.filter((p) => p.value !== undefined && p.value !== null).map((p) => (
        <div className="ct-row" key={String(p.dataKey)}>
          <span className="sw" style={{ background: p.color }} /><span>{p.name}</span><span className="v">{p.value}{unit}</span>
        </div>
      ))}
    </div>
  );
}

interface Point { date: string; planned: number; actual?: number; reported?: number }

/**
 * Planned vs actual S-curve with a Table toggle (accessibility fallback + Excel export).
 * Planned: share of each element's planned duration elapsed. Actual: verified activity progress by weight.
 * Reported (unverified) dotted. Today reference line.
 */
export function SCurve({ L, projectId, compact }: { L: Lookups; projectId: string; compact?: boolean }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const q = useAsync(async () => {
    const [acts, updates] = await Promise.all([
      fetchAll<Pick<ElementActivity, 'id' | 'element_id' | 'weight'>>((a, b) => supabase.from('element_activities').select('id, element_id, weight').eq('project_id', projectId).range(a, b)),
      fetchAll<Pick<ProgressUpdate, 'element_activity_id' | 'status' | 'pct_complete' | 'verified_pct' | 'created_at'> & { verified_at: string | null }>((a, b) => supabase.from('progress_updates')
        .select('element_activity_id, status, pct_complete, verified_pct, verified_at, created_at').eq('project_id', projectId)
        .in('status', ['verified', 'adjusted', 'reported']).order('created_at').range(a, b)),
    ]);
    return { acts, updates };
  }, [projectId], { key: 'scurve' });

  const data = useMemo<Point[]>(() => {
    if (!q.data) return [];
    const els = L.elements.filter((e) => e.planned_start && e.planned_finish);
    if (!els.length) return [];
    const start = new Date(els.reduce((m, e) => (e.planned_start! < m ? e.planned_start! : m), els[0].planned_start!));
    const endStr = els.reduce((m, e) => (e.planned_finish! > m ? e.planned_finish! : m), els[0].planned_finish!);
    const end = new Date(endStr > today() ? endStr : today());
    const now = Date.now();
    const actsByEl = new Map<string, Pick<ElementActivity, 'id' | 'element_id' | 'weight'>[]>();
    for (const a of q.data.acts) actsByEl.set(a.element_id, [...(actsByEl.get(a.element_id) ?? []), a]);
    const weight = (e: string) => (actsByEl.get(e) ?? []).reduce((s, a) => s + Number(a.weight), 0);
    const verified = q.data.updates.filter((u) => u.status !== 'reported' && u.verified_at && u.verified_pct !== null)
      .sort((a, b) => String(a.verified_at).localeCompare(String(b.verified_at)));
    const reported = q.data.updates;
    const points: Point[] = [];
    const step = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000 / 60)) * 86400000;
    const progressAt = (t: number, src: typeof reported, pctOf: (u: (typeof reported)[number]) => number, at: (u: (typeof reported)[number]) => string) => {
      const latest = new Map<string, number>();
      for (const u of src) if (new Date(at(u)).getTime() <= t) latest.set(u.element_activity_id, pctOf(u));
      let sum = 0;
      for (const e of els) {
        const w = weight(e.id);
        if (w > 0) sum += (actsByEl.get(e.id) ?? []).reduce((s, a) => s + Number(a.weight) * (latest.get(a.id) ?? 0), 0) / w / 100;
      }
      return Math.round((sum / els.length) * 1000) / 10;
    };
    for (let t = start.getTime(); t <= end.getTime() + step; t += step) {
      let planned = 0;
      for (const e of els) {
        const s = new Date(e.planned_start!).getTime(), f = new Date(e.planned_finish!).getTime() + 86400000;
        planned += t <= s ? 0 : t >= f ? 1 : (t - s) / (f - s);
      }
      const p: Point = { date: new Date(t).toISOString().slice(0, 10), planned: Math.round((planned / els.length) * 1000) / 10 };
      if (t <= now + step) {
        p.actual = progressAt(t, verified, (u) => Number(u.verified_pct), (u) => String(u.verified_at));
        p.reported = progressAt(t, reported, (u) => Number(u.pct_complete), (u) => u.created_at);
      }
      points.push(p);
    }
    return points;
  }, [q.data, L.elements]);

  const body = !q.data ? (q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <div style={{ height: 'var(--chart-h)' }}><Loading lines={5} /></div>)
    : !data.length ? <p className="muted">Add planned start and finish dates to elements to see the S-curve (FR-PG-09).</p>
    : view === 'table' ? (
      <DataTable rows={data} rowKey={(r) => r.date} exportName="s-curve" maxHeight="var(--chart-h)" columns={[
        { key: 'date', label: 'Date', render: (r) => shortDate(r.date) },
        { key: 'planned', label: 'Planned %', align: 'right' },
        { key: 'actual', label: 'Verified %', align: 'right' },
        { key: 'reported', label: 'Reported %', align: 'right' },
      ]} />
    ) : (
      <div className="chart-box">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -12 }}>
            <CartesianGrid {...chartTheme.grid} />
            <XAxis dataKey="date" {...chartTheme.axis} minTickGap={40} tickFormatter={(d) => shortDate(d)} />
            <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} unit="%" {...chartTheme.axis} />
            <Tooltip cursor={chartTheme.cursor} content={<ChartTooltip unit="%" labelFormat={(l) => shortDate(l)} />} />
            <Legend verticalAlign="top" align="left" height={28} iconType="plainline" wrapperStyle={{ fontSize: 12, color: 'var(--text)' }} />
            <ReferenceLine x={data.reduce((best, p) => (p.date <= today() ? p.date : best), data[0].date)} stroke="var(--border-strong)" strokeDasharray="2 3" label={{ value: 'Today', fill: 'var(--chart-axis)', fontSize: 11, position: 'insideTopRight' }} />
            <Line type="monotone" dataKey="planned" name="Planned" dot={false} {...chartTheme.planned} />
            <Line type="monotone" dataKey="reported" name="Reported (unverified)" stroke="var(--chart-1)" strokeOpacity={0.45} strokeDasharray="1 3" strokeWidth={2} dot={false} connectNulls={false} />
            <Line type="monotone" dataKey="actual" name="Verified" stroke="var(--chart-1)" dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} {...chartTheme.actual} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );

  return (
    <Card title="Progress: planned vs actual" sub={compact ? undefined : 'Planned = share of planned duration elapsed · Verified = activity progress weighted by activity weights'}
      actions={<Tabs variant="segmented" value={view} onChange={setView} tabs={[{ key: 'chart', label: 'Chart' }, { key: 'table', label: 'Table' }]} />}>
      {body}
    </Card>
  );
}
