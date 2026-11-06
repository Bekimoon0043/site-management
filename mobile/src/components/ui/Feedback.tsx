// Empty states (§3.13), skeleton pulse (§3.14), success tick (§2.7), dialogs.
import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Alert, Animated, Easing, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import { radius, space, tone as toneOf, useTheme, type Tone } from '../../theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { Button } from './Button';
import { haptic } from './haptics';

export function EmptyState({ icon = 'information-outline', title, body, action, secondary, tone: tn = 'primary', compact }: {
  icon?: IconName; title: string; body?: string; tone?: Tone; compact?: boolean;
  action?: { label: string; onPress: () => void; icon?: IconName };
  secondary?: { label: string; onPress: () => void };
}) {
  const t = useTheme();
  const c = toneOf(t, tn);
  return (
    <View style={[styles.empty, compact && styles.emptyCompact]}>
      <View style={[styles.emptyIcon, { backgroundColor: c.container }]}><Icon name={icon} size={32} color={c.onContainer} /></View>
      <Text variant="title" align="center" numberOfLines={2}>{title}</Text>
      {body ? <Text variant="body" tone="muted" align="center">{body}</Text> : null}
      {action || secondary ? (
        <View style={styles.emptyActions}>
          {secondary ? <Button title={secondary.label} variant="outline" onPress={secondary.onPress} /> : null}
          {action ? <Button title={action.label} icon={action.icon} onPress={action.onPress} /> : null}
        </View>
      ) : null}
    </View>
  );
}
/** @deprecated use EmptyState */
export const Empty = ({ text }: { text: string }) => <EmptyState title={text} compact />;

// ---------------------------------------------------------------------------
// Skeleton: one shared native-driver pulse for every block
// ---------------------------------------------------------------------------

const pulse = new Animated.Value(1);
let pulseUsers = 0;
let pulseAnim: Animated.CompositeAnimation | null = null;
function usePulse() {
  useEffect(() => {
    let cancelled = false;
    pulseUsers++;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled || reduce || pulseAnim) return;
      pulseAnim = Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 0.5, duration: 450, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 450, useNativeDriver: true }),
      ]));
      pulseAnim.start();
    });
    return () => {
      cancelled = true;
      if (--pulseUsers === 0 && pulseAnim) { pulseAnim.stop(); pulseAnim = null; pulse.setValue(1); }
    };
  }, []);
  return pulse;
}

export function Skeleton({ width = '100%', height = 16, round = radius.sm, style }: { width?: DimensionValue; height?: number; round?: number; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const o = usePulse();
  return <Animated.View style={[{ width, height, borderRadius: round, backgroundColor: t.surfaceMuted, opacity: o }, style]} />;
}

// ---------------------------------------------------------------------------
// Success tick: 56 dp circle scales 0.6 → 1 and fades in; Confirm haptic.
// ---------------------------------------------------------------------------

export function SuccessTick({ size = 72 }: { size?: number }) {
  const t = useTheme();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    haptic('confirm');
    Animated.timing(v, { toValue: 1, duration: 250, easing: Easing.out(Easing.back(1.5)), useNativeDriver: true }).start();
  }, [v]);
  return (
    <Animated.View style={{
      width: size, height: size, borderRadius: size / 2, backgroundColor: t.success, alignItems: 'center', justifyContent: 'center',
      opacity: v, transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
    }}>
      <Icon name="check" size={size * 0.55} color={t.onSuccess} />
    </Animated.View>
  );
}

/** Full-screen confirmation after posting a document. */
export function SuccessView({ title, body, actions }: {
  title: string; body?: string;
  actions: { label: string; onPress: () => void; icon?: IconName; variant?: 'primary' | 'outline' | 'tonal' | 'hero' }[];
}) {
  const t = useTheme();
  return (
    <View style={[styles.success, { backgroundColor: t.background }]}>
      <SuccessTick />
      <Text variant="headline" align="center">{title}</Text>
      {body ? <Text variant="body" tone="muted" align="center">{body}</Text> : null}
      <View style={styles.successActions}>
        {actions.map((a) => <Button key={a.label} title={a.label} icon={a.icon} variant={a.variant ?? 'outline'} block onPress={a.onPress} />)}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Dialogs — Alert only for destructive confirmations and hard errors.
// ---------------------------------------------------------------------------

export function showError(e: unknown, title = 'Cannot continue') {
  haptic('reject');
  Alert.alert(title, e instanceof Error ? e.message : String(e));
}

export function confirm(title: string, message: string, onYes: () => void, yes = 'Confirm', destructive = false) {
  Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: yes, onPress: onYes, style: destructive ? 'destructive' : 'default' }]);
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', paddingTop: space[12], paddingBottom: space[8], paddingHorizontal: space[6], gap: space[2] },
  emptyCompact: { paddingTop: space[6], paddingBottom: space[6] },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: space[2] },
  emptyActions: { flexDirection: 'row', gap: space[3], marginTop: space[3], flexWrap: 'wrap', justifyContent: 'center' },
  success: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space[6], gap: space[3] },
  successActions: { alignSelf: 'stretch', gap: space[3], marginTop: space[6] },
});
