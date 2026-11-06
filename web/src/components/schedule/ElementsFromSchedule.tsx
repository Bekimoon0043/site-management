// Building elements from an imported schedule (detector: lib/msp/elements.ts; RPC create_elements_from_schedule,
// migration 20261103000040). Shown after a schedule import, after Import BoQ and on Elements & BoQ › Import.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { invalidateAfterWrite } from '../../lib/query';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { ELEMENT_TYPES } from '../../lib/contract';
import { num } from '../../lib/format';
import {
  activityRange, concreteSpecFor, defaultNorms, detectElements, elementTakeoffs, levelInfo, matchLevel,
  type BoqLinkLite, type DetectedElement, type Norms, type SpecLite,
} from '../../lib/msp';
import { Badge, Banner, Card, DataTable, ErrorBanner, Field, Loading, toast, useBusy } from '../ui';
import { loadTasks } from './data';

interface Edit { include: boolean; code: string; element_type: string; level_code: string | null }
interface Result { elements_created: number; elements_matched: number; levels_created: number; blocks_created: number; links: number; links_removed: number; takeoffs: number; warnings: string[] }
type LinkRow = { task_id: string; boq_item_id: string; qty_share: number; boq_items: { unit: string | null; description: string } | null };

async function loadSource(projectId: string, scheduleId: string) {
  const [tasks, links, templates, existing] = await Promise.all([
    loadTasks(scheduleId),
    fetchAll<LinkRow>((a, b) => supabase.from('task_boq_links').select('task_id, boq_item_id, qty_share, boq_items(unit, description)' as '*')
      .eq('project_id', projectId).is('deleted_at', null).range(a, b), 60000),
    supabase.from('activity_templates').select('element_type, seq, name').order('seq').then(check) as Promise<{ element_type: string; seq: number; name: string }[]>,
    fetchAll<{ id: string; code: string; block_id: string | null; level_id: string | null }>((a, b) => supabase.from('elements')
      .select('id, code, block_id, level_id').eq('project_id', projectId).is('deleted_at', null).range(a, b), 60000),
  ]);
  return { tasks: tasks.filter((t) => t.source_state !== 'removed_in_source'), links, templates, existing };
}

export function ElementsFromSchedule({ scheduleId, scheduleName, compact = false }: { scheduleId: string; scheduleName?: string | null; compact?: boolean }) {
  const auth = useAuth();
  const projectId = auth.projectId ?? '';
  const lk = useLookups(projectId);
  const q = useAsync(() => loadSource(projectId, scheduleId), [projectId, scheduleId], { key: 'elements-from-schedule' });
  const [open, setOpen] = useState(!compact);
  const det = useMemo(() => (q.data ? detectElements(
    q.data.tasks.map((t) => ({ id: t.id, name: t.name, parent_id: t.parent_id, is_summary: t.is_summary, wbs: t.wbs, start: t.planned_start, finish: t.planned_finish })),
    { projectName: auth.project?.name, scheduleName }) : null), [q.data, auth.project?.name, scheduleName]);

  if (q.error || lk.error) return <ErrorBanner error={q.error ?? lk.error} onRetry={q.reload} />;
  if (!det || !lk.data || !q.data) return <Loading lines={3} />;
  if (!det.elements.length) {
    return <Banner tone="info">No building elements (columns, slabs, walls …) were recognised in this schedule's task names. Add them under Elements &amp; BoQ › Import.</Banner>;
  }
  if (!open) {
    return (
      <Card title={<><Layers size={16} aria-hidden /> {det.elements.length} building elements found in the schedule</>}
        sub={`On ${det.levels.length} level${det.levels.length === 1 ? '' : 's'}, from ${det.work_tasks - det.other_tasks} work tasks. Progress, look-ahead material needs and site-use requests use them.`}>
        <button className="primary" onClick={() => setOpen(true)}>Review and create the elements ›</button>
      </Card>
    );
  }
  return <Review det={det} source={q.data} specs={lk.data.specs} blocks={lk.data.blocks} levels={lk.data.levels} scheduleId={scheduleId} onDone={q.reload} />;
}

function Review({ det, source, specs, blocks, levels, scheduleId, onDone }: {
  det: NonNullable<ReturnType<typeof detectElements>>; source: Awaited<ReturnType<typeof loadSource>>;
  specs: SpecLite[]; blocks: { id: string; code: string; name: string; deleted_at: string | null }[];
  levels: { id: string; block_id: string; code: string; name: string; sort_order: number; deleted_at: string | null }[];
  scheduleId: string; onDone: () => void;
}) {
  const auth = useAuth();
  const nav = useNavigate();
  const live = blocks.filter((b) => !b.deleted_at);
  const [blockId, setBlockId] = useState(live.length === 1 ? live[0].id : live[0]?.id ?? '__new');
  const [newBlock, setNewBlock] = useState({ code: 'A', name: auth.project?.name ? `${auth.project.name}` : 'Main building' });
  const [edits, setEdits] = useState<Record<string, Edit>>(() => Object.fromEntries(det.elements.map((e) => [e.key, { include: true, code: e.code, element_type: e.element_type, level_code: e.level_code }])));
  const [norms, setNorms] = useState<Norms>(() => defaultNorms(specs));
  const [withTakeoffs, setWithTakeoffs] = useState(true);
  const [result, setResult] = useState<Result | null>(null);
  const { busy, error, run } = useBusy();

  const blockLevels = levels.filter((l) => !l.deleted_at && l.block_id === blockId);
  const levelFor = (code: string | null) => (code ? matchLevel(code, blockLevels) : undefined);
  const levelCodes = [...new Set([...det.levels.map((l) => l.code), ...blockLevels.map((l) => l.code)])];
  const links: BoqLinkLite[] = source.links.map((l) => ({ task_id: l.task_id, boq_item_id: l.boq_item_id, qty_share: Number(l.qty_share), unit: l.boq_items?.unit ?? null, description: l.boq_items?.description ?? '' }));
  const linkedTasks = new Set(links.map((l) => l.task_id));
  const concreteFor = useMemo(() => concreteSpecFor(specs), [specs]);
  const tmpl = (type: string) => source.templates.filter((t) => t.element_type.toLowerCase() === type.toLowerCase());
  const specLabel = new Map(specs.map((s) => [s.id, s]));
  const existingKey = new Set(source.existing.map((e) => `${e.block_id}|${e.level_id}|${e.code.toUpperCase()}`));

  const rows = det.elements.map((e) => {
    const ed = edits[e.key];
    const lv = levelFor(ed.level_code);
    const exists = blockId !== '__new' && existingKey.has(`${blockId}|${lv?.id ?? null}|${ed.code.toUpperCase()}`);
    const takeoffs = withTakeoffs ? elementTakeoffs({ ...e, element_type: ed.element_type }, links, norms, concreteFor) : [];
    return { e, ed, lv, exists, takeoffs };
  });
  const chosen = rows.filter((r) => r.ed.include);
  const noBoq = !source.tasks.some((t) => linkedTasks.has(t.id));
  const set = (key: string, patch: Partial<Edit>) => setEdits((x) => ({ ...x, [key]: { ...x[key], ...patch } }));

  const submit = () => void run(async () => {
    const usedLevels = [...new Set(chosen.map((r) => r.ed.level_code).filter((c): c is string => !!c))];
    const levelsPayload = usedLevels.map((c) => { const ex = levelFor(c); return ex ? { code: ex.code, name: ex.name, sort_order: ex.sort_order } : levelInfo(c); });
    const p = {
      op_id: crypto.randomUUID(), schedule_id: scheduleId,
      block: blockId === '__new' ? { code: newBlock.code.trim() || 'A', name: newBlock.name.trim() } : { id: blockId },
      levels: levelsPayload,
      elements: chosen.map(({ e, ed, lv, takeoffs }) => ({
        level_code: ed.level_code ? (lv?.code ?? ed.level_code) : null, code: ed.code.trim().toUpperCase(), element_type: ed.element_type,
        planned_start: e.start, planned_finish: e.finish,
        tasks: e.tasks.map((t) => { const r = activityRange(t.trade, tmpl(ed.element_type)); return { task_id: t.task_id, activity_seq_from: r?.from ?? null, activity_seq_to: r?.to ?? null }; }),
        takeoffs,
      })),
      replace_links: true,
    };
    const { data, error: err } = await supabase.rpc('create_elements_from_schedule', { p });
    if (err) throw new Error(err.message);
    const r = data as Result;
    setResult(r);
    invalidateAfterWrite({ lookups: true });
    toast.success(`${r.elements_created} element${r.elements_created === 1 ? '' : 's'} created, ${r.elements_matched} updated · ${r.links} task links`);
    onDone();
  });

  if (result) {
    return (
      <Card title="Elements created from the schedule">
        <div className="imp-summary">
          <span><b>{num(result.elements_created, 0)}</b> new elements</span><span><b>{num(result.elements_matched, 0)}</b> already there (updated)</span>
          <span><b>{num(result.levels_created, 0)}</b> new levels</span><span><b>{num(result.links, 0)}</b> task links</span>
          <span><b>{num(result.takeoffs, 0)}</b> take-off lines</span>{result.links_removed > 0 && <span><b>{result.links_removed}</b> old links removed</span>}
        </div>
        {result.warnings?.length > 0 && <ul className="small-text">{result.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}</ul>}
        <div className="row mt-2" style={{ flexWrap: 'wrap' }}>
          <button className="primary" onClick={() => nav('/elements')}>Open Elements &amp; BoQ</button>
          <button onClick={() => nav('/lookahead')}>Monthly tasks (material needs)</button>
          <button onClick={() => setResult(null)}>Run again</button>
        </div>
      </Card>
    );
  }

  const specOpts = (re: RegExp) => specs.filter((s) => re.test(s.material_name));
  const specSel = (value: string | null, re: RegExp, onChange: (v: string | null) => void, label: string) => (
    <Field label={label}>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">— none —</option>
        {specOpts(re).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
    </Field>
  );

  return (
    <div className="stack">
      <Card title={<><Layers size={16} aria-hidden /> {det.elements.length} building elements found in the schedule</>}
        sub={`${det.levels.length} levels${det.basements ? ` (${det.basements} basement${det.basements > 1 ? 's' : ''})` : ''} · ${det.work_tasks - det.other_tasks} work tasks linked · ${det.other_tasks} tasks are not building elements (earthworks, finishes …)`}>
        <div className="form-grid">
          <Field label="Block / building">
            <select value={blockId} onChange={(e) => setBlockId(e.target.value)}>
              {live.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
              <option value="__new">New block…</option>
            </select>
          </Field>
          {blockId === '__new' && <>
            <Field label="Block code"><input value={newBlock.code} onChange={(e) => setNewBlock({ ...newBlock, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Block name"><input value={newBlock.name} onChange={(e) => setNewBlock({ ...newBlock, name: e.target.value })} /></Field>
          </>}
          <Field label="Also create the material take-offs from the BoQ quantities" check wide>
            <input type="checkbox" checked={withTakeoffs} onChange={(e) => setWithTakeoffs(e.target.checked)} />
          </Field>
        </div>
        <p className="small-text muted mb-0">
          Levels: {det.levels.map((l) => { const ex = levelFor(l.code); return `${l.code}${ex ? '' : ' (new)'}`; }).join(' · ')}.
          {' '}Existing elements with the same code and level are updated, never duplicated — you can run this again after a re-import or after Import BoQ.
        </p>
        {withTakeoffs && noBoq && <Banner tone="info">This schedule has no BoQ links yet, so no take-offs can be calculated. Create the elements now, then run this again after Planning › Import BoQ.</Banner>}
        {withTakeoffs && !noBoq && (
          <details className="mt-2">
            <summary className="small-text">Material norms used for the take-offs (check with your QS)</summary>
            <div className="form-grid mt-2">
              {specSel(norms.concrete_spec, /concrete/i, (v) => setNorms({ ...norms, concrete_spec: v }), 'Concrete (1 m³ per m³; a grade in the BoQ text wins)')}
              {(['footing', 'column', 'wall', 'slab', 'beam', 'staircase'] as const).map((t) => (
                <span key={t} style={{ display: 'contents' }}>{specSel(norms.rebar_spec[t] ?? null, /rebar|reinforc/i, (v) => setNorms({ ...norms, rebar_spec: { ...norms.rebar_spec, [t]: v } }), `Rebar for ${t}s`)}</span>
              ))}
              {specSel(norms.binding_wire_spec, /binding/i, (v) => setNorms({ ...norms, binding_wire_spec: v }), `Binding wire (${norms.binding_wire_per_kg} kg per kg rebar)`)}
              {specSel(norms.hcb_spec, /hcb|block/i, (v) => setNorms({ ...norms, hcb_spec: v }), 'Blocks for blockwork')}
              <Field label="Blocks per m²"><input type="number" step="0.1" value={norms.hcb_per_m2} onChange={(e) => setNorms({ ...norms, hcb_per_m2: Number(e.target.value) || 0 })} /></Field>
              {specSel(norms.cement_spec, /cement/i, (v) => setNorms({ ...norms, cement_spec: v }), 'Mortar cement')}
              <Field label="Cement per m² of blockwork"><input type="number" step="0.01" value={norms.mortar_cement_per_m2} onChange={(e) => setNorms({ ...norms, mortar_cement_per_m2: Number(e.target.value) || 0 })} /></Field>
              {specSel(norms.sand_spec, /sand/i, (v) => setNorms({ ...norms, sand_spec: v }), 'Mortar sand')}
              <Field label="Sand (m³) per m² of blockwork"><input type="number" step="0.005" value={norms.mortar_sand_per_m2} onChange={(e) => setNorms({ ...norms, mortar_sand_per_m2: Number(e.target.value) || 0 })} /></Field>
            </div>
          </details>
        )}
        <ErrorBanner error={error} />
      </Card>
      <Card flush>
        <DataTable rows={rows} rowKey={(r) => r.e.key} maxHeight="60vh" stickyFirst
          columns={[
            { key: 'inc', label: '', sortable: false, noExport: true, render: (r) => <input type="checkbox" aria-label={`Create ${r.e.label}`} checked={r.ed.include} onChange={(ev) => set(r.e.key, { include: ev.target.checked })} /> },
            { key: 'level', label: 'Level', value: (r) => levelInfo(r.ed.level_code ?? '').sort_order, render: (r) => (
              <select aria-label="Level" value={r.ed.level_code ?? ''} onChange={(ev) => set(r.e.key, { level_code: ev.target.value || null })}>
                <option value="">Whole block</option>
                {levelCodes.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>) },
            { key: 'code', label: 'Code', id: true, value: (r) => r.ed.code, render: (r) => <input aria-label="Element code" value={r.ed.code} onChange={(ev) => set(r.e.key, { code: ev.target.value.toUpperCase() })} style={{ width: 110 }} /> },
            { key: 'label', label: 'Element', value: (r) => r.e.label, render: (r) => <span>{r.e.label}{r.exists && <> <Badge tone="info" label="exists" icon={null} /></>}</span> },
            { key: 'type', label: 'Type', value: (r) => r.ed.element_type, render: (r) => (
              <select aria-label="Element type" value={r.ed.element_type} onChange={(ev) => set(r.e.key, { element_type: ev.target.value })}>
                {[...new Set([...ELEMENT_TYPES, r.ed.element_type])].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>) },
            { key: 'tasks', label: 'Tasks', value: (r) => r.e.tasks.length, render: (r) => <TaskList el={r.e} /> },
            { key: 'takeoff', label: 'Take-off', value: (r) => r.takeoffs.length, render: (r) => (r.takeoffs.length
              ? <span className="small-text">{r.takeoffs.map((t) => { const s = specLabel.get(t.material_spec_id); return `${s?.grade || s?.material_name} ${num(t.qty, t.qty < 100 ? 2 : 0)} ${s?.uom ?? ''}`; }).join(' · ')}</span>
              : <span className="muted small-text">—</span>) },
            { key: 'conf', label: 'Check', value: (r) => r.e.confidence, render: (r) => (r.e.confidence === 'high' ? <Badge tone="success" label="sure" icon={null} />
              : <span title={r.e.note ?? ''}><Badge tone={r.e.confidence === 'medium' ? 'warning' : 'danger'} label="check" icon={null} /> <span className="small-text muted">{r.e.note}</span></span>) },
          ]} />
      </Card>
      <div className="imp-actions"><span className="small-text muted">{chosen.length} of {rows.length} selected · {chosen.filter((r) => r.exists).length} already exist</span>
        <button className="primary" disabled={busy || !chosen.length} onClick={submit}>{busy && <span className="spinner" />}Create {chosen.length} element{chosen.length === 1 ? '' : 's'}</button>
      </div>
    </div>
  );
}

function TaskList({ el }: { el: DetectedElement }) {
  return (
    <details>
      <summary className="small-text">{el.tasks.length} task{el.tasks.length === 1 ? '' : 's'} · {[...new Set(el.tasks.map((t) => t.trade ?? 'other'))].join(', ')}</summary>
      <ul className="small-text" style={{ margin: '4px 0 0', paddingLeft: 16 }}>{el.tasks.map((t) => <li key={t.task_id}>{t.name}</li>)}</ul>
    </details>
  );
}
