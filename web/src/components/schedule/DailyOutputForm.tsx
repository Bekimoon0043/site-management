// One daily output on a schedule activity (report_daily_output): today's quantity per BoQ item (units tasks) or the
// percent / status to date, plus manpower, equipment, delay cause and remarks. Each entry updates the task's progress
// and becomes a line in that day's site diary. Used on Daily progress, the schedule task drawer and the look-ahead drawer.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { invalidateAfterWrite } from '../../lib/query';
import { check, supabase } from '../../lib/supabase';
import { nextNumber } from '../../lib/fieldx';
import { DELAY_CAUSE_LABELS } from '../../lib/contract-field';
import type { EvMethod, ReportDailyOutputResult } from '../../lib/contract-schedule';
import { num } from '../../lib/format';
import { Banner, Bar, ErrorBanner, Field, Loading, toast, useBusy } from '../ui';
import { DERIVED_METHODS, PROGRESS_REPORT_ROLES, d2, loadTaskDetail, schedRpc, todayStr } from './data';
import { uploadFiles } from '../../lib/photos';
import { PendingFiles } from '../photos/PhotoDrop';

interface TaskHead {
  id: string; project_id: string; name: string; wbs: string | null; ev_method: EvMethod; start_pct: number | null; is_summary: boolean;
  source_state: string; actual_start: string | null; actual_finish: string | null; pct_complete: number; reported_pct: number;
  planned_start: string | null; planned_finish: string | null;
}

async function loadHead(taskId: string): Promise<TaskHead> {
  return check(await supabase.from('schedule_tasks').select('id, project_id, name, wbs, ev_method, start_pct, is_summary, source_state, actual_start, actual_finish, pct_complete, reported_pct, planned_start, planned_finish')
    .eq('id', taskId).single()) as TaskHead;
}

/** Number of the site diary for this day, or a new one when the day has none yet (the RPC opens it as a draft). */
async function diaryNumberFor(projectId: string, projectCode: string, day: string, blockId: string | null): Promise<string | undefined> {
  let q = supabase.from('site_diaries').select('id').eq('project_id', projectId).eq('diary_date', day);
  q = blockId ? q.eq('block_id', blockId) : q.is('block_id', null);
  const rows = check(await q.limit(1)) as { id: string }[];
  return rows.length ? undefined : nextNumber(projectCode, 'SD', 'site_diaries');
}

export function DailyOutputForm({ taskId, date, blockId = null, onDone, title = 'Record today’s output' }: {
  taskId: string; date?: string; blockId?: string | null; onDone?: (r: ReportDailyOutputResult) => void; title?: string;
}) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const day = date ?? todayStr();
  const q = useAsync(async () => {
    const [head, detail] = await Promise.all([loadHead(taskId), loadTaskDetail(taskId)]);
    return { head, detail };
  }, [taskId], { key: 'daily-output-task' });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [pct, setPct] = useState('');
  const [steps, setSteps] = useState<Record<string, string>>({});
  const [headcount, setHeadcount] = useState('');
  const [hours, setHours] = useState('');
  const [equipment, setEquipment] = useState('');
  const [delay, setDelay] = useState('');
  const [remarks, setRemarks] = useState('');
  const [started, setStarted] = useState(true);
  const [finished, setFinished] = useState(false);
  const [photos, setPhotos] = useState<File[]>([]);
  const { busy, error, run } = useBusy();

  if (!role || !PROGRESS_REPORT_ROLES.includes(role)) return null;
  if (q.error) return <ErrorBanner error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading lines={4} />;
  const { head: t, detail } = q.data;
  const m = t.ev_method;
  if (t.is_summary) return <Banner tone="info">A summary takes its progress from its sub-tasks — pick a detailed activity.</Banner>;
  if (DERIVED_METHODS.includes(m)) {
    return <Banner tone="info">{m === 'loe' ? 'Level-of-effort activity: it earns with time and is not reported.' : 'This activity takes its progress from its elements — report the element activities instead.'}</Banner>;
  }
  if (t.source_state === 'removed_in_source') return <Banner tone="warn">This activity was removed from the MS Project file.</Banner>;
  const startPct = Number(t.start_pct ?? 50);
  const toDate = (b: (typeof detail.boq)[number]) => Math.max(Number(b.reported_qty), Number(b.verified_qty));

  const reset = () => { setQty({}); setPct(''); setSteps({}); setHeadcount(''); setHours(''); setEquipment(''); setDelay(''); setRemarks(''); setFinished(false); setPhotos([]); };
  const submit = () => void run(async () => {
    const p: Record<string, unknown> = { id: crypto.randomUUID(), op_id: crypto.randomUUID(), task_id: t.id, date: day, block_id: blockId };
    if (m === 'units') {
      p.output = detail.boq.map((b) => ({ boq_item_id: b.boq_item_id, qty_today: Number(qty[b.boq_item_id] || 0) }));
    } else if (m === 'steps') {
      p.steps = detail.steps.map((s) => ({ step_id: s.id, done_pct: Number(steps[s.id] ?? s.reported_pct) }));
    } else {
      const v = finished ? 100 : pct === '' ? NaN : Number(pct);
      if (Number.isNaN(v)) throw new Error(m === 'pct' ? 'Enter the percent complete to date' : 'Choose the status');
      p.pct_complete = v;
    }
    if (!t.actual_start && started) p.actual_start = day;
    if (finished) p.actual_finish = day;
    if (headcount) p.headcount = Number(headcount);
    if (hours) p.labour_hours = Number(hours);
    if (equipment.trim()) p.equipment = equipment.trim();
    if (delay) p.delay_cause = delay;
    if (remarks.trim()) p.remarks = remarks.trim();
    const code = auth.project?.code ?? 'PRJ';
    p.diary_number = await diaryNumberFor(t.project_id, code, day, blockId);
    const r = (await schedRpc('report_daily_output', p as never)) as unknown as ReportDailyOutputResult;
    toast.success(`Output recorded · ${num(r.pct_complete, 1)} % to date · diary ${r.diary_number}${r.diary_status === 'signed' ? ' (added as addendum)' : ''}`);
    if (photos.length && r.task_progress_id) {
      const up = await uploadFiles(photos, { projectId: t.project_id, entityType: 'task_progress', entityId: r.task_progress_id, tag: 'progress',
        caption: remarks.trim() || null });
      if (up.errors.length) toast.error(`Output saved, but ${up.errors.length} photo(s) failed: ${up.errors[0]}`);
    }
    reset();
    invalidateAfterWrite();
    onDone?.(r);
  });

  return (
    <div className="stack daily-out">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h3 className="mb-0 grow">{title}</h3>
        <span className="small-text muted">{d2(day)} · now {num(t.reported_pct, 1)} % reported{Number(t.pct_complete) !== Number(t.reported_pct) ? ` · ${num(t.pct_complete, 1)} % verified` : ''}</span>
      </div>
      <div style={{ maxWidth: 360 }}><Bar pct={Number(t.reported_pct)} /></div>
      <ErrorBanner error={error} />

      {m === 'units' && (detail.boq.length ? (
        <div className="daily-out-grid">
          {detail.boq.map((b) => {
            const cur = toDate(b), add = Number(qty[b.boq_item_id] || 0), plan = Number(b.qty_share);
            return (
              <div key={b.boq_item_id} className="daily-out-row">
                <div className="grow">
                  <div className="strong">{b.boq_items?.item_no} <span className="muted">{b.boq_items?.description}</span></div>
                  <div className="small-text muted">To date {num(cur, 2)} of {num(plan, 2)} {b.boq_items?.unit}{add > 0 ? <> → <b>{num(cur + add, 2)}</b>{plan > 0 ? ` (${num(((cur + add) / plan) * 100, 0)} %)` : ''}</> : ''}</div>
                </div>
                <Field label={`Today (${b.boq_items?.unit ?? ''})`}>
                  <input type="number" min={0} step="any" inputMode="decimal" value={qty[b.boq_item_id] ?? ''} placeholder="0"
                    onChange={(e) => setQty({ ...qty, [b.boq_item_id]: e.target.value })} style={{ width: 130 }} />
                </Field>
              </div>
            );
          })}
        </div>
      ) : <Banner tone="warn">No BoQ items are linked to this activity yet. Ask the office engineer to create the BoQ (Planning › Import BoQ) or link it.</Banner>)}

      {m === 'steps' && detail.steps.map((s) => (
        <div key={s.id} className="daily-out-row">
          <span className="grow">{s.seq}. {s.name} <span className="muted small-text">(weight {num(s.weight, 0)})</span></span>
          <Field label="% done to date">
            <input type="number" min={0} max={100} value={steps[s.id] ?? String(Number(s.reported_pct))} onChange={(e) => setSteps({ ...steps, [s.id]: e.target.value })} style={{ width: 100 }} />
          </Field>
        </div>
      ))}

      {m === 'pct' && !finished && (
        <Field label="Percent complete to date" hint={`Now ${num(t.reported_pct, 1)} %`}>
          <input type="number" min={0} max={100} step="any" value={pct} onChange={(e) => setPct(e.target.value)} style={{ width: 120 }} />
        </Field>
      )}
      {(m === '0_100' || m === 'milestone') && !finished && (
        <Field label="Status">
          <select value={pct} onChange={(e) => setPct(e.target.value)} style={{ width: 200 }}>
            <option value="">Choose…</option><option value="0">Not finished (0 %)</option><option value="100">Finished (100 %)</option>
          </select>
        </Field>
      )}
      {m === '50_50' && !finished && (
        <Field label="Status">
          <select value={pct} onChange={(e) => setPct(e.target.value)} style={{ width: 200 }}>
            <option value="">Choose…</option><option value="0">Not started (0 %)</option>
            <option value={String(startPct)}>Started ({startPct} %)</option><option value="100">Finished (100 %)</option>
          </select>
        </Field>
      )}

      <div className="form-grid">
        <Field label="Manpower (people)"><input type="number" min={0} inputMode="numeric" value={headcount} onChange={(e) => setHeadcount(e.target.value)} /></Field>
        <Field label="Labour hours"><input type="number" min={0} step="0.5" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
        <Field label="Equipment used" wide><input value={equipment} onChange={(e) => setEquipment(e.target.value)} placeholder="e.g. Excavator ×1, mixer ×2" /></Field>
        <Field label="Delay / issue">
          <select value={delay} onChange={(e) => setDelay(e.target.value)}>
            <option value="">None</option>
            {Object.entries(DELAY_CAUSE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Remarks" wide hint="Needed when a quantity goes over the plan (re-measurement)"><input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        {!t.actual_start && <Field label="Work started on this day" check><input type="checkbox" checked={started} onChange={(e) => setStarted(e.target.checked)} /></Field>}
        <Field label="Activity finished on this day (100 %)" check><input type="checkbox" checked={finished} onChange={(e) => setFinished(e.target.checked)} /></Field>
      </div>
      <PendingFiles files={photos} onChange={setPhotos} label="Photos of today's work" />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="primary" disabled={busy} onClick={submit}>{busy ? <span className="spinner" /> : <Send size={14} aria-hidden />}Save output</button>
        <span className="small-text muted">Saved to the task's progress (for verification) and to the <Link to="/diary">site diary</Link> of {d2(day)}.</span>
      </div>
    </div>
  );
}
