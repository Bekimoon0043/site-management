// Gate pass detail: lines, plate check and exit (verify_gate_pass), returns of returnable
// items (return_gate_pass), approve / reject (gate_pass_action). All writes go through the outbox;
// stock moves (gate_out / gate_in, on_loan) are applied to the local ledger immediately.
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get, list } from '../../lib/db';
import { canControl, type GateEvent, type GatePass } from '../../lib/contract-control';
import { gatePassLines, isOverdue, normPlate, storeName } from '../../lib/pc';
import { outstandingReturn } from '../../lib/optimistic-pc';
import { personName, specLabel } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { fmtDate, fmtDateTime, fmtQty, num } from '../../lib/format';
import { t, useLocale } from '../../lib/i18n';
import { space } from '../../theme';
import {
  ActionBar, Banner, Card, Chip, EmptyState, Field, InfoRow, QuantityStepper, ReasonSheet, Row, Screen, Section, Sheet,
  StatusChip, SyncChip, SyncError, Text, Button, confirm, haptic, toast, type BarAction,
} from '../../components/ui';
import { PhotoStrip } from '../../components/ui';

export default function GatePassDetail() {
  const { id, scanned } = useLocalSearchParams<{ id: string; scanned?: string }>();
  const { profile } = useSession();
  useLocale();
  const g = useData(() => get<GatePass>('gate_passes', id), [id]);
  const lines = useData(() => gatePassLines(id), [id]);
  const events = useData(() => list<GateEvent>('gate_events', { parent: id }).sort((a, b) => b.at.localeCompare(a.at)), [id]);
  const [plate, setPlate] = useState('');
  const [plateErr, setPlateErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'mismatch' | 'reject' | 'approve' | 'return' | null>(null);
  const [ret, setRet] = useState<Record<string, string>>({});

  if (!g) return <Screen><Stack.Screen options={{ title: t('gate.passes') }} /><EmptyState icon="cloud-off-outline" title={t('common.notOnPhone')} /></Screen>;

  const role = profile.role;
  const canVerify = canControl(role, 'gatepass.verify') && g.status === 'approved';
  const canReturn = canControl(role, 'gatepass.return') && g.pass_type === 'returnable' && ['exited', 'partially_returned'].includes(g.status);
  const canApprove = canControl(role, 'gatepass.approve') && g.status === 'pending';
  const canCancel = (g.requested_by === profile.id || canControl(role, 'gatepass.approve')) && ['draft', 'pending', 'approved', 'rejected'].includes(g.status);
  const plateMatch = !g.vehicle_plate || !plate.trim() || normPlate(plate) === normPlate(g.vehicle_plate);
  const overdue = isOverdue(g);

  const verify = (matches: boolean, note?: string) => {
    if (matches && g.vehicle_plate && !plate.trim()) { setPlateErr('Enter the plate you see on the vehicle'); return; }
    enqueue('verify_gate_pass', { id: uuid(), gate_pass_id: g.id, plate_seen: plate.trim() || undefined, matches, note: note || undefined, at: new Date().toISOString() },
      { entityType: 'gate_pass', entityId: g.id, label: `${g.number} ${matches ? 'exit verified' : 'mismatch reported'}` });
    haptic(matches ? 'confirm' : 'reject');
    toast.success(t('common.savedOnPhone', { x: `${g.number} · ${matches ? t('status.exited') : t('gate.mismatch')}` }));
    setSheet(null);
    if (matches) router.back();
  };
  const decide = (approve: boolean, comment: string) => {
    enqueue('gate_pass_action', { gate_pass_id: g.id, action: approve ? 'approve' : 'reject', comment: comment || undefined },
      { entityType: 'gate_pass', entityId: g.id, label: `${g.number} ${approve ? 'approved' : 'rejected'}` });
    haptic(approve ? 'confirm' : 'reject');
    toast.success(t('common.savedOnPhone', { x: `${g.number} · ${approve ? t('status.approved') : t('status.rejected')}` }));
    setSheet(null);
  };
  const openReturn = () => {
    setRet(Object.fromEntries(lines.filter((l) => outstandingReturn(l) > 0).map((l) => [l.id, String(outstandingReturn(l))])));
    setSheet('return');
  };
  const doReturn = () => {
    const out = lines.map((l) => ({ gate_pass_line_id: l.id, qty_returned: num(ret[l.id] ?? '0') }))
      .filter((x) => x.qty_returned > 0);
    const bad = lines.find((l) => num(ret[l.id] ?? '0') > outstandingReturn(l) + 0.0005);
    if (bad) { toast.show({ text: `${bad.description ?? specLabel(bad.material_spec_id)}: more than is out`, tone: 'danger' }); return; }
    if (!out.length) { toast.show({ text: 'Enter the returned quantities', tone: 'warning' }); return; }
    enqueue('return_gate_pass', { id: uuid(), gate_pass_id: g.id, at: new Date().toISOString(), plate_seen: plate.trim() || undefined, lines: out },
      { entityType: 'gate_pass', entityId: g.id, label: `${g.number} returned` });
    haptic('confirm');
    toast.success(t('common.savedOnPhone', { x: `${g.number} · ${t('gate.return')}` }));
    setSheet(null);
  };

  let primary: BarAction | undefined;
  let secondary: BarAction | undefined;
  if (canVerify) {
    primary = plateMatch ? { title: t('gate.verify'), icon: 'check', variant: 'hero', onPress: () => verify(true) }
      : { title: t('gate.mismatch'), icon: 'shield-alert-outline', variant: 'danger', onPress: () => setSheet('mismatch') };
    secondary = plateMatch ? { title: t('gate.mismatch'), variant: 'dangerOutline', onPress: () => setSheet('mismatch') } : undefined;
  } else if (canReturn) {
    primary = { title: t('gate.return'), icon: 'keyboard-return', variant: 'hero', onPress: openReturn };
  } else if (canApprove) {
    primary = { title: t('common.approve'), icon: 'check', onPress: () => setSheet('approve') };
    secondary = { title: t('common.reject'), variant: 'dangerOutline', onPress: () => setSheet('reject') };
  }

  return (
    <Screen footer={primary ? <ActionBar primary={primary} secondary={secondary} /> : undefined}>
      <Stack.Screen options={{ title: g.number }} />
      <SyncError entityId={g.id} />
      {scanned ? <Banner tone="success" icon="shield-check-outline" title="QR code verified" text={scanned === 'online' ? 'Checked with the server.' : 'Checked on this phone (offline).'} /> : null}
      {overdue ? <Banner tone="danger" icon="clock-alert-outline" title={t('gate.overdue')} text={`${t('gate.expectedReturn')} ${fmtDate(g.expected_return)}`} /> : null}
      <Card stripe={overdue ? 'danger' : g.status === 'approved' ? 'info' : null}>
        <Row wrap gap={6}>
          <StatusChip status={g.status} />
          <Chip label={g.pass_type === 'returnable' ? t('gate.returnable') : t('gate.nonReturnable')} tone={g.pass_type === 'returnable' ? 'warning' : 'neutral'} icon={g.pass_type === 'returnable' ? 'swap-horizontal' : 'truck-fast-outline'} />
          <SyncChip entityId={g.id} />
        </Row>
        <InfoRow label={t('gate.destination')} value={g.destination} />
        <InfoRow label={t('gate.purpose')} value={g.purpose} />
        <InfoRow label={t('common.plate')} value={g.vehicle_plate ?? '—'} strong={!!g.vehicle_plate} />
        <InfoRow label={t('common.driver')} value={`${g.driver_name ?? '—'}${g.driver_phone ? ` · ${g.driver_phone}` : ''}`} />
        {g.store_id ? <InfoRow label={t('common.store')} value={storeName(g.store_id)} /> : null}
        {g.expected_return ? <InfoRow label={t('gate.expectedReturn')} value={fmtDate(g.expected_return)} tone={overdue ? 'danger' : undefined} /> : null}
        <InfoRow label="Requested by" value={personName(g.requested_by)} />
        {g.approved_by ? <InfoRow label="Approved by" value={`${personName(g.approved_by)} · ${fmtDateTime(g.approved_at)}`} /> : null}
        {g.decision_comment ? <Text variant="bodySm" tone="muted">{g.decision_comment}</Text> : null}
      </Card>

      {canVerify ? (
        <Card stripe={plateMatch ? 'success' : 'danger'}>
          <Field label={t('gate.plateSeen')} value={plate} onChangeText={(v) => { setPlate(v); setPlateErr(null); }} autoCapitalize="characters"
            placeholder={g.vehicle_plate ?? 'AA-3-12345'} error={plateErr} leadingIcon="car-outline" />
          {plate.trim() && g.vehicle_plate ? (
            plateMatch ? <Chip label={t('gate.plateMatch')} tone="success" icon="check" /> : <Banner tone="danger" icon="alert-octagon-outline" text={t('gate.plateDiff')} />
          ) : null}
          <Text variant="bodySm" tone="muted">Count the load against the list below before allowing exit.</Text>
        </Card>
      ) : null}

      <Section title="Photos">
        <PhotoStrip projectId={g.project_id} entityType="gate_pass" entityId={g.id}
          canAdd={canControl(role, 'gatepass.create') || canControl(role, 'gatepass.verify')} label="Vehicle, load and documents" />
      </Section>
      <Section title={t('gate.lines')}>
        <Card flush={false}>
          {lines.map((l) => (
            <InfoRow key={l.id} label={l.material_spec_id ? specLabel(l.material_spec_id) : l.description ?? '—'}
              value={`${fmtQty(l.qty)} ${l.uom ?? ''}${g.pass_type === 'returnable' && Number(l.qty_returned) > 0 ? ` · back ${fmtQty(l.qty_returned)}` : ''}`} strong />
          ))}
        </Card>
      </Section>

      {events.length ? (
        <Section title="Gate events">
          <Card>
            {events.map((e) => (
              <InfoRow key={e.id} label={`${fmtDateTime(e.at)} · ${personName(e.actor)}`}
                value={e.event === 'exit_verified' ? 'Exit verified' : e.event === 'return_in' ? 'Returned in' : `Mismatch${e.plate_seen ? ` · ${e.plate_seen}` : ''}`}
                tone={e.event === 'exit_mismatch' ? 'danger' : 'success'} />
            ))}
          </Card>
        </Section>
      ) : null}

      {canCancel ? (
        <Button title="Cancel gate pass" variant="ghost" icon="cancel" onPress={() => confirm('Cancel gate pass', `${g.number} will be cancelled.`, () => {
          enqueue('gate_pass_action', { gate_pass_id: g.id, action: 'cancel' }, { entityType: 'gate_pass', entityId: g.id, label: `${g.number} cancelled` });
          toast.success(t('common.savedOnPhone', { x: `${g.number} · ${t('status.cancelled')}` }));
        }, 'Cancel pass', true)} />
      ) : null}

      {sheet === 'mismatch' ? (
        <ReasonSheet visible onClose={() => setSheet(null)} title={t('gate.mismatch')} subtitle="The vehicle stays. Management is alerted immediately."
          reasons={['Plate does not match', 'Extra items on the vehicle', 'Items missing', 'Wrong material', 'Driver not on the pass']}
          confirmLabel={t('gate.mismatch')} variant="danger" onConfirm={(r) => verify(false, r)} />
      ) : null}
      {sheet === 'approve' || sheet === 'reject' ? (
        <ReasonSheet visible onClose={() => setSheet(null)} title={`${sheet === 'approve' ? t('common.approve') : t('common.reject')} ${g.number}`}
          subtitle={sheet === 'approve' ? 'Add a comment if needed.' : 'A reason is required to reject.'}
          reasons={sheet === 'approve' ? [] : ['Not justified', 'No stock to release', 'Wrong destination', 'Missing details']}
          allowEmpty={sheet === 'approve'} confirmLabel={sheet === 'approve' ? t('common.approve') : t('common.reject')} variant={sheet === 'approve' ? 'primary' : 'danger'}
          placeholder={sheet === 'approve' ? 'Comment (optional)' : undefined} onConfirm={(c) => decide(sheet === 'approve', c)} />
      ) : null}
      {sheet === 'return' ? (
        <Sheet visible onClose={() => setSheet(null)} title={t('gate.return')} subtitle={g.number} full
          footer={<Button title={t('gate.return')} icon="check" block onPress={doReturn} />}>
          <View style={styles.sheet}>
            {lines.filter((l) => outstandingReturn(l) > 0).map((l) => (
              <QuantityStepper key={l.id} label={l.material_spec_id ? specLabel(l.material_spec_id) : l.description ?? '—'} unit={l.uom ?? ''}
                value={ret[l.id] ?? ''} onChange={(v) => setRet((s) => ({ ...s, [l.id]: v }))}
                fill={{ label: 'All out', value: outstandingReturn(l) }} max={outstandingReturn(l)} />
            ))}
          </View>
        </Sheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingHorizontal: space[4], gap: space[3], paddingBottom: space[4] },
});
