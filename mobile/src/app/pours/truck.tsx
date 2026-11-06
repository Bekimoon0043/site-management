// Ready-mix batch ticket, fast entry while the truck discharges (features C3 step 2).
// Ticket no + photo, volume stepper, times defaulting to now, slump, water added,
// big Accept / Reject with reason chips. Store roles post GRN + MIV immediately; otherwise
// the truck waits in the store keeper's "awaiting receipt" queue (two-step receipt).
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get } from '../../lib/db';
import { canField, type MixDesign, type Pour } from '../../lib/contract-field';
import { WARNING_LABELS, openPourHoldPoints, pourElements, pourTotals, truckWarnings } from '../../lib/field';
import { capturePhoto } from '../../lib/photos';
import { elementLabel } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { fmtQty, num } from '../../lib/format';
import { space } from '../../theme';
import {
  ActionBar, Banner, Card, Chip, ChipGroup, EmptyState, Field, PhotoStrip, ProgressBar, QuantityStepper, Row, Screen, Segmented, Text, haptic,
  showError, toast, useForm, type Errors,
} from '../../components/ui';
import { TimeField } from '../../components/field';

const REJECT = ['Slump out of range', 'Late / setting', 'Wrong grade', 'Water added by driver', 'Segregation', 'Short volume', 'No ticket'];

export default function AddTruck() {
  const { pour: pourId } = useLocalSearchParams<{ pour: string }>();
  const { profile, project } = useSession();
  const form = useForm();
  const d = useData(() => {
    const p = get<Pour>('pours', pourId);
    return p ? { p, md: get<MixDesign>('mix_designs', p.mix_design_id), tot: pourTotals(p.id), holds: openPourHoldPoints(pourElements(p.id).map((e) => e.element_id)) } : null;
  }, [pourId]);
  const [id, setId] = useState(uuid);
  const [ticket, setTicket] = useState('');
  const [vol, setVol] = useState('');
  const [plate, setPlate] = useState('');
  const [batched, setBatched] = useState<string | null>(null);
  const [arrived, setArrived] = useState<string | null>(() => new Date().toISOString());
  const [discharge, setDischarge] = useState<string | null>(() => new Date().toISOString());
  const [slump, setSlump] = useState('');
  const [temp, setTemp] = useState('');
  const [water, setWater] = useState('');
  const [accept, setAccept] = useState<'yes' | 'no'>('yes');
  const [reason, setReason] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const lastVol = useMemo(() => d?.tot.trucks[d.tot.trucks.length - 1]?.volume_m3 ?? null, [d?.tot.trucks.length]);

  if (!d) return <Screen><Stack.Screen options={{ title: 'Truck' }} /><EmptyState icon="cloud-off-outline" title="Pour not on this phone" /></Screen>;
  const { p, md, tot, holds } = d;
  if (p.method !== 'ready_mix' || (p.status !== 'planned' && p.status !== 'in_progress')) {
    return <Screen><Stack.Screen options={{ title: p.number }} /><EmptyState icon="lock-outline" title={p.method !== 'ready_mix' ? 'Site-batched pour: record batches instead' : `Pour is ${p.status}`} /></Screen>;
  }
  const remaining = Math.max(Number(p.planned_m3) - tot.accepted, 0);
  const warns = truckWarnings({ batched_at: batched, arrived_at: arrived, water_added_l: water.trim() ? num(water) : null, slump_mm: slump.trim() ? num(slump) : null, concrete_temp_c: temp.trim() ? num(temp) : null }, md);
  const isStore = canField(profile.role, 'pour.receiveTruck');
  const after = tot.accepted + (accept === 'yes' ? num(vol) || 0 : 0);

  const save = () => {
    const e: Errors = {};
    if (!ticket.trim()) e.ticket = 'Enter the batch ticket number';
    else if (tot.trucks.some((k) => k.ticket_no.toLowerCase() === ticket.trim().toLowerCase())) e.ticket = 'This ticket is already recorded for the pour';
    if (!(num(vol) > 0)) e.vol = 'Enter the truck volume';
    const rr = [reason, reasonText.trim()].filter(Boolean).join(' · ');
    if (accept === 'no' && !rr) e.reason = 'Why was the truck rejected?';
    if (accept === 'yes' && isStore && !p.store_id) e.ticket = 'Set the receiving store on the pour first (Edit plan)';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      const post = accept === 'yes' && isStore
        ? { store_id: p.store_id ?? undefined, grn_id: uuid(), grn_number: nextDocNumber(project.code, 'GRN'), miv_id: uuid(), miv_number: nextDocNumber(project.code, 'MIV') }
        : {};
      enqueue('add_pour_truck', {
        id, pour_id: p.id, ticket_no: ticket.trim(), supplier_name: p.supplier_name ?? undefined, truck_plate: plate.trim() || undefined, volume_m3: num(vol),
        batched_at: batched ?? undefined, arrived_at: arrived ?? undefined, discharge_start: accept === 'yes' ? discharge ?? undefined : undefined,
        slump_mm: slump.trim() ? Math.round(num(slump)) : undefined, concrete_temp_c: temp.trim() ? num(temp) : undefined,
        water_added_l: water.trim() ? num(water) : undefined, accepted: accept === 'yes', reject_reason: accept === 'no' ? rr : undefined, ...post,
      }, { entityType: 'pour_truck', entityId: id, label: `${p.number} truck ${ticket.trim()} ${accept === 'yes' ? 'accepted' : 'rejected'}` });
      haptic(accept === 'yes' ? 'confirm' : 'reject');
      toast.success(accept === 'yes' ? `Truck ${ticket.trim()} accepted · ${fmtQty(after)} of ${fmtQty(p.planned_m3)} m3${isStore ? '' : ' · store keeper notified'}` : `Truck ${ticket.trim()} rejected`);
      // ready for the next truck
      setId(uuid()); setTicket(''); setPlate(''); setBatched(null); setArrived(new Date().toISOString()); setDischarge(new Date().toISOString());
      setSlump(''); setTemp(''); setWater(''); setAccept('yes'); setReason(null); setReasonText(''); setErrors({});
      if (after >= Number(p.planned_m3)) router.back();
    } catch (err) { showError(err); }
  };

  return (
    <Screen form={form} footer={<ActionBar summary={`After this: ${fmtQty(after)} of ${fmtQty(p.planned_m3)} m3`} warning={warns.length > 0 || accept === 'no'}
      primary={{ title: accept === 'yes' ? 'Accept truck' : 'Reject truck', variant: accept === 'yes' ? 'hero' : 'danger', icon: accept === 'yes' ? 'check' : 'close', onPress: save }}
      secondary={{ title: 'Done', variant: 'ghost', onPress: () => router.back() }} />}>
      <Stack.Screen options={{ title: `Truck #${tot.trucks.length + 1} · ${p.number}` }} />
      <Card dense>
        <Row justify="space-between"><Text variant="label">{md?.grade ?? ''} · {pourElements(p.id).map((e) => elementLabel(e.element_id)).join(', ')}</Text></Row>
        <ProgressBar pct={Math.min((tot.accepted / Number(p.planned_m3)) * 100, 100)} showLabel />
        <Text variant="caption" tone="muted">{fmtQty(tot.accepted)} m3 accepted · {fmtQty(remaining)} m3 to go{tot.awaitingCount ? ` · ${tot.awaitingCount} awaiting receipt` : ''}</Text>
      </Card>
      {holds.length && accept === 'yes' ? <Banner tone="danger" icon="hand-back-left-outline" title="Hold point not cleared" text={`${elementLabel(holds[0].elementId)}: ${holds[0].activity.name}. The server will refuse accepted concrete until it passes.`} /> : null}

      <Card>
        <Field label="Batch ticket no." value={ticket} onChangeText={setTicket} autoCapitalize="characters" error={errors.ticket} name="ticket"
          trailing={{ icon: 'camera-outline', accessibilityLabel: 'Photograph the batch ticket', onPress: () => void capturePhoto({ projectId: project.id, entityType: 'pour_truck', entityId: id, kind: 'delivery_note' }, 'camera').catch(showError) }} />
        <QuantityStepper label="Volume" unit="m3" step={0.5} quick={[6, 7, 8, 10]} value={vol} onChange={setVol} error={errors.vol} name="vol"
          fill={lastVol ? { label: 'Same as last', value: Number(lastVol) } : remaining > 0 ? { label: 'Remaining', value: Math.round(remaining * 100) / 100 } : null} />
        <Field label="Truck plate" optional value={plate} onChangeText={setPlate} autoCapitalize="characters" placeholder="AA-3-12345" />
      </Card>

      <Card>
        <TimeField label="Arrived" value={arrived} onChange={setArrived} />
        <TimeField label="Batched (from ticket)" optional value={batched} onChange={setBatched} quick={[-30, -60, -90, -120]} />
        {accept === 'yes' ? <TimeField label="Discharge start" value={discharge} onChange={setDischarge} /> : null}
      </Card>

      <Card>
        <QuantityStepper label="Slump" unit="mm" step={5} quick={[]} value={slump} onChange={setSlump}
          hint={md?.target_slump_mm ? `Target ${md.target_slump_mm} ± ${md.slump_tolerance_mm} mm` : null}
          fill={md?.target_slump_mm ? { label: 'Target', value: md.target_slump_mm } : null} />
        <Row align="flex-start">
          <View style={styles.flex}><QuantityStepper label="Water added" unit="L" step={5} quick={[]} value={water} onChange={setWater} /></View>
          <View style={styles.flex}><QuantityStepper label="Concrete temp" unit="°C" step={1} quick={[]} value={temp} onChange={setTemp} /></View>
        </Row>
        {warns.length ? <Row wrap gap={6}>{warns.map((w) => <Chip key={w} label={WARNING_LABELS[w]} tone="warning" icon="alert-outline" small />)}</Row> : null}
      </Card>

      <Card stripe={accept === 'yes' ? 'success' : 'danger'}>
        <Segmented<'yes' | 'no'> label="Decision" value={accept} onChange={(v) => { setAccept(v); haptic(v === 'yes' ? 'toggleOn' : 'toggleOff'); }} options={[
          { value: 'yes', label: 'Accept', icon: 'check', tone: 'success' }, { value: 'no', label: 'Reject', icon: 'close', tone: 'danger' },
        ]} />
        {accept === 'no' ? (
          <View style={styles.gap}>
            <ChipGroup value={reason} onChange={setReason} options={REJECT.map((r) => ({ value: r, label: r }))} />
            <Field label={reason ? 'Details' : 'Reason'} optional={!!reason} value={reasonText} onChangeText={setReasonText} error={errors.reason} name="reason" />
          </View>
        ) : <Text variant="bodySm" tone="muted">{isStore ? 'Posts the GRN and the issue to the elements now.' : 'The store keeper receives it into stock (GRN + issue to the elements).'}</Text>}
      </Card>
      <PhotoStrip projectId={project.id} entityType="pour_truck" entityId={id} kind="delivery_note" label="Batch ticket photo" />
    </Screen>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 }, gap: { gap: space[2] } });
