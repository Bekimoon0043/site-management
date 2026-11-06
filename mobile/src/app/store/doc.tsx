// Store document detail: lines, sync status, print, reverse (BR-07), acknowledge / confirm.
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get, list } from '../../lib/db';
import {
  can, type Adjustment, type AdjustmentLine, type Grn, type GrnLine, type MaterialRequest, type Miv, type MivLine,
  type Mrn, type MrnLine, type StockCount, type StockCountLine, type Store,
} from '../../lib/contract';
import { elementLabel, personName, specLabel, specUom } from '../../lib/queries';
import { enqueue } from '../../lib/sync';
import { fmtDateTime, fmtQty, titleCase } from '../../lib/format';
import { printGrn, printMiv } from '../../lib/print';
import { DOC_TABLE, type StoreDocType as DocType } from '../../lib/docs';
import { sentence, space, type Tone } from '../../theme';
import {
  ActionBar, Banner, Card, Chip, EmptyState, InfoRow, ListRow, PhotoStrip, ReasonSheet, Row, Screen, Section, SignatureField,
  StatusChip, SyncChip, SyncError, Text, confirm, haptic, toast, type BarAction,
} from '../../components/ui';
import { DOC_ICON } from '../../components/AppChrome';

const TITLES: Record<string, string> = { grn: 'Goods receipt', miv: 'Material issue', mrn: 'Material return', adjustment: 'Stock adjustment', count: 'Stock count', transfer: 'Transfer' };

export default function DocDetail() {
  const { type, id } = useLocalSearchParams<{ type: DocType; id: string }>();
  const { profile, project } = useSession();
  const [reverse, setReverse] = useState(false);
  const [sig, setSig] = useState<string | null>(null);

  const doc = useData(() => get<Record<string, unknown> & { id: string; number: string; status: string; project_id: string; store_id: string }>(DOC_TABLE[type], id), [type, id]);
  const lines = useData(() => {
    type L = { id: string; title: string; rows: [string, string][]; flag: string | null; flagTone?: Tone; note: string | null };
    switch (type) {
      case 'grn': return list<GrnLine>('grn_lines', { parent: id }).sort((a, b) => a.line_no - b.line_no).map<L>((l) => ({
        id: l.id, title: specLabel(l.material_spec_id), rows: [
          ['Delivered', `${fmtQty(l.qty_delivered)} ${specUom(l.material_spec_id)}`], ['Accepted', fmtQty(l.qty_accepted)], ['Rejected', fmtQty(l.qty_rejected)],
          ['Inspection', titleCase(l.inspection_result)], ...(l.batch_no ? [['Batch', l.batch_no] as [string, string]] : []),
        ], flag: l.variance_flag, flagTone: l.variance_flag === 'wrong_grade' ? 'danger' : 'warning', note: l.inspection_notes,
      }));
      case 'miv': return list<MivLine>('miv_lines', { parent: id }).sort((a, b) => a.line_no - b.line_no).map<L>((l) => ({
        id: l.id, title: specLabel(l.material_spec_id), rows: [
          ['Quantity', `${fmtQty(l.qty)} ${specUom(l.material_spec_id)}`], ['Element', elementLabel(l.element_id)],
        ], flag: l.substitution_reason ? 'substitution' : null, note: l.substitution_reason,
      }));
      case 'mrn': return list<MrnLine>('mrn_lines', { parent: id }).map<L>((l) => ({
        id: l.id, title: specLabel(l.material_spec_id), rows: [
          ['Quantity', `${fmtQty(l.qty)} ${specUom(l.material_spec_id)}`], ['Element', elementLabel(l.element_id)], ['Condition', titleCase(l.condition)],
        ], flag: l.condition === 'damaged' ? 'damaged' : null, note: null,
      }));
      case 'adjustment': return list<AdjustmentLine>('adjustment_lines', { parent: id }).map<L>((l) => ({
        id: l.id, title: specLabel(l.material_spec_id), rows: [
          ['Change', `${fmtQty(l.qty_delta)} ${specUom(l.material_spec_id)}`], ['From', titleCase(l.stock_status)],
          ...(l.element_id ? [['Element', elementLabel(l.element_id)] as [string, string]] : []),
        ], flag: null, note: null,
      }));
      case 'count': return list<StockCountLine>('stock_count_lines', { parent: id }).map<L>((l) => ({
        id: l.id, title: specLabel(l.material_spec_id), rows: [
          ['System', fmtQty(l.system_qty)], ['Counted', fmtQty(l.counted_qty)], ['Variance', `${Number(l.variance) > 0 ? '+' : ''}${fmtQty(l.variance)}`],
        ], flag: Number(l.variance) !== 0 ? 'variance' : null, flagTone: 'danger', note: null,
      }));
      default: return [] as L[];
    }
  }, [type, id]);

  if (!doc) {
    return <Screen><Stack.Screen options={{ title: 'Document' }} /><EmptyState icon="cloud-off-outline" title="Not on this phone yet" body="Sync and try again." /></Screen>;
  }

  const reversible = (type === 'grn' || type === 'miv' || type === 'mrn') && doc.status !== 'reversed' && can(profile.role, 'reverse');
  const miv = type === 'miv' ? (doc as unknown as Miv) : null;
  const grn = type === 'grn' ? (doc as unknown as Grn) : null;
  const adj = type === 'adjustment' ? (doc as unknown as Adjustment) : null;
  const cnt = type === 'count' ? (doc as unknown as StockCount) : null;
  const mrn = type === 'mrn' ? (doc as unknown as Mrn) : null;
  const canAck = !!miv && miv.status === 'pending_ack' && (miv.issued_to === profile.id || can(profile.role, 'mr.approve'));
  const canConfirm = !!grn && !grn.confirmed_by && grn.status === 'posted' && can(profile.role, 'grn.confirm');

  let bar: { primary: BarAction; summary?: string } | null = null;
  if (canAck) {
    bar = {
      summary: 'Sign to confirm you received these materials',
      primary: { title: 'I received these', icon: 'check', onPress: () => {
        enqueue('acknowledge_miv', { miv_id: miv!.id, signature: sig ?? undefined }, { entityType: 'miv', entityId: miv!.id, label: `${miv!.number} acknowledged` });
        haptic('confirm'); toast.success(`${miv!.number} acknowledged`);
      } },
    };
  } else if (canConfirm) {
    bar = { primary: { title: 'Confirm delivery received', icon: 'check', onPress: () => {
      enqueue('confirm_grn', { grn_id: grn!.id }, { entityType: 'grn', entityId: grn!.id, label: `${grn!.number} confirmed` });
      haptic('confirm'); toast.success(`${grn!.number} confirmed`);
    } } };
  }

  return (
    <Screen footer={bar ? <ActionBar {...bar} /> : undefined}>
      <Stack.Screen options={{ title: doc.number }} />
      <SyncError entityId={id} />
      <Card>
        <Row gap={space[3]}>
          <View style={styles.flex}>
            <Text variant="titleSm">{TITLES[type] ?? titleCase(type)}</Text>
            <Text variant="bodySm" tone="muted">{get<Store>('stores', doc.store_id)?.name ?? '—'}</Text>
          </View>
        </Row>
        <Row wrap gap={6}>
          <StatusChip status={doc.status} />
          <SyncChip entityId={id} showSynced />
          {miv?.is_emergency ? <Chip label={miv.mr_id ? 'Emergency · regularised' : 'Emergency · regularise within 24 h'} tone={miv.mr_id ? 'info' : 'danger'} icon="fire" /> : null}
        </Row>
        {grn ? <>
          <InfoRow label="Supplier" value={grn.supplier_name ?? '—'} />
          <InfoRow label="Delivery note" value={grn.delivery_note_no ?? '—'} />
          <InfoRow label="Vehicle / driver" value={`${grn.vehicle_plate ?? '—'} / ${grn.driver_name ?? '—'}`} />
          <InfoRow label="Received" value={fmtDateTime(grn.received_at)} />
          <InfoRow label="Engineer confirmation" value={grn.confirmed_by ? personName(grn.confirmed_by) : 'Not yet'} tone={grn.confirmed_by ? 'success' : 'muted'} />
        </> : null}
        {miv ? <>
          <InfoRow label="Request" value={miv.mr_id ? get<MaterialRequest>('material_requests', miv.mr_id)?.number ?? '—' : 'None (emergency)'} />
          <InfoRow label="Issued to" value={personName(miv.issued_to)} />
          <InfoRow label="Issued by" value={personName(miv.issued_by)} />
          <InfoRow label="Issued at" value={fmtDateTime(miv.issued_at)} />
          {miv.emergency_reason ? <Text variant="bodySm">Reason: {miv.emergency_reason}</Text> : null}
        </> : null}
        {mrn ? <><InfoRow label="Returned by" value={personName(mrn.returned_by)} /><InfoRow label="Received by" value={personName(mrn.received_by)} /><InfoRow label="Date" value={fmtDateTime(mrn.returned_at)} /></> : null}
        {adj ? <><InfoRow label="Type" value={titleCase(adj.adj_type)} /><InfoRow label="Reason" value={adj.reason_code ?? '—'} /><InfoRow label="Requested by" value={personName(adj.requested_by)} />{adj.remarks ? <Text variant="bodySm">{adj.remarks}</Text> : null}</> : null}
        {cnt ? <><InfoRow label="Type" value={titleCase(cnt.count_type)} /><InfoRow label="Counted by" value={personName(cnt.counted_by)} /><InfoRow label="Counted at" value={fmtDateTime(cnt.counted_at)} /></> : null}
      </Card>
      {typeof doc.reversal_reason === 'string' ? <Banner tone="danger" title="Reversed" text={doc.reversal_reason} /> : null}

      <Section title="Lines">
        {lines.map((l) => (
          <Card key={l.id} dense stripe={l.flag ? l.flagTone ?? 'warning' : null}>
            <Row justify="space-between">
              <Text variant="label" style={styles.flex}>{l.title}</Text>
              {l.flag ? <Chip label={sentence(l.flag)} tone={l.flagTone ?? 'warning'} icon="alert-outline" small /> : null}
            </Row>
            {l.rows.map(([k, v]) => <InfoRow key={k} label={k} value={v} />)}
            {l.note ? <Text variant="bodySm" tone="muted">{l.note}</Text> : null}
          </Card>
        ))}
      </Section>

      <PhotoStrip projectId={doc.project_id} entityType={type} entityId={id} canAdd={type !== 'count'} label="Photos" />
      {canAck ? <SignatureField label="Your signature" optional value={sig} onChange={setSig} /> : null}

      <Section title="Actions">
        <Card flush>
          {grn ? <ListRow id="pdf" title="Share GRN as PDF" icon="file-pdf-box" chevron onPress={() => void printGrn(id)} /> : null}
          {miv ? <ListRow id="pdf" title="Share MIV as PDF" icon="file-pdf-box" chevron onPress={() => void printMiv(id)} /> : null}
          {miv && miv.is_emergency && !miv.mr_id && can(profile.role, 'miv.post') ? (
            <ListRow id="reg" title="Regularise against a request" icon="link-variant" chevron onPress={() => router.push(`/approvals?regularise=${miv.id}`)} />
          ) : null}
          {reversible ? <ListRow id="rev" title="Post reversal" subtitle="Posted records cannot be edited; a reversal corrects mistakes" icon="swap-horizontal" iconTone="danger" onPress={() => setReverse(true)} /> : null}
          {!grn && !miv && !reversible ? <ListRow id="none" title="No actions for this document" icon={DOC_ICON[type] ?? 'file-document-outline'} iconTone="neutral" /> : null}
        </Card>
      </Section>
      <Text variant="caption" tone="muted">{project.code}</Text>

      {reverse ? (
        <ReasonSheet visible onClose={() => setReverse(false)} title={`Reverse ${doc.number}`}
          subtitle="A reversing stock entry will be posted. The original record stays in the audit trail."
          reasons={['Entered twice', 'Wrong quantity', 'Wrong material', 'Wrong store']} confirmLabel="Post reversal" variant="danger"
          onConfirm={(r) => confirm('Reverse document', 'Post the reversal now?', () => {
            enqueue('reverse_document', { doc_type: type as 'grn' | 'miv' | 'mrn', doc_id: id, reason: r },
              { entityType: type, entityId: id, label: `${doc.number} reversed` });
            setReverse(false); haptic('confirm'); toast.success(`${doc.number} reversal saved on phone`);
          }, 'Reverse', true)} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
