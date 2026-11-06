// Snag list (features C2): mine / open / overdue / to review / closed, ?element= narrows.
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useSession } from '../../lib/app';
import { jf, rowsWhere, syncStatusMap } from '../../lib/counts';
import { canField, type Snag } from '../../lib/contract-field';
import { elementLabel, personName } from '../../lib/queries';
import { fmtDate, today } from '../../lib/format';
import { space } from '../../theme';
import { ChipGroup, EmptyState, Fab, ListRow, Screen, fabScroll } from '../../components/ui';
import { ElementPicker } from '../../components/pickers';
import { SEVERITY_INFO } from '../../components/field';

type Filter = 'mine' | 'open' | 'overdue' | 'review' | 'closed' | 'all';
const OPEN = `('open','in_progress','reopened','ready_for_review')`;

export default function Snags() {
  const { profile, project } = useSession();
  const params = useLocalSearchParams<{ element?: string; filter?: Filter }>();
  const [filter, setFilter] = useState<Filter>(params.filter ?? (params.element ? 'open' : profile.role === 'office_engineer' ? 'review' : 'mine'));
  const [elementId, setElementId] = useState<string | null>(params.element ?? null);
  const [ext, setExt] = useState(true);
  const onScroll = useMemo(() => fabScroll(setExt), []);
  const rows = useData(() => {
    const sync = syncStatusMap();
    const t0 = today();
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (elementId) { where.push('AND parent = ?'); args.push(elementId); }
    if (filter === 'mine') { where.push(`AND (${jf('assignee_user_id')} = ? OR ${jf('raised_by')} = ?) AND ${jf('status')} IN ${OPEN}`); args.push(profile.id, profile.id); }
    if (filter === 'open') where.push(`AND ${jf('status')} IN ${OPEN}`);
    if (filter === 'overdue') { where.push(`AND ${jf('status')} IN ${OPEN} AND ${jf('due_date')} IS NOT NULL AND ${jf('due_date')} < ?`); args.push(t0); }
    if (filter === 'review') where.push(`AND ${jf('status')} = 'ready_for_review'`);
    if (filter === 'closed') where.push(`AND ${jf('status')} IN ('closed','cancelled')`);
    const order = `CASE ${jf('severity')} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, ${jf('created_at')} DESC`;
    return rowsWhere<Snag>('snags', project.id, where.join(' '), args, order, 500).map((s) => {
      const overdue = !!s.due_date && s.due_date < t0 && !['closed', 'cancelled'].includes(s.status);
      const sev = SEVERITY_INFO[s.severity];
      return {
        id: s.id, title: s.title, status: s.status, sync: sync.get(s.id) ?? null, tone: sev.tone,
        sub: [s.number, s.element_id ? elementLabel(s.element_id) : s.location_text].filter(Boolean).join(' · '),
        meta: [s.assignee_user_id ? personName(s.assignee_user_id) : s.assignee_party, s.due_date ? `due ${fmtDate(s.due_date)}` : null].filter(Boolean).join(' · ') || null,
        chip: overdue ? { label: 'Overdue', tone: 'danger' as const, icon: 'clock-alert-outline' as const } : s.severity === 'critical' || s.severity === 'high' ? { label: sev.label, tone: sev.tone, icon: sev.icon } : null,
      };
    });
  }, [project.id, profile.id, filter, elementId]);
  const open = useCallback((id: string) => router.push(`/snags/${id}`), []);
  const canCreate = canField(profile.role, 'snag.create');
  const newHref = `/snags/new${elementId ? `?element=${elementId}` : ''}`;

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: 'Snags' }} />
      <View style={{ padding: space[4], paddingBottom: space[2], gap: space[2] }}>
        <ChipGroup<Filter> scroll value={filter} onChange={setFilter} options={[
          { value: 'mine', label: 'Mine' }, { value: 'open', label: 'Open' }, { value: 'overdue', label: 'Overdue', icon: 'clock-alert-outline' },
          { value: 'review', label: 'To review', icon: 'eye-outline' }, { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' },
        ]} />
        <ElementPicker projectId={project.id} label="Element" optional allowClear value={elementId} onChange={setElementId} placeholder="All elements" />
      </View>
      <FlashList data={rows} keyExtractor={(r) => r.id} onScroll={onScroll}
        renderItem={({ item: r }) => <ListRow id={r.id} title={r.title} subtitle={r.sub} meta={r.meta} status={r.status} chip={r.chip} stripe={r.tone === 'neutral' ? null : r.tone} sync={r.sync} icon="bug-outline" onPress={open} />}
        ListEmptyComponent={<EmptyState icon="bug-outline" tone="success" title="No snags here" body="Defects found on site are raised with a photo in a few seconds."
          action={canCreate ? { label: 'Raise snag', onPress: () => router.push(newHref as never) } : undefined} />} />
      {canCreate ? <Fab label="Raise snag" icon="camera-plus-outline" extended={ext} onPress={() => router.push(newHref as never)} /> : null}
    </Screen>
  );
}
