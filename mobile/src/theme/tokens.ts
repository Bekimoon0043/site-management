// "Blueprint & Beacon" design tokens (docs/research/mobile-design.md §1–2).
// The three theme objects are module constants: a theme switch re-renders once
// and `makeStyles` caches StyleSheets per theme object.

export const light = {
  background: '#F3F4F1', surface: '#FFFFFF', surfaceElevated: '#FFFFFF', surfaceMuted: '#E6E8EB',
  border: '#D3D7DD', borderStrong: '#7C8592', text: '#111827', textMuted: '#4A5361', textDisabled: '#8A929E',
  primary: '#163A5F', onPrimary: '#FFFFFF', primaryContainer: '#DCE7F3', onPrimaryContainer: '#0D2742',
  accent: '#F59E0B', onAccent: '#1A1203', accentStrong: '#B86E00',
  success: '#1D7A3A', onSuccess: '#FFFFFF', successContainer: '#DDF3E3', onSuccessContainer: '#0F4D23',
  warning: '#9A5800', onWarning: '#FFFFFF', warningContainer: '#FFF0D1', onWarningContainer: '#6B3D00',
  danger: '#B42318', onDanger: '#FFFFFF', dangerContainer: '#FDE3E1', onDangerContainer: '#7F1710',
  info: '#0B65A3', onInfo: '#FFFFFF', infoContainer: '#DDEEFA', onInfoContainer: '#06446F',
  violet: '#5B3FA8', onViolet: '#FFFFFF', violetContainer: '#ECE6FA', onVioletContainer: '#3E2580',
  neutral: '#4A5361', onNeutral: '#FFFFFF', neutralContainer: '#E6E8EB', onNeutralContainer: '#374151',
  scrim: 'rgba(17,24,39,0.48)', offlineBand: '#374151', onOfflineBand: '#FFFFFF',
  inverseSurface: '#111827', onInverseSurface: '#FFFFFF',
  ripple: 'rgba(17,24,39,0.10)',
  /** Signature canvas is white in every theme. */
  canvas: '#FFFFFF', ink: '#000000',
  borderWidth: 1, shadow: true, dark: false, boost: false,
} as const;

type Widen<T> = T extends boolean ? boolean : T extends number ? number : string;
export type Theme = { readonly [K in keyof typeof light]: Widen<(typeof light)[K]> };

export const dark: Theme = {
  background: '#0D1117', surface: '#161B22', surfaceElevated: '#1F2630', surfaceMuted: '#262D37',
  border: '#2C3540', borderStrong: '#68737F', text: '#ECEFF3', textMuted: '#A3ADBB', textDisabled: '#5E6875',
  primary: '#8DB8EA', onPrimary: '#0A1E33', primaryContainer: '#1E3A5C', onPrimaryContainer: '#D6E6FA',
  accent: '#FFB224', onAccent: '#1A1203', accentStrong: '#FFB224',
  success: '#57C77A', onSuccess: '#0A2414', successContainer: '#123620', onSuccessContainer: '#9BE3B1',
  warning: '#FFB224', onWarning: '#1A1203', warningContainer: '#3D2A06', onWarningContainer: '#FFD27A',
  danger: '#FF7A6E', onDanger: '#2A0804', dangerContainer: '#45160F', onDangerContainer: '#FFB4AB',
  info: '#62B8F2', onInfo: '#04213A', infoContainer: '#0E2C44', onInfoContainer: '#A6D6F7',
  violet: '#B9A3F5', onViolet: '#1B1236', violetContainer: '#2A2148', onVioletContainer: '#D7CCFA',
  neutral: '#A3ADBB', onNeutral: '#0D1117', neutralContainer: '#262D37', onNeutralContainer: '#C9D1DB',
  scrim: 'rgba(0,0,0,0.6)', offlineBand: '#374151', onOfflineBand: '#ECEFF3',
  inverseSurface: '#ECEFF3', onInverseSurface: '#111827',
  ripple: 'rgba(255,255,255,0.12)',
  canvas: '#FFFFFF', ink: '#000000',
  borderWidth: 1, shadow: false, dark: true, boost: false,
};

/** High-contrast light variant for direct sun (§1.4). */
export const sunlight: Theme = {
  ...light, background: '#FFFFFF', text: '#000000', textMuted: '#2F3744',
  border: '#4A5361', borderStrong: '#4A5361', primary: '#0F2B4A', borderWidth: 2, shadow: false, boost: true,
};

export type ThemeMode = 'system' | 'light' | 'dark' | 'sunlight';

// ---------------------------------------------------------------------------
// Spacing, sizes, radii (§2.3, §2.4)
// ---------------------------------------------------------------------------

export const space = {
  0: 0, 0.5: 2, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48,
  // aliases
  xs: 4, sm: 8, md: 12, lg: 16, xl: 24, gutter: 16,
} as const;

export const size = { touch: 48, control: 56, tile: 88, row: 64, rowTall: 72, icon: 24, iconSm: 20 } as const;
/** @deprecated use size.touch / size.control */
export const TOUCH = size.control;

export const radius = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;

export const duration = { press: 100, fade: 150, enter: 200, push: 250 } as const;

// ---------------------------------------------------------------------------
// Typography (§2.1, §2.2). System font (Roboto). Ethiopic falls back to the
// system Noto Sans Ethiopic; `ethiopic` multiplies line heights by 1.15 and
// adds +1 sp to body/caption sizes, never below 14 sp.
// ---------------------------------------------------------------------------

type Weight = '400' | '500' | '600' | '700' | '800';
export interface TypeStyle { fontSize: number; lineHeight: number; fontWeight: Weight }

export const typeScale = {
  display: { fontSize: 32, lineHeight: 40, fontWeight: '800' },
  headline: { fontSize: 24, lineHeight: 32, fontWeight: '700' },
  title: { fontSize: 20, lineHeight: 28, fontWeight: '700' },
  titleSm: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bodySm: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  button: { fontSize: 16, lineHeight: 20, fontWeight: '700' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
} as const satisfies Record<string, TypeStyle>;

export type TypeVariant = keyof typeof typeScale;

const UP: Record<Weight, Weight> = { '400': '500', '500': '600', '600': '700', '700': '800', '800': '800' };

/** Resolve a type style for a theme (sunlight boost) and script (Ethiopic). */
export function typeFor(variant: TypeVariant, t: Pick<Theme, 'boost'>, ethiopic = false): TypeStyle {
  const base: TypeStyle = typeScale[variant];
  let { fontSize, lineHeight, fontWeight } = base;
  const bodyish = variant === 'body' || variant === 'bodySm' || variant === 'caption' || variant === 'label';
  if (t.boost) {
    if (bodyish) { fontSize += 1; lineHeight += 1; }
    fontWeight = UP[fontWeight];
  }
  if (ethiopic) {
    if (bodyish) fontSize += 1;
    fontSize = Math.max(fontSize, 14);
    lineHeight = Math.round(lineHeight * 1.15);
  }
  return { fontSize, lineHeight, fontWeight };
}

/** Font family for Ethiopic UI (Phase 3: embed Noto Sans Ethiopic via expo-font plugin). */
export const ETHIOPIC_FONT = 'NotoSansEthiopic';

// ---------------------------------------------------------------------------
// Elevation (§2.5). Android native shadows; dark mode uses lighter surfaces.
// ---------------------------------------------------------------------------

export function elevation(t: Theme, level: 0 | 1 | 2 | 3) {
  if (!t.shadow || level === 0) return { elevation: 0 } as const;
  return { elevation: level === 1 ? 1 : level === 2 ? 4 : 8, shadowColor: '#000' } as const;
}

// ---------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------

export type Tone = 'neutral' | 'primary' | 'info' | 'success' | 'warning' | 'danger' | 'violet';

export interface ToneColors { solid: string; onSolid: string; container: string; onContainer: string }

export function tone(t: Theme, k: Tone): ToneColors {
  switch (k) {
    case 'primary': return { solid: t.primary, onSolid: t.onPrimary, container: t.primaryContainer, onContainer: t.onPrimaryContainer };
    case 'info': return { solid: t.info, onSolid: t.onInfo, container: t.infoContainer, onContainer: t.onInfoContainer };
    case 'success': return { solid: t.success, onSolid: t.onSuccess, container: t.successContainer, onContainer: t.onSuccessContainer };
    case 'warning': return { solid: t.warning, onSolid: t.onWarning, container: t.warningContainer, onContainer: t.onWarningContainer };
    case 'danger': return { solid: t.danger, onSolid: t.onDanger, container: t.dangerContainer, onContainer: t.onDangerContainer };
    case 'violet': return { solid: t.violet, onSolid: t.onViolet, container: t.violetContainer, onContainer: t.onVioletContainer };
    default: return { solid: t.neutral, onSolid: t.onNeutral, container: t.neutralContainer, onContainer: t.onNeutralContainer };
  }
}
