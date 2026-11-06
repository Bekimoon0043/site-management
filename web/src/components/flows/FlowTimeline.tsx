import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Hand, OctagonX, Undo2 } from 'lucide-react';
import { flowStatusLabel, flowSteps, nextActor, stepIndex, type FlowMrStatus, type RequestType } from '../../lib/contract-flows';
import { ACTOR_LABEL, FLOW_STATUS_TONE, ageText, flowOpts, slaState, stepVerb, type FlowSettings, type TimelineStep, type TraceDoc } from '../../lib/flows';
import { shortDate, dateTime } from '../../lib/format';
import { Badge } from '../Badge';
import { Banner } from '../Page';
import './flows.css';

/** Status badge with the flow-specific label (purchase vs site use). */
export function FlowStatusBadge({ status, type }: { status: string; type: RequestType }) {
  const known = ['draft', 'submitted', 'reviewed', 'returned', 'approved', 'partially_issued', 'issued', 'closed', 'rejected', 'cancelled', 'received'];
  return <Badge value={known.includes(status) ? status : undefined} tone={FLOW_STATUS_TONE[status] ?? 'neutral'}
    label={flowStatusLabel(status as FlowMrStatus, type)} icon={known.includes(status) ? undefined : null} />;
}

function Age({ hours, sla }: { hours?: number | null; sla?: number | null }) {
  if (hours === null || hours === undefined) return null;
  const s = slaState(hours, sla);
  return <span className={s === 'ok' ? '' : s} title={sla ? `SLA ${sla} h` : undefined}>waiting {ageText(hours)}{s !== 'ok' ? ' ⚠' : ''}</span>;
}

/** Horizontal stepper for a request detail page (vertical below 720 px). */
export function FlowTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="flow-tl" aria-label="Request workflow">
      {steps.map((s, i) => (
        <li key={s.key} className={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
          <span className="ft-dot" aria-hidden>
            {s.state === 'done' ? <Check size={14} /> : s.state === 'returned' ? <Undo2 size={13} /> : s.state === 'rejected' ? <OctagonX size={13} /> : s.state === 'current' ? <Hand size={12} /> : <span className="xs-text">{i + 1}</span>}
          </span>
          <div className="ft-label">{s.label}</div>
          <div className="ft-meta">
            {s.state === 'done' && <>{s.who}{s.at && <> · <span title={dateTime(s.at)}>{shortDate(s.at)}</span></>}</>}
            {s.state === 'skipped' && (s.note ?? 'Skipped')}
            {(s.state === 'returned' || s.state === 'rejected') && <>{s.note}{s.who && <> · {s.who}</>}{s.at && <> · {shortDate(s.at)}</>}</>}
            {s.state === 'current' && <><strong>{s.actor ? ACTOR_LABEL[s.actor] : ''}</strong> · <Age hours={s.hours} sla={s.slaHours} />{s.slaHours ? <span className="muted"> (SLA {s.slaHours} h)</span> : null}</>}
            {s.state === 'waiting' && s.actor && ACTOR_LABEL[s.actor]}
          </div>
          {s.state === 'current' && s.assignees && s.assignees.length > 0 && <div className="ft-meta">Waiting for: {s.assignees.join(', ')}</div>}
          {s.state === 'current' && s.note && <div className="ft-meta">{s.note}</div>}
          {s.state === 'returned' && s.assignees?.length ? <div className="ft-meta">Waiting for: {s.assignees.join(', ')} · <Age hours={s.hours} /></div> : null}
          {s.comment && (s.state === 'done' || s.state === 'returned' || s.state === 'rejected') && <div className="ft-comment">“{s.comment}”</div>}
          {s.state === 'done' && s.note && <div className="ft-meta">{s.note}</div>}
        </li>
      ))}
    </ol>
  );
}

/** Compact variant for table rows: ●●◉○○ Coordinator · 2 d. */
export function FlowPill({ type, status, hours, sla, settings }: {
  type: RequestType; status: string; hours?: number | null; sla?: number | null; settings?: FlowSettings | null;
}) {
  const steps = flowSteps(type);
  const st = status as FlowMrStatus;
  const done = st === 'closed' || st === 'received';
  const bad = st === 'rejected' || st === 'cancelled';
  const actor = done || bad ? null : nextActor(st, type, flowOpts(settings));
  let idx = stepIndex(st, type);
  if (st === 'submitted' && actor && steps[idx]?.actor !== actor && steps[idx + 1]?.actor === actor) idx += 1;
  const s = slaState(hours, sla);
  const label = bad ? flowStatusLabel(st, type) : done ? flowStatusLabel(st, type) : actor ? ACTOR_LABEL[actor] : flowStatusLabel(st, type);
  const aria = bad || done ? label : `Step ${idx + 1} of ${steps.length}, waiting for ${label}${hours ? ` for ${ageText(hours)}` : ''}`;
  return (
    <span className="flow-pill" aria-label={aria} title={aria}>
      <span className="dots" aria-hidden>
        {steps.map((x, i) => (
          <span key={x.key} className={`d ${done || i < idx ? 'done' : i === idx ? (bad ? 'bad' : st === 'returned' ? 'ret' : 'current') : ''}`} />
        ))}
      </span>
      <span className="who">{label}</span>
      {!done && !bad && hours !== null && hours !== undefined && <span className={s === 'ok' ? 'muted' : s}>· {ageText(hours)}</span>}
    </span>
  );
}

/** "Your turn" banner (schedule-ux §9.2) with the step's single primary action. */
export function YourTurnBanner({ step, type, action }: { step: TimelineStep | null; type: RequestType; action?: ReactNode }) {
  if (!step) return null;
  const s = slaState(step.hours, step.slaHours);
  return (
    <Banner tone="attention" action={action}>
      <strong>Your turn:</strong> {step.state === 'returned' ? 'fix and resubmit this request' : stepVerb(step.key, type)}
      {step.hours !== null && step.hours !== undefined && <> · <span className={s === 'late' ? 'danger-text strong' : s === 'warn' ? 'strong' : ''}>waiting {ageText(step.hours)}</span></>}
      {step.slaHours ? <span className="muted"> (SLA {step.slaHours} h)</span> : null}
    </Banner>
  );
}

const KIND_LABEL: Record<TraceDoc['kind'], string> = { SUR: 'Site use', PR: 'Purchase', RFQ: 'RFQ', PO: 'PO', DN: 'Notice', GRN: 'GRN', MIV: 'Issue' };

/** Horizontal chip chain: SUR → PR → RFQ → PO → delivery notice → GRN → MIV. */
export function TraceChain({ docs }: { docs: TraceDoc[] }) {
  if (!docs.length) return <span className="muted small-text">No linked documents yet.</span>;
  return (
    <div className="trace-chain" aria-label="Document chain">
      {docs.map((d, i) => (
        <Fragment key={`${d.kind}${d.id}`}>
          {i > 0 && <ChevronRight size={12} className="arrow" aria-hidden />}
          <span className="kind">{KIND_LABEL[d.kind]}</span>
          {d.to ? <Link to={d.to}><Badge tone={FLOW_STATUS_TONE[d.status] ?? 'neutral'} label={d.label} icon={null} title={d.status} /></Link>
            : <Badge tone={FLOW_STATUS_TONE[d.status] ?? 'neutral'} label={d.label} icon={null} title={d.status} />}
        </Fragment>
      ))}
    </div>
  );
}
