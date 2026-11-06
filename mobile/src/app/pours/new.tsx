// Plan a concrete pour (features C3 step 1): elements (planned m³ pre-filled from the
// take-off), mix design, method, supplier / store, planned volume. ?id= edits a planned pour.
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get } from '../../lib/db';
import { type MixDesign, type Pour, type PourMethod } from '../../lib/contract-field';
import { openPourHoldPoints, pourElements, plannedConcrete } from '../../lib/field';
import { elementLabel, stores } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { fmtQty, num, today } from '../../lib/format';
import {
  ActionBar, Banner, Card, ChipGroup, EmptyState, Field, IconButton, QuantityStepper, Row, Screen, Section, Segmented, Text, haptic, showError,
  toast, useForm, useUnsavedGuard, type Errors,
} from '../../components/ui';
import { DateField, ElementPicker, StorePicker, SupplierPicker } from '../../components/pickers';
import { MixDesignPicker } from '../../components/field';

interface El { id: string; elementId: string; m3: string }
const CURING = ['Wet hessian', 'Ponding', 'Curing compound', 'Plastic sheet'];

export default function NewPour() {
  const { project } = useSession();
  const params = useLocalSearchParams<{ id?: string; element?: string }>();
  const form = useForm();
  const prev = useMemo(() => (params.id ? get<Pour>('pours', params.id) : null), [params.id]);
  const [id] = useState(() => prev?.id ?? uuid());
  const [date, setDate] = useState<string | null>(prev?.pour_date ?? today());
  const [mixId, setMixId] = useState<string | null>(prev?.mix_design_id ?? null);
  const [method, setMethod] = useState<PourMethod>(prev?.method ?? 'ready_mix');
  const [supplierId, setSupplierId] = useState<string | null>(prev?.supplier_id ?? null);
  const [storeId, setStoreId] = useState<string | null>(prev?.store_id ?? stores(project.id)[0]?.id ?? null);
  const [els, setEls] = useState<El[]>(() => prev
    ? pourElements(prev.id).filter((e) => !e.deleted_at).map((e) => ({ id: e.id, elementId: e.element_id, m3: e.planned_m3 != null ? String(e.planned_m3) : '' }))
    : params.element ? [{ id: uuid(), elementId: params.element, m3: '' }] : []);
  const [total, setTotal] = useState(prev ? String(prev.planned_m3) : '');
  const [curing, setCuring] = useState<string | null>(prev?.curing_method ?? null);
  const [remarks, setRemarks] = useState(prev?.remarks ?? '');
  const [pick, setPick] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const disable = useUnsavedGuard(els.length > 0 || !!mixId, { what: 'pour plan' });

  const md = useData(() => (mixId ? get<MixDesign>('mix_designs', mixId) : null), [mixId]);
  const holds = useData(() => openPourHoldPoints(els.map((e) => e.elementId)), [els.map((e) => e.elementId).join()]);
  const sum = els.reduce((s, e) => s + (num(e.m3) || 0), 0);

  if (prev && prev.status !== 'planned' && prev.status !== 'in_progress') {
    return <Screen><Stack.Screen options={{ title: prev.number }} /><EmptyState icon="lock-outline" title={`Pour is ${prev.status}`} /></Screen>;
  }

  const chooseMix = (v: string | null) => {
    setMixId(v);
    const m = v ? get<MixDesign>('mix_designs', v) : null;
    if (m && !prev) setMethod(m.source === 'site' ? 'site_batched' : 'ready_mix');
    // fill element volumes from the take-off of this concrete grade
    if (m?.material_spec_id) setEls((xs) => xs.map((e) => (e.m3 ? e : { ...e, m3: String(plannedConcrete(e.elementId, m.material_spec_id) ?? '') })));
  };
  const addElement = (v: string | null) => {
    setPick(null);
    if (!v || els.some((e) => e.elementId === v)) return;
    const q = plannedConcrete(v, md?.material_spec_id ?? null);
    setEls((xs) => [...xs, { id: uuid(), elementId: v, m3: q != null ? String(q) : '' }]);
  };

  const save = () => {
    const e: Errors = {};
    if (!els.length) e.elements = 'Add at least one element';
    if (!mixId) e.mix = 'Choose the mix design';
    if (method === 'ready_mix' && md && !md.material_spec_id) e.mix = 'This mix has no concrete grade for ready-mix receipt';
    const planned = total.trim() ? num(total) : sum;
    if (!(planned > 0)) e.total = 'Enter the planned volume';
    if (method === 'site_batched' && !storeId) e.store = 'Choose the store cement is issued from';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      const number = prev?.number ?? nextDocNumber(project.code, 'POUR');
      const supplier = supplierId ? get<{ name: string }>('suppliers', supplierId)?.name : undefined;
      enqueue('save_pour', {
        id, project_id: project.id, number, pour_date: date ?? today(), mix_design_id: mixId!, method,
        supplier_id: method === 'ready_mix' ? supplierId ?? undefined : undefined, supplier_name: method === 'ready_mix' ? supplier : undefined,
        store_id: storeId ?? undefined, planned_m3: Math.round(planned * 1000) / 1000, curing_method: curing ?? undefined, remarks: remarks.trim() || undefined,
        elements: els.map((x) => ({ id: x.id, element_id: x.elementId, planned_m3: x.m3.trim() ? num(x.m3) : undefined })),
      }, { entityType: 'pour', entityId: id, label: `${number} planned` });
      haptic('confirm'); toast.success(`${number} ${prev ? 'updated' : 'planned'} · saved on phone`);
      disable(); router.replace(`/pours/${id}`);
    } catch (err) { showError(err); }
  };

  return (
    <Screen form={form} footer={<ActionBar summary={`${els.length} element${els.length === 1 ? '' : 's'} · ${fmtQty(total.trim() ? num(total) : sum)} m3`}
      primary={{ title: prev ? 'Save pour' : 'Plan pour', variant: 'hero', icon: 'calendar-check-outline', onPress: save }} />}>
      <Stack.Screen options={{ title: prev ? `Edit ${prev.number}` : 'Plan concrete pour' }} />
      <Section title="Elements">
        {els.map((x, i) => (
          <Card key={x.id} dense>
            <Row>
              <Text variant="label" style={styles.flex}>{elementLabel(x.elementId)}</Text>
              <IconButton icon="close" accessibilityLabel="Remove element" onPress={() => setEls((xs) => xs.filter((_, j) => j !== i))} />
            </Row>
            <QuantityStepper label="Planned" unit="m3" step={0.5} quick={[]} value={x.m3} onChange={(v) => setEls((xs) => xs.map((y, j) => (j === i ? { ...y, m3: v } : y)))} />
          </Card>
        ))}
        <ElementPicker projectId={project.id} label="Add element" value={pick} onChange={addElement} error={errors.elements} name="elements" />
        {holds.length ? (
          <Banner tone="warning" icon="hand-back-left-outline" title="Hold points not cleared"
            text={`${holds.map((h) => `${elementLabel(h.elementId)}: ${h.activity.name}`).join(' · ')}. Trucks cannot be accepted until the inspection passes.`}
            actions={[{ label: 'Request inspection', onPress: () => router.push(`/inspections/check?element=${holds[0].elementId}&activity=${holds[0].activity.id}`) }]} />
        ) : null}
      </Section>
      <Card>
        <MixDesignPicker projectId={project.id} value={mixId} onChange={chooseMix} error={errors.mix} name="mix" />
        <Segmented<PourMethod> label="Method" value={method} onChange={setMethod} options={[
          { value: 'ready_mix', label: 'Ready-mix', icon: 'dump-truck' }, { value: 'site_batched', label: 'Site batched', icon: 'hammer-wrench' },
        ]} />
        <DateField label="Pour date" quick value={date} onChange={setDate} />
        <QuantityStepper label="Planned volume" unit="m3" step={0.5} quick={[]} value={total} onChange={setTotal} error={errors.total} name="total"
          fill={sum > 0 ? { label: 'Elements', value: Math.round(sum * 1000) / 1000 } : null} />
      </Card>
      <Card>
        {method === 'ready_mix' ? <SupplierPicker label="Ready-mix supplier" value={supplierId} onChange={setSupplierId} /> : null}
        <View><StorePicker projectId={project.id} label={method === 'ready_mix' ? 'Receiving store' : 'Batching store'} value={storeId} onChange={setStoreId} error={errors.store} name="store" /></View>
        <ChipGroup label="Curing" scroll value={curing} onChange={setCuring} options={CURING.map((c) => ({ value: c, label: c }))} />
        <Field label="Remarks" optional value={remarks} onChangeText={setRemarks} multiline />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
