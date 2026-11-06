// Cube set: sampling facts, results per test age and lab results entry (office engineer).
// Each cube passes if strength ≥ fck × age factor (28 d: ≥ fck − 4); the 28-day set passes
// if mean ≥ fck and every cube ≥ fck − 4. A 28-day failure raises a critical snag.
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../../lib/app';
import { get } from '../../../lib/db';
import { canField, type CubeSet, type Pour } from '../../../lib/contract-field';
import { cubeAgeFactor, cubePasses, cubeResults, cubeStrength, localDate } from '../../../lib/field';
import { elementLabel, personName } from '../../../lib/queries';
import { enqueue, uuid } from '../../../lib/sync';
import { addDays, fmtDate, fmtDateTime, num, today } from '../../../lib/format';
import { space } from '../../../theme';
import {
  ActionBar, Banner, Card, Chip, ChipGroup, EmptyState, InfoRow, ListRow, PhotoStrip, QuantityStepper, Row, Screen, Section, Segmented, StatusChip,
  SyncError, Text, haptic, toast, useForm, type Errors,
} from '../../../components/ui';

const LABELS = 'ABCDEFGHIJ'.split('');

export default function CubeSetScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useSession();
  const form = useForm();
  const d = useData(() => {
    const c = get<CubeSet>('cube_sets', id);
    return c ? { c, results: cubeResults(id), pour: get<Pour>('pours', c.pour_id) } : null;
  }, [id]);
  const [age, setAge] = useState<string | null>(null);
  const [mode, setMode] = useState<'kn' | 'mpa'>('kn');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Errors>({});
  if (!d) return <Screen><Stack.Screen options={{ title: 'Cube set' }} /><EmptyState icon="cloud-off-outline" title="Not on this phone yet" /></Screen>;
  const { c, results, pour } = d;
  const fck = Number(c.required_strength_mpa);
  const sampled = localDate(c.sampled_at);
  const doneAges = new Set(results.map((r) => Number(r.age_days)));
  const openAges = c.test_ages.filter((a) => !doneAges.has(Number(a)));
  const selAge = age ? Number(age) : openAges[0] ?? null;
  const canEnter = canField(profile.role, 'cube.results') && selAge != null;
  const labels = LABELS.slice(0, Math.min(c.cubes_count, LABELS.length));
  const strength = (k: string) => { const v = vals[k]; if (!v?.trim()) return null; return mode === 'kn' ? cubeStrength(num(v), c.cube_size_mm) : num(v); };
  const entered = labels.map((l) => ({ l, s: strength(l) })).filter((x) => x.s != null && Number.isFinite(x.s)) as { l: string; s: number }[];
  const mean = entered.length ? entered.reduce((s, x) => s + x.s, 0) / entered.length : null;
  const setPass = selAge != null && selAge >= 28 && mean != null ? mean >= fck && entered.every((x) => x.s >= fck - 4) : null;

  const save = () => {
    if (selAge == null) return;
    const e: Errors = {};
    if (!entered.length) e.c0 = 'Enter at least one cube result';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    const fail28 = setPass === false;
    enqueue('record_cube_results', {
      cube_set_id: c.id,
      results: entered.map((x) => ({ id: uuid(), cube_label: `${c.number}-${x.l}`, age_days: selAge, tested_on: today(),
        ...(mode === 'kn' ? { load_kn: num(vals[x.l]) } : { strength_mpa: x.s }) })),
      snag: fail28 ? { id: uuid(), number: `${c.number}-S1` } : undefined,
    }, { entityType: 'cube_set', entityId: c.id, label: `${c.number} ${selAge}-day results` });
    haptic(fail28 ? 'reject' : 'confirm');
    toast.success(fail28 ? `${c.number} failed at 28 days · critical snag raised` : `${c.number} ${selAge}-day results saved on phone`);
    setVals({}); setAge(null);
  };

  return (
    <Screen form={form} footer={canEnter ? <ActionBar summary={mean != null ? `Mean ${mean.toFixed(1)} MPa · fck ${fck}` : `${selAge}-day test`} warning={setPass === false}
      primary={{ title: 'Save results', variant: 'hero', icon: 'check', onPress: save }} /> : undefined}>
      <Stack.Screen options={{ title: c.number }} />
      <SyncError entityId={c.id} />
      <Card stripe={c.result_28d === 'fail' ? 'danger' : c.result_28d === 'pass' ? 'success' : c.result_early === 'low' ? 'warning' : null}>
        <Row wrap gap={6}>
          {c.result_28d ? <StatusChip status={c.result_28d} label={`28 days: ${c.result_28d}`} /> : <Chip label="28 days pending" icon="timer-sand" />}
          {c.result_early ? <StatusChip status={c.result_early} label={`Early: ${c.result_early}`} /> : null}
        </Row>
        <InfoRow label="Pour" value={pour ? `${pour.number} · ${fmtDate(pour.pour_date)}` : '—'} />
        {c.element_id ? <InfoRow label="Element" value={elementLabel(c.element_id)} /> : null}
        <InfoRow label="Sampled" value={fmtDateTime(c.sampled_at)} />
        <InfoRow label="Set" value={`${c.cubes_count} × ${c.cube_size_mm} mm · tests at ${c.test_ages.join(' / ')} days`} />
        <InfoRow label="Required" value={`fck ${fck} MPa`} />
        {c.mean_28d_mpa != null ? <InfoRow label="28-day mean" value={`${c.mean_28d_mpa} MPa`} strong tone={c.result_28d === 'fail' ? 'danger' : 'success'} /> : null}
        {c.lab_name ? <InfoRow label="Lab" value={c.lab_name} /> : null}
      </Card>
      {c.snag_id ? (
        <Card flush><ListRow id={c.snag_id} title="Critical snag raised" subtitle={get<{ number: string }>('snags', c.snag_id)?.number ?? ''} icon="bug-outline" iconTone="danger" chevron onPress={(x) => router.push(`/snags/${x}`)} /></Card>
      ) : null}

      <Section title="Tests">
        <Card flush>
          {c.test_ages.map((a) => {
            const rs = results.filter((r) => Number(r.age_days) === Number(a));
            const due = addDays(sampled, Number(a));
            return (
              <ListRow key={a} id={String(a)} title={`${a}-day test`} icon="test-tube"
                subtitle={rs.length ? rs.map((r) => `${r.cube_label.split('-').pop()} ${Number(r.strength_mpa).toFixed(1)}`).join(' · ') + ' MPa' : `Due ${fmtDate(due)}`}
                chip={rs.length ? { label: rs.every((r) => r.passed) ? 'All pass' : 'Low', tone: rs.every((r) => r.passed) ? 'success' : 'danger', icon: rs.every((r) => r.passed) ? 'check' : 'alert-outline' }
                  : due < today() ? { label: 'Overdue', tone: 'danger', icon: 'clock-alert-outline' } : due === today() ? { label: 'Due today', tone: 'warning', icon: 'calendar-today' } : null} />
            );
          })}
        </Card>
      </Section>

      {canEnter ? (
        <Section title="Enter lab results">
          <Card>
            {openAges.length > 1 ? <ChipGroup label="Test age" value={String(selAge)} onChange={setAge} options={openAges.map((a) => ({ value: String(a), label: `${a} days` }))} /> : <Text variant="label">{selAge}-day test</Text>}
            <Segmented<'kn' | 'mpa'> label="Lab sheet gives" value={mode} onChange={setMode} options={[{ value: 'kn', label: 'Load (kN)' }, { value: 'mpa', label: 'Strength (MPa)' }]} />
            <Text variant="caption" tone="muted">Pass at {selAge} days: ≥ {selAge! >= 28 ? `${fck - 4} MPa per cube, mean ≥ ${fck}` : `${(fck * cubeAgeFactor(selAge!)).toFixed(1)} MPa (${Math.round(cubeAgeFactor(selAge!) * 100)}% of fck)`}</Text>
            {labels.map((l, i) => {
              const s = strength(l);
              const ok = s != null && Number.isFinite(s) ? cubePasses(s, selAge!, fck) : null;
              return (
                <View key={l} style={styles.cube}>
                  <QuantityStepper label={`Cube ${l}`} unit={mode === 'kn' ? 'kN' : 'MPa'} step={mode === 'kn' ? 10 : 0.5} quick={[]} value={vals[l] ?? ''}
                    onChange={(v) => setVals((x) => ({ ...x, [l]: v }))} error={i === 0 ? errors.c0 : null} name={i === 0 ? 'c0' : undefined}
                    info={s != null && mode === 'kn' && Number.isFinite(s) ? `${s.toFixed(1)} MPa` : null} />
                  {ok != null ? <Chip label={ok ? 'Pass' : 'Low'} tone={ok ? 'success' : 'danger'} icon={ok ? 'check' : 'alert-outline'} small /> : null}
                </View>
              );
            })}
            {setPass === false ? <Banner tone="danger" icon="alert-octagon-outline" title="28-day set fails" text="Saving raises a critical snag and alerts management." /> : null}
            {setPass === true ? <Banner tone="success" icon="check-circle-outline" text="28-day set passes." /> : null}
          </Card>
          <PhotoStrip projectId={c.project_id} entityType="cube_set" entityId={c.id} kind="document" label="Lab sheet" />
        </Section>
      ) : (
        <>
          {selAge == null ? <Banner tone="success" icon="check-all" text="All tests recorded." /> : canField(profile.role, 'cube.results') ? null : <Banner tone="info" text="The office engineer enters lab results." />}
          <PhotoStrip projectId={c.project_id} entityType="cube_set" entityId={c.id} kind="document" label="Lab sheet" canAdd={canField(profile.role, 'cube.results')} />
        </>
      )}
      {results.length ? <Text variant="caption" tone="muted">Results recorded by {[...new Set(results.map((r) => personName((r as unknown as { recorded_by: string }).recorded_by)))].join(', ')}</Text> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({ cube: { gap: space[1] } });
