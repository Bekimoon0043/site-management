// Shelf-life lots: server FIFO allocation with cached read and per-GRN pack expiry correction.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useSession, useSyncState } from '../../lib/app';
import { cachedLots, refreshLots, storeRpc } from '../../lib/store';
import type { ExpiryStatus, StockLot } from '../../lib/contract-store';
import { ago, fmtDate, fmtQty } from '../../lib/format';
import {
  Banner, Button, ChipGroup, EmptyState, InfoRow, ListRow, Screen, Sheet, Text, haptic, showError, toast,
} from '../../components/ui';
import { DateField } from '../../components/pickers';

type Filter = 'all' | ExpiryStatus;
const LABEL: Record<ExpiryStatus, string> = { expired: 'Expired', expiring: 'Use first', ok: 'OK', no_expiry: 'No expiry' };
const TONE: Record<ExpiryStatus, 'danger' | 'warning' | 'success' | 'neutral'> = { expired: 'danger', expiring: 'warning', ok: 'success', no_expiry: 'neutral' };
const EDIT_ROLES = ['store_keeper', 'coordinator', 'manager', 'admin'];

export default function StockAgeing() {
  const { project } = useSession();
  return <StockAgeingProject key={project.id} projectId={project.id} />;
}

function StockAgeingProject({ projectId }: { projectId: string }) {
  const { profile, project } = useSession();
  const sync = useSyncState();
  const [cache, setCache] = useState(() => cachedLots(projectId));
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<StockLot | null>(null);
  const [expiry, setExpiry] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const canEdit = EDIT_ROLES.includes(profile.role);

  const reload = useCallback(async () => {
    setBusy(true);
    try { setCache(await refreshLots(projectId)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [projectId]);
  useEffect(() => {
    let on = true;
    void refreshLots(projectId).then((fresh) => { if (on) { setCache(fresh); setError(null); } })
      .catch((e) => { if (on) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (on) setBusy(false); });
    return () => { on = false; };
  }, [projectId]);

  const rows = useMemo(() => (cache?.rows ?? []).filter((r) => filter === 'all' || r.expiry_status === filter)
    .sort((a, b) => (a.days_to_expiry ?? 1e9) - (b.days_to_expiry ?? 1e9) || b.age_days - a.age_days), [cache, filter]);
  const count = (s: ExpiryStatus) => cache?.rows.filter((r) => r.expiry_status === s).length ?? 0;
  const save = async (value: string | null) => {
    if (!selected?.grn_line_id || busy) return;
    setBusy(true);
    try {
      await storeRpc('set_lot_expiry', { grn_line_id: selected.grn_line_id, expiry_date: value });
      haptic('confirm'); toast.success(value ? 'Pack expiry saved' : 'Using the material shelf life');
      setCache(await refreshLots(project.id)); setSelected(null); setError(null);
    } catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: 'Shelf life & FIFO lots' }} />
      <View style={styles.head}>
        {!sync.online ? <Banner tone="info" icon="cloud-off-outline" text="Offline: showing the last downloaded lots. Connect to change pack expiry." /> : null}
        {count('expired') ? <Banner tone="danger" title="Expired stock"
          text="Do not use expired cement or chemicals in structural work untested. Re-test or write off through an approved adjustment." /> : null}
        {error ? <Banner tone="danger" text={error} actions={[{ label: 'Retry', onPress: () => void reload() }]} /> : null}
        <ChipGroup<Filter> scroll value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All lots', count: cache?.rows.length ?? 0 },
          { value: 'expired', label: 'Expired', count: count('expired'), tone: 'danger' },
          { value: 'expiring', label: 'Use first', count: count('expiring'), tone: 'warning' },
          { value: 'ok', label: 'OK', count: count('ok'), tone: 'success' },
          { value: 'no_expiry', label: 'No expiry', count: count('no_expiry') },
        ]} />
        <Text variant="caption" tone="muted">Oldest receipts are allocated to issues first (FIFO).{cache ? ` Updated ${ago(cache.at)}.` : ''}</Text>
      </View>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.ledger_id}
        renderItem={({ item: r }) => <ListRow id={r.ledger_id} title={r.label}
          subtitle={`${r.store_name} · ${r.doc_number} · received ${fmtDate(r.received_on)}`}
          meta={r.expiry_date ? `Expires ${fmtDate(r.expiry_date)}${r.days_to_expiry != null ? ` · ${r.days_to_expiry < 0 ? `${-r.days_to_expiry} days ago` : `${r.days_to_expiry} days left`}` : ''}` : `${r.age_days} days old`}
          qty={fmtQty(r.remaining_qty)} unit={r.uom} qtyTone={r.expiry_status === 'expired' ? 'danger' : r.expiry_status === 'expiring' ? 'warning' : 'default'}
          chip={{ label: LABEL[r.expiry_status], tone: TONE[r.expiry_status], icon: r.expiry_status === 'expired' ? 'alert-outline' : undefined }}
          stripe={r.expiry_status === 'expired' ? 'danger' : r.expiry_status === 'expiring' ? 'warning' : null}
          chevron={!!(canEdit && r.grn_line_id)} onPress={canEdit && r.grn_line_id ? (id) => {
            const lot = rows.find((x) => x.ledger_id === id) ?? null;
            setSelected(lot); setExpiry(lot?.expiry_date ?? null);
          } : undefined} />}
        ListEmptyComponent={<EmptyState icon="calendar-alert" title={cache ? 'No lots in this filter' : 'No downloaded stock lots'}
          body={cache ? 'Lots appear after materials are received.' : 'Connect once to download stock ageing.'} compact />}
        contentContainerStyle={styles.list}
      />
      {selected ? (
        <Sheet visible onClose={() => setSelected(null)} title={`Pack expiry · ${selected.label}`}
          subtitle={`${selected.doc_number} · received ${fmtDate(selected.received_on)}`}
          footer={<Button title="Save expiry" busy={busy} disabled={!expiry} onPress={() => void save(expiry)} />}>
          <View style={styles.sheet}>
            <InfoRow label="Lot remaining" value={`${fmtQty(selected.remaining_qty)} ${selected.uom}`} />
            <InfoRow label="Age" value={`${selected.age_days} days`} />
            {selected.batch_no ? <InfoRow label="Batch" value={selected.batch_no} /> : null}
            <DateField label="Expiry printed on the pack" value={expiry} onChange={setExpiry}
              hint={selected.shelf_life_days ? `Without a pack date: received + ${selected.shelf_life_days} days` : 'No default shelf life is set for this material'} />
            <Button title="Use material shelf life" variant="outline" busy={busy} onPress={() => void save(null)} />
          </View>
        </Sheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { padding: 16, gap: 12 },
  list: { paddingBottom: 32 },
  sheet: { padding: 16, gap: 16 },
});
