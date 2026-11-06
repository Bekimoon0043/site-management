// Create / edit / clone a material request (SRS 4.2, FR-MR-01..08; spec §5.1).
// One screen, progressive disclosure: a collapsed header summary with smart defaults,
// compact line cards edited in a sheet (stepper + quick-add + Fill BoQ), sticky action bar.
// The save_mr payload is unchanged.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Redirect, Stack, router, useLocalSearchParams, type Href } from 'expo-router';
import { canFlow } from '../../lib/contract-flows';
import { ft } from '../../lib/flows-i18n';
import { requestTypeOf } from '../../lib/flows';
import { useData, useSession } from '../../lib/app';
import { get, kvGet, kvSet, list } from '../../lib/db';
import type { Block, ElementTakeoff, MaterialRequest, MaterialSpec, MrPriority, Store } from '../../lib/contract';
import { boqBalance, conversions, elementLabel, lineElements, mrLines, specLabel, specs, stockQty, stores } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { addDays, fmtDate, fmtQty, num, today } from '../../lib/format';
import { t as tr, useLocale } from '../../lib/i18n';
import { space, useTheme } from '../../theme';
import {
  ActionBar, Banner, Button, Card, Chip, ChipGroup, Field, Icon, IconButton, QuantityStepper, Row, Screen, SearchSheet, Section,
  Segmented, Sheet, Text, haptic, showError, toast, useFieldRef, useForm, useUnsavedGuard, type Errors, type Option,
} from '../../components/ui';
import { BlockPicker, DateField, ElementPicker, StorePicker } from '../../components/pickers';

interface ElSplit { id: string; elementId: string | null; qty: string }
interface Line { id: string; specId: string | null; qty: string; unit: string; requiredDate: string | null; remarks: string; overReason: string; elements: ElSplit[] }

const newLine = (specId: string | null = null, elementId: string | null = null): Line => ({
  id: uuid(), specId, qty: '', unit: '', requiredDate: null, remarks: '', overReason: '', elements: [{ id: uuid(), elementId, qty: '' }],
});

function loadLines(mrId: string, fresh: boolean): Line[] {
  return mrLines(mrId).filter((l) => !l.deleted_at).map((l) => ({
    id: fresh ? uuid() : l.id, specId: l.material_spec_id, qty: String(l.qty), unit: '', requiredDate: fresh ? null : l.required_date,
    remarks: l.remarks ?? '', overReason: fresh ? '' : l.over_boq_reason ?? '',
    elements: lineElements(l.id).filter((e) => !e.deleted_at).map((e) => ({ id: fresh ? uuid() : e.id, elementId: e.element_id, qty: String(e.qty) })),
  }));
}

// Base-unit quantity of a line after alternative-unit conversion (FR-ST-12).
function baseQty(l: Line): number {
  const q = num(l.qty);
  if (!l.specId || !l.unit) return q;
  const c = conversions(l.specId).find((x) => x.alt_uom === l.unit);
  return c ? q * Number(c.factor) : q;
}
const splitQty = (l: Line, e: ElSplit) => (l.elements.length === 1 ? baseQty(l) : num(e.qty));

const OVER_REASONS = ['Wastage', 'Design change', 'Re-work', 'Take-off error'];
const DRAFT_KEY = (pid: string) => `draft:mr:${pid}`;

interface Draft { blockId: string | null; priority: MrPriority; requiredDate: string | null; storeId: string | null; location: string; drawing: string; purpose: string; lookahead: boolean; lines: Line[] }

// ---------------------------------------------------------------------------
// Line sheet
// ---------------------------------------------------------------------------

function LineSheet({ projectId, mrId, initial, isNew, headerDate, onSave, onRemove, onClose }: {
  projectId: string; mrId: string; initial: Line; isNew: boolean; headerDate: string | null;
  onSave: (l: Line) => void; onRemove: () => void; onClose: () => void;
}) {
  const t = useTheme();
  const [l, setL] = useState<Line>(initial);
  const [pickSpec, setPickSpec] = useState(false);
  const [more, setMore] = useState({ date: !!initial.requiredDate, remarks: !!initial.remarks, split: initial.elements.length > 1 });
  const [err, setErr] = useState<Errors>({});
  const [otherOpen, setOtherOpen] = useState(false);
  const set = (p: Partial<Line>) => setL((x) => ({ ...x, ...p }));
  const setSplit = (k: number, p: Partial<ElSplit>) => setL((x) => ({ ...x, elements: x.elements.map((e, m) => (m === k ? { ...e, ...p } : e)) }));
  const specOpts = useData(() => specs().map<Option>((s) => ({ id: s.id, label: s.label, sub: `${s.category} · ${s.uom}`, category: s.category, trailing: s.uom })));

  const inf = useData(() => {
    if (!l.specId) return null;
    const spec = get<MaterialSpec>('material_specs', l.specId);
    const stock = stockQty(projectId, l.specId);
    const els = l.elements.filter((e) => e.elementId).map((e) => {
      const b = boqBalance(projectId, e.elementId!, l.specId!, mrId);
      const q = splitQty(l, e);
      return { ...b, el: e.elementId!, q, over: b.balance != null && Number.isFinite(q) && q > b.balance + 1e-6 };
    });
    const due = l.requiredDate ?? headerDate;
    const leadWarn = !!spec && !!due && due < addDays(today(), Number(spec.lead_time_days));
    return { spec, stock, els, over: els.some((x) => x.over), leadWarn, convs: conversions(l.specId) };
  }, [l, projectId, mrId, headerDate]);

  const uom = inf?.spec?.uom ?? '';
  const conv = inf?.convs.find((c) => c.alt_uom === l.unit);
  const bal = inf?.els.length === 1 ? inf.els[0].balance : null;
  const fillVal = bal != null && bal > 0 ? (conv ? bal / Number(conv.factor) : bal) : null;
  const overBy = inf?.els.reduce((s, x) => s + (x.over && x.balance != null ? x.q - x.balance : 0), 0) ?? 0;

  const save = () => {
    const e: Errors = {};
    if (!l.specId) e.spec = 'Select material and grade';
    if (!(baseQty(l) > 0)) e.qty = 'Enter a quantity greater than zero';
    if (l.elements.length > 1) {
      const sum = l.elements.reduce((s, x) => s + splitQty(l, x), 0);
      if (Math.abs(sum - baseQty(l)) > 0.001) e.split = `Element split (${fmtQty(sum)}) must equal the line quantity (${fmtQty(baseQty(l))})`;
    }
    setErr(e);
    if (Object.keys(e).length) { haptic('reject'); return; }
    haptic('tick');
    onSave(l);
  };

  return (
    <Sheet visible onClose={onClose} full title={l.specId ? `${specLabel(l.specId)}${uom ? ` (${uom})` : ''}` : 'Material'}
      footer={<>
        {!isNew ? <Button title="Remove" variant="dangerOutline" icon="trash-can-outline" onPress={onRemove} /> : <Button title="Cancel" variant="ghost" onPress={onClose} />}
        <Button title={tr('mr.saveLine')} flex iconRight="chevron-right" onPress={save} />
      </>}>
      <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
        <Row justify="space-between">
          <Text variant="bodySm" tone="muted" style={styles.flex}>{inf?.spec ? `${inf.spec.description ?? ''}` : ''}</Text>
          <Button title={tr('mr.changeMaterial')} size="sm" variant="ghost" icon="swap-horizontal" onPress={() => setPickSpec(true)} />
        </Row>
        {err.spec ? <Text variant="bodySm" tone="danger">{err.spec}</Text> : null}
        {inf ? (
          <View style={[styles.well, { backgroundColor: t.surfaceMuted }]}>
            <Text variant="bodySm" num>Stock on site {fmtQty(inf.stock)} {uom}</Text>
            {inf.els.map((x) => (
              <Text key={x.el} variant="bodySm" num>
                {elementLabel(x.el)}: {x.planned == null ? 'no take-off' : `BoQ bal ${fmtQty(x.balance)} ${uom} (planned ${fmtQty(x.planned)}, requested ${fmtQty(x.requested)})`}
              </Text>
            ))}
            {inf.spec ? <Text variant="caption" tone="muted">Wastage allowance {inf.spec.wastage_pct}% · lead time {inf.spec.lead_time_days} d</Text> : null}
          </View>
        ) : null}

        <QuantityStepper value={l.qty} onChange={(v) => set({ qty: v })} unit={l.unit || uom} error={err.qty}
          info={inf ? `Stock ${fmtQty(inf.stock)} ${uom}` : null}
          fill={fillVal != null ? { label: 'BoQ', value: Math.round(fillVal * 1000) / 1000 } : null}
          units={inf?.convs.length ? {
            value: l.unit || '__base', onChange: (v) => set({ unit: v === '__base' ? '' : v }),
            options: [{ value: '__base', label: uom }, ...inf.convs.map((c) => ({ value: c.alt_uom, label: c.alt_uom }))].slice(0, 4),
          } : null}
          hint={l.unit && Number.isFinite(baseQty(l)) ? `= ${fmtQty(baseQty(l))} ${uom}` : null} />

        {!more.split ? (
          <ElementPicker projectId={projectId} label={tr('mr.element')} value={l.elements[0]?.elementId ?? null}
            onChange={(v) => setSplit(0, { elementId: v })} hint="Where the material will be used" />
        ) : (
          <View style={styles.gap}>
            <Text variant="label">Split across elements</Text>
            {l.elements.map((e, k) => (
              <Card key={e.id} dense>
                <ElementPicker projectId={projectId} label={`Element ${k + 1}`} value={e.elementId} onChange={(v) => setSplit(k, { elementId: v })} />
                <Row align="flex-end">
                  <View style={styles.flex}>
                    <Field label={`Quantity for this element (${uom})`} value={e.qty} onChangeText={(v) => setSplit(k, { qty: v })} keyboardType="decimal-pad" />
                  </View>
                  {l.elements.length > 1 ? <IconButton icon="trash-can-outline" tone="danger" accessibilityLabel="Remove element"
                    onPress={() => set({ elements: l.elements.filter((_, m) => m !== k) })} /> : null}
                </Row>
              </Card>
            ))}
            {err.split ? <Text variant="bodySm" tone="danger">{err.split}</Text> : null}
            <Button title={tr('mr.addElement')} size="md" variant="tonal" icon="plus" onPress={() => set({ elements: [...l.elements, { id: uuid(), elementId: null, qty: '' }] })} />
          </View>
        )}

        {inf?.over ? (
          <View style={styles.gap}>
            <Banner tone="warning" title={`Over BoQ by ${fmtQty(overBy)} ${uom}`} text="A reason is needed to submit." />
            <ChipGroup label="Reason" value={OVER_REASONS.includes(l.overReason) ? l.overReason : otherOpen || l.overReason ? '__other' : null}
              onChange={(v) => {
                if (v === '__other') { setOtherOpen(true); if (OVER_REASONS.includes(l.overReason)) set({ overReason: '' }); }
                else { setOtherOpen(false); set({ overReason: v }); }
              }}
              options={[...OVER_REASONS.map((r) => ({ value: r, label: r })), { value: '__other', label: 'Other…' }]} />
            {otherOpen || (l.overReason && !OVER_REASONS.includes(l.overReason)) ? (
              <Field label="Reason for exceeding BoQ" value={l.overReason} onChangeText={(v) => set({ overReason: v })} multiline
                placeholder="e.g. Design change S-201 Rev C" autoFocus={otherOpen && !l.overReason} />
            ) : null}
          </View>
        ) : null}
        {inf?.leadWarn ? <Banner tone="warning" text={`Lead time is ${inf.spec?.lead_time_days} days — the required date may be too early.`} /> : null}

        {more.date ? (
          <DateField label="Different required date" value={l.requiredDate} onChange={(v) => set({ requiredDate: v })} minimumDate={new Date()} quick
            hint={headerDate ? `Request date is ${fmtDate(headerDate)}` : undefined} />
        ) : null}
        {more.remarks ? <Field label={tr('common.remarks')} optional value={l.remarks} onChangeText={(v) => set({ remarks: v })} multiline /> : null}
        <Row wrap>
          {!more.split ? <Button title="Split across elements" size="sm" variant="ghost" icon="plus" onPress={() => setMore((m) => ({ ...m, split: true }))} /> : null}
          {!more.date ? <Button title="Different date" size="sm" variant="ghost" icon="plus" onPress={() => setMore((m) => ({ ...m, date: true }))} /> : null}
          {!more.remarks ? <Button title="Remarks" size="sm" variant="ghost" icon="plus" onPress={() => setMore((m) => ({ ...m, remarks: true }))} /> : null}
        </Row>
      </ScrollView>
      {pickSpec ? (
        <SearchSheet visible onClose={() => setPickSpec(false)} title="Material / grade" options={specOpts} value={l.specId}
          onSelect={(id) => set({ specId: id, unit: '' })} recentKey="spec" favKey="spec" categories />
      ) : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function RequestForm() {
  useLocale();
  const { project, profile } = useSession();
  // spec / qty / element / need_by / la_plan / la_item: prefill from the monthly tasks window (look-ahead item → "Request from store")
  const params = useLocalSearchParams<{ id?: string; clone?: string; lookahead?: string; spec?: string; qty?: string; element?: string; need_by?: string; la_plan?: string; la_item?: string }>();
  const source = get<MaterialRequest>('material_requests', params.id ?? params.clone ?? null);
  const editing = !!params.id && !!source;
  const isPlainNew = !params.id && !params.clone && !params.spec;
  const form = useForm();

  const defaults = useMemo<Draft>(() => {
    const ss = stores(project.id);
    const main = ss.find((s) => s.store_type === 'main') ?? ss[0];
    const lastBlock = kvGet(`last-block:${project.id}`);
    return {
      blockId: source?.block_id ?? (lastBlock && get<Block>('blocks', lastBlock) ? lastBlock : null),
      priority: source?.priority ?? 'normal',
      requiredDate: editing ? source!.required_date : params.need_by && params.need_by >= today() ? params.need_by : params.lookahead ? addDays(today(), 7) : addDays(today(), 1),
      storeId: source ? source.store_id : main?.id ?? null,
      location: source?.delivery_location ?? '', drawing: source?.drawing_ref ?? '', purpose: source?.purpose ?? '',
      lookahead: source?.is_lookahead ?? !!params.lookahead,
      lines: source ? loadLines(source.id, !editing) : params.spec ? [{ ...newLine(params.spec, params.element ?? null), qty: params.qty ?? '' }] : [],
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [id] = useState(() => (editing ? source!.id : uuid()));
  const [h, setH] = useState<Draft>(defaults);
  const [headerOpen, setHeaderOpen] = useState(!defaults.blockId);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<{ index: number | null; line: Line } | null>(null);
  const [pickSpec, setPickSpec] = useState(false);
  const [pickTemplate, setPickTemplate] = useState(false);
  const [saved, setSaved] = useState(false);
  const lastEl = useRef<string | null>(null);
  const lines = h.lines;
  const setLines = (fn: (ls: Line[]) => Line[]) => setH((x) => ({ ...x, lines: fn(x.lines) }));

  const specOpts = useData(() => specs().map<Option>((s) => ({ id: s.id, label: s.label, sub: `${s.category} · ${s.uom}`, category: s.category, trailing: s.uom })));

  // Restore an autosaved draft of a brand-new request.
  useEffect(() => {
    if (!isPlainNew) return;
    const raw = kvGet(DRAFT_KEY(project.id));
    if (!raw) return;
    try {
      const d = JSON.parse(raw) as Draft;
      if (!d.lines?.length) return;
      setH(d);
      toast.show({ text: 'Restored your unsaved request', action: { label: 'Discard', onPress: () => { kvSet(DRAFT_KEY(project.id), null); setH(defaults); } } });
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = !saved && JSON.stringify(h) !== JSON.stringify(defaults);
  // Autosave every 5 s.
  const latest = useRef(h);
  latest.current = h;
  useEffect(() => {
    if (!isPlainNew) return;
    const timer = setInterval(() => {
      if (latest.current.lines.length) kvSet(DRAFT_KEY(project.id), JSON.stringify(latest.current));
    }, 5000);
    return () => clearInterval(timer);
  }, [isPlainNew, project.id]);

  // Live per-line info for cards (FR-MR-03/04/05).
  const info = useData(() => lines.map((l) => {
    if (!l.specId) return null;
    const spec = get<MaterialSpec>('material_specs', l.specId);
    const els = l.elements.filter((e) => e.elementId).map((e) => {
      const b = boqBalance(project.id, e.elementId!, l.specId!, id);
      const q = splitQty(l, e);
      return { ...b, el: e.elementId!, over: b.balance != null && Number.isFinite(q) && q > b.balance + 1e-6 };
    });
    const due = l.requiredDate ?? h.requiredDate;
    const leadWarn = !!spec && !!due && due < addDays(today(), Number(spec.lead_time_days));
    return { spec, els, over: els.some((x) => x.over), leadWarn };
  }), [lines, h.requiredDate, project.id, id]);

  const validate = (submit: boolean): Errors => {
    const e: Errors = {};
    if (submit) {
      if (!h.blockId) e.block = 'Block is required';
      if (!h.storeId && !h.location.trim()) e.location = 'Choose a store or type a delivery location';
    }
    if (!h.requiredDate) e.date = 'Required date is required';
    lines.forEach((l, i) => {
      if (!l.specId) e[`line${i}`] = 'Select material and grade';
      else if (!(baseQty(l) > 0)) e[`line${i}`] = 'Enter a quantity greater than zero';
      else if (submit) {
        const q = baseQty(l);
        const sum = l.elements.reduce((s, x) => s + splitQty(l, x), 0);
        if (l.elements.some((x) => !x.elementId)) e[`line${i}`] = 'Select the structural element(s)';
        else if (l.elements.length > 1 && Math.abs(sum - q) > 0.001) e[`line${i}`] = `Element split (${fmtQty(sum)}) must equal the line quantity (${fmtQty(q)})`;
        else if (info[i]?.over && !l.overReason.trim()) e[`line${i}`] = 'Over BoQ — a reason is required';
      }
    });
    if (!lines.length) e.lines = 'Add at least one material';
    return e;
  };

  const disable = useUnsavedGuard(dirty, { what: 'request', onSaveDraft: () => save(false) });

  const save = (submit: boolean) => {
    const e = validate(submit);
    setErrors(e);
    if (Object.keys(e).length) {
      if (e.block || e.location || e.date) setHeaderOpen(true);
      setTimeout(() => form.focusFirstError(e), 50);
      return;
    }
    setBusy(true);
    try {
      const number = editing ? source!.number : nextDocNumber(project.code, 'MR');
      enqueue('save_mr', {
        id, project_id: project.id, number, request_type: 'site_use', block_id: h.blockId ?? null, priority: h.priority, required_date: h.requiredDate!,
        delivery_location: h.location.trim() || undefined, store_id: h.storeId ?? undefined, drawing_ref: h.drawing.trim() || undefined,
        purpose: h.purpose.trim() || undefined, is_lookahead: h.lookahead, device_created_at: new Date().toISOString(), submit,
        ...(params.la_plan ? { lookahead_plan_id: params.la_plan } : null),
        lines: lines.map((l) => ({
          id: l.id, material_spec_id: l.specId!, qty: baseQty(l), required_date: l.requiredDate ?? undefined,
          ...(params.la_item ? { lookahead_item_id: params.la_item } : null),
          remarks: [l.remarks.trim(), l.unit ? `Requested as ${l.qty} ${l.unit}` : ''].filter(Boolean).join(' · ') || undefined,
          over_boq_reason: l.overReason.trim() || undefined,
          elements: l.elements.filter((x) => x.elementId).map((x) => ({ id: x.id, element_id: x.elementId!, qty: splitQty(l, x) })),
        })),
      }, { entityType: 'material_request', entityId: id, label: `${number} ${submit ? 'submitted' : 'saved as draft'}` });
      if (h.blockId) kvSet(`last-block:${project.id}`, h.blockId);
      if (isPlainNew) kvSet(DRAFT_KEY(project.id), null);
      haptic('confirm');
      toast.success(submit ? `${number} submitted · saved on phone` : `${number} saved as draft`);
      setSaved(true);
      disable();
      router.replace(`/requests/${id}`);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  // FR-MR-08: pour/activity template — lines from the element's remaining take-off.
  const fillFromTakeoff = (elementId: string | null) => {
    if (!elementId) return;
    const suggested = list<ElementTakeoff>('element_takeoffs', { parent: elementId }).map((to) => {
      const b = boqBalance(project.id, elementId, to.material_spec_id, id);
      const q = Math.max(b.balance ?? Number(to.planned_qty), 0);
      return { ...newLine(to.material_spec_id, elementId), qty: q > 0 ? String(Math.round(q * 1000) / 1000) : '' };
    }).filter((l) => num(l.qty) > 0);
    if (!suggested.length) { showError(new Error('This element has no remaining take-off quantities.'), 'Nothing to suggest'); return; }
    lastEl.current = elementId;
    setLines((ls) => [...ls.filter((l) => l.specId), ...suggested]);
    toast.success(`${suggested.length} line${suggested.length > 1 ? 's' : ''} added from ${elementLabel(elementId)}`);
  };

  const store = h.storeId ? get<Store>('stores', h.storeId) : null;
  const block = h.blockId ? get<Block>('blocks', h.blockId) : null;
  const attention = lines.filter((_, i) => info[i]?.over || info[i]?.leadWarn || errors[`line${i}`]).length;
  if (source && requestTypeOf(source) === 'purchase') {
    return <Redirect href={`/requests/purchase?${params.id ? 'id' : 'clone'}=${source.id}` as Href} />;
  }
  const title = editing ? `Edit ${source!.number}` : params.clone ? 'Clone request' : h.lookahead ? 'Look-ahead request' : 'New request';
  const headerErr = errors.block || errors.location || errors.date;

  return (
    <Screen form={form} footer={
      <ActionBar
        summary={lines.length ? `${lines.length} line${lines.length > 1 ? 's' : ''}${attention ? ` · ${attention} need${attention > 1 ? '' : 's'} attention` : ''}` : 'No materials yet'}
        warning={attention > 0}
        secondary={{ title: tr('mr.saveDraft'), onPress: () => save(false), busy }}
        primary={{ title: tr('common.submit'), onPress: () => save(true), busy }}
      />
    }>
      <Stack.Screen options={{ title }} />
      {isPlainNew && canFlow(profile.role, 'pr.create') ? (
        <Banner tone="info" icon="cart-outline" text={ft('flow.kindPurchaseHint')}
          actions={[{ label: ft('flow.newPurchase'), onPress: () => { disable(); router.replace('/requests/purchase' as Href); } }]} />
      ) : null}
      {editing && source!.status === 'submitted' ? <Banner tone="info" text="Editing a submitted request sends it back to draft — submit again when done." /> : null}

      {/* Header summary card */}
      {!headerOpen ? (
        <Card onPress={() => setHeaderOpen(true)} stripe={headerErr ? 'danger' : null} accessibilityLabel="Edit request details">
          <Row justify="space-between" align="flex-start">
            <View style={styles.flex}>
              <Text variant="titleSm">{block ? `${block.code} · ${block.name}` : 'Choose block'}{store ? ` · ${store.name}` : h.location ? ` · ${h.location}` : ''}</Text>
              <Text variant="bodySm" tone="muted">
                Needed {h.requiredDate ? fmtDate(h.requiredDate) : '—'} · {h.priority === 'normal' ? 'Normal' : h.priority === 'urgent' ? 'Urgent' : 'Critical path'}
                {h.lookahead ? ' · Look-ahead' : ''}
              </Text>
            </View>
            <Icon name="pencil-outline" size={22} tone="primary" />
          </Row>
        </Card>
      ) : (
        <Card>
          <Row justify="space-between">
            <Text variant="titleSm">Request details</Text>
            {h.blockId ? <Button title="Done" size="sm" variant="ghost" icon="check" onPress={() => setHeaderOpen(false)} /> : null}
          </Row>
          <BlockPicker projectId={project.id} value={h.blockId} onChange={(v) => setH((x) => ({ ...x, blockId: v }))} error={errors.block} name="block" />
          <DateField label={tr('mr.neededOnSite')} value={h.requiredDate} onChange={(v) => setH((x) => ({ ...x, requiredDate: v }))} error={errors.date} name="date"
            minimumDate={new Date()} quick />
          <Segmented<MrPriority> label={tr('mr.priority')} value={h.priority} onChange={(v) => setH((x) => ({ ...x, priority: v }))} options={[
            { value: 'normal', label: 'Normal' }, { value: 'urgent', label: 'Urgent', tone: 'warning' }, { value: 'critical', label: 'Critical', tone: 'danger' },
          ]} />
          <StorePicker projectId={project.id} label={tr('mr.deliverStore')} value={h.storeId} onChange={(v) => setH((x) => ({ ...x, storeId: v }))} allowClear />
          {!h.storeId ? (
            <Field label={tr('mr.location')} value={h.location} onChangeText={(v) => setH((x) => ({ ...x, location: v }))}
              placeholder="e.g. Block A yard, Level 2 deck" error={errors.location} name="location" />
          ) : null}
          <Field label={tr('mr.drawing')} optional value={h.drawing} onChangeText={(v) => setH((x) => ({ ...x, drawing: v }))} placeholder="S-201 Rev C" autoCapitalize="characters" />
          <Field label={tr('mr.purposeRemarks')} optional value={h.purpose} onChangeText={(v) => setH((x) => ({ ...x, purpose: v }))} multiline />
          {profile.role !== 'site_engineer' ? (
            <Segmented label={tr('mr.requestType')} value={h.lookahead ? 'la' : 'now'} onChange={(v) => setH((x) => ({ ...x, lookahead: v === 'la' }))}
              options={[{ value: 'now', label: 'Current works' }, { value: 'la', label: 'Look-ahead' }]} />
          ) : null}
        </Card>
      )}

      <Section title={tr('mr.materials')}>
        {lines.map((l, i) => {
          const inf = info[i];
          const uom = inf?.spec?.uom ?? '';
          const err = errors[`line${i}`];
          const els = l.elements.filter((e) => e.elementId).map((e) => elementLabel(e.elementId));
          return (
            <View key={l.id}>
              <LineCard index={i} title={l.specId ? specLabel(l.specId) : 'Choose material'} qty={l.qty ? `${fmtQty(num(l.qty))} ${l.unit || uom}` : '—'}
                where={els.length ? els.join(', ') : 'No element yet'} err={err ?? null}
                over={!!inf?.over} overReason={l.overReason.trim()} lead={!!inf?.leadWarn} hasBoq={!!inf?.els.some((x) => x.planned != null)}
                onPress={() => setSheet({ index: i, line: l })} />
            </View>
          );
        })}
        {errors.lines ? <Text variant="bodySm" tone="danger">{errors.lines}</Text> : null}
        {!lines.length ? (
          <Card>
            <Text variant="body" tone="muted">Add the materials you need. Use “From element” to fill lines from an element's take-off.</Text>
          </Card>
        ) : null}
        <Row>
          <Button title={tr('mr.addMaterial')} variant="tonal" icon="plus" flex onPress={() => setPickSpec(true)} />
          {!editing ? <Button title={tr('mr.fromElement')} variant="tonal" icon="content-copy" flex onPress={() => setPickTemplate(true)} /> : null}
        </Row>
      </Section>

      {pickSpec ? (
        <SearchSheet visible onClose={() => setPickSpec(false)} title="Add material" options={specOpts} value={null} recentKey="spec" favKey="spec" categories
          onSelect={(sid) => setSheet({ index: null, line: newLine(sid, lastEl.current) })}
          emptyAction={{ label: 'Request new code', onPress: (q) => toast.show({ text: `Ask your office engineer to add “${q}” to the material register.`, tone: 'warning' }) }} />
      ) : null}
      {pickTemplate ? <TemplatePicker projectId={project.id} onPick={fillFromTakeoff} onClose={() => setPickTemplate(false)} /> : null}
      {sheet ? (
        <LineSheet projectId={project.id} mrId={id} initial={sheet.line} isNew={sheet.index == null} headerDate={h.requiredDate}
          onClose={() => setSheet(null)}
          onRemove={() => {
            const idx = sheet.index; const removed = sheet.line;
            setLines((ls) => ls.filter((_, j) => j !== idx));
            setSheet(null);
            toast.show({ text: 'Line removed', action: { label: 'Undo', onPress: () => setLines((ls) => { const c = [...ls]; c.splice(idx ?? c.length, 0, removed); return c; }) } });
          }}
          onSave={(l) => {
            const el = l.elements.find((e) => e.elementId)?.elementId;
            if (el) lastEl.current = el;
            setLines((ls) => (sheet.index == null ? [...ls, l] : ls.map((x, j) => (j === sheet.index ? l : x))));
            setErrors((e) => { const c = { ...e }; delete c.lines; if (sheet.index != null) delete c[`line${sheet.index}`]; return c; });
            setSheet(null);
          }} />
      ) : null}
    </Screen>
  );
}

function LineCard({ index, title, qty, where, err, over, overReason, lead, hasBoq, onPress }: {
  index: number; title: string; qty: string; where: string; err: string | null; over: boolean; overReason: string; lead: boolean; hasBoq: boolean; onPress: () => void;
}) {
  return (
    <View>
      <Card onPress={onPress} dense stripe={err ? 'danger' : over ? 'warning' : null} accessibilityLabel={`Line ${index + 1}: ${title}, ${qty}. Tap to edit.`}>
        <FieldAnchor name={`line${index}`} />
        <Row justify="space-between">
          <Text variant="titleSm" numberOfLines={1} style={styles.flex}>{title}</Text>
          <Text variant="titleSm" num>{qty}</Text>
        </Row>
        <Row justify="space-between">
          <Row gap={4} style={styles.flex}>
            <Icon name="pillar" size={16} tone="muted" />
            <Text variant="bodySm" tone="muted" numberOfLines={1} style={styles.flex}>{where}</Text>
          </Row>
          {err ? <Chip label="Fix" tone="danger" icon="alert-circle-outline" small />
            : over ? <Chip label={overReason ? 'Over BoQ · reason given' : 'Over BoQ · reason needed'} tone="warning" icon="alert-outline" small />
              : hasBoq ? <Chip label={tr('mr.withinBoq')} tone="success" icon="check" small /> : null}
        </Row>
        {lead ? <Text variant="caption" tone="warning">Lead time may be too short</Text> : null}
        {err ? <Text variant="bodySm" tone="danger">{err}</Text> : null}
      </Card>
    </View>
  );
}

/** Registers a zero-size anchor for scroll-to-error inside a card. */
function FieldAnchor({ name }: { name: string }) {
  const ref = useFieldRef(name);
  return <View ref={ref} collapsable={false} style={styles.anchor} />;
}

function TemplatePicker({ projectId, onPick, onClose }: { projectId: string; onPick: (id: string) => void; onClose: () => void }) {
  const opts = useData(() => {
    const withTakeoff = new Set(list<ElementTakeoff>('element_takeoffs', { project: projectId }).map((x) => x.element_id));
    return list<{ id: string; code: string; element_type: string; level_id: string | null; deleted_at: string | null }>('elements', { project: projectId })
      .filter((e) => withTakeoff.has(e.id))
      .map<Option>((e) => ({ id: e.id, code: e.code, label: elementLabel(e.id), sub: `${e.element_type} · take-off available` }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [projectId]);
  return (
    <SearchSheet visible onClose={onClose} title="Fill from element take-off" options={opts} value={null} recentKey={`element:${projectId}`}
      onSelect={onPick} placeholder="Search element, e.g. C12" />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap: { gap: space[2] },
  sheetBody: { paddingHorizontal: space[4], paddingBottom: space[6], gap: space[4] },
  well: { borderRadius: 12, padding: space[3], gap: 2 },
  anchor: { position: 'absolute', top: 0, left: 0, width: 1, height: 1 },
});
