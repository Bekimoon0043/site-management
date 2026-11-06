// Material return note (FR-ST-05, workflow 9.3). Prefills from an issue voucher.
import React, { useState } from 'react';
import { Stack, router } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { list } from '../../lib/db';
import type { Miv, MivLine } from '../../lib/contract';
import { personName, specLabel, specUom, stores } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { fmtDate, fmtQty, num } from '../../lib/format';
import {
  ActionBar, Button, Card, Field, Picker, QuantityStepper, Row, Screen, Section, Segmented, Text, haptic, showError, toast, useForm, type Errors,
} from '../../components/ui';
import { ElementPicker, PersonPicker, SpecPicker, StorePicker } from '../../components/pickers';

interface Line { id: string; specId: string | null; elementId: string | null; mrLineId: string | null; issued: number | null; qty: string; condition: 'good' | 'damaged' }
const blank = (): Line => ({ id: uuid(), specId: null, elementId: null, mrLineId: null, issued: null, qty: '', condition: 'good' });

export default function Return() {
  const { project } = useSession();
  const form = useForm();
  const [id] = useState(uuid);
  const [storeId, setStoreId] = useState<string | null>(() => stores(project.id)[0]?.id ?? null);
  const [mivId, setMivId] = useState<string | null>(null);
  const [by, setBy] = useState<string | null>(null);
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [errors, setErrors] = useState<Errors>({});

  const mivOptions = useData(() => list<Miv>('mivs', { project: project.id })
    .filter((m) => m.status !== 'reversed')
    .sort((a, b) => b.issued_at.localeCompare(a.issued_at)).slice(0, 100)
    .map((m) => ({ id: m.id, code: m.number, label: m.number, sub: `${fmtDate(m.issued_at)} · ${personName(m.issued_to)}` })), [project.id]);

  const pickMiv = (mid: string | null) => {
    setMivId(mid);
    if (!mid) { setLines([blank()]); return; }
    const m = list<Miv>('mivs', { project: project.id }).find((x) => x.id === mid);
    if (m) { setBy(m.issued_to); setStoreId(m.store_id); }
    setLines(list<MivLine>('miv_lines', { parent: mid }).map((l) => ({ ...blank(), specId: l.material_spec_id, elementId: l.element_id, mrLineId: l.mr_line_id, issued: Number(l.qty) })));
  };
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const post = () => {
    const e: Errors = {};
    if (!storeId) e.store = 'Select the store';
    const out = lines.filter((l) => l.specId && num(l.qty) > 0).map((l) => ({
      id: l.id, material_spec_id: l.specId!, element_id: l.elementId ?? undefined, mr_line_id: l.mrLineId ?? undefined,
      qty: num(l.qty), condition: l.condition,
    }));
    if (!out.length) e.line0 = 'Enter at least one returned quantity';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      const number = nextDocNumber(project.code, 'MRN');
      enqueue('post_mrn', {
        id, project_id: project.id, number, store_id: storeId!, miv_id: mivId ?? undefined, returned_by: by ?? undefined,
        returned_at: new Date().toISOString(), remarks: remarks.trim() || undefined, lines: out,
      }, { entityType: 'mrn', entityId: id, label: `${number} return` });
      haptic('confirm');
      toast.success(`${number} saved on phone`);
      router.replace(`/store/doc?type=mrn&id=${id}`);
    } catch (err) { showError(err); }
  };

  const n = lines.filter((l) => num(l.qty) > 0).length;
  return (
    <Screen form={form} footer={<ActionBar summary={`${n} item${n === 1 ? '' : 's'} returned`} primary={{ title: 'Post return', onPress: post }} />}>
      <Stack.Screen options={{ title: 'Return to store' }} />
      <Card>
        <Picker label="From issue voucher" optional value={mivId} options={mivOptions} onChange={pickMiv} allowClear placeholder="Manual return" />
        <PersonPicker projectId={project.id} label="Returned by" value={by} onChange={setBy} />
        <StorePicker projectId={project.id} value={storeId} onChange={setStoreId} error={errors.store} name="store" />
      </Card>
      <Section title="Items">
        {lines.map((l, i) => (
          <Card key={l.id} stripe={l.condition === 'damaged' ? 'warning' : null}>
            {l.issued != null && l.specId ? <Text variant="titleSm">{specLabel(l.specId)}</Text>
              : <SpecPicker value={l.specId} onChange={(v) => setLine(i, { specId: v })} />}
            <QuantityStepper label="Returned" unit={l.specId ? specUom(l.specId) : ''} value={l.qty} onChange={(v) => setLine(i, { qty: v })}
              name={`line${i}`} error={i === 0 ? errors.line0 : null} max={l.issued ?? undefined}
              info={l.issued != null ? `Issued ${fmtQty(l.issued)}` : null} fill={l.issued ? { label: 'All issued', value: l.issued } : null} />
            <Segmented label="Condition" value={l.condition} onChange={(v) => setLine(i, { condition: v })} options={[
              { value: 'good', label: 'Good · to stock', tone: 'success' }, { value: 'damaged', label: 'Damaged', tone: 'warning' },
            ]} />
            {l.condition === 'damaged' ? <Text variant="caption" tone="warning">Damaged items go to quarantine, not available stock.</Text> : null}
            <ElementPicker projectId={project.id} label="Returned from element" optional value={l.elementId} onChange={(v) => setLine(i, { elementId: v })} />
            {lines.length > 1 ? <Row><Button title="Remove" size="sm" variant="dangerOutline" icon="trash-can-outline" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} /></Row> : null}
          </Card>
        ))}
        <Button variant="tonal" title="Add item" icon="plus" onPress={() => setLines((ls) => [...ls, blank()])} />
      </Section>
      <Field label="Remarks" optional value={remarks} onChangeText={setRemarks} multiline />
    </Screen>
  );
}
