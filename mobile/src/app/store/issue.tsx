// Material issue against an approved request (FR-ST-02..04, BR-01/02/05; spec §5.3).
// Defaults: receiver = requester, element from the request, qty = min(remaining, available).
// Emergency issue (no request) via ?emergency=1. The post_miv payload is unchanged.
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get } from '../../lib/db';
import type { MaterialRequest } from '../../lib/contract';
import { issuedForLine, lineElements, mrLines, requests, specLabel, specUom, stockQty, stores } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { fmtDate, fmtQty, num } from '../../lib/format';
import { t, useLocale } from '../../lib/i18n';
import { printMiv } from '../../lib/print';
import { requestTypeOf, reservedQty, type FlowMr } from '../../lib/flows';
import { ft } from '../../lib/flows-i18n';
import { space } from '../../theme';
import {
  ActionBar, Banner, Button, Card, ChipGroup, Field, Picker, QuantityStepper, Row, Screen, Section, Segmented, SignatureField,
  SuccessView, Text, showError, useForm, useUnsavedGuard, type Errors,
} from '../../components/ui';
import { ElementPicker, PersonPicker, SpecPicker, StorePicker } from '../../components/pickers';

interface Line { id: string; mrLineId: string | null; requestedSpec: string | null; specId: string | null; elementId: string | null; qty: string; remaining: number | null; subReason: string; changeGrade: boolean }
const blank = (): Line => ({ id: uuid(), mrLineId: null, requestedSpec: null, specId: null, elementId: null, qty: '', remaining: null, subReason: '', changeGrade: false });
const EMERGENCY_REASONS = ['Pour in progress', 'Safety', 'Breakdown repair', 'Request not yet approved'];

export default function Issue() {
  useLocale();
  const { project } = useSession();
  const params = useLocalSearchParams<{ mr?: string; emergency?: string }>();
  const form = useForm();
  const [id] = useState(uuid);
  const [mode] = useState<'request' | 'emergency'>(params.emergency ? 'emergency' : 'request');
  const [mrId, setMrId] = useState<string | null>(params.mr ?? null);
  const [storeId, setStoreId] = useState<string | null>(() => stores(project.id)[0]?.id ?? null);
  const [receiver, setReceiver] = useState<string | null>(null);
  const [reasonPick, setReasonPick] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<Line[]>(() => (params.emergency ? [blank()] : []));
  const [signNow, setSignNow] = useState<'now' | 'later'>('later');
  const [sig, setSig] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [posted, setPosted] = useState<string | null>(null);

  const mrOptions = useData(() => requests(project.id)
    // store orders only: site-use requests approved by the coordinator (purchase requests are received, never issued)
    .filter((r) => ['approved', 'partially_issued', 'sourced', 'ordered'].includes(r.status) && requestTypeOf(r) === 'site_use')
    .map((r) => ({ id: r.id, code: r.number, label: r.number, sub: `Needed ${fmtDate(r.required_date)} · ${r.status === 'partially_issued' ? 'part issued' : 'approved'}` })), [project.id]);

  useEffect(() => {
    if (mode !== 'request') return;
    if (!mrId) { setLines([]); return; }
    const mr = get<MaterialRequest>('material_requests', mrId);
    if (mr) setReceiver(mr.requested_by);
    setLines(mrLines(mrId).filter((l) => !l.deleted_at).map((l) => {
      const remaining = Math.max(Number(l.approved_qty ?? 0) - issuedForLine(project.id, l.id), 0);
      const avail = storeId ? stockQty(project.id, l.material_spec_id, storeId) : 0;
      const els = lineElements(l.id).filter((e) => !e.deleted_at);
      return {
        ...blank(), mrLineId: l.id, requestedSpec: l.material_spec_id, specId: l.material_spec_id,
        elementId: els[0]?.element_id ?? null, remaining,
        qty: remaining > 0 ? String(Math.max(Math.min(remaining, avail), 0)) : '0',
      };
    }).filter((l) => (l.remaining ?? 0) > 0));
  }, [mrId, mode, storeId, project.id]);

  // Store order: issue from the store the coordinator chose.
  useEffect(() => {
    const mr = mrId ? get<FlowMr>('material_requests', mrId) : null;
    if (mr?.store_id) setStoreId(mr.store_id);
  }, [mrId]);
  const order = mrId ? get<FlowMr>('material_requests', mrId) : null;

  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const dirty = !posted && (mode === 'emergency' ? lines.some((l) => l.specId) : !!mrId && !params.mr);
  const disable = useUnsavedGuard(dirty, { what: 'issue' });
  const emergencyReason = [reasonPick === '__other' ? '' : reasonPick, reason.trim()].filter(Boolean).join(' · ');

  const post = () => {
    const e: Errors = {};
    if (!storeId) e.store = 'Select the store';
    if (!receiver) e.receiver = 'Select who receives the materials';
    if (mode === 'request' && !mrId) e.mr = 'Select an approved request';
    if (mode === 'emergency' && !emergencyReason) e.reason = 'Emergency issue requires a reason';
    const active = lines.filter((l) => num(l.qty) > 0);
    lines.forEach((l, i) => {
      const q = num(l.qty);
      if (!(q > 0)) return;
      if (!l.specId) { e[`line${i}`] = 'Select the material'; return; }
      if (!l.elementId) { e[`line${i}`] = `Select the structural element (BR-02)`; return; }
      if (l.remaining != null && q > l.remaining + 1e-9) { e[`line${i}`] = `Only ${fmtQty(l.remaining)} remaining on the request`; return; }
      const avail = storeId ? stockQty(project.id, l.specId, storeId) : 0;
      if (q > avail + 1e-9) { e[`line${i}`] = `Exceeds stock: only ${fmtQty(avail)} available in this store`; return; }
      if (l.requestedSpec && l.specId !== l.requestedSpec && !l.subReason.trim()) e[`line${i}`] = 'A substitution reason is required when issuing a different grade (BR-05)';
    });
    if (!active.length && !e.mr) e.lines = 'Enter at least one quantity to issue';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      const out = active.map((l) => ({
        id: l.id, mr_line_id: l.mrLineId ?? undefined, material_spec_id: l.specId!, element_id: l.elementId!, qty: num(l.qty),
        substitution_reason: l.specId !== l.requestedSpec && l.requestedSpec ? l.subReason.trim() : undefined,
      }));
      const number = nextDocNumber(project.code, 'MIV');
      enqueue('post_miv', {
        id, project_id: project.id, number, store_id: storeId!, mr_id: mode === 'request' ? mrId : null, issued_to: receiver!,
        issued_at: new Date().toISOString(), is_emergency: mode === 'emergency', emergency_reason: mode === 'emergency' ? emergencyReason : undefined,
        remarks: remarks.trim() || undefined, receiver_signature: signNow === 'now' ? sig ?? undefined : undefined, lines: out,
      }, { entityType: 'miv', entityId: id, label: `${number} issued` });
      disable();
      setPosted(number);
    } catch (err) { showError(err); }
  };

  if (posted) {
    return (
      <>
        <Stack.Screen options={{ title: t('issue.issued'), headerBackVisible: false }} />
        <SuccessView title={t('common.savedOnPhone', { x: posted })}
          body={signNow === 'now' && sig ? 'Signed by the receiver.' : 'The receiver signs off in their app.'}
          actions={[
            { label: 'Share PDF', icon: 'file-pdf-box', onPress: () => void printMiv(id) },
            { label: 'Back to issue queue', icon: 'package-variant-closed', variant: 'tonal', onPress: () => router.replace('/queue') },
            { label: t('common.done'), icon: 'check', variant: 'primary', onPress: () => router.replace(`/store/doc?type=miv&id=${id}`) },
          ]} />
      </>
    );
  }

  const mrNumber = mrId ? get<MaterialRequest>('material_requests', mrId)?.number : null;
  const totalQty = lines.reduce((s, l) => s + (num(l.qty) || 0), 0);
  const units = [...new Set(lines.filter((l) => l.specId && num(l.qty) > 0).map((l) => specUom(l.specId!)))];
  const count = lines.filter((l) => num(l.qty) > 0).length;

  return (
    <Screen form={form} footer={
      <ActionBar summary={`${count} item${count === 1 ? '' : 's'}${units.length === 1 ? ` · ${fmtQty(totalQty)} ${units[0]}` : ''}`}
        primary={{ title: t('act.issue'), onPress: post }} />
    }>
      <Stack.Screen options={{ title: mode === 'emergency' ? t('issue.emergency') : mrNumber ? `${t('act.issue')} · ${mrNumber}` : t('issue.title') }} />
      {mode === 'emergency' ? (
        <Banner tone="danger" title={t('issue.emergencyBanner')} text="Emergency issues must be regularised against an approved request within 24 hours (BR-01). Management is notified." />
      ) : null}
      <Card>
        {mode === 'request' && !params.mr ? (
          <Picker label={t('issue.approvedRequest')} value={mrId} options={mrOptions} onChange={setMrId} error={errors.mr} name="mr" />
        ) : null}
        {mode === 'emergency' ? (
          <View style={styles.gap}>
            <ChipGroup label={t('issue.emergencyReason')} value={reasonPick} onChange={setReasonPick}
              options={[...EMERGENCY_REASONS.map((r) => ({ value: r, label: r })), { value: '__other', label: 'Other…' }]} />
            <Field label={reasonPick === '__other' || !reasonPick ? 'Reason' : 'Details'} optional={!!reasonPick && reasonPick !== '__other'}
              value={reason} onChangeText={setReason} multiline error={errors.reason} name="reason" />
          </View>
        ) : null}
        <PersonPicker projectId={project.id} label={t('issue.to')} value={receiver} onChange={setReceiver} error={errors.receiver} name="receiver" />
        <StorePicker projectId={project.id} label={t('issue.fromStore')} value={storeId} onChange={setStoreId} error={errors.store} name="store" />
      </Card>

      {mode === 'request' && mrId && !lines.length ? <Banner tone="success" text="Nothing remaining to issue on this request." /> : null}
      {lines.length ? (
        <Section title={t('common.items')}>
          {lines.map((l, i) => {
            const avail = l.specId && storeId ? stockQty(project.id, l.specId, storeId) : 0;
            const uom = l.specId ? specUom(l.specId) : '';
            const issued = l.mrLineId ? issuedForLine(project.id, l.mrLineId) : 0;
            const fill = l.remaining != null ? Math.max(Math.min(l.remaining, avail), 0) : null;
            const over = num(l.qty) > avail + 1e-9;
            // §5.1 reservation: stock promised to earlier-approved store orders is not available to this one
            const reserved = order && l.specId && storeId ? reservedQty(project.id, storeId, l.specId, order.id, order.approved_at) : 0;
            const short = !over && reserved > 0 && num(l.qty) > Math.max(avail - reserved, 0) + 1e-9;
            return (
              <Card key={l.id} stripe={errors[`line${i}`] ? 'danger' : null}>
                <Text variant="titleSm">{l.requestedSpec ? specLabel(l.requestedSpec) : `Item ${i + 1}`}</Text>
                {l.remaining != null ? (
                  <Text variant="caption" tone="muted" num>Approved {fmtQty((l.remaining ?? 0) + issued)} · issued {fmtQty(issued)} · stock {fmtQty(avail)} {uom}</Text>
                ) : l.specId ? <Text variant="caption" tone="muted" num>Stock {fmtQty(avail)} {uom}</Text> : null}
                {!l.requestedSpec || l.changeGrade ? (
                  <SpecPicker label={l.requestedSpec ? 'Issue grade (substitution)' : 'Material / grade'} value={l.specId} onChange={(v) => setLine(i, { specId: v })} />
                ) : null}
                {l.requestedSpec && l.specId !== l.requestedSpec ? (
                  <Field label={t('issue.subReason')} value={l.subReason} onChangeText={(v) => setLine(i, { subReason: v })} multiline />
                ) : null}
                <QuantityStepper value={l.qty} onChange={(v) => setLine(i, { qty: v })} unit={uom} name={`line${i}`}
                  max={l.remaining ?? undefined} fill={fill ? { label: l.remaining != null ? 'Remaining' : 'Stock', value: fill } : null}
                  error={errors[`line${i}`] ?? (over ? `Exceeds stock (${fmtQty(avail)})` : null)}
                  warning={short ? `${ft('flow.ati', { q: fmtQty(Math.max(avail - reserved, 0)), u: uom })} · ${ft('flow.reservedFor', { q: fmtQty(reserved) })}` : null} />
                <ElementPicker projectId={project.id} label={t('issue.forElement')} value={l.elementId} onChange={(v) => setLine(i, { elementId: v })} />
                <Row>
                  {l.requestedSpec && !l.changeGrade ? <Button title={t('issue.differentGrade')} size="sm" variant="ghost" icon="swap-horizontal" onPress={() => setLine(i, { changeGrade: true })} /> : null}
                  {mode === 'emergency' && lines.length > 1 ? <Button title="Remove" size="sm" variant="dangerOutline" icon="trash-can-outline" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} /> : null}
                </Row>
              </Card>
            );
          })}
          {errors.lines ? <Text variant="bodySm" tone="danger">{errors.lines}</Text> : null}
          {mode === 'emergency' ? <Button variant="tonal" title={t('common.addItem')} icon="plus" onPress={() => setLines((ls) => [...ls, blank()])} /> : null}
        </Section>
      ) : null}

      <Segmented label={t('issue.receiverSignOff')} value={signNow} onChange={setSignNow} options={[
        { value: 'now', label: 'On phone now', icon: 'draw-pen' }, { value: 'later', label: 'Later in app', icon: 'cellphone' },
      ]} />
      {signNow === 'now' ? <SignatureField label={t('issue.receiverSig')} value={sig} onChange={setSig} /> : null}
      <Field label={t('common.remarks')} optional value={remarks} onChangeText={setRemarks} />
    </Screen>
  );
}

const styles = StyleSheet.create({ gap: { gap: space[2] } });
