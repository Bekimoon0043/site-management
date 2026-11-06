// Site diary detail: sections, addenda and (office engineer / coordinator) sign-off.
// Signed diaries are frozen; later changes are addenda. Return-to-draft needs a comment.
import React, { useState } from 'react';
import { View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get } from '../../lib/db';
import { canField, DELAY_CAUSE_LABELS, type SiteDiary } from '../../lib/contract-field';
import { daySummary, diaryChildren } from '../../lib/field';
import { blocks, elementLabel, personName } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { fmtDate, fmtDateTime, fmtQty } from '../../lib/format';
import { space } from '../../theme';
import {
  ActionBar, Banner, Button, Card, Chip, EmptyState, Field, InfoRow, ListRow, PhotoStrip, ReasonSheet, Row, Screen, Section, Sheet,
  StatusChip, SyncChip, SyncError, Text, haptic, toast, type BarAction,
} from '../../components/ui';
import { WEATHER_INFO, diaryConflict, resolveDiaryConflict } from '../../components/field';

export default function DiaryDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useSession();
  const [ret, setRet] = useState(false);
  const [add, setAdd] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const d = useData(() => {
    const doc = get<SiteDiary>('site_diaries', id);
    if (!doc) return null;
    return { doc, c: diaryChildren(id), summary: daySummary(doc.project_id, doc.diary_date), conflict: diaryConflict(id),
      block: doc.block_id ? blocks(doc.project_id).find((b) => b.id === doc.block_id)?.code ?? null : null };
  }, [id]);
  if (!d) return <Screen><Stack.Screen options={{ title: 'Site diary' }} /><EmptyState icon="cloud-off-outline" title="Not on this phone yet" body="It will appear after the next sync." /></Screen>;
  const { doc, c } = d;
  const mine = doc.created_by === profile.id;
  const canSign = canField(profile.role, 'diary.sign') && doc.status === 'submitted' && (!mine || profile.role === 'admin');
  const canEdit = doc.status !== 'signed' && (mine || canField(profile.role, 'diary.sign'));
  const canAddendum = canField(profile.role, 'diary.write') && (doc.status !== 'draft' || !mine);
  const labour = c.labour.filter((l) => !l.deleted_at);
  const head = labour.reduce((s, l) => s + Number(l.headcount), 0);

  const sign = (approve: boolean, comment?: string) => {
    enqueue('sign_site_diary', { diary_id: doc.id, approve, comment }, { entityType: 'site_diary', entityId: doc.id, label: `${doc.number} ${approve ? 'signed' : 'returned'}` });
    haptic(approve ? 'confirm' : 'reject');
    toast.success(approve ? `${doc.number} signed · saved on phone` : `${doc.number} returned to the author`);
    if (approve) router.back();
  };
  const postAddendum = () => {
    if (!text.trim()) { setErr('Write the addendum'); return; }
    enqueue('add_diary_addendum', { id: uuid(), diary_id: doc.id, text: text.trim() }, { entityType: 'site_diary', entityId: doc.id, label: `${doc.number} addendum` });
    haptic('confirm'); toast.success('Addendum saved on phone');
    setText(''); setAdd(false); setErr(null);
  };

  let primary: BarAction | null = null;
  let secondary: BarAction | null = null;
  if (canSign) {
    primary = { title: 'Sign diary', variant: 'hero', icon: 'draw-pen', onPress: () => sign(true) };
    secondary = { title: 'Return', variant: 'dangerOutline', onPress: () => setRet(true) };
  } else if (canEdit && doc.status === 'draft') {
    primary = { title: 'Edit and submit', variant: 'hero', icon: 'pencil-outline', onPress: () => router.push(`/diary/edit?id=${doc.id}`) };
  } else if (canAddendum) {
    primary = { title: 'Add addendum', icon: 'text-box-plus-outline', onPress: () => setAdd(true) };
    if (canEdit && doc.status === 'submitted') secondary = { title: 'Edit', variant: 'outline', onPress: () => router.push(`/diary/edit?id=${doc.id}`) };
  }

  return (
    <Screen footer={primary ? <ActionBar primary={primary} secondary={secondary} /> : undefined}>
      <Stack.Screen options={{ title: doc.number }} />
      <SyncError entityId={doc.id} />
      {d.conflict ? (
        <Banner tone="warning" title={`Diary ${d.conflict.existing_number} already exists for this day`} text="Add these entries to it as an addendum instead."
          actions={[{ label: 'Add as addendum', onPress: () => { const to = resolveDiaryConflict(doc.id); if (to) { toast.success('Added as an addendum · saved on phone'); router.replace(`/diary/${to}`); } } }]} />
      ) : null}
      <Card>
        <Row wrap gap={6}><StatusChip status={doc.status} /><SyncChip entityId={doc.id} showSynced />{d.block ? <Chip label={`Block ${d.block}`} icon="floor-plan" /> : null}</Row>
        <Text variant="titleSm">{fmtDate(doc.diary_date)}</Text>
        <InfoRow label="Author" value={personName(doc.created_by)} />
        {doc.submitted_at ? <InfoRow label="Submitted" value={fmtDateTime(doc.submitted_at)} /> : null}
        {doc.signed_by ? <InfoRow label="Signed" value={`${personName(doc.signed_by)} · ${fmtDateTime(doc.signed_at)}`} tone="success" icon="draw-pen" /> : null}
        {doc.sign_comment ? <InfoRow label="Reviewer comment" value={doc.sign_comment} tone={doc.status === 'draft' ? 'warning' : 'default'} /> : null}
      </Card>

      <Section title="Weather">
        <Card dense>
          <Row wrap gap={6}>
            {doc.weather_am ? <Chip label={`AM ${WEATHER_INFO[doc.weather_am].label}`} icon={WEATHER_INFO[doc.weather_am].icon} /> : null}
            {doc.weather_pm ? <Chip label={`PM ${WEATHER_INFO[doc.weather_pm].label}`} icon={WEATHER_INFO[doc.weather_pm].icon} /> : null}
            {doc.rain_hours ? <Chip label={`Rain ${fmtQty(doc.rain_hours)} h`} tone="info" icon="weather-rainy" /> : null}
            {!doc.weather_am && !doc.weather_pm ? <Text variant="bodySm" tone="muted">Not recorded</Text> : null}
          </Row>
        </Card>
      </Section>

      <Section title={`Labour · ${head}`}>
        {labour.length ? (
          <Card dense>
            {labour.map((l) => <InfoRow key={l.id} label={l.trade_name ?? get<{ name: string }>('labour_trades', l.trade_id)?.name ?? 'Trade'} value={`${l.headcount}${l.hours ? ` · ${fmtQty(l.hours)} h` : ''}`} />)}
          </Card>
        ) : <Text variant="bodySm" tone="muted">No labour recorded.</Text>}
      </Section>

      {c.equipment.some((e) => !e.deleted_at) ? (
        <Section title="Equipment">
          <Card dense>
            {c.equipment.filter((e) => !e.deleted_at).map((e) => (
              <InfoRow key={e.id} label={`${e.equipment}${e.qty > 1 ? ` ×${e.qty}` : ''}`} value={`${e.status}${e.hours_worked != null ? ` · ${fmtQty(e.hours_worked)} h` : ''}`}
                tone={e.status === 'breakdown' ? 'danger' : e.status === 'idle' ? 'warning' : 'default'} />
            ))}
          </Card>
        </Section>
      ) : null}

      {c.delays.some((x) => !x.deleted_at) ? (
        <Section title="Delays and issues">
          {c.delays.filter((x) => !x.deleted_at).map((x) => (
            <Card key={x.id} dense stripe="warning">
              <Row justify="space-between"><Text variant="label">{DELAY_CAUSE_LABELS[x.cause]}</Text>{x.hours_lost ? <Chip label={`${fmtQty(x.hours_lost)} h lost`} tone="warning" icon="clock-alert-outline" small /> : null}</Row>
              {x.description ? <Text variant="bodySm">{x.description}</Text> : null}
            </Card>
          ))}
        </Section>
      ) : null}

      {doc.work_summary ? <Section title="Work done"><Card dense><Text variant="body">{doc.work_summary}</Text></Card></Section> : null}
      {c.elements.some((e) => !e.deleted_at) ? (
        <Section title="Elements worked on">
          <Row wrap gap={6}>{c.elements.filter((e) => !e.deleted_at).map((e) => <Chip key={e.id} label={elementLabel(e.element_id)} icon="pillar" />)}</Row>
        </Section>
      ) : null}

      <Section title="Today on site">
        {d.summary.length ? (
          <Card flush>{d.summary.slice(0, 15).map((s) => <ListRow key={`${s.kind}:${s.id}`} id={s.id} title={s.number} subtitle={s.summary} status={s.status} />)}</Card>
        ) : <Text variant="bodySm" tone="muted">Nothing else recorded on this phone for the day.</Text>}
      </Section>

      {c.visitors.some((v) => !v.deleted_at) ? (
        <Section title="Visitors">
          <Card dense>{c.visitors.filter((v) => !v.deleted_at).map((v) => <InfoRow key={v.id} label={v.name} value={[v.organisation, v.purpose].filter(Boolean).join(' · ') || '—'} />)}</Card>
        </Section>
      ) : null}
      {c.instructions.some((i) => !i.deleted_at) ? (
        <Section title="Instructions received">
          {c.instructions.filter((i) => !i.deleted_at).map((i) => (
            <Card key={i.id} dense><Text variant="caption" tone="muted">{i.given_by ?? 'Instruction'}</Text><Text variant="body">{i.instruction}</Text></Card>
          ))}
        </Section>
      ) : null}
      {doc.safety_notes || doc.notes ? (
        <Section title="Safety and notes">
          <Card dense>
            {doc.safety_notes ? <InfoRow label="Safety" value={doc.safety_notes} /> : null}
            {doc.notes ? <InfoRow label="Notes" value={doc.notes} /> : null}
          </Card>
        </Section>
      ) : null}

      <PhotoStrip projectId={doc.project_id} entityType="site_diary" entityId={doc.id} canAdd={doc.status !== 'signed'} label="Site photos" />

      <Section title="Addenda">
        {c.addenda.length ? c.addenda.map((a) => (
          <Card key={a.id} dense>
            <Text variant="caption" tone="muted">{personName(a.created_by)} · {fmtDateTime(a.created_at)}</Text>
            <Text variant="body">{a.text}</Text>
          </Card>
        )) : <Text variant="bodySm" tone="muted">No addenda.</Text>}
        {canAddendum && primary?.title !== 'Add addendum' ? <Button title="Add addendum" size="sm" variant="tonal" icon="text-box-plus-outline" onPress={() => setAdd(true)} /> : null}
      </Section>

      <ReasonSheet visible={ret} onClose={() => setRet(false)} title="Return diary" subtitle="Say what needs correcting" confirmLabel="Return to author" variant="danger"
        reasons={['Weather missing', 'Labour incomplete', 'Work done unclear', 'Delays not explained', 'Photos missing']}
        onConfirm={(r) => { setRet(false); sign(false, r); }} />
      {add ? (
        <Sheet visible={add} onClose={() => setAdd(false)} title="Addendum" subtitle={`To ${doc.number}`}
          footer={<><Button title="Cancel" variant="ghost" onPress={() => setAdd(false)} /><Button title="Save addendum" flex onPress={postAddendum} /></>}>
          <View style={{ paddingHorizontal: space[4], paddingBottom: space[3] }}>
            <Field label="Addendum" value={text} onChangeText={(v) => { setText(v); setErr(null); }} multiline autoFocus error={err} />
          </View>
        </Sheet>
      ) : null}
    </Screen>
  );
}
