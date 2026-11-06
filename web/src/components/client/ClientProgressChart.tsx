import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { shortDate } from '../../lib/format';
import { ChartTooltip, chartTheme } from '../charts/SCurve';

export interface ClientProgressPoint {
  period_end: string;
  pct_planned: number | null;
  pct_verified: number | null;
  spi: number | null;
  forecast_finish: string | null;
  verified_through: string | null;
}

export function ClientProgressChart({ rows }: { rows: ClientProgressPoint[] }) {
  const data = rows.map((r) => ({
    date: r.period_end,
    planned: r.pct_planned == null ? undefined : Number(r.pct_planned),
    verified: r.pct_verified == null ? undefined : Number(r.pct_verified),
  }));
  if (!data.length) return <p className="muted">No verified progress history is available yet.</p>;
  return (
    <div className="client-progress-chart" role="img" aria-label="Planned and verified progress history">
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 12, right: 18, bottom: 4, left: 0 }}>
          <CartesianGrid {...chartTheme.grid} />
          <XAxis dataKey="date" {...chartTheme.axis} tickFormatter={(v) => shortDate(String(v))} minTickGap={22} />
          <YAxis {...chartTheme.axis} domain={[0, 100]} width={42} tickFormatter={(v: number) => `${v}%`} />
          <Tooltip cursor={chartTheme.cursor} content={<ChartTooltip unit=" %" labelFormat={(v) => shortDate(String(v))} />} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="planned" name="Planned" stroke="var(--chart-planned)" strokeDasharray="5 4" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="verified" name="Verified complete" stroke="var(--chart-1)" strokeWidth={2.5} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Fixed-size SVG used by the A4 print/PDF report; it renders even while the report is hidden on screen. */
export function ClientProgressPrintChart({ rows }: { rows: ClientProgressPoint[] }) {
  if (rows.length < 2) return <p>No progress history is available yet.</p>;
  const w = 720, h = 220, pad = 34;
  const x = (i: number) => pad + (i * (w - pad * 2)) / Math.max(rows.length - 1, 1);
  const y = (v: number | null) => h - pad - (Math.max(0, Math.min(100, Number(v ?? 0))) * (h - pad * 2)) / 100;
  const path = (key: 'pct_planned' | 'pct_verified') => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ');
  return (
    <svg className="client-print-chart" viewBox={`0 0 ${w} ${h}`} aria-label="Planned versus verified progress">
      {[0, 25, 50, 75, 100].map((v) => <g key={v}><line x1={pad} x2={w - pad} y1={y(v)} y2={y(v)} stroke="#d1d5db" /><text x={4} y={y(v) + 4} fontSize="11">{v}%</text></g>)}
      <path d={path('pct_planned')} fill="none" stroke="#64748b" strokeWidth="2" strokeDasharray="7 5" />
      <path d={path('pct_verified')} fill="none" stroke="#0f766e" strokeWidth="3" />
      <text x={pad} y={h - 6} fontSize="10">{shortDate(rows[0].period_end)}</text>
      <text x={w - pad} y={h - 6} textAnchor="end" fontSize="10">{shortDate(rows.at(-1)?.period_end ?? '')}</text>
      <g transform={`translate(${w - 220},12)`}><line x2="28" y1="4" y2="4" stroke="#64748b" strokeDasharray="7 5" strokeWidth="2" /><text x="34" y="8" fontSize="11">Planned</text><line x1="105" x2="133" y1="4" y2="4" stroke="#0f766e" strokeWidth="3" /><text x="139" y="8" fontSize="11">Verified</text></g>
    </svg>
  );
}
