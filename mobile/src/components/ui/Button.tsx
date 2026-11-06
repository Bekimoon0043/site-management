// Buttons (spec §3.1) and icon buttons. Native ripple for press feedback.
import React, { memo, useRef } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { makeStyles, radius, size, useTheme, type Theme } from '../../theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'hero' | 'tonal' | 'outline' | 'ghost' | 'danger' | 'dangerOutline';
export type ButtonSize = 'lg' | 'md' | 'sm';

function colors(t: Theme, v: ButtonVariant, disabled: boolean) {
  if (disabled) return { bg: t.surfaceMuted, fg: t.textDisabled, border: 'transparent', bw: 0 };
  switch (v) {
    case 'hero': return { bg: t.accent, fg: t.onAccent, border: t.dark ? 'transparent' : t.accentStrong, bw: t.dark ? 0 : 1.5 };
    case 'tonal': return { bg: t.primaryContainer, fg: t.onPrimaryContainer, border: 'transparent', bw: 0 };
    case 'outline': return { bg: 'transparent', fg: t.primary, border: t.borderStrong, bw: Math.max(1.5, t.borderWidth) };
    case 'ghost': return { bg: 'transparent', fg: t.primary, border: 'transparent', bw: 0 };
    case 'danger': return { bg: t.danger, fg: t.onDanger, border: 'transparent', bw: 0 };
    case 'dangerOutline': return { bg: 'transparent', fg: t.danger, border: t.danger, bw: Math.max(1.5, t.borderWidth) };
    default: return { bg: t.primary, fg: t.onPrimary, border: 'transparent', bw: 0 };
  }
}

const HEIGHT: Record<ButtonSize, number> = { lg: 56, md: 48, sm: 40 };

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  /** Full width. */
  block?: boolean;
  /** Grow to fill a row (flex: 1). */
  flex?: boolean;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

export const Button = memo(function Button({
  title, onPress, variant = 'primary', size: sz = 'lg', icon, iconRight, block, flex, disabled = false, busy = false,
  style, testID, accessibilityLabel, accessibilityHint,
}: ButtonProps) {
  const t = useTheme();
  const c = colors(t, variant, disabled);
  const width = useRef<number | null>(null);
  const h = HEIGHT[sz];
  return (
    <View
      style={[
        { minHeight: sz === 'sm' ? size.touch : h, justifyContent: 'center' },
        block && styles.block, flex && styles.flex, style,
      ]}
      onLayout={(e) => { if (!busy) width.current = e.nativeEvent.layout.width; }}
    >
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: disabled || busy, busy }}
        disabled={disabled || busy}
        onPress={onPress}
        android_ripple={{ color: t.ripple, borderless: false }}
        style={[
          styles.btn,
          {
            minHeight: h, backgroundColor: c.bg, borderColor: c.border, borderWidth: c.bw,
            paddingHorizontal: sz === 'sm' ? 14 : 20, minWidth: busy && width.current ? width.current : undefined,
          },
        ]}
      >
        {busy ? <ActivityIndicator color={c.fg} /> : (
          <>
            {icon ? <Icon name={icon} size={20} color={c.fg} /> : null}
            <Text variant="button" color={c.fg} numberOfLines={1} style={sz === 'sm' ? styles.smText : undefined}>{title}</Text>
            {iconRight ? <Icon name={iconRight} size={20} color={c.fg} /> : null}
          </>
        )}
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  btn: { borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, overflow: 'hidden' },
  block: { alignSelf: 'stretch' },
  flex: { flex: 1 },
  smText: { fontSize: 15 },
});

// ---------------------------------------------------------------------------
// Icon button: 24 dp glyph in a 48 dp target (spec §2.3)
// ---------------------------------------------------------------------------

const useIbStyles = makeStyles((t) => ({
  ib: { width: size.touch, height: size.touch, borderRadius: size.touch / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  badge: {
    position: 'absolute', top: 4, right: 2, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9,
    backgroundColor: t.danger, alignItems: 'center', justifyContent: 'center',
  },
  badgeText: { color: t.onDanger, fontSize: 11, fontWeight: '700', lineHeight: 14 },
  filled: { backgroundColor: t.surfaceMuted },
}));

export const IconButton = memo(function IconButton({ icon, onPress, accessibilityLabel, tone = 'text', badge, filled, color, testID, size: iconSize = 24 }: {
  icon: IconName; onPress: () => void; accessibilityLabel: string; tone?: 'text' | 'muted' | 'primary' | 'danger' | 'onPrimary';
  /** Count badge (shown only when > 0). */
  badge?: number; filled?: boolean; color?: string; testID?: string; size?: number;
}) {
  const t = useTheme();
  const s = useIbStyles();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${accessibilityLabel}, ${badge}` : accessibilityLabel}
      android_ripple={{ color: t.ripple, borderless: true, radius: 24 }}
      style={[s.ib, filled && s.filled]}
    >
      <Icon name={icon} size={iconSize} tone={tone} color={color} />
      {badge ? (
        <View style={s.badge}>
          <Text style={s.badgeText} maxFontSizeMultiplier={1}>{badge > 9 ? '9+' : String(badge)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
});

// ---------------------------------------------------------------------------
// Extended FAB (amber, navy-dark label). Shrinks to icon-only while scrolling down:
//   const [ext, setExt] = useState(true);  onScroll={fabScroll(setExt)}
// ---------------------------------------------------------------------------

export const Fab = memo(function Fab({ label, icon = 'plus', onPress, extended = true, bottom = 16 }: {
  label: string; icon?: IconName; onPress: () => void; extended?: boolean; bottom?: number;
}) {
  const t = useTheme();
  return (
    <View pointerEvents="box-none" style={[fabStyles.wrap, { bottom }]}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
        android_ripple={{ color: 'rgba(0,0,0,0.12)' }}
        style={[fabStyles.fab, { backgroundColor: t.accent, borderColor: t.dark ? t.accent : t.accentStrong, paddingHorizontal: extended ? 20 : 0, width: extended ? undefined : 56 }, t.shadow ? { elevation: 8 } : null]}>
        <Icon name={icon} size={24} color={t.onAccent} />
        {extended ? <Text variant="button" color={t.onAccent}>{label}</Text> : null}
      </Pressable>
    </View>
  );
});

/** onScroll handler factory that toggles FAB extension by scroll direction. */
export function fabScroll(set: (extended: boolean) => void) {
  let last = 0;
  return (e: { nativeEvent: { contentOffset: { y: number } } }) => {
    const y = e.nativeEvent.contentOffset.y;
    if (Math.abs(y - last) < 8) return;
    set(y < last || y < 24);
    last = y;
  };
}

const fabStyles = StyleSheet.create({
  wrap: { position: 'absolute', right: 16 },
  fab: { height: 56, minWidth: 56, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, overflow: 'hidden' },
});
