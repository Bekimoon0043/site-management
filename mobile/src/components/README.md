# Mobile component library

Design: "Blueprint & Beacon" (`docs/research/mobile-design.md`). Navy primary (`#163A5F` light / `#8DB8EA` dark),
amber accent for the **one** hero action per screen, concrete neutrals. Three themes: light, dark, **sunlight**
(high contrast, 2 dp borders, +1 sp / bolder text). Users pick System / Light / Dark / Sunlight in Settings or More.

```ts
import { Button, Card, ListRow, Screen, ... } from '../components/ui';      // primitives
import { SpecPicker, ElementPicker, DateField, ... } from '../components/pickers'; // domain pickers
import { useTheme, makeStyles, space, radius, statusInfo } from '../theme';
```

## Rules (keep the app fast on 2 GB phones)

- No inline style objects in list rows: use `makeStyles((t) => ({...}))` (cached per theme) or `StyleSheet.create`.
- Lists that can exceed ~30 rows use `FlashList` (`@shopify/flash-list` v2, no `estimatedItemSize`) with **memoised rows
  taking primitive props** and one stable `onPress(id)` callback. No `key` on the row root, no `useState` in rows.
- Counts/aggregates come from SQL (`lib/counts.ts`: `dashboardCounts`, `countMr`, `mrRows`, `rowsWhere`, `stockBalancesSql`,
  `syncStatusMap`), not `list()` + JS `.filter().length`.
- Writes go through `enqueue(rpc, payload, info)` — never block on the network; navigate straight to the result and toast
  "… saved on phone".
- Icons: `<Icon name>` only (typed union in `ui/Icon.tsx`; add names there). No emoji / Unicode glyphs.
- Sentence case everywhere (no UPPERCASE). Meaning never by colour alone: chips carry an icon + words.
- Touch targets ≥ 48 dp (default 56). Animate only opacity/transform with `useNativeDriver`.
- Haptics: `haptic('confirm' | 'reject' | 'tick' | 'toggleOn' | 'toggleOff')` — fire-and-forget, respects the setting.

## Theme (`src/theme`)

| Export | Use |
|---|---|
| `useTheme()` | Current `Theme` (flat colour tokens + `borderWidth`, `shadow`, `dark`, `boost`) |
| `makeStyles(fn)` | `const useStyles = makeStyles((t) => ({ row: { backgroundColor: t.surface } }))` |
| `space` `size` `radius` `duration` | 4 dp grid (`space[4] = 16`), `size.touch/control/tile`, radii |
| `typeScale`, `typeFor(variant, t, ethiopic)` | Type tokens; Ethiopic gets ×1.15 line height, +1 sp, min 14 sp |
| `tone(t, 'success')` | `{ solid, onSolid, container, onContainer }` for any `Tone` |
| `statusInfo(status)`, `priorityInfo(p)`, `SYNC_INFO` | Status → `{ tone, icon, label }` (spec §1.6) |
| `setThemeMode`, `useUiPrefs`, `setHapticsEnabled` | Persisted UI preferences (kv `ui:theme`, `ui:haptics`) |

Tones: `neutral | primary | info | success | warning | danger | violet`.

## Components (`components/ui`)

| Component | Key props | Notes |
|---|---|---|
| `Text` | `variant` (display, headline, title, titleSm, body, bodySm, label, button, caption), `tone`, `num`, `align`, `weight` | Replaces T/H1/H2. `num` = tabular digits. `ScriptContext` switches Ethiopic. |
| `Icon` | `name`, `size` (24/20/28), `tone` or `color`, `accessibilityLabel` | MDI font, embedded at build time. |
| `Button` | `title`, `onPress`, `variant` (primary, hero, tonal, outline, ghost, danger, dangerOutline), `size` (lg 56 / md 48 / sm 40), `icon`, `iconRight`, `block`, `flex`, `busy`, `disabled` | `hero` = amber, one per screen. |
| `IconButton` | `icon`, `onPress`, `accessibilityLabel`, `badge`, `tone` | 48 dp target. |
| `Fab` + `fabScroll(setExt)` | `label`, `icon`, `extended` | Amber extended FAB on main list screens; memoise `fabScroll` with `useMemo`. |
| `Card` | `onPress`, `stripe` (Tone), `dense`, `flush`, `selected` | 4 dp left stripe in status tone. `flush` for lists of `ListRow`. |
| `Row` / `Col` / `Section` / `Divider` | `gap`, `justify`, `align`, `wrap`; Section: `title`, `action`, `onAction` | Section titles are sentence case. |
| `InfoRow` | `label`, `value`, `tone`, `icon`, `strong` | Label/value pair (old `KV`). |
| `Banner` | `tone`, `title`, `text`, `icon`, `actions[]` | Inline notices / failure banners. |
| `Chip`, `StatusChip`, `PriorityChip` | `label`, `tone`, `icon`, `small`; `status`; `priority` | Non-interactive tonal chips. `PriorityChip` renders nothing for normal. |
| `FilterChip`, `ChipGroup` | `options[{value,label,count,icon,tone}]`, `value`, `onChange`, `scroll`, `label` | Single-select chips (old `Chips`). Use for >4 options. |
| `Segmented` | `options` (2–4), `value`, `onChange`, `label` | Option `tone` colours the selected segment (Pass/Conditional/Reject). |
| `Field` | TextInput props + `label`, `name`, `error`, `warning`, `hint`, `optional`, `leadingIcon`, `trailing{icon,onPress}` | 56 dp; "(optional)" label; required fields unmarked. |
| `SelectField` | `label`, `value`, `sub`, `onPress`, `error`, `icon`, `onClear` | Trigger for any sheet. |
| `SearchInput` | TextInput props + `onClear` | List headers and sheets. |
| `QuantityStepper` | `value` (string), `onChange`, `unit`, `step`, `quick[]`, `fill{label,value}`, `max`, `info`, `units{options,value,onChange}`, `error`, `warning`, `name` | ± with long-press acceleration, quick-add chips, smart Fill chip. `stepFor(uom)` gives defaults. |
| `Sheet` | `visible`, `onClose`, `title`, `subtitle`, `footer`, `full` (90 %), `fullscreen` | Modal bottom sheet, keyboard-safe. |
| `SearchSheet` | `options: Option[]`, `value`, `onSelect`, `recentKey`, `favKey`, `categories`, `onClear`, `emptyAction` | Favourites / Recent / All, category chips, normalised search keys (ø12 = d12 = 12mm). |
| `Picker` | `label`, `value`, `options`, `onChange`, `recentKey`, `favKey`, `categories`, `allowClear`, `error`, `name` | `SelectField` + `SearchSheet`. `Option = { id, label, sub?, code?, category?, trailing? }`. |
| `ReasonSheet` | `reasons[]`, `onConfirm(reason)`, `confirmLabel`, `variant`, `allowEmpty` | Reason chips + "Other…" text. Reject / return / reverse. |
| `ListRow` | `id`, `title`, `subtitle`, `meta`, `icon`, `iconTone`, `status`, `chip`, `qty`, `unit`, `qtyTone`, `stripe`, `sync`, `chevron`, `unread`, `onPress(id)` | Memoised 64/72 dp FlashList row. |
| `KpiTile`, `Grid` | `label`, `value`, `sub`, `tone`, `onPress`; `columns` | Zero reads "All clear"; only warning/danger colour the number. |
| `ActionTile`, `HeroAction` | `icon`, `label`, `hint`, `onPress`, `badge`, `compact` | Home quick actions; one hero (amber) per dashboard. |
| `ProgressBar`, `ProgressRing` | `pct`, `planned` (marker), `showLabel`; `size` | SVG ring, static render. |
| `PhotoStrip` + `usePhotoCount(entityId)` | `projectId`, `entityType`, `entityId`, `kind`, `canAdd`, `label`, `required`, `error`, `name` | 80 dp expo-image thumbs (320 px files), one-tap camera, viewer with Delete/Retake. |
| `SignatureField` | `label`, `value`, `onChange`, `signer`, `optional`, `error` | Inline preview + full-screen pad; SVG path in 320×140 viewBox (same as PDFs). |
| `Screen` | `scroll`, `padded`, `gap`, `footer`, `form`, `band`, `insetBottom` | Adds the offline band. `insetBottom={false}` inside tabs. |
| `ActionBar` | `summary`, `warning`, `primary`, `secondary`, `tertiary` | Sticky bottom bar; primary bottom-right. |
| `useForm()` | → `form.focusFirstError(errors)` | Pass `form` to `<Screen>`; fields with `name` register for scroll-to-error. |
| `useUnsavedGuard(dirty, { what, onSaveDraft })` | → `disable()` | "Discard …? / Keep editing / Save draft". Call `disable()` before navigating after save. |
| `SyncPill`, `OfflineBand`, `SyncChip`, `SyncDot`, `SyncError`, `LastSynced`, `useOutboxCounts` | `entityId` / `status` | Sync UI. In lists use `SyncDot` with `syncStatusMap()` (one query). |
| `toast` + `ToastHost` | `toast.success(text, action?)`, `toast.show({ text, tone, action })` | Host is mounted in the root layout. |
| `EmptyState`, `Skeleton`, `SuccessView`, `SuccessTick` | `icon`, `title`, `body`, `action`, `secondary`, `tone`, `compact` | Skeletons only for first-ever/remote loads, never local data. |
| `showError`, `confirm` | | `Alert` only for destructive confirmations and hard errors. |

Domain pickers (`components/pickers.tsx`): `SpecPicker` (category chips, favourites), `ElementPicker` (level chips),
`PersonPicker` (role chips, `roles?`), `StorePicker` (`all?`), `BlockPicker`, `SupplierPicker`, `DateField` (`quick` →
Today / Tomorrow / next days chips), `openDatePicker()`. App chrome (`components/AppChrome.tsx`): `HeaderActions`,
`ProjectSwitcher`, `kindFor(role)`, `DOC_ICON`.

## Navigation

- `app/(tabs)/_layout.tsx` — role-based bottom tabs (`ROLE_TABS`). Add a tab by adding a file in `(tabs)/` and a
  `screen('name')` line; hide it for roles with `ROLE_TABS`. Badges only for actionable counts.
- Create / post / detail screens live outside `(tabs)` and push full-screen on the root stack (no tab bar).
- Set a screen title with `<Stack.Screen options={{ title }} />` inside the screen.

## Screen templates

### List screen (tab or stack)

```tsx
export default function Inspections() {
  const { project } = useSession();
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const rows = useData(() => {
    const sync = syncStatusMap();
    return rowsWhere<Inspection>('inspections', project.id, filter === 'open' ? `AND ${jf('status')} = 'open'` : '', [], `${jf('created_at')} DESC`)
      .map((r) => ({ id: r.id, title: r.number, sub: r.location, status: r.status, sync: sync.get(r.id) ?? null }));
  }, [project.id, filter]);
  const open = useCallback((id: string) => router.push(`/inspections/${id}`), []);
  return (
    <Screen scroll={false} padded={false} insetBottom={false}>
      <View style={{ padding: space[4], gap: space[1] }}>
        <ChipGroup scroll value={filter} onChange={setFilter} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} />
      </View>
      <FlashList data={rows} keyExtractor={(r) => r.id}
        renderItem={({ item: r }) => <ListRow id={r.id} title={r.title} subtitle={r.sub} status={r.status} sync={r.sync} icon="clipboard-check-outline" onPress={open} />}
        ListEmptyComponent={<EmptyState icon="clipboard-check-outline" title="No inspections yet" body="…" action={{ label: 'New inspection', onPress: () => router.push('/inspections/new') }} />} />
      <Fab label="New inspection" onPress={() => router.push('/inspections/new')} />
    </Screen>
  );
}
```

### Detail screen

```tsx
export default function InspectionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const doc = useData(() => get<Inspection>('inspections', id), [id]);
  if (!doc) return <Screen><EmptyState icon="cloud-off-outline" title="Not on this phone yet" /></Screen>;
  return (
    <Screen footer={<ActionBar primary={{ title: 'Close snag', onPress: closeIt }} secondary={{ title: 'Reject', variant: 'dangerOutline', onPress: () => setReason(true) }} />}>
      <Stack.Screen options={{ title: doc.number }} />
      <SyncError entityId={id} />
      <Card>
        <Row wrap gap={6}><StatusChip status={doc.status} /><SyncChip entityId={id} showSynced /></Row>
        <InfoRow label="Location" value={doc.location} />
      </Card>
      <Section title="Items">{/* Cards or a flush Card of ListRows */}</Section>
      <PhotoStrip projectId={doc.project_id} entityType="inspection" entityId={id} />
    </Screen>
  );
}
```

### Create-flow screen

```tsx
export default function NewPour() {
  const { project } = useSession();
  const form = useForm();
  const [id] = useState(uuid);
  const [elementId, setElementId] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const disable = useUnsavedGuard(!!elementId || !!qty, { what: 'pour' });
  const photos = usePhotoCount(id);

  const submit = () => {
    const e: Errors = {};
    if (!elementId) e.element = 'Select the element';
    if (!(num(qty) > 0)) e.qty = 'Enter the volume';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }   // never a silently disabled button
    enqueue('record_pour', { id, project_id: project.id, element_id: elementId!, volume: num(qty) }, { entityType: 'pour', entityId: id, label: 'Pour recorded' });
    haptic('confirm'); toast.success('Pour saved on phone');
    disable(); router.replace(`/pours/${id}`);
  };

  return (
    <Screen form={form} footer={<ActionBar summary={`${fmtQty(num(qty) || 0)} m3${photos ? '' : ' · no photo yet'}`} warning={!photos} primary={{ title: 'Save pour', variant: 'hero', onPress: submit }} />}>
      <Stack.Screen options={{ title: 'Concrete pour' }} />
      <Card>
        <ElementPicker projectId={project.id} value={elementId} onChange={setElementId} error={errors.element} name="element" />
        <QuantityStepper label="Volume" unit="m3" value={qty} onChange={setQty} error={errors.qty} name="qty" />
      </Card>
      <PhotoStrip projectId={project.id} entityType="pour" entityId={id} required={1} />
      <SignatureField label="Supervisor signature" value={sig} onChange={setSig} optional />
    </Screen>
  );
}
```

Success after posting a document: render `<SuccessView title="GRN-… saved on phone" actions={[...]} />` (see `store/receive.tsx`).

## Localisation (English / Amharic) and calendar

`lib/i18n.ts`: `t('home.needsYou')` (typed keys, `{n}` placeholders), `tx(dynamicKey, fallback)`, `useLocale()` /
`useT()` to re-render on change, `setLocalePrefs({ locale, calendar })` (kv `ui:locale` / `ui:calendar`; Settings also
enqueues `set_my_locale`). Missing Amharic keys fall back to English. In files where `t` is the theme, import
`{ t as tr }`. `components/LocaleRoot.tsx` (root layout) provides `ScriptContext` so `Text` uses Ethiopic sizing for
`am`. Dates: always `fmtDate` / `fmtDateTime` (`lib/format.ts`) — they switch to `formatEthiopian` when the calendar
preference is Ethiopian. `statusInfo()` labels are translated (`status.<key>`). Keep strings in sentence case, avoid
concatenating translated fragments, and let layouts tolerate ~30 % longer labels.

## QR labels

`QrScanner` (`ui/QrScanner.tsx`, expo-camera loaded lazily) and `lib/qr.ts` (`ensureQrKey` via `get_qr_key`, key in
expo-secure-store; `checkQr(code)` verifies offline, else online `verify_qr`). `Picker` / `SearchSheet` accept
`scan={(entityType, entityId) => ({ id } | { query } | null)}` to show a scan button; `SpecPicker`, `ElementPicker`
and `StorePicker` already pass one.
