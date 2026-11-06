// Shared field & quality UI bits: weather chips, severity info, mix-design picker and
// the diary "already exists → add as addendum" resolution (used by diary edit/detail).
import React from 'react';
import { View } from 'react-native';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { list } from '../lib/db';
import { getDb, kvGet, kvSet } from '../lib/db';
import { useData } from '../lib/app';
import { discardOp, enqueue, uuid, type OutboxEntry } from '../lib/sync';
import { elementLabel } from '../lib/queries';
import { mixDesigns } from '../lib/field';
import {
  DELAY_CAUSE_LABELS, canField, type LabourTrade, type SaveSiteDiaryPayload, type SnagSeverity, type Weather,
} from '../lib/contract-field';
import type { Tone } from '../theme';
import type { Href } from 'expo-router';
import type { AppRole } from '../lib/contract';
import type { FieldCounts } from '../lib/counts';
import { today } from '../lib/format';
import { ChipGroup, Picker, SelectField, type IconName, type Option } from './ui';

export const WEATHER_INFO: Record<Weather, { label: string; icon: IconName }> = {
  sunny: { label: 'Sunny', icon: 'weather-sunny' }, cloudy: { label: 'Cloudy', icon: 'weather-cloudy' },
  rain: { label: 'Rain', icon: 'weather-rainy' }, heavy_rain: { label: 'Heavy rain', icon: 'weather-pouring' },
  windy: { label: 'Windy', icon: 'weather-windy' }, fog: { label: 'Fog', icon: 'weather-fog' },
};

export function WeatherChips({ label, value, onChange }: { label: string; value: Weather | null; onChange: (w: Weather) => void }) {
  return (
    <ChipGroup<Weather> label={label} scroll value={value} onChange={onChange}
      options={(Object.keys(WEATHER_INFO) as Weather[]).map((w) => ({ value: w, label: WEATHER_INFO[w].label, icon: WEATHER_INFO[w].icon }))} />
  );
}

export const SEVERITY_INFO: Record<SnagSeverity, { label: string; tone: Tone; icon: IconName }> = {
  low: { label: 'Low', tone: 'neutral', icon: 'information-outline' },
  medium: { label: 'Medium', tone: 'info', icon: 'alert-circle-outline' },
  high: { label: 'High', tone: 'warning', icon: 'alert-outline' },
  critical: { label: 'Critical', tone: 'danger', icon: 'alert-octagon-outline' },
};

export function MixDesignPicker({ projectId, value, onChange, error, name }: { projectId: string; value: string | null; onChange: (id: string | null) => void; error?: string | null; name?: string }) {
  const options = useData(() => mixDesigns(projectId).filter((m) => !m.deleted_at).map<Option>((m) => ({
    id: m.id, label: `${m.code} · ${m.grade}`, sub: `${m.source === 'site' ? 'Site batched' : 'Ready-mix'} · fck ${m.target_strength_mpa} MPa${m.target_slump_mm ? ` · slump ${m.target_slump_mm} mm` : ''}`,
  })), [projectId]);
  return <Picker label="Mix design" value={value} onChange={onChange} options={options} error={error} name={name} recentKey={`mix:${projectId}`} />;
}

// ---------------------------------------------------------------------------
// Diary conflict → addendum
// ---------------------------------------------------------------------------

export interface DiaryConflict { existing_id: string; existing_number: string }
export const diaryConflict = (diaryId: string): DiaryConflict | null => {
  const v = kvGet(`diary-conflict:${diaryId}`);
  return v ? (JSON.parse(v) as DiaryConflict) : null;
};

/** Plain-text addendum from a diary payload (sections that were filled in). */
export function addendumText(x: Omit<SaveSiteDiaryPayload, 'op_id'>): string {
  const trades = new Map(list<LabourTrade>('labour_trades').map((t) => [t.id, t.name]));
  const parts: string[] = [];
  if (x.weather_am || x.weather_pm) parts.push(`Weather: AM ${x.weather_am ? WEATHER_INFO[x.weather_am].label : '—'} / PM ${x.weather_pm ? WEATHER_INFO[x.weather_pm].label : '—'}${x.rain_hours ? `, rain ${x.rain_hours} h` : ''}`);
  if (x.labour?.length) parts.push(`Labour: ${x.labour.map((l) => `${(l.trade_id && trades.get(l.trade_id)) || l.trade_name || 'Trade'} ${l.headcount}`).join(', ')}`);
  if (x.equipment?.length) parts.push(`Equipment: ${x.equipment.map((e) => `${e.equipment}${e.qty && e.qty > 1 ? ` ×${e.qty}` : ''}${e.status && e.status !== 'working' ? ` (${e.status})` : ''}`).join(', ')}`);
  if (x.delays?.length) parts.push(`Delays: ${x.delays.map((d) => `${DELAY_CAUSE_LABELS[d.cause]}${d.hours_lost ? ` ${d.hours_lost} h` : ''}${d.description ? ` — ${d.description}` : ''}`).join('; ')}`);
  if (x.visitors?.length) parts.push(`Visitors: ${x.visitors.map((v) => `${v.name}${v.organisation ? ` (${v.organisation})` : ''}`).join(', ')}`);
  if (x.instructions?.length) parts.push(`Instructions: ${x.instructions.map((i) => `${i.given_by ? `${i.given_by}: ` : ''}${i.instruction}`).join('; ')}`);
  if (x.elements?.length) parts.push(`Elements worked on: ${x.elements.map((e) => elementLabel(e.element_id)).join(', ')}`);
  if (x.work_summary) parts.push(`Work done: ${x.work_summary}`);
  if (x.safety_notes) parts.push(`Safety: ${x.safety_notes}`);
  if (x.notes) parts.push(`Notes: ${x.notes}`);
  return parts.join('\n') || 'No details';
}

/** Post a diary payload as an addendum to the existing diary of that day. */
export function addAsAddendum(existingId: string, x: Omit<SaveSiteDiaryPayload, 'op_id'>) {
  const id = uuid();
  enqueue('add_diary_addendum', { id, diary_id: existingId, text: addendumText(x) }, { entityType: 'site_diary', entityId: existingId, label: 'Diary addendum' });
}

/** Resolve a server "exists" conflict: re-post the rejected diary as an addendum and drop the rejected op. */
export function resolveDiaryConflict(diaryId: string): string | null {
  const c = diaryConflict(diaryId);
  const failed = getDb().getFirstSync<OutboxEntry>(
    `SELECT * FROM outbox WHERE entity_id = ? AND rpc = 'save_site_diary' AND status = 'failed' ORDER BY seq DESC LIMIT 1`, [diaryId]);
  if (!c || !failed) return null;
  // the newest save carries the full diary (sections are replace-by-id)
  const all = getDb().getAllSync<OutboxEntry>(
    `SELECT * FROM outbox WHERE entity_id = ? AND rpc = 'save_site_diary' AND status IN ('failed','pending') ORDER BY seq DESC`, [diaryId]);
  const payload = JSON.parse(all[0]?.payload ?? failed.payload) as SaveSiteDiaryPayload;
  addAsAddendum(c.existing_id, payload);
  for (const e of all) discardOp(e.id);   // newest first, so each rollback restores the previous copy
  kvSet(`diary-conflict:${diaryId}`, null);
  return c.existing_id;
}

// ---------------------------------------------------------------------------
// Time of day (truck tickets): defaults to now, quick chips, native time dialog
// ---------------------------------------------------------------------------

const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

export function TimeField({ label, value, onChange, optional, quick = [0, -15, -30, -60] }: {
  label: string; value: string | null; onChange: (iso: string | null) => void; optional?: boolean; quick?: number[];
}) {
  const pick = () => DateTimePickerAndroid.open({
    value: value ? new Date(value) : new Date(), mode: 'time', is24Hour: true,
    onChange: (ev, d) => { if (ev.type === 'set' && d) onChange(d.toISOString()); },
  });
  return (
    <View style={{ gap: 4 }}>
      <SelectField label={label} optional={optional} value={value ? hhmm(value) : null} placeholder="Set time" icon="clock-outline" onPress={pick}
        onClear={optional && value ? () => onChange(null) : undefined} />
      <ChipGroup<string> scroll value={null} onChange={(m) => onChange(new Date(Date.now() + Number(m) * 60e3).toISOString())}
        options={quick.map((m) => ({ value: String(m), label: m === 0 ? 'Now' : `${-m} min ago` }))} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Home "Needs you" items for field & quality (counts from counts.ts fieldCounts)
// ---------------------------------------------------------------------------

export interface FieldTask { id: string; icon: IconName; tone: Tone; stripe: Tone; title: string; sub: string; href: Href }

export function fieldTasks(role: AppRole, c: FieldCounts): { tasks: FieldTask[]; total: number } {
  const tasks: FieldTask[] = [];
  let total = 0;
  const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;
  if (role === 'site_engineer' && c.diaryToday !== 'submitted' && c.diaryToday !== 'signed' && new Date().getHours() >= 12) {
    tasks.push({ id: 'diary', icon: 'notebook-edit-outline', tone: 'warning', stripe: 'warning', title: c.diaryToday === 'draft' ? "Today's diary is a draft" : "Today's diary not submitted",
      sub: 'Weather, labour and work done · about 2 min', href: `/diary/edit?date=${today()}` });
    total += 1;
  }
  if (c.snagsMine && (role === 'site_engineer' || !canField(role, 'snag.review'))) {
    tasks.push({ id: 'snags', icon: 'bug-outline', tone: c.snagsOverdue ? 'danger' : 'warning', stripe: c.snagsOverdue ? 'danger' : 'warning',
      title: `${plural(c.snagsMine, 'snag')} assigned to you`, sub: c.snagsOverdue ? `${c.snagsOverdue} overdue on the project` : 'Fix, add an after photo, mark ready', href: '/snags?filter=mine' });
    total += c.snagsMine;
  }
  if (c.cubesDue && canField(role, 'cube.sample')) {
    tasks.push({ id: 'cubes', icon: 'test-tube', tone: 'info', stripe: 'info', title: `${plural(c.cubesDue, 'cube test')} due`,
      sub: canField(role, 'cube.results') ? 'Enter the lab results' : 'Send the cubes to the lab', href: '/pours/cubes' });
    total += c.cubesDue;
  }
  if (c.diariesToSign && canField(role, 'diary.sign')) {
    tasks.push({ id: 'sign', icon: 'draw-pen', tone: 'info', stripe: 'info', title: `${plural(c.diariesToSign, 'site diary')} to sign`.replace('diarys', 'diaries'), sub: 'Check and sign off', href: '/diary?filter=sign' });
    total += c.diariesToSign;
  }
  if (c.inspectionsRequested && canField(role, 'inspection.perform')) {
    tasks.push({ id: 'ins', icon: 'clipboard-check-outline', tone: 'warning', stripe: 'warning', title: `${plural(c.inspectionsRequested, 'inspection')} requested`, sub: 'Hold points waiting for you', href: '/inspections?filter=requested' });
    total += c.inspectionsRequested;
  }
  if (c.snagsToReview && canField(role, 'snag.review')) {
    tasks.push({ id: 'review', icon: 'eye-outline', tone: 'info', stripe: 'info', title: `${plural(c.snagsToReview, 'snag')} ready for review`, sub: 'Close or reopen', href: '/snags?filter=review' });
    total += c.snagsToReview;
  }
  if (c.trucksAwaiting && canField(role, 'pour.receiveTruck')) {
    tasks.push({ id: 'trucks', icon: 'dump-truck', tone: 'warning', stripe: 'warning', title: `${plural(c.trucksAwaiting, 'ready-mix truck')} to receive`, sub: 'GRN + issue to the pour', href: '/pours/receive' });
    total += c.trucksAwaiting;
  }
  return { tasks, total };
}
