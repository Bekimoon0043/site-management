// recharts lives only in this chunk — import it with React.lazy (pages/evm/Evm.tsx).
import { useMemo } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { EvmTimeseriesRow } from '../../lib/contract-schedule';
import { shortDate } from '../../lib/format';
import { ChartTooltip, chartTheme } from '../charts/SCurve';
import { isAm } from './data';

const compact = (v: number) => {
  const a = Math.abs(v);
  return a >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : String(Math.round(v));
};
const round = (v: number | null | undefined) => (v == null ? undefined : Math.round(v));

/** Cumulative PV / EV / AC + EAC forecast line (follows the PV shape from the status date to completion). */
export function EvmSCurve({ rows, bac, eac, statusDate, currency = 'ETB' }: {
  rows: EvmTimeseriesRow[]; bac: number | null; eac: number | null; statusDate: string | null; currency?: string;
}) {
  const am = isAm();
  const data = useMemo(() => {
    const actual = rows.filter((r) => r.is_actual);
    const last = actual[actual.length - 1];
    const pvNow = last ? Number(last.pv) : 0;
    const acNow = last ? Number(last.ac ?? 0) : 0;
    const span = (bac ?? 0) - pvNow;
    return rows.map((r) => {
      const pv = Number(r.pv);
      let fc: number | undefined;
      if (eac != null && last && r.period_end >= last.period_end) {
        fc = span > 0 ? acNow + ((eac - acNow) * Math.max(0, pv - pvNow)) / span : r.period_end === last.period_end ? acNow : eac;
      }
      return { x: r.period_end, pv: round(pv), ev: round(r.ev), ac: round(r.ac), fc: round(fc) };
    });
  }, [rows, bac, eac]);
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid {...chartTheme.grid} />
        <XAxis dataKey="x" {...chartTheme.axis} tickFormatter={(v) => shortDate(v)} minTickGap={24} />
        <YAxis {...chartTheme.axis} tickFormatter={compact} width={48} />
        <Tooltip cursor={chartTheme.cursor} content={<ChartTooltip unit={` ${currency}`} labelFormat={(l) => shortDate(l)} />} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
        {statusDate && <ReferenceLine x={data.find((d) => d.x >= statusDate)?.x} stroke="var(--accent)" strokeWidth={1.5} label={{ value: am ? 'ዛሬ' : 'Status date', fill: 'var(--text-muted)', fontSize: 11, position: 'insideTopRight' }} />}
        <Line type="monotone" dataKey="pv" name={am ? 'የታቀደ (PV)' : 'Planned (PV)'} stroke="var(--chart-planned)" strokeDasharray="4 4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="ev" name={am ? 'የተሰራ (EV)' : 'Earned (EV)'} stroke="var(--chart-1)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        <Line type="monotone" dataKey="ac" name={am ? 'ወጪ (AC)' : 'Actual cost (AC)'} stroke="var(--chart-3)" strokeDasharray="2 3" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        {eac != null && <Line type="monotone" dataKey="fc" name={am ? 'የወጪ ትንበያ (EAC)' : 'Forecast cost (EAC)'} stroke="var(--chart-3)" strokeOpacity={0.55} strokeDasharray="6 4" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Cumulative SPI / CPI per period (computed from cumulative values, not averaged). */
export function EvmTrend({ rows, warn = 0.95, crit = 0.9 }: { rows: EvmTimeseriesRow[]; warn?: number; crit?: number }) {
  const am = isAm();
  const data = rows.filter((r) => r.is_actual && Number(r.pv) > 0).map((r) => ({
    x: r.period_end,
    spi: r.ev != null ? Math.round((Number(r.ev) / Number(r.pv)) * 100) / 100 : undefined,
    cpi: r.ev != null && r.ac ? Math.round((Number(r.ev) / Number(r.ac)) * 100) / 100 : undefined,
  }));
  if (!data.length) return <p className="muted">{am ? 'ገና መረጃ የለም።' : 'No progress measured yet.'}</p>;
  const vals = data.flatMap((d) => [d.spi, d.cpi]).filter((v): v is number => v != null);
  const lo = Math.min(0.8, ...vals), hi = Math.max(1.1, ...vals);
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid {...chartTheme.grid} />
        <XAxis dataKey="x" {...chartTheme.axis} tickFormatter={(v) => shortDate(v)} minTickGap={24} />
        <YAxis {...chartTheme.axis} domain={[Math.floor(lo * 20) / 20, Math.ceil(hi * 20) / 20]} width={40} tickFormatter={(v: number) => v.toFixed(2)} />
        <Tooltip cursor={chartTheme.cursor} content={<ChartTooltip labelFormat={(l) => shortDate(l)} />} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
        <ReferenceLine y={1} stroke="var(--border-strong)" strokeWidth={1.5} label={{ value: am ? 'ዒላማ 1.00' : 'Target 1.00', fill: 'var(--text-muted)', fontSize: 11, position: 'insideTopLeft' }} />
        <ReferenceLine y={warn} stroke="var(--warning)" strokeDasharray="3 3" />
        <ReferenceLine y={crit} stroke="var(--danger)" strokeDasharray="3 3" />
        <Line type="monotone" dataKey="spi" name={am ? 'የጊዜ አፈጻጸም (SPI)' : 'Schedule (SPI)'} stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
        <Line type="monotone" dataKey="cpi" name={am ? 'የወጪ አፈጻጸም (CPI)' : 'Cost (CPI)'} stroke="var(--chart-3)" strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
