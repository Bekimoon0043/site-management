// Schedule task progress update (schedule-ux.md §7.1): ring + planned marker, % stepper (or BoQ
// quantity stepper for 'units' tasks, step ticks for 'steps'), remaining days, photo, issue chips,
// remarks → report_task_progress (offline). Element-measured tasks are refused by the server, so
// they list their elements and route to the existing element progress flow instead.
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../../lib/app';
import { canSchedule } from '../../../lib/contract-schedule';
import type { RncCode, WeeklyCommitment, LookaheadItem } from '../../../lib/contract-lookahead';
import { list } from '../../../lib/db';
import { plannedPct, taskDetail, weekFor } from '../../../lib/schedule';
import { unitsPct } from '../../../lib/optimistic-schedule';
import { elementLabel, personName } from '../../../lib/queries';
import { enqueue, uuid } from '../../../lib/sync';
import { fmtDate, fmtQty, num, today } from '../../../lib/format';
import { t as tr, useLocale, type TKey } from '../../../lib/i18n';
import { space } from '../../../theme';
import {
  ActionBar, Banner, Card, Chip, ChipGroup, EmptyState, Field, InfoRow, ListRow, PhotoStrip, ProgressBar, ProgressRing,
  QuantityStepper, Row, Screen, Section, Segmented, SyncError, Text, haptic, toast, useForm, useUnsavedGuard, type Errors,
} from '../../../components/ui';

type Issue = 'none' | 'materials' | 'labour' | 'equipment' | 'weather' | 'drawing' | 'other';
const ISSUES: Issue[] = ['none', 'materials', 'labour', 'equipment', 'weather', 'drawing', 'other'];
const ISSUE_RNC: Record<Issue, RncCode | null> = {
  none: null, materials: 'materials', labour: 'labour', equipment: 'equipment', weather: 'weather', drawing: 'design_info', other: 'other',
};
const issueLabel = (i: Issue) => tr(i === 'none' ? 'sch.none' : (`sch.issue.${i}` as TKey));

export default function TaskUpdate() {
  useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, project } = useSession();
  const form = useForm();
  const [reportId] = useState(uuid);
  const d = useData(() => taskDetail(id), [id]);
  const task = d?.task;

  // this week's commitment on the look-ahead item of this task (→ "Done as promised?")
  const commitment = useData(() => {
    const items = list<LookaheadItem>('lookahead_items', { project: project.id }).filter((i) => i.schedule_task_id === id && i.status === 'active');
    for (const i of items) {
      const w = weekFor(i.plan_id, 'this');
      const c = w ? list<WeeklyCommitment>('weekly_commitments', { parent: i.id }).find((x) => x.week_id === w.id && x.kind === 'commitment' && x.outcome === 'pending') : undefined;
      if (c) return c;
    }
    return null;
  }, [id, project.id]);

  const verifiedPct = Number(task?.pct_complete ?? 0);
  const [pct, setPct] = useState(() => String(Math.max(Number(task?.reported_pct ?? 0), verifiedPct)));
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries((d?.boq ?? []).map((b) => [b.link.boq_item_id, String(Math.max(Number(b.link.reported_qty), Number(b.link.verified_qty)))])));
  const [steps, setSteps] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((d?.steps ?? []).map((s) => [s.id, Number(s.reported_pct) >= 100 || Number(s.verified_pct) >= 100])));
  const [remaining, setRemaining] = useState(task?.remaining_days != null ? String(task.remaining_days) : '');
  const [issue, setIssue] = useState<Issue>('none');
  const [remarks, setRemarks] = useState('');
  const [promised, setPromised] = useState<'yes' | 'no' | 'skip'>('skip');
  const [errors, setErrors] = useState<Errors>({});
  const [touched, setTouched] = useState(false);
  const disable = useUnsavedGuard(touched, { what: 'progress update' });
  const touch = <T,>(fn: (v: T) => void) => (v: T) => { setTouched(true); fn(v); };

  const method = task?.ev_method ?? 'pct';
  const newPct = useMemo(() => {
    if (!task) return 0;
    if (method === 'units') return unitsPct(task.id, (d?.boq ?? []).map((b) => ({ boq_item_id: b.link.boq_item_id, qty_to_date: num(qty[b.link.boq_item_id] ?? '') || 0 })));
    if (method === 'steps') {
      const total = (d?.steps ?? []).reduce((s, x) => s + Number(x.weight), 0);
      const done = (d?.steps ?? []).reduce((s, x) => s + (steps[x.id] ? Number(x.weight) : 0), 0);
      return total ? Math.round((10000 * done) / total) / 100 : 0;
    }
    return num(pct);
  }, [task, method, qty, steps, pct, d]);

  if (!d || !task) return <Screen><Stack.Screen options={{ title: tr('sch.update') }} /><EmptyState icon="cloud-off-outline" title={tr('common.notOnPhone')} /></Screen>;

  const planned = plannedPct(task.planned_start, task.planned_finish);
  const canReport = canSchedule(profile.role, 'progress.report');
  const fromElements = method === 'elements';
  const blocked = fromElements || method === 'loe' || task.is_summary;
  const startPct = Number(task.start_pct ?? 50);

  const submit = () => {
    const e: Errors = {};
    const note = remarks.trim();
    if (method === 'units') {
      for (const b of d.boq) {
        const v = num(qty[b.link.boq_item_id] ?? '');
        if (!(v >= 0)) e[`q:${b.link.boq_item_id}`] = tr('sch.enterQty');
        else if ((v < Number(b.link.verified_qty) || v > Number(b.link.qty_share)) && !note) e.remarks = tr('sch.remarkNeeded');
      }
    } else if (method !== 'steps') {
      if (!(newPct >= 0 && newPct <= 100)) e.pct = tr('sch.enterPct');
    }
    if (promised === 'no' && issue === 'none') e.issue = tr('sch.chooseReason');
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    const p = newPct;
    const rem = remaining.trim() ? num(remaining) : undefined;
    enqueue('report_task_progress', {
      id: reportId, task_id: task.id, status_date: today(),
      ...(method === 'units' ? { qty: d.boq.map((b) => ({ boq_item_id: b.link.boq_item_id, qty_to_date: num(qty[b.link.boq_item_id] ?? '') || 0 })) }
        : method === 'steps' ? { steps: d.steps.map((s) => ({ step_id: s.id, done_pct: steps[s.id] ? 100 : 0 })) }
          : { pct_complete: p }),
      ...(!task.actual_start && p > 0 ? { actual_start: today() } : null),
      ...(p >= 100 ? { actual_finish: today(), remaining_days: 0 } : rem != null && rem >= 0 ? { remaining_days: rem } : null),
      delay_cause: issue !== 'none' ? issueLabel(issue) : undefined,
      remarks: note || undefined,
    }, { entityType: 'task_progress', entityId: reportId, label: `${task.name} at ${Math.round(p * 10) / 10}%` });
    if (commitment && promised !== 'skip') {
      enqueue('report_commitment', {
        commitment_id: commitment.id, outcome: promised === 'yes' ? 'completed' : 'not_completed', actual_pct: p,
        ...(promised === 'no' ? { rnc_code: ISSUE_RNC[issue] ?? 'other', rnc_note: note || undefined } : null),
      }, { entityType: 'weekly_commitment', entityId: commitment.id, label: `${task.name} commitment ${promised === 'yes' ? 'completed' : 'not completed'}` });
    }
    haptic('confirm');
    toast.success(tr('sch.saved'));
    disable();
    router.back();
  };

  const footer = canReport && !blocked ? (
    <ActionBar summary={`${Math.round(Number(task.reported_pct ?? verifiedPct) * 10) / 10}% → ${Number.isFinite(newPct) ? Math.round(newPct * 10) / 10 : '—'}%`}
      primary={{ title: tr('sch.report'), variant: 'hero', icon: 'send-outline', onPress: submit }} />
  ) : undefined;

  return (
    <Screen form={form} footer={footer}>
      <Stack.Screen options={{ title: task.name }} />
      <SyncError entityId={reportId} />
      <Card>
        <Row gap={16} align="center">
          <ProgressRing pct={verifiedPct} label={`${Math.round(verifiedPct)}%`} />
          <View style={styles.flex}>
            <Text variant="titleSm">{task.wbs ? `${task.wbs} · ` : ''}{task.name}</Text>
            <Text variant="bodySm" tone="muted">{tr('sch.verified', { p: Math.round(verifiedPct * 10) / 10 })} · {tr('sch.reported', { p: Math.round(Number(task.reported_pct ?? 0) * 10) / 10 })}</Text>
            {planned != null ? <Text variant="bodySm" tone={planned - verifiedPct > 5 ? 'warning' : 'muted'}>{tr('sch.plan', { p: Math.round(planned) })}</Text> : null}
          </View>
        </Row>
        <ProgressBar pct={verifiedPct} planned={planned} />
        <Row wrap gap={6}>
          {task.is_critical ? <Chip label={tr('sch.critical')} tone="warning" icon="lightning-bolt-outline" /> : null}
          {task.is_milestone ? <Chip label={tr('sch.milestone')} tone="info" icon="flag-outline" /> : null}
          {task.total_float_days != null ? <Chip label={`Float ${fmtQty(task.total_float_days, 1)} d`} tone={Number(task.total_float_days) <= 0 ? 'danger' : 'neutral'} icon="timer-sand" /> : null}
        </Row>
        <InfoRow label={tr('sch.planned')} value={`${fmtDate(task.planned_start)} – ${fmtDate(task.planned_finish)}`} />
        {task.forecast_finish ? <InfoRow label={tr('sch.forecast')} value={`${fmtDate(task.forecast_start)} – ${fmtDate(task.forecast_finish)}`}
          tone={task.planned_finish && task.forecast_finish > task.planned_finish ? 'warning' : undefined} /> : null}
      </Card>

      {fromElements ? (
        <>
          <Banner tone="info" icon="pillar" title={tr('sch.elementLinked')} text={tr('sch.elementLinkedBody')} />
          <Card flush>
            {d.elements.map(({ link, el }) => (
              <ListRow key={link.id} id={link.element_id} title={el ? elementLabel(el.id) : '—'} icon="pillar"
                subtitle={el ? `${Math.round(Number(el.progress_pct))}% · ${el.element_type}` : null} status={el?.status ?? null} chevron
                onPress={(eid) => router.push(`/progress/${eid}`)} />
            ))}
          </Card>
        </>
      ) : method === 'loe' ? (
        <Banner tone="info" icon="timer-sand" title={tr('sch.loe')} text={tr('sch.loeBody')} />
      ) : task.is_summary ? (
        <Banner tone="info" icon="layers-outline" title={tr('sch.summary')} />
      ) : canReport ? (
        <>
          <Card>
            {method === 'units' ? d.boq.map(({ link, item }) => (
              <QuantityStepper key={link.id} name={`q:${link.boq_item_id}`} label={`${tr('sch.qtyToDate')} · ${item?.item_no ?? ''} ${item?.description ?? ''}`.trim()}
                unit={item?.unit} value={qty[link.boq_item_id] ?? ''} onChange={touch((v: string) => setQty((s) => ({ ...s, [link.boq_item_id]: v })))}
                fill={{ label: `All ${fmtQty(link.qty_share)}`, value: Number(link.qty_share) }}
                info={tr('sch.ofPlanned', { q: fmtQty(link.qty_share), u: item?.unit ?? '' })} error={errors[`q:${link.boq_item_id}`]} />
            )) : method === 'steps' ? (
              <View style={styles.gap}>
                <Text variant="label">{tr('sch.steps')}</Text>
                {d.steps.map((s) => (
                  <ListRow key={s.id} id={s.id} title={`${s.seq}. ${s.name}`} subtitle={`${fmtQty(s.weight, 1)}%`}
                    icon={steps[s.id] ? 'checkbox-marked' : 'checkbox-blank-outline'} iconTone={steps[s.id] ? 'success' : 'neutral'}
                    onPress={(sid) => { setTouched(true); setSteps((x) => ({ ...x, [sid]: !x[sid] })); }} />
                ))}
              </View>
            ) : method === '0_100' || method === 'milestone' ? (
              <Segmented label={tr('sch.zeroHundred')} value={num(pct) >= 100 ? '100' : '0'} onChange={touch((v: '0' | '100') => setPct(v))}
                options={[{ value: '0', label: tr('sch.notStarted') }, { value: '100', label: tr('sch.finished'), tone: 'success' }]} />
            ) : method === '50_50' ? (
              <Segmented label={tr('sch.startFinish')} value={num(pct) >= 100 ? '100' : num(pct) > 0 ? 's' : '0'}
                onChange={touch((v: '0' | 's' | '100') => setPct(v === 's' ? String(startPct) : v))}
                options={[{ value: '0', label: tr('sch.notStarted') }, { value: 's', label: `${tr('sch.started')} ${startPct}%` }, { value: '100', label: tr('sch.finished'), tone: 'success' }]} />
            ) : (
              <QuantityStepper name="pct" label={tr('sch.percent')} unit="%" step={5} quick={[25, 50, 75, 100]} max={100}
                value={pct} onChange={touch(setPct)} error={errors.pct}
                warning={num(pct) < verifiedPct ? tr('sch.verified', { p: verifiedPct }) : null} />
            )}
            {newPct < 100 ? (
              <QuantityStepper label={tr('sch.remaining')} unit="d" step={1} quick={[1, 2, 5]} value={remaining} onChange={touch(setRemaining)} />
            ) : null}
          </Card>
          <PhotoStrip projectId={project.id} entityType="task_progress" entityId={reportId} />
          <Card>
            <ChipGroup<Issue> label={tr('sch.issue')} value={issue} onChange={touch(setIssue)}
              options={ISSUES.map((i) => ({ value: i, label: issueLabel(i), tone: i === 'none' ? undefined : 'warning' }))} />
            {errors.issue ? <Text variant="caption" tone="danger">{errors.issue}</Text> : null}
            <Field name="remarks" label={tr('sch.note')} optional={!errors.remarks} value={remarks} onChangeText={touch(setRemarks)} error={errors.remarks} multiline />
            {commitment ? (
              <Segmented label={tr('sch.promised')} value={promised} onChange={touch(setPromised)}
                options={[{ value: 'yes', label: tr('sch.yes'), tone: 'success' }, { value: 'no', label: tr('sch.no'), tone: 'danger' }, { value: 'skip', label: tr('la.pending') }]} />
            ) : null}
          </Card>
        </>
      ) : null}

      {d.history.length ? (
        <Section title={tr('sch.history')}>
          <Card flush>
            {d.history.slice(0, 8).map((h) => (
              <ListRow key={h.id} id={h.id} title={`${Math.round(Number(h.pct_complete ?? 0) * 10) / 10}%${h.verified_pct != null ? ` → ${Math.round(Number(h.verified_pct) * 10) / 10}%` : ''}`}
                subtitle={`${fmtDate(h.status_date)} · ${personName(h.reported_by)}${h.remarks ? ` · ${h.remarks}` : ''}`}
                meta={h.verify_comment ?? null} status={h.status} sync={h._pending ? 'pending' : null} icon="progress-check" />
            ))}
          </Card>
        </Section>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap: { gap: space[1] },
});
