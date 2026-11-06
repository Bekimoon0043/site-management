// Requests list (role-filtered), FlashList with memoised rows, extended FAB.
import React, { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useDataVersion, useSession } from '../../lib/app';
import { can } from '../../lib/contract';
import { mrField, mrRows, syncStatusMap } from '../../lib/counts';
import { specMap, personName } from '../../lib/queries';
import { addDays, fmtDate, today } from '../../lib/format';
import { t, useLocale } from '../../lib/i18n';
import { priorityInfo, space } from '../../theme';
import { ActionTile, ChipGroup, EmptyState, Fab, Grid, ListRow, Screen, SearchInput, Sheet, fabScroll, normalize } from '../../components/ui';
import { type Href } from 'expo-router';
import { canFlow } from '../../lib/contract-flows';
import { requestTypeOf, sqlRequestType, typeLabel } from '../../lib/flows';
import { ft } from '../../lib/flows-i18n';
import { flowRowChip } from '../../components/FlowTimeline';

type Filter = 'all' | 'mine' | 'open' | 'purchase' | 'to_issue' | 'lookahead' | 'closed';

const WHERE: Record<Filter, string> = {
  all: '',
  mine: '',
  open: `AND ${mrField('status')} NOT IN ('received','closed','rejected','cancelled') AND NOT (${mrField('status')} = 'issued' AND ${sqlRequestType('r')} = 'site_use')`,
  purchase: `AND ${sqlRequestType('r')} = 'purchase' AND ${mrField('status')} NOT IN ('closed','rejected','cancelled')`,
  to_issue: `AND ${sqlRequestType('r')} = 'site_use' AND ${mrField('status')} IN ('approved','partially_issued','sourced','ordered')`,
  lookahead: `AND ${mrField('status')} NOT IN ('draft','received','closed','rejected','cancelled','issued') AND ${mrField('required_date')} <= ?`,
  closed: `AND ${mrField('status')} IN ('issued','received','closed','rejected','cancelled')`,
};

export default function Requests() {
  useLocale();
  const { profile, project } = useSession();
  const params = useLocalSearchParams<{ filter?: Filter }>();
  const seesAll = can(profile.role, 'mr.viewAll') || profile.role === 'store_keeper' || profile.role === 'office_engineer';
  const [filter, setFilter] = useState<Filter>(params.filter ?? (seesAll ? 'open' : 'mine'));
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const [ext, setExt] = useState(true);
  const onScroll = useMemo(() => fabScroll(setExt), []);
  const v = useDataVersion();

  const rows = useData(() => {
    const sm = specMap(v);
    const sync = syncStatusMap();
    let where = WHERE[filter];
    const args: (string | number)[] = [];
    if (filter === 'lookahead') args.push(addDays(today(), 14));
    if (!seesAll || filter === 'mine') { where += ` AND ${mrField('requested_by')} = ?`; args.push(profile.id); }
    const nq = normalize(dq);
    return mrRows(project.id, where, args).map((r) => {
      const labels = r.specIds.map((id) => sm.get(id)?.label ?? 'Material');
      const summary = labels.slice(0, 2).join(', ') + (r.lineCount > 2 ? ` +${r.lineCount - 2}` : '');
      const p = priorityInfo(r.priority);
      const type = requestTypeOf(r);
      return {
        id: r.id, number: r.number, status: r.status, summary: `${typeLabel(type)} · ${summary || 'No lines'}`,
        meta: `${p ? `${p.label} · ` : ''}Needed ${fmtDate(r.required_date)} · ${personName(r.requested_by)}${r.is_lookahead ? ' · look-ahead' : ''}`,
        chip: flowRowChip(r.status, type), purchase: type === 'purchase',
        sync: sync.get(r.id) ?? null,
        key: nq ? normalize(`${r.number} ${labels.join(' ')}`) : '',
      };
    }).filter((r) => !nq || r.key.includes(nq));
  }, [project.id, filter, seesAll, profile.id, dq]);

  const open = useCallback((id: string) => router.push(`/requests/${id}`), []);
  // Site engineer → site use; office engineer (and other PR roles) → purchase, with site use available too.
  const canSur = can(profile.role, 'mr.create');
  const canPr = canFlow(profile.role, 'pr.create');
  const canCreate = canSur || canPr;
  const [choose, setChoose] = useState(false);
  const create = () => {
    if (canSur && canPr) setChoose(true);
    else router.push((canPr ? '/requests/purchase' : '/requests/new') as Href);
  };

  return (
    <Screen scroll={false} padded={false} insetBottom={false}>
      <View style={styles.head}>
        <SearchInput value={q} onChangeText={setQ} onClear={() => setQ('')} placeholder={t('mr.searchList')} />
        <ChipGroup<Filter> scroll value={filter} onChange={setFilter} options={[
          ...(seesAll ? [{ value: 'open' as const, label: 'Open' }] : []),
          { value: 'mine', label: 'Mine' },
          { value: 'purchase', label: ft('flow.type.purchaseShort') },
          { value: 'to_issue', label: 'To issue' },
          { value: 'lookahead', label: 'Next 14 days' },
          { value: 'closed', label: 'Closed' },
          ...(seesAll ? [{ value: 'all' as const, label: 'All' }] : []),
        ]} />
      </View>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.id}
        onScroll={onScroll}
        contentContainerStyle={styles.list}
        renderItem={({ item: r }) => (
          <ListRow id={r.id} title={r.number} subtitle={r.summary} meta={r.meta} chip={r.chip}
            icon={r.purchase ? 'cart-outline' : 'clipboard-list-outline'} sync={r.sync} onPress={open} />
        )}
        ListEmptyComponent={q ? (
          <EmptyState icon="magnify" title={`No match for “${q}”`} action={{ label: 'Clear search', onPress: () => setQ('') }} />
        ) : (
          <EmptyState icon="clipboard-text-outline" title={t('mr.none')} body={t('mr.noneBody')}
            action={canCreate ? { label: 'New request', icon: 'plus', onPress: create } : undefined} />
        )}
      />
      {canCreate ? <Fab label="New request" extended={ext} onPress={create} /> : null}
      {choose ? (
        <Sheet visible onClose={() => setChoose(false)} title={ft('flow.whatKind')}>
          <View style={styles.sheet}>
            <Grid>
              <ActionTile icon="cart-plus" label={ft('flow.newPurchase')} hint={ft('flow.kindPurchaseHint')}
                onPress={() => { setChoose(false); router.push('/requests/purchase' as Href); }} />
              <ActionTile icon="package-variant-closed" label={ft('flow.newSiteUse')} hint={ft('flow.kindSiteUseHint')}
                onPress={() => { setChoose(false); router.push('/requests/new'); }} />
            </Grid>
          </View>
        </Sheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: space[4], paddingTop: space[3], gap: space[1] },
  list: { paddingBottom: 96 },
  sheet: { paddingHorizontal: space[4], paddingBottom: space[4] },
});
