// Inspection result / detail: big outcome, whether the hold point cleared, item responses,
// snags raised. Requested → "Do inspection" (office engineer) or cancel; failed → re-inspect.
import React, { useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get, list } from '../../lib/db';
import type { ElementActivity } from '../../lib/contract';
import { canField, type ChecklistTemplate, type Inspection, type InspectionItem, type Snag } from '../../lib/contract-field';
import { holdPointState } from '../../lib/field';
import { elementLabel, personName } from '../../lib/queries';
import { enqueue } from '../../lib/sync';
import { fmtDateTime } from '../../lib/format';
import {
  ActionBar, Banner, Card, Chip, EmptyState, InfoRow, ListRow, PhotoStrip, ReasonSheet, Row, Screen, Section, StatusChip, SuccessTick, SyncChip,
  SyncError, Text, haptic, toast, type BarAction,
} from '../../components/ui';

export default function InspectionDetail() {
  const { id, done } = useLocalSearchParams<{ id: string; done?: string }>();
  const { profile } = useSession();
  const [cancel, setCancel] = useState(false);
  const d = useData(() => {
    const i = get<Inspection>('inspections', id);
    if (!i) return null;
    const items = list<InspectionItem>('inspection_items', { parent: id }).sort((a, b) => a.seq - b.seq);
    const snags = list<Snag>('snags', { parent: i.element_id }).filter((s) => s.source_id === id);
    const act = i.element_activity_id ? get<ElementActivity>('element_activities', i.element_activity_id) : null;
    return { i, items, snags, act, tpl: get<ChecklistTemplate>('checklist_templates', i.template_id), hold: act ? holdPointState(i.project_id, act.id) : null };
  }, [id]);
  if (!d) return <Screen><Stack.Screen options={{ title: 'Inspection' }} /><EmptyState icon="cloud-off-outline" title="Not on this phone yet" /></Screen>;
  const { i, items, snags, act, tpl, hold } = d;
  const canPerform = canField(profile.role, 'inspection.perform');
  const canCancel = i.status === 'requested' && (i.requested_by === profile.id || canPerform);

  let primary: BarAction | null = null;
  let secondary: BarAction | null = null;
  if (i.status === 'requested' && canPerform) primary = { title: 'Do inspection', variant: 'hero', icon: 'clipboard-check-outline', onPress: () => router.push(`/inspections/check?id=${i.id}`) };
  if (i.status === 'requested' && canCancel) secondary = { title: 'Cancel request', variant: 'dangerOutline', onPress: () => setCancel(true) };
  if (i.status === 'completed' && i.result === 'fail' && canField(profile.role, 'inspection.request')) {
    primary = { title: 'Re-inspect', icon: 'refresh', onPress: () => router.push(`/inspections/check?element=${i.element_id}${i.element_activity_id ? `&activity=${i.element_activity_id}` : ''}&template=${i.template_id}&reinspect=${i.id}`) };
  }
  if (!primary && secondary) { primary = secondary; secondary = null; }

  const tone = i.result === 'pass' ? 'success' : i.result === 'conditional' ? 'warning' : 'danger';
  return (
    <Screen footer={primary ? <ActionBar primary={primary} secondary={secondary} /> : undefined}>
      <Stack.Screen options={{ title: i.number }} />
      <SyncError entityId={i.id} />
      {i.status === 'completed' && i.result ? (
        <Card stripe={tone}>
          {done ? <Row justify="center"><SuccessTick size={56} /></Row> : null}
          <Row justify="space-between">
            <Text variant="headline" tone={tone}>{i.result === 'pass' ? 'Passed' : i.result === 'conditional' ? 'Passed with remarks' : 'Failed'}</Text>
            <StatusChip status={i.result} />
          </Row>
          {act?.is_hold_point ? (
            hold?.cleared
              ? <Banner tone="success" icon="lock-open-outline" title="Hold point cleared" text={`${act.name} is signed off. Work can continue.`} />
              : i.result === 'fail'
                ? <Banner tone="danger" icon="lock-outline" title="Hold point still closed" text="Fix the snags, then re-inspect." />
                : <Banner tone="warning" icon="lock-outline" title="Hold point not cleared yet" text={hold?.pending.length ? `Still needed: ${hold.pending.map((p) => p.name).join(', ')}` : 'Waiting for sync.'} />
          ) : null}
        </Card>
      ) : null}
      <Card>
        <Row wrap gap={6}><StatusChip status={i.status} /><SyncChip entityId={i.id} showSynced /></Row>
        <Text variant="titleSm">{tpl?.name ?? 'Checklist'}</Text>
        <InfoRow label="Element" value={elementLabel(i.element_id)} />
        {act ? <InfoRow label="Activity" value={act.name} icon={act.is_hold_point ? 'hand-back-left-outline' : undefined} /> : null}
        <InfoRow label="Requested" value={`${personName(i.requested_by)} · ${fmtDateTime(i.requested_at ?? i.created_at)}`} />
        {i.requested_for ? <InfoRow label="Wanted on" value={fmtDateTime(i.requested_for)} /> : null}
        {i.inspector_id ? <InfoRow label="Inspected" value={`${personName(i.inspector_id)} · ${fmtDateTime(i.inspected_at)}`} /> : null}
        {i.consultant_name ? <InfoRow label="Consultant" value={i.consultant_name} /> : null}
        {i.remarks ? <InfoRow label="Remarks" value={i.remarks} /> : null}
        {i.reinspection_of ? <InfoRow label="Re-inspection of" value={get<Inspection>('inspections', i.reinspection_of)?.number ?? '—'} /> : null}
      </Card>

      {snags.length ? (
        <Section title={`Snags raised · ${snags.length}`}>
          <Card flush>
            {snags.map((s) => <ListRow key={s.id} id={s.id} title={s.title} subtitle={s.number} status={s.status} icon="bug-outline" iconTone="danger" chevron onPress={(sid) => router.push(`/snags/${sid}`)} />)}
          </Card>
        </Section>
      ) : null}

      {items.length ? (
        <Section title="Checklist">
          {items.map((it) => (
            <Card key={it.id} dense stripe={it.response === 'fail' ? 'danger' : it.response === 'pass' ? 'success' : 'neutral'}>
              <Row align="flex-start" justify="space-between">
                <Text variant="body" style={{ flex: 1 }}>{it.seq}. {it.text}</Text>
                <Chip label={it.response === 'na' ? 'N/A' : it.response === 'pass' ? 'Pass' : 'Fail'} tone={it.response === 'fail' ? 'danger' : it.response === 'pass' ? 'success' : 'neutral'}
                  icon={it.response === 'fail' ? 'close' : it.response === 'pass' ? 'check' : undefined} small />
              </Row>
              {it.value_num != null ? <Text variant="bodySm" tone="muted" num>Measured {it.value_num}</Text> : null}
              {it.value_text ? <Text variant="bodySm">{it.value_text}</Text> : null}
              {it.is_critical ? <Text variant="caption" tone="danger">Critical item</Text> : null}
              <PhotoStrip projectId={i.project_id} entityType="inspection_item" entityId={it.id} canAdd={false} label="Photo" />
            </Card>
          ))}
        </Section>
      ) : null}
      <PhotoStrip projectId={i.project_id} entityType="inspection" entityId={i.id} canAdd={i.status !== 'cancelled'} label="Inspection photos" />

      <ReasonSheet visible={cancel} onClose={() => setCancel(false)} title="Cancel inspection request" confirmLabel="Cancel request" variant="danger"
        reasons={['Not ready yet', 'Requested by mistake', 'Wrong checklist']} allowEmpty
        onConfirm={(r) => {
          setCancel(false);
          enqueue('cancel_inspection', { inspection_id: i.id, comment: r || undefined }, { entityType: 'inspection', entityId: i.id, label: `${i.number} cancelled` });
          haptic('reject'); toast.success(`${i.number} cancelled`);
        }} />
    </Screen>
  );
}
