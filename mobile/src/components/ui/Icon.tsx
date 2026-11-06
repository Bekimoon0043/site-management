// One icon font: Material Design Icons (Pictogrammers), embedded at build time
// via the package's Android autolinking (fonts copied into assets) — no runtime load.
import React, { memo } from 'react';
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons/static';
import { useTheme, type Theme } from '../../theme';

/** The icons the app uses. Add new names here (tsc rejects names that don't exist in MDI). */
export type IconName =
  // navigation / chrome
  | 'home-variant' | 'home-variant-outline' | 'dots-horizontal' | 'dots-horizontal-circle-outline' | 'magnify' | 'close' | 'chevron-right'
  | 'chevron-down' | 'chevron-up' | 'chevron-left' | 'arrow-left' | 'bell-outline' | 'bell' | 'cog-outline' | 'logout'
  | 'menu-down' | 'sort' | 'filter-variant' | 'history' | 'eye-outline' | 'open-in-new'
  // actions
  | 'plus' | 'minus' | 'check' | 'check-all' | 'check-circle' | 'check-circle-outline' | 'pencil' | 'pencil-outline'
  | 'trash-can-outline' | 'content-copy' | 'share-variant-outline' | 'file-pdf-box' | 'refresh' | 'undo-variant'
  | 'send-outline' | 'star' | 'star-outline' | 'camera-outline' | 'camera-plus-outline' | 'image-outline'
  | 'image-multiple-outline' | 'draw-pen' | 'calendar-outline' | 'calendar-today' | 'map-marker-outline'
  | 'map-marker-check-outline' | 'playlist-plus' | 'swap-horizontal' | 'swap-vertical' | 'tune-variant'
  | 'checkbox-marked' | 'checkbox-blank-outline' | 'radiobox-marked' | 'radiobox-blank' | 'circle-outline'
  | 'lock-outline' | 'lock-open-outline' | 'fingerprint' | 'account-outline' | 'account-circle-outline'
  | 'account-group-outline' | 'account-clock-outline' | 'account-hard-hat-outline' | 'link-variant'
  // domain
  | 'package-variant-closed' | 'package-variant-closed-remove' | 'package-variant' | 'warehouse' | 'file-document-multiple-outline'
  | 'file-document-outline' | 'clipboard-list-outline' | 'clipboard-text-outline' | 'clipboard-check-outline'
  | 'clipboard-alert-outline' | 'chart-gantt' | 'check-decagram-outline' | 'check-decagram' | 'truck-delivery-outline'
  | 'truck-check-outline' | 'truck-fast-outline' | 'dump-truck' | 'crane' | 'hard-hat' | 'wall' | 'pillar'
  | 'floor-plan' | 'barcode-scan' | 'qrcode-scan' | 'scale-balance' | 'ruler-square' | 'cube-outline'
  | 'delete-variant' | 'counter' | 'keyboard-return' | 'tray-arrow-down' | 'tray-arrow-up' | 'store-search-outline'
  | 'cart-outline' | 'layers-outline' | 'progress-check' | 'progress-clock' | 'progress-wrench' | 'format-list-checks'
  | 'weather-pouring' | 'clock-outline' | 'timer-sand' | 'hand-back-left-outline' | 'shield-check-outline'
  | 'circle-half-full' | 'cancel' | 'close-octagon-outline' | 'fire' | 'alert-outline' | 'alert-circle-outline'
  | 'alert-octagon-outline' | 'information-outline' | 'help-circle-outline' | 'lightning-bolt-outline'
  | 'arrow-up-bold' | 'arrow-down-bold' | 'plus-circle-outline' | 'minus-circle-outline'
  // field & quality
  | 'weather-sunny' | 'weather-cloudy' | 'weather-rainy' | 'weather-windy' | 'weather-fog' | 'bug-outline'
  | 'flask-outline' | 'test-tube' | 'tools' | 'excavator' | 'notebook-outline' | 'notebook-edit-outline' | 'thermometer'
  | 'water-outline' | 'ticket-outline' | 'truck-outline' | 'play-outline' | 'flag-outline' | 'calendar-check-outline'
  | 'calendar-alert' | 'account-tie-outline' | 'note-text-outline' | 'hammer-wrench' | 'clipboard-plus-outline'
  | 'text-box-plus-outline' | 'format-list-numbered'
  // sync / system
  | 'cloud-check-outline' | 'cloud-upload-outline' | 'sync' | 'cloud-alert-outline' | 'cloud-off-outline'
  | 'clock-alert-outline' | 'database-refresh-outline' | 'wifi' | 'vibrate' | 'theme-light-dark'
  | 'white-balance-sunny' | 'weather-night' | 'cellphone' | 'brightness-auto' | 'phone-rotate-landscape'
  // procurement / gate / alerts / settings
  | 'boom-gate' | 'boom-gate-outline' | 'car-outline' | 'car-arrow-right' | 'car-arrow-left' | 'truck-outline'
  | 'bell-alert-outline' | 'bell-cog-outline' | 'tag-outline' | 'cash' | 'translate' | 'calendar-month-outline'
  | 'cart-arrow-down' | 'cart-plus' | 'send' | 'message-text-outline' | 'shield-alert-outline' | 'chart-line';

export type IconTone = 'text' | 'muted' | 'primary' | 'onPrimary' | 'accent' | 'onAccent' | 'success' | 'warning' | 'danger' | 'info' | 'disabled';

const toneColor = (t: Theme, tone: IconTone): string => ({
  text: t.text, muted: t.textMuted, primary: t.primary, onPrimary: t.onPrimary, accent: t.accent, onAccent: t.onAccent,
  success: t.success, warning: t.warning, danger: t.danger, info: t.info, disabled: t.textDisabled,
}[tone]);

export interface IconProps {
  name: IconName;
  /** 24 standard, 20 inline (chips/rows), 28–32 action tiles. */
  size?: number;
  tone?: IconTone;
  /** Overrides tone. */
  color?: string;
  accessibilityLabel?: string;
}

export const Icon = memo(function Icon({ name, size = 24, tone = 'text', color, accessibilityLabel }: IconProps) {
  const t = useTheme();
  return (
    <MaterialDesignIcons
      name={name}
      size={size}
      color={color ?? toneColor(t, tone)}
      allowFontScaling={false}
      accessible={!!accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={accessibilityLabel ? 'yes' : 'no-hide-descendants'}
    />
  );
});
