// Gate passes (D1): pending exit / on loan / overdue return / to approve. The guard's main list;
// store keepers and engineers reach it from Home / More. Tap → pass detail (verify, return, approve).
import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useSession } from '../../lib/app';
import { canControl } from '../../lib/contract-control';
import { syncStatusMap } from '../../lib/counts';
import { gatePassLines, gatePasses, isOverdue, type GateFilter } from '../../lib/pc';
import { fmtDate } from '../../lib/format';
import { t, useLocale } from '../../lib/i18n';
import { space } from '../../theme';
import { Button, ChipGroup, EmptyState, Fab, ListRow, Row, Screen } from '../../components/ui';

export default function GatePasses() {
  const { profile, project } = useSession();
  useLocale();
  const [filter, setFilter] = useState<GateFilter>(profile.role === 'security' ? 'pending_exit' : 'all');
  const rows = useData(() => {
    const sync = syncStatusMap();
    return gatePasses(project.id, filter, profile.id).map((g) => {
      const n = gatePassLines(g.id).length;
      const overdue = isOverdue(g);
      return {
        id: g.id, number: g.number, status: overdue ? 'overdue' : g.status,
        sub: `${g.pass_type === 'returnable' ? t('gate.returnable') : t('gate.nonReturnable')} · ${g.destination} · ${n} item${n === 1 ? '' : 's'}`,
        meta: `${g.vehicle_plate ?? '—'}${g.expected_return ? ` · ${t('gate.expectedReturn')} ${fmtDate(g.expected_return)}` : ''}`,
        stripe: overdue ? ('danger' as const) : g.status === 'approved' ? ('info' as const) : null,
        sync: sync.get(g.id) ?? null,
      };
    });
  }, [project.id, filter, profile.id]);
  const open = useCallback((id: string) => router.push(`/gate/${id}`), []);
  const canCreate = canControl(profile.role, 'gatepass.create');
  const canVerify = canControl(profile.role, 'gatepass.verify');

  return (
    <Screen scroll={false} padded={false} insetBottom={false}>
      <View style={styles.head}>
        {canVerify ? (
          <Row>
            <Button title={t('gate.scan')} icon="qrcode-scan" variant="tonal" flex onPress={() => router.push('/gate/scan')} />
            <Button title={t('gate.vehicle')} icon="car-outline" variant="outline" flex onPress={() => router.push('/gate/vehicle')} />
          </Row>
        ) : null}
        <ChipGroup<GateFilter> scroll value={filter} onChange={setFilter} options={[
          { value: 'pending_exit', label: t('gate.pendingExit') }, { value: 'on_loan', label: t('gate.onLoan') },
          { value: 'overdue', label: t('gate.overdue'), tone: 'danger' }, { value: 'to_approve', label: t('status.pending') },
          ...(canCreate ? [{ value: 'mine' as const, label: 'Mine' }] : []), { value: 'all', label: t('common.all') },
        ]} />
      </View>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={({ item: r }) => (
          <ListRow id={r.id} title={r.number} subtitle={r.sub} meta={r.meta} status={r.status} stripe={r.stripe} sync={r.sync}
            icon="boom-gate-outline" chevron onPress={open} />
        )}
        ListEmptyComponent={<EmptyState icon="boom-gate-outline" tone="success" title={t('common.allCaught')} compact
          body="Gate passes show up here once requested and approved." />}
        contentContainerStyle={styles.list}
      />
      {canCreate ? <Fab label={t('gate.new')} onPress={() => router.push('/gate/new')} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { padding: space[4], gap: space[3], paddingBottom: space[1] },
  list: { paddingBottom: space[12] },
});
