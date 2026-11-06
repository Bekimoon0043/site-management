// Global search (spec §4.5): document numbers ("0142" matches MR-BOLE-0142), materials
// (open the bin card), elements (open progress) and people. Local SQLite only.
import React, { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Stack, router, type Href } from 'expo-router';
import { useData, useSession } from '../lib/app';
import { getDb, kvGet, kvSet } from '../lib/db';
import { elements, levels, members, specs } from '../lib/queries';
import { ROLE_LABELS } from '../lib/contract';
import { space } from '../theme';
import { Card, EmptyState, FilterChip, ListRow, Screen, SearchInput, Section, normalize, type IconName } from '../components/ui';

interface Hit { id: string; title: string; sub: string; icon: IconName; href: Href; status?: string }
const DOCS: { tbl: string; type: string; icon: IconName; route: (id: string) => Href }[] = [
  { tbl: 'material_requests', type: 'Request', icon: 'clipboard-list-outline', route: (id) => `/requests/${id}` },
  { tbl: 'grns', type: 'Receipt', icon: 'truck-delivery-outline', route: (id) => `/store/doc?type=grn&id=${id}` },
  { tbl: 'mivs', type: 'Issue', icon: 'package-variant-closed-remove', route: (id) => `/store/doc?type=miv&id=${id}` },
  { tbl: 'mrns', type: 'Return', icon: 'keyboard-return', route: (id) => `/store/doc?type=mrn&id=${id}` },
  { tbl: 'adjustments', type: 'Adjustment', icon: 'delete-variant', route: (id) => `/store/doc?type=adjustment&id=${id}` },
  { tbl: 'stock_counts', type: 'Count', icon: 'counter', route: (id) => `/store/doc?type=count&id=${id}` },
  { tbl: 'transfers', type: 'Transfer', icon: 'swap-horizontal', route: () => '/store/transfer' },
];

const RECENT = 'recent-searches';
const readRecent = (): string[] => { try { return JSON.parse(kvGet(RECENT) ?? '[]') as string[]; } catch { return []; } };

export default function Search() {
  const { project } = useSession();
  const [q, setQ] = useState('');
  const [all, setAll] = useState<string | null>(null);
  const dq = useDeferredValue(q.trim());
  const recent = useMemo(readRecent, [all]);

  const base = useData(() => ({
    specs: specs().map((s) => ({ s, key: normalize(`${s.label} ${s.category}`) })),
    els: (() => {
      const lv = new Map(levels(project.id).map((l) => [l.id, l.code]));
      return elements(project.id).map((e) => ({ e, label: `${e.code}${e.level_id ? ` (${lv.get(e.level_id) ?? ''})` : ''}`, key: normalize(`${e.code} ${e.element_type} ${e.grid ?? ''}`) }));
    })(),
    people: members(project.id).map((p) => ({ p, key: normalize(`${p.full_name} ${p.email ?? ''} ${p.phone ?? ''}`) })),
  }), [project.id]);

  const groups = useMemo(() => {
    if (dq.length < 2) return [];
    const nq = normalize(dq);
    const like = `%${dq.replace(/[%_]/g, '')}%`;
    const docs: Hit[] = [];
    for (const d of DOCS) {
      const rows = getDb().getAllSync<{ pk: string; number: string; status: string }>(
        `SELECT pk, json_extract(json, '$.number') AS number, json_extract(json, '$.status') AS status FROM rows
         WHERE tbl = ? AND (project_id = ? OR ? = 'transfers') AND deleted = 0 AND json_extract(json, '$.number') LIKE ? COLLATE NOCASE
         ORDER BY json_extract(json, '$.number') DESC LIMIT 20`, [d.tbl, project.id, d.tbl, like]);
      rows.forEach((r) => docs.push({ id: r.pk, title: r.number, sub: d.type, icon: d.icon, href: d.route(r.pk), status: r.status }));
    }
    const mats: Hit[] = base.specs.filter((x) => x.key.includes(nq)).map(({ s }) => ({
      id: s.id, title: s.label, sub: `${s.category} · ${s.uom} · bin card`, icon: 'cube-outline', href: `/store/bincard?spec=${s.id}`,
    }));
    const els: Hit[] = base.els.filter((x) => x.key.includes(nq)).map(({ e, label }) => ({
      id: e.id, title: label, sub: `${e.element_type}${e.grid ? ` · grid ${e.grid}` : ''}`, icon: 'pillar', href: `/progress/${e.id}`,
    }));
    const people: Hit[] = base.people.filter((x) => x.key.includes(nq)).map(({ p }) => ({
      id: p.id, title: p.full_name, sub: `${ROLE_LABELS[p.role]}${p.phone ? ` · ${p.phone}` : ''}`, icon: 'account-outline', href: '/requests?filter=all',
    }));
    return [
      { key: 'docs', title: 'Documents', hits: docs },
      { key: 'mats', title: 'Materials', hits: mats },
      { key: 'els', title: 'Elements', hits: els },
      { key: 'people', title: 'People', hits: people },
    ].filter((g) => g.hits.length);
  }, [dq, base, project.id]);

  const go = useCallback((h: Hit) => {
    const t = q.trim();
    if (t) kvSet(RECENT, JSON.stringify([t, ...readRecent().filter((x) => x !== t)].slice(0, 8)));
    router.push(h.href);
  }, [q]);

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: 'Search' }} />
      <View style={styles.head}>
        <SearchInput value={q} onChangeText={(v) => { setQ(v); setAll(null); }} onClear={() => setQ('')} autoFocus
          placeholder="Number, material, element or person" />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        {dq.length < 2 ? (
          recent.length ? (
            <Section title="Recent searches">
              <View style={styles.chips}>{recent.map((r) => <FilterChip key={r} label={r} icon="history" selected={false} onPress={() => setQ(r)} />)}</View>
            </Section>
          ) : <EmptyState icon="magnify" title="Search this phone" body="Find requests and documents by number (e.g. 0142), materials, elements and people." compact />
        ) : groups.length ? groups.map((g) => {
          const shown = all === g.key ? g.hits : g.hits.slice(0, 5);
          return (
            <Section key={g.key} title={`${g.title} · ${g.hits.length}`} action={g.hits.length > 5 && all !== g.key ? 'See all' : undefined} onAction={() => setAll(g.key)}>
              <Card flush>
                {shown.map((h) => <ListRow key={h.id} id={h.id} title={h.title} subtitle={h.sub} icon={h.icon} status={h.status} onPress={() => go(h)} />)}
              </Card>
            </Section>
          );
        }) : <EmptyState icon="magnify" title={`No match for “${q}”`} action={{ label: 'Clear search', onPress: () => setQ('') }} compact />}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { padding: space[4], paddingBottom: space[2] },
  body: { paddingHorizontal: space[4], paddingBottom: space[8], gap: space[3] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space[2] },
});
