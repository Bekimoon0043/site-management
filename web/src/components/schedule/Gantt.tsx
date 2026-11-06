// Read-only, virtualised SVG Gantt (docs/research/schedule-ux.md §4.1, §5). One vertical scroller drives the
// WBS tree (left, sticky) and the bars (right). Rows are windowed by @tanstack/react-virtual, dates by a
// quantised horizontal window; bar geometry is computed once per (tasks, zoom) into a typed array.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Clock, Diamond, Flame } from 'lucide-react';
import { dayNo, dayStr, d2, type SchedLink, type SchedTask } from './data';
import type { FlatRow } from './tree';

export type Zoom = 'day' | 'week' | 'month';
export const PX_PER_DAY: Record<Zoom, number> = { day: 28, week: 6, month: 1.6 };
const ROW_H = 32;
const HEAD_H = 44;
const LEFT_W = 440;
const CHUNK = 600;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface GanttShow { baseline: boolean; forecast: boolean; deps: boolean; critical: boolean }

export interface GanttProps {
  tasks: SchedTask[];
  rows: FlatRow[];
  /** Dense display identifier in full WBS order (1..N). */
  taskNo: Int32Array;
  zoom: Zoom;
  show: GanttShow;
  /** Only needed when show.deps. */
  links?: SchedLink[];
  statusDate: string;
  today: string;
  /** Calendar days late per task index. */
  late: Int32Array;
  /** ISO weekdays that are worked + non-working dates → name. */
  workWeek?: { weekdays: number[]; holidays: Map<string, string> };
  activeId: string | null;
  onOpen: (id: string) => void;
  onToggle: (i: number) => void;
  /** Change the value to scroll to today. */
  todayTick: number;
}

// Geometry slots per task (Float64Array, NaN = none)
const G = 8; // ps, pf(excl), bs, bf(excl), fs, ff(excl), as, statusClip

export function Gantt({ tasks, rows, taskNo, zoom, show, links, statusDate, today, late, workWeek, activeId, onOpen, onToggle, todayTick }: GanttProps) {
  const ppd = PX_PER_DAY[zoom];
  const scrollRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [vw, setVw] = useState(1200);
  const [winQ, setWinQ] = useState(0);
  const [focus, setFocus] = useState(0);
  const centerDay = useRef<number | null>(null);

  // Day numbers once per task list.
  const days = useMemo(() => {
    const n = tasks.length;
    const a = new Float64Array(n * G);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const t = tasks[i];
      const o = i * G;
      a[o] = dayNo(t.planned_start); a[o + 1] = dayNo(t.planned_finish) + 1;
      a[o + 2] = dayNo(t.baseline_start); a[o + 3] = dayNo(t.baseline_finish) + 1;
      a[o + 4] = dayNo(t.actual_start ?? t.forecast_start); a[o + 5] = dayNo(t.forecast_finish) + 1;
      a[o + 6] = dayNo(t.actual_start); a[o + 7] = dayNo(t.actual_finish) + 1;
      for (let k = 0; k < G; k++) { const v = a[o + k]; if (!Number.isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    }
    const td = dayNo(today);
    if (!Number.isFinite(lo)) { lo = td - 30; hi = td + 60; }
    return { a, d0: Math.min(lo, td) - 14, d1: Math.max(hi, td) + 28 };
  }, [tasks, today]);

  // Geometry per zoom (x in chart px).
  const geo = useMemo(() => {
    const { a, d0 } = days;
    const g = new Float32Array(a.length);
    for (let k = 0; k < a.length; k++) g[k] = (a[k] - d0) * ppd;
    return g;
  }, [days, ppd]);
  const chartW = Math.ceil((days.d1 - days.d0) * ppd);
  const xOf = (d: string) => (dayNo(d) - days.d0) * ppd;
  const xToday = xOf(today);
  const xStatus = xOf(statusDate) + ppd; // end of the status day

  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 8, scrollMargin: HEAD_H });
  const items = v.getVirtualItems();

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVw(el.clientWidth));
    ro.observe(el);
    setVw(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current!;
    const q = Math.floor(el.scrollLeft / CHUNK) * CHUNK;
    if (q !== winQ) setWinQ(q);
    centerDay.current = days.d0 + (el.scrollLeft + (el.clientWidth - LEFT_W) / 2) / ppd;
  };
  const scrollToX = (x: number) => { const el = scrollRef.current; if (el) el.scrollLeft = Math.max(0, x - (el.clientWidth - LEFT_W) / 3); };

  // Zoom keeps the centre date; first render lands on today.
  const prevPpd = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevPpd.current === null || centerDay.current === null) scrollToX(xToday);
    else if (prevPpd.current !== ppd) el.scrollLeft = Math.max(0, (centerDay.current - days.d0) * ppd - (el.clientWidth - LEFT_W) / 2);
    prevPpd.current = ppd;
    onScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ppd]);
  const firstTick = useRef(todayTick);
  useEffect(() => { if (todayTick !== firstTick.current) scrollToX(xToday); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [todayTick]);

  const wx0 = Math.max(0, winQ - CHUNK);
  const wx1 = Math.min(chartW, winQ + vw + CHUNK);
  const y0 = items.length ? items[0].start - HEAD_H : 0;
  const y1 = items.length ? items[items.length - 1].end - HEAD_H : 0;

  // Header ticks + non-working day shading for the date window only.
  const scale = useMemo(() => buildScale(days.d0, ppd, zoom, wx0, wx1, workWeek), [days.d0, ppd, zoom, wx0, wx1, workWeek]);

  // Dependencies between rendered rows.
  const linkIdx = useMemo(() => {
    if (!show.deps || !links) return null;
    const pos = new Map(tasks.map((t, i) => [t.id, i]));
    const out = new Map<number, { s: number; type: string }[]>();
    for (const l of links) {
      const p = pos.get(l.pred_task_id), s = pos.get(l.succ_task_id);
      if (p === undefined || s === undefined) continue;
      const a = out.get(p) ?? [];
      a.push({ s, type: l.link_type });
      out.set(p, a);
    }
    return out;
  }, [show.deps, links, tasks]);

  const rowOfTask = new Map<number, number>();
  for (const it of items) rowOfTask.set(rows[it.index].i, it.start - HEAD_H);
  const paths: string[] = [];
  const critPaths: string[] = [];
  if (linkIdx) {
    for (const it of items) {
      const p = rows[it.index].i;
      const outs = linkIdx.get(p);
      if (!outs) continue;
      const py = it.start - HEAD_H + ROW_H / 2;
      for (const l of outs) {
        const sy0 = rowOfTask.get(l.s);
        if (sy0 === undefined) continue;
        const sy = sy0 + ROW_H / 2;
        const pg = p * G, sg = l.s * G;
        const fromX = l.type === 'SS' || l.type === 'SF' ? geo[pg] : geo[pg + 1];
        const toX = l.type === 'FF' || l.type === 'SF' ? geo[sg + 1] : geo[sg];
        if (Number.isNaN(fromX) || Number.isNaN(toX)) continue;
        const d = `M${fromX} ${py}h6V${sy}H${toX - 4}`;
        (tasks[p].is_critical && tasks[l.s].is_critical && show.critical ? critPaths : paths).push(d);
      }
    }
  }

  // Shared tooltip (DOM-updated, no React state per pointer move).
  const raf = useRef(0);
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const target = (e.target as Element).closest('[data-i]');
    const tip = tipRef.current;
    if (!tip) return;
    if (!target) { tip.hidden = true; return; }
    const i = Number(target.getAttribute('data-i'));
    const host = scrollRef.current!.parentElement!.getBoundingClientRect();
    const x = e.clientX - host.left, y = e.clientY - host.top;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      fillTip(tip, tasks[i], late[i]);
      tip.hidden = false;
      const w = tip.offsetWidth;
      tip.style.transform = `translate(${Math.min(x + 14, host.width - w - 8)}px, ${y + 16}px)`;
    });
  };
  const onLeave = () => { cancelAnimationFrame(raf.current); if (tipRef.current) tipRef.current.hidden = true; };
  const onBodyClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const target = (e.target as Element).closest('[data-i]');
    if (target) onOpen(tasks[Number(target.getAttribute('data-i'))].id);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !rows.length) return;
    const k = e.key;
    const go = (n: number) => { const f = Math.max(0, Math.min(rows.length - 1, n)); setFocus(f); v.scrollToIndex(f, { align: 'auto' }); };
    if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); go(focus + 1); }
    else if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); go(focus - 1); }
    else if (k === 'PageDown') { e.preventDefault(); go(focus + 15); }
    else if (k === 'PageUp') { e.preventDefault(); go(focus - 15); }
    else if (k === 'Home') { e.preventDefault(); go(0); }
    else if (k === 'End') { e.preventDefault(); go(rows.length - 1); }
    else if (k === 'Enter') { e.preventDefault(); const r = rows[focus]; if (r) onOpen(tasks[r.i].id); }
    else if (k === 'ArrowRight' || k === 'ArrowLeft') {
      const r = rows[focus];
      if (r?.hasKids && !r.ctx && (k === 'ArrowRight') !== r.expanded) { e.preventDefault(); onToggle(r.i); }
    }
  };
  const focusRow = Math.min(focus, Math.max(0, rows.length - 1));
  const totalH = rows.length * ROW_H;
  const statusShown = statusDate !== today;

  return (
    <div className="gantt-host">
      <div className="gantt" ref={scrollRef} onScroll={onScroll} tabIndex={0} onKeyDown={onKey}
        role="treegrid" aria-label="Schedule (Gantt)" aria-rowcount={rows.length} aria-activedescendant={rows[focusRow] ? `gr-${rows[focusRow].i}` : undefined}>
        <div className="gantt-inner" style={{ width: LEFT_W + chartW, height: HEAD_H + totalH }}>
          <div className="gantt-head" style={{ width: LEFT_W + chartW, height: HEAD_H }}>
            <div className="gantt-corner" style={{ width: LEFT_W }} role="row">
              <span className="c-id" role="columnheader">ID</span><span className="c-wbs" role="columnheader">WBS</span><span className="c-name" role="columnheader">Task</span>
              <span className="c-pct" role="columnheader">%</span><span className="c-float" role="columnheader">Float</span>
            </div>
            <svg className="gantt-scale" aria-hidden width={wx1 - wx0} height={HEAD_H} style={{ left: LEFT_W + wx0 }}>
              <g transform={`translate(${-wx0},0)`}>
                {scale.top.map((t) => <g key={`t${t.x}`}><line x1={t.x} x2={t.x} y1={0} y2={HEAD_H} className="tick-major" /><text x={t.x + 4} y={15}>{t.label}</text></g>)}
                {scale.bottom.map((t) => <g key={`b${t.x}`}><line x1={t.x} x2={t.x} y1={22} y2={HEAD_H} className="tick" /><text x={t.x + 3} y={37} className="tick-label">{t.label}</text></g>)}
                {xToday >= wx0 && xToday <= wx1 && <g className="today-chip"><rect x={xToday - 20} y={22} width={40} height={16} rx={8} /><text x={xToday} y={34} textAnchor="middle">Today</text></g>}
              </g>
            </svg>
          </div>
          <div className="gantt-left" style={{ width: LEFT_W, height: totalH }} role="rowgroup">
            {items.map((it) => {
              const r = rows[it.index];
              const t = tasks[r.i];
              return (
                <LeftRow key={t.id} id={`gr-${r.i}`} i={r.i} y={it.start - HEAD_H} depth={r.depth} hasKids={r.hasKids} expanded={r.expanded} ctx={r.ctx}
                  taskNo={taskNo[r.i]} wbs={t.wbs ?? String(t.msp_uid)} name={t.name} summary={t.is_summary} milestone={t.is_milestone} critical={show.critical && t.is_critical}
                  pct={Number(t.pct_complete)} float={t.total_float_days} late={late[r.i]} removed={t.source_state === 'removed_in_source'}
                  active={t.id === activeId} focused={it.index === focusRow} onOpen={onOpen} onToggle={onToggle} taskId={t.id} />
              );
            })}
          </div>
          <div className="gantt-chart" style={{ left: LEFT_W, top: HEAD_H, width: chartW, height: totalH }}>
            <svg className="gantt-body" aria-hidden width={wx1 - wx0} height={Math.max(0, y1 - y0)} style={{ left: wx0, top: y0 }}
              onPointerMove={onMove} onPointerLeave={onLeave} onClick={onBodyClick}>
              <defs>
                <pattern id="g-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="4" className="hatch" /></pattern>
                <marker id="g-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L6 3L0 6z" className="arrow" /></marker>
              </defs>
              <g transform={`translate(${-wx0},${-y0})`}>
                {scale.off.map((o) => <rect key={o.x} x={o.x} y={y0} width={o.w} height={y1 - y0} className={o.holiday ? 'bg-holiday' : 'bg-off'} />)}
                {items.map((it) => {
                  const r = rows[it.index];
                  const t = tasks[r.i];
                  const o = r.i * G;
                  const px0 = geo[o], px1 = geo[o + 1];
                  if (!(px1 >= wx0 - 200 && px0 <= wx1 + 200) && !(geo[o + 3] >= wx0 && geo[o + 2] <= wx1) && !(geo[o + 5] >= wx0 && geo[o + 4] <= wx1)) return null;
                  return (
                    <BarRow key={t.id} i={r.i} y={it.start - HEAD_H} kind={t.is_milestone ? 2 : t.is_summary ? 1 : 0} ctx={r.ctx}
                      px0={px0} px1={px1} bx0={show.baseline ? geo[o + 2] : NaN} bx1={geo[o + 3]}
                      fx0={show.forecast ? geo[o + 4] : NaN} fx1={geo[o + 5]} statusX={xStatus}
                      pct={Number(t.pct_complete)} crit={show.critical && t.is_critical} done={Number(t.pct_complete) >= 100} late={late[r.i] > 0} />
                  );
                })}
                {paths.map((d) => <path key={d} d={d} className="dep" markerEnd="url(#g-arrow)" />)}
                {critPaths.map((d) => <path key={d} d={d} className="dep crit" markerEnd="url(#g-arrow)" />)}
              </g>
            </svg>
            {statusShown && <div className="gantt-line status" style={{ left: xStatus }} title={`Status date ${d2(statusDate)}`} />}
            <div className="gantt-line today" style={{ left: xToday }} title={`Today ${d2(today)}`} />
          </div>
        </div>
      </div>
      <div className="gantt-tip" ref={tipRef} hidden role="tooltip" />
    </div>
  );
}

const LeftRow = memo(function LeftRow({ id, i, taskId, taskNo, y, depth, hasKids, expanded, ctx, wbs, name, summary, milestone, critical, pct, float, late, removed, active, focused, onOpen, onToggle }: {
  id: string; i: number; taskId: string; taskNo: number; y: number; depth: number; hasKids: boolean; expanded: boolean; ctx: boolean; wbs: string; name: string;
  summary: boolean; milestone: boolean; critical: boolean; pct: number; float: number | null; late: number; removed: boolean; active: boolean; focused: boolean;
  onOpen: (id: string) => void; onToggle: (i: number) => void;
}) {
  return (
    <div id={id} role="row" aria-level={depth + 1} aria-expanded={hasKids ? expanded : undefined} aria-selected={active}
      className={`g-row${summary ? ' summary' : ''}${ctx ? ' ctx' : ''}${active ? ' active' : ''}${focused ? ' focused' : ''}${removed ? ' removed' : ''}`}
      style={{ transform: `translateY(${y}px)` }} onClick={() => onOpen(taskId)}>
      <span className="c-id" role="gridcell">{taskNo}</span>
      <span className="c-wbs" role="gridcell">{wbs}</span>
      <span className="c-name" role="gridcell" style={{ paddingLeft: 4 + depth * 14 }} title={name}>
        {hasKids ? (
          <button type="button" className="caret" tabIndex={-1} aria-label={expanded ? 'Collapse' : 'Expand'} disabled={ctx}
            onClick={(e) => { e.stopPropagation(); onToggle(i); }}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        ) : <span className="caret-sp" />}
        {milestone && <Diamond size={11} className="ms-icon" aria-label="Milestone" />}
        {critical && <Flame size={12} className="danger-text" aria-label="Critical" />}
        <span className="truncate">{name}</span>
        {late > 0 && <span className={`late-chip${late > 7 ? ' bad' : ''}`}><Clock size={11} aria-hidden />{late} d late</span>}
      </span>
      <span className="c-pct" role="gridcell">{pct > 0 ? `${Math.round(pct)}%` : milestone ? '' : '0%'}</span>
      <span className={`c-float${float != null && float < 0 ? ' danger-text' : ''}`} role="gridcell">{summary || float == null ? '' : `${Math.round(float * 10) / 10} d`}</span>
    </div>
  );
});

const BarRow = memo(function BarRow({ i, y, kind, ctx, px0, px1, bx0, bx1, fx0, fx1, statusX, pct, crit, done, late }: {
  i: number; y: number; kind: 0 | 1 | 2; ctx: boolean; px0: number; px1: number; bx0: number; bx1: number; fx0: number; fx1: number; statusX: number;
  pct: number; crit: boolean; done: boolean; late: boolean;
}) {
  const hasP = !Number.isNaN(px0) && !Number.isNaN(px1);
  const hasB = !Number.isNaN(bx0) && !Number.isNaN(bx1);
  const hasF = !Number.isNaN(fx0) && !Number.isNaN(fx1) && (Math.abs(fx1 - px1) > 0.5 || Math.abs(fx0 - px0) > 0.5);
  if (kind === 2) {
    const x = hasP ? px1 : hasB ? bx1 : NaN;
    if (Number.isNaN(x)) return null;
    const cy = y + 14;
    return (
      <g data-i={i} className={`ms${done ? ' done' : ''}${crit ? ' crit' : ''}${ctx ? ' ctx' : ''}`}>
        <rect x={x - 9} y={y} width={18} height={ROW_H} className="hit" />
        {hasB && <path d={`M${bx1} ${y + 21}l4 4l-4 4l-4 -4z`} className="bar-baseline-ms" />}
        <path d={`M${x} ${cy - 6}l6 6l-6 6l-6 -6z`} />
        {hasF && <path d={`M${fx1} ${cy - 4}l4 4l-4 4l-4 -4z`} className="fc-ms" />}
      </g>
    );
  }
  const w = hasP ? Math.max(2, px1 - px0) : 0;
  return (
    <g data-i={i} className={`${kind === 1 ? 'sum' : 'leaf'}${crit ? ' crit' : ''}${ctx ? ' ctx' : ''}${late ? ' late' : ''}`}>
      {hasP && <rect x={px0} y={y} width={w} height={ROW_H} className="hit" />}
      {hasB && <rect x={bx0} y={y + 24} width={Math.max(2, bx1 - bx0)} height={4} className="bar-baseline" />}
      {hasP && kind === 1 && <path d={`M${px0} ${y + 9}h${w}v8l-4 -3H${px0 + 4}l-4 3z`} className="bar-summary" />}
      {hasP && kind === 1 && pct > 0 && <rect x={px0} y={y + 9} width={(w * Math.min(100, pct)) / 100} height={5} className="bar-summary-done" />}
      {hasP && kind === 0 && <rect x={px0} y={y + 8} width={w} height={13} rx={3} className="bar-planned" />}
      {hasP && kind === 0 && pct > 0 && <rect x={px0} y={y + 8} width={(w * Math.min(100, pct)) / 100} height={13} rx={3} className="bar-done" />}
      {hasF && kind === 0 && (
        <>
          <path d={`M${fx0} ${y + 14.5}H${Math.min(fx1, Math.max(fx0, statusX))}`} className="fc-actual" />
          {fx1 > statusX && <path d={`M${Math.max(fx0, statusX)} ${y + 14.5}H${fx1}`} className="fc-ahead" />}
          <path d={`M${fx1} ${y + 10}v9`} className="fc-end" />
        </>
      )}
    </g>
  );
});

function fillTip(tip: HTMLDivElement, t: SchedTask, late: number) {
  const rows: [string, string][] = [];
  const range = (a: string | null, b: string | null) => (a || b ? `${d2(a) || '?'} → ${d2(b) || '?'}` : '—');
  rows.push(['Planned', range(t.planned_start, t.planned_finish)]);
  if (t.baseline_start || t.baseline_finish) rows.push(['Baseline', range(t.baseline_start, t.baseline_finish)]);
  if (t.forecast_finish) rows.push(['Forecast', range(t.forecast_start, t.forecast_finish)]);
  if (t.actual_start) rows.push(['Actual', range(t.actual_start, t.actual_finish)]);
  rows.push(['Progress', `${Math.round(Number(t.pct_complete))} % verified${Number(t.reported_pct) !== Number(t.pct_complete) ? ` · ${Math.round(Number(t.reported_pct))} % reported` : ''}`]);
  if (!t.is_summary && t.total_float_days != null) rows.push(['Float', `${t.total_float_days} d${t.is_critical ? ' · critical' : ''}`]);
  const bf = dayNo(t.baseline_finish), ff = dayNo(t.forecast_finish ?? t.planned_finish);
  if (!Number.isNaN(bf) && !Number.isNaN(ff) && bf !== ff) rows.push(['Variance', `${ff > bf ? '+' : ''}${ff - bf} d vs baseline`]);
  if (late > 0) rows.push(['Late', `${late} d`]);
  tip.replaceChildren();
  const h = document.createElement('div');
  h.className = 'tip-title';
  h.textContent = `${t.wbs ? `${t.wbs} ` : ''}${t.name}`;
  tip.append(h);
  const dl = document.createElement('dl');
  for (const [k, val] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = val;
    dl.append(dt, dd);
  }
  tip.append(dl);
}

interface Tick { x: number; label: string }
function buildScale(d0: number, ppd: number, zoom: Zoom, wx0: number, wx1: number, ww?: { weekdays: number[]; holidays: Map<string, string> }) {
  const top: Tick[] = [], bottom: Tick[] = [], off: { x: number; w: number; holiday: boolean }[] = [];
  const a = d0 + Math.floor(wx0 / ppd) - 1, b = d0 + Math.ceil(wx1 / ppd) + 1;
  const work = new Set(ww?.weekdays ?? [1, 2, 3, 4, 5, 6]);
  for (let d = a; d <= b; d++) {
    const s = dayStr(d);
    const dom = +s.slice(8, 10), m = +s.slice(5, 7) - 1, y = s.slice(0, 4);
    const x = (d - d0) * ppd;
    const iso = (((d + 3) % 7) + 7) % 7 + 1;
    if (zoom === 'month') {
      if (dom === 1 && m === 0) top.push({ x, label: y });
      if (dom === 1) bottom.push({ x, label: MON[m] });
    } else {
      if (dom === 1) top.push({ x, label: `${MON[m]} ${y}` });
      if (zoom === 'day') bottom.push({ x, label: String(dom) });
      else if (iso === 1) bottom.push({ x, label: String(dom).padStart(2, '0') });
      const hol = ww?.holidays.has(s) ?? false;
      if (hol || !work.has(iso)) off.push({ x, w: ppd, holiday: hol });
    }
  }
  if (!top.length || top[0].x > wx0 + 40) {
    const s = dayStr(a + 1);
    top.unshift({ x: Math.max(0, wx0), label: zoom === 'month' ? s.slice(0, 4) : `${MON[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}` });
  }
  return { top, bottom, off };
}
