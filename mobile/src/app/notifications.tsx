// Notifications stream: type icon, one line, relative time, unread dot; tap marks read + deep-links.
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, type Href } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useApp, useData } from '../lib/app';
import { list } from '../lib/db';
import type { AppNotification } from '../lib/contract';
import { enqueue } from '../lib/sync';
import { ago } from '../lib/format';
import { space } from '../theme';
import { Button, ChipGroup, EmptyState, ListRow, Screen, type IconName } from '../components/ui';

const ROUTE: Record<string, (id: string) => Href> = {
  material_request: (id) => `/requests/${id}`,
  grn: (id) => `/store/doc?type=grn&id=${id}`,
  miv: (id) => `/store/doc?type=miv&id=${id}`,
  adjustment: () => '/approvals?tab=adjustments',
  stock_count: () => '/approvals?tab=counts',
  transfer: () => '/store/transfer',
  progress_update: () => '/progress/verify',
};
const ICON: Record<string, IconName> = {
  material_request: 'clipboard-list-outline', grn: 'truck-delivery-outline', miv: 'package-variant-closed-remove',
  adjustment: 'delete-variant', stock_count: 'counter', transfer: 'swap-horizontal', progress_update: 'progress-check',
};

export default function Notifications() {
  const { userId } = useApp();
  const [filter, setFilter] = useState<'unread' | 'all'>('all');
  const rows = useData(() => list<AppNotification>('notifications', { parent: userId })
    .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 300), [userId]);
  const unread = rows.filter((n) => !n.read_at);
  const shown = useMemo(() => (filter === 'unread' ? unread : rows), [filter, rows, unread]);
  const byId = useMemo(() => new Map(rows.map((n) => [n.id, n])), [rows]);

  const open = useCallback((id: string) => {
    const n = byId.get(id);
    if (!n) return;
    if (!n.read_at) enqueue('mark_notifications_read', { ids: [n.id] }, { entityType: 'notification', entityId: n.id, label: 'Notification read' });
    const r = n.entity_type && n.entity_id ? ROUTE[n.entity_type]?.(n.entity_id) : null;
    if (r) router.push(r);
  }, [byId]);

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: 'Notifications' }} />
      <View style={styles.head}>
        <ChipGroup value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread', count: unread.length }]} />
        {unread.length ? <Button title="Mark all read" size="sm" variant="ghost" icon="check-all"
          onPress={() => enqueue('mark_notifications_read', {}, { entityType: 'notification', entityId: 'all', label: 'All notifications read' })} /> : null}
      </View>
      <FlashList
        data={shown}
        keyExtractor={(n) => n.id}
        renderItem={({ item: n }) => (
          <ListRow id={n.id} title={n.title} subtitle={n.body} meta={ago(n.created_at)} unread={!n.read_at}
            icon={n.is_critical ? 'alert-octagon-outline' : ICON[n.entity_type ?? ''] ?? 'bell-outline'} iconTone={n.is_critical ? 'danger' : 'primary'}
            chip={n.is_critical ? { label: 'Critical', tone: 'danger' } : null} onPress={open} />
        )}
        ListEmptyComponent={<EmptyState icon="bell-outline" title={filter === 'unread' ? 'All read' : 'No notifications'} compact />}
        contentContainerStyle={styles.list}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space[4], paddingTop: space[2] },
  list: { paddingBottom: space[8] },
});
