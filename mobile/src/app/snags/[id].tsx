// Snag detail: photos, facts, timeline of events and the lifecycle actions
// start / ready for review (assignee, engineers) · close / reopen / cancel (reviewers).
import React, { useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get, list } from '../../lib/db';
import { canField, SNAG_STATUS_LABELS, type Snag, type SnagAction, type SnagEvent } from '../../lib/contract-field';
import { elementLabel, personName } from '../../lib/queries';
import { enqueue } from '../../lib/sync';
import { fmtDate, fmtDateTime, today } from '../../lib/format';
import {
  ActionBar, Card, Chip, EmptyState, InfoRow, ListRow, PhotoStrip, ReasonSheet, Row, Screen, Section, StatusChip, SyncChip, SyncError, Text,
  haptic, toast, type BarAction,
} from '../../components/ui';
import { SEVERITY_INFO } from '../../components/field';

const LABEL: Record<SnagAction, string> = { start: 'Start work', ready: 'Ready for review', close: 'Close snag', reopen: 'Reopen', cancel: 'Cancel snag' };
const ACTION_TEXT: Record<string, string> = { create: 'Raised', edit: 'Edited', start: 'Work started', ready: 'Marked ready for review', close: 'Closed', reopen: 'Reopened', cancel: 'Cancelled' };

export default function SnagDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useSession();
  const [reason, setReason] = useState<SnagAction | null>(null);
  const d = useData(() => {
    const s = get<Snag>('snags', id);
    return s ? { s, events: list<SnagEvent>('snag_events', { parent: id }).sort((a, b) => b.created_at.localeCompare(a.created_at)) } : null;
  }, [id]);
  if (!d) return <Screen><Stack.Screen options={{ title: 'Snag' }} /><EmptyState icon="cloud-off-outline" title="Not on this phone yet" /></Screen>;
  const { s, events } = d;
  const reviewer = canField(profile.role, 'snag.review');
  const worker = reviewer || profile.role === 'site_engineer' || s.assignee_user_id === profile.id;
  const sev = SEVERITY_INFO[s.severity];
  const overdue = !!s.due_date && s.due_date < today() && !['closed', 'cancelled'].includes(s.status);

  const act = (a: SnagAction, comment?: string) => {
    enqueue('snag_action', { snag_id: s.id, action: a, comment }, { entityType: 'snag', entityId: s.id, label: `${s.number} ${LABEL[a].toLowerCase()}` });
    haptic(a === 'close' ? 'confirm' : a === 'reopen' || a === 'cancel' ? 'reject' : 'tick');
    toast.success(`${s.number}: ${LABEL[a].toLowerCase()} · saved on phone`);
  };

  const actions: BarAction[] = [];
  if (worker && (s.status === 'open' || s.status === 'reopened')) actions.push({ title: LABEL.start, variant: 'outline', icon: 'play-outline', onPress: () => act('start') });
  if (worker && ['open', 'in_progress', 'reopened'].includes(s.status)) actions.push({ title: LABEL.ready, icon: 'check', onPress: () => act('ready') });
  if (reviewer && s.status === 'ready_for_review') {
    actions.push({ title: LABEL.reopen, variant: 'dangerOutline', icon: 'undo-variant', onPress: () => setReason('reopen') });
    actions.push({ title: LABEL.close, variant: 'hero', icon: 'check-all', onPress: () => act('close') });
  }
  if (reviewer && s.status === 'closed') actions.push({ title: LABEL.reopen, variant: 'dangerOutline', icon: 'undo-variant', onPress: () => setReason('reopen') });
  const primary = actions[actions.length - 1];
  const secondary = actions.length > 1 ? actions[actions.length - 2] : null;
  const canCancel = reviewer && ['open', 'in_progress', 'reopened'].includes(s.status);

  return (
    <Screen footer={primary ? <ActionBar primary={primary} secondary={secondary}
      tertiary={canCancel ? { title: 'Cancel', variant: 'ghost', onPress: () => setReason('cancel') } : null} /> : undefined}>
      <Stack.Screen options={{ title: s.number }} />
      <SyncError entityId={s.id} />
      <PhotoStrip projectId={s.project_id} entityType="snag" entityId={s.id} canAdd={!['closed', 'cancelled'].includes(s.status)}
        label={s.status === 'ready_for_review' || s.status === 'in_progress' ? 'Photos (add an after photo)' : 'Photos'} />
      <Card stripe={sev.tone === 'neutral' ? null : sev.tone}>
        <Row wrap gap={6}>
          <StatusChip status={s.status} label={SNAG_STATUS_LABELS[s.status]} />
          <Chip label={sev.label} tone={sev.tone} icon={sev.icon} />
          {overdue ? <Chip label="Overdue" tone="danger" icon="clock-alert-outline" /> : null}
          <SyncChip entityId={s.id} />
        </Row>
        <Text variant="titleSm">{s.title}</Text>
        {s.description ? <Text variant="body">{s.description}</Text> : null}
        {s.element_id ? <InfoRow label="Element" value={elementLabel(s.element_id)} /> : null}
        {s.location_text ? <InfoRow label="Location" value={s.location_text} /> : null}
        {s.trade ? <InfoRow label="Trade" value={s.trade} /> : null}
        <InfoRow label="Assigned to" value={s.assignee_user_id ? personName(s.assignee_user_id) : s.assignee_party ?? 'Not assigned'} />
        {s.due_date ? <InfoRow label="Fix by" value={fmtDate(s.due_date)} tone={overdue ? 'danger' : 'default'} /> : null}
        <InfoRow label="Raised" value={`${personName(s.raised_by)} · ${fmtDate(s.created_at)}`} />
        {s.closed_by ? <InfoRow label="Closed" value={`${personName(s.closed_by)} · ${fmtDateTime(s.closed_at)}`} tone="success" /> : null}
      </Card>
      {s.source_type === 'inspection' && s.source_id ? (
        <Card flush><ListRow id={s.source_id} title="From inspection" subtitle={get<{ number: string }>('inspections', s.source_id)?.number ?? ''} icon="clipboard-check-outline" chevron onPress={(x) => router.push(`/inspections/${x}`)} /></Card>
      ) : null}
      {s.source_type === 'cube' && s.source_id ? (
        <Card flush><ListRow id={s.source_id} title="From cube test" subtitle={get<{ number: string }>('cube_sets', s.source_id)?.number ?? ''} icon="test-tube" chevron onPress={(x) => router.push(`/pours/cubes/${x}`)} /></Card>
      ) : null}
      <Section title="Timeline">
        {events.length ? (
          <Card flush>
            {events.map((e) => (
              <ListRow key={e.id} id={e.id} title={ACTION_TEXT[e.action] ?? e.action} subtitle={`${personName(e.actor)} · ${fmtDateTime(e.created_at)}${e.comment ? ` — ${e.comment}` : ''}`}
                icon={e.action === 'close' ? 'check-all' : e.action === 'reopen' ? 'undo-variant' : e.action === 'create' ? 'bug-outline' : 'history'}
                iconTone={e.action === 'close' ? 'success' : e.action === 'reopen' || e.action === 'cancel' ? 'danger' : 'primary'} />
            ))}
          </Card>
        ) : <Text variant="bodySm" tone="muted">No history yet.</Text>}
      </Section>
      <ReasonSheet visible={!!reason} onClose={() => setReason(null)} title={reason === 'cancel' ? 'Cancel snag' : 'Reopen snag'} variant="danger"
        confirmLabel={reason === 'cancel' ? 'Cancel snag' : 'Reopen'}
        reasons={reason === 'cancel' ? ['Duplicate', 'Not a defect', 'Raised by mistake'] : ['Not fixed', 'Fix incomplete', 'No after photo', 'New damage']}
        onConfirm={(r) => { const a = reason!; setReason(null); act(a, r); }} />
    </Screen>
  );
}
