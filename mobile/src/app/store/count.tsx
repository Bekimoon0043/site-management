// Periodic / spot stock count with variance (FR-ST-08). Smart fill chip = system quantity.
import React, { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Stack, router } from 'expo-router';
import { useSession } from '../../lib/app';
import { specLabel, specUom, stockBalances, stockQty, stores } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { fmtQty, num } from '../../lib/format';
import {
  ActionBar, Card, Chip, EmptyState, Field, QuantityStepper, Row, Screen, Section, Segmented, Text, haptic, showError, toast, useForm, type Errors,
} from '../../components/ui';
import { SpecPicker, StorePicker } from '../../components/pickers';

interface Line { id: string; specId: string; counted: string }

export default function Count() {
  const { project } = useSession();
  const form = useForm();
  const [id] = useState(uuid);
  const [storeId, setStoreId] = useState<string | null>(() => stores(project.id)[0]?.id ?? null);
  const [type, setType] = useState<'periodic' | 'spot'>('periodic');
  const [lines, setLines] = useState<Line[]>([]);
  const [remarks, setRemarks] = useState('');
  const [errors, setErrors] = useState<Errors>({});

  useEffect(() => {
    if (!storeId || type === 'spot') { setLines([]); return; }
    setLines(stockBalances(project.id).filter((b) => b.store_id === storeId && b.available !== 0)
      .map((b) => ({ id: uuid(), specId: b.material_spec_id, counted: '' }))
      .sort((a, b) => specLabel(a.specId).localeCompare(specLabel(b.specId))));
  }, [storeId, type, project.id]);

  const add = (sid: string | null) => {
    if (sid && !lines.some((l) => l.specId === sid)) setLines((ls) => [...ls, { id: uuid(), specId: sid, counted: '' }]);
  };

  const submit = () => {
    const e: Errors = {};
    if (!storeId) e.store = 'Select the store';
    lines.forEach((l, i) => { if (l.counted.trim() !== '' && !(num(l.counted) >= 0)) e[`line${i}`] = `Invalid count for ${specLabel(l.specId)}`; });
    const out = lines.filter((l) => l.counted.trim() !== '').map((l) => ({ id: l.id, material_spec_id: l.specId, counted_qty: num(l.counted) }));
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    if (!out.length) { showError(new Error('Enter at least one counted quantity')); return; }
    try {
      const number = nextDocNumber(project.code, 'CNT');
      enqueue('submit_stock_count', {
        id, project_id: project.id, number, store_id: storeId!, count_type: type, counted_at: new Date().toISOString(),
        remarks: remarks.trim() || undefined, lines: out,
      }, { entityType: 'stock_count', entityId: id, label: `${number} count` });
      haptic('confirm');
      toast.success(`${number} submitted for approval`);
      router.replace(`/store/doc?type=count&id=${id}`);
    } catch (err) { showError(err); }
  };

  const counted = lines.filter((l) => l.counted.trim() !== '');
  const variances = counted.filter((l) => storeId && Math.abs(num(l.counted) - stockQty(project.id, l.specId, storeId)) > 1e-9).length;

  return (
    <Screen form={form} footer={
      <ActionBar summary={`${counted.length} of ${lines.length} counted${variances ? ` · ${variances} variance${variances > 1 ? 's' : ''}` : ''}`}
        warning={variances > 0} primary={{ title: 'Submit count', onPress: submit }} />
    }>
      <Stack.Screen options={{ title: 'Stock count' }} />
      <Card>
        <StorePicker projectId={project.id} value={storeId} onChange={setStoreId} error={errors.store} name="store" />
        <Segmented label="Count type" value={type} onChange={setType} options={[{ value: 'periodic', label: 'Periodic (all)' }, { value: 'spot', label: 'Spot check' }]} />
      </Card>
      <Section title="Items">
        {!lines.length ? <EmptyState icon="counter" title={type === 'spot' ? 'Add the items you are checking' : 'No stock in this store'} compact /> : null}
        {lines.map((l, i) => {
          const sys = storeId ? stockQty(project.id, l.specId, storeId) : 0;
          const c = num(l.counted);
          const variance = l.counted.trim() !== '' && Number.isFinite(c) ? c - sys : null;
          return (
            <Card key={l.id} dense stripe={variance == null ? null : variance === 0 ? 'success' : 'danger'}>
              <Row justify="space-between">
                <Text variant="label" style={styles.flex}>{specLabel(l.specId)}</Text>
                {variance != null ? <Chip label={variance === 0 ? 'Matches' : `Variance ${variance > 0 ? '+' : ''}${fmtQty(variance)}`}
                  tone={variance === 0 ? 'success' : 'danger'} icon={variance === 0 ? 'check' : 'alert-outline'} small /> : null}
              </Row>
              <QuantityStepper label="Physical count" unit={specUom(l.specId)} value={l.counted} name={`line${i}`} error={errors[`line${i}`]}
                info={`System ${fmtQty(sys)}`} quick={[]} fill={{ label: 'System', value: sys }}
                onChange={(v) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, counted: v } : x)))} />
            </Card>
          );
        })}
        <SpecPicker label="Add item to count" value={null} onChange={add} placeholder="Search material" />
      </Section>
      <Field label="Remarks" optional value={remarks} onChangeText={setRemarks} multiline />
    </Screen>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
