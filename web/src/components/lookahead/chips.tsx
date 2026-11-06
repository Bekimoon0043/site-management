import { CircleCheck, CircleDashed, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { ConstraintStatus, NeedStatus, Readiness } from '../../lib/contract-lookahead';
import { CONSTRAINT_STATUS_LABELS, NEED_STATUS_LABELS } from '../../lib/contract-lookahead';
import { Badge, type Tone } from '../Badge';
import { ctypeLabel, ctypeShort, lbl, readinessLabel, type LaItem } from './la';

const R_TONE: Record<Readiness, Tone> = { ready: 'success', at_risk: 'warning', not_ready: 'danger' };
const R_ICON = { ready: CircleCheck, at_risk: TriangleAlert, not_ready: OctagonAlert };

/** Readiness as icon + word (+ worst constraint type when not ready). */
export function ReadyBadge({ item, short }: { item: Pick<LaItem, 'readiness' | 'worst_ctype' | 'worst_description' | 'open_constraints'>; short?: boolean }) {
  const r = item.readiness;
  if (!r) return <Badge tone="neutral" icon={CircleDashed} label={readinessLabel(null)} outline />;
  const word = r === 'ready' ? readinessLabel(r) : item.worst_ctype ? (short ? ctypeShort(item.worst_ctype) : `${readinessLabel(r)} · ${ctypeLabel(item.worst_ctype)}`) : readinessLabel(r);
  return <Badge tone={R_TONE[r]} icon={R_ICON[r]} label={word} title={item.worst_description ?? undefined} />;
}

/** Compact chip inside a calendar bar. */
export function ReadyChip({ item }: { item: Pick<LaItem, 'readiness' | 'worst_ctype' | 'worst_description'> }) {
  const r = item.readiness;
  if (!r) return null;
  const I = R_ICON[r];
  return (
    <span className={`la-chip ${r}`} title={item.worst_description ?? readinessLabel(r)}>
      <I size={11} aria-hidden />{r === 'ready' ? readinessLabel(r) : ctypeShort(item.worst_ctype) || readinessLabel(r)}
    </span>
  );
}

const C_TONE: Record<ConstraintStatus, Tone> = { open: 'warning', in_progress: 'info', cleared: 'success', blocked: 'danger', waived: 'neutral' };
export function ConstraintStatusBadge({ status }: { status: ConstraintStatus }) {
  const I = status === 'cleared' ? CircleCheck : status === 'blocked' ? OctagonAlert : status === 'waived' ? undefined : TriangleAlert;
  return <Badge tone={C_TONE[status]} icon={I ?? null} label={lbl(CONSTRAINT_STATUS_LABELS[status], status)} />;
}

const N_TONE: Record<NeedStatus, Tone> = { late_order: 'danger', raise_pr_now: 'danger', to_order: 'warning', arrives_late: 'warning', in_procurement: 'info', covered: 'success' };
export function NeedBadge({ status }: { status: NeedStatus }) {
  const I = status === 'covered' ? CircleCheck : status === 'late_order' || status === 'raise_pr_now' ? OctagonAlert : TriangleAlert;
  return <Badge tone={N_TONE[status]} icon={status === 'in_procurement' ? null : I} label={lbl(NEED_STATUS_LABELS[status], status)} />;
}
