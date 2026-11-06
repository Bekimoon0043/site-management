// Screen scaffolding: Screen (scroll or fixed), sticky ActionBar (§3.10), useForm for
// scroll-to-first-error, unsaved-changes guard (§4.1).
import React, { useRef } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View, type HostInstance, type ScrollViewInstance, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePreventRemove } from 'expo-router';
import { elevation, space, useTheme } from '../../theme';
import { Text } from './Text';
import { Button, type ButtonVariant } from './Button';
import { Icon } from './Icon';
import { OfflineBand } from './SyncBand';
import { FormProvider, useFormController } from './Form';
import type { IconName } from './Icon';

export interface FormHandle {
  scrollRef: React.RefObject<ScrollViewInstance | null>;
  contentRef: React.RefObject<HostInstance | null>;
  ctl: ReturnType<typeof useFormController>;
  /** Scroll to the first field with an error, fire the Reject haptic. */
  focusFirstError: (errors: Record<string, string | undefined | null>) => void;
}

/** Create a form handle and pass it to <Screen form={form}>. */
export function useForm(): FormHandle {
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  const contentRef = useRef<HostInstance | null>(null);
  const ctl = useFormController(scrollRef, contentRef);
  return { scrollRef, contentRef, ctl, focusFirstError: ctl.focusFirstError };
}

export interface ScreenProps {
  children: React.ReactNode;
  /** ScrollView (default) or a fixed container (for FlashList screens). */
  scroll?: boolean;
  /** 16 dp gutter. */
  padded?: boolean;
  gap?: number;
  /** Sticky footer, usually <ActionBar>. */
  footer?: React.ReactNode;
  /** Show the offline / failure band at the top (default true). */
  band?: boolean;
  form?: FormHandle;
  /** Bottom safe-area padding (false inside tabs, where the tab bar handles it). */
  insetBottom?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  refreshControl?: React.ComponentProps<typeof ScrollView>['refreshControl'];
}

export function Screen({ children, scroll = true, padded = true, gap = space[4], footer, band = true, form, insetBottom = true, contentStyle, refreshControl }: ScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const bottom = footer ? 0 : insetBottom ? insets.bottom : 0;
  const inner = (
    <View ref={form?.contentRef} collapsable={false}
      style={[{ padding: padded ? space[4] : 0, gap }, scroll && { paddingBottom: (padded ? space[8] : 0) + bottom }, !scroll && styles.flex, contentStyle]}>
      {children}
    </View>
  );
  const body = scroll ? (
    <ScrollView ref={form?.scrollRef} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" refreshControl={refreshControl}
      contentContainerStyle={styles.grow}>
      {inner}
    </ScrollView>
  ) : inner;
  const content = (
    <View style={[styles.flex, { backgroundColor: t.background }]}>
      {band ? <OfflineBand /> : null}
      {form ? <FormProvider value={form.ctl}>{body}</FormProvider> : body}
      {footer}
    </View>
  );
  return footer ? (
    <KeyboardAvoidingView style={[styles.flex, { backgroundColor: t.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {content}
    </KeyboardAvoidingView>
  ) : content;
}

// ---------------------------------------------------------------------------
// Sticky bottom action bar
// ---------------------------------------------------------------------------

export interface BarAction {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  iconRight?: IconName;
  busy?: boolean;
  /** Only for genuinely unavailable actions — the primary should explain instead (scroll to error). */
  disabled?: boolean;
}

export function ActionBar({ summary, warning, primary, secondary, tertiary }: {
  /** Left-side live summary ("3 lines · 2 warnings"). */
  summary?: string | null;
  /** Turns the summary into a warning line with an icon. */
  warning?: boolean;
  primary: BarAction;
  secondary?: BarAction | null;
  tertiary?: BarAction | null;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, elevation(t, 2), {
      backgroundColor: t.surfaceElevated, borderTopColor: t.border, borderTopWidth: t.borderWidth,
      paddingBottom: Math.max(insets.bottom, space[3]),
    }]}>
      {summary ? (
        <View style={styles.summary}>
          {warning ? <Icon name="alert-outline" size={18} tone="warning" /> : null}
          <Text variant="bodySm" weight="600" tone={warning ? 'warning' : 'muted'} numberOfLines={2} style={styles.flex}>{summary}</Text>
        </View>
      ) : null}
      <View style={styles.actions}>
        {tertiary ? <Button size="lg" variant={tertiary.variant ?? 'ghost'} {...tertiary} /> : null}
        {secondary ? <Button size="lg" variant={secondary.variant ?? 'outline'} flex {...secondary} /> : null}
        <Button size="lg" flex iconRight={primary.iconRight ?? (primary.icon ? undefined : 'chevron-right')} {...primary} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Unsaved changes guard: "Discard? / Keep editing / Save draft"
// ---------------------------------------------------------------------------

/** Blocks back navigation while `dirty`. Returns `disable()` — call it right before navigating after a save. */
export function useUnsavedGuard(dirty: boolean, opts: { what: string; onSaveDraft?: () => void }): () => void {
  return usePreventRemove(dirty, ({ repeat }) => {
    const buttons: Parameters<typeof Alert.alert>[2] = [
      { text: 'Keep editing', style: 'cancel' },
      ...(opts.onSaveDraft ? [{ text: 'Save draft', onPress: () => { opts.onSaveDraft?.(); } }] : []),
      { text: 'Discard', style: 'destructive' as const, onPress: () => repeat() },
    ];
    Alert.alert(`Discard ${opts.what}?`, 'Your changes on this screen are not saved yet.', buttons);
  });
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
  bar: { paddingHorizontal: space[4], paddingTop: space[3], gap: space[2] },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actions: { flexDirection: 'row', gap: space[3], alignItems: 'center' },
});
