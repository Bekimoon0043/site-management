// Wastage, damage and loss with reason, photo and approval (FR-ST-07).
import React, { useState } from 'react';
import { Stack, router } from 'expo-router';
import { useSession } from '../../lib/app';
import { WASTAGE_REASONS, type StockStatus } from '../../lib/contract';
import { specUom, stockQty, stores } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { fmtQty, num } from '../../lib/format';
import {
  ActionBar, Banner, Button, Card, ChipGroup, Field, PhotoStrip, QuantityStepper, Row, Screen, Section, Segmented, Text, haptic, showError, toast,
  useForm, type Errors,
} from '../../components/ui';
import { ElementPicker, SpecPicker, StorePicker } from '../../components/pickers';

type AdjType = 'wastage' | 'damage' | 'loss' | 'write_off';
interface Line { id: string; specId: string | null; elementId: string | null; qty: string; status: StockStatus }
const blank = (): Line => ({ id: uuid(), specId: null, elementId: null, qty: '', status: 'available' });

export default function Wastage() {
  const { project } = useSession();
  const form = useForm();
  const [id] = useState(uuid);
  const [storeId, setStoreId] = useState<string | null>(() => stores(project.id)[0]?.id ?? null);
  const [type, setType] = useState<AdjType>('wastage');
  const [reason, setReason] = useState<string | null>(null);
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [errors, setErrors] = useState<Errors>({});
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const post = () => {
    const e: Errors = {};
    if (!storeId) e.store = 'Select the store';
    if (!reason) e.reason = 'Select a reason code';
    lines.forEach((l, i) => {
      if (!l.specId || !(num(l.qty) > 0) || !storeId) return;
      const avail = stockQty(project.id, l.specId, storeId, l.status);
      if (num(l.qty) > avail + 1e-9) e[`line${i}`] = `Only ${fmtQty(avail)} ${l.status} in this store`;
    });
    const out = lines.filter((l) => l.specId && num(l.qty) > 0)
      .map((l) => ({ id: l.id, material_spec_id: l.specId!, element_id: l.elementId ?? undefined, stock_status: l.status, qty: num(l.qty) }));
    if (!out.length && !Object.keys(e).some((k) => k.startsWith('line'))) e.line0 = 'Enter at least one quantity';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      const number = nextDocNumber(project.code, 'ADJ');
      enqueue('create_adjustment', {
        id, project_id: project.id, number, store_id: storeId!, adj_type: type, reason_code: reason!,
        remarks: remarks.trim() || undefined, lines: out,
      }, { entityType: 'adjustment', entityId: id, label: `${number} ${type}` });
      haptic('confirm');
      toast.success(`${number} sent for approval`);
      router.replace(`/store/doc?type=adjustment&id=${id}`);
    } catch (err) { showError(err); }
  };

  const n = lines.filter((l) => num(l.qty) > 0).length;
  return (
    <Screen form={form} footer={<ActionBar summary={`${n} item${n === 1 ? '' : 's'} · needs approval`} primary={{ title: 'Submit for approval', onPress: post }} />}>
      <Stack.Screen options={{ title: 'Wastage / damage / loss' }} />
      <Banner tone="info" text="Stock is only reduced after a coordinator or manager approves." />
      <Card>
        <StorePicker projectId={project.id} value={storeId} onChange={setStoreId} error={errors.store} name="store" />
        <Segmented label="Type" value={type} onChange={setType} options={[
          { value: 'wastage', label: 'Wastage' }, { value: 'damage', label: 'Damage' }, { value: 'loss', label: 'Loss' }, { value: 'write_off', label: 'Write-off' },
        ]} />
        <ChipGroup label="Reason" value={reason} onChange={setReason} options={WASTAGE_REASONS.map((r) => ({ value: r, label: r }))} />
        {errors.reason ? <Text variant="bodySm" tone="danger">{errors.reason}</Text> : null}
      </Card>
      <Section title="Items">
        {lines.map((l, i) => (
          <Card key={l.id}>
            <SpecPicker value={l.specId} onChange={(v) => setLine(i, { specId: v })} />
            <Segmented label="From stock" value={l.status} onChange={(v) => setLine(i, { status: v })} options={[{ value: 'available', label: 'Available' }, { value: 'quarantine', label: 'Quarantine' }]} />
            <QuantityStepper label="Quantity lost / damaged" unit={l.specId ? specUom(l.specId) : ''} value={l.qty} onChange={(v) => setLine(i, { qty: v })}
              name={`line${i}`} error={errors[`line${i}`]} info={l.specId && storeId ? `In store ${fmtQty(stockQty(project.id, l.specId, storeId, l.status))}` : null} />
            <ElementPicker projectId={project.id} label="Element (if wasted at the workface)" optional value={l.elementId} onChange={(v) => setLine(i, { elementId: v })} />
            {lines.length > 1 ? <Row><Button title="Remove" size="sm" variant="dangerOutline" icon="trash-can-outline" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} /></Row> : null}
          </Card>
        ))}
        <Button variant="tonal" title="Add item" icon="plus" onPress={() => setLines((ls) => [...ls, blank()])} />
      </Section>
      <PhotoStrip projectId={project.id} entityType="adjustment" entityId={id} label="Evidence photos" />
      <Field label="Remarks" optional value={remarks} onChangeText={setRemarks} multiline />
    </Screen>
  );
}
