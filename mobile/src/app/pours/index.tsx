// Concrete pours: active / today / completed; header links to cubes due and (store) trucks to receive.
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useSession } from '../../lib/app';
import { get } from '../../lib/db';
import { fieldCounts, jf, rowsWhere, syncStatusMap } from '../../lib/counts';
import { canField, type MixDesign, type Pour } from '../../lib/contract-field';
import { pourElements, pourTotals } from '../../lib/field';
import { elementLabel } from '../../lib/queries';
import { fmtDate, fmtQty, today } from '../../lib/format';
import { space } from '../../theme';
import { Banner, ChipGroup, EmptyState, Fab, ListRow, Screen, fabScroll } from '../../components/ui';

type Filter = 'active' | 'today' | 'completed' | 'all';

export default function Pours() {
  const { profile, project } = useSession();
  const params = useLocalSearchParams<{ element?: string }>();
  const [filter, setFilter] = useState<Filter>(params.element ? 'all' : 'active');
  const [ext, setExt] = useState(true);
  const onScroll = useMemo(() => fabScroll(setExt), []);
  const data = useData(() => {
    const sync = syncStatusMap();
    const where = filter === 'active' ? `AND ${jf('status')} IN ('planned','in_progress')` : filter === 'today' ? `AND ${jf('pour_date')} = ?`
      : filter === 'completed' ? `AND ${jf('status')} = 'completed'` : '';
    let pours = rowsWhere<Pour>('pours', project.id, where, filter === 'today' ? [today()] : [], `${jf('pour_date')} DESC`, 300);
    if (params.element) pours = pours.filter((p) => pourElements(p.id).some((e) => e.element_id === params.element));
    return {
      c: fieldCounts(project.id, profile.id),
      rows: pours.map((p) => {
        const t = pourTotals(p.id);
        const placed = p.method === 'ready_mix' ? t.accepted : t.batched;
        const els = pourElements(p.id).filter((e) => !e.deleted_at);
        return {
          id: p.id, title: `${p.number} · ${get<MixDesign>('mix_designs', p.mix_design_id)?.grade ?? ''}`, status: p.status, sync: sync.get(p.id) ?? null,
          sub: `${fmtDate(p.pour_date)} · ${els.slice(0, 3).map((e) => elementLabel(e.element_id)).join(', ')}${els.length > 3 ? ` +${els.length - 3}` : ''}`,
          qty: fmtQty(p.actual_m3 ?? placed), meta: `of ${fmtQty(p.planned_m3)} m3`,
          chip: t.awaitingCount ? { label: `${t.awaitingCount} to receive`, tone: 'warning' as const, icon: 'timer-sand' as const } : null,
        };
      }),
    };
  }, [project.id, profile.id, filter, params.element]);
  const open = useCallback((id: string) => router.push(`/pours/${id}`), []);
  const canPlan = canField(profile.role, 'pour.write');

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: params.element ? `Pours · ${elementLabel(params.element)}` : 'Concrete pours' }} />
      <View style={{ padding: space[4], paddingBottom: space[2], gap: space[2] }}>
        {data.c.trucksAwaiting && canField(profile.role, 'pour.receiveTruck') ? (
          <Banner tone="warning" icon="dump-truck" title={`${data.c.trucksAwaiting} ready-mix truck${data.c.trucksAwaiting > 1 ? 's' : ''} to receive`} onPress={() => router.push('/pours/receive')}
            actions={[{ label: 'Receive', onPress: () => router.push('/pours/receive') }]} />
        ) : null}
        {data.c.cubesDue ? (
          <Banner tone="info" icon="test-tube" title={`${data.c.cubesDue} cube test${data.c.cubesDue > 1 ? 's' : ''} due`} actions={[{ label: 'Cubes due', onPress: () => router.push('/pours/cubes') }]} />
        ) : null}
        <ChipGroup<Filter> scroll value={filter} onChange={setFilter} options={[
          { value: 'active', label: 'Active' }, { value: 'today', label: 'Today' }, { value: 'completed', label: 'Completed' }, { value: 'all', label: 'All' },
        ]} />
      </View>
      <FlashList data={data.rows} keyExtractor={(r) => r.id} onScroll={onScroll}
        renderItem={({ item: r }) => <ListRow id={r.id} title={r.title} subtitle={r.sub} meta={r.meta} qty={r.qty} unit="m3" status={r.status} chip={r.chip} sync={r.sync} icon="dump-truck" onPress={open} />}
        ListEmptyComponent={<EmptyState icon="dump-truck" title="No pours here" body="Plan a pour for one or more elements; trucks, batches and cubes are recorded on the day."
          action={canPlan ? { label: 'Plan pour', onPress: () => router.push(`/pours/new${params.element ? `?element=${params.element}` : ''}`) } : undefined} />} />
      {canPlan ? <Fab label="Plan pour" icon="calendar-check-outline" extended={ext} onPress={() => router.push(`/pours/new${params.element ? `?element=${params.element}` : ''}`)} /> : null}
    </Screen>
  );
}
