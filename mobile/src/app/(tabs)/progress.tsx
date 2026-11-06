// Elements & progress (spec §5.4 entry): "Active this week" by default, level chips,
// rows with progress bar + planned marker and "Not updated N d". Camera icon = photo-first update.
import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useSession } from '../../lib/app';
import { can } from '../../lib/contract';
import { lastReportByElement } from '../../lib/counts';
import { MyTasksList } from '../../components/schedule';
import { blocks, elements, levels } from '../../lib/queries';
import { fmtDate, today } from '../../lib/format';
import { t as tr, useLocale } from '../../lib/i18n';
import { space, useTheme } from '../../theme';
import {
  Button, Chip, ChipGroup, EmptyState, FilterChip, IconButton, ProgressBar, Screen, SearchInput, SearchSheet, Segmented, StatusChip, Text, normalize,
} from '../../components/ui';

type Filter = 'active' | 'delayed' | 'completed' | 'all';

const DAY = 86400e3;
function plannedPct(start: string | null, finish: string | null): number | null {
  if (!start || !finish) return null;
  const s = new Date(`${start}T00:00:00`).getTime();
  const f = new Date(`${finish}T00:00:00`).getTime();
  const n = Date.now();
  if (f <= s) return n >= f ? 100 : 0;
  return Math.max(0, Math.min(100, ((n - s) / (f - s)) * 100));
}

interface ElRow { id: string; code: string; sub: string; status: string; pct: number; planned: number | null; delayed: boolean; stale: number | null; behind: number | null }

const ElementRow = memo(function ElementRow({ r, onOpen, onPhoto, canReport }: { r: ElRow; onOpen: (id: string) => void; onPhoto: (id: string) => void; canReport: boolean }) {
  const t = useTheme();
  return (
    <Pressable onPress={() => onOpen(r.id)} android_ripple={{ color: t.ripple }} accessibilityRole="button"
      accessibilityLabel={`${r.code}, ${Math.round(r.pct)} percent${r.delayed ? ', delayed' : ''}`}
      style={[styles.row, { backgroundColor: t.surface, borderBottomColor: t.border }]}>
      {r.delayed ? <View style={[styles.stripe, { backgroundColor: t.danger }]} /> : null}
      <View style={styles.body}>
        <View style={styles.top}>
          <Text variant="titleSm" numberOfLines={1} style={styles.flex}>{r.code}</Text>
          {r.delayed ? <Chip label={tr('status.delayed')} tone="danger" icon="clock-alert-outline" small /> : <StatusChip status={r.status} small />}
        </View>
        <Text variant="bodySm" tone="muted" numberOfLines={1}>{r.sub}</Text>
        <ProgressBar pct={r.pct} planned={r.planned} showLabel />
        {r.stale != null && r.stale >= 3 && r.status !== 'completed' ? (
          <Text variant="caption" tone="warning">Not updated {r.stale} d{r.behind && r.behind > 0 ? ` · behind ${Math.round(r.behind)}%` : ''}</Text>
        ) : r.behind && r.behind > 5 ? <Text variant="caption" tone="warning">Behind plan {Math.round(r.behind)}%</Text> : null}
      </View>
      {canReport ? <IconButton icon="camera-outline" tone="primary" accessibilityLabel={`Photo update for ${r.code}`} onPress={() => onPhoto(r.id)} /> : null}
    </Pressable>
  );
});

type Mode = 'elements' | 'schedule';

/** Progress tab: Segmented Elements · Schedule (schedule-ux.md §4.4 / §7.1). */
export default function ProgressTab() {
  useLocale();
  const { profile } = useSession();
  const params = useLocalSearchParams<{ mode?: Mode; filter?: string }>();
  const [mode, setMode] = useState<Mode>(params.mode ?? (params.filter ? 'elements' : profile.role === 'site_engineer' ? 'schedule' : 'elements'));
  useEffect(() => { if (params.mode) setMode(params.mode); else if (params.filter) setMode('elements'); }, [params.mode, params.filter]);
  const sw = (
    <Segmented<Mode> value={mode} onChange={setMode} options={[
      { value: 'elements', label: tr('sch.elements'), icon: 'pillar' }, { value: 'schedule', label: tr('sch.schedule'), icon: 'chart-gantt' },
    ]} />
  );
  if (mode === 'schedule') return <Screen scroll={false} padded={false} insetBottom={false}><MyTasksList header={sw} /></Screen>;
  return <Elements modeSwitch={sw} />;
}

function Elements({ modeSwitch }: { modeSwitch: React.ReactNode }) {
  useLocale();
  const { project, profile } = useSession();
  const params = useLocalSearchParams<{ filter?: Filter }>();
  const [filter, setFilter] = useState<Filter>(params.filter ?? 'active');
  const [levelCode, setLevelCode] = useState<string>('__all');
  const [blockId, setBlockId] = useState<string | null>(null);
  const [blockSheet, setBlockSheet] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);

  const meta = useData(() => ({
    blocks: blocks(project.id).map((b) => ({ id: b.id, label: `${b.code} · ${b.name}` })),
    levels: levels(project.id),
  }), [project.id]);

  const all = useData(() => {
    const lv = new Map(meta.levels.map((l) => [l.id, l]));
    const last = lastReportByElement(project.id);
    const t0 = today();
    return elements(project.id).map((e) => {
      const l = e.level_id ? lv.get(e.level_id) : undefined;
      const planned = plannedPct(e.planned_start, e.planned_finish);
      const lastAt = last.get(e.id) ?? e.actual_start ?? null;
      const pct = Number(e.progress_pct);
      return {
        e, levelCode: l?.code ?? '', key: normalize(`${e.code} ${e.element_type} ${e.grid ?? ''}`),
        row: {
          id: e.id, code: `${e.code}${l ? ` (${l.code})` : ''}`, status: e.status, pct, planned,
          sub: `${e.element_type}${e.grid ? ` · grid ${e.grid}` : ''} · finish ${fmtDate(e.planned_finish)}`,
          delayed: !!e.planned_finish && e.planned_finish < t0 && e.status !== 'completed',
          stale: lastAt ? Math.floor((Date.now() - new Date(lastAt.length === 10 ? `${lastAt}T00:00:00` : lastAt).getTime()) / DAY) : null,
          behind: planned != null ? planned - pct : null,
        } as ElRow,
      };
    });
  }, [project.id, meta]);

  const levelCodes = useMemo(() => [...new Set(meta.levels.filter((l) => !blockId || l.block_id === blockId).map((l) => l.code))], [meta.levels, blockId]);

  const rows = useMemo(() => {
    const t0 = today();
    const weekAhead = new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10);
    const nq = normalize(dq);
    return all.filter(({ e, levelCode: lc, key }) => {
      if (blockId && e.block_id !== blockId) return false;
      if (levelCode !== '__all' && lc !== levelCode) return false;
      if (nq && !key.includes(nq)) return false;
      if (filter === 'active') return e.status === 'in_progress' || (!!e.planned_start && e.planned_start <= weekAhead && e.status !== 'completed');
      if (filter === 'delayed') return !!e.planned_finish && e.planned_finish < t0 && e.status !== 'completed';
      if (filter === 'completed') return e.status === 'completed';
      return true;
    }).map((x) => x.row);
  }, [all, blockId, levelCode, dq, filter]);

  const avg = rows.length ? rows.reduce((s, r) => s + r.pct, 0) / rows.length : 0;
  const canReport = can(profile.role, 'progress.report');
  const open = useCallback((id: string) => router.push(`/progress/${id}`), []);
  const photo = useCallback((id: string) => router.push(`/progress/${id}?photo=1`), []);

  return (
    <Screen scroll={false} padded={false} insetBottom={false}>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={
          <View style={styles.head}>
            {modeSwitch}
            <SearchInput value={q} onChangeText={setQ} onClear={() => setQ('')} placeholder={tr('progress.searchEl')} />
            <ChipGroup<Filter> scroll value={filter} onChange={setFilter} options={[
              { value: 'active', label: 'Active this week' }, { value: 'delayed', label: 'Delayed', tone: 'danger' },
              { value: 'completed', label: 'Completed' }, { value: 'all', label: 'All' },
            ]} />
            <View style={styles.filters}>
              {meta.blocks.length > 1 ? (
                <FilterChip label={blockId ? meta.blocks.find((b) => b.id === blockId)?.label ?? 'Block' : 'All blocks'} selected={!!blockId}
                  trailingIcon="chevron-down" onPress={() => setBlockSheet(true)} />
              ) : null}
            </View>
            {levelCodes.length > 1 ? (
              <ChipGroup scroll value={levelCode} onChange={setLevelCode}
                options={[{ value: '__all', label: 'All levels' }, ...levelCodes.map((c) => ({ value: c, label: c }))]} />
            ) : null}
            <View style={styles.summary}>
              <Text variant="bodySm" tone="muted" style={styles.flex}>{rows.length} elements · average {avg.toFixed(1)}%</Text>
              {can(profile.role, 'progress.verify') ? (
                <Button title={tr('progress.verifyQueue')} size="sm" variant="tonal" icon="shield-check-outline" onPress={() => router.push('/progress/verify')} />
              ) : null}
            </View>
          </View>
        }
        renderItem={({ item }) => <ElementRow r={item} onOpen={open} onPhoto={photo} canReport={canReport} />}
        ListEmptyComponent={<EmptyState icon="chart-gantt" title={q ? `No match for “${q}”` : 'No elements in this view'} compact
          action={{ label: 'Show all', onPress: () => { setFilter('all'); setLevelCode('__all'); setBlockId(null); setQ(''); } }} />}
        contentContainerStyle={styles.list}
      />
      {blockSheet ? (
        <SearchSheet visible onClose={() => setBlockSheet(false)} title="Block" options={meta.blocks} value={blockId}
          onSelect={(id) => { setBlockId(id); setLevelCode('__all'); }} onClear={() => setBlockId(null)} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[2], gap: space[1] },
  filters: { flexDirection: 'row', gap: space[2] },
  summary: { flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 48 },
  list: { paddingBottom: space[8] },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: space[4], paddingRight: space[1], paddingVertical: space[3], gap: space[2], borderBottomWidth: StyleSheet.hairlineWidth * 2 },
  stripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  body: { flex: 1, gap: 4 },
  top: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
});
