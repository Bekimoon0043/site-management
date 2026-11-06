// Alerts for management (D2): consumption variance, large adjustments, overdue gate passes,
// gate mismatches, unmatched vehicle exits… Acknowledge or close with a note (alert_action).
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, type Href } from 'expo-router';
import { useData, useSession } from '../lib/app';
import { canControl, type Alert } from '../lib/contract-control';
import { alerts } from '../lib/pc';
import { enqueue } from '../lib/sync';
import { ago, fmtDateTime } from '../lib/format';
import { t, useLocale } from '../lib/i18n';
import { sentence, space, type Tone } from '../theme';
import { Button, Card, Chip, ChipGroup, EmptyState, ReasonSheet, Row, Screen, SyncDot, Text, haptic, toast } from '../components/ui';
import { syncStatusMap } from '../lib/counts';

const SEV: Record<Alert['severity'], { tone: Tone; icon: 'alert-octagon-outline' | 'alert-outline' | 'information-outline' }> = {
  critical: { tone: 'danger', icon: 'alert-octagon-outline' }, warning: { tone: 'warning', icon: 'alert-outline' }, info: { tone: 'info', icon: 'information-outline' },
};
const entityHref = (a: Alert): Href | null =>
  a.entity_type === 'gate_pass' && a.entity_id ? `/gate/${a.entity_id}`
  : a.entity_type === 'material_request' && a.entity_id ? `/requests/${a.entity_id}`
  : a.entity_type === 'adjustment' && a.entity_id ? `/store/doc?type=adjustment&id=${a.entity_id}`
  : a.entity_type === 'miv' && a.entity_id ? `/store/doc?type=miv&id=${a.entity_id}`
  : null;

export default function Alerts() {
  const { profile, project } = useSession();
  useLocale();
  const [scope, setScope] = useState<'open' | 'all'>('open');
  const [closing, setClosing] = useState<Alert | null>(null);
  const rows = useData(() => ({ list: alerts(project.id, scope === 'open'), sync: syncStatusMap() }), [project.id, scope]);
  const manage = canControl(profile.role, 'alert.manage');

  const act = (a: Alert, action: 'acknowledge' | 'close', note?: string) => {
    enqueue('alert_action', { alert_id: a.id, action, note }, { entityType: 'alert', entityId: a.id, label: `Alert ${action === 'close' ? 'closed' : 'acknowledged'}` });
    haptic('confirm');
    toast.success(t('common.savedOnPhone', { x: action === 'close' ? t('status.closed') : t('status.acknowledged') }));
    setClosing(null);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: t('title.alerts') }} />
      <ChipGroup value={scope} onChange={setScope} options={[{ value: 'open', label: t('common.open') }, { value: 'all', label: t('common.all') }]} />
      {rows.list.length ? rows.list.map((a) => {
        const s = SEV[a.severity] ?? SEV.info;
        const href = entityHref(a);
        return (
          <Card key={a.id} stripe={a.status === 'closed' ? null : s.tone} onPress={href ? () => router.push(href) : undefined}>
            <Row justify="space-between" align="flex-start">
              <View style={styles.flex}>
                <Row gap={6}><Text variant="titleSm" style={styles.shrink}>{a.title}</Text><SyncDot status={rows.sync.get(a.id) ?? null} /></Row>
                <Text variant="bodySm" tone="muted">{sentence(a.rule)} · {ago(a.created_at)}</Text>
              </View>
              <Chip label={t(`status.${a.severity}` as 'status.critical')} tone={s.tone} icon={s.icon} />
            </Row>
            {a.details?.summary ? <Text variant="body">{a.details.summary}</Text> : null}
            <Row wrap gap={6}>
              <Chip label={a.status === 'open' ? t('status.open') : a.status === 'acknowledged' ? t('status.acknowledged') : t('status.closed')}
                tone={a.status === 'open' ? 'danger' : a.status === 'acknowledged' ? 'info' : 'neutral'} icon={a.status === 'closed' ? 'lock-outline' : 'bell-alert-outline'} />
              {a.acked_at ? <Text variant="caption" tone="muted">Acknowledged {fmtDateTime(a.acked_at)}</Text> : null}
            </Row>
            {a.close_note ? <Text variant="bodySm" tone="muted">{a.close_note}</Text> : null}
            {manage && a.status !== 'closed' ? (
              <Row>
                {a.status === 'open' ? <Button title={t('common.acknowledge')} variant="outline" flex icon="check" onPress={() => act(a, 'acknowledge')} /> : null}
                <Button title={t('common.close')} variant="tonal" flex icon="lock-outline" onPress={() => setClosing(a)} />
              </Row>
            ) : null}
          </Card>
        );
      }) : <EmptyState icon="check-all" tone="success" title={t('common.allCaught')} body="No open alerts for this project." />}
      {closing ? (
        <ReasonSheet visible onClose={() => setClosing(null)} title={`${t('common.close')}: ${closing.title}`} subtitle="A closing note is required."
          reasons={['Investigated: no issue', 'Corrected in the books', 'Returned to site', 'Disciplinary action taken']}
          confirmLabel={t('common.close')} onConfirm={(n) => act(closing, 'close', n)} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 }, shrink: { flexShrink: 1 } });
