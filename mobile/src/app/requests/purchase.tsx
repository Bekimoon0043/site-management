// Purchase request fast form (Flow A, docs/research/procurement-lookahead.md §3.2):
// material + quantity stepper + required date + purpose; no element split. Numbers use the PR
// document type (<PROJ>-PR-<DEV>-<SEQ>) so save_mr accepts request_type 'purchase'.
// ?id= edits a draft/returned PR, ?clone= copies one, ?spec=&qty= prefills a line.
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Redirect, Stack, router, useLocalSearchParams, type Href } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get } from '../../lib/db';
import type { MrPriority } from '../../lib/contract';
import { canFlow } from '../../lib/contract-flows';
import { mainStoreId, nextFlowNumber, requestTypeOf, type FlowMr } from '../../lib/flows';
import { ft } from '../../lib/flows-i18n';
import { mrLines, specUom, stockQty } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { addDays, fmtQty, num, today } from '../../lib/format';
import { useLocale } from '../../lib/i18n';
import { space } from '../../theme';
import {
  ActionBar, Banner, Button, Card, Field, IconButton, QuantityStepper, Row, Screen, Section, Segmented, Text, haptic, showError, toast,
  useForm, useUnsavedGuard, type Errors,
} from '../../components/ui';
import { DateField, SpecPicker, StorePicker } from '../../components/pickers';

interface Line { id: string; specId: string | null; qty: string }
const blank = (specId: string | null = null, qty = ''): Line => ({ id: uuid(), specId, qty });

export default function PurchaseRequestForm() {
  useLocale();
  const { project, profile } = useSession();
  // Look-ahead "Raise purchase request" passes spec, qty, need_by, la_plan, la_item (element is ignored: PRs need no split).
  const params = useLocalSearchParams<{ id?: string; clone?: string; spec?: string; qty?: string; need_by?: string; la_plan?: string; la_item?: string; element?: string }>();
  const source = get<FlowMr>('material_requests', params.id ?? params.clone ?? null);
  const editing = !!params.id && !!source && ['draft', 'returned', 'submitted'].includes(source.status);
  const form = useForm();

  const initial = useMemo(() => ({
    lines: source ? mrLines(source.id).filter((l) => !l.deleted_at).map((l) => ({ id: editing ? l.id : uuid(), specId: l.material_spec_id, qty: String(l.qty) }))
      : [blank(params.spec ?? null, params.qty ?? '')],
    requiredDate: editing ? source!.required_date : params.need_by && params.need_by >= today() ? params.need_by : addDays(today(), 7),
    purpose: source?.purpose ?? '',
    priority: (source?.priority ?? 'normal') as MrPriority,
    storeId: source?.store_id ?? mainStoreId(project.id),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  const [id] = useState(() => (editing ? source!.id : uuid()));
  const [lines, setLines] = useState<Line[]>(initial.lines);
  const [requiredDate, setRequiredDate] = useState<string | null>(initial.requiredDate);
  const [purpose, setPurpose] = useState(initial.purpose);
  const [priority, setPriority] = useState<MrPriority>(initial.priority);
  const [storeId, setStoreId] = useState<string | null>(initial.storeId);
  const [errors, setErrors] = useState<Errors>({});
  const [saved, setSaved] = useState(false);
  const dirty = !saved && JSON.stringify({ lines, requiredDate, purpose, priority, storeId }) !== JSON.stringify(initial);
  const disable = useUnsavedGuard(dirty, { what: 'purchase request' });

  const info = useData(() => lines.map((l) => (l.specId ? { uom: specUom(l.specId), stock: stockQty(project.id, l.specId) } : null)), [lines, project.id]);
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  if (!canFlow(profile.role, 'pr.create')) {
    return (
      <Screen>
        <Stack.Screen options={{ title: ft('flow.newPurchase') }} />
        <Banner tone="info" text={ft('flow.kindPurchaseHint')} />
      </Screen>
    );
  }
  if (params.id && source && requestTypeOf(source) !== 'purchase') {
    return <Redirect href={`/requests/new?id=${source.id}`} />;
  }

  const save = (submit: boolean) => {
    const e: Errors = {};
    if (!requiredDate) e.date = ft('flow.errDate');
    lines.forEach((l, i) => {
      if (!l.specId) e[`spec${i}`] = ft('flow.errMaterial');
      else if (!(num(l.qty) > 0)) e[`qty${i}`] = ft('flow.errQty');
    });
    if (!lines.length) e.lines = ft('flow.errLines');
    setErrors(e);
    if (Object.keys(e).length) { haptic('reject'); form.focusFirstError(e); return; }
    try {
      const number = editing ? source!.number : nextFlowNumber(project.code, 'purchase');
      enqueue('save_mr', {
        id, project_id: project.id, number, request_type: 'purchase', block_id: editing ? source!.block_id : null, priority,
        required_date: requiredDate!, store_id: storeId ?? undefined, purpose: purpose.trim() || undefined,
        device_created_at: new Date().toISOString(), submit,
        ...(params.la_plan ? { lookahead_plan_id: params.la_plan, is_lookahead: true } : null),
        lines: lines.map((l, i) => ({
          id: l.id, material_spec_id: l.specId!, qty: num(l.qty), elements: [],
          // the look-ahead item is linked to the prefilled (first) line
          ...(params.la_item && i === 0 && !editing ? { lookahead_item_id: params.la_item } : null),
        })),
      }, { entityType: 'material_request', entityId: id, label: `${number} ${submit ? 'submitted' : 'saved as draft'}` });
      haptic('confirm');
      toast.success(submit ? ft('flow.prSubmitted', { n: number }) : ft('flow.prDraft', { n: number }));
      setSaved(true);
      disable();
      router.replace(`/requests/${id}`);
    } catch (err) {
      showError(err);
    }
  };

  return (
    <Screen form={form} footer={
      <ActionBar summary={ft('flow.lines', { n: lines.length })}
        secondary={{ title: ft('flow.saveDraft'), onPress: () => save(false) }}
        primary={{ title: ft('flow.submitPr'), variant: 'hero', onPress: () => save(true) }} />
    }>
      <Stack.Screen options={{ title: editing ? source!.number : ft('flow.newPurchase') }} />
      {!editing && canFlow(profile.role, 'sur.create') ? (
        <Banner tone="info" icon="swap-horizontal" text={ft('flow.kindSiteUseHint')}
          actions={[{ label: ft('flow.newSiteUse'), onPress: () => { disable(); router.replace('/requests/new' as Href); } }]} />
      ) : null}

      <Section title={ft('flow.whatKind')}>
        {lines.map((l, i) => (
          <Card key={l.id} dense>
            <Row align="flex-start">
              <View style={styles.flex}>
                <SpecPicker label={ft('flow.material')} value={l.specId} onChange={(v) => setLine(i, { specId: v ?? null })} error={errors[`spec${i}`]} name={`spec${i}`} />
              </View>
              {lines.length > 1 ? <IconButton icon="trash-can-outline" tone="danger" accessibilityLabel={ft('flow.removeLine')}
                onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} /> : null}
            </Row>
            <QuantityStepper label={ft('flow.qty')} unit={info[i]?.uom ?? ''} value={l.qty} onChange={(v) => setLine(i, { qty: v })}
              info={info[i] ? ft('flow.stockNow', { q: fmtQty(info[i]!.stock), u: info[i]!.uom }) : null} error={errors[`qty${i}`]} name={`qty${i}`} />
          </Card>
        ))}
        {errors.lines ? <Text variant="bodySm" tone="danger">{errors.lines}</Text> : null}
        <Button title={ft('flow.addMaterial')} variant="tonal" icon="plus" onPress={() => setLines((ls) => [...ls, blank()])} />
      </Section>

      <Card>
        <DateField label={ft('flow.requiredBy')} value={requiredDate} onChange={setRequiredDate} error={errors.date} name="date" minimumDate={new Date()} quick />
        <Field label={ft('flow.purpose')} optional value={purpose} onChangeText={setPurpose} multiline placeholder={ft('flow.purposePh')} />
        <Segmented<MrPriority> value={priority} onChange={setPriority} options={[
          { value: 'normal', label: 'Normal' }, { value: 'urgent', label: 'Urgent', tone: 'warning' }, { value: 'critical', label: 'Critical', tone: 'danger' },
        ]} />
        <StorePicker projectId={project.id} label={ft('flow.deliverTo')} value={storeId} onChange={(v) => setStoreId(v ?? null)} allowClear />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap: { gap: space[2] },
});
