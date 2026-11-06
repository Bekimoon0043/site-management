// App chrome shared by tab screens: header actions (sync pill, bell, search) and the
// Home project switcher ("BOLE-RES ▾" → project sheet).
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useApp, useData, useSession } from '../lib/app';
import { list } from '../lib/db';
import { dashboardFor, type AppNotification, type AppRole } from '../lib/contract';
import { projects } from '../lib/queries';
import { t } from '../lib/i18n';
import { dashboardForControl } from '../lib/contract-control';
import { space, useTheme } from '../theme';
import { Icon, IconButton, ListRow, Sheet, SyncPill, Text, type IconName } from './ui';
import type { StoreDocType } from '../lib/docs';

export type RoleKind = 'store' | 'site' | 'office' | 'management' | 'procurement' | 'gate';
/** Security has its own gate home (contract-control dashboardForControl). */
export const kindFor = (role: AppRole): RoleKind =>
  (role === 'procurement' ? 'procurement' : dashboardForControl(role) === 'gate' ? 'gate' : dashboardFor(role));

export const DOC_ICON: Record<StoreDocType, IconName> = {
  grn: 'truck-delivery-outline', miv: 'package-variant-closed-remove', mrn: 'keyboard-return',
  adjustment: 'delete-variant', count: 'counter', transfer: 'swap-horizontal',
};

export function HeaderActions({ search }: { search?: boolean }) {
  const { profile } = useSession();
  const unread = useData(() => list<AppNotification>('notifications', { parent: profile.id }).filter((n) => !n.read_at).length, [profile.id]);
  return (
    <View style={styles.actions}>
      <SyncPill />
      <IconButton icon={unread ? 'bell' : 'bell-outline'} badge={unread} accessibilityLabel={t('title.notifications')} onPress={() => router.push('/notifications')} />
      {search ? <IconButton icon="magnify" accessibilityLabel={t('title.search')} onPress={() => router.push('/search')} /> : null}
    </View>
  );
}

export function ProjectSwitcher() {
  const t = useTheme();
  const { project, selectProject } = useApp();
  const [open, setOpen] = useState(false);
  const ps = useData(() => projects());
  const multi = ps.length > 1;
  return (
    <>
      <Pressable disabled={!multi} onPress={() => setOpen(true)} accessibilityRole="button"
        accessibilityLabel={`Project ${project?.code ?? ''}${multi ? ', change project' : ''}`} hitSlop={8} style={styles.switcher}
        android_ripple={{ color: t.ripple }}>
        <Text variant="title" numberOfLines={1}>{project?.code ?? ''}</Text>
        {multi ? <Icon name="menu-down" size={24} tone="text" /> : null}
      </Pressable>
      {open ? (
        <Sheet visible={open} onClose={() => setOpen(false)} title="Switch project">
          <View style={styles.list}>
            {ps.map((p) => (
              <ListRow key={p.id} id={p.id} title={p.name} subtitle={`${p.code}${p.location ? ` · ${p.location}` : ''}`}
                icon={p.id === project?.id ? 'check' : 'crane'} iconTone={p.id === project?.id ? 'success' : 'primary'}
                onPress={(id) => { selectProject(id); setOpen(false); }} />
            ))}
          </View>
        </Sheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center', marginRight: 4 },
  switcher: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 48, paddingRight: space[2] },
  list: { paddingBottom: space[2] },
});
