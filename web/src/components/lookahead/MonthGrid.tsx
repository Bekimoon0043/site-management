// Month calendar: weeks as rows (Mon–Sat), task bars spanning days (HTML divs, greedy lane packing),
// holidays shaded with names (tentative marked), PPC per week in the right rail.
import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Diamond, Flame } from 'lucide-react';
import { toEthiopian } from '../../lib/contract-control';
import { ppcTone, type CalendarMode, type PpcWeek } from '../../lib/contract-lookahead';
import { addDays, daysBetween, isAm } from '../evm/data';
import { ReadyChip } from './chips';
import { mondayOf, roleLabel, type LaItem, type LaWeek } from './la';

export interface Holiday { on_date: string; name: string; name_am: string | null; is_tentative: boolean; working?: boolean }
const MAX_LANES = 6;
const DOW_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_AM = ['ሰኞ', 'ማክሰኞ', 'ረቡዕ', 'ሐሙስ', 'ዓርብ', 'ቅዳሜ'];

interface Placed { item: LaItem; c0: number; c1: number; lane: number; clipL: boolean; clipR: boolean }

export function MonthGrid({ items, weeks, periodStart, periodEnd, horizonEnd, holidays, ppc, mode, today, onOpen, ppcTarget = 80 }: {
  items: LaItem[]; weeks: LaWeek[]; periodStart: string; periodEnd: string; horizonEnd: string; holidays: Holiday[]; ppc: PpcWeek[];
  mode: CalendarMode; today: string; onOpen: (it: LaItem) => void; ppcTarget?: number;
}) {
  const am = isAm();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const hol = useMemo(() => new Map(holidays.map((h) => [h.on_date, h])), [holidays]);
  const rows = useMemo(() => {
    const mondays = [...new Set(weeks.map((w) => mondayOf(w.week_start)))].sort();
    if (!mondays.length) { for (let d = mondayOf(periodStart); d <= horizonEnd; d = addDays(d, 7)) mondays.push(d); }
    return mondays.map((mon) => {
      const sat = addDays(mon, 5);
      const placed: Placed[] = [];
      const cands = items.filter((it) => it.start && (it.finish ?? it.start) >= mon && it.start <= sat)
        .map((it) => {
          const s = it.start! < mon ? mon : it.start!;
          const f = (it.finish ?? it.start!) > sat ? sat : it.finish ?? it.start!;
          const c0 = Math.min(5, daysBetween(mon, s)), c1 = Math.max(c0, Math.min(5, daysBetween(mon, f)));
          return { item: it, c0, c1, clipL: it.start! < mon, clipR: (it.finish ?? it.start!) > sat, lane: 0 };
        })
        .filter((p) => daysBetween(mon, p.item.start! < mon ? mon : p.item.start!) <= 5)
        .sort((a, b) => a.c0 - b.c0 || (b.c1 - b.c0) - (a.c1 - a.c0) || Number(b.item.is_critical) - Number(a.item.is_critical));
      const laneEnd: number[] = [];
      for (const p of cands) {
        let l = laneEnd.findIndex((e) => e < p.c0);
        if (l < 0) { l = laneEnd.length; laneEnd.push(p.c1); } else laneEnd[l] = p.c1;
        p.lane = l;
        placed.push(p);
      }
      const week = weeks.find((w) => mondayOf(w.week_start) === mon);
      return { mon, sat, placed, lanes: laneEnd.length, week, ppc: week?.id ? ppc.find((x) => x.week_id === week.id) : undefined };
    });
  }, [items, weeks, periodStart, horizonEnd, ppc]);
  const late = items.filter((it) => it.window_role === 'late' || (it.finish && it.finish < (rows[0]?.mon ?? periodStart)));

  return (
    <div className="la-month" role="grid" aria-label={am ? 'የወር የሥራ ዕቅድ' : 'Monthly tasks window'}>
      {late.length > 0 && (
        <div className="la-late" aria-label="Overdue tasks">
          <span className="la-late-head"><Flame size={13} aria-hidden /> {am ? 'የዘገዩ (ካለፈው የተሸጋገሩ)' : 'Late — carried into this month'}</span>
          {late.map((it) => (
            <button key={it.id} className="la-bar role-late inline" onClick={() => onOpen(it)} title={`${it.name} · planned finish ${it.finish ?? '—'}`}>
              <span className="la-name">{it.name}</span><ReadyChip item={it} />
            </button>
          ))}
        </div>
      )}
      <div className="la-head" role="row">
        <div className="la-wk" role="columnheader">{am ? 'ሳምንት' : 'Week'}</div>
        {(am ? DOW_AM : DOW_EN).map((d) => <div key={d} role="columnheader" className="la-dow">{d}</div>)}
        <div className="la-ppc" role="columnheader">PPC</div>
      </div>
      {rows.map((r) => {
        const open = expanded.has(r.mon);
        const shown = open ? r.placed : r.placed.filter((p) => p.lane < MAX_LANES);
        const hidden = r.placed.length - shown.length;
        const lanes = open ? r.lanes : Math.min(r.lanes, MAX_LANES);
        return (
          <div className={`la-week${r.week?.in_buffer ? ' buffer' : ''}`} role="row" key={r.mon}>
            <div className="la-wk">
              <strong>W{r.week?.week_no ?? '—'}</strong>
              {r.week?.in_buffer && <span className="xs-text muted">{am ? 'ቀጣይ' : 'next month'}</span>}
              {r.week && r.week.status !== 'open' && <span className="xs-text muted">{r.week.status === 'closed' ? (am ? 'ተዘግቷል' : 'closed') : (am ? 'ተጀምሯል' : 'locked')}</span>}
            </div>
            <div className="la-days" style={{ gridTemplateRows: `auto repeat(${Math.max(lanes, 1)}, 24px) ${hidden ? 'auto' : ''}` }}>
              {Array.from({ length: 6 }, (_, i) => {
                const d = addDays(r.mon, i);
                const h = hol.get(d);
                const out = d < periodStart || d > horizonEnd;
                const e = toEthiopian(d);
                return (
                  <div key={d} role="gridcell" className={`la-day${out ? ' out' : ''}${d > periodEnd && !out ? ' buf' : ''}${h && !h.working ? ' hol' : ''}${d === today ? ' today' : ''}`}
                    style={{ gridColumn: i + 1, gridRow: `1 / span ${Math.max(lanes, 1) + 1 + (hidden ? 1 : 0)}` }}>
                    <span className="la-dnum">
                      {mode === 'ethiopian' ? <><strong>{e.day}</strong> <span className="subtle">{Number(d.slice(8))}/{Number(d.slice(5, 7))}</span></>
                        : <><strong>{Number(d.slice(8))}</strong> <span className="subtle">{e.day}</span></>}
                    </span>
                    {h && <span className={`la-hol${h.is_tentative ? ' tentative' : ''}`} title={h.is_tentative ? 'Date depends on the moon sighting — confirm' : undefined}>
                      {am && h.name_am ? h.name_am : h.name}{h.is_tentative ? (am ? ' (ግምት)' : ' (tentative)') : ''}</span>}
                  </div>
                );
              })}
              {shown.map((p) => (
                <button key={p.item.id} className={`la-bar role-${p.item.window_role}${p.item.is_critical ? ' crit' : ''}${p.item.status !== 'active' ? ' inactive' : ''}`}
                  style={{ gridColumn: `${p.c0 + 1} / ${p.c1 + 2}`, gridRow: p.lane + 2 }} onClick={() => onOpen(p.item)}
                  title={`${p.item.name} · ${roleLabel(p.item.window_role)} · ${p.item.start} → ${p.item.finish}${p.item.worst_description ? ` · ${p.item.worst_description}` : ''}${p.item.responsible_name ? ` · ${p.item.responsible_name}` : ''}`}>
                  {p.clipL && <ArrowLeft size={11} aria-label="continues from previous week" />}
                  {p.item.is_milestone && <Diamond size={11} aria-label="milestone" />}
                  <span className="la-name">{p.item.name}</span>
                  <ReadyChip item={p.item} />
                  {p.clipR && <ArrowRight size={11} aria-label="continues next week" />}
                </button>
              ))}
              {hidden > 0 && (
                <button className="link-btn la-more" style={{ gridColumn: '1 / -1', gridRow: lanes + 2 }} onClick={() => setExpanded((s) => new Set(s).add(r.mon))}>+{hidden} more ▾</button>
              )}
              {open && r.lanes > MAX_LANES && (
                <button className="link-btn la-more" style={{ gridColumn: '1 / -1', gridRow: lanes + 2 }} onClick={() => setExpanded((s) => { const n = new Set(s); n.delete(r.mon); return n; })}>Show less ▴</button>
              )}
            </div>
            <div className="la-ppc">
              {r.ppc && r.ppc.committed > 0 ? (
                <>
                  <span className="tnum strong">{r.ppc.completed}/{r.ppc.committed}</span>
                  <span className={`la-ppc-v ${ppcTone(r.ppc.ppc, r.ppc.ppc_target ?? ppcTarget)}`}>{r.ppc.ppc == null ? '—' : `${Math.round(r.ppc.ppc)} %`}</span>
                  {r.ppc.status !== 'closed' && <span className="xs-text muted">{am ? 'እስካሁን' : 'so far'}</span>}
                </>
              ) : <span className="xs-text muted">{r.placed.length} {am ? 'ሥራ' : 'tasks'}</span>}
            </div>
          </div>
        );
      })}
      <div className="la-legend" aria-label="Legend">
        {(['starting', 'ongoing', 'finishing', 'starting_next', 'late'] as const).map((k) => <span key={k}><i className={`la-sw role-${k}`} />{roleLabel(k)}</span>)}
        <span><i className="la-sw hol" />{am ? 'በዓል' : 'Holiday'}</span>
      </div>
    </div>
  );
}
