// Element detail + progress update (spec §5.4): ring with planned marker, activity rows with
// hold-point locks, % chips + stepper, photos, issue-on-site chips, sticky "62% → 75% [Report ▸]".
// ?photo=1 opens the camera first (photo-first update). The report_progress payload is unchanged.
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get, list } from '../../lib/db';
import { can, type Element, type ElementActivity, type ProgressUpdate } from '../../lib/contract';
import { elementConsumption, elementLabel, personName, specLabel, specUom } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { capturePhoto } from '../../lib/photos';
import { fmtDate, fmtQty, num, today } from '../../lib/format';
import { t as tr, useLocale } from '../../lib/i18n';
import { space, useTheme } from '../../theme';
import {
  ActionBar, Banner, Button, Card, Chip, ChipGroup, EmptyState, Field, Icon, InfoRow, PhotoStrip, ProgressBar, ProgressRing,
  QuantityStepper, Row, Screen, Section, StatusChip, SyncDot, Text, haptic, showError, toast, useForm, type Errors,
} from '../../components/ui';
import { DateField } from '../../components/pickers';
import { ElementQuality } from '../../components/ElementQuality';

const ISSUES = ['None', 'Weather', 'Materials', 'Labour', 'Equipment', 'Other…'];

function plannedPct(start: string | null, finish: string | null): number | null {
  if (!start || !finish) return null;
  const s = new Date(`${start}T00:00:00`).getTime();
  const f = new Date(`${finish}T00:00:00`).getTime();
  if (f <= s) return Date.now() >= f ? 100 : 0;
  return Math.max(0, Math.min(100, ((Date.now() - s) / (f - s)) * 100));
}

export default function ElementDetail() {
  useLocale();
  const t = useTheme();
  const { id, photo } = useLocalSearchParams<{ id: string; photo?: string }>();
  const { profile, project } = useSession();
  const form = useForm();
  const [actId, setActId] = useState<string | null>(null);
  const [updateId, setUpdateId] = useState(uuid);
  const [pct, setPct] = useState('');
  const [qty, setQty] = useState('');
  const [uom, setUom] = useState('m3');
  const [showQty, setShowQty] = useState(false);
  const [date, setDate] = useState<string | null>(today());
  const [issue, setIssue] = useState<string>('None');
  const [remarks, setRemarks] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const photoDone = useRef(false);

  const d = useData(() => {
    const e = get<Element>('elements', id);
    const acts = list<ElementActivity>('element_activities', { parent: id }).sort((a, b) => a.seq - b.seq);
    const updates = list<ProgressUpdate>('progress_updates', { parent: id }).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const consumption = e ? elementConsumption(e.project_id, id) : [];
    return { e, acts, updates, consumption };
  }, [id]);

  const canReport = can(profile.role, 'progress.report');
  // FR-PG-05: an activity after an unsigned hold point is blocked.
  const blockedBy = (a: ElementActivity) => d.acts.find((x) => x.seq < a.seq && x.is_hold_point && Number(x.verified_pct) < 100);

  // Default activity: first one that is not complete and not blocked.
  useEffect(() => {
    if (actId || !canReport) return;
    const first = d.acts.find((a) => Number(a.reported_pct) < 100 && !blockedBy(a));
    if (first) setActId(first.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.acts.length]);

  useEffect(() => {
    if (photo && !photoDone.current && d.e && canReport) {
      photoDone.current = true;
      void capturePhoto({ projectId: d.e.project_id, entityType: 'progress_update', entityId: updateId }, 'camera').catch(showError);
    }
  }, [photo, d.e, canReport, updateId]);

  if (!d.e) return <Screen><Stack.Screen options={{ title: tr('progress.element') }} /><EmptyState icon="pillar" title="Element not found on this phone" /></Screen>;
  const e = d.e;
  const delayed = !!e.planned_finish && e.planned_finish < today() && e.status !== 'completed';
  const planned = plannedPct(e.planned_start, e.planned_finish);
  const progress = Number(e.progress_pct);
  const behind = planned != null ? planned - progress : null;
  const act = d.acts.find((x) => x.id === actId) ?? null;
  const fromPct = act ? Number(act.reported_pct) : 0;

  const report = () => {
    const errs: Errors = {};
    if (!act) errs.act = 'Choose the activity';
    const p = num(pct);
    if (!(p >= 0 && p <= 100) || pct.trim() === '') errs.pct = 'Percent complete must be between 0 and 100';
    const b = act ? blockedBy(act) : undefined;
    if (b && p > 0) errs.act = `Hold point "${b.name}" must be signed off first`;
    if (issue === 'Other…' && !remarks.trim()) errs.remarks = 'Describe the issue on site';
    setErrors(errs);
    if (Object.keys(errs).length) { form.focusFirstError(errs); return; }
    try {
      const note = [issue !== 'None' && issue !== 'Other…' ? `Issue: ${issue}` : '', remarks.trim()].filter(Boolean).join(' · ');
      enqueue('report_progress', {
        id: updateId, element_activity_id: act!.id, report_date: date ?? today(), pct_complete: p,
        qty_achieved: qty.trim() ? num(qty) : undefined, uom: qty.trim() ? uom : undefined, remarks: note || undefined,
      }, { entityType: 'progress_update', entityId: updateId, label: `${e.code} ${act!.name} ${p}%` });
      haptic('confirm');
      toast.success(`${act!.name} ${p}% reported · saved on phone`);
      setUpdateId(uuid()); setPct(''); setQty(''); setRemarks(''); setIssue('None'); setActId(null); setShowQty(false);
    } catch (err) { showError(err); }
  };

  return (
    <Screen form={form} footer={canReport && act ? (
      <ActionBar summary={`${act.name}: ${fromPct}% → ${pct.trim() ? `${num(pct)}%` : '…'}`} primary={{ title: tr('progress.reportBtn'), onPress: report }} />
    ) : undefined}>
      <Stack.Screen options={{ title: elementLabel(e.id) }} />
      <Card>
        <Row align="center" gap={space[4]}>
          <ProgressRing pct={progress} />
          <View style={styles.flex}>
            <Text variant="titleSm">{e.code} · {e.element_type}</Text>
            <Row wrap gap={6}>
              {delayed ? <Chip label={tr('status.delayed')} tone="danger" icon="clock-alert-outline" /> : <StatusChip status={e.status} />}
              {behind != null && behind > 5 ? <Chip label={`Behind ${Math.round(behind)}%`} tone="warning" icon="alert-outline" /> : null}
            </Row>
            {planned != null ? <Text variant="bodySm" tone="muted">Planned {Math.round(planned)}% by today</Text> : null}
          </View>
        </Row>
        <ProgressBar pct={progress} planned={planned} showLabel />
        <InfoRow label={tr('progress.planned')} value={`${fmtDate(e.planned_start)} → ${fmtDate(e.planned_finish)}`} />
        <InfoRow label={tr('progress.actual')} value={`${fmtDate(e.actual_start)} → ${fmtDate(e.actual_finish)}`} />
        {e.grid ? <InfoRow label="Grid" value={e.grid} /> : null}
        {e.drawing_ref ? <InfoRow label="Drawing" value={e.drawing_ref} /> : null}
        {e.dimensions ? <InfoRow label="Dimensions" value={e.dimensions} /> : null}
      </Card>

      <Section title={tr('progress.activities')}>
        {d.acts.length ? (
          <Card flush>
            {d.acts.map((a, i) => {
              const blocked = blockedBy(a);
              const sel = actId === a.id;
              const done = Number(a.verified_pct) >= 100;
              return (
                <Pressable key={a.id} disabled={!canReport} onPress={() => { setActId(a.id); setErrors({}); }}
                  accessibilityRole="radio" accessibilityState={{ selected: sel, disabled: !canReport }}
                  android_ripple={{ color: t.ripple }}
                  style={[styles.act, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: t.border }, sel && { backgroundColor: t.primaryContainer }]}>
                  <Icon name={done ? 'checkbox-marked' : sel ? 'radiobox-marked' : blocked ? 'lock-outline' : 'radiobox-blank'} size={24}
                    tone={done ? 'success' : sel ? 'primary' : 'muted'} />
                  <View style={styles.flex}>
                    <Text variant="body" weight="600">{a.seq}. {a.name}</Text>
                    <Text variant="caption" tone="muted">Verified {Number(a.verified_pct)}% · reported {Number(a.reported_pct)}% · weight {a.weight}</Text>
                    {blocked ? <Text variant="caption" tone="warning">Blocked until “{blocked.name}” is signed off</Text> : null}
                  </View>
                  {a.is_hold_point ? <Chip label={done ? 'Hold point signed' : 'Hold point'} tone={done ? 'success' : 'warning'} icon="hand-back-left-outline" small /> : null}
                </Pressable>
              );
            })}
          </Card>
        ) : <EmptyState icon="format-list-checks" title="No activity sequence" body="This element type has no activity template yet." compact />}
        {errors.act ? <Text variant="bodySm" tone="danger">{errors.act}</Text> : null}
      </Section>

      {canReport && act ? (
        <Card>
          <Text variant="titleSm">Update: {act.name}</Text>
          <ChipGroup value={['25', '50', '75', '100'].includes(pct) ? pct : null} onChange={setPct}
            options={['25', '50', '75', '100'].map((v) => ({ value: v, label: `${v}%` }))} />
          <QuantityStepper label={tr('progress.percent')} unit="%" value={pct} onChange={setPct} step={5} quick={[]} max={100}
            fill={fromPct > 0 ? { label: 'Last', value: fromPct } : null} error={errors.pct} name="pct" />
          <PhotoStrip projectId={e.project_id} entityType="progress_update" entityId={updateId} label={tr('progress.photos')} />
          <ChipGroup label={tr('progress.issueOnSite')} value={issue} onChange={setIssue} options={ISSUES.map((v) => ({ value: v, label: v }))} />
          <Field label={issue === 'Other…' ? 'Describe the issue' : 'Note'} optional={issue !== 'Other…'} value={remarks} onChangeText={setRemarks}
            multiline error={errors.remarks} name="remarks" />
          <DateField label={tr('progress.reportDate')} value={date} onChange={setDate} />
          {showQty ? (
            <View style={styles.gap}>
              <Field label={tr('progress.qtyAchieved')} optional value={qty} onChangeText={setQty} keyboardType="decimal-pad" />
              <ChipGroup label="Unit" value={uom} onChange={setUom} options={['m3', 'm2', 'kg', 'm', 'nr'].map((u) => ({ value: u, label: u }))} />
            </View>
          ) : <Button title={tr('progress.qtyAchieved')} size="sm" variant="ghost" icon="plus" onPress={() => setShowQty(true)} />}
        </Card>
      ) : canReport ? <Banner tone="info" text="Tap an activity to report today's progress." /> : null}

      <ElementQuality elementId={e.id} />

      <Section title={tr('progress.materialsPvI')}>
        {d.consumption.length ? d.consumption.map((c) => {
          const variance = c.planned && progress > 0 ? (c.issued / (c.planned * progress / 100) - 1) * 100 : null;
          return (
            <Card key={c.specId} dense>
              <Text variant="label">{specLabel(c.specId)}</Text>
              <InfoRow label="Take-off" value={c.planned == null ? '—' : `${fmtQty(c.planned)} ${specUom(c.specId)}`} />
              <InfoRow label="Issued (net of returns)" value={`${fmtQty(c.issued)} ${specUom(c.specId)}`} />
              {variance != null ? <InfoRow label="Variance vs work done" value={`${variance > 0 ? '+' : ''}${variance.toFixed(1)}%`}
                tone={variance > 3 ? 'danger' : 'success'} icon={variance > 3 ? 'alert-outline' : 'check'} /> : null}
            </Card>
          );
        }) : <Text variant="bodySm" tone="muted">No take-off or issues recorded.</Text>}
      </Section>

      <Section title={tr('progress.history')}>
        {d.updates.length ? d.updates.map((u) => (
          <Card key={u.id} dense>
            <Row justify="space-between">
              <Row gap={6} style={styles.flex}>
                <Text variant="label" numberOfLines={1} style={styles.flex}>{d.acts.find((a) => a.id === u.element_activity_id)?.name ?? 'Activity'} — {Number(u.pct_complete)}%</Text>
                <SyncDot status={u._pending ? 'pending' : null} />
              </Row>
              <StatusChip status={u.status} small />
            </Row>
            <Text variant="caption" tone="muted">{fmtDate(u.report_date)} · {personName(u.reported_by)}{u.qty_achieved ? ` · ${fmtQty(u.qty_achieved)} ${u.uom ?? ''}` : ''}</Text>
            {u.remarks ? <Text variant="bodySm">{u.remarks}</Text> : null}
            {u.verified_by ? <Text variant="caption" tone="muted">Verified {u.verified_pct ?? '—'}% by {personName(u.verified_by)}{u.verify_comment ? ` — “${u.verify_comment}”` : ''}</Text> : null}
          </Card>
        )) : <Text variant="bodySm" tone="muted">No progress reported yet.</Text>}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap: { gap: space[2] },
  act: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 56, paddingHorizontal: space[4], paddingVertical: space[2] },
});
