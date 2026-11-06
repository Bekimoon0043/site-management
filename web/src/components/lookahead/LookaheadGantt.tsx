// Gantt of the monthly look-ahead items: task list on the left, day-scale bars on the right (period + horizon),
// week boundaries, Sundays / holidays shaded, today line, % complete fill. Clicking a row or bar opens the item.
import { useMemo } from 'react';
import { Diamond, Flame } from 'lucide-react';
import { date, num } from '../../lib/format';
import { tr } from '../evm/data';
import { ReadyChip } from './chips';
import { roleLabel, type LaItem, type LaWeek } from './la';
import type { Holiday } from './MonthGrid';

const DAY_MS = 86_400_000;
const dayNo = (s: string) => Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY_MS);
const isoOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function LookaheadGantt({ items, weeks, periodStart, periodEnd, horizonEnd, holidays, today, activeId, onOpen }: {
  items: LaItem[]; weeks: LaWeek[]; periodStart: string; periodEnd: string; horizonEnd: string; holidays: Holiday[];
  today: string; activeId?: string | null; onOpen: (it: LaItem) => void;
}) {
  const d0 = dayNo(periodStart), d1 = dayNo(horizonEnd || periodEnd), pEnd = dayNo(periodEnd), t = dayNo(today);
  const days = useMemo(() => {
    const hol = new Map(holidays.map((h) => [h.on_date, h]));
    const weekStarts = new Map(weeks.map((w) => [w.week_start, w]));
    return Array.from({ length: Math.max(1, d1 - d0 + 1) }, (_, i) => {
      const iso = isoOf(d0 + i);
      const dt = new Date(`${iso}T00:00:00Z`);
      const h = hol.get(iso);
      return {
        iso, dom: dt.getUTCDate(), month: dt.getUTCMonth(), sunday: dt.getUTCDay() === 0,
        hol: h && !h.working ? h : null, week: weekStarts.get(iso) ?? null, buffer: d0 + i > pEnd,
      };
    });
  }, [d0, d1, pEnd, holidays, weeks]);
  const cols = days.length;
  const todayCol = t >= d0 && t <= d1 ? t - d0 : null;

  return (
    <div className="lag" role="group" aria-label={tr('Gantt chart of the month', 'የወሩ ጋንት ቻርት')}>
      <div className="lag-scroll">
        <div className="lag-grid" style={{ gridTemplateColumns: `var(--lag-name) repeat(${cols}, var(--lag-day))` }}>
          <div className="lag-corner lag-h1">{tr('Task', 'ሥራ')}</div>
          {days.map((d, i) => (
            <div key={`w${d.iso}`} className={`lag-h1${d.week ? ' wk' : ''}`} style={{ gridColumn: i + 2 }}>
              {d.week ? `W${d.week.week_no}` : i === 0 || d.dom === 1 ? MONTHS[d.month] : ''}
            </div>
          ))}
          <div className="lag-corner lag-h2"><span className="muted">{num(items.length, 0)} {tr('tasks', 'ሥራዎች')}</span></div>
          {days.map((d, i) => (
            <div key={`d${d.iso}`} title={d.hol ? d.hol.name : date(d.iso)}
              className={`lag-h2${d.sunday ? ' off' : ''}${d.hol ? ' hol' : ''}${d.buffer ? ' buf' : ''}${i === todayCol ? ' today' : ''}`} style={{ gridColumn: i + 2 }}>
              {d.dom}
            </div>
          ))}

          {items.map((it, r) => {
            const row = r + 3;
            const has = !!it.start;
            const s = it.start ? dayNo(it.start) : 0;
            const f = it.finish ? Math.max(s, dayNo(it.finish)) : s;
            const vis = has && f >= d0 && s <= d1;
            const c0 = Math.max(s, d0) - d0, c1 = Math.min(f, d1) - d0;
            const act = it.id === activeId ? ' active' : '';
            const pct = Math.max(0, Math.min(100, Number(it.pct) || 0));
            const label = `${it.name}: ${date(it.start)} → ${date(it.finish)}, ${num(pct, 0)} %`;
            return (
              <div key={it.id} style={{ display: 'contents' }}>
                <button className={`lag-name${act}`} style={{ gridRow: row }} onClick={() => onOpen(it)} title={it.name}>
                  <span className="lag-name-main">{it.is_critical && <Flame size={12} className="danger-text" aria-label="Critical" />}{it.name}</span>
                  <span className="lag-name-sub">
                    <span className={`la-chip role-${it.window_role}`}>{roleLabel(it.window_role)}</span>
                    <span className="xs-text muted">{num(pct, 0)}%{it.target_pct != null ? ` → ${num(it.target_pct, 0)}` : ''}</span>
                    <ReadyChip item={it} />
                  </span>
                </button>
                <div className={`lag-lane${act}`} style={{ gridRow: row, gridColumn: `2 / span ${cols}` }}>
                  {todayCol != null && <span className="lag-today" style={{ left: `calc(${todayCol + 0.5} * var(--lag-day))` }} aria-hidden />}
                  {has && f < d0 && (
                    <button className={`lag-out left role-${it.window_role}`} onClick={() => onOpen(it)} title={label} aria-label={label}>‹ {date(it.finish)}</button>
                  )}
                  {has && s > d1 && (
                    <button className={`lag-out right role-${it.window_role}`} onClick={() => onOpen(it)} title={label} aria-label={label}>{date(it.start)} ›</button>
                  )}
                  {vis && (it.is_milestone ? (
                    <button className={`lag-ms${it.is_critical ? ' crit' : ''}`} style={{ left: `calc(${c0 + 0.5} * var(--lag-day) - 7px)` }} aria-label={label} title={label} onClick={() => onOpen(it)}>
                      <Diamond size={14} aria-hidden />
                    </button>
                  ) : (
                    <button className={`lag-bar role-${it.window_role}${it.is_critical ? ' crit' : ''}${s < d0 ? ' cut-l' : ''}${f > d1 ? ' cut-r' : ''}`}
                      style={{ left: `calc(${c0} * var(--lag-day) + 1px)`, width: `calc(${c1 - c0 + 1} * var(--lag-day) - 2px)` }}
                      aria-label={label} title={label} onClick={() => onOpen(it)}>
                      <span className="lag-fill" style={{ width: `${pct}%` }} aria-hidden />
                      {it.target_pct != null && it.target_pct > pct && <span className="lag-target" style={{ left: `${Math.min(100, it.target_pct)}%` }} aria-hidden />}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}

          {/* background columns: weekends, holidays, look-ahead buffer, week starts */}
          {days.map((d, i) => (d.sunday || d.hol || d.buffer || d.week) && (
            <div key={`bg${d.iso}`} className={`lag-col${d.sunday || d.hol ? ' off' : ''}${d.hol ? ' hol' : ''}${d.buffer ? ' buf' : ''}${d.week ? ' wk' : ''}`}
              style={{ gridColumn: i + 2, gridRow: `3 / span ${Math.max(1, items.length)}` }} aria-hidden />
          ))}
        </div>
      </div>
      <div className="la-legend">
        <span><span className="la-sw role-starting" /> {roleLabel('starting')}</span>
        <span><span className="la-sw role-ongoing" /> {roleLabel('ongoing')}</span>
        <span><span className="la-sw role-finishing" /> {roleLabel('finishing')}</span>
        <span><span className="la-sw role-late" /> {roleLabel('late')}</span>
        <span><span className="la-sw role-starting_next" /> {roleLabel('starting_next')}</span>
        <span><span className="la-sw lag-sw-fill" /> {tr('% complete', '% ተጠናቋል')}</span>
        <span><span className="la-sw hol" /> {tr('Holiday / Sunday', 'በዓል / እሁድ')}</span>
        <span><span className="la-sw lag-sw-buf" /> {tr('Next weeks (look-ahead)', 'ቀጣይ ሳምንታት')}</span>
      </div>
    </div>
  );
}
