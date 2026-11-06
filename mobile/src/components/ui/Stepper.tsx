// Quantity stepper with quick-add chips and a smart "Fill" chip (spec §3.7).
import React, { memo, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { radius, size, space, typeFor, useTheme } from '../../theme';
import { fmtQty, num } from '../../lib/format';
import { Icon } from './Icon';
import { Text } from './Text';
import { FieldLabel, FieldMessage } from './Field';
import { FilterChip } from './Chip';
import { Segmented } from './Segmented';
import { useFieldRef } from './Form';
import { haptic } from './haptics';

/** Default step and quick-add chips for a unit of measure. */
export function stepFor(uom: string | null | undefined): { step: number; quick: number[] } {
  const u = (uom ?? '').toLowerCase().replace('³', '3').replace('²', '2').trim();
  if (['t', 'ton', 'tons', 'tonne', 'tonnes', 'mt'].includes(u)) return { step: 0.1, quick: [0.5, 1, 5] };
  if (['m3', 'cum', 'cbm'].includes(u)) return { step: 0.5, quick: [0.5, 1, 5] };
  if (u === 'kg') return { step: 1, quick: [10, 50, 100] };
  if (['m', 'lm', 'm2', 'sqm'].includes(u)) return { step: 1, quick: [1, 10, 50] };
  if (['l', 'ltr', 'litre', 'liter'].includes(u)) return { step: 1, quick: [5, 20, 50] };
  return { step: 1, quick: [1, 5, 10, 50] }; // bag, pcs, nr, roll, …
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export interface QuantityStepperProps {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  unit?: string;
  /** Right side of the label row, e.g. "Stock 340 bag". */
  info?: string | null;
  step?: number;
  quick?: number[];
  /** Smart fill chip, e.g. { label: 'Approved', value: 150 }. */
  fill?: { label: string; value: number } | null;
  min?: number;
  /** Hard limit applied by +/- (typing above is still possible and should be validated). */
  max?: number;
  error?: string | null;
  warning?: string | null;
  hint?: string | null;
  name?: string;
  /** Alternative units segmented control beside the label. */
  units?: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void } | null;
  autoFocus?: boolean;
}

export const QuantityStepper = memo(function QuantityStepper({
  value, onChange, label = 'Quantity', unit, info, step, quick, fill, min = 0, max, error, warning, hint, name, units, autoFocus,
}: QuantityStepperProps) {
  const t = useTheme();
  const def = stepFor(unit);
  const st = step ?? def.step;
  const chips = quick ?? def.quick;
  const wrapRef = useFieldRef(name);
  const cur = useRef(0);
  const v = num(value || '0');
  cur.current = Number.isFinite(v) ? v : 0;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(0);
  const repeated = useRef(false);

  const clamp = (n: number) => {
    let x = Math.max(min, n);
    if (max != null) x = Math.min(max, x);
    return round(x);
  };
  const set = (n: number) => { const c = clamp(n); cur.current = c; onChange(String(c)); };
  const bump = (dir: 1 | -1, mult = 1) => { haptic('tick'); set(cur.current + dir * st * mult); };

  const stop = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => stop, []);
  const startRepeat = (dir: 1 | -1) => {
    started.current = Date.now();
    repeated.current = false;
    const tick = () => {
      repeated.current = true;
      const mult = Date.now() - started.current > 2000 ? 10 : 1;
      set(cur.current + dir * st * mult);
      timer.current = setTimeout(tick, 80);
    };
    timer.current = setTimeout(tick, 400);
  };

  const ty = typeFor('display', t);
  const border = error ? t.danger : t.borderStrong;
  const bw = error ? 2 : Math.max(1.5, t.borderWidth);
  const a11yValue = `${fmtQty(cur.current)} ${unit ?? ''}`.trim();

  const side = (dir: 1 | -1) => (
    <Pressable
      onPress={() => { if (!repeated.current) bump(dir); repeated.current = false; }}
      onPressIn={() => startRepeat(dir)}
      onPressOut={stop}
      accessibilityRole="button"
      accessibilityLabel={dir > 0 ? `Increase by ${st}` : `Decrease by ${st}`}
      android_ripple={{ color: t.ripple }}
      style={[styles.side, { backgroundColor: t.surfaceMuted }]}
    >
      <Icon name={dir > 0 ? 'plus' : 'minus'} size={28} tone="text" />
    </Pressable>
  );

  return (
    <View ref={wrapRef} style={styles.wrap}>
      <FieldLabel
        label={`${label}${unit ? ` (${unit})` : ''}`}
        right={info ? <Text variant="bodySm" tone="muted" num>{info}</Text> : null}
      />
      {units && units.options.length > 1 ? (
        <Segmented options={units.options} value={units.value} onChange={units.onChange} accessibilityLabel="Unit" />
      ) : null}
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: a11yValue }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => bump(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
        style={[styles.box, { borderColor: border, borderWidth: bw, backgroundColor: t.surface }]}
      >
        {side(-1)}
        <TextInput
          value={value}
          onChangeText={(s) => onChange(s.replace(/[^0-9.,]/g, ''))}
          keyboardType="decimal-pad"
          selectTextOnFocus
          autoFocus={autoFocus}
          placeholder="0"
          placeholderTextColor={t.textMuted}
          selectionColor={t.primary}
          cursorColor={t.primary}
          maxFontSizeMultiplier={1.2}
          accessibilityLabel={`${label} value`}
          style={[styles.input, { color: t.text, fontSize: ty.fontSize, fontWeight: ty.fontWeight, fontVariant: ['tabular-nums'] }]}
        />
        {side(1)}
      </View>
      {chips.length || fill ? (
        <View style={styles.chips}>
          {chips.map((q) => (
            <FilterChip key={q} label={`+${fmtQty(q)}`} selected={false} onPress={() => set(cur.current + q)} />
          ))}
          {fill && fill.value > 0 ? (
            <FilterChip label={`Fill: ${fill.label} ${fmtQty(fill.value)}`} icon="arrow-down-bold" selected={false}
              onPress={() => set(fill.value)} />
          ) : null}
          {cur.current > 0 ? <FilterChip label="Clear" icon="close" selected={false} onPress={() => onChange('')} /> : null}
        </View>
      ) : null}
      <FieldMessage error={error} warning={warning} hint={hint} />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  box: { flexDirection: 'row', alignItems: 'stretch', borderRadius: radius.md, overflow: 'hidden', minHeight: size.control + 4 },
  side: { width: 60, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, textAlign: 'center', paddingVertical: 4, minHeight: size.control },
  chips: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space[2] },
});
