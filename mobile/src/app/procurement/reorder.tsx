// Reorder suggestions (v_reorder_suggestions, cached for offline; local estimate when never
// fetched) → tick the lines → one replenishment request (create_mr_from_suggestions).
import React, { useEffect, useMemo, useState } from 'react';
import { Stack, router } from 'expo-router';
import { useData, useDataVersion, useSession } from '../../lib/app';
import type { MrPriority } from '../../lib/contract';
import { canProcure } from '../../lib/contract-procurement';
import { cachedReorder, refreshReorder } from '../../lib/pc';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { addDays, ago, fmtDate, fmtQty, today } from '../../lib/format';
import { bump } from '../../lib/db';
import { t, useLocale } from '../../lib/i18n';
import {
  ActionBar, Banner, Card, ChipGroup, EmptyState, ListRow, Screen, Section, Segmented, haptic, showError, toast,
} from '../../components/ui';
import { DateField } from '../../components/pickers';

export default function Reorder() {
  const { profile, project } = useSession();
  useLocale();
  const v = useDataVersion();
  const data = useData(() => cachedReorder(project.id, v), [project.id]);
  const [store, setStore] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [date, setDate] = useState<string | null>(addDays(today(), 7));
  const [priority, setPriority] = useState<MrPriority>('normal');
  const allowed = canProcure(profile.role, 'reorder.createMr');

  useEffect(() => { void refreshReorder(project.id).then((ok) => { if (ok) bump(); }); }, [project.id]);

  const storesIn = useMemo(() => [...new Map(data.rows.map((r) => [r.store_id, r.store_name])).entries()], [data.rows]);
  const storeId = store ?? storesIn[0]?.[0] ?? null;
  const rows = useMemo(() => data.rows.filter((r) => r.store_id === storeId)
    .sort((a, b) => Number(b.stockout_before_lead_time) - Number(a.stockout_before_lead_time) || a.label.localeCompare(b.label)), [data.rows, storeId]);
  const key = (specId: string) => `${storeId}|${specId}`;
  const toggle = (specId: string) => setPicked((s) => { const n = new Set(s); const k = key(specId); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const chosen = rows.filter((r) => picked.has(key(r.material_spec_id)));

  const create = () => {
    if (!storeId || !chosen.length) { toast.show({ text: 'Tick at least one material', tone: 'warning' }); return; }
    try {
      const id = uuid();
      const number = nextDocNumber(project.code, 'MR');
      enqueue('create_mr_from_suggestions', {
        id, project_id: project.id, number, store_id: storeId, required_date: date ?? undefined, priority, submit: true,
        device_created_at: new Date().toISOString(),
        lines: chosen.map((r) => ({ id: uuid(), material_spec_id: r.material_spec_id, qty: Number(r.suggested_qty), remarks: 'Reorder suggestion' })),
      }, { entityType: 'material_request', entityId: id, label: `${number} reorder submitted` });
      haptic('confirm');
      toast.success(t('common.savedOnPhone', { x: number }));
      router.replace(`/requests/${id}`);
    } catch (e) { showError(e); }
  };

  return (
    <Screen footer={allowed && rows.length ? <ActionBar summary={`${chosen.length} of ${rows.length} selected`}
      primary={{ title: 'Create request', icon: 'cart-plus', variant: 'hero', onPress: create }} /> : undefined}>
      <Stack.Screen options={{ title: t('kpi.reorder') }} />
      {data.source === 'local' ? <Banner tone="info" icon="cloud-off-outline" text="Estimated on this phone from stock and reorder levels. Connect for the full forecast." />
        : <Banner tone="neutral" icon="clock-outline" text={`Forecast updated ${ago(data.at)}`} />}
      {storesIn.length > 1 ? <ChipGroup scroll value={storeId ?? ''} onChange={(s) => { setStore(s); setPicked(new Set()); }} options={storesIn.map(([id, name]) => ({ value: id, label: name }))} /> : null}
      {rows.length ? (
        <Card flush>
          {rows.map((r) => (
            <ListRow key={r.material_spec_id} id={r.material_spec_id} title={r.label}
              subtitle={`Have ${fmtQty(r.available)} · reorder at ${fmtQty(r.reorder_level)}${Number(r.open_po_qty) > 0 ? ` · on order ${fmtQty(r.open_po_qty)}` : ''}`}
              meta={r.stockout_date ? `Runs out ~${fmtDate(r.stockout_date)}${r.days_cover != null ? ` (${fmtQty(r.days_cover, 1)} days)` : ''}` : null}
              qty={fmtQty(r.suggested_qty)} unit={r.uom} qtyTone={r.stockout_before_lead_time ? 'danger' : 'default'}
              icon={picked.has(key(r.material_spec_id)) ? 'checkbox-marked' : 'checkbox-blank-outline'}
              iconTone={picked.has(key(r.material_spec_id)) ? 'primary' : 'neutral'}
              stripe={r.stockout_before_lead_time ? 'danger' : null} onPress={allowed ? toggle : undefined} />
          ))}
        </Card>
      ) : <EmptyState icon="check-all" tone="success" title="Nothing to reorder" body="Stock is above reorder levels, counting open orders." />}
      {allowed && rows.length ? (
        <Section title="Request">
          <Card>
            <DateField label={t('mr.requiredDate')} value={date} onChange={setDate} quick />
            <Segmented<MrPriority> value={priority} onChange={setPriority} accessibilityLabel={t('mr.priority')} options={[
              { value: 'normal', label: 'Normal' }, { value: 'urgent', label: 'Urgent', tone: 'warning' }, { value: 'critical', label: 'Critical', tone: 'danger' },
            ]} />
          </Card>
        </Section>
      ) : null}
    </Screen>
  );
}
