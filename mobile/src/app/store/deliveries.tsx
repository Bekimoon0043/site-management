// Store keeper: delivery notices from procurement (Flow A). Accept the notice (space / labour ready)
// or ask for another date, then receive it with a GRN prefilled from the PO lines (delivery_notice_id).
import React, { useState } from 'react';
import { Stack, router, type Href } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get } from '../../lib/db';
import { canFlow, type DeliveryNotice } from '../../lib/contract-flows';
import type { PurchaseOrder } from '../../lib/contract-procurement';
import { jf, rowsWhere, syncStatusMap } from '../../lib/counts';
import { noticeLabel } from '../../lib/flows';
import { ft } from '../../lib/flows-i18n';
import { specLabel, specUom } from '../../lib/queries';
import { storeName, supplierName } from '../../lib/pc';
import { enqueue } from '../../lib/sync';
import { addDays, fmtDate, fmtQty, today } from '../../lib/format';
import { useLocale } from '../../lib/i18n';
import {
  Button, Card, Chip, EmptyState, InfoRow, ReasonSheet, Row, Screen, Section, Sheet, StatusChip, SyncDot, Text, haptic, toast,
} from '../../components/ui';
import { DateField } from '../../components/pickers';
import { StyleSheet, View } from 'react-native';
import { space } from '../../theme';

const OPEN = ['notified', 'acknowledged', 'reschedule_requested', 'arrived'];

export default function DeliveryNotices() {
  useLocale();
  const { project, profile } = useSession();
  const [resched, setResched] = useState<DeliveryNotice | null>(null);
  const canAck = canFlow(profile.role, 'delivery.acknowledge');
  const d = useData(() => {
    const sync = syncStatusMap();
    const all = rowsWhere<DeliveryNotice>('delivery_notices', project.id, '', [], `${jf('expected_date')} ASC`);
    const rows = all.map((n) => ({ n, po: get<PurchaseOrder>('purchase_orders', n.po_id), sync: sync.get(n.id) ?? null }));
    return { open: rows.filter((r) => OPEN.includes(r.n.status)), done: rows.filter((r) => !OPEN.includes(r.n.status)).reverse().slice(0, 20) };
  }, [project.id]);

  const accept = (n: DeliveryNotice, po: string) => {
    enqueue('acknowledge_delivery_notice', { id: n.id, decision: 'accept' }, { entityType: 'delivery_notice', entityId: n.id, label: `Delivery ${po} accepted` });
    haptic('confirm');
    toast.success(ft('flow.noticeAccepted', { po }));
  };

  const card = ({ n, po, sync }: (typeof d.open)[number]) => {
    const t0 = today();
    const late = n.expected_date < t0 && OPEN.includes(n.status);
    const poNo = po?.number ?? 'PO';
    return (
      <Card key={n.id} stripe={late ? 'danger' : n.status === 'notified' ? 'warning' : 'info'}>
        <Row justify="space-between">
          <Row gap={6} style={styles.shrink}><Text variant="titleSm" numberOfLines={1}>{poNo}</Text><SyncDot status={sync} /></Row>
          <StatusChip status={n.status} label={noticeLabel(n.status)} />
        </Row>
        <Text variant="bodySm" tone="muted">
          {supplierName(po?.supplier_id)} · {storeName(n.store_id)}
        </Text>
        <Row wrap gap={6}>
          <Chip label={ft('flow.expectedOn', { d: fmtDate(n.expected_date) })} tone={late ? 'danger' : n.expected_date <= addDays(t0, 1) ? 'warning' : 'neutral'} icon="calendar-outline" />
          {n.expected_window ? <Chip label={n.expected_window} tone="neutral" icon="clock-outline" /> : null}
          {n.vehicle_plate ? <Chip label={n.vehicle_plate} tone="neutral" icon="truck-outline" /> : null}
        </Row>
        {(n.lines ?? []).slice(0, 4).map((l) => <InfoRow key={l.po_line_id} label={specLabel(l.material_spec_id)} value={`${fmtQty(l.qty)} ${specUom(l.material_spec_id)}`} />)}
        {(n.lines ?? []).length > 4 ? <Text variant="caption" tone="muted">{ft('flow.items', { n: n.lines.length })}</Text> : null}
        {n.driver_name || n.driver_phone ? <Text variant="bodySm" tone="muted">{[n.driver_name, n.driver_phone].filter(Boolean).join(' · ')}</Text> : null}
        {n.note ? <Text variant="bodySm">{n.note}</Text> : null}
        {n.proposed_date ? <Text variant="bodySm" tone="warning">{ft('flow.proposedDate')}: {fmtDate(n.proposed_date)}</Text> : null}
        {canAck && OPEN.includes(n.status) ? (
          <View style={styles.actions}>
            {n.status === 'notified' || n.status === 'reschedule_requested' ? (
              <Row>
                <Button title={ft('flow.reschedule')} variant="outline" size="md" flex onPress={() => setResched(n)} />
                <Button title={ft('flow.acceptDelivery')} size="md" flex icon="check" onPress={() => accept(n, poNo)} />
              </Row>
            ) : null}
            <Button title={ft('flow.receiveGrn')} variant={n.status === 'notified' ? 'tonal' : 'hero'} icon="tray-arrow-down" block
              onPress={() => router.push(`/store/receive?notice=${n.id}` as Href)} />
          </View>
        ) : null}
      </Card>
    );
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: ft('flow.deliveries') }} />
      <Text variant="bodySm" tone="muted">{ft('flow.deliveriesBody')}</Text>
      {d.open.length ? d.open.map(card) : <EmptyState icon="truck-delivery-outline" title={ft('flow.noNotices')} body={ft('flow.noNoticesBody')} compact />}
      {d.done.length ? <Section title={`${ft('flow.notice.received')} · ${d.done.length}`}>{d.done.map(card)}</Section> : null}
      {resched ? <RescheduleSheet n={resched} onClose={() => setResched(null)} /> : null}
    </Screen>
  );
}

function RescheduleSheet({ n, onClose }: { n: DeliveryNotice; onClose: () => void }) {
  const [date, setDate] = useState<string | null>(addDays(n.expected_date > today() ? n.expected_date : today(), 1));
  const [why, setWhy] = useState(false);
  const po = get<PurchaseOrder>('purchase_orders', n.po_id)?.number ?? 'PO';
  return (
    <>
      <Sheet visible={!why} onClose={onClose} title={ft('flow.reschedule')} subtitle={po}
        footer={<><Button title="Cancel" variant="ghost" onPress={onClose} /><Button title={ft('flow.reschedule')} flex onPress={() => setWhy(true)} disabled={!date} /></>}>
        <View style={styles.sheet}>
          <DateField label={ft('flow.proposedDate')} value={date} onChange={setDate} minimumDate={new Date()} quick />
        </View>
      </Sheet>
      {why ? (
        <ReasonSheet visible onClose={onClose} title={ft('flow.reschedule')} subtitle={`${po} · ${fmtDate(date)}`} allowEmpty
          reasons={[ft('flow.reason.noSpace'), ft('flow.reason.noLabour'), ft('flow.reason.storeClosed'), ft('flow.reason.noCrane')]}
          confirmLabel={ft('flow.reschedule')}
          onConfirm={(note) => {
            enqueue('acknowledge_delivery_notice', { id: n.id, decision: 'reschedule', proposed_date: date!, note: note || undefined },
              { entityType: 'delivery_notice', entityId: n.id, label: `Delivery ${po} reschedule` });
            haptic('confirm');
            toast.success(ft('flow.rescheduleAsked', { po }));
            onClose();
          }} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  actions: { gap: space[2] },
  sheet: { paddingHorizontal: space[4], paddingBottom: space[6], gap: space[4] },
});
