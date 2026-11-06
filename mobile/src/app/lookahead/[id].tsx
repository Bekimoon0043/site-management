// Look-ahead item detail (schedule-ux.md §8.2): readiness / constraints (clear, waive with reason,
// owner + due → update_constraint), material needs with stock / PO status and one-tap
// "Request from store" (site-use request prefilled) or "Raise purchase request" (office engineer),
// weekly commitments (commit_lookahead_item, override needs a reason) and outcomes with reason
// chips (report_commitment). Everything is queued offline.
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams, type Href } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import {
  CONSTRAINT_LABELS, CONSTRAINT_STATUS_LABELS, NEED_STATUS_LABELS, RNC_LABELS, canLookahead, readinessOf,
  type ConstraintStatus, type ConstraintType, type LookaheadConstraint, type LookaheadItem, type LookaheadPlan,
  type LookaheadWeek, type NeedStatus, type RncCode, type WeeklyCommitment,
} from '../../lib/contract-lookahead';
import { bump, get } from '../../lib/db';
import { canCommitItem, isOpenConstraint, itemCommitments, itemConstraints, planWeeks, weekFor } from '../../lib/schedule';
import { cachedNeeds, fetchNeeds } from '../../lib/sync-schedule';
import { elementLabel, personName } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { addDays, ago, fmtDate, fmtQty, num, today } from '../../lib/format';
import { t as tr, useLocale } from '../../lib/i18n';
import { space, type Tone } from '../../theme';
import {
  Banner, Button, Card, Chip, ChipGroup, EmptyState, Field, InfoRow, QuantityStepper, Row, Screen, Section, Sheet,
  SyncDot, Text, haptic, showError, toast, type IconName,
} from '../../components/ui';
import { DateField, PersonPicker } from '../../components/pickers';
import { lbl, readinessChip, roleChip } from '../../components/schedule';
import { PhotoStrip } from '../../components/ui';

const CTYPES: ConstraintType[] = ['material', 'predecessor', 'approval', 'inspection', 'information', 'labour', 'equipment', 'space', 'external'];
const RNC: RncCode[] = ['materials', 'prerequisite_work', 'design_info', 'failed_inspection', 'labour', 'equipment', 'weather', 'space_access',
  'approvals', 'client_change', 'bad_planning', 'subcontractor', 'power_water_outage', 'other'];
const STATUS_TONE: Record<ConstraintStatus, Tone> = { open: 'warning', in_progress: 'info', blocked: 'danger', cleared: 'success', waived: 'neutral' };
const NEED_TONE: Record<NeedStatus, { tone: Tone; icon: IconName }> = {
  late_order: { tone: 'danger', icon: 'alert-octagon-outline' }, raise_pr_now: { tone: 'danger', icon: 'cart-plus' },
  to_order: { tone: 'warning', icon: 'cart-outline' }, arrives_late: { tone: 'warning', icon: 'truck-fast-outline' },
  in_procurement: { tone: 'info', icon: 'progress-clock' }, covered: { tone: 'success', icon: 'check-circle-outline' },
};
const OVERRIDE_REASONS = ['Constraint will clear before the work starts', 'Partial work possible', 'Confirmed by phone', 'Coordinator instruction'];

type CSheet =
  | { mode: 'clear' | 'waive' | 'block' | 'edit'; c: LookaheadConstraint }
  | { mode: 'new' };

export default function LookaheadItemDetail() {
  useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, project } = useSession();
  const role = profile.role;
  const d = useData(() => {
    const item = get<LookaheadItem>('lookahead_items', id);
    if (!item) return null;
    const plan = get<LookaheadPlan>('lookahead_plans', item.plan_id);
    const cs = itemConstraints(id);
    const cms = itemCommitments(id).sort((a, b) => a.committed_at.localeCompare(b.committed_at));
    const wk = new Map(planWeeks(item.plan_id).map((w) => [w.id, w]));
    return {
      item, plan, cs, cms, wk, readiness: cs.length ? readinessOf(cs, today()) : item.readiness,
      thisWeek: weekFor(item.plan_id, 'this'), nextWeek: weekFor(item.plan_id, 'next'),
      needs: (cachedNeeds(item.plan_id)?.rows ?? []).filter((n) => n.item_id === id), needsAt: cachedNeeds(item.plan_id)?.at ?? null,
    };
  }, [id]);

  useEffect(() => {
    const planId = d?.item.plan_id;
    if (planId) void fetchNeeds(planId).then(bump).catch(() => undefined);
  }, [d?.item.plan_id]);

  const [cs, setCs] = useState<CSheet | null>(null);
  const [commit, setCommit] = useState<{ week: LookaheadWeek; candidate: WeeklyCommitment | null } | null>(null);
  const [outcome, setOutcome] = useState<WeeklyCommitment | null>(null);

  if (!d) return <Screen><Stack.Screen options={{ title: tr('la.title') }} /><EmptyState icon="cloud-off-outline" title={tr('common.notOnPhone')} /></Screen>;
  const { item, plan, readiness } = d;
  const rc = readinessChip(readiness);
  const cls = roleChip(item.window_role);
  const canConstraint = canLookahead(role, 'lookahead.constraint') && plan?.status !== 'closed';
  const canReport = canLookahead(role, 'lookahead.report');
  const commitTargets = [d.thisWeek, d.nextWeek].filter((w): w is LookaheadWeek => !!w && canCommitItem(item, w, role, profile.id, plan?.status ?? 'draft'));
  const open = d.cs.filter(isOpenConstraint);
  const closed = d.cs.filter((c) => !isOpenConstraint(c));

  const requestFromStore = (n: (typeof d.needs)[number]) => {
    const qty = n.from_stock > 0 ? Math.min(n.window_need, n.from_stock) : n.window_need;
    router.push(`/requests/new?type=site_use&lookahead=1&spec=${n.material_spec_id}&qty=${qty}${item.element_id ? `&element=${item.element_id}` : ''}&la_plan=${item.plan_id}&la_item=${item.id}&need_by=${n.need_by}` as Href);
  };
  const raisePr = (n: (typeof d.needs)[number]) => {
    router.push(`/requests/purchase?spec=${n.material_spec_id}&qty=${n.suggested_qty || n.to_order}${item.element_id ? `&element=${item.element_id}` : ''}&la_plan=${item.plan_id}&la_item=${item.id}&need_by=${n.need_by}` as Href);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: item.name }} />
      <Card stripe={readiness === 'not_ready' ? 'danger' : readiness === 'at_risk' ? 'warning' : 'success'}>
        <Text variant="titleSm">{item.wbs ? `${item.wbs} · ` : ''}{item.name}</Text>
        {item.group_name ? <Text variant="bodySm" tone="muted">{item.group_name}</Text> : null}
        <Row wrap gap={6}>
          <Chip label={rc.label} tone={rc.tone} icon={rc.icon} />
          <Chip label={cls.label} tone={cls.tone} />
          {item.is_critical ? <Chip label={tr('sch.critical')} tone="warning" icon="lightning-bolt-outline" /> : null}
          {item.is_milestone ? <Chip label={tr('sch.milestone')} tone="info" icon="flag-outline" /> : null}
        </Row>
        <InfoRow label={tr('sch.planned')} value={tr('la.window', { s: fmtDate(item.planned_start), f: fmtDate(item.planned_finish) })} />
        <InfoRow label={tr('sch.pctComplete')} value={`${Math.round(Number(item.pct_complete))}%${item.target_pct_end_of_period != null ? ` · ${tr('sch.plan', { p: Math.round(Number(item.target_pct_end_of_period)) })}` : ''}`} />
        <InfoRow label={tr('la.responsible')} value={item.responsible_id ? personName(item.responsible_id) : tr('la.unassigned')} />
        {item.element_id ? <InfoRow label="Element" value={elementLabel(item.element_id)} /> : null}
        <Row wrap gap={8}>
          {item.schedule_task_id ? <Button title={tr('sch.update')} size="sm" variant="tonal" icon="progress-wrench" onPress={() => router.push(`/schedule/task/${item.schedule_task_id}` as Href)} /> : null}
          {item.element_id ? <Button title="Element" size="sm" variant="ghost" icon="pillar" onPress={() => router.push(`/progress/${item.element_id}`)} /> : null}
        </Row>
      </Card>

      <Section title={`${tr('la.constraints')} · ${open.length}`} action={canConstraint ? tr('la.addConstraint') : undefined} onAction={() => setCs({ mode: 'new' })}>
        {open.length ? open.map((c) => (
          <Card key={c.id} stripe={STATUS_TONE[c.status]}>
            <Row justify="space-between" align="flex-start">
              <Text variant="label" style={styles.flex}>{lbl(CONSTRAINT_LABELS[c.ctype])}{c.auto ? ' · auto' : ''}{c.advisory ? ' · advisory' : ''}</Text>
              <SyncDot status={c._pending ? 'pending' : null} />
              <Chip small label={lbl(CONSTRAINT_STATUS_LABELS[c.status])} tone={STATUS_TONE[c.status]} />
            </Row>
            <Text variant="body">{c.description}</Text>
            <InfoRow label={tr('la.owner')} value={c.owner_id ? personName(c.owner_id) : c.owner_role ?? tr('la.unassigned')} />
            <InfoRow label={tr('la.due')} value={fmtDate(c.due_date)} tone={c.due_date && c.due_date < today() ? 'danger' : undefined} />
            {canConstraint ? (
              <Row wrap gap={8}>
                <Button title={tr('la.clear')} size="sm" icon="check" onPress={() => setCs({ mode: 'clear', c })} />
                <Button title={tr('la.waive')} size="sm" variant="outline" onPress={() => setCs({ mode: 'waive', c })} />
                {c.status !== 'blocked' ? <Button title={tr('la.block')} size="sm" variant="dangerOutline" onPress={() => setCs({ mode: 'block', c })} /> : null}
                <Button title={`${tr('la.owner')} / ${tr('la.due')}`} size="sm" variant="ghost" icon="pencil-outline" onPress={() => setCs({ mode: 'edit', c })} />
              </Row>
            ) : null}
          </Card>
        )) : <Banner tone="success" icon="check-circle-outline" text={tr('la.noConstraints')} />}
        {closed.length ? <Text variant="caption" tone="muted">{closed.map((c) => `${lbl(CONSTRAINT_LABELS[c.ctype])}: ${lbl(CONSTRAINT_STATUS_LABELS[c.status])}`).join(' · ')}</Text> : null}
      </Section>

      <Section title={tr('la.materials')}>
        {d.needsAt ? <Text variant="caption" tone="muted">{ago(d.needsAt)}</Text> : <Banner tone="info" icon="cloud-off-outline" text={tr('la.needsOffline')} />}
        {d.needs.length ? d.needs.map((n) => {
          const ns = NEED_TONE[n.need_status] ?? NEED_TONE.covered;
          const short = Math.max(n.short_firm, n.to_order);
          return (
            <Card key={n.material_spec_id} stripe={ns.tone === 'success' ? null : ns.tone}>
              <Row justify="space-between" align="flex-start">
                <Text variant="titleSm" style={styles.flex}>{n.label}</Text>
                <Chip small label={lbl(NEED_STATUS_LABELS[n.need_status])} tone={ns.tone} icon={ns.icon} />
              </Row>
              <InfoRow label={tr('la.need')} value={`${fmtQty(n.window_need)} ${n.uom}`} strong />
              <InfoRow label={tr('la.inStock')} value={`${fmtQty(n.from_stock)} ${n.uom}`} />
              <InfoRow label={tr('la.onOrder')} value={`${fmtQty(n.from_po + n.from_procurement + n.from_pending_pr)} ${n.uom}${n.po_numbers?.length ? ` · ${n.po_numbers.join(', ')}` : ''}${n.next_po_eta ? ` · ${fmtDate(n.next_po_eta)}` : ''}`} />
              {short > 0 ? <InfoRow label={tr('la.short')} value={`${fmtQty(short)} ${n.uom}`} tone="danger" /> : null}
              <Text variant="caption" tone={n.late_order ? 'danger' : 'muted'}>{tr('la.needBy', { d: fmtDate(n.need_by) })}{n.order_by ? ` · order by ${fmtDate(n.order_by)}` : ''}</Text>
              <Row wrap gap={8}>
                {canLookahead(role, 'lookahead.raise_sur') && n.from_stock > 0 ? (
                  <Button title={tr('la.requestStore')} size="sm" icon="clipboard-list-outline" onPress={() => requestFromStore(n)} />
                ) : null}
                {canLookahead(role, 'lookahead.raise_pr') && (n.to_order > 0 || n.raise_pr_now || n.late_order) ? (
                  <Button title={tr('la.raisePr')} size="sm" variant={role === 'office_engineer' ? 'primary' : 'tonal'} icon="cart-plus" onPress={() => raisePr(n)} />
                ) : null}
              </Row>
            </Card>
          );
        }) : d.needsAt ? <Text variant="bodySm" tone="muted">{tr('la.noNeeds')}</Text> : null}
      </Section>

      <Section title={tr('la.commitments')}>
        {d.cms.length ? d.cms.map((c) => {
          const w = d.wk.get(c.week_id);
          const started = !!w && w.week_start <= today() && w.status !== 'closed';
          const tone: Tone = c.outcome === 'completed' ? 'success' : c.outcome === 'not_completed' ? 'danger' : c.kind === 'candidate' ? 'warning' : 'primary';
          return (
            <Card key={c.id} stripe={tone}>
              <Row justify="space-between" align="flex-start">
                <Text variant="label" style={styles.flex}>{w ? `${tr('la.week', { n: w.week_no })} · ${fmtDate(w.week_start)}` : '—'}</Text>
                <SyncDot status={c._pending ? 'pending' : null} />
                <Chip small tone={tone} label={c.kind === 'candidate' ? tr('la.candidate') : c.outcome === 'completed' ? tr('la.completed') : c.outcome === 'not_completed' ? tr('la.notCompleted') : tr('la.committed')} />
              </Row>
              <Text variant="body">{c.description}{c.target_pct != null ? ` · ${Math.round(Number(c.target_pct))}%` : ''}</Text>
              <Text variant="caption" tone="muted">{personName(c.committed_by)}{c.override_reason ? ` · ${c.override_reason}` : ''}</Text>
              {c.rnc_code ? <Text variant="bodySm" tone="danger">{lbl(RNC_LABELS[c.rnc_code])}{c.rnc_note ? ` · ${c.rnc_note}` : ''}</Text> : null}
              {c.kind === 'candidate' && w && canCommitItem(item, w, role, profile.id, plan?.status ?? 'draft') ? (
                <Button title={tr('la.commitThis')} size="sm" icon="calendar-check-outline" onPress={() => setCommit({ week: w, candidate: c })} />
              ) : null}
              {c.kind === 'commitment' && c.outcome === 'pending' && started && canReport
                && (role !== 'site_engineer' || c.committed_by === profile.id || item.responsible_id === profile.id) ? (
                <Row>
                  <Button title={tr('la.notCompleted')} variant="dangerOutline" flex onPress={() => setOutcome(c)} />
                  <Button title={tr('la.completed')} icon="check" flex onPress={() => {
                    enqueue('report_commitment', { commitment_id: c.id, outcome: 'completed', actual_pct: Number(item.pct_complete) },
                      { entityType: 'weekly_commitment', entityId: c.id, label: `${item.name} completed` });
                    haptic('confirm'); toast.success(tr('la.outcomeSaved'));
                  }} />
                </Row>
              ) : null}
            </Card>
          );
        }) : <Text variant="bodySm" tone="muted">{tr('la.notCommitted')}</Text>}
        {commitTargets.filter((w) => !d.cms.some((c) => c.week_id === w.id)).map((w) => (
          <Button key={w.id} title={w.id === d.nextWeek?.id ? tr('la.commitNext') : tr('la.commitThis')} block
            variant={readiness === 'ready' ? 'hero' : 'outline'} icon="calendar-check-outline" onPress={() => setCommit({ week: w, candidate: null })} />
        ))}
        {d.nextWeek && !commitTargets.length && canLookahead(role, 'lookahead.commit') && plan?.status === 'published' ? (
          <Text variant="caption" tone="muted">{tr('la.locked')}</Text>
        ) : null}
      </Section>

      <Section title="Photos">
        <PhotoStrip projectId={project.id} entityType="lookahead_item" entityId={item.id} canAdd={role !== 'store_keeper' && role !== 'security'} />
      </Section>

      {cs ? <ConstraintSheet s={cs} item={item} projectId={project.id} onClose={() => setCs(null)} /> : null}
      {commit ? <CommitSheet week={commit.week} candidate={commit.candidate} item={item} ready={readiness === 'ready'} onClose={() => setCommit(null)} /> : null}
      {outcome ? <OutcomeSheet c={outcome} item={item} onClose={() => setOutcome(null)} /> : null}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

function ConstraintSheet({ s, item, projectId, onClose }: { s: CSheet; item: LookaheadItem; projectId: string; onClose: () => void }) {
  const c = s.mode === 'new' ? null : s.c;
  const [ctype, setCtype] = useState<ConstraintType>('material');
  const [desc, setDesc] = useState('');
  const [owner, setOwner] = useState<string | null>(c?.owner_id ?? null);
  const [due, setDue] = useState<string | null>(c?.due_date ?? (item.planned_start ? addDays(item.planned_start, -2) : null));
  const [comment, setComment] = useState('');
  const needComment = s.mode === 'waive' || (s.mode === 'clear' && !!c?.auto && c.ctype === 'material');
  const title = s.mode === 'new' ? tr('la.addConstraint') : s.mode === 'clear' ? tr('la.clear') : s.mode === 'waive' ? tr('la.waive') : s.mode === 'block' ? tr('la.block') : `${tr('la.owner')} / ${tr('la.due')}`;

  const save = () => {
    if (s.mode === 'new' && !desc.trim()) { showError(new Error(tr('la.description'))); return; }
    if (needComment && !comment.trim()) { showError(new Error(s.mode === 'waive' ? tr('la.waiveReason') : tr('la.clearComment'))); return; }
    const cid = c?.id ?? uuid();
    const status: ConstraintStatus | undefined = s.mode === 'clear' ? 'cleared' : s.mode === 'waive' ? 'waived' : s.mode === 'block' ? 'blocked' : undefined;
    enqueue('update_constraint', {
      id: cid,
      ...(s.mode === 'new' ? { item_id: item.id, ctype, description: desc.trim() } : null),
      ...(s.mode === 'new' || s.mode === 'edit' ? { owner_id: owner, ...(due ? { due_date: due } : null) } : null),
      ...(status ? { status } : null),
      comment: comment.trim() || undefined,
    }, { entityType: 'lookahead_constraint', entityId: cid, label: `${item.name}: ${title}` });
    haptic(s.mode === 'block' ? 'reject' : 'confirm');
    toast.success(tr('la.constraintSaved'));
    onClose();
  };

  return (
    <Sheet visible onClose={onClose} title={title} subtitle={c?.description ?? item.name}
      footer={<Button title={title} block variant={s.mode === 'block' ? 'danger' : 'primary'} onPress={save} />}>
      <View style={styles.sheet}>
        {s.mode === 'new' ? (
          <>
            <ChipGroup<ConstraintType> label={tr('la.type')} value={ctype} onChange={setCtype} options={CTYPES.map((x) => ({ value: x, label: lbl(CONSTRAINT_LABELS[x]) }))} />
            <Field label={tr('la.description')} value={desc} onChangeText={setDesc} multiline />
          </>
        ) : null}
        {s.mode === 'new' || s.mode === 'edit' ? (
          <>
            <PersonPicker projectId={projectId} label={tr('la.owner')} value={owner} onChange={setOwner} allowClear optional />
            <DateField label={tr('la.due')} value={due} onChange={setDue} optional />
          </>
        ) : null}
        {s.mode !== 'edit' ? (
          <Field label={s.mode === 'waive' ? tr('la.waiveReason') : s.mode === 'clear' ? tr('la.clearComment') : tr('sch.comment')}
            optional={!needComment} value={comment} onChangeText={setComment} multiline />
        ) : null}
      </View>
    </Sheet>
  );
}

function CommitSheet({ week, candidate, item, ready, onClose }: { week: LookaheadWeek; candidate: WeeklyCommitment | null; item: LookaheadItem; ready: boolean; onClose: () => void }) {
  const [desc, setDesc] = useState(candidate?.description ?? item.name);
  const [target, setTarget] = useState(candidate?.target_pct != null ? String(candidate.target_pct) : '');
  const [reason, setReason] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const overrideText = reason === '__other' ? other.trim() : reason ?? '';
  const reasons = useMemo(() => [...OVERRIDE_REASONS.map((r) => ({ value: r, label: r })), { value: '__other', label: tr('sch.issue.other') }], []);
  const save = () => {
    if (!ready && !overrideText) { showError(new Error(tr('la.overrideReason'))); return; }
    const t = target.trim() ? num(target) : undefined;
    if (t != null && !(t >= 0 && t <= 100)) { showError(new Error(tr('sch.enterPct'))); return; }
    const cid = candidate?.id ?? uuid();
    enqueue('commit_lookahead_item', {
      id: cid, item_id: item.id, week_id: week.id, description: desc.trim() || item.name,
      ...(t != null ? { target_pct: t } : null), ...(!ready ? { override_reason: overrideText } : null),
    }, { entityType: 'weekly_commitment', entityId: cid, label: `${item.name} committed for week ${week.week_no}` });
    haptic('confirm');
    toast.success(tr('la.commitSaved'));
    onClose();
  };
  return (
    <Sheet visible onClose={onClose} title={`${tr('la.week', { n: week.week_no })} · ${fmtDate(week.week_start)}`} subtitle={item.name}
      footer={<Button title={ready ? tr('la.committed') : tr('la.override')} block variant={ready ? 'hero' : 'outline'} icon="calendar-check-outline" onPress={save} />}>
      <View style={styles.sheet}>
        <Field label={tr('la.description')} value={desc} onChangeText={setDesc} multiline />
        <QuantityStepper label={tr('la.targetPct')} unit="%" step={5} quick={[25, 50, 75, 100]} max={100} value={target} onChange={setTarget} />
        {!ready ? (
          <>
            <Banner tone="warning" icon="alert-outline" text={tr('la.overrideReason')} />
            <ChipGroup value={reason} onChange={setReason} options={reasons} />
            {reason === '__other' ? <Field label={tr('la.overrideReason')} value={other} onChangeText={setOther} /> : null}
          </>
        ) : null}
      </View>
    </Sheet>
  );
}

function OutcomeSheet({ c, item, onClose }: { c: WeeklyCommitment; item: LookaheadItem; onClose: () => void }) {
  const [code, setCode] = useState<RncCode | null>(null);
  const [note, setNote] = useState('');
  const [pct, setPct] = useState(String(Math.round(Number(item.pct_complete))));
  const save = () => {
    if (!code) { showError(new Error(tr('sch.chooseReason'))); return; }
    enqueue('report_commitment', { commitment_id: c.id, outcome: 'not_completed', rnc_code: code, rnc_note: note.trim() || undefined, actual_pct: num(pct) || undefined },
      { entityType: 'weekly_commitment', entityId: c.id, label: `${item.name} not completed` });
    haptic('reject');
    toast.success(tr('la.outcomeSaved'));
    onClose();
  };
  return (
    <Sheet visible onClose={onClose} title={tr('la.why')} subtitle={c.description} full
      footer={<Button title={tr('la.notCompleted')} block variant="danger" onPress={save} />}>
      <View style={styles.sheet}>
        <ChipGroup<RncCode> value={code} onChange={setCode} options={RNC.map((r) => ({ value: r, label: lbl(RNC_LABELS[r]) }))} />
        <QuantityStepper label={tr('sch.percent')} unit="%" step={5} quick={[]} max={100} value={pct} onChange={setPct} />
        <Field label={tr('sch.note')} optional value={note} onChangeText={setNote} multiline />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sheet: { paddingHorizontal: space[4], paddingBottom: space[3], gap: space[3] },
});
