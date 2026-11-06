// Dashboard pieces: KPI tile (§3.3), action tiles + hero action (§3.2), progress bar/ring (§3.17).
import React, { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { elevation, radius, size, space, tone as toneOf, useTheme, type Tone } from '../../theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

// ---------------------------------------------------------------------------
// KPI tile
// ---------------------------------------------------------------------------

export const KpiTile = memo(function KpiTile({ label, value, sub, tone: tn = 'neutral', icon, onPress, zeroIsGood = true }: {
  label: string; value: number | string; sub?: string;
  /** Only warning/danger colour the number (with an icon). */
  tone?: Tone; icon?: IconName; onPress?: () => void;
  /** A zero count reads success-muted ("0 · all clear"), not red. */
  zeroIsGood?: boolean;
}) {
  const t = useTheme();
  const isZero = value === 0 || value === '0';
  const alert = !isZero && (tn === 'warning' || tn === 'danger');
  const c = toneOf(t, tn);
  const body = (
    <View style={[styles.kpi, { backgroundColor: t.dark ? t.surfaceElevated : t.surface, borderColor: t.border, borderWidth: t.borderWidth }, elevation(t, onPress ? 1 : 0)]}>
      {alert ? <View style={[styles.kpiBar, { backgroundColor: c.solid }]} /> : null}
      <View style={styles.kpiTop}>
        <Text variant="display" num color={alert ? c.solid : undefined} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
        {alert ? <Icon name={icon ?? (tn === 'danger' ? 'alert-octagon-outline' : 'alert-outline')} size={22} color={c.solid} /> : null}
      </View>
      <Text variant="label" tone="muted" numberOfLines={2}>{label}</Text>
      {isZero && zeroIsGood ? (
        <View style={styles.clear}><Icon name="check" size={14} tone="success" /><Text variant="caption" tone="success">All clear</Text></View>
      ) : sub ? <Text variant="caption" tone="muted" numberOfLines={2}>{sub}</Text> : null}
    </View>
  );
  if (!onPress) return <View style={styles.kpiWrap}>{body}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: ${value}${sub ? `, ${sub}` : ''}`}
      android_ripple={{ color: t.ripple }} style={styles.kpiWrap}>
      {body}
    </Pressable>
  );
});

export function Grid({ children, columns = 2, gap = space[3] }: { children: React.ReactNode; columns?: 2 | 3; gap?: number }) {
  const items = React.Children.toArray(children).filter(Boolean);
  const rows: React.ReactNode[][] = [];
  items.forEach((c, i) => { if (i % columns === 0) rows.push([]); rows[rows.length - 1].push(c); });
  return (
    <View style={{ gap }}>
      {rows.map((r, i) => (
        <View key={i} style={{ flexDirection: 'row', gap }}>
          {r}
          {Array.from({ length: columns - r.length }).map((_, k) => <View key={`pad${k}`} style={styles.flex} />)}
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Action tiles
// ---------------------------------------------------------------------------

export const ActionTile = memo(function ActionTile({ icon, label, hint, onPress, tone: tn = 'primary', badge, compact }: {
  icon: IconName; label: string; hint?: string; onPress: () => void; tone?: Tone; badge?: number;
  /** 3-column compact tile (icon + label). */
  compact?: boolean;
}) {
  const t = useTheme();
  const c = toneOf(t, tn);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}${hint ? `, ${hint}` : ''}${badge ? `, ${badge}` : ''}`}
      android_ripple={{ color: t.ripple }}
      style={[styles.tile, compact && styles.tileCompact, elevation(t, 1),
        { backgroundColor: t.dark ? t.surfaceElevated : t.surface, borderColor: t.border, borderWidth: t.borderWidth }]}>
      <View style={[styles.tileIcon, compact && styles.tileIconSm, { backgroundColor: c.container }]}>
        <Icon name={icon} size={compact ? 24 : 28} color={c.onContainer} />
      </View>
      <Text variant={compact ? 'label' : 'titleSm'} numberOfLines={2} align={compact ? 'center' : undefined}>{label}</Text>
      {hint && !compact ? <Text variant="caption" tone="muted" numberOfLines={1}>{hint}</Text> : null}
      {badge ? (
        <View style={[styles.badge, { backgroundColor: t.danger }]}>
          <Text variant="caption" weight="700" color={t.onDanger} num maxFontSizeMultiplier={1}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
});

/** The one amber hero action per dashboard ("Receive delivery", "New request"). */
export const HeroAction = memo(function HeroAction({ icon, label, hint, onPress }: { icon: IconName; label: string; hint?: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} android_ripple={{ color: 'rgba(0,0,0,0.12)' }}
      style={[styles.hero, elevation(t, 1), { backgroundColor: t.accent, borderColor: t.dark ? t.accent : t.accentStrong }]}>
      <View style={[styles.heroIcon, { backgroundColor: 'rgba(26,18,3,0.12)' }]}><Icon name={icon} size={28} color={t.onAccent} /></View>
      <View style={styles.flex}>
        <Text variant="title" color={t.onAccent}>{label}</Text>
        {hint ? <Text variant="bodySm" color={t.onAccent}>{hint}</Text> : null}
      </View>
      <Icon name="chevron-right" size={28} color={t.onAccent} />
    </Pressable>
  );
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export const ProgressBar = memo(function ProgressBar({ pct, planned, showLabel, tone: tn }: { pct: number; planned?: number | null; showLabel?: boolean; tone?: Tone }) {
  const t = useTheme();
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const fill = tn ? toneOf(t, tn).solid : p >= 100 ? t.success : t.primary;
  return (
    <View style={styles.barRow} accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(p) }}>
      <View style={[styles.track, { backgroundColor: t.surfaceMuted }]}>
        <View style={[styles.fill, { width: `${p}%`, backgroundColor: fill }]} />
        {planned != null && planned > 0 && planned <= 100 ? (
          <View style={[styles.marker, { left: `${planned}%`, backgroundColor: t.text }]} />
        ) : null}
      </View>
      {showLabel ? <Text variant="label" num style={styles.barLabel}>{Math.round(p)}%</Text> : null}
    </View>
  );
});
/** @deprecated alias */
export const Progress = ({ pct }: { pct: number }) => <ProgressBar pct={pct} />;

export const ProgressRing = memo(function ProgressRing({ pct, size: sz = 96, stroke = 8, label }: { pct: number; size?: number; stroke?: number; label?: string }) {
  const t = useTheme();
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = (sz - stroke) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <View style={{ width: sz, height: sz, alignItems: 'center', justifyContent: 'center' }} accessible accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(p) }}>
      <Svg width={sz} height={sz} style={StyleSheet.absoluteFill}>
        <Circle cx={sz / 2} cy={sz / 2} r={r} stroke={t.surfaceMuted} strokeWidth={stroke} fill="none" />
        <Circle cx={sz / 2} cy={sz / 2} r={r} stroke={p >= 100 ? t.success : t.primary} strokeWidth={stroke} fill="none"
          strokeDasharray={`${circ} ${circ}`} strokeDashoffset={circ * (1 - p / 100)} strokeLinecap="round"
          transform={`rotate(-90 ${sz / 2} ${sz / 2})`} />
      </Svg>
      <Text variant={sz >= 80 ? 'headline' : 'label'} num>{label ?? `${Math.round(p)}%`}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  kpiWrap: { flex: 1, borderRadius: radius.md, overflow: 'hidden' },
  kpi: { minHeight: 96, borderRadius: radius.md, padding: space[3], gap: 2, overflow: 'hidden', flex: 1 },
  kpiBar: { position: 'absolute', top: 0, left: 0, right: 0, height: 4 },
  kpiTop: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  clear: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tile: { flex: 1, minHeight: size.tile + 8, borderRadius: radius.lg, padding: space[3], gap: space[2], overflow: 'hidden' },
  tileCompact: { minHeight: size.tile, alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: space[2] },
  tileIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  tileIconSm: { width: 40, height: 40, borderRadius: 20 },
  badge: { position: 'absolute', top: 8, right: 8, minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  hero: { minHeight: 72, borderRadius: radius.lg, flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[4], paddingVertical: space[3], borderWidth: 1.5, overflow: 'hidden' },
  heroIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  track: { flex: 1, height: 8, borderRadius: 4, overflow: 'visible' },
  fill: { height: 8, borderRadius: 4 },
  marker: { position: 'absolute', top: -3, width: 2, height: 14, marginLeft: -1 },
  barLabel: { minWidth: 44, textAlign: 'right' },
});
