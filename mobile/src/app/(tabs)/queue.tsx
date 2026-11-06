// Store keeper's queue (Flow B, spec §5.3): store orders to issue = coordinator-approved site-use
// requests (sur_issue), earliest issue-by date first; a row tap goes straight into the issue form.
// Delivery notices from procurement (Flow A, delivery_ack) sit on top → accept → receive (GRN).
import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useDataVersion, useSession } from '../../lib/app';
import { flowInboxCounts, mrField, mrRows, mrStatusIn, syncStatusMap } from '../../lib/counts';
import { sqlRequestType } from '../../lib/flows';
import { ft } from '../../lib/flows-i18n';
import { personName, specMap } from '../../lib/queries';
import { fmtDate, today } from '../../lib/format';
import { useLocale } from '../../lib/i18n';
import { priorityInfo, space } from '../../theme';
import { Banner, Button, EmptyState, ListRow, Screen, Text } from '../../components/ui';
import { flowRowChip } from '../../components/FlowTimeline';

export default function IssueQueue() {
  useLocale();
  const { project, profile } = useSession();
  const v = useDataVersion();
  const d = useData(() => {
    const sm = specMap(v);
    const sync = syncStatusMap();
    const t0 = today();
    const fc = flowInboxCounts(project.id, profile.id, profile.role);
    const rows = mrRows(project.id, `${mrStatusIn(['approved', 'partially_issued', 'sourced', 'ordered'])} AND ${sqlRequestType('r')} = 'site_use'`, [],
      `COALESCE(${mrField('issue_by')}, ${mrField('required_date')}) ASC`).map((r) => {
      const p = priorityInfo(r.priority);
      const due = (r as { issue_by?: string | null }).issue_by ?? r.required_date;
      const overdue = due <= t0;
      return {
        id: r.id, number: r.number,
        sub: `${r.specIds.map((id) => sm.get(id)?.label ?? 'Material').slice(0, 2).join(', ')}${r.lineCount > 2 ? ` +${r.lineCount - 2}` : ''}`,
        meta: `${ft('flow.issueByDate', { d: fmtDate(due) })} · ${personName(r.requested_by)}${p ? ` · ${p.label}` : ''}`,
        chip: overdue ? { label: 'Due', tone: 'warning' as const, icon: 'clock-outline' as const } : flowRowChip(r.status, 'site_use'),
        stripe: overdue ? ('warning' as const) : p ? p.tone : null,
        sync: sync.get(r.id) ?? null,
      };
    });
    return { rows, notices: fc.delivery_ack };
  }, [project.id, profile.id, profile.role]);

  const open = useCallback((id: string) => router.push(`/store/issue?mr=${id}`), []);

  return (
    <Screen scroll={false} padded={false} insetBottom={false}>
      <FlashList
        data={d.rows}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={
          <View style={styles.headWrap}>
            <Banner tone={d.notices ? 'warning' : 'info'} icon="truck-delivery-outline"
              title={d.notices ? ft('flow.inbox.delivery_ack', { n: d.notices }) : ft('flow.deliveries')} text={ft('flow.deliveriesBody')}
              onPress={() => router.push('/store/deliveries' as Href)} />
            <View style={styles.head}>
              <Text variant="bodySm" tone="muted" style={styles.flex}>{d.rows.length ? `${ft('flow.storeOrders')} · ${d.rows.length}` : ft('flow.storeOrders')}</Text>
              <Button title="Emergency" size="sm" variant="dangerOutline" icon="fire" onPress={() => router.push('/store/issue?emergency=1')} />
            </View>
          </View>
        }
        renderItem={({ item: r }) => (
          <ListRow id={r.id} title={r.number} subtitle={r.sub} meta={r.meta} chip={r.chip} stripe={r.stripe}
            icon="package-variant-closed" sync={r.sync} chevron onPress={open} />
        )}
        ListEmptyComponent={<EmptyState icon="check-all" tone="success" title={ft('flow.noStoreOrders')} body={ft('flow.storeOrdersBody')}
          secondary={{ label: 'Emergency issue', onPress: () => router.push('/store/issue?emergency=1') }} />}
        contentContainerStyle={styles.list}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headWrap: { paddingHorizontal: space[4], paddingTop: space[3], gap: space[2] },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingVertical: space[1] },
  list: { paddingBottom: space[8] },
});
