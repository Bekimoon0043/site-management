// Toast / snackbar (spec §3.12): one at a time, bottom, 4 s (6 s with action), slide 16 dp + fade.
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { elevation, radius, space, useTheme } from '../../theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export interface ToastOptions {
  text: string;
  tone?: 'default' | 'success' | 'danger' | 'warning';
  action?: { label: string; onPress: () => void };
  /** Extra bottom offset (e.g. above a sticky action bar). */
  offset?: number;
}

let current: (ToastOptions & { id: number }) | null = null;
let seq = 0;
const ls = new Set<() => void>();
const emit = () => ls.forEach((l) => l());

/** Show a toast from anywhere: `toast.show({ text: 'Added to favourites', tone: 'success' })`. */
export const toast = {
  show(o: ToastOptions | string) {
    current = { ...(typeof o === 'string' ? { text: o } : o), id: ++seq };
    emit();
  },
  success(text: string, action?: ToastOptions['action']) { toast.show({ text, tone: 'success', action }); },
  error(text: string) { toast.show({ text, tone: 'danger' }); },
  hide() { current = null; emit(); },
};

const ICON: Record<NonNullable<ToastOptions['tone']>, IconName | null> = {
  default: null, success: 'check-circle-outline', danger: 'alert-octagon-outline', warning: 'alert-outline',
};

/** Mount once at the root. */
export function ToastHost() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const c = useSyncExternalStore((l) => { ls.add(l); return () => { ls.delete(l); }; }, () => current);
  const [shown, setShown] = useState<typeof c>(null);
  const v = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!c) {
      Animated.timing(v, { toValue: 0, duration: 150, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => setShown(null));
      return;
    }
    setShown(c);
    v.setValue(0);
    Animated.timing(v, { toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    const timer = setTimeout(() => { if (current?.id === c.id) toast.hide(); }, c.action ? 6000 : 4000);
    return () => clearTimeout(timer);
  }, [c, v]);

  if (!shown) return null;
  const bg = t.inverseSurface;
  const fg = t.onInverseSurface;
  const ic = ICON[shown.tone ?? 'default'];
  return (
    <Animated.View pointerEvents="box-none" style={[styles.wrap, {
      bottom: insets.bottom + 72 + (shown.offset ?? 0),
      opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
    }]}>
      <View accessibilityLiveRegion="polite" style={[styles.toast, elevation(t, 3), { backgroundColor: bg }]}>
        {ic ? <Icon name={ic} size={22} color={shown.tone === 'danger' ? (t.dark ? t.danger : '#FF9C93') : shown.tone === 'success' ? (t.dark ? t.success : '#7EDC9B') : fg} /> : null}
        <Text variant="bodySm" weight="600" color={fg} style={styles.flex} numberOfLines={2}>{shown.text}</Text>
        {shown.action ? (
          <Pressable onPress={() => { shown.action?.onPress(); toast.hide(); }} accessibilityRole="button" hitSlop={8} style={styles.action}>
            <Text variant="label" color={t.dark ? t.primary : '#8DB8EA'}>{shown.action.label}</Text>
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: space[4], right: space[4] },
  toast: { minHeight: 52, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[4], paddingVertical: space[2] },
  flex: { flex: 1 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
});
