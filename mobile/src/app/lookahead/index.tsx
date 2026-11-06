// Monthly tasks window / look-ahead agenda (schedule-ux.md §8.2): month grouped by week → day,
// holidays as day headers, items with class + readiness chip, PPC this week / 4-week rolling.
// Multi-day items show on their start day ("until …") and under "Continuing" in later weeks.
import React, { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams, type Href } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useSession } from '../../lib/app';
import { CONSTRAINT_LABELS, READINESS_LABELS, ppcTone, type ConstraintType, type LookaheadPlan, type LookaheadWeek } from '../../lib/contract-lookahead';
import { getDb } from '../../lib/db';
import { syncStatusMap } from '../../lib/counts';
import { buildAgenda, defaultPlan, holidaysBetween, localPpc, planItems, plansFor, weeks, type AgendaEntry, type AgendaItem } from '../../lib/schedule';
import { cachedPpc } from '../../lib/sync-schedule';
import { fmtDate, today } from '../../lib/format';
import { getLocale, t as tr, useLocale } from '../../lib/i18n';
import { space, useTheme, type Tone } from '../../theme';
import { Banner, Card, Chip, ChipGroup, EmptyState, Icon, Row, Screen, SyncDot, Text } from '../../components/ui';
import { lbl, readinessChip, roleChip } from '../../components/schedule';

type Range = 'this' | 'next' | 'month';
type Filter = 'all' | 'mine' | 'not_ready' | 'constraints';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_AM = ['እሑድ', 'ሰኞ', 'ማክሰኞ', 'ረቡዕ', 'ሐሙስ', 'ዓርብ', 'ቅዳሜ'];
const dayName = (iso: string) => (getLocale() === 'am' ? DOW_AM : DOW)[new Date(`${iso}T00:00:00`).getDay()];
const planLabel = (p: LookaheadPlan) => (getLocale() === 'am' && p.period_label_am ? p.period_label_am : p.period_label);

const ItemRow = memo(function ItemRow({ i, continuing, onOpen }: { i: AgendaItem; continuing: boolean; onOpen: (id: string) => void }) {
  const t = useTheme();
  const rc = readinessChip(i.readiness);
  const cls = roleChip(i.role);
  const stripe: Tone | null = i.readiness === 'not_ready' ? 'danger' : i.readiness === 'at_risk' ? 'warning' : null;
  const sub = i.worst
    ? `${i.worstType ? `${lbl(CONSTRAINT_LABELS[i.worstType as ConstraintType])}: ` : ''}${i.worst}`
    : continuing ? `${fmtDate(i.start)} – ${fmtDate(i.finish)}` : i.finish && i.finish !== i.start ? tr('la.until', { d: `${dayName(i.finish)} ${fmtDate(i.finish)}` }) : null;
  return (
    <Pressable onPress={() => onOpen(i.id)} android_ripple={{ color: t.ripple }} accessibilityRole="button"
      accessibilityLabel={`${i.name}, ${rc.label}`} style={[styles.row, { backgroundColor: t.surface, borderBottomColor: t.border }]}>
      {stripe ? <View style={[styles.stripe, { backgroundColor: stripe === 'danger' ? t.danger : t.warning }]} /> : null}
      <View style={styles.body}>
        <View style={styles.top}>
          {i.milestone ? <Icon name="flag-outline" size={18} tone="info" /> : null}
          <Text variant="titleSm" numberOfLines={2} style={styles.flex}>{i.name}</Text>
          <SyncDot status={i.sync} />
        </View>
        {sub ? <Text variant="bodySm" tone={i.worst ? 'warning' : 'muted'} numberOfLines={1}>{sub}</Text> : null}
        <View style={styles.chips}>
          <Chip small label={rc.label} tone={rc.tone} icon={rc.icon} />
          <Chip small label={cls.label} tone={cls.tone} />
          {i.critical ? <Chip small label={tr('sch.critical')} tone="warning" icon="lightning-bolt-outline" /> : null}
          {i.committedThis ? <Chip small label={`${tr('la.committed')} · ${tr('sch.thisWeek')}`} tone={i.outcomeThis === 'completed' ? 'success' : i.outcomeThis === 'not_completed' ? 'danger' : 'primary'} icon="calendar-check-outline" /> : null}
          {i.committedNext ? <Chip small label={`${tr('la.committed')} · ${tr('sch.nextWeek')}`} tone="primary" icon="calendar-check-outline" /> : null}
          <Text variant="caption" tone="muted">{Math.round(i.pct)}%</Text>
        </View>
      </View>
      <Icon name="chevron-right" size={20} tone="muted" />
    </Pressable>
  );
});

const WeekHead = memo(function WeekHead({ label, sub }: { label: string; sub: string }) {
  const t = useTheme();
  return (
    <View style={[styles.week, { backgroundColor: t.surfaceMuted ?? t.background, borderBottomColor: t.border }]}>
      <Text variant="title">{label}</Text>
      <Text variant="caption" tone="muted">{sub}</Text>
    </View>
  );
});

const DayHead = memo(function DayHead({ date, holidays }: { date: string; holidays: { name: string; nameAm: string | null; tentative: boolean }[] }) {
  const isToday = date === today();
  return (
    <View style={styles.day}>
      <Text variant="label" tone={isToday ? 'primary' : 'muted'}>{dayName(date)} {fmtDate(date)}</Text>
      {holidays.map((h) => (
        <Row key={h.name} gap={4}>
          <Icon name="calendar-alert" size={16} tone="warning" />
          <Text variant="caption" tone="warning">{getLocale() === 'am' && h.nameAm ? h.nameAm : h.name} · {tr('la.holiday')}{h.tentative ? ` · ${tr('la.tentative')}` : ''}</Text>
        </Row>
      ))}
    </View>
  );
});

export default function Lookahead() {
  const { locale, calendar } = useLocale();
  const { profile, project } = useSession();
  const params = useLocalSearchParams<{ range?: Range; filter?: Filter }>();
  const [range, setRange] = useState<Range>(params.range ?? 'this');
  const [filter, setFilter] = useState<Filter>(params.filter ?? (profile.role === 'site_engineer' ? 'mine' : 'all'));
  const plans = useData(() => plansFor(project.id), [project.id]);
  const [planId, setPlanId] = useState<string | null>(null);
  const plan = useMemo(() => plans.find((p) => p.id === planId) ?? defaultPlan(project.id, calendar), [plans, planId, project.id, calendar]);

  const data = useData(() => {
    if (!plan) return null;
    const sync = syncStatusMap();
    let items = planItems(plan.id, sync);
    if (filter === 'mine') items = items.filter((i) => i.responsible === profile.id);
    if (filter === 'not_ready') items = items.filter((i) => i.readiness !== 'ready');
    if (filter === 'constraints') {
      const mine = new Set(getDb().getAllSync<{ i: string }>(
        `SELECT json_extract(json, '$.item_id') AS i FROM rows WHERE tbl = 'lookahead_constraints' AND project_id = ?
         AND json_extract(json, '$.owner_id') = ? AND json_extract(json, '$.status') IN ('open','in_progress','blocked')`, [project.id, profile.id]).map((r) => r.i));
      items = items.filter((i) => mine.has(i.id));
    }
    const w = weeks();
    const r = range === 'this' ? { from: w.thisStart, to: w.thisEnd } : range === 'next' ? { from: w.nextStart, to: w.nextEnd } : null;
    const hol = holidaysBetween(project.id, plan.period_start, plan.horizon_end);
    const entries = buildAgenda(plan, items, hol, r, (wk: LookaheadWeek) => tr('la.week', { n: wk.week_no }));
    const lp = localPpc(plan.id);
    const cache = cachedPpc(project.id)?.rows ?? [];
    const cur = cache.find((x) => x.week_start <= today() && x.week_end >= today()) ?? cache[0];
    return { entries, ppc: { ...lp, rolling: cur?.ppc_rolling_4w ?? lp.rolling, target: cur?.ppc_target ?? 80 } };
  }, [plan?.id, filter, range, project.id, profile.id, locale]);

  const open = useCallback((id: string) => router.push(`/lookahead/${id}` as Href), []);

  if (!plan || !data) {
    return (
      <Screen>
        <Stack.Screen options={{ title: tr('la.title') }} />
        <EmptyState icon="calendar-month-outline" title={tr('la.noPlan')} body={tr('la.noPlanBody')} />
      </Screen>
    );
  }
  const tone = ppcTone(data.ppc.rolling, data.ppc.target ?? 80);
  const ppcChipTone: Tone = tone === 'good' ? 'success' : tone === 'watch' ? 'warning' : tone === 'poor' ? 'danger' : 'neutral';

  const renderItem = ({ item: e }: { item: AgendaEntry }) => {
    if (e.type === 'week') return <WeekHead label={e.label} sub={`${fmtDate(e.week.week_start)} – ${fmtDate(e.week.week_end)}${e.week.ppc != null ? ` · PPC ${Math.round(Number(e.week.ppc))}%` : ''}`} />;
    if (e.type === 'day') return <DayHead date={e.date} holidays={e.holidays} />;
    if (e.type === 'continuing') return <View style={styles.day}><Text variant="label" tone="muted">{tr('la.continuing', { n: e.n })}</Text></View>;
    return <ItemRow i={e.item} continuing={e.continuing} onOpen={open} />;
  };

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: `${tr('la.title')} · ${planLabel(plan)}` }} />
      <FlashList
        data={data.entries}
        keyExtractor={(e) => e.key}
        getItemType={(e) => e.type}
        renderItem={renderItem}
        ListHeaderComponent={
          <View style={styles.head}>
            {plans.length > 1 ? (
              <ChipGroup scroll value={plan.id} onChange={setPlanId}
                options={plans.map((p) => ({ value: p.id, label: `${planLabel(p)}${p.calendar_mode === 'ethiopian' ? ' (E.C.)' : ''}` }))} />
            ) : null}
            {plan.status === 'draft' ? <Banner tone="warning" icon="pencil-outline" text={tr('la.draft')} /> : null}
            <Card dense>
              <Row justify="space-between" wrap gap={6}>
                <Text variant="titleSm">{tr('la.ppcThis', { d: data.ppc.thisDone, n: data.ppc.thisTotal })}</Text>
                <Chip label={data.ppc.rolling != null ? tr('la.ppcRolling', { p: Math.round(data.ppc.rolling) }) : tr('la.ppcNone')} tone={ppcChipTone}
                  icon={tone === 'good' ? 'check-circle-outline' : tone === 'none' ? 'information-outline' : 'alert-outline'} />
              </Row>
            </Card>
            <ChipGroup<Range> scroll value={range} onChange={setRange} options={[
              { value: 'this', label: tr('sch.thisWeek') }, { value: 'next', label: tr('sch.nextWeek') }, { value: 'month', label: tr('la.month') },
            ]} />
            <ChipGroup<Filter> scroll value={filter} onChange={setFilter} options={[
              { value: 'all', label: tr('common.all') }, { value: 'mine', label: tr('la.mine'), icon: 'account-hard-hat-outline' },
              { value: 'not_ready', label: lbl(READINESS_LABELS.not_ready), tone: 'danger' },
              { value: 'constraints', label: tr('la.constraints'), icon: 'alert-octagon-outline' },
            ]} />
          </View>
        }
        ListEmptyComponent={<EmptyState icon="calendar-month-outline" title={tr('sch.noTasks')} compact
          action={{ label: tr('la.month'), onPress: () => { setRange('month'); setFilter('all'); } }} />}
        contentContainerStyle={styles.list}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { paddingBottom: space[8] },
  head: { paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[2], gap: space[2] },
  week: { paddingHorizontal: space[4], paddingTop: space[4], paddingBottom: space[2], borderBottomWidth: StyleSheet.hairlineWidth * 2 },
  day: { paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[1], gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: space[4], paddingRight: space[3], paddingVertical: space[3], gap: space[2], borderBottomWidth: StyleSheet.hairlineWidth * 2 },
  stripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  body: { flex: 1, gap: 4 },
  top: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
});
