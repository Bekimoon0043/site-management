// recharts lives only in this chunk — import with React.lazy.
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { PpcWeek } from '../../lib/contract-lookahead';
import { shortDate } from '../../lib/format';
import { ChartTooltip, chartTheme } from '../charts/SCurve';
import { isAm } from '../evm/data';

/** PPC per closed week (bars), rolling 4-week PPC (line), target (reference line). */
export function PpcChart({ weeks, target }: { weeks: PpcWeek[]; target: number }) {
  const am = isAm();
  const data = weeks.filter((w) => w.committed > 0).map((w) => ({
    x: w.week_start, ppc: w.ppc == null ? undefined : Math.round(Number(w.ppc)), roll: w.ppc_rolling_4w == null ? undefined : Math.round(Number(w.ppc_rolling_4w)),
  }));
  if (!data.length) return <p className="muted">{am ? 'ገና የተዘጋ ሳምንት የለም።' : 'No weeks with commitments yet.'}</p>;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid {...chartTheme.grid} />
        <XAxis dataKey="x" {...chartTheme.axis} tickFormatter={(v) => shortDate(v)} minTickGap={16} />
        <YAxis {...chartTheme.axis} domain={[0, 100]} width={36} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip cursor={chartTheme.cursor} content={<ChartTooltip unit="%" labelFormat={(l) => `${am ? 'ሳምንት' : 'Week of'} ${shortDate(l)}`} />} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
        <ReferenceLine y={target} stroke="var(--success)" strokeDasharray="4 3" label={{ value: `${am ? 'ዒላማ' : 'Target'} ${target}%`, fill: 'var(--text-muted)', fontSize: 11, position: 'insideTopLeft' }} />
        <Bar dataKey="ppc" name={am ? 'የሳምንቱ PPC' : 'PPC (week)'} fill="var(--chart-1)" radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        <Line type="monotone" dataKey="roll" name={am ? '4 ሳምንት አማካይ' : 'Rolling 4 weeks'} stroke="var(--chart-3)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
