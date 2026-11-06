// New gate pass (store keeper / engineer): returnable (tools, formwork on loan, with an expected
// return date) or non-returnable. Submitted passes go to the coordinator / manager inbox.
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { useSession } from '../../lib/app';
import type { GatePassType } from '../../lib/contract-control';
import { specLabel, specUom, stockQty, stores } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { addDays, fmtQty, num, today } from '../../lib/format';
import { t, useLocale } from '../../lib/i18n';
import { space } from '../../theme';
import {
  ActionBar, Button, Card, Field, QuantityStepper, Row, Screen, Section, Segmented, Text, haptic, showError, toast, useForm, useUnsavedGuard,
  type Errors,
} from '../../components/ui';
import { DateField, SpecPicker, StorePicker } from '../../components/pickers';

interface Line { id: string; specId: string | null; description: string; qty: string; free: boolean }
const blank = (): Line => ({ id: uuid(), specId: null, description: '', qty: '', free: false });

export default function NewGatePass() {
  const { project } = useSession();
  useLocale();
  const form = useForm();
  const [id] = useState(uuid);
  const [type, setType] = useState<GatePassType>('returnable');
  const [storeId, setStoreId] = useState<string | null>(() => stores(project.id)[0]?.id ?? null);
  const [destination, setDestination] = useState('');
  const [purpose, setPurpose] = useState('');
  const [plate, setPlate] = useState('');
  const [driver, setDriver] = useState('');
  const [phone, setPhone] = useState('');
  const [ret, setRet] = useState<string | null>(addDays(today(), 7));
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [errors, setErrors] = useState<Errors>({});
  const disable = useUnsavedGuard(!!destination || lines.some((l) => l.specId || l.description), { what: 'gate pass' });

  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const save = (submit: boolean) => {
    const e: Errors = {};
    if (!destination.trim()) e.destination = 'Enter where the items are going';
    if (!purpose.trim()) e.purpose = 'Enter the purpose';
    if (type === 'returnable' && !ret) e.ret = 'Pick the expected return date';
    lines.forEach((l, i) => {
      if (!l.specId && !l.description.trim()) e[`line${i}`] = 'Choose a material or describe the item';
      else if (!(num(l.qty) > 0)) e[`line${i}`] = 'Enter the quantity';
      else if (l.specId && storeId && num(l.qty) > stockQty(project.id, l.specId, storeId) + 0.0005) e[`line${i}`] = `Only ${fmtQty(stockQty(project.id, l.specId, storeId))} ${specUom(l.specId)} in this store`;
    });
    if (lines.some((l) => l.specId) && !storeId) e.store = 'A store is required for stock items';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      const number = nextDocNumber(project.code, 'GP');
      enqueue('save_gate_pass', {
        id, project_id: project.id, number, pass_type: type, store_id: storeId, destination: destination.trim(), purpose: purpose.trim(),
        vehicle_plate: plate.trim() || undefined, driver_name: driver.trim() || undefined, driver_phone: phone.trim() || undefined,
        expected_return: type === 'returnable' ? ret : null, submit,
        lines: lines.map((l) => ({ id: l.id, material_spec_id: l.specId, description: l.description.trim() || undefined, qty: num(l.qty), uom: l.specId ? specUom(l.specId) : undefined })),
      }, { entityType: 'gate_pass', entityId: id, label: `${number} ${submit ? 'submitted' : 'saved'}` });
      haptic('confirm');
      toast.success(t('common.savedOnPhone', { x: number }));
      disable();
      router.replace(`/gate/${id}`);
    } catch (err) { showError(err); }
  };

  return (
    <Screen form={form} footer={
      <ActionBar summary={`${lines.length} item${lines.length === 1 ? '' : 's'}`}
        primary={{ title: t('gate.submitPass'), variant: 'hero', icon: 'send-outline', onPress: () => save(true) }}
        secondary={{ title: 'Save draft', variant: 'outline', onPress: () => save(false) }} />
    }>
      <Stack.Screen options={{ title: t('gate.new') }} />
      <Card>
        <Segmented<GatePassType> value={type} onChange={setType} accessibilityLabel="Gate pass type" options={[
          { value: 'returnable', label: t('gate.returnable') }, { value: 'non_returnable', label: t('gate.nonReturnable') },
        ]} />
        <StorePicker projectId={project.id} label={t('common.store')} value={storeId} onChange={setStoreId} error={errors.store} name="store" allowClear />
        <Field label={t('gate.destination')} value={destination} onChangeText={setDestination} error={errors.destination} name="destination" placeholder="Site B, workshop, supplier…" />
        <Field label={t('gate.purpose')} value={purpose} onChangeText={setPurpose} error={errors.purpose} name="purpose" placeholder="Formwork loan, repair, return to supplier…" />
        {type === 'returnable' ? <DateField label={t('gate.expectedReturn')} value={ret} onChange={setRet} error={errors.ret} name="ret" quick minimumDate={new Date()} /> : null}
      </Card>
      <Card>
        <Row align="flex-start">
          <View style={styles.flex}><Field label={t('common.plate')} optional value={plate} onChangeText={setPlate} autoCapitalize="characters" placeholder="AA-3-12345" /></View>
          <View style={styles.flex}><Field label={t('common.driver')} optional value={driver} onChangeText={setDriver} autoCapitalize="words" /></View>
        </Row>
        <Field label="Driver phone" optional value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      </Card>
      <Section title={t('gate.lines')}>
        {lines.map((l, i) => (
          <Card key={l.id} stripe={errors[`line${i}`] ? 'danger' : null}>
            <Row justify="space-between">
              <Text variant="titleSm" style={styles.flex}>{l.specId ? specLabel(l.specId) : l.description || `Item ${i + 1}`}</Text>
              <Button title={l.free ? 'From stock' : 'Not in stock list'} size="sm" variant="ghost" onPress={() => setLine(i, { free: !l.free, specId: null })} />
            </Row>
            {l.free ? <Field label="Description" value={l.description} onChangeText={(v) => setLine(i, { description: v })} name={`line${i}`} error={errors[`line${i}`]} placeholder="Generator, scaffold clamps…" />
              : <SpecPicker value={l.specId} onChange={(v) => setLine(i, { specId: v })} name={`line${i}`} error={errors[`line${i}`]}
                  hint={l.specId && storeId ? `Available ${fmtQty(stockQty(project.id, l.specId, storeId))} ${specUom(l.specId)}` : null} />}
            <QuantityStepper label={t('common.quantity')} unit={l.specId ? specUom(l.specId) : ''} value={l.qty} onChange={(v) => setLine(i, { qty: v })} />
            {lines.length > 1 ? <Button title={t('common.remove')} size="sm" variant="dangerOutline" icon="trash-can-outline" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} /> : null}
          </Card>
        ))}
        <Button title={t('common.addItem')} variant="tonal" icon="plus" onPress={() => setLines((ls) => [...ls, blank()])} />
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
