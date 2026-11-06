// Store keeper: ready-mix trucks accepted on site and awaiting receipt (two-step truck
// receipt). Receiving posts a GRN into the store and an MIV of the same volume to the
// pour's elements (receive_pour_truck), applied to local stock immediately.
import React, { useState } from 'react';
import { Stack, router } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get } from '../../lib/db';
import { jf, rowsWhere } from '../../lib/counts';
import { canField, type MixDesign, type Pour, type PourTruck } from '../../lib/contract-field';
import { WARNING_LABELS, openPourHoldPoints, pourElements } from '../../lib/field';
import { elementLabel, personName, specLabel } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { fmtDateTime, fmtQty } from '../../lib/format';
import { Banner, Button, Card, Chip, EmptyState, InfoRow, PhotoStrip, Row, Screen, StatusChip, Text, haptic, showError, toast } from '../../components/ui';
import { StorePicker } from '../../components/pickers';

export default function ReceiveTrucks() {
  const { profile, project } = useSession();
  const [store, setStore] = useState<Record<string, string | null>>({});
  const rows = useData(() => rowsWhere<PourTruck>('pour_trucks', project.id, `AND ${jf('status')} = 'awaiting_receipt'`, [], `${jf('created_at')} ASC`).map((k) => {
    const p = get<Pour>('pours', k.pour_id);
    const md = p ? get<MixDesign>('mix_designs', p.mix_design_id) : null;
    return { k, p, md, holds: p ? openPourHoldPoints(pourElements(p.id).map((e) => e.element_id)) : [] };
  }), [project.id]);
  const allowed = canField(profile.role, 'pour.receiveTruck');

  const receive = (k: PourTruck, p: Pour) => {
    const storeId = store[k.id] ?? p.store_id;
    if (!storeId) { showError(new Error('Choose the store that receives the concrete')); return; }
    try {
      const grn = nextDocNumber(project.code, 'GRN');
      const miv = nextDocNumber(project.code, 'MIV');
      enqueue('receive_pour_truck', { truck_id: k.id, store_id: storeId, grn_id: uuid(), grn_number: grn, miv_id: uuid(), miv_number: miv },
        { entityType: 'pour_truck', entityId: k.id, label: `Truck ${k.ticket_no} received (${grn})` });
      haptic('confirm');
      toast.success(`${grn} + ${miv} saved on phone · ${fmtQty(k.volume_m3)} m3 to ${p.number}`);
    } catch (err) { showError(err); }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Ready-mix to receive' }} />
      {!allowed ? <Banner tone="info" text="Only the store keeper (or management) receives ready-mix trucks into stock." /> : null}
      {rows.length ? rows.map(({ k, p, md, holds }) => (
        <Card key={k.id} stripe={(k.warnings ?? []).length ? 'warning' : 'info'}>
          <Row justify="space-between">
            <Text variant="titleSm">Ticket {k.ticket_no}</Text>
            <Text variant="title" num>{fmtQty(k.volume_m3)} m3</Text>
          </Row>
          <Row wrap gap={6}>
            <StatusChip status={k.status} />
            {md ? <Chip label={md.grade} icon="flask-outline" /> : null}
            {(k.warnings ?? []).map((w) => <Chip key={w} label={WARNING_LABELS[w]} tone="warning" icon="alert-outline" small />)}
          </Row>
          <InfoRow label="Pour" value={p ? `${p.number} · ${pourElements(p.id).map((e) => elementLabel(e.element_id)).join(', ')}` : '—'} />
          {md?.material_spec_id ? <InfoRow label="Material" value={specLabel(md.material_spec_id)} /> : null}
          <InfoRow label="Recorded" value={`${personName(k.recorded_by)} · ${fmtDateTime(k.arrived_at ?? k.created_at)}`} />
          {k.slump_mm != null ? <InfoRow label="Slump" value={`${k.slump_mm} mm`} /> : null}
          {k.truck_plate ? <InfoRow label="Plate" value={k.truck_plate} /> : null}
          <PhotoStrip projectId={k.project_id} entityType="pour_truck" entityId={k.id} kind="delivery_note" canAdd={allowed} label="Batch ticket" />
          {holds.length ? <Banner tone="danger" icon="hand-back-left-outline" text={`Hold point "${holds[0].activity.name}" on ${elementLabel(holds[0].elementId)} is not cleared; the server will refuse the receipt.`} /> : null}
          {allowed && p ? (
            <>
              <StorePicker projectId={project.id} label="Receiving store" value={store[k.id] ?? p.store_id} onChange={(v) => setStore((s) => ({ ...s, [k.id]: v }))} />
              <Button title="Receive into stock" icon="tray-arrow-down" onPress={() => receive(k, p)} block />
            </>
          ) : null}
          {p ? <Button title="Open pour" size="sm" variant="ghost" icon="open-in-new" onPress={() => router.push(`/pours/${p.id}`)} /> : null}
        </Card>
      )) : <EmptyState icon="dump-truck" tone="success" title="No trucks waiting" body="Trucks accepted by the site engineer show up here to receive." />}
    </Screen>
  );
}
