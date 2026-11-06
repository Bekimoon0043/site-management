// Form fields (spec §3.9): label above, 56 dp input, 1.5 dp borderStrong, 2 dp primary on focus,
// 2 dp danger + icon + message on error. Optional fields say "(optional)"; required ones are unmarked.
import React, { forwardRef, memo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View, type TextInputInstance, type TextInputProps } from 'react-native';
import { radius, size, space, typeFor, useTheme } from '../../theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { useFieldRef } from './Form';

export function FieldLabel({ label, optional, right }: { label: string; optional?: boolean; right?: React.ReactNode }) {
  return (
    <View style={styles.labelRow}>
      <Text variant="label" style={styles.flex1}>
        {label}{optional ? <Text variant="bodySm" tone="muted"> (optional)</Text> : null}
      </Text>
      {right}
    </View>
  );
}

export function FieldMessage({ error, hint, warning }: { error?: string | null; hint?: string | null; warning?: string | null }) {
  if (error) {
    return (
      <View style={styles.msg} accessibilityLiveRegion="polite">
        <Icon name="alert-circle-outline" size={18} tone="danger" />
        <Text variant="bodySm" tone="danger" style={styles.flex1}>{error}</Text>
      </View>
    );
  }
  if (warning) {
    return (
      <View style={styles.msg}>
        <Icon name="alert-outline" size={18} tone="warning" />
        <Text variant="bodySm" tone="warning" style={styles.flex1}>{warning}</Text>
      </View>
    );
  }
  return hint ? <Text variant="bodySm" tone="muted">{hint}</Text> : null;
}

export interface FieldProps extends TextInputProps {
  label?: string;
  /** Registers with the FormScreen for scroll-to-error. */
  name?: string;
  hint?: string | null;
  error?: string | null;
  warning?: string | null;
  optional?: boolean;
  /** Icon inside the input, on the left. */
  leadingIcon?: IconName;
  /** Trailing icon button inside the input (e.g. camera next to delivery-note no.). */
  trailing?: { icon: IconName; onPress: () => void; accessibilityLabel: string };
}

export const Field = memo(forwardRef<TextInputInstance, FieldProps>(function Field(
  { label, name, hint, error, warning, optional, leadingIcon, trailing, style, multiline, onFocus, onBlur, ...props }, ref,
) {
  const t = useTheme();
  const [focus, setFocus] = useState(false);
  const wrapRef = useFieldRef(name);
  const bw = error || focus ? 2 : Math.max(1.5, t.borderWidth);
  const bc = error ? t.danger : focus ? t.primary : t.borderStrong;
  const ty = typeFor('body', t);
  return (
    <View ref={wrapRef} style={styles.wrap}>
      {label ? <FieldLabel label={label} optional={optional} /> : null}
      <View style={[styles.box, { borderColor: bc, borderWidth: bw, backgroundColor: t.surface, minHeight: multiline ? 96 : size.control }]}>
        {leadingIcon ? <Icon name={leadingIcon} size={22} tone="muted" /> : null}
        <TextInput
          ref={ref}
          placeholderTextColor={t.textMuted}
          selectionColor={t.primary}
          cursorColor={t.primary}
          multiline={multiline}
          accessibilityLabel={props.accessibilityLabel ?? label}
          onFocus={(e) => { setFocus(true); onFocus?.(e); }}
          onBlur={(e) => { setFocus(false); onBlur?.(e); }}
          maxFontSizeMultiplier={1.4}
          {...props}
          style={[styles.input, { color: t.text, fontSize: ty.fontSize, fontWeight: ty.fontWeight },
            multiline && styles.multi, style]}
        />
        {trailing ? (
          <Pressable onPress={trailing.onPress} accessibilityRole="button" accessibilityLabel={trailing.accessibilityLabel}
            hitSlop={4} android_ripple={{ color: t.ripple, borderless: true, radius: 22 }} style={styles.trailing}>
            <Icon name={trailing.icon} size={24} tone="primary" />
          </Pressable>
        ) : null}
      </View>
      <FieldMessage error={error} hint={hint} warning={warning} />
    </View>
  );
}));

/** The 56 dp trigger that opens a sheet (pickers, dates). */
export const SelectField = memo(function SelectField({ label, value, sub, placeholder = 'Select…', onPress, error, hint, warning, optional, name, icon, disabled, onClear }: {
  label?: string; value?: string | null; sub?: string | null; placeholder?: string; onPress: () => void;
  error?: string | null; hint?: string | null; warning?: string | null; optional?: boolean; name?: string; icon?: IconName; disabled?: boolean;
  onClear?: () => void;
}) {
  const t = useTheme();
  const wrapRef = useFieldRef(name);
  return (
    <View ref={wrapRef} style={styles.wrap}>
      {label ? <FieldLabel label={label} optional={optional} /> : null}
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label ?? ''}: ${value ?? placeholder}`}
        accessibilityState={{ disabled }}
        android_ripple={{ color: t.ripple }}
        style={[styles.box, {
          borderColor: error ? t.danger : t.borderStrong, borderWidth: error ? 2 : Math.max(1.5, t.borderWidth),
          backgroundColor: disabled ? t.surfaceMuted : t.surface, minHeight: size.control, overflow: 'hidden',
        }]}
      >
        {icon ? <Icon name={icon} size={22} tone="muted" /> : null}
        <View style={styles.selectBody}>
          <Text variant="body" tone={value ? 'default' : 'muted'} numberOfLines={2}>{value || placeholder}</Text>
          {value && sub ? <Text variant="bodySm" tone="muted" numberOfLines={1}>{sub}</Text> : null}
        </View>
        {onClear && value ? (
          <Pressable onPress={onClear} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Clear ${label ?? ''}`} style={styles.trailing}>
            <Icon name="close" size={20} tone="muted" />
          </Pressable>
        ) : null}
        {!disabled ? <Icon name="chevron-down" size={24} tone="muted" /> : null}
      </Pressable>
      <FieldMessage error={error} hint={hint} warning={warning} />
    </View>
  );
});

/** Search input for list headers and sheets. */
export const SearchInput = memo(forwardRef<TextInputInstance, TextInputProps & { onClear?: () => void }>(function SearchInput({ value, onClear, style, ...props }, ref) {
  const t = useTheme();
  return (
    <View style={[styles.box, styles.search, { borderColor: t.borderStrong, borderWidth: Math.max(1, t.borderWidth), backgroundColor: t.surface }]}>
      <Icon name="magnify" size={22} tone="muted" />
      <TextInput
        ref={ref}
        value={value}
        placeholderTextColor={t.textMuted}
        selectionColor={t.primary}
        cursorColor={t.primary}
        returnKeyType="search"
        autoCorrect={false}
        maxFontSizeMultiplier={1.4}
        accessibilityLabel={props.placeholder ?? 'Search'}
        {...props}
        style={[styles.input, { color: t.text, fontSize: 16 }, style]}
      />
      {value && onClear ? (
        <Pressable onPress={onClear} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear search" style={styles.trailing}>
          <Icon name="close" size={20} tone="muted" />
        </Pressable>
      ) : null}
    </View>
  );
}));

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  flex1: { flex: 1 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  msg: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  box: { borderRadius: radius.md, paddingHorizontal: space[3], flexDirection: 'row', alignItems: 'center', gap: space[2] },
  input: { flex: 1, minHeight: 52, paddingVertical: 8 },
  multi: { textAlignVertical: 'top', paddingTop: 12, minHeight: 92 },
  trailing: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  selectBody: { flex: 1, paddingVertical: 8, gap: 2 },
  search: { minHeight: size.control },
});
