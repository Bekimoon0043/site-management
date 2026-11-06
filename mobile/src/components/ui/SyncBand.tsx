// Sync UI (spec §1.6, §3.11): header sync pill, offline band, per-record sync chip/icon,
// failure banner, "last synced" line. Optimistic writes never block on the network.
import React, { memo, useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useData, useDataVersion, useSyncState } from '../../lib/app';
import { getDb } from '../../lib/db';
import { entitySyncStatus, syncNow } from '../../lib/sync';
import { ago } from '../../lib/format';
import { radius, space, SYNC_INFO, tone as toneOf, useTheme } from '../../theme';
import { Icon } from './Icon';
import { Text } from './Text';
import { Chip } from './Chip';
import { Banner } from './Layout';

export function useOutboxCounts() {
  return useData(() => {
    const r = getDb().getFirstSync<{ p: number; f: number }>(
      `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS p, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS f FROM outbox`);
    return { pending: r?.p ?? 0, failed: r?.f ?? 0 };
  });
}

/** One looped native-driver rotation while syncing. */
export function SpinningIcon({ spinning, size = 22, color }: { spinning: boolean; size?: number; color: string }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!spinning) { v.stopAnimation(); v.setValue(0); return; }
    const a = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [spinning, v]);
  const rotate = v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-360deg'] });
  return <Animated.View style={{ transform: [{ rotate }] }}><Icon name="sync" size={size} color={color} /></Animated.View>;
}

/** Header pill: icon only when synced, "⬆ 3" when pending, danger when failed. Tap → Sync status. */
export function SyncPill() {
  const t = useTheme();
  const s = useSyncState();
  const { pending, failed } = useOutboxCounts();
  const kind = failed ? 'failed' : s.running ? 'syncing' : !s.online ? 'offline' : pending ? 'pending' : 'synced';
  const info = SYNC_INFO[kind];
  const c = toneOf(t, info.tone);
  const fg = kind === 'synced' ? t.textMuted : c.onContainer;
  const count = failed || pending;
  return (
    <Pressable onPress={() => router.push('/sync')} accessibilityRole="button"
      accessibilityLabel={`Sync status: ${info.label}${count ? `, ${count} changes` : ''}`}
      android_ripple={{ color: t.ripple, borderless: true, radius: 24 }} style={styles.pillHit}>
      <View style={[styles.pill, { backgroundColor: kind === 'synced' ? 'transparent' : c.container }]}>
        {kind === 'syncing' ? <SpinningIcon spinning size={20} color={fg} /> : <Icon name={info.icon} size={20} color={fg} />}
        {count && kind !== 'syncing' ? <Text variant="caption" weight="700" color={fg} num>{count}</Text> : null}
      </View>
    </Pressable>
  );
}

/** 36 dp strip under the header, only when offline or something failed. */
export function OfflineBand() {
  const t = useTheme();
  const s = useSyncState();
  const { pending, failed } = useOutboxCounts();
  const show = !s.online || failed > 0;
  const o = useRef(new Animated.Value(show ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(o, { toValue: show ? 1 : 0, duration: 150, useNativeDriver: true }).start();
  }, [show, o]);
  if (!show) return null;
  const text = failed
    ? `${failed} change${failed > 1 ? 's' : ''} rejected by the server · tap to fix`
    : `Offline · ${pending ? `${pending} change${pending > 1 ? 's' : ''} saved on this phone` : 'working from this phone'}`;
  return (
    <Animated.View style={{ opacity: o }}>
      <Pressable onPress={() => router.push('/sync')} accessibilityRole="button" accessibilityLabel={text}
        style={[styles.band, { backgroundColor: failed ? t.danger : t.offlineBand }]}>
        <Icon name={failed ? 'cloud-alert-outline' : 'cloud-off-outline'} size={18} color={failed ? t.onDanger : t.onOfflineBand} />
        <Text variant="bodySm" weight="600" color={failed ? t.onDanger : t.onOfflineBand} numberOfLines={1} style={styles.flex}>{text}</Text>
      </Pressable>
    </Animated.View>
  );
}

/** Per-record chip: quiet when synced (unless `showSynced`), warning when pending, danger when failed. */
export const SyncChip = memo(function SyncChip({ entityId, showSynced }: { entityId: string; showSynced?: boolean }) {
  useDataVersion();
  const s = entitySyncStatus(entityId);
  if (!s) return null;
  if (s.status === 'synced') return showSynced ? <Chip label="Synced" tone="success" icon="cloud-check-outline" /> : null;
  const info = SYNC_INFO[s.status === 'pending' ? 'pending' : 'failed'];
  return <Chip label={s.status === 'pending' ? 'Saved on phone · will sync' : 'Sync failed'} tone={info.tone} icon={info.icon} />;
});
/** @deprecated alias */
export const SyncBadge = SyncChip;

/** Small 16 dp icon for list rows (calm rows: no full chip). Pass a pre-computed status. */
export const SyncDot = memo(function SyncDot({ status }: { status: 'pending' | 'failed' | 'synced' | null | undefined }) {
  if (!status || status === 'synced') return null;
  return <Icon name={status === 'pending' ? 'cloud-upload-outline' : 'cloud-alert-outline'} size={16} tone={status === 'pending' ? 'warning' : 'danger'}
    accessibilityLabel={status === 'pending' ? 'Saved on phone, will sync' : 'Sync failed'} />;
});

/** Failure banner on an affected record (keeps the existing SyncError copy, restyled). */
export function SyncError({ entityId }: { entityId: string }) {
  useDataVersion();
  const s = entitySyncStatus(entityId);
  if (s?.status !== 'failed') return null;
  return (
    <Banner tone="danger" title="Rejected by the server" text={s.error ?? 'The server did not accept this change.'}
      actions={[{ label: 'Fix in Sync status', onPress: () => router.push('/sync') }]} />
  );
}

/** "Last synced 4 min ago · Sync now" line. */
export function LastSynced() {
  const s = useSyncState();
  const stale = !s.lastSyncAt || Date.now() - new Date(s.lastSyncAt).getTime() > 30 * 60 * 1000;
  return (
    <Pressable onPress={() => void syncNow()} accessibilityRole="button" accessibilityLabel="Sync now" style={styles.last}>
      <Icon name={stale ? 'clock-alert-outline' : 'cloud-check-outline'} size={16} tone="muted" />
      <Text variant="caption" tone="muted">
        {s.running ? 'Syncing…' : `Last synced ${ago(s.lastSyncAt)}`}{stale && !s.running ? ' · Sync now' : ''}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pillHit: { minWidth: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  pill: { height: 32, minWidth: 32, paddingHorizontal: 8, borderRadius: radius.pill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  band: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[4] },
  last: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, alignSelf: 'center' },
});
