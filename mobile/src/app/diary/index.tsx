// Site diary history: one row per day/block, "To sign" for reviewers, FAB → today's diary.
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useSession } from '../../lib/app';
import { jf, rowsWhere, syncStatusMap } from '../../lib/counts';
import { canField, type SiteDiary } from '../../lib/contract-field';
import { blocks, personName } from '../../lib/queries';
import { fmtDate, today } from '../../lib/format';
import { space } from '../../theme';
import { ChipGroup, EmptyState, Fab, ListRow, Screen, fabScroll } from '../../components/ui';
import { WEATHER_INFO } from '../../components/field';

type Filter = 'all' | 'sign' | 'mine' | 'draft';

export default function Diaries() {
  const { profile, project } = useSession();
  const params = useLocalSearchParams<{ filter?: Filter }>();
  const reviewer = canField(profile.role, 'diary.sign');
  const [filter, setFilter] = useState<Filter>(params.filter ?? (reviewer ? 'sign' : 'all'));
  const [ext, setExt] = useState(true);
  const onScroll = useMemo(() => fabScroll(setExt), []);
  const rows = useData(() => {
    const sync = syncStatusMap();
    const bl = new Map(blocks(project.id).map((b) => [b.id, b.code]));
    const where = filter === 'sign' ? `AND ${jf('status')} = 'submitted' AND ${jf('created_by')} != ?`
      : filter === 'mine' ? `AND ${jf('created_by')} = ?` : filter === 'draft' ? `AND ${jf('status')} = 'draft' AND ${jf('created_by')} = ?` : '';
    return rowsWhere<SiteDiary>('site_diaries', project.id, where, filter === 'all' ? [] : [profile.id], `${jf('diary_date')} DESC`, 200).map((d) => ({
      id: d.id, title: `${fmtDate(d.diary_date)}${d.block_id ? ` · ${bl.get(d.block_id) ?? ''}` : ''}`,
      sub: `${d.number} · ${personName(d.created_by)}`,
      meta: [d.weather_am ? WEATHER_INFO[d.weather_am].label : null, d.weather_pm && d.weather_pm !== d.weather_am ? WEATHER_INFO[d.weather_pm].label : null].filter(Boolean).join(' → ') || null,
      status: d.status, sync: sync.get(d.id) ?? null,
    }));
  }, [project.id, profile.id, filter]);
  const open = useCallback((id: string) => router.push(`/diary/${id}`), []);
  const canWrite = canField(profile.role, 'diary.write');

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: 'Site diary' }} />
      <View style={{ padding: space[4], paddingBottom: space[2] }}>
        <ChipGroup<Filter> scroll value={filter} onChange={setFilter} options={[
          ...(reviewer ? [{ value: 'sign' as Filter, label: 'To sign', icon: 'draw-pen' as const }] : []),
          { value: 'all', label: 'All' }, { value: 'mine', label: 'Mine' }, { value: 'draft', label: 'My drafts' },
        ]} />
      </View>
      <FlashList data={rows} keyExtractor={(r) => r.id} onScroll={onScroll}
        renderItem={({ item: r }) => <ListRow id={r.id} title={r.title} subtitle={r.sub} meta={r.meta} status={r.status} sync={r.sync} icon="notebook-outline" onPress={open} />}
        ListEmptyComponent={<EmptyState icon="notebook-outline" title={filter === 'sign' ? 'No diaries waiting for you' : 'No diaries yet'}
          body={filter === 'sign' ? 'Submitted diaries show up here for sign-off.' : 'Write today’s diary in about two minutes.'}
          action={canWrite ? { label: "Today's diary", onPress: () => router.push(`/diary/edit?date=${today()}`) } : undefined} />} />
      {canWrite ? <Fab label="Today's diary" icon="notebook-edit-outline" extended={ext} onPress={() => router.push(`/diary/edit?date=${today()}`)} /> : null}
    </Screen>
  );
}
