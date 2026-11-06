// Work / no-work decision for one public holiday: proposal (site engineer, office engineer, coordinator) and the
// project manager's decision; an admin also confirms or moves a tentative (lunar) date.
import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import type { Lookups } from '../../lib/hooks';
import { date, dateTime } from '../../lib/format';
import { canCalendar, HOLIDAY_CHOICE_LABELS, type HolidayChoice, type HolidayDecision } from '../../lib/contract-calendar';
import { Badge, Banner, ErrorBanner, Field, toast, useBusy } from '../ui';
import { calRpc, ethLabel, holidayName } from './data';

const CHOICES: HolidayChoice[] = ['no_work', 'half_day', 'work'];

export function decisionBadge(d: Pick<HolidayDecision, 'status' | 'decision' | 'proposed_choice'>) {
  if (d.status === 'decided') return <Badge tone={d.decision === 'no_work' ? 'neutral' : 'success'} label={`Decided: ${HOLIDAY_CHOICE_LABELS[d.decision!].toLowerCase()}`} icon={null} />;
  if (d.status === 'proposed') return <Badge tone="warning" label={`Proposed: ${HOLIDAY_CHOICE_LABELS[d.proposed_choice!].toLowerCase()}`} icon={null} />;
  return <Badge tone="warning" label="Needs a decision" icon={null} />;
}

export function HolidayPanel({ d, holidayId, L, onChanged }: { d: HolidayDecision; holidayId?: string; L?: Lookups; onChanged: (msg: string) => void }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const mayDecide = canCalendar(role, 'decide');
  const mayPropose = canCalendar(role, 'propose') && !mayDecide && d.status !== 'decided';
  const [choice, setChoice] = useState<HolidayChoice>(d.decision ?? d.proposed_choice ?? 'no_work');
  const [note, setNote] = useState('');
  const [move, setMove] = useState(d.on_date);
  const { busy, error, run } = useBusy();
  const who = (id: string | null) => (id && L ? L.person(id) : '');

  const propose = () => void run(async () => {
    await calRpc('propose_holiday_decision', { decision_id: d.id, choice, note: note || undefined });
    toast.success('Proposal sent to the project manager');
    onChanged('Proposal sent');
  });
  const decide = (c: HolidayChoice | 'reopen') => void run(async () => {
    const r = await calRpc('decide_holiday', c === 'reopen' ? { decision_id: d.id, action: 'reopen' } : { decision_id: d.id, choice: c, note: note || undefined });
    const moved = Number(r.moved ?? 0);
    const msg = c === 'reopen' ? `${d.name} reopened — no work until decided` : `${d.name}: ${HOLIDAY_CHOICE_LABELS[c].toLowerCase()}${moved ? ` · ${moved} task${moved === 1 ? '' : 's'} re-dated` : ''}`;
    toast.success(msg);
    onChanged(msg);
  });
  const confirmDate = () => void run(async () => {
    await calRpc('save_public_holiday', { id: holidayId ?? d.holiday_id, on_date: move, is_tentative: false });
    toast.success(`${d.name} confirmed on ${date(move)} for every project`);
    onChanged('Date confirmed');
  });

  return (
    <div className="stack cal-holiday">
      <div>
        <h3 className="mb-0">{holidayName(d)}{d.name_am && holidayName(d) !== d.name_am ? <span className="muted"> · {d.name_am}</span> : null}</h3>
        <div className="muted small-text">{date(d.on_date)} · {ethLabel(d.on_date)}{d.days_to_go >= 0 ? ` · in ${d.days_to_go} day${d.days_to_go === 1 ? '' : 's'}` : ''}</div>
        <div className="mt-1">{decisionBadge(d)}</div>
      </div>
      <ErrorBanner error={error} />
      {d.is_tentative && <Banner tone="warn">Lunar holiday: the date is set by moon sighting and may move by a day.{canCalendar(role, 'holidays') ? ' Confirm it once announced.' : ' An admin confirms the announced date.'}</Banner>}
      {d.status !== 'decided' && <p className="small-text mb-0">Until the project manager decides, the site does <b>not</b> work on this day (calendar default). Public-holiday work is paid at 2.5×; obtain the Engineer's consent when the contract requires it.</p>}
      {d.proposed_choice && (
        <p className="small-text mb-0">Proposed <b>{HOLIDAY_CHOICE_LABELS[d.proposed_choice].toLowerCase()}</b>{d.proposed_by ? ` by ${who(d.proposed_by)}` : ''}{d.proposed_at ? ` · ${dateTime(d.proposed_at)}` : ''}{d.proposed_note ? ` — “${d.proposed_note}”` : ''}</p>
      )}
      {d.status === 'decided' && (
        <p className="small-text mb-0">Decided <b>{HOLIDAY_CHOICE_LABELS[d.decision!].toLowerCase()}</b>{d.decided_by ? ` by ${who(d.decided_by)}` : ''}{d.decided_at ? ` · ${dateTime(d.decided_at)}` : ''}{d.decision_note ? ` — “${d.decision_note}”` : ''}</p>
      )}

      {(mayPropose || mayDecide) && (
        <div className="cal-choice" role="radiogroup" aria-label="Work on this holiday?">
          {CHOICES.map((c) => (
            <label key={c} className={`choice-card${choice === c ? ' active' : ''}`}>
              <input type="radio" name={`hol-${d.id}`} checked={choice === c} onChange={() => setChoice(c)} />
              <strong>{HOLIDAY_CHOICE_LABELS[c]}</strong>
            </label>
          ))}
        </div>
      )}
      {(mayPropose || mayDecide) && <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder={choice === 'no_work' ? 'Optional' : 'e.g. slab pour cannot wait; crew agreed'} /></Field>}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {mayPropose && <button className="primary" disabled={busy} onClick={propose}>{busy && <span className="spinner" />}Propose to the manager</button>}
        {mayDecide && <button className="primary" disabled={busy} onClick={() => decide(choice)}>{busy && <span className="spinner" />}{d.status === 'decided' ? 'Change decision' : 'Confirm decision'}</button>}
        {mayDecide && d.status === 'decided' && <button disabled={busy} onClick={() => decide('reopen')}>Reopen</button>}
      </div>
      {!mayPropose && !mayDecide && d.status !== 'decided' && <p className="muted small-text mb-0">The project manager decides; site and office engineers and coordinators can propose.</p>}

      {canCalendar(role, 'holidays') && d.is_tentative && (
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Announced date"><input type="date" value={move} onChange={(e) => setMove(e.target.value)} /></Field>
          <button disabled={busy || !move} onClick={confirmDate}>Confirm date</button>
        </div>
      )}
    </div>
  );
}
