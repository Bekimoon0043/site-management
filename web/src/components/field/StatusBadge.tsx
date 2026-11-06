import { Badge, type Tone } from '../ui';

/**
 * Tones for field/quality/control statuses the shared Badge map doesn't know yet.
 * Unknown values fall through to the shared map (icon + label) and then to neutral.
 */
const EXTRA: Record<string, { tone: Tone; label?: string }> = {
  // diary / inspection
  signed: { tone: 'success', label: 'Signed' },
  requested: { tone: 'info' },
  fail: { tone: 'danger', label: 'Fail' },
  // snags
  open: { tone: 'warning', label: 'Open' },
  ready_for_review: { tone: 'info', label: 'Ready for review' },
  reopened: { tone: 'warning', label: 'Reopened' },
  low: { tone: 'neutral', label: 'Low' },
  medium: { tone: 'info', label: 'Medium' },
  high: { tone: 'warning', label: 'High' },
  // concrete / rebar
  planned: { tone: 'neutral', label: 'Planned' },
  awaiting_receipt: { tone: 'warning', label: 'Awaiting receipt' },
  superseded: { tone: 'neutral', label: 'Superseded' },
  overdue: { tone: 'danger', label: 'Overdue' },
  due: { tone: 'warning', label: 'Due today' },
  upcoming: { tone: 'neutral', label: 'Upcoming' },
  ok: { tone: 'success', label: 'OK' },
  over: { tone: 'danger', label: 'Over' },
  under: { tone: 'warning', label: 'Under' },
  no_basis: { tone: 'warning', label: 'No BBS / take-off' },
  // gate / alerts
  exited: { tone: 'primary', label: 'Left site' },
  partially_returned: { tone: 'violet', label: 'Part returned' },
  info: { tone: 'info', label: 'Info' },
  exit_verified: { tone: 'success', label: 'Exit verified' },
  exit_mismatch: { tone: 'danger', label: 'Exit mismatch' },
  return_in: { tone: 'info', label: 'Returned in' },
};

/** Status badge with the field/control tone map. `returned` reads as good for gate passes. */
export function SBadge({ value, label, gate }: { value: string | null | undefined; label?: string; gate?: boolean }) {
  if (!value) return null;
  if (gate && value === 'returned') return <Badge value={value} tone="success" label={label ?? 'Returned'} />;
  const x = EXTRA[value];
  return <Badge value={value} tone={x?.tone} label={label ?? x?.label} />;
}
