import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { num } from '../lib/format';
import { Skeleton } from './Page';

export interface KpiDelta {
  value: number;
  /** e.g. "vs last week" — always shown after the delta. */
  window: string;
  /** Which direction is good; colour shows sentiment, the arrow shows direction. */
  goodDirection: 'up' | 'down' | 'none';
  unit?: string;
  digits?: number;
}

/**
 * KPI card. Zero is neutral (never green). `status` adds a 3px left edge only when the count needs action.
 * When `to` is set the whole card links to the exact filtered list behind the number.
 */
export function Kpi({ label, value, unit, delta, spark, status, to, loading, error, onRetry, hint, compact }: {
  label: string; value: ReactNode; unit?: string; delta?: KpiDelta; spark?: number[]; status?: 'ok' | 'warning' | 'danger';
  to?: string; loading?: boolean; error?: string | null; onRetry?: () => void; hint?: ReactNode; compact?: boolean;
}) {
  const body = (
    <>
      <div className="kpi-label">{label}</div>
      {loading ? (
        <><Skeleton width="50%" height={28} /><Skeleton width="70%" /></>
      ) : error ? (
        <div className="kpi-delta"><span className="bad">Couldn't load</span>{onRetry && <button className="link-btn" onClick={(e) => { e.preventDefault(); onRetry(); }}>Retry</button>}</div>
      ) : (
        <>
          <div className="kpi-value">{value}{unit && <span className="unit">{unit}</span>}</div>
          {delta && <DeltaRow d={delta} />}
          {hint && <div className="kpi-delta">{hint}</div>}
          {spark && spark.length > 1 && <Sparkline values={spark} className="kpi-spark" />}
        </>
      )}
      {to && <ArrowRight size={14} className="kpi-go" aria-hidden />}
    </>
  );
  const cls = `kpi${compact ? ' compact' : ''}${status === 'danger' || status === 'warning' ? ` status-${status}` : ''}`;
  return to ? <Link className={cls} to={to}>{body}</Link> : <div className={cls}>{body}</div>;
}

function DeltaRow({ d }: { d: KpiDelta }) {
  const dir = d.value > 0 ? 'up' : d.value < 0 ? 'down' : 'flat';
  const sentiment = dir === 'flat' || d.goodDirection === 'none' ? 'flat' : dir === d.goodDirection ? 'good' : 'bad';
  const I = dir === 'up' ? ArrowUp : dir === 'down' ? ArrowDown : Minus;
  return (
    <div className="kpi-delta">
      <span className={sentiment}><I size={12} aria-hidden style={{ verticalAlign: '-2px' }} /> {num(Math.abs(d.value), d.digits ?? 0)}{d.unit ?? ''}</span>
      <span>{d.window}</span>
    </div>
  );
}

/** Pure-SVG sparkline (no axes; last point dotted). Keeps recharts out of the dashboard KPI row. */
export function Sparkline({ values, className, width = 160, height = 32 }: { values: number[]; className?: string; width?: number; height?: number }) {
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 4) + 2, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const last = pts[pts.length - 1];
  return (
    <svg className={className} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden>
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill="var(--surface)" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** @deprecated use <Kpi>. Kept so older pages compile. */
export function Tile({ label, value, sub, to, tone }: { label: string; value: ReactNode; sub?: ReactNode; to?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return <Kpi label={label} value={value} hint={sub} to={to} status={tone === 'bad' ? 'danger' : tone === 'warn' ? 'warning' : undefined} />;
}
