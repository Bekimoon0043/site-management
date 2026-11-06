import { useEffect, useState } from 'react';
import { useAsync } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import type { CubeResult, CubeSet, RecordCubeResultsResult } from '../../lib/contract-field';
import { optNum, optStr, rpcx, uuid } from '../../lib/fieldx';
import { date, num, today } from '../../lib/format';
import { SBadge } from '../../components/field/StatusBadge';
import { Banner, DataTable, Drawer, ErrorBanner, Field, Loading, toast, useBusy } from '../../components/ui';

/** Indicative early-age factor (mirrors app.cube_age_factor). */
const ageFactor = (age: number) => (age >= 28 ? 1 : age >= 21 ? 0.95 : age >= 14 ? 0.85 : age >= 7 ? 0.65 : age >= 3 ? 0.4 : 0.25);

interface Draft { id: string; cube_label: string; load_kn: string; strength_mpa: string; density_kg_m3: string; failure_mode: string }

/** Lab results entry for one cube set at one age (record_cube_results): kN or MPa, per-cube pass/fail preview. */
export function CubeResultsDrawer({ cubeSetId, age: initialAge, onClose }: { cubeSetId: string; age?: number; onClose: () => void }) {
  const q = useAsync(async () => {
    const [set, results] = await Promise.all([
      supabase.from('cube_sets').select('*, pours(number)').eq('id', cubeSetId).single().then(check) as Promise<CubeSet & { pours: { number: string } | null }>,
      supabase.from('cube_results').select('*').eq('cube_set_id', cubeSetId).order('age_days').order('cube_label').then(check) as Promise<CubeResult[]>,
    ]);
    return { set, results };
  }, [cubeSetId], { key: 'cube-set' });
  const set = q.data?.set;
  const [age, setAge] = useState(initialAge ? String(initialAge) : '');
  const [testedOn, setTestedOn] = useState(today());
  const [rows, setRows] = useState<Draft[]>([]);
  const { busy, error, run } = useBusy();
  useEffect(() => {
    if (!set) return;
    if (!age) setAge(String(set.test_ages.find((a) => !q.data!.results.some((r) => r.age_days === a)) ?? set.test_ages[set.test_ages.length - 1] ?? 28));
    setRows(Array.from({ length: set.cubes_count }, (_, i) => ({ id: uuid(), cube_label: `${set.number}-${String.fromCharCode(65 + i)}`, load_kn: '', strength_mpa: '', density_kg_m3: '', failure_mode: '' })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set?.id]);

  if (!q.data || !set) return <Drawer title="Cube results" onClose={onClose}>{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={6} />}</Drawer>;
  const fck = Number(set.required_strength_mpa);
  const a = Number(age) || 0;
  const strengthOf = (r: Draft) => optNum(r.strength_mpa) ?? (optNum(r.load_kn) !== undefined ? Math.round((Number(r.load_kn) * 1000) / (set.cube_size_mm * set.cube_size_mm) * 100) / 100 : undefined);
  const passes = (s: number) => (a >= 28 ? s >= fck - 4 : s >= fck * ageFactor(a));
  const entered = rows.filter((r) => strengthOf(r) !== undefined);
  const mean = entered.length ? entered.reduce((s, r) => s + strengthOf(r)!, 0) / entered.length : null;
  const setPassPreview = a >= 28 && mean !== null ? mean >= fck && entered.every((r) => strengthOf(r)! >= fck - 4) : null;
  const setRow = (i: number, patch: Partial<Draft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = () => run(async () => {
    if (!a) throw new Error('Choose the test age.');
    if (!entered.length) throw new Error('Enter a load (kN) or strength (MPa) for at least one cube.');
    const res = await rpcx('record_cube_results', {
      cube_set_id: set.id,
      results: entered.map((r) => ({ id: r.id, cube_label: r.cube_label, age_days: a, tested_on: testedOn || undefined, load_kn: optNum(r.load_kn),
        strength_mpa: optNum(r.strength_mpa), density_kg_m3: optNum(r.density_kg_m3), failure_mode: optStr(r.failure_mode) })),
    }) as unknown as RecordCubeResultsResult;
    if (res.result_28d === 'fail') toast.error(`${set.number}: 28-day FAIL (mean ${num(res.mean_28d_mpa, 1)} MPa < ${fck}) — critical snag raised`);
    else if (res.result_28d === 'pass') toast.success(`${set.number}: 28-day pass (mean ${num(res.mean_28d_mpa, 1)} MPa)`);
    else toast.success(`${set.number}: ${a}-day results saved${res.result_early === 'low' ? ' — early strength LOW' : ''}`);
    onClose();
  });

  return (
    <Drawer size="lg" title={`Cube results — ${set.number}`} subtitle={`Pour ${set.pours?.number ?? ''} · sampled ${date(set.sampled_at)} · ${set.cubes_count} × ${set.cube_size_mm} mm · required ${num(fck, 1)} MPa`}
      onClose={onClose} footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Record results</button>
      </>}>
      <ErrorBanner error={error} />
      {q.data.results.length > 0 && (
        <>
          <h3>Recorded</h3>
          <DataTable rows={q.data.results} maxHeight="none" columns={[
            { key: 'cube_label', label: 'Cube', id: true },
            { key: 'age_days', label: 'Age', align: 'right', render: (r) => <>{r.age_days}<span className="unit">d</span></> },
            { key: 'tested_on', label: 'Tested', render: (r) => date(r.tested_on) },
            { key: 'strength_mpa', label: 'Strength', align: 'right', render: (r) => <>{num(r.strength_mpa, 2)}<span className="unit">MPa</span></> },
            { key: 'passed', label: 'Result', value: (r) => (r.passed ? 'Pass' : 'Fail'), render: (r) => <SBadge value={r.passed ? 'pass' : 'fail'} /> },
          ]} />
        </>
      )}
      <div className="form-grid mt-2">
        <Field label="Test age" required>
          <select value={age} onChange={(e) => setAge(e.target.value)}>
            {[...new Set([...set.test_ages, 3, 7, 14, 28, 56])].sort((x, y) => x - y).map((d) => <option key={d} value={d}>{d} days{q.data!.results.some((r) => r.age_days === d) ? ' (has results)' : ''}</option>)}
          </select>
        </Field>
        <Field label="Tested on"><input type="date" value={testedOn} onChange={(e) => setTestedOn(e.target.value)} /></Field>
        <Field label="Pass criterion">
          <span className="muted">{a >= 28 ? `each ≥ ${num(fck - 4, 1)} MPa, mean ≥ ${num(fck, 1)} MPa` : a ? `≥ ${num(fck * ageFactor(a), 1)} MPa (indicative, ${Math.round(ageFactor(a) * 100)} % of fck)` : '—'}</span>
        </Field>
      </div>
      <DataTable rows={rows.map((r, i) => ({ ...r, _i: i }))} rowKey={(r) => r.id} maxHeight="none" virtual={false} columns={[
        { key: 'cube_label', label: 'Cube', sortable: false, render: (r) => <input aria-label="Cube label" value={r.cube_label} onChange={(e) => setRow(r._i, { cube_label: e.target.value })} style={{ width: 150 }} /> },
        { key: 'load_kn', label: 'Load (kN)', sortable: false, render: (r) => <input aria-label="Load kN" inputMode="decimal" value={r.load_kn} onChange={(e) => setRow(r._i, { load_kn: e.target.value })} style={{ width: 90 }} /> },
        { key: 'strength_mpa', label: 'or MPa', sortable: false, render: (r) => <input aria-label="Strength MPa" inputMode="decimal" value={r.strength_mpa} placeholder={strengthOf({ ...r, strength_mpa: '' }) !== undefined ? num(strengthOf({ ...r, strength_mpa: '' }), 2) : ''} onChange={(e) => setRow(r._i, { strength_mpa: e.target.value })} style={{ width: 90 }} /> },
        { key: 'density', label: 'Density', sortable: false, render: (r) => <input aria-label="Density" inputMode="decimal" value={r.density_kg_m3} onChange={(e) => setRow(r._i, { density_kg_m3: e.target.value })} style={{ width: 80 }} /> },
        { key: 'failure_mode', label: 'Failure mode', sortable: false, render: (r) => <input aria-label="Failure mode" value={r.failure_mode} onChange={(e) => setRow(r._i, { failure_mode: e.target.value })} style={{ width: 120 }} /> },
        { key: 'res', label: 'Result', sortable: false, render: (r) => { const s = strengthOf(r); return s === undefined || !a ? '' : <SBadge value={passes(s) ? 'pass' : 'fail'} label={`${passes(s) ? 'Pass' : 'Fail'} · ${num(s, 1)}`} />; } },
      ]} />
      {setPassPreview !== null && (
        <Banner tone={setPassPreview ? 'ok' : 'error'}>
          28-day set: mean {num(mean, 2)} MPa — {setPassPreview ? 'PASS' : 'FAIL. A critical snag will be raised and management notified.'}
        </Banner>
      )}
    </Drawer>
  );
}
