// Register of store documents (GRN / MIV / MRN / adjustments / counts).
import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useSession } from '../../lib/app';
import { rowsWhere, syncStatusMap } from '../../lib/counts';
import { personName } from '../../lib/queries';
import { fmtDateTime } from '../../lib/format';
import { DOC_TABLE, type StoreDocType as DocType } from '../../lib/docs';
import { sentence, space } from '../../theme';
import { ChipGroup, EmptyState, ListRow, Screen } from '../../components/ui';
import { DOC_ICON } from '../../components/AppChrome';

export default function Docs() {
  const { project } = useSession();
  const params = useLocalSearchParams<{ type?: DocType }>();
  const [type, setType] = useState<DocType>(params.type ?? 'grn');

  const rows = useData(() => {
    const sync = syncStatusMap();
    return rowsWhere<Record<string, string | null | boolean>>(DOC_TABLE[type], project.id).map((r) => {
      const who = (r.supplier_name ?? (r.issued_to ? personName(r.issued_to as string) : null)
        ?? (r.requested_by ? personName(r.requested_by as string) : null) ?? (r.counted_by ? personName(r.counted_by as string) : null)) as string | null;
      const extra = (r.adj_type as string | undefined) ?? (r.is_emergency ? 'emergency' : undefined);
      const at = ((r.received_at ?? r.issued_at ?? r.returned_at ?? r.counted_at ?? r.sent_at ?? r.created_at) as string) ?? '';
      return {
        id: r.id as string, number: r.number as string, status: r.status as string, at,
        sub: `${fmtDateTime(at)}${who ? ` · ${who}` : ''}`, extra: extra ? sentence(extra) : null,
        sync: sync.get(r.id as string) ?? null,
      };
    }).sort((a, b) => b.at.localeCompare(a.at));
  }, [type, project.id]);

  const open = useCallback((id: string) => router.push(`/store/doc?type=${type}&id=${id}`), [type]);

  return (
    <Screen scroll={false} padded={false} insetBottom={false}>
      <View style={styles.head}>
        <ChipGroup<DocType> scroll value={type} onChange={setType} options={[
          { value: 'grn', label: 'Receipts (GRN)' }, { value: 'miv', label: 'Issues (MIV)' }, { value: 'mrn', label: 'Returns' },
          { value: 'adjustment', label: 'Adjustments' }, { value: 'count', label: 'Counts' },
        ]} />
      </View>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={({ item: r }) => (
          <ListRow id={r.id} title={r.number} subtitle={r.sub} status={r.status} icon={DOC_ICON[type]} sync={r.sync}
            chip={r.extra ? { label: r.extra, tone: r.extra === 'Emergency' ? 'danger' : 'warning' } : null} onPress={open} />
        )}
        ListEmptyComponent={<EmptyState icon={DOC_ICON[type]} title="No documents yet" body="Documents you post on this phone appear here straight away." compact />}
        contentContainerStyle={styles.list}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: space[4], paddingTop: space[2] },
  list: { paddingBottom: space[8] },
});
