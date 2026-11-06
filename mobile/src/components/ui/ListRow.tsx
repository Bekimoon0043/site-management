// Dense list rows for FlashList (spec §3.4). Pure, memoised, primitive props only.
import React, { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { size, space, statusInfo, tone as toneOf, useTheme, type Tone } from '../../theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { Chip } from './Chip';
import { SyncDot } from './SyncBand';

export interface ListRowProps {
  /** Passed back to onPress so the parent can use one stable callback. */
  id: string;
  title: string;
  subtitle?: string | null;
  /** Second meta line (72 dp row). */
  meta?: string | null;
  icon?: IconName;
  iconTone?: Tone;
  /** Status key from the §1.6 map → trailing chip. */
  status?: string | null;
  /** Free chip instead of / in addition to status. */
  chip?: { label: string; tone: Tone; icon?: IconName } | null;
  /** Big right-aligned quantity (stock rows). */
  qty?: string | null;
  unit?: string | null;
  qtyTone?: 'default' | 'danger' | 'warning' | 'success';
  stripe?: Tone | null;
  sync?: 'pending' | 'failed' | 'synced' | null;
  chevron?: boolean;
  /** Unread dot (notifications). */
  unread?: boolean;
  onPress?: (id: string) => void;
  testID?: string;
}

export const ListRow = memo(function ListRow({
  id, title, subtitle, meta, icon, iconTone = 'primary', status, chip, qty, unit, qtyTone = 'default', stripe, sync, chevron, unread, onPress, testID,
}: ListRowProps) {
  const t = useTheme();
  const st = status ? statusInfo(status) : null;
  const ic = icon ? toneOf(t, iconTone) : null;
  const tall = !!meta;
  return (
    <Pressable
      testID={testID}
      disabled={!onPress}
      onPress={onPress ? () => onPress(id) : undefined}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={[title, subtitle, meta, st?.label, chip?.label, qty ? `${qty} ${unit ?? ''}` : null].filter(Boolean).join(', ')}
      android_ripple={{ color: t.ripple }}
      style={[styles.row, { minHeight: tall ? size.rowTall : size.row, backgroundColor: t.surface, borderBottomColor: t.border, borderBottomWidth: t.borderWidth === 2 ? 2 : StyleSheet.hairlineWidth * 2 }]}
    >
      {stripe ? <View style={[styles.stripe, { backgroundColor: toneOf(t, stripe).solid }]} /> : null}
      {ic && icon ? (
        <View style={[styles.lead, { backgroundColor: ic.container }]}><Icon name={icon} size={22} color={ic.onContainer} /></View>
      ) : null}
      <View style={styles.body}>
        <View style={styles.titleRow}>
          {unread ? <View style={[styles.dot, { backgroundColor: t.primary }]} /> : null}
          <Text variant="titleSm" numberOfLines={1} style={styles.shrink}>{title}</Text>
          <SyncDot status={sync} />
        </View>
        {subtitle ? <Text variant="bodySm" tone="muted" numberOfLines={1}>{subtitle}</Text> : null}
        {meta ? <Text variant="caption" tone="muted" numberOfLines={1}>{meta}</Text> : null}
        {qty != null && (st || chip) ? (
          <View style={styles.chipsUnder}>
            {chip ? <Chip label={chip.label} tone={chip.tone} icon={chip.icon} small /> : null}
            {st ? <Chip label={st.label} tone={st.tone} icon={st.icon} small /> : null}
          </View>
        ) : null}
      </View>
      {qty != null ? (
        <View style={styles.qty}>
          <Text variant="title" num tone={qtyTone} numberOfLines={1}>{qty}</Text>
          {unit ? <Text variant="caption" tone="muted">{unit}</Text> : null}
        </View>
      ) : (st || chip) ? (
        <View style={styles.trail}>
          {st ? <Chip label={st.label} tone={st.tone} icon={st.icon} strike={st.muted} /> : null}
          {chip ? <Chip label={chip.label} tone={chip.tone} icon={chip.icon} /> : null}
        </View>
      ) : null}
      {chevron ? <Icon name="chevron-right" size={22} tone="muted" /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space[4], paddingVertical: space[2], gap: space[3] },
  stripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  lead: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shrink: { flexShrink: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  trail: { alignItems: 'flex-end', gap: 4, maxWidth: '45%' },
  chipsUnder: { flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' },
  qty: { alignItems: 'flex-end', minWidth: 64 },
});
