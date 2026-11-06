// Office engineer verification of site-reported progress (FR-PG-03).
import React, { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Stack, router } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get } from '../../lib/db';
import type { ElementActivity, ProgressUpdate } from '../../lib/contract';
import { jf, rowsWhere, scheduleCounts } from '../../lib/counts';
import { t as tr } from '../../lib/i18n';
import type { Href } from 'expo-router';
import { elementLabel, personName } from '../../lib/queries';
import { enqueue } from '../../lib/sync';
import { fmtDate, fmtQty, num } from '../../lib/format';
import { space } from '../../theme';
import {
  Banner, Button, Card, Chip, EmptyState, Field, PhotoStrip, QuantityStepper, Row, Screen, SyncDot, Text, haptic, showError, toast,
} from '../../components/ui';

export default function Verify() {
  const { project, profile } = useSession();
  const taskReports = useData(() => scheduleCounts(project.id, profile.id).tasksToVerify, [project.id, profile.id]);
  const [pct, setPct] = useState<Record<string, string>>({});
  const [comment, setComment] = useState<Record<string, string>>({});
  const rows = useData(() => rowsWhere<ProgressUpdate>('progress_updates', project.id, `AND ${jf('status')} = 'reported'`, [], `${jf('created_at')} ASC`), [project.id]);

  const decide = (u: ProgressUpdate, approve: boolean) => {
    const v = pct[u.id]?.trim();
    const p = v ? num(v) : Number(u.pct_complete);
    const cm = comment[u.id]?.trim();
    if (!(p >= 0 && p <= 100)) { showError(new Error('Percent must be between 0 and 100')); return; }
    if ((!approve || p !== Number(u.pct_complete)) && !cm) { showError(new Error('A comment is required when adjusting or rejecting'), 'Comment needed'); return; }
    enqueue('verify_progress', { progress_id: u.id, approve, verified_pct: approve ? p : undefined, comment: cm || undefined },
      { entityType: 'progress_update', entityId: u.id, label: `Progress ${approve ? 'verified' : 'rejected'}` });
    haptic(approve ? 'confirm' : 'reject');
    toast.success(`${elementLabel(u.element_id)} ${approve ? `verified at ${p}%` : 'rejected'}`);
  };

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: 'Verify progress' }} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {taskReports ? (
          <Banner tone="info" icon="chart-gantt" title={tr('sch.tasksToVerify', { n: taskReports })}
            actions={[{ label: tr('sch.verifyTitle'), onPress: () => router.push('/schedule/verify' as Href) }]} />
        ) : null}
        {rows.length ? rows.map((u) => (
          <Card key={u.id}>
            <Row justify="space-between" align="flex-start">
              <Text variant="titleSm" style={styles.flex}>{elementLabel(u.element_id)} — {get<ElementActivity>('element_activities', u.element_activity_id)?.name}</Text>
              <SyncDot status={u._pending ? 'pending' : null} />
            </Row>
            <Row wrap gap={6}>
              <Chip label={`Reported ${Number(u.pct_complete)}%`} tone="info" icon="progress-clock" />
              {u.qty_achieved ? <Chip label={`${fmtQty(u.qty_achieved)} ${u.uom ?? ''}`} tone="neutral" /> : null}
            </Row>
            <Text variant="bodySm" tone="muted">{fmtDate(u.report_date)} · {personName(u.reported_by)}</Text>
            {u.remarks ? <Text variant="body">{u.remarks}</Text> : null}
            <PhotoStrip projectId={u.project_id} entityType="progress_update" entityId={u.id} canAdd={false} />
            <QuantityStepper label="Verified percent" unit="%" step={5} quick={[]} max={100} value={pct[u.id] ?? String(Number(u.pct_complete))}
              onChange={(v) => setPct((s) => ({ ...s, [u.id]: v }))} fill={{ label: 'Reported', value: Number(u.pct_complete) }} />
            <Field label="Comment" optional value={comment[u.id] ?? ''} onChangeText={(v) => setComment((s) => ({ ...s, [u.id]: v }))}
              hint="Required when you adjust the percent or reject." />
            <Row>
              <Button title="Reject" variant="dangerOutline" flex onPress={() => decide(u, false)} />
              <Button title="Verify" icon="shield-check-outline" flex onPress={() => decide(u, true)} />
            </Row>
            <Button title="Open element" size="sm" variant="ghost" icon="open-in-new" onPress={() => router.push(`/progress/${u.element_id}`)} />
          </Card>
        )) : <EmptyState icon="check-all" tone="success" title="All caught up" body="Nothing is waiting for verification." />}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { padding: space[4], gap: space[3], paddingBottom: space[8] },
});
