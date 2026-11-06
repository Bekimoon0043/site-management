// Stock list (spec §5.5): sticky search + sort, filter chips with counts, dense FlashList rows
// (qty right-aligned, tabular), low stock = danger stripe + chip. Balances via SQL GROUP BY.
import React, { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useDataVersion, useSession, useSyncState } from '../../lib/app';
import { stockBalancesSql } from '../../lib/counts';
import { specMap, stores } from '../../lib/queries';
import { fmtQty } from '../../lib/format';
import { printStockStatus } from '../../lib/print';
import { space } from '../../theme';
import {
  Button, ChipGroup, EmptyState, FilterChip, IconButton, ListRow, Screen, SearchInput, SearchSheet, Sheet, normalize,
} from '../../components/ui';
import { syncNow } from '../../lib/sync';

type Filter = 'all' | 'low' | 'quarantine';
type Sort = 'low' | 'az' | 'recent';

export default function Stock() {
  const { project } = useSession();
  const params = useLocalSearchParams<{ low?: string }>();
  const [filter, setFilter] = useState<Filter>(params.low ? 'low' : 'all');
  const [sort, setSort] = useState<Sort>('low');
  const [storeId, setStoreId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState<'sort' | 'store' | null>(null);
  const dq = useDeferredValue(q);
  const v = useDataVersion();
  const sync = useSyncState();

  const storeOpts = useData(() => stores(project.id).map((s) => ({ id: s.id, label: s.name, sub: `${s.store_type} store` })), [project.id]);
  const storeName = useMemo(() => new Map(storeOpts.map((s) => [s.id, s.label])), [storeOpts]);

  const all = useData(() => {
    const sm = specMap(v);
    return stockBalancesSql(project.id).map((b) => {
      const s = sm.get(b.material_spec_id);
      const reorder = Number(s?.reorder_level ?? 0);
      const label = s?.label ?? 'Unknown material';
      return {
        id: `${b.store_id}|${b.material_spec_id}`, store_id: b.store_id, spec: b.material_spec_id, label,
        uom: s?.uom ?? '', category: s?.category ?? '', available: b.available, quarantine: b.quarantine, last: b.last,
        reorder, low: reorder > 0 && b.available <= reorder, key: normalize(`${label} ${s?.category ?? ''}`),
      };
    });
  }, [project.id]);

  const rows = useMemo(() => {
    const nq = normalize(dq);
    const out = all
      .filter((r) => (!storeId || r.store_id === storeId))
      .filter((r) => (filter === 'low' ? r.low : filter === 'quarantine' ? r.quarantine > 0 : true))
      .filter((r) => !nq || r.key.includes(nq));
    if (sort === 'az') out.sort((a, b) => a.label.localeCompare(b.label));
    else if (sort === 'recent') out.sort((a, b) => b.last.localeCompare(a.last));
    else out.sort((a, b) => Number(b.low) - Number(a.low) || a.label.localeCompare(b.label));
    return out;
  }, [all, storeId, filter, dq, sort]);

  const counts = useMemo(() => ({
    low: all.filter((r) => r.low && (!storeId || r.store_id === storeId)).length,
    quarantine: all.filter((r) => r.quarantine > 0 && (!storeId || r.store_id === storeId)).length,
  }), [all, storeId]);

  const open = useCallback((id: string) => {
    const [store, spec] = id.split('|');
    router.push(`/store/bincard?spec=${spec}&store=${store}`);
  }, []);
  const multiStore = storeOpts.length > 1;

  return (
    <Screen scroll={false} padded={false} insetBottom={false}>
      <View style={styles.head}>
        <View style={styles.searchRow}>
          <View style={styles.flex}><SearchInput value={q} onChangeText={setQ} onClear={() => setQ('')} placeholder="Search material" /></View>
          <IconButton icon="sort" filled accessibilityLabel="Sort" onPress={() => setSheet('sort')} />
        </View>
        <View style={styles.chips}>
          <ChipGroup<Filter> scroll value={filter} onChange={setFilter} options={[
            { value: 'all', label: 'All' },
            { value: 'low', label: 'Low', count: counts.low, tone: 'danger' },
            { value: 'quarantine', label: 'Quarantine', count: counts.quarantine, tone: 'warning' },
          ]} style={styles.flexShrink} />
        </View>
        <View style={styles.storeRow}>
          <Button title="Shelf life" icon="calendar-alert" variant="tonal" size="md" flex onPress={() => router.push('/store/ageing' as Href)} />
          <Button title="Tools" icon="tools" variant="outline" size="md" flex onPress={() => router.push('/store/tools' as Href)} />
        </View>
        {multiStore ? (
          <View style={styles.storeRow}>
            <FilterChip label={storeId ? storeName.get(storeId) ?? 'Store' : 'All stores'} selected={!!storeId} trailingIcon="chevron-down"
              onPress={() => setSheet('store')} />
          </View>
        ) : null}
      </View>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={({ item: r }) => (
          <ListRow id={r.id} title={r.label}
            subtitle={`${storeName.get(r.store_id) ?? 'Store'} · ${r.category}${r.quarantine ? ` · ${fmtQty(r.quarantine)} quarantine` : ''}`}
            qty={fmtQty(r.available)} unit={r.uom} qtyTone={r.low ? 'danger' : 'default'}
            chip={r.low ? { label: `Low · reorder ${fmtQty(r.reorder)}`, tone: 'danger', icon: 'alert-outline' } : null}
            stripe={r.low ? 'danger' : null} onPress={open} />
        )}
        ListEmptyComponent={all.length === 0 ? (
          <EmptyState icon={sync.online ? 'warehouse' : 'cloud-off-outline'}
            title={sync.online ? 'No stock recorded yet' : 'No stock data on this phone yet'}
            body={sync.online ? 'Stock appears after the first delivery or opening balance.' : 'Connect to the internet once to download stock.'}
            action={{ label: 'Sync now', icon: 'sync', onPress: () => void syncNow() }} />
        ) : (
          <EmptyState icon="magnify" title={q ? `No match for “${q}”` : 'Nothing in this filter'} compact
            action={{ label: 'Show all', onPress: () => { setQ(''); setFilter('all'); setStoreId(null); } }} />
        )}
        ListFooterComponent={rows.length ? (
          <View style={styles.footer}>
            <Button title="Share stock report (PDF)" icon="file-pdf-box" variant="outline" block onPress={() => void printStockStatus(project.id)} />
          </View>
        ) : null}
      />

      {sheet === 'sort' ? (
        <Sheet visible onClose={() => setSheet(null)} title="Sort stock">
          <View style={styles.sheet}>
            {([['low', 'Low stock first', 'alert-outline'], ['az', 'A–Z', 'sort'], ['recent', 'Recently moved', 'history']] as const).map(([k, l, ic]) => (
              <ListRow key={k} id={k} title={l} icon={sort === k ? 'check' : ic} iconTone={sort === k ? 'success' : 'neutral'}
                onPress={() => { setSort(k); setSheet(null); }} />
            ))}
          </View>
        </Sheet>
      ) : null}
      {sheet === 'store' ? (
        <SearchSheet visible onClose={() => setSheet(null)} title="Store" options={storeOpts} value={storeId}
          onSelect={setStoreId} onClear={() => setStoreId(null)} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  head: { paddingHorizontal: space[4], paddingTop: space[3], gap: space[1] },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  chips: { flexDirection: 'row', alignItems: 'center' },
  storeRow: { flexDirection: 'row' },
  footer: { padding: space[4], paddingBottom: space[8] },
  sheet: { paddingBottom: space[2] },
});
