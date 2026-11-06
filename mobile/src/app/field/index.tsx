// Site & quality hub (More → Site & quality): diary, inspections, snags, pours, cubes,
// truck receipts, rebar. Badges are SQL counts (counts.ts fieldCounts).
import React, { useState } from 'react';
import { Stack, router, type Href } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { fieldCounts } from '../../lib/counts';
import { canField } from '../../lib/contract-field';
import { today } from '../../lib/format';
import { space } from '../../theme';
import { ActionTile, Card, Grid, HeroAction, ListRow, Screen, Section, type IconName } from '../../components/ui';
import { ElementPicker } from '../../components/pickers';

export default function FieldHub() {
  const { profile, project } = useSession();
  const c = useData(() => fieldCounts(project.id, profile.id), [project.id, profile.id]);
  const [el, setEl] = useState<string | null>(null);
  const role = profile.role;
  const go = (h: Href) => router.push(h);
  const diaryHint = c.diaryToday === 'none' ? 'Not started today' : c.diaryToday === 'draft' ? 'Draft · submit before you leave' : `Today's diary ${c.diaryToday}`;
  const tiles: { icon: IconName; label: string; href: Href; badge?: number; show: boolean }[] = [
    { icon: 'notebook-outline', label: canField(role, 'diary.sign') ? 'Diaries to sign' : 'Diary history', href: '/diary', badge: canField(role, 'diary.sign') ? c.diariesToSign : undefined, show: true },
    { icon: 'clipboard-check-outline', label: 'Inspections', href: '/inspections', badge: canField(role, 'inspection.perform') ? c.inspectionsRequested : undefined, show: true },
    { icon: 'bug-outline', label: 'Snags', href: '/snags', badge: canField(role, 'snag.review') ? c.snagsToReview : c.snagsMine, show: true },
    { icon: 'dump-truck', label: 'Concrete pours', href: '/pours', badge: c.poursActive || undefined, show: true },
    { icon: 'test-tube', label: 'Cubes due', href: '/pours/cubes', badge: c.cubesDue, show: true },
    { icon: 'tray-arrow-down', label: 'Trucks to receive', href: '/pours/receive', badge: c.trucksAwaiting, show: canField(role, 'pour.receiveTruck') },
  ];
  return (
    <Screen gap={space[4]}>
      <Stack.Screen options={{ title: 'Site & quality' }} />
      {canField(role, 'diary.write') ? (
        <HeroAction icon="notebook-edit-outline" label="Today's site diary" hint={diaryHint} onPress={() => go(`/diary/edit?date=${today()}`)} />
      ) : null}
      <Grid columns={3}>
        {tiles.filter((t) => t.show).map((t) => <ActionTile key={t.label} compact icon={t.icon} label={t.label} badge={t.badge || undefined} onPress={() => go(t.href)} />)}
      </Grid>
      <Section title="Overview">
        <Card flush>
          <ListRow id="open" title="Open snags" qty={String(c.snagsOpen)} icon="bug-outline" chevron onPress={() => go('/snags?filter=open')} />
          <ListRow id="overdue" title="Overdue snags" qty={String(c.snagsOverdue)} qtyTone={c.snagsOverdue ? 'danger' : 'default'} icon="clock-alert-outline" chevron onPress={() => go('/snags?filter=overdue')} />
          {canField(role, 'snag.create') ? <ListRow id="raise" title="Raise a snag" icon="camera-plus-outline" chevron onPress={() => go('/snags/new')} /> : null}
          {canField(role, 'pour.write') ? <ListRow id="plan" title="Plan a pour" icon="calendar-check-outline" chevron onPress={() => go('/pours/new')} /> : null}
        </Card>
      </Section>
      <Section title="Rebar (BBS)">
        <ElementPicker projectId={project.id} label="Element" value={el} onChange={(v) => { setEl(null); if (v) go(`/rebar/${v}`); }} placeholder="Open an element's BBS" />
      </Section>
    </Screen>
  );
}
