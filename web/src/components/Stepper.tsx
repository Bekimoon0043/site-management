import { Fragment } from 'react';
import { Check, ChevronRight } from 'lucide-react';

/** Numbered wizard steps. Completed steps are clickable (go back); future steps are not. */
export function Stepper({ steps, current, onStep }: { steps: string[]; current: number; onStep?: (i: number) => void }) {
  return (
    <ol className="stepper" aria-label="Progress" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {steps.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <li className="step-line" aria-hidden />}
          <li>
            <button type="button" className={`step${i < current ? ' done' : i === current ? ' current' : ''}`} disabled={i >= current || !onStep}
              aria-current={i === current ? 'step' : undefined} onClick={() => onStep?.(i)}>
              <span className="step-n">{i < current ? <Check size={14} /> : i + 1}</span>{s}
            </button>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

const MR_FLOW = ['draft', 'submitted', 'reviewed', 'approved', 'issued', 'closed'] as const;
const FLOW_LABEL: Record<string, string> = { draft: 'Draft', submitted: 'Submitted', reviewed: 'Reviewed', approved: 'Approved', issued: 'Issued', closed: 'Closed' };

/** Horizontal lifecycle for a material request; terminal states (rejected/cancelled/returned) replace the tail. */
export function MrLifecycle({ status }: { status: string }) {
  const norm = status === 'partially_issued' || status === 'sourced' || status === 'ordered' ? (status === 'partially_issued' ? 'issued' : 'approved') : status;
  const terminal = ['rejected', 'cancelled', 'returned'].includes(norm);
  const idx = terminal ? 1 : MR_FLOW.indexOf(norm as (typeof MR_FLOW)[number]);
  const shown = terminal ? MR_FLOW.slice(0, 2) : MR_FLOW;
  return (
    <div className="lifecycle" aria-label="Request lifecycle">
      {shown.map((s, i) => {
        const cls = terminal || i < idx ? 'done' : i === idx ? 'current' : '';
        return (
          <Fragment key={s}>
            {i > 0 && <ChevronRight size={12} aria-hidden />}
            <span className={`lc ${cls}`} aria-current={cls === 'current' ? 'step' : undefined}>
              {cls === 'done' && <Check size={12} aria-hidden />}{FLOW_LABEL[s]}{status === 'partially_issued' && s === 'issued' ? ' (part)' : ''}
            </span>
          </Fragment>
        );
      })}
      {terminal && <><ChevronRight size={12} aria-hidden /><span className="lc terminal">{norm === 'returned' ? 'Returned' : norm === 'rejected' ? 'Rejected' : 'Cancelled'}</span></>}
    </div>
  );
}
