// Layout primitives: Card (§3.3), Row, Col, Section, Divider, InfoRow (KV), Banner.
import React, { memo } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { elevation, makeStyles, radius, space, tone as toneOf, useTheme, type Tone } from '../../theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { Button } from './Button';

// ---------------------------------------------------------------------------
// Row / Col
// ---------------------------------------------------------------------------

export function Row({ children, gap = space.sm, wrap, align = 'center', justify, style }: {
  children: React.ReactNode; gap?: number; wrap?: boolean; align?: ViewStyle['alignItems']; justify?: ViewStyle['justifyContent']; style?: StyleProp<ViewStyle>;
}) {
  return <View style={[{ flexDirection: 'row', alignItems: align, justifyContent: justify, gap, flexWrap: wrap ? 'wrap' : 'nowrap' }, style]}>{children}</View>;
}

export function Col({ children, gap = space.sm, flex, style }: { children: React.ReactNode; gap?: number; flex?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ gap }, flex && { flex: 1, minWidth: 0 }, style]}>{children}</View>;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

const useCardStyles = makeStyles((t) => ({
  card: {
    backgroundColor: t.surface, borderRadius: radius.md, borderWidth: t.borderWidth, borderColor: t.border,
    padding: space[4], gap: space[2], overflow: 'hidden',
  },
  raised: { ...elevation(t, 1), backgroundColor: t.dark ? t.surfaceElevated : t.surface },
  dense: { padding: space[3] },
  stripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  selected: { borderColor: t.primary, borderWidth: 2 },
  flat: { padding: 0, gap: 0 },
}));

export interface CardProps {
  children: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  /** 4 dp left stripe in a status tone. */
  stripe?: Tone | null;
  dense?: boolean;
  /** No padding (for lists of rows inside a card). */
  flush?: boolean;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

export const Card = memo(function Card({ children, onPress, onLongPress, stripe, dense, flush, selected, style, testID, accessibilityLabel }: CardProps) {
  const t = useTheme();
  const s = useCardStyles();
  const body = (
    <>
      {stripe ? <View style={[s.stripe, { backgroundColor: toneOf(t, stripe).solid }]} /> : null}
      {children}
    </>
  );
  const base = [s.card, dense && s.dense, flush && s.flat, stripe && { paddingLeft: (dense ? space[3] : space[4]) + 4 }, selected && s.selected, style];
  if (onPress || onLongPress) {
    return (
      <View style={[{ borderRadius: radius.md }, s.raised]}>
        <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
          onPress={onPress} onLongPress={onLongPress} android_ripple={{ color: t.ripple }} style={base}>
          {body}
        </Pressable>
      </View>
    );
  }
  return <View testID={testID} style={base}>{body}</View>;
});

// ---------------------------------------------------------------------------
// Section header (sentence case, never uppercase)
// ---------------------------------------------------------------------------

export function Section({ title, action, onAction, children, gap = space[2], style }: {
  title: string; action?: string; onAction?: () => void; children?: React.ReactNode; gap?: number; style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ gap }, style]}>
      <View style={styles.sectionHead}>
        <Text variant="label" tone="muted" accessibilityRole="header" style={styles.flex1}>{title}</Text>
        {action && onAction ? <Button title={action} variant="ghost" size="sm" onPress={onAction} /> : null}
      </View>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Divider / InfoRow
// ---------------------------------------------------------------------------

export function Divider({ inset = 0, style }: { inset?: number; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[{ height: t.borderWidth === 2 ? 2 : StyleSheet.hairlineWidth * 2, backgroundColor: t.border, marginLeft: inset }, style]} />;
}

/** Label/value row ("Requested · 120 bag"). Value is right-aligned, tabular. */
export const InfoRow = memo(function InfoRow({ label, value, tone: tn, icon, strong }: {
  label: string; value: React.ReactNode; tone?: 'default' | 'success' | 'warning' | 'danger' | 'muted'; icon?: IconName; strong?: boolean;
}) {
  return (
    <View style={styles.kv}>
      <Text variant="bodySm" tone="muted" style={styles.flex1}>{label}</Text>
      {typeof value === 'string' || typeof value === 'number' ? (
        <View style={styles.kvVal}>
          {icon ? <Icon name={icon} size={16} tone={tn === 'default' || !tn ? 'text' : tn} /> : null}
          <Text variant={strong ? 'titleSm' : 'body'} weight={strong ? undefined : '600'} num tone={tn ?? 'default'} align="right">{value}</Text>
        </View>
      ) : value}
    </View>
  );
});
/** @deprecated alias */
export const KV = ({ k, v }: { k: string; v: React.ReactNode }) => <InfoRow label={k} value={v} />;

// ---------------------------------------------------------------------------
// Banner (inline notice): tonal container + icon + text + optional actions
// ---------------------------------------------------------------------------

export function Banner({ tone: tn = 'info', title, text, icon, actions, onPress }: {
  tone?: Tone; title?: string; text?: string; icon?: IconName;
  actions?: { label: string; onPress: () => void }[]; onPress?: () => void;
}) {
  const t = useTheme();
  const c = toneOf(t, tn);
  const ic: IconName = icon ?? (tn === 'danger' ? 'alert-octagon-outline' : tn === 'warning' ? 'alert-outline' : tn === 'success' ? 'check-circle-outline' : 'information-outline');
  const body = (
    <View style={[styles.banner, { backgroundColor: c.container }]}>
      <Icon name={ic} size={22} color={c.onContainer} />
      <View style={styles.bannerBody}>
        {title ? <Text variant="label" color={c.onContainer}>{title}</Text> : null}
        {text ? <Text variant="bodySm" color={c.onContainer}>{text}</Text> : null}
        {actions?.length ? (
          <View style={styles.bannerActions}>
            {actions.map((a) => (
              <Pressable key={a.label} onPress={a.onPress} accessibilityRole="button" hitSlop={8}
                style={styles.bannerAction} android_ripple={{ color: t.ripple }}>
                <Text variant="label" color={c.onContainer} style={styles.underline}>{a.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
  return onPress ? <Pressable onPress={onPress} accessibilityRole="button">{body}</Pressable> : body;
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', minHeight: 32, marginTop: space[2] },
  kv: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 28 },
  kvVal: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  banner: { flexDirection: 'row', gap: space[3], padding: space[3], borderRadius: radius.md, alignItems: 'flex-start' },
  bannerBody: { flex: 1, gap: 2 },
  bannerActions: { flexDirection: 'row', gap: space[4], marginTop: space[1] },
  bannerAction: { minHeight: 40, justifyContent: 'center' },
  underline: { textDecorationLine: 'underline' },
});
