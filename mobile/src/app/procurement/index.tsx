// Procurement status (read-only on mobile): purchase orders with received % and delay flag,
// RFQs with status. Creating / awarding happens on the web console.
import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, type Href } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useSession } from '../../lib/app';
import { list } from '../../lib/db';
import type { PoStatus, RfqLine } from '../../lib/contract-procurement';
import { syncStatusMap } from '../../lib/counts';
import { poDelayed, poExpected, poLines, purchaseOrders, receivedPct, rfqs, supplierName } from '../../lib/pc';
import { fmtDate } from '../../lib/format';
import { t, useLocale } from '../../lib/i18n';
import { space } from '../../theme';
import { Button, ChipGroup, EmptyState, ListRow, Row, Screen, Segmented } from '../../components/ui';

type Filter = 'open' | 'approval' | 'delayed' | 'all';
const OPEN: PoStatus[] = ['draft', 'submitted', 'approved', 'sent', 'partially_received'];

export default function Procurement() {
  const { project } = useSession();
  useLocale();
  const [tab, setTab] = useState<'po' | 'rfq'>('po');
  const [filter, setFilter] = useState<Filter>('open');
  const pos = useData(() => {
    const sync = syncStatusMap();
    return purchaseOrders(project.id, filter === 'all' ? undefined : filter === 'approval' ? ['submitted'] : OPEN)
      .filter((p) => filter !== 'delayed' || poDelayed(p))
      .map((p) => {
        const delayed = poDelayed(p);
        return {
          id: p.id, title: p.number, status: delayed ? 'delayed' : p.status,
          sub: `${supplierName(p.supplier_id)} · ${poLines(p.id).length} line(s)`,
          meta: `Expected ${fmtDate(poExpected(p))} · ${receivedPct(p.id)}% received`,
          stripe: delayed ? ('danger' as const) : null, sync: sync.get(p.id) ?? null,
        };
      });
  }, [project.id, filter]);
  const rq = useData(() => rfqs(project.id).map((r) => ({
    id: r.id, title: r.number, status: r.status, sub: r.title,
    meta: `${list<RfqLine>('rfq_lines', { parent: r.id }).filter((l) => !l.deleted_at).length} line(s)${r.required_by ? ` · needed ${fmtDate(r.required_by)}` : ''}`,
  })), [project.id]);
  const openPo = useCallback((id: string) => router.push(`/procurement/po/${id}`), []);

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: t('act.purchaseOrders') }} />
      <View style={styles.head}>
        <Segmented value={tab} onChange={setTab} accessibilityLabel="Document type" options={[{ value: 'po', label: 'Purchase orders' }, { value: 'rfq', label: 'RFQs' }]} />
        {tab === 'po' ? (
          <ChipGroup<Filter> scroll value={filter} onChange={setFilter} options={[
            { value: 'open', label: t('common.open') }, { value: 'approval', label: 'Awaiting approval' },
            { value: 'delayed', label: t('status.delayed'), tone: 'danger' }, { value: 'all', label: t('common.all') },
          ]} />
        ) : null}
        <Row>
          <Button title={t('act.logPrice')} icon="tag-outline" variant="tonal" size="md" flex onPress={() => router.push('/procurement/price')} />
          <Button title={t('act.reorder')} icon="cart-arrow-down" variant="outline" size="md" flex onPress={() => router.push('/procurement/reorder')} />
        </Row>
        <Button title="Supplier performance" icon="store-search-outline" variant="outline" size="md" block
          onPress={() => router.push('/procurement/suppliers' as Href)} />
      </View>
      {tab === 'po' ? (
        <FlashList data={pos} keyExtractor={(r) => r.id}
          renderItem={({ item: r }) => <ListRow id={r.id} title={r.title} subtitle={r.sub} meta={r.meta} status={r.status} stripe={r.stripe} sync={r.sync} icon="cart-outline" chevron onPress={openPo} />}
          ListEmptyComponent={<EmptyState icon="cart-outline" title="No purchase orders" body="Purchase orders are created on the web console." compact />}
          contentContainerStyle={styles.list} />
      ) : (
        <FlashList data={rq} keyExtractor={(r) => r.id}
          renderItem={({ item: r }) => <ListRow id={r.id} title={r.title} subtitle={r.sub} meta={r.meta} status={r.status} icon="store-search-outline" />}
          ListEmptyComponent={<EmptyState icon="store-search-outline" title="No RFQs" compact />}
          contentContainerStyle={styles.list} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { padding: space[4], gap: space[3], paddingBottom: space[1] },
  list: { paddingBottom: space[8] },
});
