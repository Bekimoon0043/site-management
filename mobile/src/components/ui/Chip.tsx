// Chips (spec §3.5): status chip (non-interactive, tonal), filter chip, choice chips.
import React, { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { priorityInfo, radius, space, statusInfo, tone as toneOf, useTheme, type Tone } from '../../theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { haptic } from './haptics';

// ---------------------------------------------------------------------------
// Tonal chip: container background + on-container text + icon. 28 dp.
// ---------------------------------------------------------------------------

export const Chip = memo(function Chip({ label, tone: tn = 'neutral', icon, small, strike }: {
  label: string; tone?: Tone; icon?: IconName; small?: boolean; strike?: boolean;
}) {
  const t = useTheme();
  const c = toneOf(t, tn);
  return (
    <View style={[styles.chip, small && styles.chipSm, { backgroundColor: c.container }]} accessible accessibilityLabel={label}>
      {icon ? <Icon name={icon} size={small ? 14 : 16} color={c.onContainer} /> : null}
      <Text variant="caption" weight="600" color={c.onContainer} numberOfLines={1} strike={strike} maxFontSizeMultiplier={1.3}>{label}</Text>
    </View>
  );
});

/** Status chip from the §1.6 mapping. */
export const StatusChip = memo(function StatusChip({ status, label, small }: { status: string; label?: string; small?: boolean }) {
  const s = statusInfo(status);
  return <Chip label={label ?? s.label} tone={s.tone} icon={s.icon} small={small} />;
});

/** Priority chip: nothing for "normal". */
export const PriorityChip = memo(function PriorityChip({ priority }: { priority: string | null | undefined }) {
  const p = priorityInfo(priority);
  return p ? <Chip label={p.label} tone={p.tone} icon={p.icon} /> : null;
});

// ---------------------------------------------------------------------------
// Filter / choice chip: 40 dp visual, 48 dp target
// ---------------------------------------------------------------------------

export const FilterChip = memo(function FilterChip({ label, selected, onPress, count, icon, trailingIcon, tone: tn }: {
  label: string; selected: boolean; onPress: () => void; count?: number; icon?: IconName; trailingIcon?: IconName;
  /** Optional semantic tone for the selected state (e.g. inspection result). */
  tone?: Tone;
}) {
  const t = useTheme();
  const sel = tn ? toneOf(t, tn) : { container: t.primaryContainer, onContainer: t.onPrimaryContainer };
  const fg = selected ? sel.onContainer : t.text;
  return (
    <Pressable
      onPress={() => { haptic('tick'); onPress(); }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={count != null ? `${label}, ${count}` : label}
      android_ripple={{ color: t.ripple }}
      style={styles.hit}
    >
      <View style={[styles.filter, {
        backgroundColor: selected ? sel.container : t.surfaceMuted,
        borderColor: selected ? 'transparent' : t.boost ? t.borderStrong : 'transparent',
        borderWidth: t.boost ? 2 : 0,
      }]}>
        {selected ? <Icon name="check" size={18} color={fg} /> : icon ? <Icon name={icon} size={18} color={fg} /> : null}
        <Text variant="label" color={fg} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {label}{count != null ? ` · ${count}` : ''}
        </Text>
        {trailingIcon ? <Icon name={trailingIcon} size={18} color={fg} /> : null}
      </View>
    </Pressable>
  );
});

export interface ChipOption<V extends string> { value: V; label: string; count?: number; icon?: IconName; tone?: Tone }

/** Single-select chips (wrapping). Replaces the old `Chips`. */
export function ChipGroup<V extends string>({ options, value, onChange, label, scroll, style }: {
  options: ChipOption<V>[]; value: V | null; onChange: (v: V) => void; label?: string;
  /** Horizontal scroll instead of wrapping (filter bars). */
  scroll?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const chips = options.map((o) => (
    <FilterChip key={o.value} label={o.label} count={o.count} icon={o.icon} tone={o.tone}
      selected={o.value === value} onPress={() => onChange(o.value)} />
  ));
  return (
    <View style={[styles.group, style]}>
      {label ? <Text variant="label">{label}</Text> : null}
      {scroll ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollRow}>{chips}</ScrollView>
      ) : <View style={styles.wrapRow}>{chips}</View>}
    </View>
  );
}
/** @deprecated alias of ChipGroup */
export const Chips = ChipGroup;

const styles = StyleSheet.create({
  chip: { height: 28, borderRadius: radius.pill, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', maxWidth: '100%' },
  chipSm: { height: 24, paddingHorizontal: 8 },
  hit: { minHeight: 48, justifyContent: 'center', borderRadius: radius.pill, overflow: 'hidden' },
  filter: { minHeight: 40, borderRadius: radius.pill, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 6 },
  group: { gap: space[1] },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space[2] },
  scrollRow: { gap: space[2], paddingRight: space[4] },
});
