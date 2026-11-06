# Site Materials: Mobile Design Spec (implementation-ready)

Status: proposal · Date: 29 Oct 2026 · Scope: `mobile/` (Expo SDK 58, RN 0.88, React 19.3, expo-router) with shared tokens for `web/`.
Grounded in the current code: `mobile/src/theme.ts`, `components/ui.tsx`, `components/pickers.tsx`, `components/Photos.tsx`, `components/SignaturePad.tsx`, `app/index.tsx`, `app/requests/new.tsx`, `app/store/receive.tsx`, `app/store/stock.tsx`, `app/_layout.tsx`.

---

## 0. What the app does today, and what to change

| Area | Today | Problem | Direction |
|---|---|---|---|
| Theme (`theme.ts`) | 13 flat colours, generic Tailwind blue `#1d4ed8`, `TOUCH = 52`, 5-step spacing | No brand. No container/"on" roles. `muted` is used for both secondary text and labels. No status tokens. No sunlight mode. Dark `primary #4f8bff` with white text is only 3.3:1 (fails AA for button labels). | Full token set (§1) with semantic + status + sync roles, a high-contrast "Sunlight" mode and a user theme override |
| Icons | Emoji and Unicode glyphs (`⬇ ⬆ ↩ ▦ ☰ 🔔 ⟳`) | Rendering varies by Android version and OEM. Emoji ignore theme colour. Some glyphs are missing on older devices. | One icon font: Material Design Icons (§2.6) |
| Navigation | Single `Stack`, a dashboard with 6 tiles and 4–8 equal-weight action buttons | Everything is one tap deep from Home, then back. No persistent access to Requests/Stock/Approvals. No badges. | Role-based bottom tabs, a hero action and quick-action tiles (§4) |
| Forms (`requests/new.tsx`, `store/receive.tsx`) | One long scroll. Every field is visible. Line cards contain 8–10 inputs. Free-typed quantities. Submit sits at the end of the scroll. | Too long to finish a request in 90 s or a GRN in 2 min, and too much typing | Smart defaults, a collapsed header summary, line editing in a sheet, stepper with quick-add, sticky action bar (§5) |
| Picker (`pickers.tsx`) | Full-screen `Modal` with FlatList, 300-item slice, recents marked "★ recent" | No favourites, no sections, filtering re-runs `toLowerCase` on every option on every keystroke, no category filter | Sectioned search sheet with Favourites / Recent / All, category chips, precomputed search keys, FlashList (§3.6) |
| Lists | `FlatList`. Cards with 4–5 `KV` rows in Stock. | Rows are tall, so about 4 fit per screen. FlatList is slower on low-end devices. | FlashList v2 with 64–72 dp dense rows (§3.4, §6) |
| Photos | RN `Image` showing the full-resolution local file in a 96 px box | Decoding full camera images at thumbnail size uses a lot of memory on 2 GB phones | `expo-image` and stored 320 px thumbnails (§6) |
| Signature | Re-renders every committed path on each pointer move | Lag on low-end phones | Memoise committed paths, throttle points (§3.17) |
| Status badges | Outlined UPPERCASE text in the tone colour | Colour carries the meaning. Uppercase is harder to scan and Amharic has no case. | Filled tonal chip: icon + sentence-case label (§3.5) |

---

## 1. Brand & colour system

### 1.1 Concept: "Blueprint & Beacon"

- **Blueprint navy, primary `#163A5F`.** This is the colour of construction drawings and of steel and engineering brands. It reads as serious and trustworthy for approvals and stock figures. At 11.6:1 against white it holds up in glare, unlike mid blues such as the current `#1d4ed8`, which wash out outdoors. It also stays clearly separate from the semantic colours (success green, danger red, info blue-cyan).
- **Beacon amber, accent `#F59E0B`.** This is the safety colour of the site: hi-vis vests, signage, plant. ANSI Z535 uses orange and yellow for warning and caution, and safety orange is chosen because it stands out against sky and concrete. Using it for the brand ties the app to the site. Two rules come with that:
  1. **Amber is never text on a light background** (2.1:1). It is a *fill* with dark text (`onAccent #1A1203`, 8.6:1), a stripe, or an icon-plus-label chip.
  2. **Amber is scarce.** Use it for the one hero action per screen (FAB, "New request", "Receive delivery"), the active-tab indicator, the brand mark and attention highlights. Because amber is also the warning hue, *warning states always carry an icon and words* ("Low stock", "Waiting to sync") and use the deeper `warning` brown-amber family. Meaning never comes from hue alone.
- **Concrete neutrals.** A slightly warm grey (`#F3F4F1` background) instead of blue-grey. It is calmer in sunlight, sets the app apart from typical SaaS blue-greys, and makes white cards stand out.
- **Why not dark-first:** outdoors, ambient light reflects off the screen and compresses contrast whatever the theme. Light mode with near-black text gives the most usable contrast in direct sun on LCD phones, which are typical at 2 GB RAM. Dark mode is supported for indoor and night use and follows the system by default.

### 1.2 Light tokens

| Token | Hex | Use |
|---|---|---|
| `background` | `#F3F4F1` | App background (concrete) |
| `surface` | `#FFFFFF` | Cards, sheets, list rows, inputs |
| `surfaceElevated` | `#FFFFFF` | Sticky bars, sheets, menus (same colour plus shadow in light) |
| `surfaceMuted` | `#E6E8EB` | Secondary buttons, unselected chips, info wells, skeleton base |
| `border` | `#D3D7DD` | Decorative dividers and card outlines (no contrast requirement) |
| `borderStrong` | `#7C8592` | Input, checkbox and outline-button borders (3.7:1, WCAG 1.4.11) |
| `text` | `#111827` | Primary text |
| `textMuted` | `#4A5361` | Labels, secondary text, placeholders |
| `textDisabled` | `#8A929E` | Disabled only |
| `primary` | `#163A5F` | Primary buttons, links, selected states, focus ring, progress |
| `onPrimary` | `#FFFFFF` | Text and icons on primary |
| `primaryContainer` | `#DCE7F3` | Selected chip/segment, selected row, tonal button |
| `onPrimaryContainer` | `#0D2742` | Text on primaryContainer |
| `accent` | `#F59E0B` | Hero action fill, active-tab indicator, brand |
| `onAccent` | `#1A1203` | Text and icons on accent |
| `accentStrong` | `#B86E00` | 1.5 dp outline around amber fills on light backgrounds (4.0:1), so the FAB edge is visible |
| `success` | `#1D7A3A` | onSuccess `#FFFFFF` |
| `successContainer` | `#DDF3E3` | onSuccessContainer `#0F4D23` |
| `warning` | `#9A5800` | onWarning `#FFFFFF` |
| `warningContainer` | `#FFF0D1` | onWarningContainer `#6B3D00` |
| `danger` | `#B42318` | onDanger `#FFFFFF` |
| `dangerContainer` | `#FDE3E1` | onDangerContainer `#7F1710` |
| `info` | `#0B65A3` | onInfo `#FFFFFF` |
| `infoContainer` | `#DDEEFA` | onInfoContainer `#06446F` |
| `violet` | `#5B3FA8` | For "partial" states. Container `#ECE6FA`, on `#3E2580` |
| `neutralContainer` | `#E6E8EB` | onNeutralContainer `#374151` |
| `scrim` | `rgba(17,24,39,0.48)` | Behind sheets and dialogs |
| `offlineBand` | `#374151` | Offline banner background, text `#FFFFFF` |

### 1.3 Dark tokens

| Token | Hex | Notes |
|---|---|---|
| `background` | `#0D1117` | |
| `surface` | `#161B22` | |
| `surfaceElevated` | `#1F2630` | In dark mode elevation is shown by a lighter surface, not a shadow |
| `surfaceMuted` | `#262D37` | |
| `border` | `#2C3540` | Decorative |
| `borderStrong` | `#68737F` | 3.6:1 on surface, 3.15:1 on elevated |
| `text` | `#ECEFF3` | |
| `textMuted` | `#A3ADBB` | |
| `textDisabled` | `#5E6875` | |
| `primary` | `#8DB8EA` | Light blueprint. Button text is **dark** |
| `onPrimary` | `#0A1E33` | |
| `primaryContainer` | `#1E3A5C` | onPrimaryContainer `#D6E6FA` |
| `accent` | `#FFB224` | onAccent `#1A1203`. accentStrong is not needed |
| `success` | `#57C77A` | onSuccess `#0A2414`. Container `#123620`, on `#9BE3B1` |
| `warning` | `#FFB224` | onWarning `#1A1203`. Container `#3D2A06`, on `#FFD27A` |
| `danger` | `#FF7A6E` | onDanger `#2A0804`. Container `#45160F`, on `#FFB4AB` |
| `info` | `#62B8F2` | onInfo `#04213A`. Container `#0E2C44`, on `#A6D6F7` |
| `violet` | `#B9A3F5` | Container `#2A2148`, on `#D7CCFA` |
| `neutralContainer` | `#262D37` | on `#C9D1DB` |
| `scrim` | `rgba(0,0,0,0.6)` | |
| `offlineBand` | `#374151` | text `#ECEFF3` |

### 1.4 "Sunlight" high-contrast mode (light variant, user setting)

This overrides the light theme for use in direct sun. It is selected in Settings as Theme: System / Light / Dark / **Sunlight**.
`background #FFFFFF`, `surface #FFFFFF`, `text #000000` (21:1), `textMuted #2F3744` (12:1), `border` and `borderStrong #4A5361` (7.8:1), `primary #0F2B4A` (14.3:1). All borders become **2 dp**. Card shadows are turned off; the 2 dp border provides the separation. Body text gets +1 sp and weights go up one step (400→500, 600→700).
This mode is cheap to build because it only overrides tokens. It also gives us something to show in demos.

### 1.5 WCAG contrast checks (computed with the WCAG 2.x relative-luminance formula)

| Pair (light) | Ratio | | Pair (dark) | Ratio |
|---|---|---|---|---|
| text / background | 16.07 | | text / background | 16.41 |
| text / surface | 17.74 | | text / surface | 15.00 |
| text / surfaceMuted | 14.45 | | text / surfaceElevated | 13.21 |
| textMuted / surface | 7.77 | | textMuted / surface | 7.62 |
| textMuted / background | 7.04 | | textMuted / surfaceElevated | 6.71 |
| textMuted / surfaceMuted | 6.33 | | textMuted / surfaceMuted | 6.12 |
| onPrimary / primary | 11.64 | | onPrimary / primary | 8.16 |
| primary / background (links) | 10.54 | | primary / background | 9.17 |
| onPrimaryContainer / primaryContainer | 12.10 | | onPrimaryContainer / primaryContainer | 9.12 |
| onAccent / accent | 8.64 | | onAccent / accent | 10.29 |
| accent / primary (amber on navy, brand) | 5.42 | | accent / surface | 9.59 |
| accentStrong / surface (non-text edge) | 3.99 | | | |
| success / surface · white on success | 5.39 | | success / surface | 8.12 |
| warning / surface · white on warning | 5.57 | | warning / surface | 9.59 |
| danger / surface · white on danger | 6.57 | | danger / surface | 6.80 |
| info / surface · white on info | 6.17 | | info / surface | 7.96 |
| onSuccessContainer / successContainer | 8.55 | | | 8.90 |
| onWarningContainer / warningContainer | 8.13 | | | 9.63 |
| onDangerContainer / dangerContainer | 8.49 | | | 9.00 |
| onInfoContainer / infoContainer | 8.57 | | | 9.29 |
| violet / surface · on / violetContainer | 7.72 · 9.69 | | | 7.92 · 9.87 |
| onNeutralContainer / neutralContainer | 8.40 | | | 9.01 |
| borderStrong / surface (1.4.11) | 3.73 | | borderStrong / surface | 3.58 |
| offlineBand text | 10.31 | | offlineBand text | 8.94 |
| ❌ accent as text on white | 2.12 (forbidden) | | ❌ border (decorative) | 1.39 (decorative only) |

Every text pair is at least 5.4:1, which beats AA (4.5:1) with margin for glare. The project rule is **≥ 7:1 for body text and ≥ 4.5:1 for anything else that carries meaning**. AA is not sufficient outdoors.

### 1.6 Status colour mapping

All chips are **container background + on-container text + icon**. The solid tone colour is used only for the 4 dp left stripe on cards and for progress fills.

**Material request (`material_requests.status`)**

| Status | Tone | Icon (MDI) | Label |
|---|---|---|---|
| draft | neutral | `pencil-outline` | Draft |
| submitted | info | `send-outline` | Submitted |
| reviewed | info | `clipboard-check-outline` | Reviewed |
| returned | warning | `undo-variant` | Returned |
| approved | success | `check-decagram-outline` | Approved |
| partially_issued | violet | `circle-half-full` | Part issued |
| issued | primary (container) | `truck-check-outline` | Issued |
| closed | neutral | `lock-outline` | Closed |
| rejected | danger | `close-octagon-outline` | Rejected |
| cancelled | neutral (text muted, struck icon) | `cancel` | Cancelled |

**Other documents:** pending_ack → warning `account-clock-outline` "Awaiting sign-off" · acknowledged → success · posted → success `check` · reversed → danger `swap-horizontal` · in_transit → info `truck-fast-outline` · received → success · pending (adjustment/count) → warning `timer-sand` · adjusted → info · reported (progress) → info "To verify" · verified → success `shield-check-outline` · not_started → neutral · in_progress → primary · completed → success · on_hold/hold point → warning `hand-back-left-outline`.

**Priority:** normal → no chip (absence is the default) · urgent → warningContainer `alert-outline` "Urgent" · critical → dangerContainer `fire` "Critical path".

**Sync state (per record and global)**

| State | Visual | Icon | Copy |
|---|---|---|---|
| synced | No chip on the record (stay quiet); success tick only on the doc detail header | `cloud-check-outline` | "Synced 2 min ago" |
| pending / queued | warningContainer chip | `cloud-upload-outline` | "Saved on phone · will sync" |
| syncing | infoContainer chip + spinning icon (one native-driver rotation) | `sync` | "Syncing…" |
| failed / rejected by server | dangerContainer chip; the record card gets a danger stripe | `cloud-alert-outline` | "Sync failed · tap to fix" |
| offline (global) | `offlineBand` strip under the header | `cloud-off-outline` | "Offline · 3 changes saved on this phone" |
| stale (online, last sync > 30 min) | textMuted line on Home | `clock-alert-outline` | "Last synced 2 h ago · Sync now" |

### 1.7 Tokens in code (replace `mobile/src/theme.ts`)

```ts
// src/theme/tokens.ts
export const light = {
  background: '#F3F4F1', surface: '#FFFFFF', surfaceElevated: '#FFFFFF', surfaceMuted: '#E6E8EB',
  border: '#D3D7DD', borderStrong: '#7C8592', text: '#111827', textMuted: '#4A5361', textDisabled: '#8A929E',
  primary: '#163A5F', onPrimary: '#FFFFFF', primaryContainer: '#DCE7F3', onPrimaryContainer: '#0D2742',
  accent: '#F59E0B', onAccent: '#1A1203', accentStrong: '#B86E00',
  success: '#1D7A3A', onSuccess: '#FFFFFF', successContainer: '#DDF3E3', onSuccessContainer: '#0F4D23',
  warning: '#9A5800', onWarning: '#FFFFFF', warningContainer: '#FFF0D1', onWarningContainer: '#6B3D00',
  danger: '#B42318', onDanger: '#FFFFFF', dangerContainer: '#FDE3E1', onDangerContainer: '#7F1710',
  info: '#0B65A3', onInfo: '#FFFFFF', infoContainer: '#DDEEFA', onInfoContainer: '#06446F',
  violet: '#5B3FA8', violetContainer: '#ECE6FA', onVioletContainer: '#3E2580',
  neutralContainer: '#E6E8EB', onNeutralContainer: '#374151',
  scrim: 'rgba(17,24,39,0.48)', offlineBand: '#374151', onOfflineBand: '#FFFFFF',
  ripple: 'rgba(17,24,39,0.10)', borderWidth: 1, shadow: true,
} as const;
export type Theme = { [K in keyof typeof light]: (typeof light)[K] extends boolean ? boolean : (typeof light)[K] extends number ? number : string };

export const dark: Theme = {
  background: '#0D1117', surface: '#161B22', surfaceElevated: '#1F2630', surfaceMuted: '#262D37',
  border: '#2C3540', borderStrong: '#68737F', text: '#ECEFF3', textMuted: '#A3ADBB', textDisabled: '#5E6875',
  primary: '#8DB8EA', onPrimary: '#0A1E33', primaryContainer: '#1E3A5C', onPrimaryContainer: '#D6E6FA',
  accent: '#FFB224', onAccent: '#1A1203', accentStrong: '#FFB224',
  success: '#57C77A', onSuccess: '#0A2414', successContainer: '#123620', onSuccessContainer: '#9BE3B1',
  warning: '#FFB224', onWarning: '#1A1203', warningContainer: '#3D2A06', onWarningContainer: '#FFD27A',
  danger: '#FF7A6E', onDanger: '#2A0804', dangerContainer: '#45160F', onDangerContainer: '#FFB4AB',
  info: '#62B8F2', onInfo: '#04213A', infoContainer: '#0E2C44', onInfoContainer: '#A6D6F7',
  violet: '#B9A3F5', violetContainer: '#2A2148', onVioletContainer: '#D7CCFA',
  neutralContainer: '#262D37', onNeutralContainer: '#C9D1DB',
  scrim: 'rgba(0,0,0,0.6)', offlineBand: '#374151', onOfflineBand: '#ECEFF3',
  ripple: 'rgba(255,255,255,0.12)', borderWidth: 1, shadow: false,
};

export const sunlight: Theme = { ...light, background: '#FFFFFF', text: '#000000', textMuted: '#2F3744',
  border: '#4A5361', borderStrong: '#4A5361', primary: '#0F2B4A', borderWidth: 2, shadow: false };
```

- Provide the theme through a `ThemeProvider` context. The mode is `system | light | dark | sunlight`, stored in `kv` and combined with `useColorScheme()`. The three theme objects are module constants, so the context value only changes when the mode changes, and `useTheme()` returns a stable reference.
- Styles: `const useStyles = makeStyles((t) => StyleSheet.create({...}))`, cached per theme object in a `WeakMap`. This stops the current pattern of building a new inline style object on every render of every row.
- Set `app.json` `splash.backgroundColor` and `android.adaptiveIcon.backgroundColor` to `#163A5F`. The icon is an amber hard-hat or beacon glyph on navy.

### 1.8 Sharing with the web console

Export the same token object as CSS variables (generate `web/src/tokens.css` from `tokens.ts` with a ~20-line script, `--background`, `--surface`, and so on, plus `[data-theme=dark]`).
**Reconciliation note:** `docs/research/web-design.md` currently proposes primary indigo `#2f3fb0`, accent `#f59e0b`, info teal `#0e7490`. Accent and semantic families already line up; this spec adopts `#F59E0B` for exact parity. **Choose one primary for both clients.** This spec recommends Blueprint navy `#163A5F` (light) / `#8DB8EA` (dark), for three reasons: it has more contrast in glare (11.6:1 vs 8.5:1), it is more distinctive, and it fits the construction setting. If the web team keeps indigo, the mobile app should use indigo too rather than diverge.

---

## 2. Typography, spacing, radii, elevation, icons, motion

### 2.1 Fonts

| Script | Mobile | Web |
|---|---|---|
| Latin | **System font (Roboto on Android).** It adds no bytes and no load time, has hinting tuned for low-DPI screens, and users already know it. Inter is not worth ~300 KB per weight or the risk of a render before fonts load. Procore uses Inter on web, which is fine for the web console. | `Inter Variable`, system-ui fallback |
| Ethiopic (Amharic) | **Noto Sans Ethiopic.** Android already ships `NotoSansEthiopic` as a system fallback font, so Amharic text such as names or remarks renders today without bundling anything. When the Amharic UI ships (Phase 3), embed `@expo-google-fonts/noto-sans-ethiopic` (or the OFL variable TTF) **with the expo-font config plugin**. Build-time embedding is recommended over `useFonts` because nothing loads at runtime. Use 400/600/700 static faces, because on Android < API 29 only the default face of a family loads, so a single variable font would lose its weights. | `'Noto Sans Ethiopic'` in the font stack |

Rules:
- Set `fontFamily` only when the locale is `am`. Mixed Latin and Ge'ez in one string falls back per glyph on Android, which is acceptable.
- Ethiopic glyphs are taller and denser. For `am`, multiply line heights by **1.15** and add **+1 sp** to body and caption sizes. Never go below 14 sp for Ge'ez.
- Numbers always use `fontVariant: ['tabular-nums']` so quantity columns line up. Format quantities with grouping (`1,250.5`) and the unit after a thin space.
- Do not use UPPERCASE labels; use sentence case.

### 2.2 Type scale (sp; scales with the OS font size)

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `display` | 32 / 40 | 800 | KPI numbers, the big quantity in a stepper |
| `headline` | 24 / 32 | 700 | Screen titles on Home and detail headers |
| `title` | 20 / 28 | 700 | Sheet titles, section headers |
| `titleSm` | 17 / 24 | 600 | Card titles, list row primary text |
| `body` | 16 / 24 | 400 | Default text, input text (never < 16, which avoids squinting and zoom) |
| `bodySm` | 14 / 20 | 400 | Secondary row text, helper text |
| `label` | 15 / 20 | 600 | Field labels, chip labels |
| `button` | 16 / 20 | 700 | Buttons |
| `caption` | 13 / 18 | 500 | Timestamps and meta only. This is the floor; nothing smaller. |

- Allow OS font scaling. Set `maxFontSizeMultiplier={1.4}` on dense rows and `1.2` on `display` KPIs so grids don't break. Test layouts at 1.3×.
- Define these as a `type` object (`type.body = { fontSize: 16, lineHeight: 24, fontWeight: '400' }`) and a single `<Text variant="body" tone="muted">` component. That replaces `T`, `H1` and `H2`.

### 2.3 Spacing (4 dp grid)

`space = { 0: 0, 0.5: 2, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 }`
- Screen gutter is 16. Card padding is 16 (12 for dense rows). Gap between form fields is 16. Gap between related controls is 8.
- **Touch targets: minimum 48 dp (M3/Android), default 56 dp for buttons, inputs, list rows and steppers, 64+ dp for action tiles and the hero button.** That is about 9 mm, a size field guidance recommends for gloved use. Keep at least 8 dp between adjacent targets. Icon buttons use a 24 dp glyph inside a 48 dp hit area (`hitSlop` is not enough; size the Pressable itself).
- Rename `TOUCH = 52` to `size.touch = 48`, `size.control = 56`, `size.tile = 88`.

### 2.4 Radii

`radius = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, pill: 999 }`. Inputs and buttons use 12. Cards use 12. Sheets use 24 on the top corners. Chips use pill. Action tiles use 16. Corners are deliberately soft but not bubbly.

### 2.5 Elevation

Android shadows are rendered natively. Keep them small; never animate them.

| Level | Light | Dark | Use |
|---|---|---|---|
| 0 | 1 dp `border` | 1 dp `border` | List rows, inline cards (default; borders survive sunlight better than shadows) |
| 1 | `elevation: 1` + border | `surfaceElevated`, no shadow | Tappable cards, tiles |
| 2 | `elevation: 4` | `surfaceElevated` + 1 dp `border` top | Sticky bottom action bar, header when scrolled |
| 3 | `elevation: 8` | `surfaceElevated` | Bottom sheets, FAB, toasts, menus |

Sunlight mode: no shadows, 2 dp borders only.

### 2.6 Iconography: Material Design Icons (`@react-native-vector-icons/material-design-icons`)

**Choice:** the community "MaterialCommunityIcons" set (Pictogrammers MDI, 7,000+ glyphs), installed from the new per-family package `@react-native-vector-icons/material-design-icons` (v14 is current).
Why:
- **`@expo/vector-icons` is being deprecated.** Expo's docs say "will be deprecated and is not recommended", and Expo's migration post measured ~4 MB saved by moving to per-family packages. Start on the replacement.
- **It is a font, not SVG.** Each icon is one `Text` glyph, so it costs almost nothing in long FlashList rows. `lucide-react-native` renders each icon as `react-native-svg` paths (several native views per icon). That is fine for a few icons, but measurably heavier in 50-row lists on low-end phones, and Lucide has fewer domain glyphs.
- **It has construction and logistics glyphs** that Lucide and Material Symbols lack: `truck-delivery-outline`, `dump-truck`, `crane`, `hard-hat`, `warehouse`, `package-variant-closed`, `wall`, `pillar`, `floor-plan`, `clipboard-check-outline`, `barcode-scan`, `qrcode-scan`, `scale-balance`, `ruler-square`, `cube-outline`, `swap-horizontal`, `delete-variant` (wastage), `counter`, `draw-pen` (signature), `camera-plus-outline`.
- **It matches Material 3 visually** and works with expo-router `NativeTabs` (which takes `md`/drawable icons) and with the web console (`@mdi/js` uses the same names).

Setup: `npx expo install @react-native-vector-icons/material-design-icons expo-font`. Use the `/static` import with the config plugin in dev and EAS builds, so the font is embedded at build time with no runtime load and no duplicate copy. Do **not** add `node_modules` font paths to the expo-font plugin, because the build fails. Wrap it in one `<Icon name size tone>` component and **type `name` as a union of the ~60 icons we use**. That stops icon names drifting.
Style: use outline variants by default and filled variants for the selected tab and the active state. Sizes are 24 standard, 20 inline in chips and rows, 28–32 in action tiles. Icons always sit next to a label, except universally understood ones (back, close, search, more) which get an `accessibilityLabel`.

### 2.7 Motion

- **Durations:** 100 ms (press), 150 ms (fade, chip toggle), 200 ms (sheet and toast enter), 250 ms (screen push, native). Easing: `Easing.out(Easing.cubic)` for enter, `Easing.in(Easing.cubic)` for exit.
- **Animate only `opacity` and `transform`, with `useNativeDriver: true`.** Never animate width, height, layout or shadow.
- **Press feedback:** use `Pressable android_ripple={{ color: t.ripple }}`, a native ripple with no JS frames. Drop the current `opacity: 0.7` on press (it makes the whole card dim). For tiles, add a 0.98 scale through one `Animated.Value` per tile, or skip it.
- **"Premium but cheap" micro-interactions:**
  1. Success tick: after posting a GRN or MIV, a 56 dp circle scales from 0.6 to 1 and fades in (one Animated.Value), and the `Confirm` haptic fires.
  2. A stepper value change gives a light tick haptic and the number crossfades over 100 ms.
  3. The sync icon rotates while syncing, using one looped native-driver animation.
  4. Skeleton shimmer is replaced by a **pulse** (opacity 0.5↔1, 900 ms), driven by **one shared Animated.Value** for all skeleton blocks.
  5. Toasts slide 16 dp up and fade in.
- Respect `AccessibilityInfo.isReduceMotionEnabled()`. When it is on, cut durations to 0 and turn off the pulse.

### 2.8 Haptics (`expo-haptics`)

On Android use `Haptics.performAndroidHapticsAsync(AndroidHaptics.X)`. It uses the system haptic engine and needs no VIBRATE permission. Android guidance is "clear, not buzzy", using predefined effects and taking frequency into account.

| Event | Effect |
|---|---|
| Document posted, request submitted, approved | `Confirm` |
| Validation blocked submit, sync failure surfaced | `Reject` |
| Stepper +/- and quick-add chip | `Keyboard_Tap` (or a segment tick, if the v58 enum has one; check the enum names in the v58 docs) |
| Toggle (favourite star, inspection pass/fail) | `Toggle_On` / `Toggle_Off` |
| Long-press start (e.g. drag-to-reorder lines) | `Gesture_Start` |

- No haptics on scroll, navigation or plain taps. Add a setting "Vibration feedback: on/off", default on.
- Call haptics fire-and-forget (`void Haptics...`), never awaited before navigation.

---

## 3. Component specs

All components live in `src/components/ui/` (one file per component, re-exported from `index.ts`), read tokens through `useTheme()`, and accept `testID` and `accessibilityLabel`.

### 3.1 Button

| Variant | Fill / text | Use |
|---|---|---|
| `primary` | primary / onPrimary | The main action of a screen (one per screen) |
| `hero` | accent / onAccent + 1.5 dp accentStrong border (light) | The single most important *creation* action: Receive, New request, Post GRN |
| `tonal` | primaryContainer / onPrimaryContainer | Secondary actions (Add line, Take photo) |
| `outline` | transparent, 1.5 dp borderStrong / primary text | Tertiary (Save draft) |
| `ghost` | transparent / primary text | Low emphasis (Clear, Cancel) |
| `danger` | danger / onDanger | Reject, Reverse, Discard |
| `dangerOutline` | transparent, danger border and text | Remove line |

- Sizes: `lg` 56 dp (default), `md` 48 dp, `sm` 40 dp (*visual*; pad the hit area to 48). Horizontal padding is 20. Icon 20 dp with a gap of 8. Text uses `button`.
- `block` makes it full width. Default is not to grow; the current `flexGrow: 1` default causes uneven rows.
- States: disabled means `surfaceMuted` fill and `textDisabled` text, with no opacity trick. Busy replaces the label with a spinner and keeps the width (store the measured width). Pressed uses the native ripple.
- Ensure `accessibilityRole="button"` and `accessibilityState={{ disabled, busy }}`.

### 3.2 Action tile (Home quick actions)

```
┌──────────────────────┐   88–104 dp tall, 2-column grid, gap 12
│ [◉ 32dp icon]        │   icon in a 48 dp circle of the tone's container
│ Receive              │   titleSm 17/600
│ 3 deliveries due     │   caption, textMuted (optional live hint)
└──────────────────────┘   surface, radius 16, level 1; badge top-right if count > 0
```
- The hero tile (the first one) can span 2 columns with an accent fill: "⬇ Receive delivery". Only one hero per dashboard.
- Show at most 6 tiles. Anything else goes in "More actions", a bottom sheet list.

### 3.3 Card and KPI tile

- **Card:** surface, radius 12, padding 16, 1 dp border (level 0) or level 1 if tappable. An optional 4 dp **left stripe** in the status tone. Header row is title (titleSm) plus a trailing chip or chevron.
- **KPI tile:** `display` number (tabular), a label underneath (label, textMuted), and a sub-line (caption) such as "Oldest 2 d". Tone shows as a 4 dp top bar or the number colour only when it is **danger or warning, with an icon**. **A zero count reads success-muted ("0 · all clear"), not red.** Tap drills down. Keep minHeight 96 and the 2-column grid. On Home show **4 KPIs max**; put the rest in a horizontal "More stats" row.

### 3.4 List row (FlashList item)

```
┌───────────────────────────────────────────────────┐ 64 dp (1 line meta) / 72 dp (2 lines)
│ [icon40] MR-BOLE-0142            [Approved chip]  │ titleSm + chip
│          Block A · 3 lines · needed Thu 31 Oct  › │ bodySm textMuted
└───────────────────────────────────────────────────┘ 1 dp divider inset 72
```
- Stock row variant: material label (titleSm, 1 line, ellipsis), store and category (bodySm), and the **quantity right-aligned at 20/700 tabular plus the unit in caption**. A low-stock row gets a danger chip "Low · reorder 50" and a danger left stripe. Avoid the current 2 dp red border round the whole card.
- Leading 40 dp icon circle for the doc type (GRN `truck-delivery-outline`, MIV `package-variant-closed-remove`... pick from §2.6 list).
- A pending-sync record shows a small `cloud-upload-outline` 16 dp icon in warning next to the title, not a full chip, to keep rows calm.
- No swipe actions; they are hard to find and error-prone with gloves. Use explicit buttons on the detail screen.

### 3.5 Status chip

- 28 dp tall (non-interactive), pill, horizontal padding 10, 16 dp icon, `label` 13/600, sentence case, container background with on-container text (§1.6).
- **Filter chip** (interactive): 40 dp visual / 48 dp hit area. Unselected is `surfaceMuted` with `text`. Selected is `primaryContainer` with `onPrimaryContainer` and a leading `check` icon. Count suffix: "Low stock · 4".

### 3.6 Search-select bottom sheet (replaces `Picker`)

Implement it in-house on RN `Modal` (`animationType="slide"`, `statusBarTranslucent`, `navigationBarTranslucent`) styled as a 90 % height sheet. Reasons: keyboard handling must be solid, and `@expo/ui`'s community BottomSheet ignores keyboard and footer props, while `@gorhom/bottom-sheet` would add Reanimated and Gesture Handler (§7).

```
┌──────────── handle ───────────────┐
│ Material / grade             [✕]  │ title
│ [🔍 Search material, grade, code] │ 56 dp, autoFocus ONLY when list > 12 items
│ (All) (Cement) (Rebar) (Aggregate)│ category filter chips, horizontal scroll
├───────────────────────────────────┤
│ ★ FAVOURITES                      │ section header (caption, textMuted)
│ ☆→★ Rebar Ø12 Gr 60     ton   ✓   │ row 56 dp; star toggles favourite (48 dp target)
│ RECENT                            │
│ Cement OPC 42.5R        bag       │
│ ALL (A–Z)                         │
│ ...                               │ FlashList, getItemType = header|row
├───────────────────────────────────┤
│ [ Clear ]            [ Done ]     │ only for multi-select
└───────────────────────────────────┘
```
- **Sections:** Favourites (user-starred, saved in `kv` `fav:<key>`), Recent (last 8, as now), then All. While the user is searching, sections collapse into one list ranked by: prefix match on code, then prefix on label words, then substring.
- **Search keys** are computed once per options array: `key = normalize(label + ' ' + sub + ' ' + code)`. Normalising means lowercase, dropping diacritics, and mapping `Ø`→`d`/`dia`, so "d12", "12mm" and "ø12" all match. Filter with `useDeferredValue(q)`; do not slice to 300.
- **Smart default:** when the picker is opened with exactly one favourite or recent, highlight it. The empty search state shows a "No match for 'xyz'" empty state with an action: "Request new material code" (logged for an admin).
- A single tap selects and closes, firing a haptic tick. Show the selected row with a `check` icon in primary.
- Variants: `SpecPicker` (category chips), `ElementPicker` (level filter chips plus "elements active this week" as a recents section), `PersonPicker` (role chips), `SupplierPicker`, `MrPicker` (cards with status and date).
- The field that opens the sheet is 56 dp, shows the selected label (body) and sub (bodySm), has a trailing `chevron-down`, and uses error styling from Form field.

### 3.7 Quantity stepper with quick-add

```
 Quantity (bag)                              Stock 340 bag
┌──────┬───────────────────────────┬──────┐
│  −   │          120              │  +   │   56 dp tall; ± buttons 56×56; value display 32/800 tabular
└──────┴───────────────────────────┴──────┘   tapping value → numeric keypad (decimal-pad), select-all on focus
 (+1) (+5) (+10) (+50)  (Fill: 150 approved)   quick chips 40/48 dp; last chip = smart fill
```
- The step size comes from the material's UoM: bags, pcs and rolls step by 1; tons step by 0.1 (chips +0.5, +1, +5); m³ steps by 0.5. Make this configurable per spec (`step`, `quick[]`).
- Long-press on ± auto-repeats with acceleration (after 400 ms, every 80 ms, then ×10 after 2 s).
- **Smart fill chip:** "Approved 150" (issue), "Outstanding 80" (receive), "BoQ balance 42" (request), "System 120" (count).
- Validation is inline under the control: "Exceeds stock (340)" in danger with an icon. A soft warning in warning tone does not block.
- Alt-unit toggle: a segmented control beside the label `[bag | ton]` with a converted hint below ("= 6.0 ton").
- Accessibility: `accessibilityRole="adjustable"` with `accessibilityActions` increment and decrement and `accessibilityValue={{ text: '120 bags' }}`.

### 3.8 Segmented control

2–4 options, 48 dp tall, the whole row framed in `surfaceMuted`. The selected segment is `surface` with level 1 and `text` in 600; others are textMuted. Use it for Inspection (Pass / Conditional / Reject: the selected one takes its semantic container colour), Priority, Unit, and filter modes on lists. More than 4 options means filter chips instead.

### 3.9 Form field

- The label sits above the input (label 15/600, `text`, not muted, so it is readable outdoors). Optional fields say "(optional)" in textMuted. Required fields are **not** marked with an asterisk; optional ones are labelled instead, because most fields are required.
- Input: 56 dp, radius 12, 1.5 dp `borderStrong`. On focus the border is 2 dp `primary`. Error state is a 2 dp `danger` border with an icon and message below in danger (bodySm). Helper text in bodySm textMuted.
- Keyboard rules: `keyboardType="decimal-pad"` for quantities, `autoCapitalize="characters"` for plates and delivery-note numbers, `returnKeyType="next"` chained with refs, `submitBehavior="submit"` on the last field.
- Free text is a last resort. Prefer chips for common reasons (e.g. reject reasons: "Wrong grade", "Damaged", "Short delivery", "Other…"); "Other" reveals a text field.

### 3.10 Sticky bottom action bar

```
├───────────────────────────────────────────────┤ level 2, surfaceElevated, top border
│ 3 lines · 2 warnings          [ Submit ▸ ]     │ 72 dp + bottom safe-area inset
│ [ Save draft ]                                 │ optional secondary (outline) to the left
└───────────────────────────────────────────────┘
```
- Every create or post flow has one. The primary action is always in the bottom-right thumb zone. It stays above the keyboard: use `KeyboardAvoidingView behavior="height"` on Android, or check that `softwareKeyboardLayoutMode: "resize"` is set in app.json.
- The left side shows a live summary ("3 lines · 2 warnings", "Total 6.0 t").
- **The primary action is never disabled without explanation.** Tapping it while incomplete scrolls to the first error, flashes the field and fires the `Reject` haptic.

### 3.11 Offline / sync banner and header pill

- **Header sync pill** (replaces the text "●/Offline/Sync !"). 32 dp visual / 48 dp hit area. Icon only when synced. Icon plus count when pending ("⬆ 3"). Danger icon when failed. Tap opens Sync status.
- **Offline band:** a 36 dp strip directly under the header in `offlineBand` with `cloud-off-outline` and the text "Offline · 3 changes saved on this phone". It is shown **only** when offline or when something has failed. When online and in sync, nothing is shown. It slides in and out over 150 ms.
- **Failure banner** on affected records and on Home: dangerContainer, title "1 document was rejected by the server", reason, actions [Fix] [Discard]. Keep the existing `SyncError` copy and behaviour, restyled.
- **Optimistic UI:** after Submit or Post, navigate straight to the detail screen with the "Saved on phone · will sync" chip, as `enqueue()` does today. Never block on the network, and never show a spinner for local writes.
- **Conflict copy:** explain it in plain words and offer one action. Example: "Stock changed since you started: only 40 bags are now available (another issue was posted). [Adjust to 40] [Discard]."

### 3.12 Toast / snackbar

Bottom, above the action bar or tab bar, 16 dp margins, radius 12, `text` on `surfaceElevated` (inverse: `#111827` background with white text in light mode). Single line plus an optional action ("Undo", "View"). Lasts 4 s, or 6 s with an action. Variants carry a leading icon (success, danger). Only one is shown at a time; new ones replace old. Use it for non-blocking confirmations ("Added to favourites", "Line removed · Undo"). Keep `Alert.alert` only for destructive confirmations and hard errors.

### 3.13 Empty states

48 dp top padding, a 64 dp tonal icon circle, a title (title, 1 line), body (1–2 sentences, textMuted), and **one** action button when there is a clear next step.
- Requests (site engineer): `clipboard-text-outline` · "No requests yet" · "Raise a request for materials you need on site." · [New request]
- Approvals: `check-all` · "All caught up" · "Nothing is waiting for your approval." (no button; positive tone)
- Stock, offline and empty: `cloud-off-outline` · "No stock data on this phone yet" · "Connect to the internet once to download stock." · [Sync now]
- Search with no results: "No match for 'ø16'" · [Clear search] [Request new code]

### 3.14 Skeletons

Use them only for first-ever loads (before the first sync) and for remote images. Local SQLite reads are synchronous and fast, so render real content and **never show a skeleton for local data**, since that adds perceived delay. Skeleton blocks copy the final layout (row height, KPI tile shapes) in `surfaceMuted`, driven by one shared native-driver pulse. Spinners are only for waits of 1–10 s with unknown shape (e.g. "Downloading your projects…"), with explanatory text.

### 3.15 Photo capture strip

```
 Delivery note & photos (1 required)
 ┌────┐ ┌────┐ ┌────┐ ┌ ─ ─ ┐
 │img │ │img │ │img⬆│  ＋   │   80 dp square thumbs, radius 8; last cell = "Add" (camera)
 └────┘ └────┘ └────┘ └ ─ ─ ┘   queued: small cloud-upload badge; failed: danger badge
 [📷 Camera]  [🖼 Gallery]        or tap the add cell → camera directly; gallery via long-press/menu
```
- Opening the camera is **one tap**. The required count is shown in the label and validated by the action bar.
- Thumbnails come from a **320 px JPEG thumbnail generated at capture** with `expo-image-manipulator`, which is already a dependency. Display with `expo-image` (`cachePolicy="memory-disk"`, `recyclingKey={id}`, `transition={100}`). Never render the full-size file in a list.
- Tap a thumbnail for a full-screen viewer with Delete and Retake.
- Location chip "📍 Geotagged" appears when available.

### 3.16 Signature pad

- Opens as a **full-screen sheet**. Suggest landscape with the hint "Turn phone sideways for more space" (do not force it). The canvas is white in both themes, with a black 3 dp stroke, a baseline guide and an "✕" sign-here marker. Buttons [Clear] [Done] are 56 dp.
- Inline it shows a 120 dp preview of the captured signature, the signer's name field (prefilled with the driver or receiver name), and [Re-sign].
- Performance: committed paths go in a memoised `<Committed paths={...}/>`. Only the live path re-renders, and `setLive` is throttled with `requestAnimationFrame`. Skip points less than 1.5 px from the previous point.

### 3.17 Progress bar and ring

- **Bar:** 8 dp track (`surfaceMuted`), radius 4, fill `primary` (or `success` at 100 %). An optional **planned marker**, a 2 dp tick in `text` at the planned %, shows ahead or behind at a glance. The label "62 %" sits to the right in label/tabular.
- **Ring** (Home and element detail): `react-native-svg` (already installed), 56 or 96 dp, 8 dp stroke, center text `display` or `title`. Static render only. If animating at all, animate one `strokeDashoffset` once on mount; skip it in lists.

### 3.18 App header

- Use the native-stack header with the `surface` background. The title is `title` (20/700). Up to 2 trailing 48 dp icon buttons: sync pill, bell with badge (danger dot plus a count up to 9+), and search on Home.
- On Home the title is the **project switcher**: "BOLE-RES ▾" opens a project sheet with recents.

---

## 4. Navigation & information architecture

### 4.1 Structure (expo-router)

```
src/app/
  _layout.tsx                 Gate (login/lock/project) → <Stack> (root)
  (tabs)/_layout.tsx          NativeTabs (role-filtered triggers)
  (tabs)/index.tsx            Home (role dashboard)
  (tabs)/requests/index.tsx   Requests list (filters by role)
  (tabs)/approvals.tsx        Approvals inbox (office/manager)
  (tabs)/stock.tsx            Stock
  (tabs)/progress/index.tsx   Elements/progress
  (tabs)/store.tsx            Store docs hub (store keeper)
  (tabs)/more.tsx             More: notifications, sync, documents, settings, theme, language, sign out
  requests/new.tsx, requests/[id].tsx, store/receive.tsx, ... (pushed on the root Stack, tab bar hidden)
  search.tsx                  Global search (modal presentation)
```
- **Use expo-router `NativeTabs`** (`import { NativeTabs } from 'expo-router/native-tabs'` in v58). It renders a real Material 3 navigation bar on Android: native, cheap, and with badges (`NativeTabs.Trigger.Badge`), `md` icon names, `indicatorColor` (set to `primaryContainer`) and `tintColor`. Hide tabs per role with `hidden={!roleHasTab}`. Changing `hidden` remounts the navigator, but the role is fixed per session, so this is fine. **Fallback:** if NativeTabs proves limiting (e.g. needing a custom center action), use expo-router JS `<Tabs>`. The design stays the same.
- Create and post flows push full-screen on the root stack (no tab bar), which gives the most room and means users can't accidentally leave a half-done GRN by switching tabs. Back with unsaved changes asks "Discard GRN? / Keep editing / Save draft". Request drafts autosave to `kv` every 5 s.

### 4.2 Tabs per role (3–5 destinations, per M3)

| Role | Tab 1 | Tab 2 | Tab 3 | Tab 4 | Tab 5 | Hero action (Home) |
|---|---|---|---|---|---|---|
| Store keeper | Home `home-variant` | **Issue queue** `package-variant-closed` (approved requests to issue, badge) | Stock `warehouse` | Docs `file-document-multiple-outline` | More | **Receive delivery** |
| Site engineer | Home | Requests `clipboard-list-outline` (mine; badge = returned) | Progress `chart-gantt` | Stock | More | **New request** |
| Office engineer | Home | Review `clipboard-check-outline` (badge) | Requests | Progress (verify badge) | More | Look-ahead request |
| Manager / PM | Home | **Approvals** `check-decagram-outline` (badge) | Requests | Progress | More | (none; Approvals is the job) |
| Procurement | Home | Requests (approved, to source) | Stock | More | n/a | n/a |

Rules:
- Badge counts are **action-required items for this user only**: requests to approve, items to issue, to acknowledge, returned to me.
- The tab bar shows labels (`labelVisibilityMode="labeled"`), because icon-only bars fail with varied literacy.
- There is no centre FAB in the tab bar. The **hero action is the first full-width tile on Home**, plus an extended FAB ("＋ New request") on the role's main list screen. The FAB is amber with a navy-dark label, 56 dp, bottom-right 16 dp above the tab bar, and shrinks to icon-only while scrolling down.

### 4.3 Home dashboard layout (all roles)

```
┌─────────────────────────────────────────┐
│ BOLE-RES ▾                 [⇅3] [🔔2] [🔍]│ header: project switcher, sync pill, bell, search
├─────────────────────────────────────────┤
│ ▓ Offline · 3 changes saved on phone    │ only when relevant
│ Good morning, Abebe · Store keeper      │ bodySm muted
│ ┌─────────────────────────────────────┐ │
│ │ ⬇  Receive delivery          (hero) │ │ accent, 72 dp, full width
│ └─────────────────────────────────────┘ │
│ NEEDS YOU                               │ "Needs you" = action list, max 3 rows + "See all"
│ ▌MR-0142 · approved · issue 3 lines  ›  │ each row deep-links to the exact task
│ ▌MIV-0087 · awaiting your sign-off    ›  │
│ ▌GRN-0033 · sync failed · fix         ›  │
│ TODAY                                   │
│ [Awaiting issue 5] [Low stock 4]        │ 4 KPI tiles, 2×2
│ [Due/overdue 2]    [Transfers in 1]     │
│ QUICK ACTIONS                           │
│ [Issue] [Return] [Count]                │ 3-col compact tiles 88 dp (icon+label)
│ [Wastage] [Transfer] [More…]            │
│ Last synced 4 min ago                   │ caption
└─────────────────────────────────────────┘
```
- **"Needs you" goes first.** It is the inbox of concrete tasks, built from the same queries as the KPIs. When it is empty: "Nothing waiting for you ✓".
- Home must render from SQLite in < 1 s. Compute KPI counts with SQL `COUNT(*)` queries, not `list()` plus JS filtering (see §6).

### 4.4 Approvals and notifications

- **Approvals inbox** (tab): cards sorted oldest first, with an age chip ("Waiting 2 d", warning after 24 h, danger after 48 h), the requester, block, line count, and **flags** (Over BoQ, Urgent, Lead-time risk). Tap opens the detail with a sticky bar [Return] [Reject] [Approve ▸].
- **Notifications** are the stream; Approvals is the to-do list. The bell opens the notifications screen with tabs "For me" and "All". Each item has a type icon, a one-line sentence, relative time and an unread dot. Tapping marks it read and deep-links.
- **Push:** a notification tap deep-links into the exact screen (`sitematerials://requests/<id>`). Group push by type ("3 requests waiting for approval").
- Approvals and Review tab badges update from the local DB after each sync.

### 4.5 Global search

The 🔍 on the Home header opens `search.tsx` as a modal. A single input searches local SQLite across document numbers (MR, GRN, MIV, ...; a typed "0142" matches `MR-BOLE-0142`), materials (opens the bin card), elements (opens progress) and people. Results are grouped by type, 5 per group, with "See all". Recent searches are shown before typing. Later, a scan icon in the input will open the QR scanner (FR-ST-11, Phase 3, `expo-camera`).

---

## 5. Screen-by-screen guidance

### 5.1 New material request: target < 90 s for a standard 2–3 line request

**Strategy: one screen, progressive disclosure, lines edited in a sheet.** A wizard adds taps and transitions that cost time for experienced daily users, and the evidence for wizards is about completion rates on *long one-off* forms, not repeat entry. The current form shows ~10 header fields plus ~10 per line. The new form shows only what is needed and defaults the rest.

```
┌ New request ─────────────────── ✕ ┐
│ ┌───────────────────────────────┐ │ HEADER SUMMARY CARD (collapsed by default)
│ │ Block A · Main store          │ │ defaults: last block used; project main store;
│ │ Needed Thu 31 Oct · Normal  ✎ │ │ required = tomorrow (or + lead time); priority Normal
│ └───────────────────────────────┘ │ tap ✎ → expands inline: Block, Date chips, Priority segmented,
│                                   │ Deliver to, Drawing ref (optional), Purpose (optional)
│ Needed: (Today)(Tomorrow)(Thu)(📅)│ date quick-chips visible when expanded
│                                   │
│ MATERIALS                         │
│ ┌───────────────────────────────┐ │ LINE CARD (compact, 72 dp)
│ │ Cement OPC 42.5R    120 bag   │ │ title + qty (tabular, right)
│ │ → C-12 (L2) · BoQ bal 140 ✓   │ │ element + live BoQ check (success/danger chip)
│ └───────────────────────────────┘ │ tap → line sheet
│ ┌───────────────────────────────┐ │
│ │ Rebar Ø12 Gr60      2.4 t   ⚠ │ │ warning: "Over BoQ by 0.3 t · reason needed"
│ └───────────────────────────────┘ │
│ [＋ Add material]  [⧉ From element]│ tonal buttons; "From element" = pour template (FR-MR-08)
│                                   │
├───────────────────────────────────┤
│ 2 lines · 1 needs attention       │ STICKY BAR
│ [Save draft]      [Submit ▸]      │
└───────────────────────────────────┘
```

**Line sheet**, opened by "Add material" (picker first, then the sheet):
```
┌ Rebar Ø12 Gr 60 (ton) ─────── ✕ ┐
│ Stock on site 1.2 t · BoQ bal 2.1 t│ info well (surfaceMuted)
│ [ −  ][     2.4      ][  + ]       │ stepper
│ (+0.5)(+1)(+5)(Fill BoQ 2.1)       │ quick chips
│ Unit [ton | bar 12 m]              │ segmented (only if conversions exist)
│ Element  [C-12 (L2)        ▾]      │ defaults to last element used on this request
│ ⚠ Over BoQ by 0.3 t                │
│ Reason (Wastage)(Design change)(Other…)│ chips → minimal typing
│ + Split across elements · + Remarks│ links (progressive)
│ [Remove]          [Save line ▸]    │
└────────────────────────────────────┘
```
- **"From element"** (pour template) is the fastest path: pick element C-12 → all remaining take-off lines are pre-filled → adjust quantities → Submit. That is about 30 s.
- **Clone** stays on the request detail ("Request again").
- Per-line required date is hidden behind "+ Different date".
- Validation is inline per line (card chip) and the bar summarises it. Nothing pops up until Submit.
- Time budget: open (1 s) → header defaults OK (0 s) → Add material, search "cem", tap (6 s) → quantity chip +50 ×2 +10 ×2 (4 s) → element recent tap (2 s) → Save line (1 s) → second line (~15 s) → Submit (1 s). About 30–40 s.

### 5.2 Receive delivery (GRN): target < 2 min

```
Step A ── "What's arriving?" (first screen)
┌ Receive delivery ──────────────── ✕ ┐
│ [🔍 Search request / supplier]      │
│ EXPECTED (approved, not fully received)
│ ┌─────────────────────────────────┐ │ cards: MR no., supplier (if known), lines summary,
│ │ MR-0142 · Dangote · 3 items     │ │ required date chip; tap = prefill everything
│ │ Needed today                    │ │
│ └─────────────────────────────────┘ │
│ [ ＋ Delivery without a request ]   │ outline button (ad-hoc)
└─────────────────────────────────────┘

Step B ── Receipt form (single screen)
┌ GRN · MR-0142 ─────────────────── ✕ ┐
│ Supplier  Dangote Cement      ▾     │ prefilled from MR / recent supplier
│ Delivery note no. [DN-_______]  📷  │ camera icon = photo of DN (counts as required photo)
│ Plate [AA-3-12345]  Driver [_____]  │ plate: characters keyboard; recents dropdown
│ ITEMS                               │
│ ┌─────────────────────────────────┐ │
│ │ Cement OPC 42.5R   ordered 400  │ │
│ │ Received [ 400 ] bag  ✓ Pass    │ │ DEFAULT received = outstanding; inspection = Pass
│ │ [All OK] [Short] [Damaged] [Reject]│ │ one tap; Short/Damaged reveal stepper for qty
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ Rebar Ø12 Gr60   ordered 2.4 t  │ │
│ │ ⚠ Short 0.4 t  (received 2.0)   │ │ exception summary in warning
│ └─────────────────────────────────┘ │
│ PHOTOS (1 required)  [▣][▣][＋]     │ strip
│ SIGNATURE  [ Driver signs here → ]  │ opens full-screen pad; name prefilled from Driver
│ Remarks (optional)                  │
├─────────────────────────────────────┤
│ 2 items · 1 exception   [Post GRN ▸]│ hero (accent) variant
└─────────────────────────────────────┘
```
- **The default path is "everything arrived OK."** The user only touches exceptions. Inspection notes, batch number and certificates go under "+ Inspection details" per line, and open automatically when Conditional or Reject is chosen.
- Wrong-grade detection stays: a danger inline chip "Different grade from request: will be flagged".
- After posting, a success screen with a tick shows "GRN-BOLE-0033 saved on phone" and [Share PDF] [Receive another] [Done]. Haptic `Confirm`.
- Budget: pick MR (5 s), DN photo (15 s), plate (8 s), all lines OK (3 s), signature (20 s), Post (2 s). About 55–70 s.

### 5.3 Issue materials (MIV)

```
┌ Issue · MR-0142 ───────────────── ✕ ┐
│ To  Abebe K. (Site eng.)       ▾    │ defaults to requester; recents
│ For element C-12 (L2)               │ from MR (read-only chip)
│ ┌─────────────────────────────────┐ │
│ │ Cement OPC 42.5R                │ │
│ │ Approved 120 · issued 0 · stock 340│ │ caption
│ │ [ − ][ 120 ][ + ]  (Fill 120)   │ │ default = min(remaining, available)
│ └─────────────────────────────────┘ │
│ Receiver sign-off: (On phone now)(Later in app)│ segmented: sign here vs pending_ack
├─────────────────────────────────────┤
│ 1 item · 120 bag        [Issue ▸]   │
└─────────────────────────────────────┘
```
- The entry point is the store keeper's **Issue queue** tab (approved and part-issued, oldest required first). A row tap goes straight into this form.
- Over-issue and grade guards appear as inline danger chips. The Issue button explains what is blocking it.
- Emergency issue (no MR) is a separate entry under More actions with a mandatory reason chip, and shows an "Emergency · regularise within 24 h" banner.

### 5.4 Progress update

```
┌ C-12 Column · Level 2 ──────────── ✕ ┐
│ ◯ 62%  planned 70% · Behind 8%       │ ring + planned marker; danger/warn chip if behind
│ ACTIVITIES (template)                │
│ ☑ Rebar fixed        ☑ Formwork      │ 56 dp checkbox rows; tick = weighted %
│ ☐ Inspection (hold point) ⛔          │ hold point needs verifier — shows lock
│ ☐ Pour concrete                      │
│ Overall %  (25)(50)(75)(100) [ 62 ±5]│ chips + stepper (step 5)
│ PHOTOS (1 required) [▣][＋]          │
│ Issue on site? (None)(Weather)(Materials)(Labour)(Other…)│ delay reason chips
│ Note (optional)                      │
├──────────────────────────────────────┤
│ 62% → 75%              [Report ▸]    │
└──────────────────────────────────────┘
```
- The entry point is the Progress tab, filtered to "Active this week" (default), with a level filter. Each row shows the element code, type, a progress bar with planned marker, and a "Not updated 5 d" warning.
- **Photo-first option:** pressing the camera icon on a row opens the camera; after the shot the user lands on this screen with the photo attached.

### 5.5 Stock list

```
┌ Stock ───────────────────────────────┐
│ [🔍 Search material]           [⇅]   │ sticky; ⇅ = sort (Low first / A–Z / Recently moved)
│ (All)(Low · 4)(Quarantine · 1)(Main store ▾)│ filter chips
├──────────────────────────────────────┤
│ ▌Cement OPC 42.5R               340  │ 64 dp rows; qty 20/700 right, unit caption
│  Main store · Cement            bag  │
│ ▌Rebar Ø12 Gr60  [Low]          1.2  │ danger stripe + chip "Low · reorder 3"
│  Main store · Steel               t  │
│ ...                                  │ FlashList
├──────────────────────────────────────┤
│ [Share stock report (PDF)]           │ footer
└──────────────────────────────────────┘
```
- Row tap opens the bin card. Bin card header: big available number, a quarantine line, a reorder line, then a movement list (FlashList, `+`/`−` coloured with icons, not colour only).
- A long list should still scroll at 60 fps on a 2 GB device.

### 5.6 Approvals detail

```
┌ MR-0142 · Abebe K. ── Waiting 2 d ─┐
│ Block A · Needed Thu 31 Oct · Urgent│
│ ┌─────────────────────────────────┐ │
│ │ Cement OPC 42.5R    120 bag     │ │
│ │ BoQ ███████░░ 120 / 140 ✓       │ │ mini bar: requested vs balance
│ │ Stock 340 · Lead 2 d ✓          │ │
│ │ Approve qty [ − ][120][ + ]     │ │ editable (part-approve)
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ Rebar Ø12 Gr60  2.4 t  ⚠ Over BoQ│ │ reason shown: "Design change (S-201 Rev C)"
│ └─────────────────────────────────┘ │
│ History ▸ (versions, comments)      │
├─────────────────────────────────────┤
│ [Return] [Reject]      [Approve ▸]  │ return/reject open reason-chip sheet
└─────────────────────────────────────┘
```
- Flags are shown first. Lines without issues show a single success tick so the approver can skim.
- Approve fires `Confirm`, shows a toast "Approved · next request ▸", and **auto-advances to the next item in the inbox**. Approvers move through the queue without going back to the list.

---

## 6. Performance checklist (low-end Android, 2 GB RAM; screens open < 2 s)

**Measure first.** Profile **release** builds (`eas build --profile preview`) on one real low-end device (e.g. Snapdragon 4xx/Helio G-series, 2 GB) kept as the reference phone. Debug builds are not representative. Track cold start to first Home render and screen push times in a simple `perf` log.

Startup
1. Hermes is the default; leave it on. Don't add JSC.
2. Keep the splash screen until `ready` (SQLite open plus session restore). **Start the network sync after the first Home frame** (`requestAnimationFrame`, then `setTimeout(sync, 0)`), not before.
3. Embed fonts and icon fonts at build time (config plugins), with no `useFonts` on the critical path.
4. Lazy-import heavy modules used on one screen (`expo-print`, `SignaturePad`, `expo-image-manipulator`) with `await import()` inside the handler, or check that Metro `inlineRequires` is active.
5. Turn on R8/minify and resource shrinking for release through `expo-build-properties` (check v58 prop names). Ship an AAB or ABI-split APKs, not a universal APK, to keep installs small.

Rendering
6. **Turn on the React Compiler**: `"experiments": { "reactCompiler": true }` in app.json. It is Babel-configured automatically since SDK 54; confirm in v58 docs, and lint with `eslint-config-expo`. It auto-memoises components and callbacks. Still follow 7–10 for lists.
7. List rows are `memo` components with **primitive props** (`id`, `label`, `qty`, `status`), not whole records or inline closures. Pass `onPressRow(id)` as one stable callback.
8. **No inline style objects in rows.** Use `StyleSheet.create` via `makeStyles(theme)`, cached per theme.
9. The theme context value is a module constant per mode, so a theme change re-renders once and nothing else does.
10. `useData` / `useDataVersion`: the current design re-runs every subscribed query on **any** data change. Scope versions per table (`useDataVersion('mivs')`) so a photo-upload status change doesn't recompute the dashboard. Keep each synchronous query under ~8 ms. Replace `list()` plus JS `.filter().length` on Home with SQL `COUNT(*)` / `GROUP BY` (one query per KPI). Add indexes on `(project_id, status)`.
11. Never block a press with work. Navigate first and let the next screen do its own reads. Defer non-visible sections with `useDeferredValue` or `startTransition`.

Lists
12. **Use `@shopify/flash-list` v2** for every list that can exceed ~30 rows: stock, picker, requests, docs, notifications, bin card, approvals. v2 needs no `estimatedItemSize`. Use `getItemType` for sectioned lists (header vs row).
13. With FlashList: no `key` prop on the row root, no `useState` in rows (use `useRecyclingState` when needed), and use `useMappingHelper` for `.map()` inside rows. Rows must render purely from props because cells are recycled.
14. Short lists (< 30) can stay as `.map` in a ScrollView. Don't virtualise tiny lists.
15. The picker search uses precomputed normalised keys and `useDeferredValue`. Don't recompute `toLowerCase()` across all options per keystroke.

Images & media
16. Use **`expo-image`** everywhere (`cachePolicy="memory-disk"`, `recyclingKey`). Render **thumbnails only** in lists and strips (320 px JPEG at quality 0.6, made at capture), and the full image only in the viewer.
17. Resize uploads at capture (e.g. a 1600 px long edge, JPEG 0.7; this probably already happens in `lib/photos.ts`, so keep it) to save bandwidth on poor links.
18. Signature: memoise committed paths, throttle live updates to rAF, drop points closer than 1.5 px.

Animation
19. Use the core `Animated` API with `useNativeDriver: true`, on opacity and transform only. No layout animations, no animated shadows. Keep a budget of ≤ 10 simultaneously animated views; Reanimated's own guidance is ~100 animated components max on low-end Android, and we stay far below it.
20. Use the native ripple for press feedback. No JS-driven press animations in lists.

Memory & data
21. Don't keep large arrays in React state or context (e.g. all specs). Read them through query functions memoised per data version.
22. Cap FlashList `drawDistance` at the default; don't raise it to "fix" blanking.
23. Unmount the camera immediately after capture. Photo uploads run in the background queue, one at a time on 2G/3G.

---

## 7. Recommended libraries (Expo SDK 58)

Install everything with `npx expo install <pkg>` so SDK-matched versions resolve.

| Library | Decision | Why / tradeoffs |
|---|---|---|
| `@shopify/flash-list` (v2.x, currently 2.3.x) | **Add** | Recycling list for the New Architecture (required by SDK 55+). JS-only in v2, no native config. Drop-in for FlatList. Caveat: rows must be pure and recycling-safe (§6.13). |
| `expo-haptics` | **Add** | Tiny. `performAndroidHapticsAsync` uses the system haptics engine without the VIBRATE permission. |
| `expo-image` | **Add** | Disk and memory cache, recycling keys, transitions. Better memory release than RN `Image`. Caveat: profile initial decode spikes, which is why thumbnails are mandatory. |
| `@react-native-vector-icons/material-design-icons` (+ `expo-font`) | **Add** | Font icons, the official successor to `@expo/vector-icons` (which is being deprecated). Use the `/static` import and config plugin. Remove any `@expo/vector-icons` use. |
| `@expo-google-fonts/noto-sans-ethiopic` (v0.4.x) | **Add with the Amharic UI (Phase 3)** | Embed it with the expo-font config plugin. Until then, rely on Android's system Noto Sans Ethiopic fallback. |
| `expo-router` `NativeTabs` | **Use (already installed)** | Native M3 navigation bar, badges, per-role `hidden`. Fallback is JS `Tabs`. |
| `react-native-svg` | **Keep** | Signature pad, progress ring. |
| `expo-image-manipulator` | **Keep** | Generate thumbnails at capture. |
| `expo-build-properties` | **Add** | R8, minify and resource shrinking for release. |
| `react-native-reanimated` 4 + `react-native-worklets` | **Do not add now** | It is the only way to get gesture-driven sheets and 120 fps shared transitions, but it adds native size, a Babel plugin and startup work, and recent 4.x patches fixed Android layout-animation leaks. Everything in this spec runs on core `Animated` with the native driver. Reconsider only if we need draggable sheets or swipe gestures. |
| `@gorhom/bottom-sheet` | **Do not add** | Needs Reanimated and Gesture Handler. Its docs target Reanimated 3, so compatibility with SDK 58's Reanimated 4 is unclear. Our sheets are modal and don't need snap gestures. |
| `@expo/ui` community `BottomSheet` | **Optional, evaluate later** | Jetpack Compose `ModalBottomSheet` on Android with a gorhom-compatible API and no Reanimated. But keyboard, footer and backdrop props are ignored, which breaks the search-select sheet (keyboard plus sticky footer). Fine for simple action sheets (e.g. "More actions"). |
| `expo-camera` | **Phase 3** | QR and barcode scanning (FR-ST-11) inside search and pickers. |
| `lucide-react-native` | **Rejected** | SVG per icon costs more in lists; fewer construction glyphs. |
| UI kits (React Native Paper, Tamagui, gluestack, NativeWind) | **Rejected** | Our ~20 components are simple. A kit adds bundle, theming indirection and re-render cost on 2 GB phones. Tokens plus our own primitives are faster and give a distinctive look. |

---

## 8. Accessibility & localisation checklist

- Targets ≥ 48 dp (default 56) with ≥ 8 dp gaps. Text contrast ≥ 7:1 for body text and ≥ 4.5:1 for everything else. UI boundaries ≥ 3:1 (`borderStrong`).
- Never use colour alone: every status has an icon and a word, and stock movements have a +/− sign.
- Every Pressable sets `accessibilityRole` and `accessibilityLabel` (in the current language) and `accessibilityState`. Steppers are `adjustable`.
- Support font scaling to 1.3× without clipping (test it). Sunlight mode adds weight and size.
- Focus order follows the visual order. After a validation error, focus and scroll to the first invalid field.
- Strings go through an i18n map from day one (`t('grn.post')`), even before Amharic exists. Avoid string concatenation, and make sure layouts tolerate ~30 % longer Amharic labels. Dates use `fmtDate` so an Ethiopian-calendar formatter can drop in later (Phase 3).
- Numbers are always Western digits (Ge'ez numerals aren't used for quantities).
- Plain language: "Saved on phone" instead of "Queued in outbox"; "Waiting for approval" instead of "Submitted".

---

## 9. Implementation order (suggested)

1. Tokens, ThemeProvider (mode setting), `makeStyles`, Text and Icon primitives, then replace emoji icons.
2. Button, Field, Chip, Segmented, Card, ListRow, StatusChip, sync pill and offline band, Toast, Empty.
3. Restructure into `(tabs)` with NativeTabs per role, plus Home "Needs you" with SQL counts.
4. Search-select sheet (favourites, sections, FlashList) and QuantityStepper.
5. Request flow (§5.1), then Receive (§5.2), Issue (§5.3), Approvals (§5.6), Progress (§5.4), Stock (§5.5).
6. Photo strip (expo-image, thumbnails), full-screen signature.
7. Performance pass on the reference device: React Compiler, FlashList everywhere, scoped data versions, R8. Time the flows against the 90 s / 2 min / 2 s targets with 3 real users.

---

## Sources

1. Google, Touch target size (Android Accessibility Help): https://support.google.com/accessibility/android/answer/7101858
2. Android Developers, Make apps more accessible: https://developer.android.com/guide/topics/ui/accessibility/apps
3. Android Developers, Layouts and navigation patterns: https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-and-nav-patterns
4. Android Developers, Compose Navigation bar: https://developer.android.com/develop/ui/compose/components/navigation-bar
5. Android Developers, Compose Material 3 Typography: https://developer.android.com/reference/kotlin/androidx/compose/material3/Typography
6. Material Design, Bottom navigation: https://material.io/components/bottom-navigation
7. Android Developers, Haptics design principles: https://developer.android.com/develop/ui/views/haptics/haptics-principles
8. SAP Fiori for Android, Accessibility (contrast modes, M3): https://www.sap.com/design-system/fiori-design-android/v26-4/foundations/accessibility
9. W3C / summaries of WCAG 2.2 (1.4.3, 1.4.11, 2.5.8): https://tetralogical.com/blog/2023/10/05/whats-new-wcag-2.2 · https://getwcag.com/blog/wcag-2-2-checklist
10. Expo, Moving away from @expo/vector-icons: https://expo.dev/blog/moving-away-from-expo-vector-icons
11. Expo docs, Icons guide: https://docs.expo.dev/guides/icons.md
12. react-native-vector-icons, Expo setup: https://github.com/oblador/react-native-vector-icons (docs/SETUP-EXPO.md)
13. Expo docs v58, Font (config plugin vs useFonts): https://docs.expo.dev/versions/v58.0.0/sdk/font.md
14. Expo docs v58, Router Native Tabs: https://docs.expo.dev/versions/v58.0.0/sdk/router/native-tabs.md
15. Expo docs, Expo UI BottomSheet drop-in: https://docs.expo.dev/versions/latest/sdk/ui/drop-in-replacements/bottomsheet.md
16. Expo docs, Haptics: https://docs.expo.dev/versions/latest/sdk/haptics.md
17. Expo docs, Image: https://docs.expo.dev/versions/v58.0.0/sdk/image/
18. Expo docs, Using Hermes: https://docs.expo.dev/guides/using-hermes
19. Expo docs, React Compiler: https://docs.expo.dev/guides/react-compiler
20. React blog, React Compiler v1.0: https://react.dev/blog/2025/10/07/react-compiler-1
21. Expo blog, What is the best React Native list component: https://expo.dev/blog/what-is-the-best-react-native-list-component
22. Shopify FlashList docs and v2 changes: https://shopify.github.io/flash-list/docs/ · https://shopify.github.io/flash-list/docs/v2-changes
23. React Native docs, Optimizing FlatList configuration: https://reactnative.dev/docs/optimizing-flatlist-configuration
24. Software Mansion, Reanimated performance guide: https://docs.swmansion.com/react-native-reanimated/docs/guides/performance
25. Software Mansion, Reanimated changelog (Android layout animation fixes): https://swmansion.com/changelog/react-native-reanimated/
26. gorhom/react-native-bottom-sheet: https://gorhom.dev/react-native-bottom-sheet/
27. Software Mansion, React Native image list deep dive (expo-image memory): https://swmansion.com/blog/react-native-image-list-recreating-apple-google-photos-in-react-native-part-1-7f73fb74fc63
28. Instamobile, Improve React Native performance on older Android: https://instamobile.io/blog/improve-react-native-performance-older-android/
29. Theodo, Measuring and improving RN startup time: https://apps.theodo.com/article/measuring-and-improving-react-native-apps-startup-time
30. Procore, Offline use of the mobile app: https://support.procore.com/faq/can-i-use-procores-mobile-application-offline
31. Procore design system, accessibility and typography (Inter): https://design.procore.com/accessibility · https://design.procore.com/typography
32. Fieldwire help, offline and sync: https://help.fieldwire.com/hc/en-us/articles/360043052832
33. Sitemate, Dashpivot mobile app (offline capture): https://sitemate.com/nz/software/dashpivot-mobile-app/
34. Raken reviews (field usability): https://www.g2.com/products/raken/reviews
35. ServiceTitan, Field Mobile App enhancements: https://help.servicetitan.com/release-hub/docs/improve-the-technician-experience-with-field-mobile-app-enhancements
36. Shopify POS UI extensions, Stepper: https://shopify.dev/docs/api/pos-ui-extensions/latest/components/stepper
37. JourneyApps, UI/UX tips for industrial environments: https://journeyapps.com/blog/ui-ux-tips-optimizing-apps-industrial-environments
38. Apario, On writing software for people who work outside: https://blog.apario.net/on-writing-software-for-people-who-work-outside
39. Dynamics Mobile / Cleverence, warehouse scanner UX: https://www.dynamicsmobile.com/insights/new-insight-12 · https://www.cleverence.com/articles/wms-warehouse-apps/10-warehouse-apps-with-simple-tablet-ui-6384
40. Scandit, Scanning at scale (UX director insights): https://www.scandit.com/blog/scanning-at-scale-ux-insights/
41. Expensify, Offline-first architecture: https://www.mintlify.com/Expensify/App/developers/architecture/offline-first
42. Display reflectance and sunlight contrast: https://jacksblog-1j5.pages.dev/en/posts/display-reflectance · https://www.lcd-module.com/displays/sunlight-readable-display.html
43. ANSI Z535 safety colours: https://jjkellercompliancenetwork.com/institute/ansi-safety-colors · https://en.wikipedia.org/wiki/Safety_orange
44. Android platform noto-fonts (NotoSansEthiopic shipped): https://android.googlesource.com/platform/external/noto-fonts/+/2536dca/notosansethiopic/
45. Fontsource, Noto Sans Ethiopic (weights 100–900): https://fontsource.org/fonts/noto-sans-ethiopic/about
46. NN/g, Recognition vs recall (heuristic 6): https://www.nngroup.com/videos/recognition-vs-recall/
47. Skeleton vs spinner studies (Viget summary and academic): https://virtuslab.com/blog/frontend/ux-patterns-beyond-raw-performance
48. Empty-state guidance: https://www.canva.dev/docs/apps/design-guidelines/empty-states · https://v4-archive.patternfly.org/v4/design-guidelines/usage-and-behavior/empty-state
49. Multi-step vs single forms: https://www.reform.app/blog/mobile-form-design-insights-studies · https://atticusli.com/blog/posts/the-form-chunking-illusion/
