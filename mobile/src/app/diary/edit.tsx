// Today's site diary as one fast form (features B1): weather AM/PM chips, rain stepper,
// labour by trade (steppers, pre-filled from the last diary), equipment, delay chips with
// cause codes, visitors, instructions, elements worked on, notes, photos and an automatic
// "Today on site" summary from local GRNs / MIVs / progress / pours / inspections / snags.
// One diary per project/block/day: if another one exists, the entries go in as an addendum.
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get } from '../../lib/db';
import { jf, rowsWhere } from '../../lib/counts';
import { canField, DELAY_CAUSE_LABELS, type DelayCause, type EquipmentStatus, type SaveSiteDiaryPayload, type SiteDiary, type Weather } from '../../lib/contract-field';
import { daySummary, diaryChildren, diaryFor, labourTrades, type ActivityItem } from '../../lib/field';
import { elementLabel } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { fmtDate, num, today } from '../../lib/format';
import { space } from '../../theme';
import {
  ActionBar, Banner, Button, Card, Chip, ChipGroup, EmptyState, FilterChip, IconButton, ListRow, PhotoStrip, QuantityStepper, Row, Screen,
  Section, Segmented, Text, Field, haptic, showError, toast, useForm, usePhotoCount, useUnsavedGuard, type Errors, type IconName,
} from '../../components/ui';
import { BlockPicker, DateField, ElementPicker } from '../../components/pickers';
import { WeatherChips, addAsAddendum, diaryConflict, resolveDiaryConflict } from '../../components/field';

interface Lab { id: string; tradeId: string | null; name: string; count: string }
interface Equip { id: string; name: string; qty: string; status: EquipmentStatus; hours: string }
interface Delay { id: string; cause: DelayCause; hours: string; text: string }
interface Visitor { id: string; name: string; org: string; purpose: string }
interface Instr { id: string; by: string; text: string }
interface El { id: string; elementId: string }

const EQUIPMENT = ['Concrete mixer', 'Poker vibrator', 'Excavator', 'Tower crane', 'Dumper', 'Water pump', 'Generator', 'Bar bending machine'];
const KIND_ICON: Record<ActivityItem['kind'], IconName> = {
  grn: 'truck-delivery-outline', miv: 'package-variant-closed-remove', progress: 'progress-check', pour: 'dump-truck',
  inspection: 'clipboard-check-outline', snag: 'bug-outline',
};

export default function DiaryEdit() {
  const { profile, project } = useSession();
  const params = useLocalSearchParams<{ id?: string; date?: string }>();
  const form = useForm();
  const existing = useMemo(() => (params.id ? get<SiteDiary>('site_diaries', params.id) : diaryFor(project.id, params.date ?? today(), null)), [params.id, params.date, project.id]);
  const editable = !existing || (existing.status !== 'signed' && (existing.created_by === profile.id || canField(profile.role, 'diary.sign')));

  const init = useMemo(() => {
    if (existing) {
      const c = diaryChildren(existing.id);
      return {
        labour: c.labour.filter((l) => !l.deleted_at).map<Lab>((l) => ({ id: l.id, tradeId: l.trade_id, name: l.trade_name ?? get<{ name: string }>('labour_trades', l.trade_id)?.name ?? 'Trade', count: String(l.headcount) })),
        equipment: c.equipment.filter((e) => !e.deleted_at).map<Equip>((e) => ({ id: e.id, name: e.equipment, qty: String(e.qty), status: e.status, hours: e.hours_worked != null ? String(e.hours_worked) : '' })),
        delays: c.delays.filter((d) => !d.deleted_at).map<Delay>((d) => ({ id: d.id, cause: d.cause, hours: d.hours_lost != null ? String(d.hours_lost) : '', text: d.description ?? '' })),
        visitors: c.visitors.filter((v) => !v.deleted_at).map<Visitor>((v) => ({ id: v.id, name: v.name, org: v.organisation ?? '', purpose: v.purpose ?? '' })),
        instructions: c.instructions.filter((i) => !i.deleted_at).map<Instr>((i) => ({ id: i.id, by: i.given_by ?? '', text: i.instruction })),
        elements: c.elements.filter((e) => !e.deleted_at).map<El>((e) => ({ id: e.id, elementId: e.element_id })),
      };
    }
    // New diary: labour trades pre-filled from my last diary (same crew most days).
    const last = rowsWhere<SiteDiary>('site_diaries', project.id, `AND ${jf('created_by')} = ?`, [profile.id], `${jf('diary_date')} DESC`, 1)[0];
    const labour = last ? diaryChildren(last.id).labour.filter((l) => !l.deleted_at).map<Lab>((l) => ({ id: uuid(), tradeId: l.trade_id, name: l.trade_name ?? get<{ name: string }>('labour_trades', l.trade_id)?.name ?? 'Trade', count: String(l.headcount) })) : [];
    return { labour, equipment: [] as Equip[], delays: [] as Delay[], visitors: [] as Visitor[], instructions: [] as Instr[], elements: [] as El[] };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.id]);

  const [id] = useState(() => existing?.id ?? uuid());
  const [date, setDate] = useState<string>(existing?.diary_date ?? params.date ?? today());
  const [blockId, setBlockId] = useState<string | null>(existing?.block_id ?? null);
  const [am, setAm] = useState<Weather | null>(existing?.weather_am ?? null);
  const [pm, setPm] = useState<Weather | null>(existing?.weather_pm ?? null);
  const [rain, setRain] = useState(existing?.rain_hours != null ? String(existing.rain_hours) : '');
  const [labour, setLabour] = useState<Lab[]>(init.labour);
  const [equipment, setEquipment] = useState<Equip[]>(init.equipment);
  const [delays, setDelays] = useState<Delay[]>(init.delays);
  const [visitors, setVisitors] = useState<Visitor[]>(init.visitors);
  const [instructions, setInstructions] = useState<Instr[]>(init.instructions);
  const [els, setEls] = useState<El[]>(init.elements);
  const [work, setWork] = useState(existing?.work_summary ?? '');
  const [safety, setSafety] = useState(existing?.safety_notes ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [addEl, setAddEl] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [dirty, setDirty] = useState(false);
  const photos = usePhotoCount(id);
  const disable = useUnsavedGuard(dirty, { what: 'diary', onSaveDraft: () => save(false) });
  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); };

  const trades = useData(() => labourTrades().filter((t) => !t.deleted_at));
  const summary = useData(() => daySummary(project.id, date), [project.id, date]);
  const conflict = useData(() => diaryConflict(id), [id]);
  const headcount = labour.reduce((s, l) => s + (num(l.count) || 0), 0);

  if (existing && !editable) {
    return (
      <Screen>
        <Stack.Screen options={{ title: existing.number }} />
        <EmptyState icon="lock-outline" title={existing.status === 'signed' ? 'This diary is signed' : 'Diary written by someone else'}
          body="Changes go in as an addendum." action={{ label: 'Open diary', onPress: () => router.replace(`/diary/${existing.id}`) }} />
      </Screen>
    );
  }

  const payload = (submit: boolean): Omit<SaveSiteDiaryPayload, 'op_id'> => ({
    id, project_id: project.id, number: existing?.number ?? '', diary_date: date, block_id: blockId,
    weather_am: am ?? undefined, weather_pm: pm ?? undefined, rain_hours: rain.trim() ? num(rain) : undefined, weather_source: 'manual',
    work_summary: work.trim() || undefined, safety_notes: safety.trim() || undefined, notes: notes.trim() || undefined, submit,
    labour: labour.filter((l) => num(l.count) > 0).map((l) => ({ id: l.id, trade_id: l.tradeId, trade_name: l.tradeId ? undefined : l.name, headcount: Math.round(num(l.count)) })),
    equipment: equipment.filter((e) => e.name.trim()).map((e) => ({ id: e.id, equipment: e.name.trim(), qty: Math.max(1, Math.round(num(e.qty) || 1)), status: e.status, hours_worked: e.hours.trim() ? num(e.hours) : undefined })),
    delays: delays.map((d) => ({ id: d.id, cause: d.cause, hours_lost: d.hours.trim() ? num(d.hours) : undefined, description: d.text.trim() || undefined })),
    visitors: visitors.filter((v) => v.name.trim()).map((v) => ({ id: v.id, name: v.name.trim(), organisation: v.org.trim() || undefined, purpose: v.purpose.trim() || undefined })),
    instructions: instructions.filter((i) => i.text.trim()).map((i) => ({ id: i.id, given_by: i.by.trim() || undefined, instruction: i.text.trim() })),
    elements: els.map((e) => ({ id: e.id, element_id: e.elementId })),
  });

  function save(submit: boolean) {
    const e: Errors = {};
    if (submit && !am && !pm) e.weather = 'Record the weather before submitting';
    if (submit && !work.trim() && !labour.some((l) => num(l.count) > 0)) e.work = 'Record the work done or the labour on site';
    if (rain.trim() && !(num(rain) >= 0 && num(rain) <= 24)) e.rain = 'Rain hours must be between 0 and 24';
    if (date > today()) e.date = 'A diary cannot be written for a future date';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      // One diary per project/block/day: someone else's diary → add mine as an addendum.
      const other = diaryFor(project.id, date, blockId);
      if (!existing && other && other.id !== id) {
        addAsAddendum(other.id, payload(submit));
        haptic('confirm'); toast.success(`Added to ${other.number} as an addendum · saved on phone`);
        disable(); router.replace(`/diary/${other.id}`);
        return;
      }
      const p = payload(submit);
      const number = existing?.number ?? nextDocNumber(project.code, 'SD');
      enqueue('save_site_diary', { ...p, number }, { entityType: 'site_diary', entityId: id, label: `${number} ${submit ? 'submitted' : 'draft saved'}` });
      haptic('confirm');
      toast.success(submit ? `${number} submitted · saved on phone` : `${number} draft saved on phone`);
      disable();
      router.replace(`/diary/${id}`);
    } catch (err) { showError(err); }
  }

  const toggleDelay = (c: DelayCause) => {
    setDirty(true);
    setDelays((ds) => (ds.some((d) => d.cause === c) ? ds.filter((d) => d.cause !== c) : [...ds, { id: uuid(), cause: c, hours: '', text: '' }]));
  };
  const addTrade = (tradeId: string) => {
    const t = trades.find((x) => x.id === tradeId);
    if (!t || labour.some((l) => l.tradeId === tradeId)) return;
    setDirty(true);
    setLabour((ls) => [...ls, { id: uuid(), tradeId, name: t.name, count: '1' }]);
  };
  const suggested = [...new Set(summary.map((s) => s.elementId).filter((x): x is string => !!x && !els.some((e) => e.elementId === x)))];

  return (
    <Screen form={form} footer={
      <ActionBar summary={`${headcount} on site${photos ? ` · ${photos} photo${photos > 1 ? 's' : ''}` : ' · no photo yet'}`} warning={!photos}
        secondary={{ title: 'Save draft', variant: 'outline', onPress: () => save(false) }}
        primary={{ title: 'Submit', variant: 'hero', icon: 'send-outline', onPress: () => save(true) }} />
    }>
      <Stack.Screen options={{ title: existing ? `Diary · ${existing.number}` : `Site diary · ${fmtDate(date)}` }} />
      {conflict ? (
        <Banner tone="warning" title={`Diary ${conflict.existing_number} already exists for this day`}
          text="Someone else submitted this day first. Your entries can be added to it as an addendum."
          actions={[{ label: 'Add as addendum', onPress: () => { const to = resolveDiaryConflict(id); if (to) { toast.success('Added as an addendum · saved on phone'); disable(); router.replace(`/diary/${to}`); } } }]} />
      ) : null}
      {existing?.status === 'submitted' ? <Banner tone="info" text="Already submitted. Saving changes returns it to draft until you submit again." /> : null}
      {existing?.sign_comment && existing.status === 'draft' ? <Banner tone="warning" title="Returned by the reviewer" text={existing.sign_comment} /> : null}

      <Card>
        <Row align="flex-start">
          <View style={styles.flex}><DateField label="Date" value={date} onChange={touch(setDate)} error={errors.date} name="date" /></View>
        </Row>
        <BlockPicker projectId={project.id} label="Block (optional — whole site if empty)" value={blockId} onChange={touch(setBlockId)} allowClear />
      </Card>

      <Section title="Weather">
        <Card>
          <WeatherChips label="Morning" value={am} onChange={touch(setAm)} />
          <WeatherChips label="Afternoon" value={pm} onChange={touch(setPm)} />
          {errors.weather ? <Text variant="bodySm" tone="danger">{errors.weather}</Text> : null}
          {am === 'rain' || am === 'heavy_rain' || pm === 'rain' || pm === 'heavy_rain' || rain ? (
            <QuantityStepper label="Rain hours" unit="h" step={0.5} quick={[1, 2, 4]} max={24} value={rain} onChange={touch(setRain)} error={errors.rain} name="rain" />
          ) : null}
        </Card>
      </Section>

      <Section title={`Labour · ${headcount}`}>
        <Card>
          {labour.map((l, i) => (
            <Row key={l.id} align="center">
              <Text variant="body" weight="600" style={styles.trade} numberOfLines={1}>{l.name}</Text>
              <View style={styles.flex}>
                <QuantityStepper value={l.count} onChange={(v) => { setDirty(true); setLabour((ls) => ls.map((x, j) => (j === i ? { ...x, count: v } : x))); }} step={1} quick={[]} />
              </View>
              <IconButton icon="close" accessibilityLabel={`Remove ${l.name}`} onPress={() => { setDirty(true); setLabour((ls) => ls.filter((_, j) => j !== i)); }} />
            </Row>
          ))}
          {errors.work && !labour.length ? <Text variant="bodySm" tone="danger">{errors.work}</Text> : null}
          <ChipGroup label={labour.length ? 'Add trade' : 'Who was on site?'} scroll value={null} onChange={addTrade}
            options={trades.filter((t) => !labour.some((l) => l.tradeId === t.id)).map((t) => ({ value: t.id, label: t.name, icon: 'plus' as IconName }))} />
        </Card>
      </Section>

      <Section title="Equipment">
        {equipment.map((e, i) => {
          const set = (p: Partial<Equip>) => { setDirty(true); setEquipment((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x))); };
          return (
            <Card key={e.id} dense stripe={e.status === 'breakdown' ? 'danger' : e.status === 'idle' ? 'warning' : null}>
              <Row>
                <View style={styles.flex}><Field label="Equipment" value={e.name} onChangeText={(v) => set({ name: v })} /></View>
                <IconButton icon="trash-can-outline" accessibilityLabel="Remove equipment" onPress={() => { setDirty(true); setEquipment((xs) => xs.filter((_, j) => j !== i)); }} />
              </Row>
              <Segmented<EquipmentStatus> value={e.status} onChange={(v) => set({ status: v })} options={[
                { value: 'working', label: 'Working', tone: 'success' }, { value: 'idle', label: 'Idle', tone: 'warning' }, { value: 'breakdown', label: 'Breakdown', tone: 'danger' },
              ]} />
              <Row align="flex-start">
                <View style={styles.flex}><QuantityStepper label="Qty" value={e.qty} onChange={(v) => set({ qty: v })} step={1} quick={[]} /></View>
                <View style={styles.flex}><QuantityStepper label="Hours worked" unit="h" value={e.hours} onChange={(v) => set({ hours: v })} step={1} quick={[]} max={24} /></View>
              </Row>
            </Card>
          );
        })}
        <ChipGroup scroll value={null} onChange={(name) => { setDirty(true); setEquipment((xs) => [...xs, { id: uuid(), name: name === '__other' ? '' : name, qty: '1', status: 'working', hours: '' }]); }}
          options={[...EQUIPMENT.filter((n) => !equipment.some((e) => e.name === n)).map((n) => ({ value: n, label: n, icon: 'plus' as IconName })), { value: '__other', label: 'Other…' }]} />
      </Section>

      <Section title="Delays and issues">
        <Row wrap gap={space[2]}>
          {(Object.keys(DELAY_CAUSE_LABELS) as DelayCause[]).map((c) => (
            <FilterChip key={c} label={DELAY_CAUSE_LABELS[c]} selected={delays.some((d) => d.cause === c)} onPress={() => toggleDelay(c)}
              icon={delays.some((d) => d.cause === c) ? 'check' : undefined} />
          ))}
        </Row>
        {delays.map((d, i) => {
          const set = (p: Partial<Delay>) => { setDirty(true); setDelays((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x))); };
          return (
            <Card key={d.id} dense stripe="warning">
              <Text variant="label">{DELAY_CAUSE_LABELS[d.cause]}</Text>
              <QuantityStepper label="Hours lost" unit="h" step={0.5} quick={[1, 2, 4, 8]} max={24} value={d.hours} onChange={(v) => set({ hours: v })} />
              <Field label="What happened" optional value={d.text} onChangeText={(v) => set({ text: v })} multiline />
            </Card>
          );
        })}
      </Section>

      <Section title="Elements worked on">
        {els.length ? (
          <Row wrap gap={space[2]}>
            {els.map((e) => <FilterChip key={e.id} label={elementLabel(e.elementId)} selected trailingIcon="close" onPress={() => { setDirty(true); setEls((xs) => xs.filter((x) => x.id !== e.id)); }} />)}
          </Row>
        ) : null}
        {suggested.length ? (
          <Button title={`Add ${suggested.length} from today's activity`} size="sm" variant="tonal" icon="playlist-plus"
            onPress={() => { setDirty(true); setEls((xs) => [...xs, ...suggested.map((s) => ({ id: uuid(), elementId: s }))]); }} />
        ) : null}
        <ElementPicker projectId={project.id} label="Add element" value={addEl} placeholder="Select element"
          onChange={(v) => { if (v && !els.some((e) => e.elementId === v)) { setDirty(true); setEls((xs) => [...xs, { id: uuid(), elementId: v }]); } setAddEl(null); }} />
      </Section>

      <Section title="Work done">
        <Field label="Work done today" optional={labour.length > 0} value={work} onChangeText={touch(setWork)} multiline error={errors.work && labour.length ? errors.work : errors.work} name="work"
          placeholder="e.g. Rebar fixing columns C1–C8, formwork slab level 2" />
      </Section>

      <Section title="Today on site" action={summary.length ? `${summary.length}` : undefined}>
        {summary.length ? (
          <Card flush>
            {summary.slice(0, 12).map((s) => (
              <ListRow key={`${s.kind}:${s.id}`} id={s.id} title={`${s.number}`} subtitle={s.summary} icon={KIND_ICON[s.kind]} status={s.status} />
            ))}
          </Card>
        ) : <Text variant="bodySm" tone="muted">No receipts, issues, progress or pours recorded on this phone for {fmtDate(date)} yet.</Text>}
      </Section>

      <Section title="Visitors">
        {visitors.map((v, i) => {
          const set = (p: Partial<Visitor>) => { setDirty(true); setVisitors((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x))); };
          return (
            <Card key={v.id} dense>
              <Row>
                <View style={styles.flex}><Field label="Name" value={v.name} onChangeText={(t) => set({ name: t })} autoCapitalize="words" /></View>
                <IconButton icon="trash-can-outline" accessibilityLabel="Remove visitor" onPress={() => { setDirty(true); setVisitors((xs) => xs.filter((_, j) => j !== i)); }} />
              </Row>
              <Row align="flex-start">
                <View style={styles.flex}><Field label="Organisation" optional value={v.org} onChangeText={(t) => set({ org: t })} /></View>
                <View style={styles.flex}><Field label="Purpose" optional value={v.purpose} onChangeText={(t) => set({ purpose: t })} /></View>
              </Row>
            </Card>
          );
        })}
        <Button title="Add visitor" size="sm" variant="tonal" icon="plus" onPress={() => { setDirty(true); setVisitors((xs) => [...xs, { id: uuid(), name: '', org: '', purpose: '' }]); }} />
      </Section>

      <Section title="Instructions received">
        {instructions.map((x, i) => {
          const set = (p: Partial<Instr>) => { setDirty(true); setInstructions((xs) => xs.map((y, j) => (j === i ? { ...y, ...p } : y))); };
          return (
            <Card key={x.id} dense>
              <Row>
                <View style={styles.flex}><Field label="Given by" optional value={x.by} onChangeText={(t) => set({ by: t })} placeholder="Consultant / client" /></View>
                <IconButton icon="trash-can-outline" accessibilityLabel="Remove instruction" onPress={() => { setDirty(true); setInstructions((xs) => xs.filter((_, j) => j !== i)); }} />
              </Row>
              <Field label="Instruction" value={x.text} onChangeText={(t) => set({ text: t })} multiline />
            </Card>
          );
        })}
        <Button title="Add instruction" size="sm" variant="tonal" icon="plus" onPress={() => { setDirty(true); setInstructions((xs) => [...xs, { id: uuid(), by: '', text: '' }]); }} />
      </Section>

      <Section title="Safety and notes">
        <Field label="Safety incidents / near misses" optional value={safety} onChangeText={touch(setSafety)} multiline />
        <Field label="Notes" optional value={notes} onChangeText={touch(setNotes)} multiline />
      </Section>

      <PhotoStrip projectId={project.id} entityType="site_diary" entityId={id} label="Site photos" />
      {delays.length ? <Row gap={6}><Chip label={`${delays.length} delay${delays.length > 1 ? 's' : ''} recorded`} tone="warning" icon="clock-alert-outline" /></Row> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  trade: { width: 112 },
});
