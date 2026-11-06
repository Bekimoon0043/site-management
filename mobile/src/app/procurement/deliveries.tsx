// Store keeper: expected deliveries from open purchase orders (v_expected_deliveries, offline).
// Delayed first. Tap → receive against the PO (lines prefilled with the outstanding quantity).
import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useDataVersion, useSession } from '../../lib/app';
import { expectedDeliveries, storeName } from '../../lib/pc';
import { fmtDate, today } from '../../lib/format';
import { t, useLocale } from '../../lib/i18n';
import { space } from '../../theme';
import { ChipGroup, EmptyState, ListRow, Screen } from '../../components/ui';

export default function ExpectedDeliveries() {
  const { project } = useSession();
  useLocale();
  const v = useDataVersion();
  const [filter, setFilter] = useState<'all' | 'delayed' | 'today'>('all');
  const rows = useData(() => {
    const d = today();
    return expectedDeliveries(project.id, v)
      .filter((e) => filter === 'all' || (filter === 'delayed' ? e.delayed : (e.expected ?? '').slice(0, 10) <= d))
      .map((e) => ({
        id: e.id, title: `${e.number} · ${e.supplier}`, sub: e.summary,
        meta: `${e.expected ? `Expected ${fmtDate(e.expected)}` : 'No date'} · ${e.outstandingLines}/${e.lines} line(s) due · ${storeName(e.storeId)}`,
        chip: e.delayed ? { label: t('status.delayed'), tone: 'danger' as const, icon: 'clock-alert-outline' as const }
          : e.deliveryStatus === 'dispatched' ? { label: 'Dispatched', tone: 'info' as const, icon: 'truck-fast-outline' as const } : null,
        stripe: e.delayed ? ('danger' as const) : null,
      }));
  }, [project.id, filter]);
  const open = useCallback((id: string) => router.push(`/store/receive?po=${id}`), []);

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: t('home.expected') }} />
      <View style={styles.head}>
        <ChipGroup value={filter} onChange={setFilter} options={[
          { value: 'all', label: t('common.all') }, { value: 'today', label: 'Due today' }, { value: 'delayed', label: t('status.delayed'), tone: 'danger' },
        ]} />
      </View>
      <FlashList data={rows} keyExtractor={(r) => r.id}
        renderItem={({ item: r }) => <ListRow id={r.id} title={r.title} subtitle={r.sub} meta={r.meta} chip={r.chip} stripe={r.stripe} icon="truck-delivery-outline" chevron onPress={open} />}
        ListEmptyComponent={<EmptyState icon="truck-delivery-outline" tone="success" title="No deliveries expected" body="Approved purchase orders with outstanding quantities show up here." compact />}
        contentContainerStyle={styles.list} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { padding: space[4], paddingBottom: space[1] },
  list: { paddingBottom: space[8] },
});
