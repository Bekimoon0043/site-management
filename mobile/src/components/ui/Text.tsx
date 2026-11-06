// <Text variant tone> — the single text primitive (replaces T / H1 / H2).
import React, { createContext, memo, useContext } from 'react';
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { ETHIOPIC_FONT, typeFor, useTheme, type Theme, type TypeVariant } from '../../theme';

export type TextTone =
  | 'default' | 'muted' | 'disabled' | 'primary' | 'onPrimary' | 'accent' | 'onAccent'
  | 'success' | 'warning' | 'danger' | 'info' | 'inherit';

const toneColor = (t: Theme, tone: TextTone): string | undefined => tone === 'inherit' ? undefined : ({
  default: t.text, muted: t.textMuted, disabled: t.textDisabled, primary: t.primary, onPrimary: t.onPrimary,
  accent: t.accent, onAccent: t.onAccent, success: t.success, warning: t.warning, danger: t.danger, info: t.info,
} as Record<Exclude<TextTone, 'inherit'>, string>)[tone];

/** Locale context: set `ethiopic` when the UI language is Amharic (Phase 3). */
export const ScriptContext = createContext<{ ethiopic: boolean }>({ ethiopic: false });

// Base styles are cached per theme so rows never allocate style objects.
const cache = new WeakMap<Theme, Map<string, TextStyle>>();
function baseStyle(t: Theme, variant: TypeVariant, tone: TextTone, num: boolean, ethiopic: boolean): TextStyle {
  let m = cache.get(t);
  if (!m) { m = new Map(); cache.set(t, m); }
  const k = `${variant}|${tone}|${num ? 1 : 0}|${ethiopic ? 1 : 0}`;
  let s = m.get(k);
  if (!s) {
    s = {
      ...typeFor(variant, t, ethiopic),
      color: toneColor(t, tone),
      ...(num ? { fontVariant: ['tabular-nums'] as TextStyle['fontVariant'] } : null),
      ...(ethiopic ? { fontFamily: ETHIOPIC_FONT } : null),
    };
    m.set(k, s);
  }
  return s;
}

export interface TextProps extends RNTextProps {
  variant?: TypeVariant;
  tone?: TextTone;
  /** Explicit colour (wins over tone). */
  color?: string;
  /** Tabular numerals for quantity columns. */
  num?: boolean;
  align?: TextStyle['textAlign'];
  weight?: TextStyle['fontWeight'];
  strike?: boolean;
}

export const Text = memo(function Text({ variant = 'body', tone = 'default', color, num, align, weight, strike, style, maxFontSizeMultiplier, ...rest }: TextProps) {
  const t = useTheme();
  const { ethiopic } = useContext(ScriptContext);
  const base = baseStyle(t, variant, tone, !!num, ethiopic);
  let extra: TextStyle | null = null;
  if (color || align || weight || strike) {
    const e: { -readonly [K in keyof TextStyle]?: TextStyle[K] } = {};
    if (color) e.color = color;
    if (align) e.textAlign = align;
    if (weight) e.fontWeight = weight;
    if (strike) e.textDecorationLine = 'line-through';
    extra = e;
  }
  return (
    <RNText
      {...rest}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? (variant === 'display' ? 1.2 : 1.4)}
      style={extra || style ? [base, extra, style] : base}
    />
  );
});
