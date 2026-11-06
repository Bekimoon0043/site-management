// /schedule/import — 4-step wizard (docs/research/schedule-ux.md §3): Upload → Preview (tree, quality, calendar,
// BoQ field) → Link (auto-match coverage + manual mapping) → Confirm (diff vs existing, options) → import_schedule.
// The BoQ itself is imported separately on /boq/import (from this schedule's Unit / Qty / Rate / Amount columns, or Excel).
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleCheck, Download, FileWarning, Flame, Upload } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups, type Lookups } from '../../lib/hooks';
import { dateTime, num } from '../../lib/format';
import {
  SCHEDULE_ACCEPT, detectElements, detectEmbeddedBoq, diffSchedule, downloadScheduleTemplate, sha256Hex, toImportPayload, useMspParse,
  type DiffField, type ExistingTask, type ImportTask, type ParsedSchedule, type QualityReport, type QualitySeverity, type ScheduleDiff,
} from '../../lib/msp';
import { CONVERTER_ACCEPT, convertScheduleFile, needsConverter, useConverterHealth } from '../../lib/msp/convertMpp';
import type { ImportScheduleResult } from '../../lib/contract-schedule';
import { Badge, Banner, Card, DataTable, Empty, ErrorBanner, Field, FilterBar, Loading, Page, SearchInput, Stepper, Tabs, toast, useBusy, type Tone } from '../../components/ui';
import { canEditSchedule, d2, loadBoqItems, loadSchedules, loadTasks, normCode, schedRpc, type BoqItemRow, type SchedHeader } from '../../components/schedule/data';
import { loadEdits } from '../../components/schedule/editing';
import { BaselineOffer } from '../../components/schedule/EmbeddedBoq';
import { ElementsFromSchedule } from '../../components/schedule/ElementsFromSchedule';
import '../../components/schedule/schedule.css';

const STEPS = ['Upload', 'Preview', 'Link to BoQ', 'Confirm'];
const SEV: Record<QualitySeverity, { tone: Tone; label: string }> = {
  ok: { tone: 'success', label: 'OK' }, info: { tone: 'info', label: 'Note' }, warning: { tone: 'warning', label: 'Check' }, error: { tone: 'danger', label: 'Must fix' },
};
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DIFF_FIELDS: DiffField[] = ['name', 'wbs', 'outline_level', 'is_summary', 'is_milestone', 'start', 'finish', 'duration_days'];

type BoqPick = string | null | undefined; // undefined = auto-detect, null = none
type MatchHow = 'code' | 'element' | 'name' | 'manual' | null;
interface TaskMatch { how: MatchHow; boq: string[]; el: string[]; label: string }

export function ScheduleImport() {
  const projectId = useProjectId();
  const auth = useAuth();
  const nav = useNavigate();
  const canEdit = canEditSchedule(auth.profile?.role);
  const lk = useLookups(projectId);
  const sq = useAsync(() => loadSchedules(projectId), [projectId], { key: 'schedules', staleTime: 60_000 });
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [mpp, setMpp] = useState<{ name: string; error?: string } | null>(null); // .mpp etc. being converted (or failed)
  const [srcName, setSrcName] = useState<string | null>(null); // original name when the XML came from the converter
  // The converter writes fresh XML (timestamps) on every run: identify the upload by the original .mpp bytes so a re-import is a duplicate.
  const [srcSha, setSrcSha] = useState<string | null>(null);
  const convSeq = useRef<AbortController | null>(null);
  const converter = useConverterHealth();
  const [over, setOver] = useState(false);
  const [boqPick, setBoqPick] = useState<BoqPick>(undefined);
  const [elField, setElField] = useState('');
  const [target, setTarget] = useState(''); // schedule id, '' = default (MASTER / new), '__new' = new code
  const [newCode, setNewCode] = useState('');
  const [result, setResult] = useState<ImportScheduleResult | null>(null);
  const parseOpts = useMemo(() => (boqPick === undefined ? {} : { boqField: boqPick }), [boqPick]);
  const parse = useMspParse(file, parseOpts);
  const parsedRaw = parse.status === 'done' ? parse.result : null;
  const parsed = useMemo(() => (parsedRaw && srcName ? { ...parsedRaw, file_name: srcName, file_sha256: srcSha ?? parsedRaw.file_sha256 } : parsedRaw), [parsedRaw, srcName, srcSha]);
  const quality = parse.status === 'done' ? parse.quality : null;
  // Unit / Qty / Rate / Amount columns in the file → the BoQ can be created from it on Import BoQ after this import.
  const boqColumns = useMemo(() => { const c = parsedRaw ? detectEmbeddedBoq(parsedRaw).confidence : 'none'; return c === 'high' || c === 'medium'; }, [parsedRaw]);
  // building elements recognised in the task names (created after the import, when the tasks have ids)
  const elementsFound = useMemo(() => {
    if (!parsedRaw) return null;
    const d = detectElements(parsedRaw.tasks.map((t) => ({ id: String(t.uid), name: t.name, parent_id: t.parent_uid != null ? String(t.parent_uid) : null, is_summary: t.is_summary })),
      { projectName: auth.project?.name, scheduleName: parsedRaw.name });
    return d.elements.length ? { elements: d.elements.length, levels: d.levels.length } : null;
  }, [parsedRaw, auth.project?.name]);
  const [resultFor, setResultFor] = useState<{ fileHasBaseline: boolean; schedHasBaseline: boolean } | null>(null);

  const schedules = sq.data?.schedules ?? [];
  const targetSched: SchedHeader | undefined = target === '__new' ? undefined : schedules.find((s) => s.id === target) ?? schedules.find((s) => s.code === 'MASTER') ?? (target ? undefined : schedules[0]);

  const pickFile = (f: File | undefined | null) => {
    if (!f) return;
    setResult(null);
    convSeq.current?.abort(); convSeq.current = null;
    setBoqPick(undefined); setElField('');
    if (needsConverter(f.name)) {
      // Binary MS Project (and other MPXJ formats): convert to MSPDI XML on the local converter, then parse as .xml.
      const ac = new AbortController(); convSeq.current = ac;
      setMpp({ name: f.name }); setFile(null); setSrcName(null); setSrcSha(null);
      void f.arrayBuffer().then(sha256Hex).then((h) => { if (!ac.signal.aborted) setSrcSha(h); });
      convertScheduleFile(f, ac.signal)
        .then((xml) => { if (ac.signal.aborted) return; setMpp(null); setSrcName(f.name); setFile(xml); })
        .catch((e: Error) => { if (!ac.signal.aborted && e.name !== 'AbortError') setMpp({ name: f.name, error: e.message }); });
      return;
    }
    setMpp(null); setSrcName(null); setSrcSha(null); setFile(f);
  };

  if (!canEdit) return <Page title="Import schedule"><Empty title="No access">Only office engineers, coordinators and managers import schedules. You can still view it under Schedule.</Empty></Page>;

  return (
    <Page title="Import schedule" width="form" breadcrumbs={[{ label: 'Schedule', to: '/schedule' }, { label: 'Import' }]}
      subtitle="Bring in your MS Project plan. Progress, links to the BoQ and baselines are kept on every re-import."
      actions={<button onClick={() => nav('/schedule')}>Cancel</button>}>
      {!result && <Stepper steps={STEPS} current={step} onStep={setStep} />}
      <div className="stack mt-2">
        {result ? <ResultCard r={result} onAgain={() => { setResult(null); setFile(null); setStep(0); }} onOpen={(h) => nav(`/schedule${h}`)}
          onBoq={() => nav(`/boq/import?from=schedule&schedule=${result.schedule_id}`)} boqColumns={boqColumns} canSeePrices={auth.canSeePrices}
          offerBaseline={!!resultFor && !resultFor.fileHasBaseline && !resultFor.schedHasBaseline} />
        : step === 0 ? (
          <>
            <Card title="Upload your MS Project schedule">
              <label className={`dropzone${over ? ' over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); pickFile(e.dataTransfer.files[0]); }}>
                <Upload size={28} aria-hidden />
                <span><b>Drop the file here</b> or <span className="link-like">choose a file</span></span>
                <span className="small-text">MS Project (.mpp or .xml) · Also works: the Excel template (.xlsx)</span>
                <input type="file" accept={`${SCHEDULE_ACCEPT},${CONVERTER_ACCEPT}`} onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              <div className="stack mt-2">
                <div className="small-text"><b>From MS Project:</b> upload the .mpp directly, or File › Save As › “XML Format (*.xml)”.{' '}
                  <span className="muted">MS Project (.mpp) converter: {converter === 'checking' ? 'checking…' : <Badge tone={converter === 'online' ? 'success' : 'neutral'} label={converter} />}</span>
                </div>
                <div className="row small-text" style={{ flexWrap: 'wrap' }}>
                  <span><b>No MS Project?</b> Fill in the Excel template (Unique ID, WBS, Name, Start, Finish, Predecessors, BoQ Code…).</span>
                  <button className="small" onClick={() => void downloadScheduleTemplate()}><Download size={14} />Download Excel template</button>
                </div>
              </div>
            </Card>
            {mpp && !mpp.error && <Banner tone="info"><span className="spinner" /> Converting MS Project file… <b>{mpp.name}</b></Banner>}
            {mpp?.error && (
              <Banner tone="error">
                <div className="mpp-help"><b>{mpp.name}</b>: {mpp.error}
                  {!/sign in again/i.test(mpp.error) && <ol><li>Open the file in MS Project.</li><li>File › Save As › choose <b>XML Format (*.xml)</b> as the file type.</li><li>Upload the new .xml file here.</li></ol>}
                </div>
              </Banner>
            )}
            {file && parse.status === 'parsing' && (
              <Banner tone="info"><span className="spinner" /> Reading {srcName ?? file.name}… {parse.progress ? `${parse.progress.stage}${parse.progress.total ? ` ${num(parse.progress.done, 0)} / ${num(parse.progress.total, 0)}` : ''}` : ''}</Banner>
            )}
            {parse.status === 'error' && <Banner tone="error">{parse.error}</Banner>}
            {parsed && quality && (
              <Banner tone={quality.blocking ? 'error' : 'ok'}>
                <b>{parsed.file_name}</b> read in {num(parse.status === 'done' ? parse.ms : 0, 0)} ms: {num(parsed.tasks.length, 0)} tasks, {num(parsed.source_links.length, 0)} links
                {quality.blocking ? ' — it has problems that must be fixed in MS Project first (see the next step).' : '.'}
              </Banner>
            )}
            <Card title="Where does it go?">
              {!sq.data ? <Loading lines={2} /> : (
                <div className="form-grid">
                  <Field label="Schedule" hint={targetSched ? 'Tasks are matched by Unique ID / GUID; progress and links are kept.' : 'A new schedule is created.'}>
                    <select value={target} onChange={(e) => setTarget(e.target.value)}>
                      <option value="">{schedules.length ? `Update ${targetSchedLabel(schedules.find((s) => s.code === 'MASTER') ?? schedules[0])}` : 'New master schedule'}</option>
                      {schedules.map((s) => <option key={s.id} value={s.id}>Update {targetSchedLabel(s)}</option>)}
                      {schedules.length > 0 && <option value="__new">New separate schedule…</option>}
                    </select>
                  </Field>
                  {target === '__new' && <Field label="Code for the new schedule" required hint="e.g. BLOCK-B, FITOUT"><input value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase())} /></Field>}
                  {targetSched && (() => { const v = targetSched.current_version_id ? sq.data!.versions.get(targetSched.current_version_id) : undefined; return v ? (
                    <p className="small-text muted wide">This is a re-import of “{targetSched.name}” (v{v.version_no}{v.file_name ? `, ${v.file_name}` : ''}, imported {dateTime(v.imported_at)}{v.imported_by ? ` by ${lk.data?.person(v.imported_by) ?? '…'}` : ''}).</p>
                  ) : null; })()}
                </div>
              )}
            </Card>
            <div className="imp-actions"><span />
              <button className="primary" disabled={!parsed || (target === '__new' && !newCode.trim())} onClick={() => setStep(1)}>Next: Preview ›</button>
            </div>
          </>
        ) : !parsed || !quality ? (
          <><Loading lines={6} />{parse.status === 'error' && <Banner tone="error">{parse.error}</Banner>}<button onClick={() => setStep(0)}>‹ Back</button></>
        ) : step === 1 ? (
          <PreviewStep s={parsed} q={quality} boqPick={boqPick} setBoqPick={setBoqPick} elField={elField} setElField={setElField}
            reparsing={false} onBack={() => setStep(0)} onNext={() => setStep(2)} boqColumns={boqColumns} elementsFound={elementsFound} />
        ) : step === 2 && lk.data ? (
          <LinkStep s={parsed} elField={elField} projectId={projectId} L={lk.data} onBack={() => setStep(1)} onNext={() => setStep(3)} />
        ) : step === 3 && lk.data ? (
          <ConfirmStep s={parsed} target={targetSched} newCode={target === '__new' ? newCode.trim() : ''} elField={elField} projectId={projectId} L={lk.data}
            onBack={() => setStep(2)} onDone={(r) => {
              setResult(r);
              setResultFor({ fileHasBaseline: parsed.tasks.some((t) => t.baseline_start), schedHasBaseline: !!targetSched?.approved_baseline_id && targetSched.id === r.schedule_id });
              toast.success(r.duplicate ? 'This file was already imported — nothing changed' : `Schedule v${r.version_no} imported · ${r.added} new, ${r.changed} changed`);
            }} />
        ) : <Loading lines={6} />}
      </div>
    </Page>
  );
}

const targetSchedLabel = (s: SchedHeader) => `${s.code} · ${s.name}`;

// ---------------------------------------------------------------------------
// Step 2: Preview
// ---------------------------------------------------------------------------
type PreviewFilter = 'all' | 'milestones' | 'critical' | 'problems';

function PreviewStep({ s, q, boqPick, setBoqPick, elField, setElField, onBack, onNext, boqColumns, elementsFound }: {
  s: ParsedSchedule; q: QualityReport; boqPick: BoqPick; setBoqPick: (v: BoqPick) => void; elField: string; setElField: (v: string) => void;
  reparsing: boolean; onBack: () => void; onNext: () => void;
  /** The file has Unit / Qty / Rate / Amount columns (the BoQ is created from them on Import BoQ). */
  boqColumns: boolean;
  elementsFound: { elements: number; levels: number } | null;
}) {
  const [filter, setFilter] = useState<PreviewFilter>('all');
  const [term, setTerm] = useState('');
  const [maxLevel, setMaxLevel] = useState(0);
  const stats = useMemo(() => {
    const preds = new Map<number, number>(), succs = new Map<number, number>();
    for (const l of s.source_links) { preds.set(l.succ_uid, (preds.get(l.succ_uid) ?? 0) + 1); succs.set(l.pred_uid, (succs.get(l.pred_uid) ?? 0) + 1); }
    const problems = new Map<number, string>();
    for (const t of s.tasks) {
      const why: string[] = [];
      if (!t.start || !t.finish) why.push('no dates');
      else if (t.finish < t.start) why.push('finish is before start');
      if (!t.is_summary && (t.pct_complete ?? 0) < 100 && !t.is_milestone && (!preds.has(t.uid) || !succs.has(t.uid))) why.push(!preds.has(t.uid) ? 'no predecessor' : 'no successor');
      if (!t.is_summary && (t.total_float_days ?? 0) < 0) why.push('negative float');
      if (why.length) problems.set(t.uid, why.join(', '));
    }
    const fieldCounts = new Map<string, number>();
    for (const t of s.tasks) for (const [k, v] of Object.entries(t.custom)) if (v) fieldCounts.set(k, (fieldCounts.get(k) ?? 0) + 1);
    return { preds, succs, problems, fieldCounts, summaries: s.tasks.filter((t) => t.is_summary).length, milestones: s.tasks.filter((t) => t.is_milestone).length,
      critical: s.tasks.filter((t) => t.is_critical && !t.is_summary).length, withBoq: s.tasks.filter((t) => t.boq_code).length,
      hasBaseline: s.tasks.some((t) => t.baseline_start), levels: Math.max(1, ...s.tasks.map((t) => t.outline_level)) };
  }, [s]);
  const tl = term.trim().toLowerCase();
  const rows = s.tasks.filter((t) => (!maxLevel || t.outline_level <= maxLevel)
    && (filter === 'all' || (filter === 'milestones' ? t.is_milestone : filter === 'critical' ? t.is_critical && !t.is_summary : stats.problems.has(t.uid)))
    && (!tl || t.name.toLowerCase().includes(tl) || (t.wbs ?? '').toLowerCase().includes(tl)));
  const cal = s.calendars.find((c) => c.uid === s.project_calendar_uid) ?? s.calendars[0];
  const holidays = cal ? cal.exceptions.filter((e) => !e.is_working) : [];
  const fieldOpts = s.custom_fields.filter((f) => stats.fieldCounts.has(f.field_name) || f.alias);
  const extraKeys = [...stats.fieldCounts.keys()].filter((k) => !s.custom_fields.some((f) => f.field_name === k));
  const label = (k: string) => { const f = s.custom_fields.find((x) => x.field_name === k); return `${k}${f?.alias ? ` “${f.alias}”` : ''} · ${num(stats.fieldCounts.get(k) ?? 0, 0)} tasks`; };
  const boqValue = boqPick === undefined ? '__auto' : boqPick === null ? '__none' : boqPick;
  const issues = q.checks.filter((c) => c.severity === 'warning' || c.severity === 'error');
  const others = q.checks.filter((c) => !(c.severity === 'warning' || c.severity === 'error'));

  return (
    <>
      <Card title={<>{s.file_name}</>} sub={`${s.source === 'mspdi' ? 'MS Project XML' : 'Excel'}${s.save_version ? ` · saved by MS Project ${s.save_version}` : ''}`}>
        <div className="imp-summary">
          <span><b>{num(s.tasks.length, 0)}</b> tasks</span><span><b>{num(stats.summaries, 0)}</b> summary</span><span><b>{num(stats.milestones, 0)}</b> milestones</span>
          <span><b>{num(s.source_links.length, 0)}</b> links</span><span><b>{num(stats.critical, 0)}</b> critical</span>
          <span>Project <b>{d2(s.project_start)}</b> → <b>{d2(s.project_finish)}</b></span>
          {s.status_date && <span>Status date <b>{d2(s.status_date)}</b></span>}
          <span>Baseline {stats.hasBaseline ? <b>✓ in the file</b> : <b>none — the current dates can become the baseline</b>}</span>
          {s.currency && <span>Currency <b>{s.currency}</b></span>}
        </div>
        {s.warnings.length > 0 && <details className="mt-2"><summary className="small-text">{s.warnings.length} reader note(s)</summary><ul className="small-text">{s.warnings.slice(0, 50).map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
      </Card>

      <Card title={issues.length ? `${issues.length} thing${issues.length === 1 ? '' : 's'} to check` : 'Schedule quality: looks good'}
        sub="DCMA-style checks. Only duplicate IDs and logic loops stop the import; the rest are advice.">
        {q.blocking && <Banner tone="error">This file can't be imported yet: fix the items marked “Must fix” in MS Project, save as XML again and re-upload.</Banner>}
        <ul className="quality-list">
          {[...issues, ...others].map((c) => (
            <li key={c.id}>
              <details>
                <summary>
                  <Badge tone={SEV[c.severity].tone} label={SEV[c.severity].label} />
                  <span>{c.label}</span>
                  <span className="q-count">{c.id === 'calendar' ? '' : `${num(c.count, 0)} of ${num(c.total, 0)}${c.count ? ` · ${c.pct} %` : ''}`}</span>
                </summary>
                {c.hint && <p className="q-hint">{c.hint}</p>}
                {c.examples.length > 0 && <ul className="q-ex">{c.examples.map((e) => <li key={`${e.uid}${e.detail}`}>UID {e.uid} · {e.name}{e.detail ? ` — ${e.detail}` : ''}</li>)}{c.count > c.examples.length && <li className="muted">…and {num(c.count - c.examples.length, 0)} more</li>}</ul>}
              </details>
            </li>
          ))}
        </ul>
      </Card>

      {elementsFound && (
        <Banner tone="info">{elementsFound.elements} building elements (columns, slabs, walls, stairs …) on {elementsFound.levels} levels were recognised in the task names.
          They are created after the import — review them on the last screen.</Banner>
      )}
      {boqColumns && (
        <Banner tone="info">This schedule also contains BoQ quantities (Unit, Qty, Rate, Amount columns). Import the schedule first —
          then create the BoQ from these columns on <b>Planning › Import BoQ</b>. You can skip the “Link to BoQ” step.</Banner>
      )}
      <div className="grid-2">
        <Card title="Calendar" sub={cal ? `${cal.name}${s.calendars.length > 1 ? ` · ${s.calendars.length - 1} other calendar(s)` : ''}` : 'No calendar in the file'}>
          {cal ? (
            <div className="stack">
              <div className="row"><span className="weekdays" aria-label="Working days">{WD.map((d, i) => <span key={d} className={cal.working_weekdays.includes(i + 1) ? 'on' : ''}>{d}</span>)}</span>
                <span className="muted small-text">{cal.working_weekdays.length}-day week · {num(cal.hours_per_day, 1)} h/day</span></div>
              {holidays.length ? (
                <details><summary className="small-text">{holidays.length} holiday(s) / non-working day(s)</summary>
                  <ul className="small-text">{holidays.slice(0, 60).map((h, i) => <li key={i}>{d2(h.from)}{h.to !== h.from ? ` → ${d2(h.to)}` : ''} {h.name ?? ''}</li>)}</ul></details>
              ) : <Banner tone="info">No holidays in the file's calendar. Ethiopian public holidays will be applied from the project calendar (Genna, Timket, Adwa, Fasika, Meskel…) to forecasts and progress.</Banner>}
            </div>
          ) : <p className="muted">The project's default calendar (Mon–Sat + public holidays) is used.</p>}
        </Card>
        <Card title="BoQ codes" sub={boqColumns ? 'Not needed when the BoQ is created from this schedule’s columns. Pick one only if a column holds existing BoQ item numbers.' : 'Which MS Project column holds the BoQ item number?'}>
          <div className="form-grid">
            <Field label="BoQ code field" hint={`${num(stats.withBoq, 0)} task(s) have a BoQ code${s.boq_field ? ` (from ${s.boq_field})` : ''}`}>
              <select value={boqValue} onChange={(e) => setBoqPick(e.target.value === '__auto' ? undefined : e.target.value === '__none' ? null : e.target.value)}>
                <option value="__auto">Detect automatically</option>
                <option value="__none">None (codes in task names only)</option>
                {fieldOpts.map((f) => <option key={f.field_name} value={f.field_name}>{label(f.field_name)}</option>)}
                {extraKeys.map((k) => <option key={k} value={k}>{label(k)}</option>)}
              </select>
            </Field>
            <Field label="Element code field" hint="Optional: column with element codes (C1;C2@GF)">
              <select value={elField} onChange={(e) => setElField(e.target.value)}>
                <option value="">None</option>
                {fieldOpts.map((f) => <option key={f.field_name} value={f.field_name}>{label(f.field_name)}</option>)}
                {extraKeys.map((k) => <option key={k} value={k}>{label(k)}</option>)}
              </select>
            </Field>
          </div>
          {!fieldOpts.length && !extraKeys.length && <p className="muted small-text">No custom fields in this file. Tip: add a “BoQ code” Text column in MS Project — linking then happens by itself.</p>}
        </Card>
      </div>

      <Card flush title="Tasks (WBS)">
        <div className="pad" style={{ paddingBottom: 0 }}>
          <FilterBar>
            <SearchInput value={term} onChange={setTerm} placeholder="Search tasks" />
            <Tabs variant="segmented" label="Task filter" value={filter} onChange={setFilter} tabs={[
              { key: 'all', label: 'All', count: s.tasks.length }, { key: 'milestones', label: 'Milestones', count: stats.milestones },
              { key: 'critical', label: 'Critical', count: stats.critical }, { key: 'problems', label: 'Problems', count: stats.problems.size, hot: stats.problems.size > 0 },
            ]} />
            <span className="filter-chip"><label className="chip-label" htmlFor="imp-lvl">Levels</label>
              <select id="imp-lvl" value={maxLevel} onChange={(e) => setMaxLevel(Number(e.target.value))}>
                <option value={0}>All</option>{Array.from({ length: Math.min(stats.levels, 8) }, (_, i) => <option key={i} value={i + 1}>Up to level {i + 1}</option>)}
              </select></span>
          </FilterBar>
        </div>
        <DataTable rows={rows} rowKey={(t) => String(t.uid)} maxHeight="60vh" stickyFirst filtered={filter !== 'all' || !!tl || !!maxLevel}
          onClearFilters={() => { setFilter('all'); setTerm(''); setMaxLevel(0); }}
          columns={[
            { key: 'wbs', label: 'WBS', id: true, sortable: false, value: (t) => t.wbs ?? t.outline_number ?? '' },
            { key: 'name', label: 'Task', sortable: false, render: (t) => (
              <span className={`tree-name${t.is_summary ? ' summary' : ''}`} style={{ paddingLeft: (t.outline_level - 1) * 16 }}>
                {t.is_critical && !t.is_summary && <Flame size={12} className="danger-text" aria-label="Critical" />}{t.is_milestone ? `◆ ${t.name}` : t.name}
              </span>) },
            { key: 'start', label: 'Start', sortable: false, render: (t) => d2(t.start) || <span className="danger-text">—</span> },
            { key: 'finish', label: 'Finish', sortable: false, render: (t) => d2(t.finish) || <span className="danger-text">—</span> },
            { key: 'duration_days', label: 'Days', align: 'right', sortable: false, render: (t) => num(t.duration_days, 1) },
            { key: 'preds', label: 'Pred.', align: 'right', sortable: false, value: (t) => stats.preds.get(t.uid) ?? 0 },
            { key: 'succs', label: 'Succ.', align: 'right', sortable: false, value: (t) => stats.succs.get(t.uid) ?? 0 },
            { key: 'boq_code', label: 'BoQ code', sortable: false },
            { key: 'problem', label: 'Check', sortable: false, value: (t) => stats.problems.get(t.uid) ?? '', render: (t) => (stats.problems.has(t.uid) ? <span className="warn-text small-text">{stats.problems.get(t.uid)}</span> : null) },
          ]} />
      </Card>
      <div className="imp-actions">
        <button onClick={onBack}>‹ Back</button>
        <button className="primary" disabled={q.blocking} title={q.blocking ? 'Fix the “Must fix” items first' : undefined} onClick={onNext}>Next: Link to BoQ ›</button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Link (client-side preview of the server's mapping; manual picks go into boq_codes / element_codes)
// ---------------------------------------------------------------------------
const manualStore = new WeakMap<ParsedSchedule, Map<number, { boq: string; el: string }>>();
const acceptStore = new WeakMap<ParsedSchedule, Set<number>>();
const getManual = (s: ParsedSchedule) => { let m = manualStore.get(s); if (!m) { m = new Map(); manualStore.set(s, m); } return m; };
const getAccepted = (s: ParsedSchedule) => { let m = acceptStore.get(s); if (!m) { m = new Set(); acceptStore.set(s, m); } return m; };

function useMatching(s: ParsedSchedule, elField: string, boq: BoqItemRow[] | undefined, L: Lookups, manualVersion: number) {
  return useMemo(() => {
    const out = new Map<number, TaskMatch>();
    if (!boq) return out;
    const boqBy = new Map(boq.map((b) => [normCode(b.item_no), b]));
    const lvlCode = new Map(L.levels.map((l) => [l.id, l.code]));
    const elBy = new Map<string, { code: string; lvl: string | null }[]>();
    for (const e of L.elements) { const k = normCode(e.code); const a = elBy.get(k) ?? []; a.push({ code: e.code, lvl: e.level_id ? lvlCode.get(e.level_id) ?? null : null }); elBy.set(k, a); }
    const elKey = elField ? s.custom_fields.find((f) => f.field_name === elField || f.alias === elField)?.field_name ?? elField : '';
    const manual = getManual(s), accepted = getAccepted(s);
    for (const t of s.tasks) {
      if (t.is_summary || t.is_milestone) continue;
      const m: TaskMatch = { how: null, boq: [], el: [], label: '' };
      const man = manual.get(t.uid);
      if (man && (man.boq || man.el)) {
        m.how = 'manual';
        if (man.boq) m.boq.push(man.boq);
        if (man.el) m.el.push(man.el);
      } else {
        for (const tok of (t.boq_code ?? '').split(/\s*[;,]\s*/)) {
          if (!tok) continue;
          const [code, qty] = tok.split('=');
          const b = boqBy.get(normCode(code));
          if (b) m.boq.push(qty ? `${b.item_no}=${qty.trim()}` : b.item_no);
        }
        if (m.boq.length) m.how = 'code';
        if (elKey && t.custom[elKey]) {
          for (const tok of t.custom[elKey].split(/\s*[;,]\s*/)) {
            const [code, lvl] = tok.split('@');
            if (code && elBy.has(normCode(code))) m.el.push(lvl ? `${code.trim()}@${lvl.trim()}` : code.trim());
          }
          if (m.el.length && !m.how) m.how = 'element';
        }
        if (!m.how) {
          // name match: element codes (C1, SW-2) and BoQ-looking numbers (02.03.01) in the task name
          for (const tok of t.name.match(/\b[A-Z]{1,3}-?\d{1,4}\b/g) ?? []) {
            const hit = elBy.get(normCode(tok));
            if (hit) for (const h of hit) m.el.push(h.lvl ? `${h.code}@${h.lvl}` : h.code);
          }
          for (const tok of t.name.match(/\b\d{1,2}(?:\.\d{1,3}){1,3}\b/g) ?? []) { const b = boqBy.get(normCode(tok)); if (b) m.boq.push(b.item_no); }
          if (m.el.length || m.boq.length) { m.how = 'name'; if (!accepted.has(t.uid)) { m.label = 'review'; } }
        }
      }
      m.el = [...new Set(m.el)].slice(0, 200);
      m.boq = [...new Set(m.boq)];
      out.set(t.uid, m);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, elField, boq, L, manualVersion]);
}

/** Whether a match will be sent with the import. */
const effective = (m: TaskMatch | undefined) => !!m && !!m.how && !(m.how === 'name' && m.label === 'review');

function LinkStep({ s, elField, projectId, L, onBack, onNext }: { s: ParsedSchedule; elField: string; projectId: string; L: Lookups; onBack: () => void; onNext: () => void }) {
  const boq = useAsync(() => loadBoqItems(projectId), [projectId], { key: 'boq-items', staleTime: 5 * 60_000 });
  const [ver, setVer] = useState(0);
  const [view, setView] = useState<'todo' | 'review' | 'linked'>('todo');
  const [term, setTerm] = useState('');
  const matches = useMatching(s, elField, boq.data, L, ver);
  const work = s.tasks.filter((t) => !t.is_summary && !t.is_milestone);
  const cnt = { code: 0, element: 0, name: 0, manual: 0, review: 0, none: 0 };
  for (const t of work) {
    const m = matches.get(t.uid);
    if (!m?.how) cnt.none++;
    else if (m.how === 'name' && m.label === 'review') cnt.review++;
    else cnt[m.how]++;
  }
  const linked = cnt.code + cnt.element + cnt.name + cnt.manual;
  const pct = (n: number) => (work.length ? (n / work.length) * 100 : 0);
  const manual = getManual(s), accepted = getAccepted(s);
  const setManual = (uid: number, patch: Partial<{ boq: string; el: string }>) => {
    const cur = manual.get(uid) ?? { boq: '', el: '' };
    manual.set(uid, { ...cur, ...patch });
    setVer((v) => v + 1);
  };
  const tl = term.trim().toLowerCase();
  const rows = work.filter((t) => {
    const m = matches.get(t.uid);
    const inView = view === 'todo' ? !m?.how || m.how === 'manual' : view === 'review' ? m?.how === 'name' : !!m?.how && m.how !== 'manual' && m.how !== 'name';
    return inView && (!tl || t.name.toLowerCase().includes(tl) || (t.wbs ?? '').toLowerCase().includes(tl));
  });
  const boqNos = useMemo(() => new Set((boq.data ?? []).map((b) => b.item_no)), [boq.data]);
  const elCodes = useMemo(() => {
    const lv = new Map(L.levels.map((l) => [l.id, l.code]));
    return L.elements.map((e) => (e.level_id && lv.get(e.level_id) ? `${e.code}@${lv.get(e.level_id)}` : e.code));
  }, [L]);

  if (boq.error) return <ErrorBanner error={boq.error} onRetry={boq.reload} />;
  if (!boq.data) return <Loading lines={6} />;
  return (
    <>
      <Card title="Coverage" sub="Each work task should be linked to a BoQ item or elements so it carries budget and measurable progress. Unlinked tasks still show on the schedule.">
        <div className="coverage" role="img" aria-label={`${Math.round(pct(linked))} % of work tasks linked`}>
          <span className="cv-code" style={{ width: `${pct(cnt.code)}%` }} /><span className="cv-el" style={{ width: `${pct(cnt.element)}%` }} />
          <span className="cv-name" style={{ width: `${pct(cnt.name)}%` }} /><span className="cv-manual" style={{ width: `${pct(cnt.manual)}%` }} />
        </div>
        <div className="cv-legend">
          <span className="strong">{Math.round(pct(linked))} % linked · {num(linked, 0)} / {num(work.length, 0)} work tasks</span>
          <span><i className="cv-code" />by BoQ code {num(cnt.code, 0)}</span><span><i className="cv-el" />by element code {num(cnt.element, 0)}</span>
          <span><i className="cv-name" />by name {num(cnt.name, 0)}</span><span><i className="cv-manual" />by hand {num(cnt.manual, 0)}</span>
          {cnt.review > 0 && <span className="warn-text">{num(cnt.review, 0)} name matches to review</span>}
        </div>
        {!boq.data.length && <Banner tone="warn">This project has no BoQ items yet — continue without links. After the import, create the BoQ on Planning › Import BoQ (from this schedule's columns or from Excel).</Banner>}
      </Card>
      <Card flush>
        <div className="pad" style={{ paddingBottom: 0 }}>
          <FilterBar right={view === 'review' && cnt.review > 0 ? <button className="small" onClick={() => { for (const t of work) if (matches.get(t.uid)?.how === 'name') accepted.add(t.uid); setVer((v) => v + 1); }}>Accept all {cnt.review} name matches</button> : undefined}>
            <Tabs variant="segmented" label="Link view" value={view} onChange={setView} tabs={[
              { key: 'todo', label: 'Not linked', count: cnt.none + cnt.manual, hot: cnt.none > 0 }, { key: 'review', label: 'Name matches', count: cnt.name + cnt.review, hot: cnt.review > 0 },
              { key: 'linked', label: 'Linked by code', count: cnt.code + cnt.element },
            ]} />
            <SearchInput value={term} onChange={setTerm} placeholder="Search tasks" />
          </FilterBar>
        </div>
        <datalist id="imp-boq">{(boq.data ?? []).map((b) => <option key={b.id} value={b.item_no}>{b.description}</option>)}</datalist>
        <datalist id="imp-el">{elCodes.map((c) => <option key={c} value={c} />)}</datalist>
        <DataTable rows={rows} rowKey={(t) => String(t.uid)} maxHeight="55vh" stickyFirst filtered={!!tl} onClearFilters={() => setTerm('')}
          empty={{ title: view === 'todo' ? 'Every work task is linked' : view === 'review' ? 'No name matches' : 'No tasks linked by code', body: view === 'linked' ? 'Pick the BoQ code field on the Preview step, or link by hand.' : undefined }}
          columns={[
            { key: 'wbs', label: 'WBS', id: true, sortable: false, value: (t) => t.wbs ?? '' },
            { key: 'name', label: 'Task', sortable: false },
            { key: 'linked', label: 'Linked to', sortable: false, value: (t) => { const m = matches.get(t.uid); return m ? [...m.boq.map((b) => `BoQ ${b}`), ...m.el.slice(0, 6)].join(', ') : ''; },
              render: (t) => {
                const m = matches.get(t.uid);
                if (view === 'todo') {
                  const cur = manual.get(t.uid) ?? { boq: '', el: '' };
                  const badB = !!cur.boq && !boqNos.has(cur.boq);
                  return (
                    <span className="row" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
                      <input list="imp-boq" value={cur.boq} placeholder="BoQ item no." aria-label={`BoQ item for ${t.name}`} style={{ width: 130 }} className={badB ? 'invalid' : undefined}
                        onChange={(e) => setManual(t.uid, { boq: e.target.value.trim() })} title={badB ? 'Not in the BoQ list' : undefined} />
                      <input list="imp-el" value={cur.el} placeholder="Element code" aria-label={`Element for ${t.name}`} style={{ width: 130 }} onChange={(e) => setManual(t.uid, { el: e.target.value.trim() })} />
                    </span>
                  );
                }
                if (!m) return null;
                const items = [...m.boq.map((b) => `BoQ ${b}`), ...m.el.slice(0, 6)];
                return <span>{items.join(', ')}{m.el.length > 6 ? ` +${m.el.length - 6}` : ''}</span>;
              } },
            { key: 'how', label: 'How', sortable: false, value: (t) => matches.get(t.uid)?.how ?? '', render: (t) => {
              const m = matches.get(t.uid);
              if (!m?.how) return null;
              if (m.how === 'name') {
                const ok = accepted.has(t.uid);
                return (
                  <span className="row" style={{ gap: 4 }}>
                    <Badge tone={ok ? 'success' : 'warning'} label={ok ? '≈ name ✓' : '≈ name'} icon={null} />
                    <button className="small" onClick={() => { if (ok) accepted.delete(t.uid); else accepted.add(t.uid); setVer((v) => v + 1); }}>{ok ? 'Undo' : 'Accept'}</button>
                  </span>
                );
              }
              return <Badge tone={m.how === 'manual' ? 'violet' : 'success'} label={m.how === 'code' ? '✓ BoQ code' : m.how === 'element' ? '✓ element code' : 'by hand'} icon={null} />;
            } },
          ]} />
      </Card>
      <div className="imp-actions">
        <button onClick={onBack}>‹ Back</button>
        <button className="primary" onClick={onNext}>Next: Confirm ›</button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Confirm (diff vs the stored schedule) → import_schedule
// ---------------------------------------------------------------------------
function ConfirmStep({ s, target, newCode, elField, projectId, L, onBack, onDone }: {
  s: ParsedSchedule; target: SchedHeader | undefined; newCode: string; elField: string; projectId: string; L: Lookups;
  onBack: () => void; onDone: (r: ImportScheduleResult) => void;
}) {
  const auth = useAuth();
  const boq = useAsync(() => loadBoqItems(projectId), [projectId], { key: 'boq-items', staleTime: 5 * 60_000 });
  const matches = useMatching(s, elField, boq.data, L, 0);
  const ex = useAsync(() => loadTasks(target?.id ?? ''), [target?.id], { key: 'sched-tasks', enabled: !!target, staleTime: 60_000 });
  // In-app edits since the last import (Schedule › Edit plan): the file replaces them.
  const appEdits = useAsync(async () => (await loadEdits(target?.id ?? '')).filter((e) => !e.undone_at), [target?.id, target?.current_version_id],
    { key: 'sched-edits', enabled: !!target });
  const existing: ExistingTask[] = useMemo(() => (ex.data ?? []).map((t) => ({
    key: t.id, uid: t.msp_uid, guid: t.msp_guid, name: t.name, wbs: t.wbs, outline_level: t.outline_level, is_summary: t.is_summary, is_milestone: t.is_milestone,
    start: t.planned_start ?? undefined, finish: t.planned_finish ?? undefined, duration_days: t.duration_days == null ? undefined : Number(t.duration_days),
    pct_complete: Number(t.pct_complete), has_progress: Number(t.pct_complete) > 0 || Number(t.reported_pct) > 0,
  })), [ex.data]);
  const diff: ScheduleDiff | null = useMemo(() => (target && !ex.data ? null : diffSchedule(s.tasks, existing, { fields: DIFF_FIELDS })), [s, existing, target, ex.data]);
  const first = !target || !existing.length;
  const fileHasProgress = s.tasks.some((t) => (t.pct_complete ?? 0) > 0);
  const projCur = auth.project?.currency ?? 'ETB';
  const curDiffers = !!s.currency && s.currency !== projCur;

  const [view, setView] = useState<'changed' | 'added' | 'removed'>('changed');
  const [applyCal, setApplyCal] = useState(true);
  const [blNo, setBlNo] = useState(s.baseline_number);
  const [opening, setOpening] = useState(false);
  const [acceptCur, setAcceptCur] = useState(false);
  const [fileWins, setFileWins] = useState(false);
  const [name, setName] = useState(target?.name ?? s.name);
  const [confirmRm, setConfirmRm] = useState<Set<number>>(new Set());
  const [remap, setRemap] = useState<Map<number, number>>(new Map());
  const [onlySlip, setOnlySlip] = useState(false);
  const { busy, error, run } = useBusy();

  const slip = (c: ScheduleDiff['changed'][number]) => {
    const from = c.existing.finish as string | undefined, to = c.task.finish;
    return from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) : 0;
  };

  const go = () => void run(async () => {
    const payload = toImportPayload(s, {
      op_id: crypto.randomUUID(), project_id: projectId, schedule_id: target?.id, code: !target && newCode ? newCode : undefined, name: name.trim() || undefined,
      elementField: elField || null,
      options: {
        apply_calendar: applyCal, baseline_number: blNo, ...(first && opening ? { opening_progress: true } : {}), ...(curDiffers && acceptCur ? { accept_currency: true } : {}),
        ...(confirmRm.size ? { confirm_remove_uids: [...confirmRm] } : {}),
        ...(remap.size ? { uid_remap: [...remap].map(([old_uid, new_uid]) => ({ old_uid, new_uid })) } : {}),
      },
    });
    if (fileWins) payload.mapping = { ...payload.mapping, file_mapping_wins: true };
    // Mapping preview → explicit codes (canonical BoQ item numbers / element code@level) so the server links exactly what was shown.
    for (const t of payload.schedule.tasks) {
      const m = matches.get(t.uid);
      if (!effective(m)) continue;
      if (m!.boq.length) t.boq_codes = m!.boq;
      if (m!.el.length) t.element_codes = m!.el;
    }
    const r = (await schedRpc('import_schedule', payload)) as unknown as ImportScheduleResult;
    onDone(r);
  });

  if (target && ex.error) return <ErrorBanner error={ex.error} onRetry={ex.reload} />;
  if (!diff || !boq.data) return <Loading lines={6} />;
  const rwp = diff.removed_with_progress;
  const changedRows = onlySlip ? diff.changed.filter((c) => Math.abs(slip(c)) > 5) : diff.changed;
  const linkedCount = s.tasks.filter((t) => effective(matches.get(t.uid))).length;
  const pcal = s.calendars.find((c) => c.uid === s.project_calendar_uid) ?? s.calendars[0];
  const noHolidays = !pcal || !pcal.exceptions.some((e) => !e.is_working);

  return (
    <>
      {!first && (appEdits.data?.length || (ex.data ?? []).some((t) => t.origin === 'app')) ? (
        <Banner tone="warn">
          <b>The plan was changed in the app since the last import</b>{appEdits.data?.length ? ` (${appEdits.data.length} edit${appEdits.data.length === 1 ? '' : 's'}, latest: ${appEdits.data[0].summary})` : ''}.
          {' '}MS Project is the master: this file replaces those changes, and {(ex.data ?? []).filter((t) => t.origin === 'app' && !s.tasks.some((f) => f.uid === t.msp_uid)).length} task(s) created in the app that are not in this file will be removed.
          {' '}To keep them, cancel, use Schedule › ⋯ › <b>Export to MS Project (XML)</b>, update that file in MS Project and import it.
        </Banner>
      ) : null}
      <Card title={first ? 'Ready to import' : `What will change (${target?.code} → new revision)`}>
        {first ? (
          <p className="mb-0">{num(s.tasks.length, 0)} tasks and {num(s.source_links.length, 0)} links will be created{target ? ` in “${target.name}”` : ' as a new schedule'}. {num(linkedCount, 0)} task(s) will be linked to the BoQ / elements.</p>
        ) : (
          <div className="diff-chips">
            <Badge tone="success" label={`+ ${num(diff.summary.added, 0)} new`} icon={null} />
            <Badge tone="info" label={`~ ${num(diff.summary.changed, 0)} changed`} icon={null} />
            <Badge tone={diff.summary.removed ? 'warning' : 'neutral'} label={`− ${num(diff.summary.removed, 0)} removed`} icon={null} />
            <Badge tone="neutral" label={`= ${num(diff.summary.unchanged, 0)} unchanged`} icon={null} />
            <Badge tone="success" icon={CircleCheck} label="Progress, links and baselines are kept" />
          </div>
        )}
      </Card>
      {!first && (
        <Card flush>
          <div className="pad" style={{ paddingBottom: 0 }}>
            <FilterBar right={view === 'changed' ? <label className="row small-text"><input type="checkbox" checked={onlySlip} onChange={(e) => setOnlySlip(e.target.checked)} />Only dates moved &gt; 5 d</label> : undefined}>
              <Tabs variant="segmented" label="Changes" value={view} onChange={setView} tabs={[
                { key: 'changed', label: 'Changed', count: diff.summary.changed }, { key: 'added', label: 'New', count: diff.summary.added },
                { key: 'removed', label: 'Removed', count: diff.summary.removed, hot: rwp.length > 0 },
              ]} />
            </FilterBar>
          </div>
          {view === 'changed' && (
            <DataTable rows={changedRows} rowKey={(c) => String(c.task.uid)} maxHeight="45vh" empty={{ title: 'No changed tasks' }}
              columns={[
                { key: 'wbs', label: 'WBS', id: true, value: (c) => c.task.wbs ?? '' },
                { key: 'name', label: 'Task', value: (c) => c.task.name },
                { key: 'was', label: 'Was', value: (c) => c.changes.map((x) => `${x.field}: ${String(x.from ?? '')}`).join('; '),
                  render: (c) => <span className="small-text">{c.changes.map((x) => <div key={x.field}>{fieldLabel(x.field)}: {fmtVal(x.from)}</div>)}</span> },
                { key: 'now', label: 'Now', value: (c) => c.changes.map((x) => `${x.field}: ${String(x.to ?? '')}`).join('; '),
                  render: (c) => { const d = slip(c); return <span className="small-text">{c.changes.map((x) => <div key={x.field}>{fieldLabel(x.field)}: {fmtVal(x.to)}{x.field === 'finish' && d !== 0 && <span className={d > 0 ? 'slip-up' : 'slip-down'}> {d > 0 ? `▲+${d}` : `▼${d}`} d</span>}</div>)}</span>; } },
                { key: 'prog', label: 'Progress', value: (c) => c.existing.pct_complete ?? 0, render: (c) => (c.existing.pct_complete ? `${num(c.existing.pct_complete, 0)} % kept` : '—') },
              ]} />
          )}
          {view === 'added' && (
            <DataTable rows={diff.added} rowKey={(t) => String(t.uid)} maxHeight="45vh" empty={{ title: 'No new tasks' }}
              columns={[
                { key: 'wbs', label: 'WBS', id: true, value: (t) => t.wbs ?? '' }, { key: 'name', label: 'Task' },
                { key: 'dates', label: 'Dates', value: (t) => t.start, render: (t) => `${d2(t.start)} → ${d2(t.finish)}` },
                { key: 'link', label: 'Link', value: (t) => (effective(matches.get(t.uid)) ? 'linked' : ''), render: (t) => (t.is_summary || t.is_milestone ? null : effective(matches.get(t.uid)) ? <Badge tone="success" label="linked" icon={null} /> : <span className="warn-text small-text">needs link</span>) },
              ]} />
          )}
          {view === 'removed' && (
            <>
              {rwp.length > 0 && <div className="pad"><Banner tone="warn">{rwp.length} removed task(s) have progress. By default they are kept as “Removed from schedule” so earned value history doesn't drop. You can map each one to its new task, or confirm the removal.</Banner></div>}
              <DataTable rows={diff.removed} rowKey={(e) => String(e.uid)} maxHeight="45vh" empty={{ title: 'No removed tasks' }}
                columns={[
                  { key: 'wbs', label: 'WBS', id: true, value: (e) => e.wbs ?? '' }, { key: 'name', label: 'Task' },
                  { key: 'dates', label: 'Was', value: (e) => e.start ?? '', render: (e) => `${d2(e.start as string)} → ${d2(e.finish as string)}` },
                  { key: 'prog', label: 'Progress', value: (e) => e.pct_complete ?? 0, render: (e) => (e.has_progress ? <Badge tone="warning" label={`${num(e.pct_complete, 0)} % ⚠`} icon={null} /> : '—') },
                  { key: 'action', label: 'What to do', sortable: false, noExport: true, render: (e) => (!e.has_progress || e.uid == null ? <span className="muted small-text">deleted</span> : (
                    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <select aria-label={`Remap ${e.name}`} value={remap.get(e.uid) ?? ''} onChange={(ev) => { const n = new Map(remap); if (ev.target.value) n.set(e.uid!, Number(ev.target.value)); else n.delete(e.uid!); setRemap(n); }}>
                        <option value="">Keep as history</option>
                        {suggest(e, diff.added).map((t) => <option key={t.uid} value={t.uid}>→ UID {t.uid} {t.name}</option>)}
                      </select>
                      <label className="row small-text"><input type="checkbox" checked={confirmRm.has(e.uid)} disabled={remap.has(e.uid)}
                        onChange={(ev) => { const n = new Set(confirmRm); if (ev.target.checked) n.add(e.uid!); else n.delete(e.uid!); setConfirmRm(n); }} />Remove anyway</label>
                    </span>
                  )) },
                ]} />
            </>
          )}
        </Card>
      )}
      <Card title="Options">
        <ErrorBanner error={error} />
        <div className="form-grid">
          <Field label="Schedule name" wide><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Baseline dates from" hint="Which MS Project baseline (0 = “Baseline”) is read as the file baseline">
            <select value={blNo} onChange={(e) => setBlNo(Number(e.target.value))}>{Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>{i === 0 ? 'Baseline' : `Baseline ${i}`}</option>)}</select>
          </Field>
          <Field label="Use this file's calendar (working days and holidays) for the project" check wide><input type="checkbox" checked={applyCal} onChange={(e) => setApplyCal(e.target.checked)} /></Field>
          {noHolidays && <div className="wide"><Banner tone="info">{pcal ? `“${pcal.name}” has no holidays.` : 'The file has no calendar.'} Ethiopian public holidays will be applied from the project calendar — they are always added on top of the working week.</Banner></div>}
          {first && fileHasProgress && <Field label="Take the file's % complete as opening progress (verified, dated the file's status date)" check wide><input type="checkbox" checked={opening} onChange={(e) => setOpening(e.target.checked)} /></Field>}
          {!first && <Field label="Use the file's BoQ / element codes even where tasks were linked by hand" check wide><input type="checkbox" checked={fileWins} onChange={(e) => setFileWins(e.target.checked)} /></Field>}
          {curDiffers && <Field label={`The file's currency is ${s.currency}, the project's is ${projCur} — import anyway`} check wide><input type="checkbox" checked={acceptCur} onChange={(e) => setAcceptCur(e.target.checked)} /></Field>}
        </div>
        {!first && <p className="muted small-text mb-0">MS Project's own % complete is ignored on re-imports — progress recorded here stays the record. Logic (links) is replaced by the file's.</p>}
      </Card>
      <div className="imp-actions">
        <button onClick={onBack} disabled={busy}>‹ Back</button>
        <button className="primary" disabled={busy || (curDiffers && !acceptCur)} title={curDiffers && !acceptCur ? 'Tick the currency option first' : undefined} onClick={go}>
          {busy && <span className="spinner" />}{busy ? `Importing ${num(s.tasks.length, 0)} tasks…` : first ? 'Import schedule' : 'Import revision'}
        </button>
      </div>
    </>
  );
}

const FIELD_LABEL: Partial<Record<DiffField, string>> = { start: 'Start', finish: 'Finish', duration_days: 'Days', name: 'Name', wbs: 'WBS', outline_level: 'Level', is_summary: 'Summary', is_milestone: 'Milestone' };
const fieldLabel = (f: DiffField) => FIELD_LABEL[f] ?? f;
const fmtVal = (v: unknown) => (v == null || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? d2(v) : String(v));

/** New tasks most like a removed one (same WBS, then shared name words). */
function suggest(e: ExistingTask, added: ImportTask[]): ImportTask[] {
  const words = new Set(e.name.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  return added.filter((t) => !t.is_summary).map((t) => {
    const tw = t.name.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const shared = tw.filter((w) => words.has(w)).length;
    return { t, score: (t.wbs && t.wbs === e.wbs ? 3 : 0) + shared / Math.max(1, Math.max(words.size, tw.length)) };
  }).filter((x) => x.score > 0.3).sort((a, b) => b.score - a.score).slice(0, 8).map((x) => x.t);
}

function ResultCard({ r, onAgain, onOpen, onBoq, boqColumns, canSeePrices, offerBaseline }: {
  r: ImportScheduleResult; onAgain: () => void; onOpen: (hash: string) => void; onBoq: () => void;
  boqColumns: boolean; canSeePrices: boolean; offerBaseline: boolean;
}) {
  const kept = r.diff?.kept_progress ?? [];
  const added = Number(r.added);
  // msp_pct_vs_verified alone = the file's % complete differs from verified progress (kept): information, not a plan change.
  const pctOnly = (r.diff?.changed ?? []).filter((c) => { const k = Object.keys(c.fields ?? {}); return k.length > 0 && k.every((x) => x === 'msp_pct_vs_verified'); }).length;
  const changed = Math.max(0, Number(r.changed) - pctOnly);
  return (
    <>
    <Card title={r.duplicate ? 'This file was already imported' : `Schedule v${r.version_no} imported`}
      sub={r.duplicate ? 'The same file (same contents) was imported before — nothing changed. The earlier result is shown.' : undefined}>
      <div className="imp-summary">
        <span><b>{num(r.added, 0)}</b> new</span><span><b>{num(changed, 0)}</b> changed</span><span><b>{num(r.removed, 0)}</b> removed</span>
        <span><b>{num(r.kept_progress, 0)}</b> removed but kept (progress)</span><span><b>{num(r.links, 0)}</b> links</span>
      </div>
      {pctOnly > 0 && <Banner tone="info">{num(pctOnly, 0)} task(s) have a different % complete in the MS Project file — the verified progress recorded here is kept.</Banner>}
      {kept.length > 0 && <Banner tone="warn">{kept.length} task(s) are no longer in the file but have progress — they are kept as “Removed from schedule”.</Banner>}
      {(r.warnings?.length ?? 0) > 0 && (
        <details className="mt-2"><summary><FileWarning size={14} aria-hidden /> {r.warnings.length} warning(s) — e.g. BoQ codes not found</summary>
          <ul className="small-text">{r.warnings.slice(0, 80).map((w, i) => <li key={i}>{typeof w === 'string' ? w : JSON.stringify(w)}</li>)}</ul></details>
      )}
      <div className="row mt-2" style={{ flexWrap: 'wrap' }}>
        <button className="primary" onClick={() => onOpen('')}>Open the schedule</button>
        {added > 0 && !boqColumns && <button onClick={() => onOpen('?unlinked=1#table')}>Show tasks that need a BoQ link</button>}
        <button onClick={() => onOpen('#baselines')}>Baselines</button>
        <button onClick={onAgain}>Import another file</button>
      </div>
      <p className="muted small-text mb-0">Next: run the forecast on the schedule page, and propose a baseline if none is approved yet.</p>
    </Card>
    {boqColumns ? (
      <Card title="Next: create the BoQ from this schedule" sub="The file has Unit, Qty, Rate and Amount columns. Import BoQ turns each task with a quantity into a BoQ item, linked to its task.">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="primary" onClick={onBoq}>Import BoQ from this schedule ›</button>
          <span className="small-text muted">Set the baseline after the BoQ, so task budgets include the BoQ amounts.</span>
        </div>
      </Card>
    ) : offerBaseline && <BaselineOffer scheduleId={r.schedule_id} canSeePrices={canSeePrices} hasBoq={false} />}
    {!r.duplicate && <ElementsFromSchedule scheduleId={r.schedule_id} compact />}
    </>
  );
}
