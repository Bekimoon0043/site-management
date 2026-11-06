// Procurement officer quick form: log a market price seen at a supplier / market (log_market_price).
// The server converts VAT-inclusive prices, compares with the 90-day average and flags spikes.
import React, { useState } from 'react';
import { Stack, router } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { canProcure, type PriceObservation } from '../../lib/contract-procurement';
import { list } from '../../lib/db';
import { canSeePrices, supplierName } from '../../lib/pc';
import { specLabel, specUom } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { fmtDate, fmtMoney, num, today } from '../../lib/format';
import { t, useLocale } from '../../lib/i18n';
import {
  ActionBar, Banner, Card, Field, InfoRow, Screen, Section, Segmented, haptic, toast, useForm, useUnsavedGuard, type Errors,
} from '../../components/ui';
import { DateField, SpecPicker, SupplierPicker } from '../../components/pickers';

export default function LogPrice() {
  const { profile, project } = useSession();
  useLocale();
  const form = useForm();
  const [specId, setSpecId] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [vat, setVat] = useState<'ex' | 'inc'>('inc');
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [location, setLocation] = useState('');
  const [on, setOn] = useState<string | null>(today());
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const disable = useUnsavedGuard(!!specId || !!price, { what: 'price' });
  const allowed = canProcure(profile.role, 'price.log') && canSeePrices(profile.role);
  const history = useData(() => (specId && allowed ? list<PriceObservation>('price_observations', { parent: specId })
    .sort((a, b) => b.observed_on.localeCompare(a.observed_on)).slice(0, 6) : []), [specId, allowed]);

  const save = (again: boolean) => {
    const e: Errors = {};
    if (!specId) e.spec = 'Select the material';
    if (!(num(price) >= 0) || !price.trim()) e.price = 'Enter the unit price';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    const id = uuid();
    enqueue('log_market_price', {
      id, project_id: project.id, material_spec_id: specId!, unit_price: num(price), observed_on: on ?? undefined,
      prices_include_vat: vat === 'inc', supplier_id: supplierId ?? undefined, location: location.trim() || undefined, note: note.trim() || undefined,
    }, { entityType: 'price_observation', entityId: id, label: `Price ${specLabel(specId)} logged` });
    haptic('confirm');
    toast.success(t('common.savedOnPhone', { x: `${specLabel(specId)} · ${fmtMoney(num(price))}` }));
    if (again) { setSpecId(null); setPrice(''); setNote(''); setErrors({}); }
    else { disable(); router.back(); }
  };

  if (!allowed) {
    return <Screen><Stack.Screen options={{ title: t('act.logPrice') }} /><Banner tone="warning" text="Only procurement and management roles with price access can log prices." /></Screen>;
  }
  return (
    <Screen form={form} footer={<ActionBar primary={{ title: t('common.save'), icon: 'check', variant: 'hero', onPress: () => save(false) }}
      secondary={{ title: 'Save & add another', variant: 'outline', onPress: () => save(true) }} />}>
      <Stack.Screen options={{ title: t('act.logPrice') }} />
      <Card>
        <SpecPicker value={specId} onChange={setSpecId} error={errors.spec} name="spec" />
        <Field label={`Unit price (ETB${specId ? ` per ${specUom(specId)}` : ''})`} value={price} onChangeText={setPrice} keyboardType="decimal-pad"
          error={errors.price} name="price" leadingIcon="cash" />
        <Segmented value={vat} onChange={setVat} accessibilityLabel="VAT" options={[{ value: 'inc', label: 'Incl. VAT' }, { value: 'ex', label: 'Excl. VAT' }]} />
        <DateField label={t('common.date')} value={on} onChange={setOn} />
        <SupplierPicker value={supplierId} onChange={setSupplierId} optional />
        <Field label="Market / location" optional value={location} onChangeText={setLocation} placeholder="Merkato, Kality…" />
        <Field label={t('common.remarks')} optional value={note} onChangeText={setNote} multiline />
      </Card>
      {history.length ? (
        <Section title="Recent prices">
          <Card>
            {history.map((h) => (
              <InfoRow key={h.id} label={`${fmtDate(h.observed_on)} · ${h.supplier_id ? supplierName(h.supplier_id) : h.location ?? h.source}`}
                value={fmtMoney(h.unit_price, h.currency)} tone={h.is_spike ? 'danger' : undefined} icon={h.is_spike ? 'arrow-up-bold' : undefined} />
            ))}
          </Card>
        </Section>
      ) : null}
    </Screen>
  );
}
