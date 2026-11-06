// Search-select bottom sheet (spec §3.6): Favourites / Recent / All sections, category chips,
// precomputed normalised search keys, ranked results, FlashList, single tap selects.
import React, { memo, useCallback, useDeferredValue, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { kvGet, kvSet } from '../../lib/db';
import { size, space, useTheme } from '../../theme';
import { Icon } from './Icon';
import { Text } from './Text';
import { Sheet } from './Sheet';
import { SearchInput, SelectField } from './Field';
import { ChipGroup } from './Chip';
import { Button } from './Button';
import { haptic } from './haptics';
import { IconButton } from './Button';
import { QrScanner } from './QrScanner';
import { toast } from './Toast';
import { checkQr } from '../../lib/qr';

/** Map a verified QR label (entity type + id) to an option id, or a search query (e.g. a material with several grades). */
export type ScanResolver = (entityType: string, entityId: string) => { id: string } | { query: string } | null;

export interface Option {
  id: string;
  label: string;
  sub?: string;
  /** Short code that ranks first on prefix match (doc number, element code…). */
  code?: string;
  /** Category for the filter chips. */
  category?: string;
  /** Right-aligned hint (e.g. unit). */
  trailing?: string;
}

// ---------------------------------------------------------------------------
// Normalised search keys
// ---------------------------------------------------------------------------

/** lowercase, strip diacritics, Ø/⌀ → d, collapse spaces. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[øØ⌀∅]/g, 'd')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[_\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keyFor(o: Option): string {
  let k = normalize(`${o.label} ${o.sub ?? ''} ${o.code ?? ''}`);
  // Diameter variants so "d12", "12mm", "dia12" and "ø12" all match.
  const extra: string[] = [];
  k.replace(/\bd ?(\d+)\b/g, (_m, n: string) => { extra.push(`${n}mm`, `dia${n}`, `d${n}`); return ''; });
  k.replace(/\b(\d+) ?mm\b/g, (_m, n: string) => { extra.push(`d${n}`, `dia${n}`); return ''; });
  if (extra.length) k += ` ${extra.join(' ')}`;
  return k;
}

interface Indexed { o: Option; key: string; code: string; words: string[] }
const indexCache = new WeakMap<Option[], Indexed[]>();
function indexOf(options: Option[]): Indexed[] {
  let ix = indexCache.get(options);
  if (!ix) {
    ix = options.map((o) => {
      const key = keyFor(o);
      return { o, key, code: normalize(o.code ?? ''), words: normalize(o.label).split(' ') };
    });
    indexCache.set(options, ix);
  }
  return ix;
}

function search(ix: Indexed[], q: string): Option[] {
  const nq = normalize(q);
  if (!nq) return ix.map((x) => x.o);
  const terms = nq.split(' ');
  const scored: { o: Option; s: number }[] = [];
  for (const x of ix) {
    if (!terms.every((tm) => x.key.includes(tm))) continue;
    let s = 3;
    if (x.code && x.code.startsWith(nq)) s = 0;
    else if (x.code && x.code.includes(nq)) s = 1;
    else if (x.words.some((w) => w.startsWith(terms[0]))) s = 2;
    scored.push({ o: x.o, s });
  }
  scored.sort((a, b) => a.s - b.s);
  return scored.map((x) => x.o);
}

// ---------------------------------------------------------------------------
// Favourites / recents (kv)
// ---------------------------------------------------------------------------

const readList = (k: string): string[] => { try { return JSON.parse(kvGet(k) ?? '[]') as string[]; } catch { return []; } };
export const recentIds = (key: string) => readList(`recent:${key}`);
export function pushRecent(key: string, id: string) {
  kvSet(`recent:${key}`, JSON.stringify([id, ...recentIds(key).filter((x) => x !== id)].slice(0, 8)));
}
export const favIds = (key: string) => readList(`fav:${key}`);
export function toggleFav(key: string, id: string): boolean {
  const cur = favIds(key);
  const on = !cur.includes(id);
  kvSet(`fav:${key}`, JSON.stringify(on ? [id, ...cur] : cur.filter((x) => x !== id)));
  return on;
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

type Item = { type: 'header'; title: string } | { type: 'row'; o: Option; fav: boolean; sel: boolean };

const Row = memo(function Row({ o, fav, sel, starrable, onPick, onStar }: {
  o: Option; fav: boolean; sel: boolean; starrable: boolean; onPick: (id: string) => void; onStar: (id: string) => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => onPick(o.id)}
      accessibilityRole="button"
      accessibilityState={{ selected: sel }}
      accessibilityLabel={`${o.label}${o.sub ? `, ${o.sub}` : ''}`}
      android_ripple={{ color: t.ripple }}
      style={[styles.row, sel && { backgroundColor: t.primaryContainer }, { borderBottomColor: t.border }]}
    >
      {starrable ? (
        <Pressable onPress={() => onStar(o.id)} hitSlop={4} accessibilityRole="button"
          accessibilityLabel={fav ? `Remove ${o.label} from favourites` : `Add ${o.label} to favourites`}
          android_ripple={{ color: t.ripple, borderless: true, radius: 22 }} style={styles.star}>
          <Icon name={fav ? 'star' : 'star-outline'} size={22} color={fav ? t.accentStrong : t.textMuted} />
        </Pressable>
      ) : <View style={styles.starPad} />}
      <View style={styles.rowBody}>
        <Text variant="body" weight={sel ? '700' : undefined} numberOfLines={2}>{o.label}</Text>
        {o.sub ? <Text variant="bodySm" tone="muted" numberOfLines={1}>{o.sub}</Text> : null}
      </View>
      {o.trailing ? <Text variant="bodySm" tone="muted">{o.trailing}</Text> : null}
      {sel ? <Icon name="check" size={22} tone="primary" /> : <View style={styles.checkPad} />}
    </Pressable>
  );
});

export interface SearchSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  options: Option[];
  value?: string | null;
  onSelect: (id: string) => void;
  /** kv key for recents (last 8). */
  recentKey?: string;
  /** kv key for favourites; enables the star toggle. Defaults to recentKey. */
  favKey?: string;
  /** Show category chips from Option.category. */
  categories?: boolean;
  onClear?: () => void;
  /** Extra action in the empty state ("Request new material code"). */
  emptyAction?: { label: string; onPress: (query: string) => void };
  placeholder?: string;
  /** Show a scan button: QR labels that verify select the matching option. */
  scan?: ScanResolver;
}

export function SearchSheet({ visible, onClose, title, options, value, onSelect, recentKey, favKey, categories, onClear, emptyAction, placeholder, scan }: SearchSheetProps) {
  const [q, setQ] = useState('');
  const [scanning, setScanning] = useState(false);
  const [cat, setCat] = useState<string>('__all');
  const [favVer, setFavVer] = useState(0);
  const dq = useDeferredValue(q);
  const fk = favKey ?? recentKey;
  const ix = indexOf(options);

  const cats = useMemo(() => {
    if (!categories) return [];
    return [...new Set(options.map((o) => o.category).filter((c): c is string => !!c))].sort();
  }, [options, categories]);

  const items = useMemo<Item[]>(() => {
    void favVer;
    const pool = cat === '__all' ? ix : ix.filter((x) => x.o.category === cat);
    const favs = new Set(fk ? favIds(fk) : []);
    const mk = (o: Option): Item => ({ type: 'row', o, fav: favs.has(o.id), sel: o.id === value });
    if (dq.trim()) return search(pool, dq).map(mk);
    const byId = new Map(pool.map((x) => [x.o.id, x.o]));
    const out: Item[] = [];
    const favRows = [...favs].map((id) => byId.get(id)).filter((o): o is Option => !!o);
    const recRows = (recentKey ? recentIds(recentKey) : []).map((id) => byId.get(id)).filter((o): o is Option => !!o && !favs.has(o.id));
    if (favRows.length) { out.push({ type: 'header', title: 'Favourites' }); favRows.forEach((o) => out.push(mk(o))); }
    if (recRows.length) { out.push({ type: 'header', title: 'Recent' }); recRows.forEach((o) => out.push(mk(o))); }
    if (out.length) out.push({ type: 'header', title: 'All (A–Z)' });
    pool.forEach((x) => out.push(mk(x.o)));
    return out;
  }, [ix, dq, cat, value, recentKey, fk, favVer]);

  const pick = useCallback((id: string) => {
    haptic('tick');
    if (recentKey) pushRecent(recentKey, id);
    onSelect(id);
    setQ('');
    onClose();
  }, [onClose, onSelect, recentKey]);

  const star = useCallback((id: string) => {
    if (!fk) return;
    const on = toggleFav(fk, id);
    haptic(on ? 'toggleOn' : 'toggleOff');
    setFavVer((n) => n + 1);
  }, [fk]);

  const close = () => { setQ(''); onClose(); };
  const empty = !items.some((i) => i.type === 'row');

  return (
    <Sheet visible={visible} onClose={close} title={title} full
      footer={onClear && value ? <Button title="Clear selection" variant="ghost" icon="close" onPress={() => { onClear(); close(); }} /> : undefined}>
      <View style={styles.top}>
        <View style={styles.searchRow}>
          <View style={styles.flex}>
            <SearchInput value={q} onChangeText={setQ} onClear={() => setQ('')} placeholder={placeholder ?? 'Search name, grade or code'}
              autoFocus={options.length > 12 && !scan} />
          </View>
          {scan ? <IconButton icon="qrcode-scan" accessibilityLabel="Scan QR label" onPress={() => setScanning(true)} /> : null}
        </View>
        {cats.length > 1 ? (
          <ChipGroup scroll value={cat} onChange={setCat}
            options={[{ value: '__all', label: 'All' }, ...cats.map((c) => ({ value: c, label: c }))]} />
        ) : null}
      </View>
      {empty ? (
        <View style={styles.empty}>
          <Icon name="magnify" size={40} tone="muted" />
          <Text variant="titleSm" align="center">{q ? `No match for “${q}”` : 'Nothing to choose from yet'}</Text>
          {!q ? <Text variant="bodySm" tone="muted" align="center">Connect to the internet once to download the lists.</Text> : null}
          <View style={styles.emptyActions}>
            {q ? <Button title="Clear search" variant="outline" size="md" onPress={() => setQ('')} /> : null}
            {q && emptyAction ? <Button title={emptyAction.label} variant="tonal" size="md" onPress={() => emptyAction.onPress(q)} /> : null}
          </View>
        </View>
      ) : (
        <FlashList
          data={items}
          keyboardShouldPersistTaps="handled"
          getItemType={(it) => it.type}
          keyExtractor={(it, i) => (it.type === 'row' ? it.o.id : `h${i}`)}
          renderItem={({ item }) => item.type === 'header'
            ? <HeaderRow title={item.title} />
            : <Row o={item.o} fav={item.fav} sel={item.sel} starrable={!!fk} onPick={pick} onStar={star} />}
        />
      )}
      {scan ? (
        <QrScanner visible={scanning} onClose={() => setScanning(false)} title={title} onCode={(code) => {
          setScanning(false);
          void checkQr(code).then((r) => {
            if (!r.ok || !r.payload) { haptic('reject'); toast.show({ text: r.reason ?? 'This QR code is not valid', tone: 'danger' }); return; }
            const res = scan(r.payload.entity_type, r.payload.entity_id);
            if (res && 'id' in res && options.some((o) => o.id === res.id)) pick(res.id);
            else if (res && 'query' in res) setQ(res.query);
            else { haptic('reject'); toast.show({ text: 'This label is not one of the choices here', tone: 'warning' }); }
          });
        }} />
      ) : null}
    </Sheet>
  );
}

const HeaderRow = memo(function HeaderRow({ title }: { title: string }) {
  return <View style={styles.header}><Text variant="caption" tone="muted" accessibilityRole="header">{title}</Text></View>;
});

// ---------------------------------------------------------------------------
// Picker = SelectField + SearchSheet
// ---------------------------------------------------------------------------

export interface PickerProps {
  label: string;
  value: string | null | undefined;
  options: Option[];
  onChange: (id: string | null) => void;
  placeholder?: string;
  recentKey?: string;
  favKey?: string;
  categories?: boolean;
  error?: string | null;
  hint?: string | null;
  warning?: string | null;
  allowClear?: boolean;
  optional?: boolean;
  name?: string;
  disabled?: boolean;
  sheetTitle?: string;
  emptyAction?: SearchSheetProps['emptyAction'];
  scan?: ScanResolver;
}

export function Picker({ label, value, options, onChange, placeholder = 'Select…', recentKey, favKey, categories, error, hint, warning, allowClear, optional, name, disabled, sheetTitle, emptyAction, scan }: PickerProps) {
  const [open, setOpen] = useState(false);
  const current = useMemo(() => options.find((o) => o.id === value), [options, value]);
  return (
    <>
      <SelectField label={label} value={current?.label} sub={current?.sub} placeholder={placeholder} onPress={() => setOpen(true)}
        error={error} hint={hint} warning={warning} optional={optional} name={name} disabled={disabled}
        onClear={allowClear ? () => onChange(null) : undefined} />
      {open ? (
        <SearchSheet visible={open} onClose={() => setOpen(false)} title={sheetTitle ?? label} options={options} value={value}
          onSelect={onChange} recentKey={recentKey} favKey={favKey} categories={categories}
          onClear={allowClear ? () => onChange(null) : undefined} emptyAction={emptyAction} scan={scan} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: space[4], paddingBottom: space[2], gap: space[2] },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  flex: { flex: 1 },
  row: { minHeight: size.control, flexDirection: 'row', alignItems: 'center', paddingRight: space[4], gap: space[2], borderBottomWidth: StyleSheet.hairlineWidth },
  star: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  starPad: { width: space[2] },
  rowBody: { flex: 1, paddingVertical: 8, gap: 1 },
  checkPad: { width: 22 },
  header: { paddingHorizontal: space[4], paddingTop: space[4], paddingBottom: space[1] },
  empty: { alignItems: 'center', gap: space[2], padding: space[8] },
  emptyActions: { flexDirection: 'row', gap: space[3], marginTop: space[2], flexWrap: 'wrap', justifyContent: 'center' },
});
