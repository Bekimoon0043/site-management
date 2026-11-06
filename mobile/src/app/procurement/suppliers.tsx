// Supplier scorecard with receipt detail and one service rating per order/person.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useSession, useSyncState } from '../../lib/app';
import { cachedSupplierPerformance, loadSupplierDeliveries, refreshSupplierPerformance, storeRpc } from '../../lib/store';
import type { SupplierDelivery, SupplierPerformance } from '../../lib/contract-store';
import { canSeePrices, purchaseOrders } from '../../lib/pc';
import { ago, fmtDate, fmtQty } from '../../lib/format';
import {
  Banner, Button, Card, Chip, ChipGroup, EmptyState, Field, InfoRow, ListRow, Picker, Row, Screen, Sheet, Text,
  haptic, showError, toast,
} from '../../components/ui';

const RATE_ROLES = ['store_keeper', 'procurement', 'coordinator', 'manager', 'admin'];
const GRADE_TONE = { A: 'success', B: 'info', C: 'warning', D: 'danger' } as const;
const pct = (v: number | null) => v == null ? '—' : `${fmtQty(v, 1)}%`;

export default function Suppliers() {
  const { project } = useSession();
  return <SuppliersProject key={project.id} projectId={project.id} />;
}

function SuppliersProject({ projectId }: { projectId: string }) {
  const { profile, project } = useSession();
  const sync = useSyncState();
  const [cache, setCache] = useState(() => cachedSupplierPerformance(projectId));
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SupplierPerformance | null>(null);
  const [deliveries, setDeliveries] = useState<SupplierDelivery[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [poId, setPoId] = useState<string | null>(null);
  const [rating, setRating] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(true);
  const canRate = RATE_ROLES.includes(profile.role);

  const reload = useCallback(async () => {
    setBusy(true);
    try { setCache(await refreshSupplierPerformance(projectId)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [projectId]);
  useEffect(() => {
    let on = true;
    void refreshSupplierPerformance(projectId).then((fresh) => { if (on) { setCache(fresh); setError(null); } })
      .catch((e) => { if (on) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (on) setBusy(false); });
    return () => { on = false; };
  }, [projectId]);
  const supplierId = selected?.supplier_id;
  useEffect(() => {
    if (!supplierId) return;
    let on = true;
    void loadSupplierDeliveries(supplierId).then((rows) => { if (on) setDeliveries(rows); })
      .catch((e) => { if (on) setDetailError(e instanceof Error ? e.message : String(e)); });
    return () => { on = false; };
  }, [supplierId]);

  const rows = useMemo(() => [...(cache?.rows ?? [])].sort((a, b) => (Number(b.score) || -1) - (Number(a.score) || -1)
    || a.name.localeCompare(b.name)), [cache]);
  const pos = useMemo(() => supplierId ? purchaseOrders(project.id).filter((p) => p.supplier_id === supplierId
    && ['sent', 'partially_received', 'received', 'closed'].includes(p.status)) : [], [project.id, supplierId]);
  const openSupplier = (id: string) => {
    setDeliveries(null); setDetailError(null); setPoId(null); setRating(null); setComment('');
    setSelected(rows.find((r) => r.supplier_id === id) ?? null);
  };
  const saveRating = async () => {
    const score = Number(rating);
    if (!selected || !poId || !(score >= 1 && score <= 5)) { showError(new Error('Choose an order and a score from 1 to 5')); return; }
    if (score <= 2 && !comment.trim()) { showError(new Error('Say what went wrong')); return; }
    setBusy(true);
    try {
      await storeRpc('rate_supplier', { po_id: poId, score, comment: comment.trim() || undefined });
      haptic('confirm'); toast.success('Supplier rating saved');
      const fresh = await refreshSupplierPerformance(project.id);
      setCache(fresh); setSelected(fresh.rows.find((r) => r.supplier_id === selected.supplier_id) ?? null);
      setPoId(null); setRating(null); setComment(''); setError(null);
    } catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: 'Supplier performance' }} />
      <View style={styles.head}>
        <Banner tone="info" title="Quality 50% · on time 35% · price 15%"
          text={`Service ratings are shown separately.${canSeePrices(profile.role) ? '' : ' Without price access, quality and delivery are re-weighted.'}`} />
        {!sync.online ? <Banner tone="info" icon="cloud-off-outline" text="Offline: showing the last downloaded scorecards. Connect to load receipts or save ratings." /> : null}
        {error ? <Banner tone="danger" text={error} actions={[{ label: 'Retry', onPress: () => void reload() }]} /> : null}
        {cache ? <Text variant="caption" tone="muted">Scorecards updated {ago(cache.at)}</Text> : null}
      </View>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.supplier_id}
        renderItem={({ item: r }) => <ListRow id={r.supplier_id} title={r.name}
          subtitle={`${r.orders} orders · ${r.deliveries} receipts${r.overdue_orders ? ` · ${r.overdue_orders} overdue now` : ''}`}
          meta={`Quality ${pct(r.quality_pct)} · on time ${pct(r.on_time_pct)} · service ${r.service_rating == null ? 'not rated' : `${fmtQty(r.service_rating, 1)} / 5`}`}
          chip={r.grade ? { label: `${r.grade} · ${fmtQty(r.score, 0)}`, tone: GRADE_TONE[r.grade] } : { label: 'No score', tone: 'neutral' }}
          stripe={r.grade === 'D' ? 'danger' : r.overdue_orders ? 'warning' : null} chevron
          onPress={openSupplier} />}
        ListEmptyComponent={<EmptyState icon="store-search-outline" title={cache ? 'No supplier history yet' : 'No downloaded scorecards'}
          body={cache ? 'Scores appear after receipts are posted against purchase orders.' : 'Connect once to download supplier performance.'} compact />}
        contentContainerStyle={styles.list}
      />
      {selected ? (
        <Sheet visible full onClose={() => setSelected(null)} title={selected.name}
          subtitle={selected.grade ? `Grade ${selected.grade} · ${fmtQty(selected.score, 1)} / 100` : 'Not enough receipt history'}>
          <ScrollView contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
            <Card>
              <InfoRow label="Quality accepted" value={pct(selected.quality_pct)} />
              <InfoRow label="On-time receipts" value={`${pct(selected.on_time_pct)} of ${selected.dated ?? 0} dated`} />
              <InfoRow label="Average days late" value={selected.avg_days_late == null ? '—' : fmtQty(selected.avg_days_late, 1)} />
              <InfoRow label="Rejected receipt lines" value={selected.rejected_lines ?? 0} />
              <InfoRow label="Service rating" value={selected.service_rating == null ? 'Not rated' : `${fmtQty(selected.service_rating, 1)} / 5 from ${selected.ratings}`} />
              {canSeePrices(profile.role) ? <InfoRow label="Price vs 90-day average"
                value={selected.price_index == null ? 'No price history' : `${selected.price_index >= 1 ? '+' : ''}${fmtQty((selected.price_index - 1) * 100, 1)}%`} /> : null}
              <InfoRow label="Last delivery" value={fmtDate(selected.last_delivery)} />
            </Card>
            <Text variant="label" tone="muted">Recent receipts</Text>
            {detailError ? <Banner tone="danger" text={detailError} /> : !deliveries ? <Text variant="body" tone="muted">Loading receipts…</Text>
              : !deliveries.length ? <EmptyState icon="truck-delivery-outline" title="No receipts yet" compact />
                : deliveries.slice(0, 20).map((d) => <Card key={d.grn_id} dense stripe={Number(d.qty_rejected) > 0 ? 'warning' : null}>
                  <Row justify="space-between"><Text variant="titleSm">{d.grn_number} · {d.po_number}</Text>
                    <Chip small label={d.days_late == null ? 'No date' : d.days_late > 0 ? `${d.days_late} d late` : 'On time'}
                      tone={d.days_late != null && d.days_late > 0 ? 'danger' : 'success'} /></Row>
                  <Text variant="bodySm" tone="muted">Promised {fmtDate(d.promised_on)} · received {fmtDate(d.received_on)}</Text>
                  <Text variant="bodySm">Accepted {fmtQty(d.qty_accepted)} / delivered {fmtQty(d.qty_delivered)}{Number(d.qty_rejected) > 0 ? ` · rejected ${fmtQty(d.qty_rejected)}` : ''}</Text>
                </Card>)}
            {canRate && pos.length ? <Card>
              <Text variant="titleSm">Rate an order</Text>
              <Text variant="bodySm" tone="muted">Rate paperwork, responsiveness, packaging and gate conduct. Rating the same order again replaces your rating.</Text>
              <Picker label="Order" value={poId} onChange={setPoId} options={pos.map((p) => ({ id: p.id, label: p.number }))} />
              <ChipGroup label="Score (1–5)" value={rating} onChange={setRating}
                options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v, tone: Number(v) <= 2 ? 'danger' : Number(v) === 3 ? 'warning' : 'success' }))} />
              <Field label="Comment" value={comment} onChangeText={setComment} multiline optional={!rating || Number(rating) > 2}
                hint={rating && Number(rating) <= 2 ? 'Required for a low score' : undefined} />
              <Button title="Save rating" busy={busy} onPress={() => void saveRating()} />
            </Card> : null}
          </ScrollView>
        </Sheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { padding: 16, gap: 12 },
  list: { paddingBottom: 32 },
  sheet: { padding: 16, gap: 16, paddingBottom: 32 },
});
