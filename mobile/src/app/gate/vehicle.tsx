// Vehicle in / out log at the gate (log_vehicle). A loaded vehicle leaving without a linked
// document is flagged and raises a critical alert on the server.
import React, { useMemo, useState } from 'react';
import { Stack } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import type { Grn } from '../../lib/contract';
import { jf, rowsWhere } from '../../lib/counts';
import { gatePasses, normPlate, vehicleLog } from '../../lib/pc';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { addDays, fmtDateTime, today } from '../../lib/format';
import { t, useLocale } from '../../lib/i18n';
import {
  ActionBar, Banner, Card, Field, ListRow, Picker, Screen, Section, Segmented, haptic, showError, toast, useForm, type Errors, type Option,
} from '../../components/ui';

type Dir = 'in' | 'out';

export default function VehicleLog() {
  const { project } = useSession();
  useLocale();
  const form = useForm();
  const [dir, setDir] = useState<Dir>('out');
  const [plate, setPlate] = useState('');
  const [driver, setDriver] = useState('');
  const [purpose, setPurpose] = useState('');
  const [loaded, setLoaded] = useState<'empty' | 'loaded'>('empty');
  const [doc, setDoc] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});

  const docs = useData(() => {
    const since = addDays(today(), -3);
    const gps = gatePasses(project.id, 'all').filter((g) => ['approved', 'exited', 'partially_returned'].includes(g.status))
      .map<Option>((g) => ({ id: `gate_pass:${g.id}`, label: g.number, code: g.number, sub: `${t('act.gatePass')} · ${g.vehicle_plate ?? '—'} · ${g.destination}`, category: t('act.gatePass') }));
    const grns = rowsWhere<Grn>('grns', project.id, `AND ${jf('received_at')} >= ?`, [since], `${jf('received_at')} DESC`, 30)
      .map<Option>((g) => ({ id: `grn:${g.id}`, label: g.number, code: g.number, sub: `GRN · ${g.vehicle_plate ?? '—'} · ${g.supplier_name ?? ''}`, category: 'GRN' }));
    return [...gps, ...grns];
  }, [project.id]);
  const recent = useData(() => vehicleLog(project.id, 20), [project.id]);

  // Auto-link: a gate pass for the typed plate.
  const suggestion = useMemo(() => {
    const p = normPlate(plate);
    if (!p || doc) return null;
    return docs.find((d) => normPlate(d.sub?.split(' · ')[1]) === p) ?? null;
  }, [plate, doc, docs]);

  const flagged = dir === 'out' && loaded === 'loaded' && !doc;

  const save = () => {
    const e: Errors = {};
    if (!normPlate(plate)) e.plate = 'Enter the plate number';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      const id = uuid();
      const number = nextDocNumber(project.code, 'VEH');
      const [type, docId] = doc ? doc.split(':') as ['grn' | 'gate_pass', string] : [undefined, undefined];
      enqueue('log_vehicle', {
        id, project_id: project.id, number, direction: dir, plate: plate.trim().toUpperCase(), driver_name: driver.trim() || undefined,
        purpose: purpose.trim() || undefined, loaded: loaded === 'loaded', linked_doc_type: type, linked_doc_id: docId, at: new Date().toISOString(),
      }, { entityType: 'vehicle_movement', entityId: id, label: `${number} ${plate.trim().toUpperCase()} ${dir}` });
      haptic(flagged ? 'reject' : 'confirm');
      toast.success(t('common.savedOnPhone', { x: `${number} · ${plate.trim().toUpperCase()}` }));
      setPlate(''); setDriver(''); setPurpose(''); setLoaded('empty'); setDoc(null); setErrors({});
    } catch (err) { showError(err); }
  };

  return (
    <Screen form={form} footer={<ActionBar warning={flagged} summary={flagged ? 'Loaded exit without a document · alert will be raised' : undefined}
      primary={{ title: t('gate.logVehicle'), variant: 'hero', icon: dir === 'out' ? 'car-arrow-right' : 'car-arrow-left', onPress: save }} />}>
      <Stack.Screen options={{ title: t('gate.vehicle') }} />
      <Card>
        <Segmented<Dir> value={dir} onChange={setDir} accessibilityLabel={t('gate.direction')} options={[
          { value: 'in', label: t('gate.in') }, { value: 'out', label: t('gate.out') },
        ]} />
        <Field label={t('common.plate')} value={plate} onChangeText={setPlate} autoCapitalize="characters" placeholder="AA-3-12345"
          error={errors.plate} name="plate" leadingIcon="car-outline" />
        <Segmented<'empty' | 'loaded'> value={loaded} onChange={setLoaded} accessibilityLabel={t('gate.loaded')} options={[
          { value: 'empty', label: 'Empty' }, { value: 'loaded', label: 'Loaded', tone: 'warning' },
        ]} />
        <Picker label={t('gate.linkedDoc')} optional value={doc} options={docs} onChange={setDoc} allowClear categories
          hint={suggestion ? `Matches ${suggestion.label}: select it to link` : null} />
        <Field label={t('common.driver')} optional value={driver} onChangeText={setDriver} autoCapitalize="words" />
        <Field label={t('gate.purpose')} optional value={purpose} onChangeText={setPurpose} placeholder="Delivery, collection, visitor…" />
      </Card>
      {flagged ? <Banner tone="danger" icon="shield-alert-outline" title="No gate pass linked" text="A loaded vehicle leaving without a gate pass is reported to management." /> : null}
      {recent.length ? (
        <Section title="Recent">
          <Card flush>
            {recent.map((m) => (
              <ListRow key={m.id} id={m.id} title={`${m.plate} · ${m.direction === 'in' ? t('gate.in') : t('gate.out')}`}
                subtitle={`${fmtDateTime(m.at)}${m.loaded ? ' · loaded' : ''}${m.purpose ? ` · ${m.purpose}` : ''}`}
                icon={m.direction === 'in' ? 'car-arrow-left' : 'car-arrow-right'} iconTone={m.flagged ? 'danger' : 'primary'}
                chip={m.flagged ? { label: 'Flagged', tone: 'danger', icon: 'shield-alert-outline' } : null} />
            ))}
          </Card>
        </Section>
      ) : null}
    </Screen>
  );
}
