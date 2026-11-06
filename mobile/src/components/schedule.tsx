// Schedule progress + look-ahead building blocks (docs/research/schedule-ux.md §6.5, §7.1, §8.2):
// "My tasks" agenda, task-progress verification cards, the progress overview card and Home tasks.
import React, { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useSession } from '../lib/app';
import type { AppRole, BoqItem } from '../lib/contract';
import { canSchedule, evmBand, type EvmBand, type ProgressOverview, type ScheduleTask, type TaskBoqLink } from '../lib/contract-schedule';
import { canLookahead, READINESS_LABELS, WINDOW_ROLE_LABELS, type Readiness, type WindowRole } from '../lib/contract-lookahead';
import { get, list } from '../lib/db';
import { syncStatusMap, type ScheduleCounts } from '../lib/counts';
import { taskAgenda, tasksToVerify, type TaskRow } from '../lib/schedule';
import { cachedOverview } from '../lib/sync-schedule';
import { personName } from '../lib/queries';
import { enqueue } from '../lib/sync';
import { fmtDate, fmtQty, num } from '../lib/format';
import { getLocale, t as tr, useLocale } from '../lib/i18n';
import { space, useTheme, type Tone } from '../theme';
import {
  Banner, Button, Card, Chip, ChipGroup, EmptyState, Field, InfoRow, PhotoStrip, ProgressBar, QuantityStepper, ReasonSheet, Row, Section,
  SyncDot, Text, haptic, showError, toast, type IconName,
} from './ui';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** en / am label record → current locale. */
export const lbl = (x: { en: string; am: string }) => (getLocale() === 'am' ? x.am : x.en);
export const READINESS_CHIP: Record<Readiness, { tone: Tone; icon: IconName }> = {
  ready: { tone: 'success', icon: 'check-circle-outline' },
  at_risk: { tone: 'warning', icon: 'alert-outline' },
  not_ready: { tone: 'danger', icon: 'alert-octagon-outline' },
};
export const readinessChip = (r: Readiness) => ({ label: lbl(READINESS_LABELS[r]), ...READINESS_CHIP[r] });
export const ROLE_TONE: Record<WindowRole, Tone> = {
  starting: 'info', ongoing: 'primary', finishing: 'success', starting_next: 'neutral', late: 'danger', manual: 'violet',
};
export const roleChip = (r: WindowRole) => ({ label: lbl(WINDOW_ROLE_LABELS[r]), tone: ROLE_TONE[r] });

export const BAND: Record<EvmBand, { tone: Tone; icon: IconName; key: 'sch.onTrack' | 'sch.behind' | 'sch.late' | 'sch.ahead' }> = {
  ok: { tone: 'success', icon: 'check-circle-outline', key: 'sch.onTrack' },
  warning: { tone: 'warning', icon: 'alert-outline', key: 'sch.behind' },
  critical: { tone: 'danger', icon: 'alert-octagon-outline', key: 'sch.late' },
  info: { tone: 'info', icon: 'arrow-up-bold', key: 'sch.ahead' },
};

const pctTxt = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(Number(n) * 10) / 10}`);

// ---------------------------------------------------------------------------
// My tasks agenda (Progress tab › Schedule)
// ---------------------------------------------------------------------------

type Entry = { type: 'head'; key: string; title: string; tone: Tone; n: number } | { type: 'task'; key: string; r: TaskRow };

const TaskAgendaRow = memo(function TaskAgendaRow({ r, onOpen }: { r: TaskRow; onOpen: (id: string) => void }) {
  const t = useTheme();
  const stripe = r.section === 'overdue' ? t.danger : r.critical ? t.warning : null;
  return (
    <Pressable onPress={() => onOpen(r.id)} android_ripple={{ color: t.ripple }} accessibilityRole="button"
      accessibilityLabel={`${r.name}, ${Math.round(r.pct)} percent`} style={[styles.row, { backgroundColor: t.surface, borderBottomColor: t.border }]}>
      {stripe ? <View style={[styles.stripe, { backgroundColor: stripe }]} /> : null}
      <View style={styles.body}>
        <View style={styles.top}>
          <Text variant="titleSm" numberOfLines={2} style={styles.flex}>{r.milestone ? `${tr('sch.milestone')} · ` : ''}{r.name}</Text>
          <SyncDot status={r.sync} />
        </View>
        <Text variant="bodySm" tone="muted" numberOfLines={1}>
          {r.wbs ? `${r.wbs} · ` : ''}{fmtDate(r.start)} – {fmtDate(r.finish)}
        </Text>
        <ProgressBar pct={r.pct} planned={r.planned} showLabel />
        <View style={styles.chips}>
          {r.section === 'overdue' ? <Chip small label={tr('sch.daysLate', { n: r.lateDays })} tone="danger" icon="clock-alert-outline" /> : null}
          {r.critical ? <Chip small label={tr('sch.critical')} tone="warning" icon="lightning-bolt-outline" /> : null}
          {r.reported > r.pct || r.toVerify ? <Chip small label={tr('sch.reported', { p: pctTxt(r.reported) })} tone="info" icon="progress-clock" /> : null}
          {r.method === 'elements' ? <Chip small label={tr('sch.fromElements')} tone="neutral" icon="pillar" /> : null}
          {r.planned != null ? <Text variant="caption" tone="muted">{tr('sch.plan', { p: Math.round(r.planned) })}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
});

const Header = memo(function Header({ title, tone, n }: { title: string; tone: Tone; n: number }) {
  const t = useTheme();
  return (
    <View style={[styles.head, { backgroundColor: t.background }]}>
      <Text variant="label" tone={tone === 'danger' ? 'danger' : 'muted'}>{title} · {n}</Text>
    </View>
  );
});

export function MyTasksList({ header }: { header?: React.ReactNode }) {
  const { profile, project } = useSession();
  const { locale } = useLocale();
  const [scope, setScope] = useState<'mine' | 'all'>(profile.role === 'site_engineer' ? 'mine' : 'all');
  const [section, setSection] = useState<'all' | 'overdue' | 'this' | 'next'>('all');
  const d = useData(() => taskAgenda(project.id, profile.id, scope === 'mine', syncStatusMap()), [project.id, profile.id, scope, locale]);
  const entries = useMemo(() => {
    const out: Entry[] = [];
    const groups: { s: TaskRow['section']; title: string; tone: Tone }[] = [
      { s: 'overdue', title: tr('sch.overdue'), tone: 'danger' }, { s: 'this', title: tr('sch.thisWeek'), tone: 'neutral' },
      { s: 'next', title: tr('sch.nextWeek'), tone: 'neutral' },
    ];
    for (const g of groups) {
      if (section !== 'all' && section !== g.s) continue;
      const rs = d.rows.filter((r) => r.section === g.s);
      if (!rs.length) continue;
      out.push({ type: 'head', key: `h:${g.s}`, title: g.title, tone: g.tone, n: rs.length });
      rs.forEach((r) => out.push({ type: 'task', key: r.id, r }));
    }
    return out;
  }, [d, section, locale]);
  const open = useCallback((id: string) => router.push(`/schedule/task/${id}` as Href), []);
  const counts = { overdue: d.rows.filter((r) => r.section === 'overdue').length, this: d.rows.filter((r) => r.section === 'this').length, next: d.rows.filter((r) => r.section === 'next').length };
  return (
    <FlashList
      data={entries}
      keyExtractor={(e) => e.key}
      getItemType={(e) => e.type}
      ListHeaderComponent={
        <View style={styles.listHead}>
          {header}
          <ChipGroup scroll value={section} onChange={setSection} options={[
            { value: 'all', label: tr('common.all') },
            { value: 'overdue', label: tr('sch.overdue'), count: counts.overdue, tone: 'danger' },
            { value: 'this', label: tr('sch.thisWeek'), count: counts.this },
            { value: 'next', label: tr('sch.nextWeek'), count: counts.next },
          ]} />
          <ChipGroup value={scope} onChange={setScope} options={[{ value: 'mine', label: tr('sch.mine'), icon: 'account-hard-hat-outline' }, { value: 'all', label: tr('sch.all') }]} />
          {scope === 'mine' && d.assigned === 0 && d.rows.length ? <Text variant="caption" tone="muted">{tr('sch.noAssigned')}</Text> : null}
          <Row gap={8} wrap>
            <Button title={tr('la.title')} size="sm" variant="tonal" icon="calendar-month-outline" onPress={() => router.push('/lookahead' as Href)} />
            {canSchedule(profile.role, 'progress.verify') ? (
              <Button title={tr('sch.verifyTitle')} size="sm" variant="tonal" icon="shield-check-outline" onPress={() => router.push('/schedule/verify' as Href)} />
            ) : null}
          </Row>
        </View>
      }
      renderItem={({ item }) => (item.type === 'head'
        ? <Header title={item.title} tone={item.tone} n={item.n} />
        : <TaskAgendaRow r={item.r} onOpen={open} />)}
      ListEmptyComponent={<EmptyState icon="chart-gantt" title={tr('sch.noTasks')} body={tr('sch.noTasksBody')} compact />}
      contentContainerStyle={styles.list}
    />
  );
}

// ---------------------------------------------------------------------------
// Task progress verification (office engineer and up)
// ---------------------------------------------------------------------------

type Report = ReturnType<typeof tasksToVerify>[number];

function VerifyCard({ u }: { u: Report }) {
  const task = get<ScheduleTask>('schedule_tasks', u.task_id);
  const links = useMemo(() => list<TaskBoqLink>('task_boq_links', { parent: u.task_id }).filter((l) => !l.deleted_at), [u.task_id]);
  const units = task?.ev_method === 'units' && !!u.qty?.length;
  const [pct, setPct] = useState(String(Number(u.pct_complete ?? 0)));
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries((u.qty ?? []).map((q) => [q.boq_item_id, String(q.qty_to_date)])));
  const [comment, setComment] = useState('');
  const [reject, setReject] = useState(false);

  const changed = units
    ? (u.qty ?? []).some((q) => num(qty[q.boq_item_id] ?? '') !== Number(q.qty_to_date))
    : num(pct) !== Number(u.pct_complete ?? 0);
  const approve = () => {
    const p = num(pct);
    if (!units && !(p >= 0 && p <= 100)) { showError(new Error(tr('sch.enterPct'))); return; }
    if (changed && !comment.trim()) { showError(new Error(tr('sch.commentNeeded'))); return; }
    enqueue('verify_task_progress', {
      progress_id: u.id, approve: true,
      ...(units ? { verified_qty: (u.qty ?? []).map((q) => ({ boq_item_id: q.boq_item_id, qty_to_date: num(qty[q.boq_item_id] ?? '') })) } : { verified_pct: p }),
      comment: comment.trim() || undefined,
    }, { entityType: 'task_progress', entityId: u.id, label: `${task?.name ?? 'Task'} ${changed ? 'adjusted' : 'verified'}` });
    haptic('confirm');
    toast.success(`${task?.name ?? 'Task'} · ${changed ? tr('sch.adjust') : tr('sch.approve')}`);
  };
  const doReject = (reason: string) => {
    enqueue('verify_task_progress', { progress_id: u.id, approve: false, comment: reason },
      { entityType: 'task_progress', entityId: u.id, label: `${task?.name ?? 'Task'} progress rejected` });
    haptic('reject');
    toast.success(`${task?.name ?? 'Task'} · ${tr('sch.reject')}`);
    setReject(false);
  };

  return (
    <Card stripe={u.original_status_date ? 'warning' : 'info'}>
      <Row justify="space-between" align="flex-start">
        <Text variant="titleSm" style={styles.flex}>{task?.wbs ? `${task.wbs} · ` : ''}{task?.name ?? '—'}</Text>
        <SyncDot status={u._pending ? 'pending' : null} />
      </Row>
      <Text variant="bodySm" tone="muted">{fmtDate(u.status_date)} · {personName(u.reported_by)}</Text>
      <Row wrap gap={6}>
        <Chip label={tr('sch.reported', { p: pctTxt(u.pct_complete) })} tone="info" icon="progress-clock" />
        <Chip label={tr('sch.verified', { p: pctTxt(task?.pct_complete) })} tone="neutral" icon="shield-check-outline" />
        {u.delay_cause ? <Chip label={u.delay_cause} tone="warning" icon="alert-outline" /> : null}
        {u.remaining_days != null ? <Chip label={`${tr('sch.remaining')}: ${fmtQty(u.remaining_days, 1)}`} tone="neutral" icon="timer-sand" /> : null}
      </Row>
      {u.remarks ? <Text variant="body">{u.remarks}</Text> : null}
      <PhotoStrip projectId={u.project_id} entityType="task_progress" entityId={u.id} canAdd={false} />
      {units ? (u.qty ?? []).map((q) => {
        const l = links.find((x) => x.boq_item_id === q.boq_item_id);
        const b = get<BoqItem>('boq_items', q.boq_item_id);
        return (
          <QuantityStepper key={q.boq_item_id} label={`${tr('sch.verifiedQty')} · ${b?.item_no ?? ''} ${b?.description ?? ''}`.trim()} unit={b?.unit}
            value={qty[q.boq_item_id] ?? ''} onChange={(v) => setQty((s) => ({ ...s, [q.boq_item_id]: v }))}
            fill={{ label: tr('sch.reported', { p: fmtQty(q.qty_to_date) }), value: Number(q.qty_to_date) }}
            info={l ? tr('sch.ofPlanned', { q: fmtQty(l.qty_share), u: b?.unit ?? '' }) : null} />
        );
      }) : (
        <QuantityStepper label={tr('sch.verifiedPct')} unit="%" step={5} quick={[]} max={100} value={pct} onChange={setPct}
          fill={{ label: tr('sch.reported', { p: pctTxt(u.pct_complete) }), value: Number(u.pct_complete ?? 0) }} />
      )}
      <Field label={tr('sch.comment')} optional={!changed} value={comment} onChangeText={setComment} hint={tr('sch.commentHint')} />
      <Row>
        <Button title={tr('sch.reject')} variant="dangerOutline" flex onPress={() => setReject(true)} />
        <Button title={changed ? tr('sch.adjust') : tr('sch.approve')} icon="shield-check-outline" flex onPress={approve} />
      </Row>
      <Button title={tr('la.open')} size="sm" variant="ghost" icon="open-in-new" onPress={() => router.push(`/schedule/task/${u.task_id}` as Href)} />
      {reject ? (
        <ReasonSheet visible onClose={() => setReject(false)} title={`${tr('sch.reject')} · ${task?.name ?? ''}`}
          reasons={['Not done on site', 'Percent too high', 'Wrong task', 'Photo missing', 'Quantity not measured']}
          confirmLabel={tr('sch.reject')} variant="danger" onConfirm={doReject} />
      ) : null}
    </Card>
  );
}

/** Cards for every task-progress report waiting for this user (not their own). */
export function TaskVerifyList() {
  const { profile, project } = useSession();
  useLocale();
  const rows = useData(() => tasksToVerify(project.id, profile.id), [project.id, profile.id]);
  if (!rows.length) return <EmptyState icon="check-all" tone="success" title={tr('common.allCaught')} body={tr('sch.nothingToVerify')} compact />;
  return <>{rows.map((u) => <VerifyCard key={u.id} u={u} />)}</>;
}

// ---------------------------------------------------------------------------
// Progress overview card (coordinator / manager Home) — v_progress_overview, cached
// ---------------------------------------------------------------------------

export function ProgressOverviewCard({ projectId }: { projectId: string }) {
  useLocale();
  const c = useData(() => cachedOverview(projectId), [projectId]);
  const rows = c?.rows ?? [];
  const o: ProgressOverview | undefined = rows.find((r) => r.level === 'project');
  if (!o) {
    return (
      <Section title={tr('sch.overview')}>
        <Banner tone="info" icon="cloud-off-outline" text={tr('sch.overviewOffline')} />
      </Section>
    );
  }
  const band = (o.spi_status ?? evmBand(o.spi)) as EvmBand | null;
  const b = band ? BAND[band] : null;
  const sv = o.sv_t_days != null ? Math.round(Number(o.sv_t_days) * 10) / 10 : null;
  return (
    <Section title={tr('sch.overview')}>
      <Card stripe={b?.tone ?? null} onPress={() => router.push('/progress?mode=schedule' as Href)}>
        <Row justify="space-between">
          <Text variant="titleSm" style={styles.flex} numberOfLines={1}>{o.name}</Text>
          <Chip label={b ? tr(b.key) : tr('sch.noBand')} tone={b?.tone ?? 'neutral'} icon={b?.icon ?? 'help-circle-outline'} />
        </Row>
        <ProgressBar pct={Number(o.pct_earned ?? 0)} planned={o.pct_planned != null ? Number(o.pct_planned) : null} showLabel />
        <Text variant="bodySm">{tr('sch.planSentence', { p: pctTxt(o.pct_planned), c: pctTxt(o.pct_earned) })}</Text>
        <InfoRow label={tr('sch.pctPlanned')} value={`${pctTxt(o.pct_planned)}%`} />
        <InfoRow label={tr('sch.pctComplete')} value={`${pctTxt(o.pct_earned)}%`} strong />
        {sv != null && sv !== 0 ? (
          <InfoRow label={tr('sch.forecast')} value={sv < 0 ? tr('sch.daysBehind', { n: -sv }) : tr('sch.daysAhead', { n: sv })} tone={sv < 0 ? 'warning' : 'success'} />
        ) : null}
        <Row wrap gap={6}>
          {o.late_tasks ? <Chip small label={tr('sch.lateTasks', { n: o.late_tasks })} tone="danger" icon="clock-alert-outline" /> : null}
          {o.critical_tasks ? <Chip small label={tr('sch.criticalOpen', { n: o.critical_tasks })} tone="warning" icon="lightning-bolt-outline" /> : null}
          {o.pending_verification ? <Chip small label={`${tr('sch.toVerify')} · ${o.pending_verification}`} tone="info" icon="progress-clock" /> : null}
        </Row>
        <Text variant="caption" tone="muted">{tr('sch.statusDate', { d: fmtDate(o.status_date) })}</Text>
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Home "Needs you" items
// ---------------------------------------------------------------------------

export interface HomeTask { id: string; icon: IconName; tone: Tone; stripe: Tone; title: string; sub: string; href: Href }

export function scheduleTasks(role: AppRole, c: ScheduleCounts): { tasks: HomeTask[]; total: number } {
  const tasks: HomeTask[] = [];
  let total = 0;
  if (role === 'site_engineer' && c.myOverdue) {
    tasks.push({ id: 'sch:overdue', icon: 'clock-alert-outline', tone: 'danger', stripe: 'danger', title: tr('sch.overdueTasks', { n: c.myOverdue }), sub: tr('sch.overdueSub'), href: '/progress?mode=schedule' as Href });
    total += c.myOverdue;
  }
  if (c.constraintsMine && canLookahead(role, 'lookahead.constraint')) {
    tasks.push({ id: 'la:constraints', icon: 'alert-octagon-outline', tone: 'warning', stripe: 'warning', title: tr('la.constraintsMine', { n: c.constraintsMine }), sub: tr('la.constraintsMineSub'), href: '/lookahead?filter=constraints' as Href });
    total += c.constraintsMine;
  }
  if (c.uncommittedReady && canLookahead(role, 'lookahead.commit')) {
    tasks.push({ id: 'la:commit', icon: 'calendar-check-outline', tone: 'info', stripe: 'info', title: tr('la.uncommitted', { n: c.uncommittedReady }), sub: tr('la.uncommittedSub'), href: '/lookahead?range=next' as Href });
    total += c.uncommittedReady;
  }
  if (c.tasksToVerify && canSchedule(role, 'progress.verify')) {
    tasks.push({ id: 'sch:verify', icon: 'shield-check-outline', tone: 'warning', stripe: 'warning', title: tr('sch.tasksToVerify', { n: c.tasksToVerify }), sub: tr('sch.tasksToVerifySub'), href: '/schedule/verify' as Href });
    total += c.tasksToVerify;
  }
  return { tasks, total };
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { paddingBottom: space[8] },
  listHead: { paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[2], gap: space[2] },
  head: { paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[1] },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: space[4], paddingRight: space[3], paddingVertical: space[3], gap: space[2], borderBottomWidth: StyleSheet.hairlineWidth * 2 },
  stripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  body: { flex: 1, gap: 4 },
  top: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
});
