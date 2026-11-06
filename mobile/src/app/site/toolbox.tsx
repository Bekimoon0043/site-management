// Record today's toolbox talk (offline): topic, hazards, attendance, PPE check, attendance-sheet photo.
import React, { useState } from 'react';
import { Stack, router } from 'expo-router';
import { useSession } from '../../lib/app';
import { enqueue, uuid } from '../../lib/sync';
import { today } from '../../lib/format';
import { TOOLBOX_TOPICS } from '../../lib/contract-site';
import { ActionBar, Card, ChipGroup, Field, PhotoStrip, Screen, haptic, showError, toast, useForm, useUnsavedGuard, type Errors } from '../../components/ui';

const TRADES = ['Mason', 'Carpenter', 'Bar bender', 'Daily labourer', 'Plasterer', 'Electrician', 'Plumber', 'Welder', 'Operator'];

export default function ToolboxTalkScreen() {
  const { project, profile } = useSession();
  const form = useForm();
  const [id] = useState(uuid);
  const [topic, setTopic] = useState('');
  const [hazards, setHazards] = useState('');
  const [count, setCount] = useState('');
  const [trades, setTrades] = useState<string[]>([]);
  const [ppe, setPpe] = useState<'yes' | 'no'>('yes');
  const [issues, setIssues] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const disable = useUnsavedGuard(!!topic || !!count, { what: 'toolbox talk' });
  const save = () => {
    const e: Errors = {};
    if (!topic.trim()) e.topic = 'Pick or type the topic';
    if (!(Number(count) > 0)) e.count = 'How many workers attended';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      enqueue('save_toolbox_talk', { id, project_id: project.id, held_on: today(), topic: topic.trim(), hazards: hazards.trim() || undefined,
        presenter_name: profile.full_name || undefined, attendees_count: Number(count), trades, ppe_checked: ppe === 'yes', ppe_issues: issues.trim() || undefined,
        duration_min: 15 }, { entityType: 'toolbox_talk', entityId: id, label: 'Toolbox talk recorded' });
      haptic('confirm'); toast.success('Toolbox talk saved');
      disable(); router.back();
    } catch (err) { showError(err); }
  };
  return (
    <Screen form={form} footer={<ActionBar summary={count ? `${count} attended` : null} primary={{ title: 'Save', variant: 'hero', icon: 'account-group-outline', onPress: save }} />}>
      <Stack.Screen options={{ title: 'Toolbox talk' }} />
      <Card>
        <Field label="Topic" value={topic} onChangeText={setTopic} error={errors.topic} name="topic" autoCapitalize="sentences" />
        <ChipGroup scroll value={null} onChange={(v) => setTopic(v)} options={TOOLBOX_TOPICS.map((t) => ({ value: t, label: t }))} />
        <Field label="Hazards discussed" optional value={hazards} onChangeText={setHazards} multiline />
      </Card>
      <Card>
        <Field label="Workers attended" value={count} onChangeText={setCount} error={errors.count} name="count" keyboardType="number-pad" />
        <ChipGroup label="Trades (tap to add)" scroll value={null} onChange={(v) => setTrades(trades.includes(v) ? trades.filter((x) => x !== v) : [...trades, v])}
          options={TRADES.map((t) => ({ value: t, label: trades.includes(t) ? `✓ ${t}` : t }))} />
        <ChipGroup<'yes' | 'no'> label="PPE checked" value={ppe} onChange={setPpe} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
        {ppe === 'yes' ? <Field label="PPE issues found" optional value={issues} onChangeText={setIssues} placeholder="e.g. 3 without helmets — issued" /> : null}
      </Card>
      <PhotoStrip projectId={project.id} entityType="toolbox_talk" entityId={id} label="Attendance sheet / photo" />
    </Screen>
  );
}
