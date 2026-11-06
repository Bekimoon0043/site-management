// Inspections list: requested (to do), failed, all; ?element= narrows to one element.
import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useSession } from '../../lib/app';
import { get } from '../../lib/db';
import { jf, rowsWhere, syncStatusMap } from '../../lib/counts';
import { canField, type ChecklistTemplate, type Inspection } from '../../lib/contract-field';
import { elementLabel, personName } from '../../lib/queries';
import { fmtDate } from '../../lib/format';
import { space } from '../../theme';
import { ChipGroup, EmptyState, ListRow, Screen } from '../../components/ui';

type Filter = 'requested' | 'failed' | 'mine' | 'all';

export default function Inspections() {
  const { profile, project } = useSession();
  const params = useLocalSearchParams<{ element?: string; filter?: Filter }>();
  const [filter, setFilter] = useState<Filter>(params.filter ?? (params.element ? 'all' : 'requested'));
  const rows = useData(() => {
    const sync = syncStatusMap();
    const tpl = new Map<string, string>();
    const where = [
      params.element ? `AND parent = ?` : '',
      filter === 'requested' ? `AND ${jf('status')} = 'requested'` : filter === 'failed' ? `AND ${jf('result')} = 'fail'` : filter === 'mine' ? `AND ${jf('requested_by')} = ?` : '',
    ].join(' ');
    const args = [...(params.element ? [params.element] : []), ...(filter === 'mine' ? [profile.id] : [])];
    return rowsWhere<Inspection>('inspections', project.id, where, args, `${jf('created_at')} DESC`, 300).map((i) => {
      if (!tpl.has(i.template_id)) tpl.set(i.template_id, get<ChecklistTemplate>('checklist_templates', i.template_id)?.name ?? 'Checklist');
      return {
        id: i.id, title: `${elementLabel(i.element_id)} · ${tpl.get(i.template_id)}`,
        sub: `${i.number} · ${i.status === 'requested' ? `requested by ${personName(i.requested_by)}` : fmtDate(i.inspected_at ?? i.created_at)}`,
        status: i.status === 'completed' ? i.result : i.status, sync: sync.get(i.id) ?? null,
      };
    });
  }, [project.id, profile.id, filter, params.element]);
  const open = useCallback((id: string) => router.push(`/inspections/${id}`), []);
  const performer = canField(profile.role, 'inspection.perform');

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: params.element ? `Inspections · ${elementLabel(params.element)}` : 'Inspections' }} />
      <View style={{ padding: space[4], paddingBottom: space[2] }}>
        <ChipGroup<Filter> scroll value={filter} onChange={setFilter} options={[
          { value: 'requested', label: performer ? 'To inspect' : 'Requested', icon: 'clipboard-text-outline' }, { value: 'failed', label: 'Failed' },
          { value: 'mine', label: 'My requests' }, { value: 'all', label: 'All' },
        ]} />
      </View>
      <FlashList data={rows} keyExtractor={(r) => r.id}
        renderItem={({ item: r }) => <ListRow id={r.id} title={r.title} subtitle={r.sub} status={r.status} sync={r.sync} icon="clipboard-check-outline" onPress={open} />}
        ListEmptyComponent={<EmptyState icon="clipboard-check-outline" title={filter === 'requested' ? 'No inspections waiting' : 'No inspections'}
          body="Request an inspection from an element's hold-point activity on the Progress tab." />} />
    </Screen>
  );
}
