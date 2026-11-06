// Raise a snag (features C2): camera opens first, then title, severity chips, trade,
// assignee (user or subcontractor), due date and element. ?element= / ?source= pre-fill.
import React, { useEffect, useRef, useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSession } from '../../lib/app';
import type { SnagSeverity, SnagSource } from '../../lib/contract-field';
import { capturePhoto } from '../../lib/photos';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { addDays, today } from '../../lib/format';
import {
  ActionBar, Card, ChipGroup, Field, PhotoStrip, Screen, haptic, showError, toast, useForm, usePhotoCount, useUnsavedGuard, type Errors,
} from '../../components/ui';
import { DateField, ElementPicker, PersonPicker } from '../../components/pickers';
import { SEVERITY_INFO } from '../../components/field';

const TRADES = ['Concrete', 'Rebar', 'Formwork', 'Masonry', 'Plaster', 'Finishing', 'Electrical', 'Plumbing', 'Safety'];
const QUICK = ['Honeycombing', 'Low cover', 'Out of plumb', 'Cracks', 'Missing ties', 'Poor finish', 'Safety hazard'];

export default function NewSnag() {
  const { project } = useSession();
  const params = useLocalSearchParams<{ element?: string; source?: SnagSource; source_id?: string; title?: string }>();
  const form = useForm();
  const [id] = useState(uuid);
  const [title, setTitle] = useState(params.title ?? '');
  const [severity, setSeverity] = useState<SnagSeverity>('medium');
  const [trade, setTrade] = useState<string | null>(null);
  const [elementId, setElementId] = useState<string | null>(params.element ?? null);
  const [location, setLocation] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [party, setParty] = useState('');
  const [due, setDue] = useState<string | null>(addDays(today(), 3));
  const [desc, setDesc] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const photos = usePhotoCount(id);
  const disable = useUnsavedGuard(!!title || photos > 0, { what: 'snag' });
  const opened = useRef(false);

  // photo first
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void capturePhoto({ projectId: project.id, entityType: 'snag', entityId: id }, 'camera').catch(() => undefined);
  }, [id, project.id]);

  const save = () => {
    const e: Errors = {};
    if (!title.trim()) e.title = 'Say what is wrong';
    if (!elementId && !location.trim()) e.element = 'Choose the element or describe the location';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      const number = nextDocNumber(project.code, 'SNG');
      enqueue('save_snag', {
        id, project_id: project.id, number, element_id: elementId ?? undefined, location_text: location.trim() || undefined,
        category: 'quality', trade: trade ?? undefined, severity, title: title.trim(), description: desc.trim() || undefined,
        assignee_user_id: assignee ?? undefined, assignee_party: party.trim() || undefined, due_date: due ?? undefined,
        source_type: params.source ?? 'walk', source_id: params.source_id || undefined,
      }, { entityType: 'snag', entityId: id, label: `${number} raised` });
      haptic('confirm'); toast.success(`${number} raised · saved on phone`);
      disable(); router.replace(`/snags/${id}`);
    } catch (err) { showError(err); }
  };

  return (
    <Screen form={form} footer={<ActionBar summary={photos ? `${photos} photo${photos > 1 ? 's' : ''}` : 'No photo yet'} warning={!photos}
      primary={{ title: 'Raise snag', variant: 'hero', icon: 'bug-outline', onPress: save }} />}>
      <Stack.Screen options={{ title: 'Raise snag' }} />
      <PhotoStrip projectId={project.id} entityType="snag" entityId={id} label="Photo of the defect" required={1} />
      <Card>
        <Field label="What is wrong" value={title} onChangeText={setTitle} error={errors.title} name="title" autoCapitalize="sentences" />
        <ChipGroup scroll value={null} onChange={(v) => setTitle(v)} options={QUICK.map((q) => ({ value: q, label: q }))} />
        <ChipGroup<SnagSeverity> label="Severity" value={severity} onChange={setSeverity}
          options={(Object.keys(SEVERITY_INFO) as SnagSeverity[]).map((s) => ({ value: s, label: SEVERITY_INFO[s].label, icon: SEVERITY_INFO[s].icon, tone: SEVERITY_INFO[s].tone }))} />
        <ChipGroup label="Trade" scroll value={trade} onChange={setTrade} options={TRADES.map((t) => ({ value: t, label: t }))} />
      </Card>
      <Card>
        <ElementPicker projectId={project.id} value={elementId} onChange={setElementId} error={errors.element} name="element" allowClear />
        <Field label="Location" optional={!!elementId} value={location} onChangeText={setLocation} placeholder="e.g. Grid B/3, north face" />
      </Card>
      <Card>
        <PersonPicker projectId={project.id} label="Assign to" optional allowClear value={assignee} onChange={setAssignee} />
        {!assignee ? <Field label="…or subcontractor / gang" optional value={party} onChangeText={setParty} autoCapitalize="words" /> : null}
        <DateField label="Fix by" optional quick value={due} onChange={setDue} />
      </Card>
      <Field label="Details" optional value={desc} onChangeText={setDesc} multiline />
    </Screen>
  );
}
