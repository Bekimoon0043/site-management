// Role-based bottom tabs (spec §4.2). JS Tabs (expo-router/js-tabs) styled as an M3
// navigation bar: labelled items, primaryContainer pill + amber indicator, badges only
// for actionable counts. Tabs a role doesn't use are hidden with href: null.
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useData, useDataVersion, useSession, useSyncState } from '../../lib/app';
import { pcCounts } from '../../lib/pc';
import { ensureQrKey } from '../../lib/qr';
import { t as tr, useLocale } from '../../lib/i18n';
import { dashboardCounts, fieldCounts, flowInboxCounts, scheduleCounts } from '../../lib/counts';
import { typeFor, useTheme } from '../../theme';
import { Icon, type IconName } from '../../components/ui';
import { HeaderActions, ProjectSwitcher, kindFor, type RoleKind } from '../../components/AppChrome';

type TabKey = 'index' | 'queue' | 'requests' | 'approvals' | 'stock' | 'progress' | 'docs' | 'passes' | 'more';
const ROLE_TABS: Record<RoleKind, TabKey[]> = {
  store: ['index', 'queue', 'stock', 'docs', 'more'],
  site: ['index', 'requests', 'progress', 'stock', 'more'],
  office: ['index', 'approvals', 'requests', 'progress', 'more'],
  management: ['index', 'approvals', 'requests', 'progress', 'more'],
  procurement: ['index', 'approvals', 'requests', 'stock', 'more'],
  gate: ['index', 'passes', 'more'],
};

const ICONS: Record<TabKey, { on: IconName; off: IconName }> = {
  index: { on: 'home-variant', off: 'home-variant-outline' },
  queue: { on: 'package-variant-closed', off: 'package-variant-closed' },
  requests: { on: 'clipboard-list-outline', off: 'clipboard-list-outline' },
  approvals: { on: 'check-decagram', off: 'check-decagram-outline' },
  stock: { on: 'warehouse', off: 'warehouse' },
  progress: { on: 'chart-gantt', off: 'chart-gantt' },
  docs: { on: 'file-document-multiple-outline', off: 'file-document-multiple-outline' },
  passes: { on: 'boom-gate', off: 'boom-gate-outline' },
  more: { on: 'dots-horizontal-circle-outline', off: 'dots-horizontal' },
};

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { profile, project } = useSession();
  const kind = kindFor(profile.role);
  const tabs = ROLE_TABS[kind];
  const c = useData(() => dashboardCounts(project.id, profile.id), [project.id, profile.id]);
  const v = useDataVersion();
  const pc = useData(() => pcCounts(project.id, v), [project.id]);
  const fc = useData(() => fieldCounts(project.id, profile.id), [project.id, profile.id]);
  const sc = useData(() => scheduleCounts(project.id, profile.id), [project.id, profile.id]);
  // material procurement flow inbox (pr_review, pr_approve, pr_accept, mr_review, mr_approve, sur_issue, delivery_ack, miv_ack)
  const flc = useData(() => flowInboxCounts(project.id, profile.id, profile.role), [project.id, profile.id, profile.role]);
  useLocale();
  const { lastSyncAt } = useSyncState();
  // QR key for offline gate / label checks: fetched once per project (retried after each sync until it succeeds).
  useEffect(() => { void ensureQrKey(project.id, profile.role); }, [project.id, profile.role, lastSyncAt]);

  const badge: Partial<Record<TabKey, number>> = {
    queue: flc.sur_issue + flc.delivery_ack,
    requests: kind === 'site' ? c.returned + flc.miv_ack : undefined,
    approvals: kind === 'office' ? flc.mr_review : kind === 'procurement' ? flc.pr_accept
      : flc.mr_approve + flc.pr_review + flc.pr_approve + c.adjustments + c.counts + pc.posToApprove + pc.gateToApprove + (kind === 'management' ? sc.tasksToVerify : 0),
    passes: pc.pendingExit + pc.overdue,
    progress: kind === 'office' ? c.toVerify + fc.inspectionsRequested + sc.tasksToVerify + sc.constraintsMine
      : kind === 'site' ? fc.snagsMine + sc.myOverdue + sc.uncommittedReady + sc.constraintsMine
      : kind === 'management' ? sc.constraintsMine + (profile.role === 'coordinator' ? sc.uncommittedReady : 0) : undefined,
    more: kind === 'store' ? fc.trucksAwaiting : undefined,
  };
  const label: Record<TabKey, string> = {
    index: tr('tab.home'), queue: tr('tab.issue'), requests: tr('tab.requests'), approvals: kind === 'office' ? tr('tab.review') : tr('tab.approvals'),
    stock: tr('tab.stock'), progress: tr('tab.progress'), docs: tr('tab.docs'), passes: tr('gate.passes'), more: tr('tab.more'),
  };
  const title = typeFor('title', t);
  const lbl = typeFor('caption', t);

  const screen = (name: TabKey, headerTitle?: string) => {
    const shown = tabs.includes(name);
    const n = badge[name];
    return (
      <Tabs.Screen
        key={name}
        name={name}
        options={{
          href: shown ? undefined : null,
          title: headerTitle ?? label[name],
          ...(name === 'index' ? { headerTitle: () => <ProjectSwitcher />, headerRight: () => <HeaderActions search /> } : null),
          tabBarLabel: label[name],
          tabBarBadge: shown && n ? (n > 99 ? '99+' : n) : undefined,
          tabBarIcon: ({ focused }) => (
            <View style={styles.iconWrap}>
              {focused ? <View style={[styles.indicator, { backgroundColor: t.accent }]} /> : null}
              <View style={[styles.pill, focused && { backgroundColor: t.primaryContainer }]}>
                <Icon name={focused ? ICONS[name].on : ICONS[name].off} size={24} color={focused ? t.onPrimaryContainer : t.textMuted} />
              </View>
            </View>
          ),
        }}
      />
    );
  };

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.surface, borderBottomColor: t.border, borderBottomWidth: t.borderWidth === 2 ? 2 : StyleSheet.hairlineWidth },
        headerTintColor: t.text,
        headerTitleStyle: { fontSize: title.fontSize, fontWeight: title.fontWeight, color: t.text },
        headerTitleAlign: 'left',
        headerRight: () => <HeaderActions />,
        sceneStyle: { backgroundColor: t.background },
        tabBarActiveTintColor: t.text,
        tabBarInactiveTintColor: t.textMuted,
        tabBarStyle: {
          backgroundColor: t.surfaceElevated, borderTopColor: t.border, borderTopWidth: t.borderWidth,
          height: 68 + insets.bottom, paddingTop: 6, paddingBottom: Math.max(insets.bottom, 8),
        },
        tabBarLabelStyle: { fontSize: lbl.fontSize, fontWeight: '600' },
        tabBarBadgeStyle: { backgroundColor: t.danger, color: t.onDanger, fontSize: 11, fontWeight: '700' },
        tabBarItemStyle: { minHeight: 56 },
        tabBarAllowFontScaling: false,
        tabBarHideOnKeyboard: true,
      }}
    >
      {screen('index', project.code)}
      {screen('queue', tr('title.issueQueue'))}
      {screen('requests')}
      {screen('approvals')}
      {screen('stock')}
      {screen('progress')}
      {screen('docs', tr('title.storeDocs'))}
      {screen('passes')}
      {screen('more')}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconWrap: { alignItems: 'center', justifyContent: 'center' },
  pill: { width: 56, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  indicator: { position: 'absolute', top: -8, width: 24, height: 3, borderRadius: 2 },
});
