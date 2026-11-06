// Segmented control (spec §3.8): 2–4 options, 48 dp, framed in surfaceMuted.
import React from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { elevation, radius, tone as toneOf, useTheme, type Tone } from '../../theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { haptic } from './haptics';

export interface SegmentOption<V extends string> { value: V; label: string; icon?: IconName; tone?: Tone }

export function Segmented<V extends string>({ options, value, onChange, label, style, accessibilityLabel }: {
  options: SegmentOption<V>[]; value: V; onChange: (v: V) => void; label?: string; style?: StyleProp<ViewStyle>; accessibilityLabel?: string;
}) {
  const t = useTheme();
  return (
    <View style={[styles.wrap, style]}>
      {label ? <Text variant="label">{label}</Text> : null}
      <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel ?? label}
        style={[styles.frame, { backgroundColor: t.surfaceMuted, borderColor: t.boost ? t.borderStrong : 'transparent', borderWidth: t.boost ? 2 : 0 }]}>
        {options.map((o) => {
          const on = o.value === value;
          const tc = on && o.tone ? toneOf(t, o.tone) : null;
          const bg = on ? (tc ? tc.container : t.dark ? t.surfaceElevated : t.surface) : 'transparent';
          const fg = on ? (tc ? tc.onContainer : t.text) : t.textMuted;
          return (
            <Pressable
              key={o.value}
              onPress={() => { if (!on) { haptic('tick'); onChange(o.value); } }}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={o.label}
              android_ripple={{ color: t.ripple }}
              style={[styles.seg, { backgroundColor: bg }, on && elevation(t, 1)]}
            >
              {o.icon ? <Icon name={o.icon} size={18} color={fg} /> : null}
              <Text variant="label" color={fg} weight={on ? '700' : '500'} numberOfLines={1} maxFontSizeMultiplier={1.3}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  frame: { flexDirection: 'row', borderRadius: radius.md, padding: 3, gap: 3, minHeight: 48 },
  seg: { flex: 1, minHeight: 42, borderRadius: radius.sm + 2, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, paddingHorizontal: 6, overflow: 'hidden' },
});
