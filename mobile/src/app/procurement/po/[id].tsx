// Purchase order summary: lines with ordered / received / outstanding (no prices for roles
// without price access), totals incl. VAT and withholding only when prices are visible.
// Management approves / rejects on the go (po_action); store keepers receive against it.
import React, { useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../../lib/app';
import { get, list } from '../../../lib/db';
import { canProcure, type PoEvent, type PoLinePrice, type PurchaseOrder } from '../../../lib/contract-procurement';
import { canSeePrices, outstandingQty, poDelayed, poExpected, poLines, poTotals, receivedPct, storeName, supplierName } from '../../../lib/pc';
import { personName, specLabel, specUom } from '../../../lib/queries';
import { enqueue } from '../../../lib/sync';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty } from '../../../lib/format';
import { t, useLocale } from '../../../lib/i18n';
import {
  ActionBar, Banner, Card, Chip, EmptyState, InfoRow, ProgressBar, ReasonSheet, Row, Screen, Section, StatusChip, SyncChip, SyncError, Text,
  haptic, toast, type BarAction,
} from '../../../components/ui';

export default function PoDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useSession();
  useLocale();
  const po = useData(() => get<PurchaseOrder>('purchase_orders', id), [id]);
  const lines = useData(() => poLines(id), [id]);
  const events = useData(() => list<PoEvent>('po_events', { parent: id }).sort((a, b) => b.created_at.localeCompare(a.created_at)), [id]);
  const prices = canSeePrices(profile.role);
  const totals = useData(() => (prices ? poTotals(id) : null), [id, prices]);
  const [decide, setDecide] = useState<'approve' | 'reject' | null>(null);

  if (!po) return <Screen><Stack.Screen options={{ title: t('act.purchaseOrders') }} /><EmptyState icon="cloud-off-outline" title={t('common.notOnPhone')} /></Screen>;

  const delayed = poDelayed(po);
  const pct = receivedPct(po.id);
  const canApprove = canProcure(profile.role, 'po.approve') && po.status === 'submitted';
  const open = lines.some((l) => outstandingQty(po, l) > 0.0005);
  const canReceive = canProcure(profile.role, 'po.receive') && open;
  const currency = totals?.currency ?? 'ETB';

  const act = (approve: boolean, comment: string) => {
    enqueue('po_action', { po_id: po.id, action: approve ? 'approve' : 'reject', comment: comment || undefined },
      { entityType: 'purchase_order', entityId: po.id, label: `${po.number} ${approve ? 'approved' : 'rejected'}` });
    haptic(approve ? 'confirm' : 'reject');
    toast.success(t('common.savedOnPhone', { x: `${po.number} · ${approve ? t('status.approved') : t('status.rejected')}` }));
    setDecide(null);
  };

  let primary: BarAction | undefined;
  let secondary: BarAction | undefined;
  if (canApprove) {
    primary = { title: t('common.approve'), icon: 'check', onPress: () => setDecide('approve') };
    secondary = { title: t('common.reject'), variant: 'dangerOutline', onPress: () => setDecide('reject') };
  } else if (canReceive) {
    primary = { title: t('home.receive'), icon: 'tray-arrow-down', variant: 'hero', onPress: () => router.push(`/store/receive?po=${po.id}`) };
  }

  return (
    <Screen footer={primary ? <ActionBar primary={primary} secondary={secondary}
      summary={canApprove && totals ? `${fmtMoney(totals.total, currency)} incl. VAT` : undefined} /> : undefined}>
      <Stack.Screen options={{ title: po.number }} />
      <SyncError entityId={po.id} />
      {delayed ? <Banner tone="danger" icon="clock-alert-outline" title={t('status.delayed')} text={`Expected ${fmtDate(poExpected(po))}`} /> : null}
      <Card stripe={delayed ? 'danger' : null}>
        <Row wrap gap={6}>
          <StatusChip status={po.status} />
          {po.delivery_status !== 'pending' ? <Chip label={po.delivery_status === 'delayed' ? t('status.delayed') : po.delivery_status} tone={po.delivery_status === 'delayed' ? 'danger' : 'info'} icon="truck-outline" /> : null}
          {po.revision > 0 ? <Chip label={`Rev ${po.revision}`} tone="neutral" icon="history" /> : null}
          <SyncChip entityId={po.id} />
        </Row>
        <InfoRow label={t('common.supplier')} value={supplierName(po.supplier_id)} strong />
        <InfoRow label="Deliver to" value={storeName(po.delivery_store_id)} />
        <InfoRow label="Order date" value={fmtDate(po.order_date)} />
        <InfoRow label="Expected" value={fmtDate(poExpected(po))} tone={delayed ? 'danger' : undefined} />
        {po.payment_terms ? <InfoRow label="Payment terms" value={po.payment_terms} /> : null}
        <InfoRow label="Created by" value={personName(po.created_by)} />
        {['approved', 'sent', 'partially_received', 'received', 'closed'].includes(po.status) ? <ProgressBar pct={pct} showLabel /> : null}
        {po.remarks ? <Text variant="bodySm" tone="muted">{po.remarks}</Text> : null}
      </Card>

      {totals ? (
        <Section title="Totals">
          <Card>
            <InfoRow label="Subtotal (ex VAT)" value={fmtMoney(totals.subtotal, currency)} />
            <InfoRow label={`VAT ${fmtQty(totals.vat_rate, 2)}%`} value={fmtMoney(totals.vat, currency)} />
            <InfoRow label="Total incl. VAT" value={fmtMoney(totals.total, currency)} strong />
            {Number(totals.withholding) > 0 ? <InfoRow label={`Withholding ${fmtQty(totals.withholding_rate, 2)}%`} value={`− ${fmtMoney(totals.withholding, currency)}`} /> : null}
            <InfoRow label="Net payable" value={fmtMoney(totals.net_payable, currency)} />
          </Card>
        </Section>
      ) : null}

      <Section title={`${t('common.items')} · ${lines.length}`}>
        <Card>
          {lines.map((l) => {
            const out = outstandingQty(po, l);
            const price = prices ? get<PoLinePrice>('po_line_prices', l.id) : null;
            const uom = l.uom ?? specUom(l.material_spec_id);
            return (
              <InfoRow key={l.id} label={`${specLabel(l.material_spec_id)}${price ? ` · ${fmtMoney(price.unit_price, price.currency)}/${uom}` : ''}`}
                value={`${fmtQty(l.qty_accepted)} / ${fmtQty(l.qty)} ${uom}${out > 0 ? ` · ${fmtQty(out)} due` : ''}`}
                tone={l.closed ? 'muted' : out > 0 ? undefined : 'success'} />
            );
          })}
        </Card>
      </Section>

      {events.length ? (
        <Section title="History">
          <Card>
            {events.slice(0, 8).map((e) => (
              <InfoRow key={e.id} label={`${fmtDateTime(e.created_at)} · ${personName(e.actor)}`} value={e.to_status ? t(`status.${e.to_status}` as 'status.draft') : e.action} />
            ))}
          </Card>
        </Section>
      ) : null}

      {decide ? (
        <ReasonSheet visible onClose={() => setDecide(null)} title={`${decide === 'approve' ? t('common.approve') : t('common.reject')} ${po.number}`}
          subtitle={decide === 'approve' ? (totals ? `${fmtMoney(totals.total, currency)} incl. VAT. Approval limits are checked on sync.` : 'Approval limits are checked on sync.') : 'A reason is required to reject.'}
          reasons={decide === 'approve' ? [] : ['Price too high', 'Get more quotations', 'Wrong supplier', 'Not needed now', 'Budget exceeded']}
          allowEmpty={decide === 'approve'} confirmLabel={decide === 'approve' ? t('common.approve') : t('common.reject')} variant={decide === 'approve' ? 'primary' : 'danger'}
          placeholder={decide === 'approve' ? 'Comment (optional)' : undefined} onConfirm={(c) => act(decide === 'approve', c)} />
      ) : null}
    </Screen>
  );
}
