// Status / priority / sync → tone + icon + sentence-case label (spec §1.6).
// Meaning never comes from hue alone: every entry has an icon and words.
import type { IconName } from '../components/ui/Icon';
import type { Tone } from './tokens';
import { getLocale, tx } from '../lib/i18n';

export interface StatusInfo { tone: Tone; icon: IconName; label: string; muted?: boolean }

const S: Record<string, StatusInfo> = {
  // material_requests.status
  draft: { tone: 'neutral', icon: 'pencil-outline', label: 'Draft' },
  submitted: { tone: 'info', icon: 'send-outline', label: 'Submitted' },
  reviewed: { tone: 'info', icon: 'clipboard-check-outline', label: 'Reviewed' },
  returned: { tone: 'warning', icon: 'undo-variant', label: 'Returned' },
  approved: { tone: 'success', icon: 'check-decagram-outline', label: 'Approved' },
  sourced: { tone: 'info', icon: 'store-search-outline', label: 'Sourced' },
  ordered: { tone: 'info', icon: 'cart-outline', label: 'Ordered' },
  partially_issued: { tone: 'violet', icon: 'circle-half-full', label: 'Part issued' },
  issued: { tone: 'primary', icon: 'truck-check-outline', label: 'Issued' },
  closed: { tone: 'neutral', icon: 'lock-outline', label: 'Closed' },
  rejected: { tone: 'danger', icon: 'close-octagon-outline', label: 'Rejected' },
  cancelled: { tone: 'neutral', icon: 'cancel', label: 'Cancelled', muted: true },
  // material procurement flows (purchase requests, delivery notices)
  reviewed_by_coordinator: { tone: 'info', icon: 'clipboard-check-outline', label: 'Coordinator reviewed' },
  approved_by_management: { tone: 'success', icon: 'check-decagram-outline', label: 'Management approved' },
  with_procurement: { tone: 'info', icon: 'cart-outline', label: 'With procurement' },
  delivery_expected: { tone: 'info', icon: 'truck-fast-outline', label: 'Delivery expected' },
  notified: { tone: 'warning', icon: 'bell-outline', label: 'Notified' },
  reschedule_requested: { tone: 'warning', icon: 'calendar-outline', label: 'Reschedule asked' },
  arrived: { tone: 'info', icon: 'truck-delivery-outline', label: 'Arrived' },
  // store documents
  pending_ack: { tone: 'warning', icon: 'account-clock-outline', label: 'Awaiting sign-off' },
  acknowledged: { tone: 'success', icon: 'check', label: 'Acknowledged' },
  posted: { tone: 'success', icon: 'check', label: 'Posted' },
  reversed: { tone: 'danger', icon: 'swap-horizontal', label: 'Reversed' },
  in_transit: { tone: 'info', icon: 'truck-fast-outline', label: 'In transit' },
  received: { tone: 'success', icon: 'check', label: 'Received' },
  pending: { tone: 'warning', icon: 'timer-sand', label: 'Pending' },
  adjusted: { tone: 'info', icon: 'tune-variant', label: 'Adjusted' },
  // progress
  reported: { tone: 'info', icon: 'progress-clock', label: 'To verify' },
  verified: { tone: 'success', icon: 'shield-check-outline', label: 'Verified' },
  not_started: { tone: 'neutral', icon: 'circle-outline', label: 'Not started' },
  in_progress: { tone: 'primary', icon: 'progress-wrench', label: 'In progress' },
  completed: { tone: 'success', icon: 'check-circle-outline', label: 'Completed' },
  on_hold: { tone: 'warning', icon: 'hand-back-left-outline', label: 'On hold' },
  hold_point: { tone: 'warning', icon: 'hand-back-left-outline', label: 'Hold point' },
  // field & quality (diary / inspections / snags / pours / cubes / BBS)
  signed: { tone: 'success', icon: 'draw-pen', label: 'Signed' },
  requested: { tone: 'info', icon: 'clipboard-text-outline', label: 'Requested' },
  pass: { tone: 'success', icon: 'check-circle-outline', label: 'Pass' },
  conditional: { tone: 'warning', icon: 'alert-outline', label: 'Conditional' },
  fail: { tone: 'danger', icon: 'close-octagon-outline', label: 'Fail' },
  open: { tone: 'warning', icon: 'bug-outline', label: 'Open' },
  ready_for_review: { tone: 'info', icon: 'eye-outline', label: 'Ready for review' },
  reopened: { tone: 'danger', icon: 'undo-variant', label: 'Reopened' },
  planned: { tone: 'neutral', icon: 'calendar-outline', label: 'Planned' },
  awaiting_receipt: { tone: 'warning', icon: 'timer-sand', label: 'Awaiting receipt' },
  superseded: { tone: 'neutral', icon: 'history', label: 'Superseded', muted: true },
  ok: { tone: 'success', icon: 'check', label: 'OK' },
  low: { tone: 'warning', icon: 'alert-outline', label: 'Low' },
  // purchase orders / gate passes / alerts
  sent: { tone: 'info', icon: 'send-outline', label: 'Sent to supplier' },
  partially_received: { tone: 'violet', icon: 'circle-half-full', label: 'Part received' },
  exited: { tone: 'primary', icon: 'truck-fast-outline', label: 'Left site' },
  partially_returned: { tone: 'violet', icon: 'circle-half-full', label: 'Part returned' },
  delayed: { tone: 'danger', icon: 'clock-alert-outline', label: 'Delayed' },
  overdue: { tone: 'danger', icon: 'clock-alert-outline', label: 'Overdue' },
  on_loan: { tone: 'warning', icon: 'swap-horizontal', label: 'On loan' },
};

/** Stock count statuses reuse "submitted"/"approved"/"rejected". */
// Translated copies are cached per language so list rows don't allocate.
const cacheByLocale = new Map<string, Map<string, StatusInfo>>();
export function statusInfo(status: string | null | undefined): StatusInfo {
  if (!status) return { tone: 'neutral', icon: 'help-circle-outline', label: 'Unknown' };
  const loc = getLocale();
  let m = cacheByLocale.get(loc);
  if (!m) { m = new Map(); cacheByLocale.set(loc, m); }
  let r = m.get(status);
  if (!r) {
    const base = S[status] ?? { tone: 'neutral' as Tone, icon: 'information-outline' as IconName, label: sentence(status) };
    r = { ...base, label: tx(`status.${status}`, base.label) };
    m.set(status, r);
  }
  return r;
}

export function priorityInfo(p: string | null | undefined): StatusInfo | null {
  if (p === 'urgent') return { tone: 'warning', icon: 'alert-outline', label: 'Urgent' };
  if (p === 'critical') return { tone: 'danger', icon: 'fire', label: 'Critical path' };
  return null; // normal → no chip (absence is the default)
}

export type SyncKind = 'synced' | 'pending' | 'syncing' | 'failed' | 'offline' | 'stale';
export const SYNC_INFO: Record<SyncKind, StatusInfo> = {
  synced: { tone: 'success', icon: 'cloud-check-outline', label: 'Synced' },
  pending: { tone: 'warning', icon: 'cloud-upload-outline', label: 'Saved on phone · will sync' },
  syncing: { tone: 'info', icon: 'sync', label: 'Syncing…' },
  failed: { tone: 'danger', icon: 'cloud-alert-outline', label: 'Sync failed · tap to fix' },
  offline: { tone: 'neutral', icon: 'cloud-off-outline', label: 'Offline' },
  stale: { tone: 'neutral', icon: 'clock-alert-outline', label: 'Not synced recently' },
};

export const sentence = (s: string) => {
  const x = s.replace(/_/g, ' ').trim();
  return x ? x[0].toUpperCase() + x.slice(1) : x;
};
