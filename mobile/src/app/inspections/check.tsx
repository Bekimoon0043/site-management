// Request / do an inspection from an element's hold-point activity (features C1).
// ?id=<requested inspection> completes a request; ?element=&activity=[&template=] starts one.
// Site engineers request; office engineers / management perform: yes-no items as big
// pass / fail toggles, measured values checked against the tolerance, photo items,
// critical markers. Failed critical items raise snags automatically (server rule).
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get, list } from '../../lib/db';
import type { Attachment, Element, ElementActivity } from '../../lib/contract';
import { canField, type ChecklistTemplateItem, type Inspection, type ItemResponse } from '../../lib/contract-field';
import { evaluateItem, holdPointState, outcomeOf, templateItems, templatesFor, type ItemAnswer } from '../../lib/field';
import { localPhotos } from '../../lib/photos';
import { elementLabel } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { num } from '../../lib/format';
import { space } from '../../theme';
import {
  ActionBar, Banner, Card, Chip, EmptyState, Field, ListRow, PhotoStrip, Row, Screen, Section, Segmented, Text, haptic, showError, toast,
  useForm, useUnsavedGuard, type Errors,
} from '../../components/ui';
import { DateField, PersonPicker } from '../../components/pickers';

const photoCount = (entityId: string) => {
  const l = localPhotos(entityId);
  const ids = new Set(l.map((x) => x.id));
  return l.length + list<Attachment>('attachments', { parent: entityId }).filter((a) => !ids.has(a.id)).length;
};

interface Answer extends ItemAnswer { id: string; snag: boolean; raw: string }

export default function InspectionCheck() {
  const { profile, project } = useSession();
  const params = useLocalSearchParams<{ id?: string; element?: string; activity?: string; template?: string; reinspect?: string }>();
  const form = useForm();
  const req = useMemo(() => (params.id ? get<Inspection>('inspections', params.id) : null), [params.id]);
  const elementId = req?.element_id ?? params.element ?? null;
  const activityId = req?.element_activity_id ?? params.activity ?? null;
  const [templateId, setTemplateId] = useState<string | null>(req?.template_id ?? params.template ?? null);
  const [id] = useState(() => req?.id ?? uuid());
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [consultant, setConsultant] = useState('');
  const [remarks, setRemarks] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [requestFor, setRequestFor] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const canPerform = canField(profile.role, 'inspection.perform');
  const [touched, setTouched] = useState(false);
  const disable = useUnsavedGuard(touched, { what: 'inspection' });

  const el = useData(() => (elementId ? get<Element>('elements', elementId) : null), [elementId]);
  const act = useData(() => (activityId ? get<ElementActivity>('element_activities', activityId) : null), [activityId]);
  const choices = useData(() => (el ? templatesFor(project.id, el.element_type, act?.is_hold_point ? act.name : null) : []), [project.id, el?.element_type, act?.name]);
  const items = useData(() => (templateId ? templateItems(templateId) : []), [templateId]);
  const hold = useData(() => (activityId ? holdPointState(project.id, activityId) : null), [project.id, activityId]);
  useEffect(() => { if (!templateId && choices.length === 1) setTemplateId(choices[0].id); }, [choices, templateId]);
  // one stable id per item (inspection_items.id + photo entity) as soon as the checklist is known
  useEffect(() => {
    setAnswers((s) => { const n = { ...s }; for (const ti of items) if (!n[ti.id]) n[ti.id] = { id: uuid(), snag: true, raw: '' }; return n; });
  }, [items]);
  // when the hold point still needs several checklists, preselect the first pending one
  useEffect(() => { if (!templateId && hold?.pending.length) setTemplateId(hold.pending[0].id); }, [hold, templateId]);

  if (!el) return <Screen><Stack.Screen options={{ title: 'Inspection' }} /><EmptyState icon="pillar" title="Element not on this phone" /></Screen>;
  const tpl = templateId ? choices.find((c) => c.id === templateId) ?? get<{ id: string; name: string; code: string }>('checklist_templates', templateId) : null;

  const set = (ti: ChecklistTemplateItem, p: Partial<Answer>) => {
    setTouched(true);
    setAnswers((s) => ({ ...s, [ti.id]: { ...(s[ti.id] ?? { id: uuid(), snag: true, raw: '' }), ...p } }));
  };
  const resp = (ti: ChecklistTemplateItem) => evaluateItem(ti, answers[ti.id]);
  const evaluated = items.map((ti) => ({ ti, response: resp(ti) }));
  const answered = evaluated.filter((e) => e.response).length;
  const preview = outcomeOf(evaluated.map((e) => ({ is_critical: e.ti.is_critical, response: e.response })));
  const failedCritical = evaluated.filter((e) => e.response === 'fail' && e.ti.is_critical).length;

  const request = () => {
    if (!templateId) { setErrors({ template: 'Choose the checklist' }); return; }
    try {
      const number = nextDocNumber(project.code, 'INS');
      enqueue('request_inspection', {
        id, project_id: project.id, number, template_id: templateId, element_id: el.id, element_activity_id: activityId ?? undefined,
        requested_for: requestFor ? new Date(`${requestFor}T08:00:00`).toISOString() : undefined, remarks: remarks.trim() || undefined,
        reinspection_of: params.reinspect || undefined,
      }, { entityType: 'inspection', entityId: id, label: `${number} requested` });
      haptic('confirm'); toast.success(`${number} requested · saved on phone`);
      disable(); router.replace(`/inspections/${id}`);
    } catch (err) { showError(err); }
  };

  const submit = () => {
    const e: Errors = {};
    if (!templateId) e.template = 'Choose the checklist';
    for (const { ti, response } of evaluated) {
      const a = answers[ti.id];
      if (!response) e[`i${ti.id}`] = ti.item_type === 'value' ? 'Enter the measured value' : 'Pass or fail?';
      else if (response === 'na' && ti.is_critical) e[`i${ti.id}`] = 'Critical items cannot be N/A';
      else if (ti.photo_required && response !== 'na' && photoCount(a?.id ?? '') === 0) e[`i${ti.id}`] = 'Take the photo';
    }
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      const number = req?.number ?? nextDocNumber(project.code, 'INS');
      enqueue('submit_inspection', {
        id, ...(req ? {} : { project_id: project.id, number, template_id: templateId!, element_id: el.id, element_activity_id: activityId ?? undefined, reinspection_of: params.reinspect || undefined }),
        inspected_at: new Date().toISOString(), consultant_name: consultant.trim() || undefined, remarks: remarks.trim() || undefined,
        items: evaluated.map(({ ti, response }) => {
          const a = answers[ti.id]!;
          const snag = response === 'fail' && (ti.is_critical || a.snag);
          return {
            id: a.id, template_item_id: ti.id, response: ti.item_type === 'value' && response !== 'na' ? undefined : response ?? undefined,
            value_num: a.value_num, value_text: a.value_text?.trim() || undefined,
            ...(snag ? { create_snag: true, snag_id: uuid(), snag_number: `${number}-S${ti.seq}` } : {}),
          };
        }),
        snag_defaults: assignee || due ? { assignee_user_id: assignee ?? undefined, due_date: due ?? undefined } : undefined,
      }, { entityType: 'inspection', entityId: id, label: `${number} ${preview}` });
      haptic(preview === 'fail' ? 'reject' : 'confirm');
      toast.success(`${number}: ${preview} · saved on phone`);
      disable(); router.replace(`/inspections/${id}?done=1`);
    } catch (err) { showError(err); }
  };

  const summary = canPerform && templateId ? `${answered}/${items.length} answered · ${answered === items.length ? (preview === 'fail' ? 'Fail' : preview === 'conditional' ? 'Conditional' : 'Pass') : 'in progress'}` : null;
  return (
    <Screen form={form} footer={templateId ? (
      canPerform ? <ActionBar summary={summary} warning={preview !== 'pass'}
        primary={{ title: 'Submit inspection', variant: 'hero', icon: 'clipboard-check-outline', onPress: submit }}
        secondary={!req ? { title: 'Request instead', variant: 'outline', onPress: request } : null} />
        : <ActionBar primary={{ title: 'Request inspection', variant: 'hero', icon: 'send-outline', onPress: request }} />
    ) : undefined}>
      <Stack.Screen options={{ title: req ? `Inspect · ${req.number}` : canPerform ? 'Inspection' : 'Request inspection' }} />
      <Card>
        <Text variant="titleSm">{elementLabel(el.id)} · {el.element_type}</Text>
        {act ? <Row wrap gap={6}><Chip label={act.name} icon={act.is_hold_point ? 'hand-back-left-outline' : 'format-list-checks'} tone={act.is_hold_point ? 'warning' : 'neutral'} />
          {hold?.cleared ? <Chip label="Hold point cleared" tone="success" icon="check" /> : null}</Row> : null}
        {hold && hold.pending.length > 1 ? <Text variant="bodySm" tone="muted">Needs to pass: {hold.pending.map((p) => p.name).join(', ')}</Text> : null}
        {params.reinspect ? <Banner tone="info" text="Re-inspection: a new record linked to the failed one." /> : null}
      </Card>

      {!req ? (
        <Section title="Checklist">
          {choices.length ? (
            <Card flush>
              {choices.map((c) => (
                <ListRow key={c.id} id={c.id} title={c.name} subtitle={`${c.code}${hold?.pending.some((p) => p.id === c.id) ? ' · needed for this hold point' : ''}`}
                  icon={templateId === c.id ? 'radiobox-marked' : 'radiobox-blank'} iconTone={templateId === c.id ? 'primary' : 'neutral'} onPress={setTemplateId} />
              ))}
            </Card>
          ) : <EmptyState compact icon="clipboard-alert-outline" title="No checklist for this element type" body="Ask the office engineer to set one up on the web console." />}
          {errors.template ? <Text variant="bodySm" tone="danger">{errors.template}</Text> : null}
        </Section>
      ) : <Card dense><Text variant="label">{tpl?.name}</Text>{req.remarks ? <Text variant="bodySm" tone="muted">{req.remarks}</Text> : null}</Card>}

      {templateId && !canPerform ? (
        <Card>
          <Text variant="bodySm" tone="muted">The office engineer is notified and does the inspection. The hold point clears when it passes.</Text>
          <DateField label="Inspection wanted on" optional quick value={requestFor} onChange={setRequestFor} />
          <Field label="Note for the inspector" optional value={remarks} onChangeText={setRemarks} multiline placeholder="e.g. Rebar fixed, ready from 2 pm" />
        </Card>
      ) : null}

      {templateId && canPerform ? (
        <>
          {items.map((ti) => {
            const a = answers[ti.id];
            const r = resp(ti);
            const err = errors[`i${ti.id}`];
            const range = ti.min_value != null || ti.max_value != null ? `${ti.min_value ?? '…'}–${ti.max_value ?? '…'}${ti.unit ? ` ${ti.unit}` : ''}` : null;
            return (
              <Card key={ti.id} stripe={err ? 'danger' : r === 'fail' ? 'danger' : r === 'pass' ? 'success' : r === 'na' ? 'neutral' : ti.is_critical ? 'warning' : null}>
                <Row align="flex-start">
                  <Text variant="body" weight="600" style={styles.flex}>{ti.seq}. {ti.text}</Text>
                  {ti.is_critical ? <Chip label="Critical" tone="danger" icon="alert-octagon-outline" small /> : null}
                </Row>
                {ti.item_type === 'value' ? (
                  <Field label={`Measured${ti.unit ? ` (${ti.unit})` : ''}`} keyboardType="decimal-pad" value={a?.raw ?? ''} name={`i${ti.id}`} error={err}
                    hint={range ? `Allowed ${range}` : null}
                    onChangeText={(v) => set(ti, { raw: v, value_num: v.trim() ? num(v) : undefined, response: undefined })} />
                ) : ti.item_type === 'text' ? (
                  <Field label="Note" optional value={a?.value_text ?? ''} onChangeText={(v) => set(ti, { value_text: v })} multiline name={`i${ti.id}`} error={err} />
                ) : (
                  <View style={styles.gap}>
                    <Segmented<ItemResponse> value={(a?.response ?? '') as ItemResponse} onChange={(v) => set(ti, { response: v })}
                      options={[
                        { value: 'pass', label: 'Pass', icon: 'check', tone: 'success' }, { value: 'fail', label: 'Fail', icon: 'close', tone: 'danger' },
                        ...(ti.is_critical ? [] : [{ value: 'na' as ItemResponse, label: 'N/A', tone: 'neutral' as const }]),
                      ]} />
                    {err ? <Text variant="bodySm" tone="danger">{err}</Text> : null}
                  </View>
                )}
                {ti.item_type === 'value' && r ? <Row gap={6}><Chip label={r === 'pass' ? 'Within tolerance' : 'Out of tolerance'} tone={r === 'pass' ? 'success' : 'danger'} icon={r === 'pass' ? 'check' : 'alert-outline'} small /></Row> : null}
                {ti.item_type === 'photo' || ti.photo_required ? (
                  <PhotoStrip projectId={project.id} entityType="inspection_item" entityId={a?.id ?? ti.id} label={ti.photo_required ? 'Photo (required)' : 'Photo'} />
                ) : null}
                {r === 'fail' ? (
                  ti.is_critical
                    ? <Banner tone="danger" icon="bug-outline" text="A snag will be raised automatically for this critical item." />
                    : <Segmented<'yes' | 'no'> label="Raise a snag?" value={a?.snag === false ? 'no' : 'yes'} onChange={(v) => set(ti, { snag: v === 'yes' })}
                        options={[{ value: 'yes', label: 'Raise snag', icon: 'bug-outline' }, { value: 'no', label: 'No snag' }]} />
                ) : null}
              </Card>
            );
          })}
          {failedCritical || evaluated.some((e) => e.response === 'fail') ? (
            <Section title="Snags from this inspection">
              <Card>
                <PersonPicker projectId={project.id} label="Assign snags to" optional allowClear value={assignee} onChange={setAssignee} />
                <DateField label="Fix by" optional quick value={due} onChange={setDue} />
              </Card>
            </Section>
          ) : null}
          <Card>
            <Field label="Consultant / witness" optional value={consultant} onChangeText={setConsultant} autoCapitalize="words" />
            <Field label="Remarks" optional value={remarks} onChangeText={setRemarks} multiline />
          </Card>
          <PhotoStrip projectId={project.id} entityType="inspection" entityId={id} label="Inspection photos" />
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 }, gap: { gap: space[1] } });
