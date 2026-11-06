import type { ComponentType, ReactNode } from 'react';
import {
  ArrowLeftRight, ArrowUp, BadgeCheck, Ban, Check, CircleCheck, CircleDot, ClipboardCheck, Clock, Contrast, Flame, Hand,
  Hourglass, Lock, OctagonX, Pencil, Send, ShieldCheck, TriangleAlert, Truck, Undo2,
} from 'lucide-react';
import { humanize } from '../lib/format';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'primary' | 'violet';
type Icon = ComponentType<{ size?: number; 'aria-hidden'?: boolean; strokeWidth?: number }>;

/**
 * Status → tone/icon/label. Mirrors the mobile app (docs/research/mobile-design.md §1.6)
 * so a status looks the same on both. Unknown values render neutral with a humanized label.
 */
const STATUS: Record<string, { tone: Tone; icon?: Icon; label?: string }> = {
  // material requests
  draft: { tone: 'neutral', icon: Pencil },
  submitted: { tone: 'info', icon: Send },
  reviewed: { tone: 'info', icon: ClipboardCheck },
  returned: { tone: 'warning', icon: Undo2, label: 'Returned' },
  approved: { tone: 'success', icon: BadgeCheck },
  sourced: { tone: 'info' }, ordered: { tone: 'info' },
  partially_issued: { tone: 'violet', icon: Contrast, label: 'Part issued' },
  issued: { tone: 'primary', icon: Truck, label: 'Issued' },
  closed: { tone: 'neutral', icon: Lock },
  rejected: { tone: 'danger', icon: OctagonX },
  cancelled: { tone: 'neutral', icon: Ban },
  // documents
  pending_ack: { tone: 'warning', icon: Clock, label: 'Awaiting sign-off' },
  acknowledged: { tone: 'success', icon: Check },
  posted: { tone: 'success', icon: Check },
  reversed: { tone: 'danger', icon: ArrowLeftRight },
  in_transit: { tone: 'info', icon: Truck, label: 'In transit' },
  received: { tone: 'success', icon: Check },
  pending: { tone: 'warning', icon: Hourglass },
  adjusted: { tone: 'info' },
  reported: { tone: 'info', icon: CircleDot, label: 'To verify' },
  verified: { tone: 'success', icon: ShieldCheck },
  // elements
  not_started: { tone: 'neutral' },
  in_progress: { tone: 'primary' },
  completed: { tone: 'success', icon: CircleCheck },
  hold_point: { tone: 'warning', icon: Hand, label: 'Hold point' },
  // inspection / flags / stock
  pass: { tone: 'success', icon: Check }, good: { tone: 'success' },
  conditional: { tone: 'warning' }, reject: { tone: 'danger', icon: OctagonX },
  shortage: { tone: 'warning' }, excess: { tone: 'warning' },
  damaged: { tone: 'danger' }, wrong_grade: { tone: 'danger', label: 'Wrong grade' },
  available: { tone: 'success' }, quarantine: { tone: 'danger' },
  // priority
  urgent: { tone: 'warning', icon: ArrowUp }, critical: { tone: 'danger', icon: Flame },
  active: { tone: 'success' }, inactive: { tone: 'neutral', label: 'Deactivated' },
  warning: { tone: 'warning', icon: TriangleAlert },
};

/** Tone for a status value (useful for row markers, KPI edges). */
export const toneOf = (value: string | null | undefined): Tone => (value ? STATUS[value]?.tone ?? 'neutral' : 'neutral');

/**
 * Status badge: soft container + on-container text + leading icon/dot, so meaning is never colour-only.
 * `value` picks tone/icon from the shared map; override with `tone`, `label`, `icon`.
 * `outline` for secondary flags (Over BoQ, Emergency).
 */
export function Badge({ value, label, tone, icon, outline, title }: {
  value?: string | null; label?: ReactNode; tone?: Tone; icon?: Icon | null; outline?: boolean; title?: string;
}) {
  if (!value && !label) return null;
  const s = value ? STATUS[value] : undefined;
  const t = tone ?? s?.tone ?? 'neutral';
  const I = icon === null ? undefined : icon ?? s?.icon;
  return (
    <span className={`badge ${t}${outline ? ' outline' : ''}`} title={title}>
      {I ? <I size={12} strokeWidth={2} aria-hidden /> : <span className="dot" aria-hidden />}
      {label ?? s?.label ?? humanize(value)}
    </span>
  );
}

/** Priority: normal renders nothing (absence is the default). */
export function PriorityBadge({ value }: { value: string | null | undefined }) {
  if (!value || value === 'normal') return null;
  return <Badge value={value} />;
}
