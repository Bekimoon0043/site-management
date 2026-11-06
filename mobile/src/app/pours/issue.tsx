// Store keeper issues cement / sand / aggregate (or admixtures) to a pour; split pro-rata
// over the pour's elements (issue_pour_materials). Pre-filled from the mix design.
import React, { useMemo, useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSession } from '../../lib/app';
import { get } from '../../lib/db';
import { canField, type MixDesign, type Pour } from '../../lib/contract-field';
import { pourElements, pourTotals, uomKg } from '../../lib/field';
import { elementLabel, specLabel, specUom, stockQty } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { fmtQty, num } from '../../lib/format';
import {
  ActionBar, Banner, Button, Card, EmptyState, Field, QuantityStepper, Screen, Section, SuccessView, Text, haptic, showError, useForm, type Errors,
} from '../../components/ui';
import { SpecPicker, StorePicker } from '../../components/pickers';

interface Line { id: string; specId: string | null; qty: string }

export default function IssueToPour() {
  const { pour: pourId } = useLocalSearchParams<{ pour: string }>();
  const { profile, project } = useSession();
  const form = useForm();
  const p = useMemo(() => get<Pour>('pours', pourId), [pourId]);
  const md = useMemo(() => (p ? get<MixDesign>('mix_designs', p.mix_design_id) : null), [p]);
  const [storeId, setStoreId] = useState<string | null>(p?.store_id ?? null);
  const [lines, setLines] = useState<Line[]>(() => {
    if (!p || !md?.cement_spec_id) return [{ id: uuid(), specId: null, qty: '' }];
    const vol = Math.max(pourTotals(p.id).batched, Number(p.planned_m3));
    const kg = md.cement_kg_per_m3 ? Number(md.cement_kg_per_m3) * vol : null;
    const per = uomKg(specUom(md.cement_spec_id));
    return [{ id: uuid(), specId: md.cement_spec_id, qty: kg && per ? String(Math.ceil(kg / per)) : '' }];
  });
  const [remarks, setRemarks] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [done, setDone] = useState<string | null>(null);
  const [mivId] = useState(uuid);

  if (!p) return <Screen><Stack.Screen options={{ title: 'Issue to pour' }} /><EmptyState icon="cloud-off-outline" title="Pour not on this phone" /></Screen>;
  if (done) {
    return (
      <>
        <Stack.Screen options={{ title: 'Issued', headerBackVisible: false }} />
        <SuccessView title={`${done} saved on phone`} body="Stock is updated now and split over the pour's elements."
          actions={[{ label: 'Open MIV', icon: 'file-document-outline', variant: 'tonal', onPress: () => router.replace(`/store/doc?type=miv&id=${mivId}`) },
            { label: 'Back to pour', icon: 'check', variant: 'primary', onPress: () => router.back() }]} />
      </>
    );
  }
  const allowed = canField(profile.role, 'pour.issue');
  const set = (i: number, x: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...x } : l)));

  const post = () => {
    const e: Errors = {};
    if (!storeId) e.store = 'Choose the issuing store';
    const out = lines.filter((l) => l.specId && num(l.qty) > 0);
    if (!out.length) e.line0 = 'Add a material and quantity';
    lines.forEach((l, i) => {
      if (l.specId && storeId && num(l.qty) > stockQty(project.id, l.specId, storeId)) e[`line${i}`] = `Only ${fmtQty(stockQty(project.id, l.specId, storeId))} ${specUom(l.specId)} in this store`;
    });
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      const number = nextDocNumber(project.code, 'MIV');
      enqueue('issue_pour_materials', { pour_id: p.id, miv_id: mivId, number, store_id: storeId!, issued_at: new Date().toISOString(), remarks: remarks.trim() || undefined,
        lines: out.map((l) => ({ material_spec_id: l.specId!, qty: num(l.qty) })) }, { entityType: 'pour', entityId: p.id, label: `${number} issued to ${p.number}` });
      haptic('confirm'); setDone(number);
    } catch (err) { showError(err); }
  };

  return (
    <Screen form={form} footer={allowed ? <ActionBar summary={`${lines.filter((l) => l.specId).length} item(s) → ${pourElements(p.id).length} element(s)`}
      primary={{ title: 'Post issue', variant: 'hero', icon: 'tray-arrow-up', onPress: post }} /> : undefined}>
      <Stack.Screen options={{ title: `Issue to ${p.number}` }} />
      {!allowed ? <Banner tone="info" text="Only the store keeper (or management) issues materials." /> : null}
      <Card dense>
        <Text variant="label">{md ? `${md.code} · ${md.grade}` : ''}</Text>
        <Text variant="bodySm" tone="muted">{pourElements(p.id).map((e) => elementLabel(e.element_id)).join(', ')} · planned {fmtQty(p.planned_m3)} m3</Text>
        {md?.cement_kg_per_m3 ? <Text variant="caption" tone="muted">Design cement {fmtQty(md.cement_kg_per_m3)} kg/m3</Text> : null}
      </Card>
      <StorePicker projectId={project.id} label="Issuing store" value={storeId} onChange={setStoreId} error={errors.store} name="store" />
      <Section title="Materials">
        {lines.map((l, i) => (
          <Card key={l.id}>
            <SpecPicker value={l.specId} onChange={(v) => set(i, { specId: v })} />
            {l.specId ? <Text variant="caption" tone="muted">{specLabel(l.specId)} · in store {storeId ? fmtQty(stockQty(project.id, l.specId, storeId)) : '—'} {specUom(l.specId)}</Text> : null}
            <QuantityStepper label="Quantity" unit={l.specId ? specUom(l.specId) : ''} value={l.qty} onChange={(v) => set(i, { qty: v })} error={errors[`line${i}`]} name={`line${i}`} />
            {lines.length > 1 ? <Button title="Remove" size="sm" variant="dangerOutline" icon="trash-can-outline" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} /> : null}
          </Card>
        ))}
        <Button title="Add material" variant="tonal" icon="plus" onPress={() => setLines((ls) => [...ls, { id: uuid(), specId: null, qty: '' }])} />
      </Section>
      <Field label="Remarks" optional value={remarks} onChangeText={setRemarks} multiline />
    </Screen>
  );
}
