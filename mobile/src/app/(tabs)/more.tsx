// More: everything that isn't a tab — notifications, sync, documents, settings, theme, sign out.
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { useApp, useData, useSession } from '../../lib/app';
import { list } from '../../lib/db';
import { ROLE_LABELS, can, type AppNotification } from '../../lib/contract';
import { setThemeMode, space, useTheme, useUiPrefs, type ThemeMode } from '../../theme';
import { Card, Icon, ListRow, Screen, Section, Segmented, Text, confirm, useOutboxCounts, type IconName } from '../../components/ui';
import { kindFor } from '../../components/AppChrome';
import { fieldCounts } from '../../lib/counts';
import { canField } from '../../lib/contract-field';
import { canProcure } from '../../lib/contract-procurement';
import { canControl, ROLE_LABELS_AM } from '../../lib/contract-control';
import { pcCounts } from '../../lib/pc';
import { t as tr, useLocale } from '../../lib/i18n';
import { useDataVersion } from '../../lib/app';

export default function More() {
  const { profile, project } = useSession();
  const { signOut } = useApp();
  const t = useTheme();
  const { mode } = useUiPrefs();
  const kind = kindFor(profile.role);
  const { pending, failed } = useOutboxCounts();
  const unread = useData(() => list<AppNotification>('notifications', { parent: profile.id }).filter((n) => !n.read_at).length, [profile.id]);
  const field = useData(() => fieldCounts(project.id, profile.id), [project.id, profile.id]);
  const { locale } = useLocale();
  const v = useDataVersion();
  const pc = useData(() => pcCounts(project.id, v), [project.id]);

  const items: { icon: IconName; label: string; sub?: string; href: Href; show?: boolean; badge?: string }[] = [
    { icon: 'bell-outline', label: tr('title.notifications'), sub: unread ? `${unread} unread` : 'All read', href: '/notifications' },
    { icon: 'bell-alert-outline', label: tr('title.alerts'), href: '/alerts', show: canControl(profile.role, 'alert.manage'),
      sub: pc.openAlerts ? `${pc.openAlerts} open${pc.criticalAlerts ? ` · ${pc.criticalAlerts} critical` : ''}` : 'No open alerts' },
    { icon: 'boom-gate-outline', label: tr('gate.passes'), href: '/passes', show: kind !== 'gate' && (canControl(profile.role, 'gatepass.create') || canControl(profile.role, 'gatepass.verify')),
      sub: [pc.pendingExit ? `${pc.pendingExit} ${tr('gate.pendingExit').toLowerCase()}` : null, pc.onLoan ? `${pc.onLoan} ${tr('gate.onLoan').toLowerCase()}` : null, pc.overdue ? `${pc.overdue} ${tr('gate.overdue').toLowerCase()}` : null].filter(Boolean).join(' · ') || undefined },
    { icon: 'car-outline', label: tr('gate.vehicle'), href: '/gate/vehicle', show: canControl(profile.role, 'vehicle.log') },
    { icon: 'truck-delivery-outline', label: tr('home.expected'), href: '/procurement/deliveries', show: canProcure(profile.role, 'po.receive'),
      sub: pc.expected ? `${pc.expected} PO(s)${pc.expectedDelayed ? ` · ${tr('home.delayed', { n: pc.expectedDelayed })}` : ''}` : undefined },
    { icon: 'cart-outline', label: tr('act.purchaseOrders'), href: '/procurement', show: kind === 'procurement' || kind === 'management' },
    { icon: 'tag-outline', label: tr('act.logPrice'), href: '/procurement/price', show: canProcure(profile.role, 'price.log') },
    { icon: 'cart-arrow-down', label: tr('kpi.reorder'), href: '/procurement/reorder', show: canProcure(profile.role, 'reorder.createMr') },
    { icon: 'sync', label: tr('title.sync'), sub: failed ? `${failed} failed · tap to fix` : pending ? `${pending} waiting to sync` : 'Everything synced', href: '/sync' },
    { icon: 'account-clock-outline', label: 'Sign off & confirm deliveries', href: '/acknowledge', show: can(profile.role, 'miv.acknowledge') },
    { icon: 'clipboard-check-outline', label: 'Site & quality', href: '/field', show: kind !== 'procurement' && profile.role !== 'security',
      sub: [field.diaryToday === 'none' && canField(profile.role, 'diary.write') ? "Today's diary not started" : null, field.snagsMine ? `${field.snagsMine} snag(s) for you` : null,
        field.cubesDue ? `${field.cubesDue} cube test(s) due` : null, canField(profile.role, 'diary.sign') && field.diariesToSign ? `${field.diariesToSign} diary(ies) to sign` : null,
        canField(profile.role, 'inspection.perform') && field.inspectionsRequested ? `${field.inspectionsRequested} inspection(s) requested` : null].filter(Boolean).join(' · ') || 'Diary, inspections, snags, pours, cubes, rebar' },
    { icon: 'dump-truck', label: 'Ready-mix trucks to receive', href: '/pours/receive', show: canField(profile.role, 'pour.receiveTruck') && kind === 'store',
      sub: field.trucksAwaiting ? `${field.trucksAwaiting} waiting` : 'None waiting' },
    { icon: 'notebook-outline', label: 'Site diary', href: '/diary', show: canField(profile.role, 'diary.write') },
    { icon: 'bug-outline', label: 'Snags', href: '/snags', show: kind !== 'procurement' && profile.role !== 'security', sub: field.snagsOpen ? `${field.snagsOpen} open${field.snagsOverdue ? ` · ${field.snagsOverdue} overdue` : ''}` : undefined },
    { icon: 'clipboard-list-outline', label: 'Requests', href: '/requests', show: kind === 'store' },
    { icon: 'warehouse', label: 'Stock', href: '/stock', show: kind === 'office' || kind === 'management' },
    { icon: 'file-document-multiple-outline', label: 'Store documents', href: '/docs', show: kind !== 'store' },
    { icon: 'chart-gantt', label: 'Elements & progress', href: '/progress', show: kind === 'store' || kind === 'procurement' },
    { icon: 'check-decagram-outline', label: 'Emergency issues', href: '/approvals?tab=emergency', show: kind === 'store' },
    { icon: 'swap-horizontal', label: 'Transfers', href: '/store/transfer', show: can(profile.role, 'transfer.post') },
    { icon: 'counter', label: 'Stock count', href: '/store/count', show: can(profile.role, 'count.submit') },
    { icon: 'keyboard-return', label: 'Return to store', href: '/store/return', show: can(profile.role, 'mrn.post') },
    { icon: 'delete-variant', label: 'Wastage / damage', href: '/store/wastage', show: can(profile.role, 'adjustment.create') },
    { icon: 'magnify', label: tr('title.search'), href: '/search' },
    { icon: 'cog-outline', label: tr('common.settings'), href: '/settings' },
  ];

  return (
    <Screen insetBottom={false}>
      <Card>
        <View style={styles.me}>
          <View style={[styles.avatar, { backgroundColor: t.primaryContainer }]}><Icon name="account-hard-hat-outline" size={28} tone="primary" /></View>
          <View style={styles.flex}>
            <Text variant="titleSm">{profile.full_name}</Text>
            <Text variant="bodySm" tone="muted">{locale === 'am' ? ROLE_LABELS_AM[profile.role] : ROLE_LABELS[profile.role]} · {project.code}</Text>
          </View>
        </View>
      </Card>
      <Card flush>
        {items.filter((i) => i.show !== false).map((i) => (
          <ListRow key={i.label} id={i.label} title={i.label} subtitle={i.sub} icon={i.icon} chevron onPress={() => router.push(i.href)} />
        ))}
      </Card>
      <Section title={tr('set.theme')}>
        <Segmented<ThemeMode> value={mode} onChange={setThemeMode} accessibilityLabel="Theme" options={[
          { value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'sunlight', label: 'Sunlight' },
        ]} />
      </Section>
      <Card flush>
        <ListRow id="out" title={tr('common.signOut')} icon="logout" iconTone="danger" onPress={() => {
          const n = pending + failed;
          confirm('Sign out', n ? `${n} change(s) are not synced yet and will be lost if another user signs in on this device.` : 'You will need to sign in again.',
            () => void signOut(), 'Sign out', true);
        }} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  me: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
