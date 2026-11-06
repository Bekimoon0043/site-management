// Sync status: outbox entries with retry / discard, photo uploads (FR-OF-04).
import React from 'react';
import { Stack } from 'expo-router';
import { useData, useSyncState } from '../lib/app';
import { discardOp, outbox, retryOp, syncNow } from '../lib/sync';
import { pendingUploads, retryUpload, wifiOnly } from '../lib/photos';
import { ago, fmtDateTime } from '../lib/format';
import { SYNC_INFO } from '../theme';
import { Banner, Button, Card, Chip, EmptyState, Row, Screen, Section, SpinningIcon, Text, confirm } from '../components/ui';
import { useTheme } from '../theme';

export default function SyncScreen() {
  const t = useTheme();
  const s = useSyncState();
  const entries = useData(() => outbox());
  const uploads = useData(() => pendingUploads());
  const failed = entries.filter((e) => e.status === 'failed');
  const pending = entries.filter((e) => e.status === 'pending');
  const done = entries.filter((e) => e.status === 'synced');

  const row = (e: (typeof entries)[number]) => {
    const info = SYNC_INFO[e.status === 'synced' ? 'synced' : e.status === 'pending' ? 'pending' : 'failed'];
    return (
      <Card key={e.id} dense stripe={e.status === 'failed' ? 'danger' : null}>
        <Row justify="space-between" align="flex-start">
          <Text variant="label" style={{ flex: 1 }}>{e.label ?? e.rpc}</Text>
          <Chip label={e.status === 'synced' ? 'Synced' : e.status === 'pending' ? 'Waiting' : 'Rejected'} tone={info.tone} icon={info.icon} small />
        </Row>
        <Text variant="caption" tone="muted">{fmtDateTime(e.created_at)} · {e.rpc} · attempts {e.attempts}</Text>
        {e.error ? <Text variant="bodySm" tone="danger">{e.error}</Text> : null}
        {e.status === 'failed' ? (
          <Row>
            <Button size="md" variant="dangerOutline" title="Discard" flex onPress={() => confirm('Discard change', 'This removes the change from this device. It was never accepted by the server.', () => discardOp(e.id), 'Discard', true)} />
            <Button size="md" title="Retry" icon="refresh" flex onPress={() => retryOp(e.id)} />
          </Row>
        ) : null}
      </Card>
    );
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Sync status' }} />
      <Card stripe={!s.online ? 'neutral' : failed.length ? 'danger' : pending.length ? 'warning' : 'success'}>
        <Row gap={8}>
          {s.running ? <SpinningIcon spinning color={t.info} /> : null}
          <Text variant="titleSm">{s.running ? 'Syncing…' : s.online ? 'Online' : 'Offline · working from this phone'}</Text>
        </Row>
        <Text variant="bodySm" tone="muted">Last successful sync {ago(s.lastSyncAt)}{s.lastSyncAt ? ` (${fmtDateTime(s.lastSyncAt)})` : ''}</Text>
        <Row wrap gap={6}>
          <Chip label={`${pending.length} waiting`} tone={pending.length ? 'warning' : 'neutral'} icon="cloud-upload-outline" />
          <Chip label={`${failed.length} rejected`} tone={failed.length ? 'danger' : 'neutral'} icon="cloud-alert-outline" />
          <Chip label={`${uploads.length} photo(s)${wifiOnly() ? ' · Wi-Fi only' : ''}`} tone="neutral" icon="image-outline" />
        </Row>
        {s.lastError ? <Text variant="bodySm" tone="danger">{s.lastError}</Text> : null}
        <Button title="Sync now" icon="sync" block onPress={() => void syncNow()} busy={s.running} />
      </Card>

      {failed.length ? (
        <Banner tone="danger" title={`${failed.length} change${failed.length > 1 ? 's were' : ' was'} rejected by the server`}
          text="For example stock was no longer available. Fix the cause and retry, or discard to undo the change on this phone." />
      ) : null}

      {failed.length ? <Section title="Needs fixing">{failed.map(row)}</Section> : null}
      {pending.length ? <Section title="Saved on phone · will sync">{pending.map(row)}</Section> : null}
      {uploads.length ? (
        <Section title="Photo uploads">
          {uploads.map((u) => (
            <Card key={u.id} dense>
              <Row justify="space-between">
                <Text variant="label">{u.entity_type} photo</Text>
                <Chip label={u.status === 'failed' ? 'Failed' : 'Waiting'} tone={u.status === 'failed' ? 'danger' : 'warning'} icon={u.status === 'failed' ? 'cloud-alert-outline' : 'cloud-upload-outline'} small />
              </Row>
              {u.error ? <Text variant="bodySm" tone="danger">{u.error}</Text> : null}
              {u.status === 'failed' ? <Button size="md" title="Retry" icon="refresh" onPress={() => retryUpload(u.id)} /> : null}
            </Card>
          ))}
        </Section>
      ) : null}
      <Section title="Synced (last 7 days)">
        {done.length ? done.map(row) : <EmptyState icon="cloud-check-outline" title="No changes recorded on this device" compact />}
      </Section>
    </Screen>
  );
}
