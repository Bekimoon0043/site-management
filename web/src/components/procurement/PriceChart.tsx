// recharts lives only in chart chunks — this module is imported with React.lazy from the price page.
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { PriceTrendRow } from '../../lib/contract-procurement';
import { num, shortDate } from '../../lib/format';
import { ChartTooltip, chartTheme } from '../charts/SCurve';

/** Weekly min / average / max price for one spec, 90-day average reference, spike weeks marked. */
export function PriceChart({ rows, currency }: { rows: PriceTrendRow[]; currency: string }) {
  const data = [...rows].sort((a, b) => a.week.localeCompare(b.week)).map((r) => ({
    week: r.week, avg: Number(r.avg_price), min: Number(r.min_price), max: Number(r.max_price), spike: r.has_spike,
  }));
  const avg90 = rows[0]?.avg_90d ?? null;
  return (
    <div className="chart-box" role="img" aria-label="Weekly price trend">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid {...chartTheme.grid} />
          <XAxis dataKey="week" {...chartTheme.axis} tickFormatter={(v: string) => shortDate(v)} minTickGap={24} />
          <YAxis {...chartTheme.axis} width={72} tickCount={5} tickFormatter={(v: number) => num(v, 0)} domain={['auto', 'auto']} />
          <Tooltip cursor={chartTheme.cursor} content={<ChartTooltip unit={` ${currency}`} labelFormat={(l) => `Week of ${shortDate(l)}`} />} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
          {avg90 !== null && <ReferenceLine y={Number(avg90)} {...chartTheme.planned} label={{ value: '90-day avg', position: 'insideTopRight', fill: 'var(--chart-axis)', fontSize: 11 }} />}
          <Line type="monotone" dataKey="max" name="Max" stroke="var(--chart-planned)" strokeWidth={1} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="min" name="Min" stroke="var(--chart-planned)" strokeWidth={1} strokeDasharray="2 3" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="avg" name="Average" stroke="var(--primary)" {...chartTheme.actual} isAnimationActive={false}
            dot={(p: { cx?: number; cy?: number; index?: number; payload?: { spike: boolean } }) => (
              <circle key={p.index} cx={p.cx} cy={p.cy} r={p.payload?.spike ? 5 : 2.5} fill={p.payload?.spike ? 'var(--danger)' : 'var(--primary)'} stroke="none" />
            )} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
