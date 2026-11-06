// Pour day (features C3): running total vs planned, ready-mix trucks or site batches,
// material issues, cube samples and close. Truck entry is append-only.
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get, list } from '../../lib/db';
import { canField, type MixDesign, type Pour, type PourIssue } from '../../lib/contract-field';
import { WARNING_LABELS, cubeSets, openPourHoldPoints, pourElements, pourTotals } from '../../lib/field';
import { elementLabel, personName } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { fmtDate, fmtDateTime, fmtQty, num } from '../../lib/format';
import { space } from '../../theme';
import {
  ActionBar, Banner, Button, Card, Chip, ChipGroup, EmptyState, Field, FilterChip, Grid, InfoRow, KpiTile, ListRow, PhotoStrip, ProgressBar,
  QuantityStepper, Row, Screen, Section, Sheet, StatusChip, SyncChip, SyncError, Text, confirm, haptic, showError, toast, type BarAction,
} from '../../components/ui';

export default function PourDay() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, project } = useSession();
  const [batch, setBatch] = useState(false);
  const [cubes, setCubes] = useState(false);
  const [close, setClose] = useState(false);
  const d = useData(() => {
    const p = get<Pour>('pours', id);
    if (!p) return null;
    const els = pourElements(id).filter((e) => !e.deleted_at);
    return {
      p, els, md: get<MixDesign>('mix_designs', p.mix_design_id), tot: pourTotals(id), sets: cubeSets(id),
      issues: list<PourIssue>('pour_issues', { parent: id }).filter((x) => !x.truck_id),
      holds: openPourHoldPoints(els.map((e) => e.element_id)),
    };
  }, [id]);
  if (!d) return <Screen><Stack.Screen options={{ title: 'Pour' }} /><EmptyState icon="cloud-off-outline" title="Not on this phone yet" /></Screen>;
  const { p, els, md, tot, sets, issues, holds } = d;
  const live = p.status === 'planned' || p.status === 'in_progress';
  const ready = p.method === 'ready_mix';
  const placed = ready ? tot.accepted : tot.batched;
  const pct = p.planned_m3 > 0 ? (placed / Number(p.planned_m3)) * 100 : 0;
  const canWrite = canField(profile.role, 'pour.write');
  const canIssue = canField(profile.role, 'pour.issue');
  const bagsPerM3 = tot.batched > 0 ? tot.cementBags / tot.batched : null;
  const designBags = md?.cement_kg_per_m3 ? Number(md.cement_kg_per_m3) / 50 : null;

  let primary: BarAction | null = null;
  let secondary: BarAction | null = null;
  if (live && canWrite) {
    primary = ready
      ? { title: 'Add truck', variant: 'hero', icon: 'dump-truck', onPress: () => router.push(`/pours/truck?pour=${p.id}`) }
      : { title: 'Add batch', variant: 'hero', icon: 'plus', onPress: () => setBatch(true) };
    secondary = { title: 'Close pour', variant: 'outline', icon: 'check-all', onPress: () => setClose(true) };
  }

  return (
    <Screen footer={primary ? <ActionBar summary={`${fmtQty(placed)} of ${fmtQty(p.planned_m3)} m3${tot.awaitingCount ? ` · ${tot.awaitingCount} to receive` : ''}`}
      warning={tot.awaitingCount > 0} primary={primary} secondary={secondary} /> : undefined}>
      <Stack.Screen options={{ title: p.number }} />
      <SyncError entityId={p.id} />
      <Card>
        <Row wrap gap={6}>
          <StatusChip status={p.status} /><Chip label={ready ? 'Ready-mix' : 'Site batched'} icon={ready ? 'dump-truck' : 'hammer-wrench'} />
          {md ? <Chip label={`${md.grade} · fck ${md.target_strength_mpa}`} icon="flask-outline" /> : null}<SyncChip entityId={p.id} />
        </Row>
        <Text variant="titleSm">{els.map((e) => elementLabel(e.element_id)).join(', ') || 'No elements'}</Text>
        <ProgressBar pct={Math.min(pct, 100)} showLabel tone={pct > 105 ? 'warning' : undefined} />
        <InfoRow label="Pour date" value={fmtDate(p.pour_date)} />
        {p.supplier_name ? <InfoRow label="Supplier" value={p.supplier_name} /> : null}
        {p.store_id ? <InfoRow label="Store" value={get<{ name: string }>('stores', p.store_id)?.name ?? '—'} /> : null}
        {p.start_at ? <InfoRow label="Started" value={fmtDateTime(p.start_at)} /> : null}
        {p.actual_m3 != null ? <InfoRow label="Actual" value={`${fmtQty(p.actual_m3)} m3 (${(((Number(p.actual_m3) / Number(p.planned_m3)) - 1) * 100).toFixed(1)}% vs plan)`} strong /> : null}
        {p.status === 'planned' && canWrite ? <Button title="Edit plan" size="sm" variant="ghost" icon="pencil-outline" onPress={() => router.push(`/pours/new?id=${p.id}`)} /> : null}
      </Card>

      {live && holds.length ? (
        <Banner tone="danger" icon="hand-back-left-outline" title="Hold point not cleared"
          text={`${holds.map((h) => `${elementLabel(h.elementId)}: ${h.activity.name}`).join(' · ')}. Concrete cannot be accepted until the inspection passes.`}
          actions={[{ label: 'Inspection', onPress: () => router.push(`/inspections/check?element=${holds[0].elementId}&activity=${holds[0].activity.id}`) }]} />
      ) : null}

      <Grid>
        <KpiTile label={ready ? 'Accepted' : 'Batched'} value={`${fmtQty(placed)} m3`} sub={`Planned ${fmtQty(p.planned_m3)} m3`} tone="info" />
        {ready
          ? <KpiTile label="Trucks" value={tot.trucks.length} sub={tot.rejectedCount ? `${tot.rejectedCount} rejected · ${fmtQty(tot.rejected)} m3` : 'None rejected'} tone={tot.rejectedCount ? 'warning' : 'neutral'} />
          : <KpiTile label="Cement" value={`${fmtQty(tot.cementBags)} bags`} sub={bagsPerM3 != null ? `${bagsPerM3.toFixed(1)}/m3${designBags ? ` · design ${designBags.toFixed(1)}` : ''}` : 'No batches yet'}
              tone={bagsPerM3 != null && designBags && bagsPerM3 > designBags * 1.05 ? 'warning' : 'neutral'} />}
      </Grid>

      {ready ? (
        <Section title={`Trucks · ${tot.trucks.length}`}>
          {tot.trucks.length ? (
            <Card flush>
              {tot.trucks.map((k) => (
                <ListRow key={k.id} id={k.id} title={`#${k.seq} · ticket ${k.ticket_no}`} qty={fmtQty(k.volume_m3)} unit="m3" status={k.status}
                  subtitle={[k.slump_mm != null ? `slump ${k.slump_mm} mm` : null, k.reject_reason, (k.warnings ?? []).map((w) => WARNING_LABELS[w]).join(', ') || null].filter(Boolean).join(' · ') || personName(k.recorded_by)}
                  stripe={k.status === 'rejected' ? 'danger' : (k.warnings ?? []).length ? 'warning' : null} icon="dump-truck" iconTone={k.status === 'rejected' ? 'danger' : 'primary'} />
              ))}
            </Card>
          ) : <Text variant="bodySm" tone="muted">No trucks yet. Add each batch ticket as the truck arrives.</Text>}
          {tot.awaitingCount ? <Banner tone="warning" icon="timer-sand" text={`${tot.awaitingCount} accepted truck${tot.awaitingCount > 1 ? 's' : ''} waiting for the store keeper to receive.`}
            actions={canField(profile.role, 'pour.receiveTruck') ? [{ label: 'Receive now', onPress: () => router.push('/pours/receive') }] : undefined} /> : null}
        </Section>
      ) : (
        <Section title={`Batches · ${tot.batches.length}`}>
          {tot.batches.length ? (
            <Card flush>
              {tot.batches.map((b) => (
                <ListRow key={b.id} id={b.id} title={`Batch ${b.seq}`} qty={fmtQty(b.cement_bags)} unit="bags" icon="hammer-wrench"
                  subtitle={[b.volume_m3 != null ? `${fmtQty(b.volume_m3)} m3` : null, b.slump_mm != null ? `slump ${b.slump_mm} mm` : null, b.mixer].filter(Boolean).join(' · ') || fmtDateTime(b.batched_at)} />
              ))}
            </Card>
          ) : <Text variant="bodySm" tone="muted">No batches yet.</Text>}
        </Section>
      )}

      <Section title="Materials issued to this pour" action={canIssue && p.status !== 'cancelled' ? 'Issue' : undefined} onAction={() => router.push(`/pours/issue?pour=${p.id}`)}>
        {issues.length ? (
          <Card flush>{issues.map((x) => <ListRow key={x.id} id={x.miv_id} title={get<{ number: string }>('mivs', x.miv_id)?.number ?? 'MIV'} icon="package-variant-closed-remove" chevron
            onPress={(mid) => router.push(`/store/doc?type=miv&id=${mid}`)} />)}</Card>
        ) : <Text variant="bodySm" tone="muted">{ready ? 'Concrete is issued automatically with each received truck.' : 'Cement, sand and aggregate are issued by the store keeper.'}</Text>}
      </Section>

      <Section title={`Cube samples · ${sets.length}`} action={canField(profile.role, 'cube.sample') && p.status !== 'cancelled' ? 'Take samples' : undefined} onAction={() => setCubes(true)}>
        {sets.length ? (
          <Card flush>{sets.map((c) => <ListRow key={c.id} id={c.id} title={c.number} subtitle={`${c.cubes_count} cubes · ${c.test_ages.join('/')} days${c.lab_name ? ` · ${c.lab_name}` : ''}`}
            status={c.result_28d ?? c.result_early ?? null} icon="test-tube" chevron onPress={(cid) => router.push(`/pours/cubes/${cid}`)} />)}</Card>
        ) : <Text variant="bodySm" tone="muted">Take at least one set of cubes per pour (or per 50 m3).</Text>}
      </Section>

      <PhotoStrip projectId={project.id} entityType="pour" entityId={p.id} label="Pour photos" canAdd={p.status !== 'cancelled'} />
      {live && canWrite && !tot.trucks.some((k) => k.status !== 'rejected') && !tot.batches.length ? (
        <Button title="Cancel pour" variant="dangerOutline" size="sm" onPress={() => confirm('Cancel pour', `${p.number} will be cancelled.`, () => {
          enqueue('close_pour', { pour_id: p.id, cancel: true }, { entityType: 'pour', entityId: p.id, label: `${p.number} cancelled` });
          haptic('reject'); toast.success(`${p.number} cancelled`);
        }, 'Cancel pour', true)} />
      ) : null}

      {batch ? <BatchSheet pour={p} onClose={() => setBatch(false)} /> : null}
      {cubes ? <CubeSheet pour={p} trucks={tot.trucks.filter((k) => k.status !== 'rejected').map((k) => ({ id: k.id, label: `#${k.seq} ${k.ticket_no}` }))} elementIds={els.map((e) => e.element_id)} onClose={() => setCubes(false)} /> : null}
      {close ? <CloseSheet pour={p} placed={placed} awaiting={tot.awaitingCount} onClose={() => setClose(false)} /> : null}
    </Screen>
  );
}

function BatchSheet({ pour, onClose }: { pour: Pour; onClose: () => void }) {
  const [bags, setBags] = useState('');
  const [vol, setVol] = useState('');
  const [sand, setSand] = useState('');
  const [agg, setAgg] = useState('');
  const [water, setWater] = useState('');
  const [slump, setSlump] = useState('');
  const [mixer, setMixer] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const save = () => {
    if (!(num(bags) >= 0) || !bags.trim()) { setErr('Enter the cement bags used'); return; }
    const bid = uuid();
    enqueue('add_pour_batch', {
      id: bid, pour_id: pour.id, cement_bags: num(bags), volume_m3: vol.trim() ? num(vol) : undefined, sand_m3: sand.trim() ? num(sand) : undefined,
      aggregate_m3: agg.trim() ? num(agg) : undefined, water_l: water.trim() ? num(water) : undefined, slump_mm: slump.trim() ? Math.round(num(slump)) : undefined,
      mixer: mixer.trim() || undefined, batched_at: new Date().toISOString(),
    }, { entityType: 'pour', entityId: pour.id, label: `${pour.number} batch` });
    haptic('confirm'); toast.success('Batch saved on phone');
    setBags(''); setVol(''); setSlump(''); setErr(null);
  };
  return (
    <Sheet visible onClose={onClose} title="Site batch" subtitle={pour.number} full
      footer={<><Button title="Done" variant="ghost" onPress={onClose} /><Button title="Save batch" flex onPress={save} /></>}>
      <View style={styles.sheet}>
        <QuantityStepper label="Cement" unit="bags" step={1} quick={[1, 2, 4]} value={bags} onChange={(v) => { setBags(v); setErr(null); }} error={err} />
        <QuantityStepper label="Volume" unit="m3" step={0.25} quick={[]} value={vol} onChange={setVol} />
        <Row align="flex-start">
          <View style={styles.flex}><QuantityStepper label="Sand" unit="m3" step={0.1} quick={[]} value={sand} onChange={setSand} /></View>
          <View style={styles.flex}><QuantityStepper label="Aggregate" unit="m3" step={0.1} quick={[]} value={agg} onChange={setAgg} /></View>
        </Row>
        <Row align="flex-start">
          <View style={styles.flex}><QuantityStepper label="Water" unit="L" step={10} quick={[]} value={water} onChange={setWater} /></View>
          <View style={styles.flex}><QuantityStepper label="Slump" unit="mm" step={5} quick={[]} value={slump} onChange={setSlump} /></View>
        </Row>
        <Field label="Mixer" optional value={mixer} onChangeText={setMixer} />
      </View>
    </Sheet>
  );
}

function CubeSheet({ pour, trucks, elementIds, onClose }: { pour: Pour; trucks: { id: string; label: string }[]; elementIds: string[]; onClose: () => void }) {
  const { project } = useSession();
  const [count, setCount] = useState('3');
  const [ages, setAges] = useState<number[]>([7, 28]);
  const [lab, setLab] = useState('');
  const [truck, setTruck] = useState<string | null>(null);
  const [el, setEl] = useState<string | null>(elementIds.length === 1 ? elementIds[0] : null);
  const toggle = (a: number) => setAges((xs) => (xs.includes(a) ? xs.filter((x) => x !== a) : [...xs, a].sort((x, y) => x - y)));
  const save = () => {
    if (!ages.length) { showError(new Error('Choose at least one test age')); return; }
    try {
      const cid = uuid();
      const number = nextDocNumber(project.code, 'CUBE');
      enqueue('save_cube_set', { id: cid, project_id: project.id, number, pour_id: pour.id, truck_id: truck ?? undefined, element_id: el ?? undefined,
        sampled_at: new Date().toISOString(), cubes_count: Math.max(1, Math.round(num(count) || 3)), cube_size_mm: 150, test_ages: ages, lab_name: lab.trim() || undefined },
      { entityType: 'cube_set', entityId: cid, label: `${number} sampled` });
      haptic('confirm'); toast.success(`${number} saved · tests due ${ages.join(' and ')} days`);
      onClose();
    } catch (err) { showError(err); }
  };
  return (
    <Sheet visible onClose={onClose} title="Take cube samples" subtitle={pour.number} full
      footer={<><Button title="Cancel" variant="ghost" onPress={onClose} /><Button title="Save samples" flex icon="test-tube" onPress={save} /></>}>
      <View style={styles.sheet}>
        <QuantityStepper label="Cubes in the set" step={1} quick={[3, 6]} value={count} onChange={setCount} />
        <Text variant="label">Test ages (days)</Text>
        <Row wrap gap={space[2]}>{[3, 7, 14, 28, 56].map((a) => <FilterChip key={a} label={`${a} d`} selected={ages.includes(a)} onPress={() => toggle(a)} />)}</Row>
        {trucks.length ? <ChipGroup label="From truck (optional)" scroll value={truck} onChange={(v) => setTruck(v === truck ? null : v)} options={trucks.map((k) => ({ value: k.id, label: k.label }))} /> : null}
        {elementIds.length > 1 ? <ChipGroup label="Element (optional)" scroll value={el} onChange={(v) => setEl(v === el ? null : v)} options={elementIds.map((e) => ({ value: e, label: elementLabel(e) }))} /> : null}
        <Field label="Lab" optional value={lab} onChangeText={setLab} autoCapitalize="words" />
      </View>
    </Sheet>
  );
}

function CloseSheet({ pour, placed, awaiting, onClose }: { pour: Pour; placed: number; awaiting: number; onClose: () => void }) {
  const [actual, setActual] = useState(placed > 0 ? String(Math.round(placed * 1000) / 1000) : '');
  const [remarks, setRemarks] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const over = num(actual) > 0 ? (num(actual) / Number(pour.planned_m3) - 1) * 100 : null;
  const save = () => {
    if (!(num(actual) > 0)) { setErr('Enter the volume actually poured'); return; }
    enqueue('close_pour', { pour_id: pour.id, actual_m3: num(actual), end_at: new Date().toISOString(), remarks: remarks.trim() || undefined },
      { entityType: 'pour', entityId: pour.id, label: `${pour.number} completed` });
    haptic('confirm'); toast.success(`${pour.number} closed · casting reported for verification`);
    onClose();
  };
  return (
    <Sheet visible onClose={onClose} title="Close pour" subtitle={pour.number}
      footer={<><Button title="Cancel" variant="ghost" onPress={onClose} /><Button title="Close pour" flex icon="check-all" onPress={save} disabled={awaiting > 0} /></>}>
      <View style={styles.sheet}>
        {awaiting ? <Banner tone="warning" text={`${awaiting} truck${awaiting > 1 ? 's are' : ' is'} still waiting for the store keeper. Receive them before closing.`} /> : null}
        <QuantityStepper label="Actual volume poured" unit="m3" step={0.5} quick={[]} value={actual} onChange={(v) => { setActual(v); setErr(null); }} error={err}
          fill={placed > 0 ? { label: 'Recorded', value: Math.round(placed * 1000) / 1000 } : null}
          warning={over != null && Math.abs(over) > 5 ? `${over > 0 ? '+' : ''}${over.toFixed(1)}% vs planned ${fmtQty(pour.planned_m3)} m3` : null} />
        <Field label="Remarks" optional value={remarks} onChangeText={setRemarks} multiline />
        <Text variant="bodySm" tone="muted">Closing reports the casting activity of each element at 100 % for the office engineer to verify.</Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sheet: { paddingHorizontal: space[4], paddingBottom: space[3], gap: space[3] },
});
