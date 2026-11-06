// Digital bin card with running balance (FR-ST-01; spec §5.5).
import React, { memo, useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useSession } from '../../lib/app';
import { get, list } from '../../lib/db';
import type { MaterialSpec, StockLedgerEntry, Store } from '../../lib/contract';
import { elementLabel, specLabel, specUom } from '../../lib/queries';
import { fmtDateTime, fmtQty } from '../../lib/format';
import { sentence, space, useTheme } from '../../theme';
import { Card, Chip, EmptyState, Icon, InfoRow, Row, Screen, Text } from '../../components/ui';

const DOC_ROUTE: Record<string, string> = { grn: 'grn', miv: 'miv', mrn: 'mrn', adjustment: 'adjustment', transfer: 'transfer' };

interface Mv { id: string; doc: string; docType: string; docId: string; qty: number; txn: string; quarantine: boolean; pending: boolean; at: string; el: string | null; balance: number }

const MoveRow = memo(function MoveRow({ m, uom, onOpen }: { m: Mv; uom: string; onOpen: (m: Mv) => void }) {
  const t = useTheme();
  const plus = m.qty > 0;
  return (
    <Pressable disabled={!DOC_ROUTE[m.docType]} onPress={() => onOpen(m)} android_ripple={{ color: t.ripple }} accessibilityRole="button"
      style={[styles.row, { backgroundColor: t.surface, borderBottomColor: t.border }]}>
      <Icon name={plus ? 'arrow-down-bold' : 'arrow-up-bold'} size={22} tone={plus ? 'success' : 'danger'}
        accessibilityLabel={plus ? 'In' : 'Out'} />
      <View style={styles.flex}>
        <Text variant="titleSm" numberOfLines={1}>{m.doc}</Text>
        <Text variant="caption" tone="muted" numberOfLines={1}>{sentence(m.txn)} · {fmtDateTime(m.at)}{m.el ? ` · ${m.el}` : ''}</Text>
        <Row gap={6}>
          {m.quarantine ? <Chip label="Quarantine" tone="warning" small /> : null}
          {m.pending ? <Chip label="Saved on phone" tone="warning" icon="cloud-upload-outline" small /> : null}
        </Row>
      </View>
      <View style={styles.qty}>
        <Text variant="titleSm" num tone={plus ? 'success' : 'danger'}>{plus ? '+' : '−'}{fmtQty(Math.abs(m.qty))}</Text>
        <Text variant="caption" tone="muted" num>bal {fmtQty(m.balance)} {uom}</Text>
      </View>
    </Pressable>
  );
});

export default function BinCard() {
  const { project } = useSession();
  const { spec, store } = useLocalSearchParams<{ spec: string; store?: string }>();
  const uom = specUom(spec);
  const s = useData(() => get<MaterialSpec>('material_specs', spec), [spec]);

  const d = useData(() => {
    const entries = list<StockLedgerEntry>('stock_ledger', { parent: spec })
      .filter((l) => l.project_id === project.id && (!store || l.store_id === store))
      .sort((a, b) => a.txn_at.localeCompare(b.txn_at) || a.created_at.localeCompare(b.created_at));
    const bal: Record<string, number> = { available: 0, quarantine: 0 };
    const rows: Mv[] = entries.map((e) => {
      bal[e.stock_status] += Number(e.qty);
      return {
        id: e.id, doc: e.doc_number, docType: e.doc_type, docId: e.doc_id, qty: Number(e.qty), txn: e.txn_type,
        quarantine: e.stock_status === 'quarantine', pending: e.id.startsWith('local:'), at: e.txn_at,
        el: e.element_id ? elementLabel(e.element_id) : null, balance: bal.available,
      };
    });
    return { rows: rows.reverse(), available: bal.available, quarantine: bal.quarantine };
  }, [spec, store, project.id]);

  const open = useCallback((m: Mv) => router.push(`/store/doc?type=${DOC_ROUTE[m.docType]}&id=${m.docId}`), []);
  const reorder = Number(s?.reorder_level ?? 0);
  const low = reorder > 0 && d.available <= reorder;

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: 'Bin card' }} />
      <FlashList
        data={d.rows}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={
          <View style={styles.head}>
            <Card stripe={low ? 'danger' : null}>
              <Text variant="titleSm">{specLabel(spec)}</Text>
              <Text variant="bodySm" tone="muted">{store ? get<Store>('stores', store)?.name : 'All stores'}</Text>
              <Row align="flex-end" gap={6}>
                <Text variant="display" num tone={low ? 'danger' : 'default'}>{fmtQty(d.available)}</Text>
                <Text variant="body" tone="muted" style={styles.unit}>{uom} available</Text>
              </Row>
              {d.quarantine ? <InfoRow label="Quarantine" value={`${fmtQty(d.quarantine)} ${uom}`} tone="warning" /> : null}
              {reorder ? <InfoRow label="Reorder level" value={`${fmtQty(reorder)} ${uom}`} tone={low ? 'danger' : 'default'} icon={low ? 'alert-outline' : undefined} /> : null}
            </Card>
            <Text variant="label" tone="muted">Movements · newest first</Text>
          </View>
        }
        renderItem={({ item }) => <MoveRow m={item} uom={uom} onOpen={open} />}
        ListEmptyComponent={<EmptyState icon="swap-vertical" title="No movements yet" compact />}
        contentContainerStyle={styles.list}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { padding: space[4], gap: space[3] },
  unit: { marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[4], paddingVertical: space[2], minHeight: 64, borderBottomWidth: StyleSheet.hairlineWidth * 2 },
  qty: { alignItems: 'flex-end' },
  list: { paddingBottom: space[8] },
});
