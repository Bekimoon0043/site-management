// Goods receipt with inspection (SRS 4.5; spec §5.2). Target < 2 min (NFR-06).
// Step A: "What's arriving?" — expected approved requests or an ad-hoc delivery.
// Step B: one-screen receipt. Default path is "everything arrived OK"; only exceptions need taps.
// Receive against a purchase order: pick the PO -> lines prefilled with the outstanding quantity;
// post_grn carries po_id / po_line_id (no prices are shown here).
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useDataVersion, useSession } from '../../lib/app';
import type { InspectionResult } from '../../lib/contract';
import { get } from '../../lib/db';
import { mrLines, personName, specLabel, specMap, specUom, stores } from '../../lib/queries';
import { mrField, mrRows, mrStatusIn, receivedForLine } from '../../lib/counts';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { capturePhoto } from '../../lib/photos';
import { fmtDate, fmtQty, num, today } from '../../lib/format';
import { printGrn } from '../../lib/print';
import type { PurchaseOrder } from '../../lib/contract-procurement';
import { expectedDeliveries, outstandingQty, poLines } from '../../lib/pc';
import { t, useLocale } from '../../lib/i18n';
import type { DeliveryNotice } from '../../lib/contract-flows';
import { jf, rowsWhere } from '../../lib/counts';
import { noticeLabel } from '../../lib/flows';
import { ft } from '../../lib/flows-i18n';
import { space } from '../../theme';
import {
  ActionBar, Banner, Button, Card, Chip, ChipGroup, EmptyState, Field, ListRow, PhotoStrip, QuantityStepper, Row, Screen, SearchInput,
  Section, Segmented, SignatureField, SuccessView, Text, recentIds, showError, useForm, usePhotoCount, useUnsavedGuard, normalize, type Errors,
} from '../../components/ui';
import { SpecPicker, StorePicker, SupplierPicker } from '../../components/pickers';

type Outcome = 'ok' | 'short' | 'damaged' | 'reject';
interface Line {
  id: string; specId: string | null; mrLineId: string | null; poLineId: string | null; requestedSpec: string | null; ordered: number | null; outstanding: number | null;
  outcome: Outcome; delivered: string; rejected: string; batch: string; inspection: InspectionResult; notes: string; details: boolean;
}
const blank = (): Line => ({
  id: uuid(), specId: null, mrLineId: null, poLineId: null, requestedSpec: null, ordered: null, outstanding: null, outcome: 'ok',
  delivered: '', rejected: '', batch: '', inspection: 'pass', notes: '', details: false,
});

// ---------------------------------------------------------------------------
// Step A
// ---------------------------------------------------------------------------

type Tn = 'danger' | 'neutral' | 'info' | 'warning';
type ArrivingItem =
  | { type: 'header'; title: string }
  | { type: 'po' | 'mr' | 'notice'; id: string; number: string; sub: string; chip: { label: string; tone: Tn; icon: 'clock-alert-outline' | 'calendar-outline' | 'truck-fast-outline' | 'clock-outline' }; key: string };

function Arriving({ projectId, onPick, onPickPo, onPickNotice }: { projectId: string; onPick: (mrId: string | null) => void; onPickPo: (poId: string) => void; onPickNotice: (id: string) => void }) {
  const [q, setQ] = useState('');
  const v = useDataVersion();
  useLocale();
  const pos = useData(() => {
    const announced = new Set(rowsWhere<DeliveryNotice>('delivery_notices', projectId,
      `AND ${jf('status')} IN ('notified','acknowledged','reschedule_requested','arrived')`).map((n) => n.po_id));
    return expectedDeliveries(projectId, v).filter((e) => !announced.has(e.id)).map((e) => ({
      type: 'po' as const, id: e.id, number: e.number, sub: `${e.supplier} · ${e.outstandingLines} line(s) due · ${e.summary}`,
      chip: e.delayed ? { label: t('status.delayed'), tone: 'danger' as Tn, icon: 'clock-alert-outline' as const }
        : { label: e.expected ? fmtDate(e.expected) : 'PO', tone: (e.deliveryStatus === 'dispatched' ? 'info' : 'neutral') as Tn, icon: e.deliveryStatus === 'dispatched' ? 'truck-fast-outline' as const : 'calendar-outline' as const },
      key: normalize(`${e.number} ${e.supplier} ${e.summary}`),
    }));
  }, [projectId]);
  // Delivery notices from procurement (Flow A): receive against the notice → GRN closes it.
  const notices = useData(() => rowsWhere<DeliveryNotice>('delivery_notices', projectId,
    `AND ${jf('status')} IN ('notified','acknowledged','reschedule_requested','arrived')`, [], `${jf('expected_date')} ASC`).map((n) => {
    const po = get<PurchaseOrder>('purchase_orders', n.po_id);
    const late = n.expected_date < today();
    return {
      type: 'notice' as const, id: n.id, number: po?.number ?? 'PO',
      sub: `${noticeLabel(n.status)} · ${ft('flow.items', { n: (n.lines ?? []).length })}${n.vehicle_plate ? ` · ${n.vehicle_plate}` : ''}`,
      chip: late ? { label: t('status.delayed'), tone: 'danger' as Tn, icon: 'clock-alert-outline' as const }
        : { label: fmtDate(n.expected_date), tone: (n.status === 'notified' ? 'warning' : 'info') as Tn, icon: 'truck-fast-outline' as const },
      key: normalize(`${po?.number ?? ''} ${n.vehicle_plate ?? ''}`),
    };
  }), [projectId]);
  const rows = useData(() => {
    const sm = specMap(v);
    const t0 = today();
    return mrRows(projectId, mrStatusIn(['approved', 'partially_issued']), [], `${mrField('required_date')} ASC`).map((r) => ({
      id: r.id, number: r.number, status: r.status,
      sub: `${personName(r.requested_by)} · ${r.lineCount} item${r.lineCount === 1 ? '' : 's'} · ${r.specIds.map((s) => sm.get(s)?.label ?? '').slice(0, 2).join(', ')}`,
      chip: r.required_date <= t0 ? { label: r.required_date === t0 ? 'Needed today' : `Due ${fmtDate(r.required_date)}`, tone: 'warning' as const, icon: 'clock-outline' as const }
        : { label: `Needed ${fmtDate(r.required_date)}`, tone: 'neutral' as const, icon: 'calendar-outline' as const },
      key: normalize(`${r.number} ${r.specIds.map((s) => sm.get(s)?.label ?? '').join(' ')}`),
    }));
  }, [projectId]);
  const nq = normalize(q);
  const shownMr = nq ? rows.filter((r) => r.key.includes(nq)) : rows;
  const shownPo = nq ? pos.filter((r) => r.key.includes(nq)) : pos;
  const shownNotices = nq ? notices.filter((r) => r.key.includes(nq)) : notices;
  const shown: ArrivingItem[] = [
    ...(shownNotices.length ? [{ type: 'header' as const, title: ft('flow.deliveries') }, ...shownNotices] : []),
    ...(shownPo.length ? [{ type: 'header' as const, title: t('grn.expectedPo') }, ...shownPo] : []),
    ...(shownMr.length ? [{ type: 'header' as const, title: t('grn.expectedMr') }, ...shownMr.map((r) => ({ ...r, type: 'mr' as const }))] : []),
  ];
  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: t('grn.title') }} />
      <FlashList
        data={shown}
        keyExtractor={(r, i) => (r.type === 'header' ? `h${i}` : r.id)}
        getItemType={(r) => r.type}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.headA}>
            <SearchInput value={q} onChangeText={setQ} onClear={() => setQ('')} placeholder={t('grn.searchArriving')} />
            <Button title={t('grn.adhoc')} variant="outline" icon="plus" block onPress={() => onPick(null)} />
          </View>
        }
        renderItem={({ item: r }) => r.type === 'header'
          ? <View style={styles.hdr}><Text variant="label" tone="muted">{r.title}</Text></View>
          : r.type === 'notice'
            ? <ListRow id={r.id} title={r.number} subtitle={r.sub} chip={r.chip} icon="truck-delivery-outline" stripe={r.chip.tone === 'danger' ? 'danger' : 'warning'} chevron onPress={onPickNotice} />
          : r.type === 'po'
            ? <ListRow id={r.id} title={r.number} subtitle={r.sub} chip={r.chip} icon="cart-outline" stripe={r.chip.tone === 'danger' ? 'danger' : null} chevron onPress={onPickPo} />
            : <ListRow id={r.id} title={r.number} subtitle={r.sub} chip={r.chip} icon="truck-delivery-outline" chevron onPress={onPick} />}
        ListEmptyComponent={<EmptyState icon="truck-delivery-outline" title={q ? `No match for “${q}”` : t('grn.noneWaiting')}
          body={q ? undefined : t('grn.noneWaitingBody')} compact />}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Step B
// ---------------------------------------------------------------------------

export default function Receive() {
  const { project } = useSession();
  useLocale();
  const params = useLocalSearchParams<{ po?: string; notice?: string }>();
  const [noticeId, setNoticeId] = useState<string | null>(null);
  const [step, setStep] = useState<'pick' | 'form' | 'done'>('pick');
  const [id, setId] = useState(uuid);
  const [mrId, setMrId] = useState<string | null>(null);
  const [poId, setPoId] = useState<string | null>(null);
  const [storeId, setStoreId] = useState<string | null>(() => stores(project.id)[0]?.id ?? null);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [dn, setDn] = useState('');
  const [plate, setPlate] = useState('');
  const [driver, setDriver] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [sig, setSig] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [posted, setPosted] = useState<string | null>(null);
  const form = useForm();
  const photos = usePhotoCount(id);

  const dirty = step === 'form' && (lines.some((l) => l.specId) || !!dn || !!plate);
  const disable = useUnsavedGuard(dirty, { what: 'goods receipt' });

  const start = (mid: string | null) => {
    setMrId(mid);
    const recent = recentIds('supplier')[0] ?? null;
    if (recent && get('suppliers', recent)) setSupplierId(recent);
    if (mid) {
      const ls = mrLines(mid).filter((l) => !l.deleted_at && Number(l.approved_qty ?? 0) > 0).map((l) => {
        const outstanding = Math.max(Number(l.approved_qty) - receivedForLine(project.id, l.id), 0);
        // Default = everything outstanding arrived OK; fully received lines start empty.
        return { ...blank(), specId: l.material_spec_id, requestedSpec: l.material_spec_id, mrLineId: l.id, ordered: Number(l.approved_qty), outstanding,
          outcome: (outstanding > 0 ? 'ok' : 'short') as Outcome, delivered: outstanding > 0 ? String(Math.round(outstanding * 1000) / 1000) : '' };
      });
      setLines(ls.length ? ls : [blank()]);
    } else {
      setLines([blank()]);
    }
    setStep('form');
  };

  /** Receive against a PO: supplier + store from the PO, one line per outstanding PO line. */
  const startPo = (pid: string) => {
    const po = get<PurchaseOrder>('purchase_orders', pid);
    if (!po) return;
    setPoId(pid); setMrId(null);
    setSupplierId(po.supplier_id);
    if (po.delivery_store_id) setStoreId(po.delivery_store_id);
    const ls = poLines(pid).map((pl) => ({ pl, out: outstandingQty(po, pl) })).filter((x) => x.out > 0.0005).map(({ pl, out }) => ({
      ...blank(), specId: pl.material_spec_id, requestedSpec: pl.material_spec_id, mrLineId: pl.mr_line_id, poLineId: pl.id,
      ordered: Number(pl.qty), outstanding: out, outcome: 'ok' as Outcome, delivered: String(Math.round(out * 1000) / 1000),
    }));
    setLines(ls.length ? ls : [blank()]);
    setStep('form');
  };
  /** Receive against a delivery notice: the PO's lines, quantities from the notice, vehicle from the notice. */
  const startNotice = (nid: string) => {
    const n = get<DeliveryNotice>('delivery_notices', nid);
    if (!n) return;
    startPo(n.po_id);
    setNoticeId(nid);
    if (n.store_id) setStoreId(n.store_id);
    if (n.vehicle_plate) setPlate(n.vehicle_plate);
    if (n.driver_name) setDriver(n.driver_name);
    const want = new Map((n.lines ?? []).map((l) => [l.po_line_id, Number(l.qty)]));
    if (want.size) {
      setLines((ls) => ls.filter((l) => !l.poLineId || want.has(l.poLineId)).map((l) => {
        const q = l.poLineId ? want.get(l.poLineId) : undefined;
        return q != null && l.outstanding != null ? { ...l, delivered: String(Math.round(Math.min(q, l.outstanding) * 1000) / 1000) } : l;
      }));
    }
  };
  useEffect(() => {
    if (params.notice && step === 'pick') startNotice(params.notice);
    else if (params.po && step === 'pick') startPo(params.po);
  }, [params.po, params.notice]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const setOutcome = (i: number, o: Outcome) => {
    const l = lines[i];
    const full = String(l.outstanding ?? l.ordered ?? (num(l.delivered) || ''));
    if (o === 'ok') setLine(i, { outcome: o, inspection: 'pass', rejected: '', delivered: l.ordered != null ? full : l.delivered });
    if (o === 'short') setLine(i, { outcome: o, inspection: 'pass', rejected: '' });
    if (o === 'damaged') setLine(i, { outcome: o, inspection: 'conditional', details: true });
    if (o === 'reject') setLine(i, { outcome: o, inspection: 'reject', details: true });
  };

  const post = () => {
    const e: Errors = {};
    if (!storeId) e.store = 'Select the receiving store';
    if (!supplierId && !supplierName.trim()) e.supplier = 'Select or type the supplier';
    lines.forEach((l, i) => {
      const del = num(l.delivered);
      const rej = l.inspection === 'reject' ? del : num(l.rejected || '0');
      if (l.specId && del > 0 && (!(rej >= 0) || rej > del)) e[`line${i}`] = 'Rejected quantity cannot exceed delivered quantity';
      if (!l.specId && lines.length === 1) e[`line${i}`] = 'Select the material';
    });
    const payloadLines = lines.filter((l) => l.specId && num(l.delivered) > 0);
    if (!payloadLines.length && !Object.keys(e).some((k) => k.startsWith('line'))) e.line0 = 'Enter at least one delivered quantity';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      const out = payloadLines.map((l) => {
        const del = num(l.delivered);
        const rej = l.inspection === 'reject' ? del : num(l.rejected || '0');
        return {
          id: l.id, material_spec_id: l.specId!, mr_line_id: l.mrLineId ?? undefined, po_line_id: l.poLineId ?? undefined,
          ordered_qty: l.poLineId ? l.outstanding ?? undefined : l.ordered ?? undefined,
          qty_delivered: del, qty_rejected: rej, qty_accepted: del - rej, batch_no: l.batch.trim() || undefined,
          inspection_result: l.inspection, inspection_notes: l.notes.trim() || undefined,
        };
      });
      const number = nextDocNumber(project.code, 'GRN');
      const supplier = supplierId ? get<{ name: string }>('suppliers', supplierId)?.name : undefined;
      enqueue('post_grn', {
        id, project_id: project.id, number, store_id: storeId!, supplier_id: supplierId ?? undefined, po_id: poId ?? undefined,
        delivery_notice_id: noticeId ?? undefined,
        supplier_name: supplierName.trim() || supplier, delivery_note_no: dn.trim() || undefined,
        vehicle_plate: plate.trim() || undefined, driver_name: driver.trim() || undefined,
        received_at: new Date().toISOString(), remarks: remarks.trim() || undefined, supplier_signature: sig ?? undefined,
        lines: out,
      }, { entityType: 'grn', entityId: id, label: `${number} received` });
      disable();
      setPosted(number);
      setStep('done');
    } catch (err) { showError(err); }
  };

  const reset = () => {
    setId(uuid()); setMrId(null); setPoId(null); setNoticeId(null); setSupplierId(null); setSupplierName(''); setDn(''); setPlate(''); setDriver(''); setRemarks('');
    setLines([]); setSig(null); setErrors({}); setPosted(null); setStep('pick');
  };

  const exceptions = useMemo(() => lines.filter((l) => l.outcome !== 'ok' || (l.requestedSpec && l.specId !== l.requestedSpec)).length, [lines]);

  if (step === 'pick') return <Arriving projectId={project.id} onPick={start} onPickPo={startPo} onPickNotice={startNotice} />;
  if (step === 'done') {
    return (
      <>
        <Stack.Screen options={{ title: t('grn.received'), headerBackVisible: false }} />
        <SuccessView title={t('common.savedOnPhone', { x: posted ?? '' })} body={t('grn.stockUpdated')}
          actions={[
            { label: 'Share PDF', icon: 'file-pdf-box', onPress: () => void printGrn(id) },
            { label: t('grn.receiveAnother'), icon: 'tray-arrow-down', variant: 'tonal', onPress: reset },
            { label: t('common.done'), icon: 'check', variant: 'primary', onPress: () => router.replace(`/store/doc?type=grn&id=${id}`) },
          ]} />
      </>
    );
  }

  const mrNumber = poId ? get<{ number: string }>('purchase_orders', poId)?.number : mrId ? get<{ number: string }>('material_requests', mrId)?.number : null;
  return (
    <Screen form={form} footer={
      <ActionBar
        summary={`${lines.filter((l) => l.specId).length} item${lines.length === 1 ? '' : 's'}${exceptions ? ` · ${exceptions} exception${exceptions > 1 ? 's' : ''}` : ' · all OK'}${photos ? '' : ' · no photo yet'}`}
        warning={exceptions > 0 || !photos}
        primary={{ title: t('grn.post'), variant: 'hero', onPress: post }}
      />
    }>
      <Stack.Screen options={{ title: mrNumber ? `GRN · ${mrNumber}` : 'GRN · ad-hoc' }} />
      <Card>
        <SupplierPicker value={supplierId} onChange={setSupplierId} error={!supplierId ? errors.supplier : null} name="supplier" />
        {!supplierId ? <Field label="…or supplier name" value={supplierName} onChangeText={setSupplierName} error={errors.supplier} autoCapitalize="words" /> : null}
        <Field label={t('grn.dn')} optional value={dn} onChangeText={setDn} autoCapitalize="characters" placeholder="DN-"
          trailing={{ icon: 'camera-outline', accessibilityLabel: 'Photograph delivery note', onPress: () => void capturePhoto({ projectId: project.id, entityType: 'grn', entityId: id, kind: 'delivery_note' }, 'camera').catch(showError) }} />
        <Row align="flex-start">
          <View style={styles.flex}><Field label={t('common.plate')} optional value={plate} onChangeText={setPlate} autoCapitalize="characters" placeholder="AA-3-12345" /></View>
          <View style={styles.flex}><Field label={t('common.driver')} optional value={driver} onChangeText={setDriver} autoCapitalize="words" /></View>
        </Row>
        <StorePicker projectId={project.id} label={t('grn.receivingStore')} value={storeId} onChange={setStoreId} error={errors.store} name="store" />
      </Card>

      {poId ? <Banner tone="info" icon={noticeId ? 'truck-delivery-outline' : 'cart-outline'} text={noticeId ? ft('flow.againstNotice', { po: mrNumber ?? '' }) : t('grn.againstPo', { po: mrNumber ?? '' })} /> : null}
      <Section title={t('common.items')}>
        {lines.map((l, i) => {
          const uom = l.specId ? specUom(l.specId) : '';
          const del = num(l.delivered);
          const flag = l.ordered != null && del > 0 ? (del < (l.outstanding ?? l.ordered) ? `Short ${fmtQty((l.outstanding ?? l.ordered) - del)} ${uom}` : del > (l.outstanding ?? l.ordered) ? `Excess ${fmtQty(del - (l.outstanding ?? l.ordered))} ${uom}` : null) : null;
          const wrongGrade = !!l.requestedSpec && l.specId !== l.requestedSpec;
          return (
            <Card key={l.id} stripe={errors[`line${i}`] ? 'danger' : l.outcome === 'reject' ? 'danger' : l.outcome !== 'ok' || wrongGrade ? 'warning' : 'success'}>
              <Row justify="space-between" align="flex-start">
                <Text variant="titleSm" style={styles.flex}>{l.specId ? specLabel(l.specId) : `Item ${i + 1}`}</Text>
                {l.ordered != null ? <Text variant="bodySm" tone="muted" num>ordered {fmtQty(l.ordered)}{l.outstanding != null && l.outstanding !== l.ordered ? ` · due ${fmtQty(l.outstanding)}` : ''}</Text> : null}
              </Row>
              {!l.requestedSpec ? <SpecPicker value={l.specId} onChange={(v) => setLine(i, { specId: v })} name={`line${i}`} error={errors[`line${i}`]} />
                : errors[`line${i}`] ? <Text variant="bodySm" tone="danger">{errors[`line${i}`]}</Text> : null}
              {wrongGrade ? <Banner tone="danger" text="Different grade from request: will be flagged as wrong grade." /> : null}
              {l.ordered != null ? (
                <ChipGroup<Outcome> value={l.outcome} onChange={(o) => setOutcome(i, o)} options={[
                  { value: 'ok', label: t('grn.allOk'), icon: 'check', tone: 'success' }, { value: 'short', label: t('grn.short'), tone: 'warning' },
                  { value: 'damaged', label: t('grn.damaged'), tone: 'warning' }, { value: 'reject', label: t('common.reject'), tone: 'danger' },
                ]} />
              ) : null}
              {l.ordered == null || l.outcome !== 'ok' ? (
                <QuantityStepper label={t('grn.received')} unit={uom} value={l.delivered} onChange={(v) => setLine(i, { delivered: v })}
                  fill={l.outstanding ? { label: 'Outstanding', value: l.outstanding } : null} warning={flag} />
              ) : (
                <Row gap={6}><Chip label={`Received ${fmtQty(del)} ${uom}`} tone="success" icon="check" /><Chip label="Pass" tone="success" icon="shield-check-outline" /></Row>
              )}
              {l.outcome === 'damaged' ? (
                <QuantityStepper label="Damaged / rejected" unit={uom} value={l.rejected} onChange={(v) => setLine(i, { rejected: v })}
                  error={num(l.rejected || '0') > del ? 'Cannot exceed received quantity' : null} quick={[]} />
              ) : null}
              {l.outcome === 'reject' ? <Text variant="bodySm" tone="danger">Whole line rejected — goes to quarantine, not to stock.</Text> : null}
              {l.details ? (
                <View style={styles.gap}>
                  <Segmented<InspectionResult> label="Inspection" value={l.inspection} onChange={(v) => setLine(i, { inspection: v })} options={[
                    { value: 'pass', label: 'Pass', tone: 'success' }, { value: 'conditional', label: 'Conditional', tone: 'warning' }, { value: 'reject', label: 'Reject', tone: 'danger' },
                  ]} />
                  <Field label="Inspection notes" optional value={l.notes} onChangeText={(v) => setLine(i, { notes: v })} multiline placeholder="Certificates, slump, diameter check…" />
                  <Field label="Batch / heat / ticket no." optional value={l.batch} onChangeText={(v) => setLine(i, { batch: v })} autoCapitalize="characters" />
                  {!l.requestedSpec || l.poLineId ? null : <SpecPicker label="Grade delivered (change only if different)" value={l.specId} onChange={(v) => setLine(i, { specId: v })} />}
                </View>
              ) : (
                <Button title="Inspection details" size="sm" variant="ghost" icon="plus" onPress={() => setLine(i, { details: true })} />
              )}
              {lines.length > 1 && !l.mrLineId ? <Button title="Remove item" size="sm" variant="dangerOutline" icon="trash-can-outline" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} /> : null}
            </Card>
          );
        })}
        <Button title={t('common.addItem')} variant="tonal" icon="plus" onPress={() => setLines((ls) => [...ls, blank()])} />
      </Section>

      <PhotoStrip projectId={project.id} entityType="grn" entityId={id} kind="delivery_note" label={t('grn.photos')} required={1} />
      <SignatureField label={t('grn.signature')} value={sig} onChange={setSig} signer={driver.trim() || null} optional />
      <Field label={t('common.remarks')} optional value={remarks} onChangeText={setRemarks} multiline />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap: { gap: space[3] },
  headA: { padding: space[4], gap: space[3] },
  hdr: { paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[1] },
});
