// Task detail drawer (docs/research/schedule-ux.md §4.3): dates, float, logic, BoQ / element links editor
// (save_task_setup), EV method, progress history with verify actions, progress report (report_task_progress).
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Diamond, Flame, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { EV_METHOD_LABELS, type EvMethod, type LinkType } from '../../lib/contract-schedule';
import { dateTime, num } from '../../lib/format';
import { Badge, Banner, Bar, Card, Drawer, ErrorBanner, Field, Loading, Tabs, toast, useBusy } from '../ui';
import { DailyOutputForm } from './DailyOutputForm';
import { Attachments } from '../Attachments';
import { AssignmentsTab } from './Resources';
import { editRpc } from './editing';
import { VerifyQtyFields, initQtyDraft, qtyAdjusted, qtyInvalid, verifiedQty } from './VerifyQty';
import {
  BASELINE_APPROVE_ROLES, DERIVED_METHODS, EV_METHODS, PROGRESS_REPORT_ROLES, SCHEDULE_EDIT_ROLES, d2, dayNo, loadBoqItems, loadTaskDetail,
  schedRpc, taskState, todayStr, type SchedLink, type SchedTask, type TaskDetail,
} from './data';

type Tab = 'progress' | 'links' | 'logic' | 'resources' | 'setup';

export function TaskDrawer({ task, path, taskById, L, statusDay, late, onOpenTask, onClose }: {
  task: SchedTask; path: string; taskById: Map<string, SchedTask>; L: Lookups; statusDay: number; late: number;
  onOpenTask: (id: string) => void; onClose: () => void;
}) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const canEdit = !!role && SCHEDULE_EDIT_ROLES.includes(role);
  const canReport = !!role && PROGRESS_REPORT_ROLES.includes(role);
  const [tab, setTab] = useState<Tab>('progress');
  const d = useAsync(() => loadTaskDetail(task.id), [task.id], { key: 'sched-task' });
  const pending = d.data?.progress.filter((p) => p.status === 'reported').length ?? 0;
  const st = taskState(task);
  const pct = Number(task.pct_complete), rep = Number(task.reported_pct);

  // Planned % by the status date (linear over the baseline, else plan).
  const bs = dayNo(task.baseline_start ?? task.planned_start), bf = dayNo(task.baseline_finish ?? task.planned_finish);
  const plannedPct = Number.isNaN(bs) || Number.isNaN(bf) ? null : statusDay >= bf ? 100 : statusDay < bs ? 0 : Math.round(((statusDay - bs + 1) / (bf - bs + 1)) * 100);

  const cell = (label: string, a: string | null, b: string | null, extra?: React.ReactNode) => (
    <div><div className="dg-label">{label}</div><div className="dg-val">{a || b ? <>{d2(a) || '—'} →<br />{d2(b) || '—'}</> : <span className="muted-dash">—</span>}</div>{extra}</div>
  );
  const fcSlip = !Number.isNaN(dayNo(task.forecast_finish)) && !Number.isNaN(dayNo(task.baseline_finish ?? task.planned_finish))
    ? dayNo(task.forecast_finish) - dayNo(task.baseline_finish ?? task.planned_finish) : 0;

  return (
    <Drawer size="lg" onClose={onClose}
      title={<>{task.wbs && <span className="muted">{task.wbs} </span>}{task.name}</>}
      subtitle={<>{path || 'Top level'} · UID {task.msp_uid}</>}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {task.is_critical && <Badge tone="danger" icon={Flame} label="Critical" />}
        {task.is_milestone && <Badge tone="neutral" icon={Diamond} label="Milestone" />}
        {task.is_summary && <Badge tone="neutral" label="Summary" icon={null} />}
        <Badge value={st} />
        {late > 0 && <Badge tone={late > 7 ? 'danger' : 'warning'} icon={Clock} label={`${late} d late`} />}
        {pending > 0 && <Badge value="reported" label={`${pending} to verify`} />}
        {task.source_state === 'removed_in_source' && <Badge tone="warning" label="Removed from the MS Project file" icon={null} />}
      </div>
      <div className="prog-line mt-2">
        <div style={{ minWidth: 220 }}><Bar pct={pct} /></div>
        <span className="muted small-text">verified{rep !== pct ? ` · ${num(rep, 1)} % reported` : ''}{plannedPct !== null ? ` · planned by status date ${plannedPct} %` : ''}</span>
        {plannedPct !== null && st !== 'completed' && pct + 5 < plannedPct && <Badge tone="warning" icon={Clock} label="Behind" />}
      </div>
      <div className="date-grid">
        {cell('Baseline', task.baseline_start, task.baseline_finish)}
        {cell('Planned', task.planned_start, task.planned_finish)}
        {cell('Forecast', task.forecast_start, task.forecast_finish, fcSlip !== 0 && <div className={fcSlip > 0 ? 'slip-up small-text' : 'slip-down small-text'}>{fcSlip > 0 ? '▲ +' : '▼ '}{fcSlip} d</div>)}
        {cell('Actual', task.actual_start, task.actual_finish)}
      </div>
      {task.is_milestone && canEdit && <ClientMilestoneUpdate task={task} />}
      <dl className="kv">
        {!task.is_summary && <><dt>Float</dt><dd>{task.total_float_days == null ? '—' : `${num(task.total_float_days, 1)} d total`}{task.free_float_days != null ? ` · ${num(task.free_float_days, 1)} d free` : ''}{task.is_critical ? ' · on the critical path' : ''}</dd></>}
        <dt>Duration</dt><dd>{task.duration_days == null ? '—' : `${num(task.duration_days, 1)} working days`}{task.remaining_days != null && st === 'in_progress' ? ` · ${num(task.remaining_days, 1)} d remaining` : ''}</dd>
        {!task.is_summary && <><dt>Measured by</dt><dd>{EV_METHOD_LABELS[task.ev_method].en} <span className="muted">— {EV_METHOD_LABELS[task.ev_method].hint}</span></dd></>}
        {task.msp_pct_complete != null && <><dt>MS Project %</dt><dd>{num(task.msp_pct_complete, 0)} % <span className="muted">(reference only — not used for earned value)</span></dd></>}
        {(task.block_id || task.level_id) && <><dt>Location</dt><dd>{[L.block(task.block_id), L.level(task.level_id)].filter(Boolean).join(' / ')}</dd></>}
        {task.notes && <><dt>Notes</dt><dd>{task.notes}</dd></>}
      </dl>
      <div className="mt-2">
        <Tabs label="Task sections" value={tab} onChange={setTab} tabs={[
          { key: 'progress', label: 'Progress', count: pending || undefined, hot: pending > 0 },
          { key: 'links', label: 'BoQ & elements', count: d.data ? d.data.boq.length + d.data.elements.length : undefined },
          { key: 'logic', label: 'Logic' },
          ...(!task.is_summary ? [{ key: 'resources' as Tab, label: 'Resources' }] : []),
          ...(!task.is_summary ? [{ key: 'setup' as Tab, label: 'Measurement' }] : []),
        ]} />
      </div>
      <ErrorBanner error={d.error} onRetry={d.reload} />
      {!d.data ? <Loading lines={4} /> : (
        <>
          {tab === 'progress' && <ProgressTab task={task} detail={d.data} L={L} canReport={canReport} canVerify={canEdit} />}
          {tab === 'links' && <LinksTab task={task} detail={d.data} L={L} canEdit={canEdit} />}
          {tab === 'logic' && <LogicTab task={task} taskById={taskById} onOpenTask={onOpenTask} canEdit={canEdit} />}
          {tab === 'resources' && !task.is_summary && <AssignmentsTab task={task} canEdit={canEdit} />}
          {tab === 'setup' && !task.is_summary && <SetupTab task={task} detail={d.data} L={L} canEdit={canEdit} />}
        </>
      )}
    </Drawer>
  );
}

function ClientMilestoneUpdate({ task }: { task: SchedTask }) {
  const [action, setAction] = useState(task.client_recovery_action ?? '');
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    const { error: saveError } = await supabase.rpc('set_client_milestone_update', { p: { task_id: task.id, recovery_action: action } });
    if (saveError) throw new Error(saveError.message);
    toast.success(action.trim() ? 'Client milestone recovery action published' : 'Client recovery action removed');
  });
  return <Card title="Client milestone update" sub="Plain-language recovery action shown beside this milestone in the external portal.">
    <ErrorBanner error={error} />
    <Field label="Recovery action"><textarea rows={2} maxLength={1000} value={action} onChange={(e) => setAction(e.target.value)} placeholder="What will be done to protect or recover this milestone?" /></Field>
    <div className="row mt-2"><button disabled={busy} onClick={save}>{busy && <span className="spinner" />}Save client update</button>{task.client_recovery_updated_at && <span className="muted small-text">Last published {dateTime(task.client_recovery_updated_at)}</span>}</div>
  </Card>;
}

// ---------------------------------------------------------------------------
function ProgressTab({ task, detail, L, canReport, canVerify }: { task: SchedTask; detail: TaskDetail; L: Lookups; canReport: boolean; canVerify: boolean }) {
  const auth = useAuth();
  const me = auth.session?.user.id;
  const derived = DERIVED_METHODS.includes(task.ev_method);
  const removed = task.source_state === 'removed_in_source';
  return (
    <div className="stack">
      {task.is_summary ? <Banner tone="info">A summary takes its progress from its sub-tasks.</Banner>
        : task.ev_method === 'elements' ? (
          <Banner tone="info" action={<Link to="/progress#elements">Element progress →</Link>}>
            This task's progress comes from its linked elements. Report the element activities (columns, slabs…) instead — the task updates by itself when they are verified.
          </Banner>
        ) : task.ev_method === 'loe' ? <Banner tone="info">Level-of-effort task: it earns with time and is not reported.</Banner>
        : removed ? <Banner tone="warn">This task was removed from the MS Project file. Re-map it in the next import or leave it as history.</Banner>
        : canReport ? (
          <>
            <DailyOutputForm taskId={task.id} />
            <details className="mt-2">
              <summary className="small-text">Correct the to-date figure instead (re-measurement, remaining duration)</summary>
              <div className="mt-2"><ReportForm task={task} detail={detail} /></div>
            </details>
          </>
        ) : null}
      <h3 className="mb-0">Photos</h3>
      <Attachments entityType="schedule_task" entityId={task.id} canAdd={canReport} tags={['progress', 'before', 'after', 'issue']}
        emptyText="No photos of this activity yet — photos added with the daily output appear under each report in History." />
      <h3 className="mb-0">History</h3>
      {!detail.progress.length ? <p className="muted">No progress reported yet{derived ? '' : '. Site engineers report on the mobile app or here'}.</p> : (
        <ul className="hist">
          {detail.progress.map((p) => (
            <HistItem key={p.id} p={p} task={task} L={L} canVerify={canVerify && p.status === 'reported' && (p.reported_by !== me || auth.profile?.role === 'admin')} />
          ))}
        </ul>
      )}
    </div>
  );
}

function HistItem({ p, task, L, canVerify }: { p: TaskDetail['progress'][number]; task: SchedTask; L: Lookups; canVerify: boolean }) {
  const [pct, setPct] = useState(String(p.pct_complete ?? ''));
  const [qd, setQd] = useState(() => initQtyDraft(p.qty));
  const [comment, setComment] = useState('');
  const { busy, error, run } = useBusy();
  const editablePct = ['pct', '0_100', '50_50', 'milestone'].includes(p.method);
  const units = p.method === 'units' && !!p.qty?.length;
  const adjusted = editablePct ? Number(pct) !== Number(p.pct_complete) : units && qtyAdjusted(p.qty, qd);
  const decide = (approve: boolean) => {
    if ((!approve || adjusted) && !comment.trim()) { toast.error(approve ? 'Add a comment to verify with an adjustment' : 'Add a comment to reject'); return; }
    if (approve && units && qtyInvalid(p.qty, qd)) { toast.error('Enter the measured quantity (zero or more)'); return; }
    void run(async () => {
      await schedRpc('verify_task_progress', { progress_id: p.id, approve, verified_pct: approve && editablePct ? Number(pct) : undefined,
        verified_qty: approve && units && adjusted ? verifiedQty(p.qty, qd) : undefined, comment: comment.trim() || undefined });
      toast.success(`${task.name}: progress ${approve ? (adjusted ? 'adjusted' : 'verified') : 'rejected'}`);
    });
  };
  return (
    <li>
      <div className="h1">
        <Badge value={p.status} />
        <span className="strong">{num(p.pct_complete, 1)} %</span>
        {p.qty_done != null && <span className="muted">· qty {num(p.qty_done, 3)}</span>}
        <span className="muted">as of {d2(p.status_date)}</span>
        {p.original_status_date && <Badge tone="warning" label={`late report (was ${d2(p.original_status_date)})`} icon={null} />}
        <span className="grow" />
        <span className="muted small-text">{L.person(p.reported_by)} · {dateTime(p.created_at)}</span>
      </div>
      {(p.remarks || p.delay_cause || p.actual_start || p.actual_finish || p.remaining_days != null) && (
        <div className="h2">
          {[p.actual_start && `started ${d2(p.actual_start)}`, p.actual_finish && `finished ${d2(p.actual_finish)}`, p.remaining_days != null && `${num(p.remaining_days, 1)} d remaining`,
            p.delay_cause && `delay: ${p.delay_cause}`].filter(Boolean).join(' · ')}
          {p.remarks && <div>“{p.remarks}”</div>}
        </div>
      )}
      {p.verified_by && <div className="h2">{p.status === 'rejected' ? 'Rejected' : 'Verified'} by {L.person(p.verified_by)}{p.verified_pct != null ? ` at ${num(p.verified_pct, 1)} %` : ''}{p.verify_comment ? ` · “${p.verify_comment}”` : ''}</div>}
      <LazyPhotos id={p.id} open={canVerify} />
      {canVerify && (
        <>
          <ErrorBanner error={error} />
          <div className="verify-row">
            {editablePct && <Field label="Verified %"><input type="number" min={0} max={100} value={pct} onChange={(e) => setPct(e.target.value)} style={{ width: 90 }} /></Field>}
            {units && <VerifyQtyFields taskId={task.id} qty={p.qty} draft={qd} setDraft={setQd} />}
            <div className="grow" style={{ minWidth: 200 }}>
              <Field label={adjusted ? 'Comment (required — adjusted)' : 'Comment'}><input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Required to reject or adjust" /></Field>
            </div>
            <button disabled={busy} onClick={() => decide(false)}>Reject</button>
            <button className="primary" disabled={busy} onClick={() => decide(true)}>{busy && <span className="spinner" />}{adjusted ? 'Verify with adjustment' : 'Verify'}</button>
          </div>
        </>
      )}
    </li>
  );
}

/** Photos of one progress report, loaded when opened (open by default for the verifier). */
function LazyPhotos({ id, open }: { id: string; open: boolean }) {
  const [shown, setShown] = useState(open);
  return (
    <details className="h2" open={open} onToggle={(e) => setShown((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="small-text">Photos</summary>
      {shown && <Attachments entityType="task_progress" entityId={id} emptyText="No photos with this report." />}
    </details>
  );
}

function ReportForm({ task, detail }: { task: SchedTask; detail: TaskDetail }) {
  const m = task.ev_method;
  const lastVerified = detail.progress.find((p) => p.status === 'verified' || p.status === 'adjusted');
  const [statusDate, setStatusDate] = useState(todayStr());
  const [pct, setPct] = useState(String(Number(task.reported_pct) || ''));
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(detail.boq.map((b) => [b.boq_item_id, String(Number(b.reported_qty) || Number(b.verified_qty) || '')])));
  const [steps, setSteps] = useState<Record<string, string>>(() => Object.fromEntries(detail.steps.map((s) => [s.id, String(Number(s.reported_pct) || '')])));
  const [aStart, setAStart] = useState(task.actual_start ?? '');
  const [aFinish, setAFinish] = useState('');
  const [remaining, setRemaining] = useState('');
  const [cause, setCause] = useState('');
  const [remarks, setRemarks] = useState('');
  const { busy, error, setError, run } = useBusy();
  const startPct = Number(task.start_pct ?? 50);

  const submit = () => {
    const p: Parameters<typeof schedRpc<'report_task_progress'>>[1] = { id: crypto.randomUUID(), task_id: task.id, status_date: statusDate || undefined };
    if (m === 'units') {
      if (!detail.boq.length) { setError('Link BoQ items to this task first (BoQ & elements tab).'); return; }
      p.qty = detail.boq.map((b) => ({ boq_item_id: b.boq_item_id, qty_to_date: Number(qty[b.boq_item_id] || 0) }));
    } else if (m === 'steps') {
      p.steps = detail.steps.map((s) => ({ step_id: s.id, done_pct: Number(steps[s.id] || 0) }));
    } else {
      const v = Number(pct);
      if (pct === '' || !Number.isFinite(v) || v < 0 || v > 100) { setError('Enter the percent complete (0–100).'); return; }
      p.pct_complete = v;
    }
    if (aStart) p.actual_start = aStart;
    if (aFinish) p.actual_finish = aFinish;
    if (remaining !== '') p.remaining_days = Number(remaining);
    if (cause.trim()) p.delay_cause = cause.trim();
    if (remarks.trim()) p.remarks = remarks.trim();
    void run(async () => {
      const r = await schedRpc('report_task_progress', p);
      toast.success(`${task.name}: ${num(r.pct_complete, 1)} % reported — waiting for verification${r.rolled_to_next_period ? ' (counted in the next period)' : ''}`);
      setRemarks(''); setCause('');
    });
  };

  return (
    <div className="card pad">
      <h3 className="mb-0">Report progress</h3>
      <p className="muted small-text mt-2">Cumulative to the status date. {lastVerified ? `Last verified: ${num(lastVerified.verified_pct, 1)} % on ${d2(lastVerified.status_date)}.` : 'Nothing verified yet.'}</p>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Status date" required><input type="date" value={statusDate} max={todayStr()} onChange={(e) => setStatusDate(e.target.value)} /></Field>
        {m === 'units' && detail.boq.map((b) => (
          <Field key={b.boq_item_id} label={`${b.boq_items?.item_no ?? 'BoQ'} done to date`} hint={`Planned for this task: ${num(b.qty_share, 3)} ${b.boq_items?.unit ?? ''}`}>
            <span className="input-unit"><input type="number" min={0} value={qty[b.boq_item_id] ?? ''} onChange={(e) => setQty({ ...qty, [b.boq_item_id]: e.target.value })} /><span>{b.boq_items?.unit}</span></span>
          </Field>
        ))}
        {m === 'units' && !detail.boq.length && <Banner tone="warn">No BoQ items linked — link them before reporting quantities.</Banner>}
        {m === 'steps' && detail.steps.map((s) => (
          <Field key={s.id} label={`${s.seq}. ${s.name}`} hint={`Weight ${num(s.weight, 1)}`}>
            <span className="input-unit"><input type="number" min={0} max={100} value={steps[s.id] ?? ''} onChange={(e) => setSteps({ ...steps, [s.id]: e.target.value })} /><span>%</span></span>
          </Field>
        ))}
        {(m === '0_100' || m === 'milestone') && (
          <Field label="Status" required>
            <select value={pct} onChange={(e) => setPct(e.target.value)}><option value="">Choose…</option><option value="0">Not finished (0 %)</option><option value="100">Finished (100 %)</option></select>
          </Field>
        )}
        {m === '50_50' && (
          <Field label="Status" required>
            <select value={pct} onChange={(e) => setPct(e.target.value)}><option value="">Choose…</option><option value="0">Not started (0 %)</option><option value={String(startPct)}>Started ({startPct} %)</option><option value="100">Finished (100 %)</option></select>
          </Field>
        )}
        {m === 'pct' && <Field label="Percent complete" required><span className="input-unit"><input type="number" min={0} max={100} value={pct} onChange={(e) => setPct(e.target.value)} /><span>%</span></span></Field>}
        <Field label="Actual start"><input type="date" value={aStart} max={todayStr()} onChange={(e) => setAStart(e.target.value)} /></Field>
        <Field label="Actual finish" hint="Only when 100 % done"><input type="date" value={aFinish} max={todayStr()} onChange={(e) => setAFinish(e.target.value)} /></Field>
        <Field label="Remaining (working days)"><input type="number" min={0} value={remaining} onChange={(e) => setRemaining(e.target.value)} /></Field>
        <Field label="Delay cause"><input value={cause} onChange={(e) => setCause(e.target.value)} placeholder="e.g. materials, rain, approvals" /></Field>
        <Field label="Remarks" wide><input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Required when the quantity goes down or above plan" /></Field>
      </div>
      <div className="row mt-2" style={{ justifyContent: 'flex-end' }}>
        <button className="primary" disabled={busy} onClick={submit}>{busy && <span className="spinner" />}Report progress</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
interface BoqEdit { boq_item_id: string; item_no: string; description: string; unit: string; qty: string; orig: string | null; deleted: boolean }
interface ElEdit { element_id: string; weight: string; orig: string | null; deleted: boolean }

function LinksTab({ task, detail, L, canEdit }: { task: SchedTask; detail: TaskDetail; L: Lookups; canEdit: boolean }) {
  const auth = useAuth();
  const items = useAsync(() => loadBoqItems(auth.projectId!), [auth.projectId], { key: 'boq-items', staleTime: 5 * 60_000, enabled: canEdit && !task.is_summary });
  const init = () => ({
    boq: detail.boq.map((b): BoqEdit => ({ boq_item_id: b.boq_item_id, item_no: b.boq_items?.item_no ?? '?', description: b.boq_items?.description ?? '', unit: b.boq_items?.unit ?? '',
      qty: b.source === 'auto' ? '' : String(Number(b.qty_share)), orig: b.source === 'auto' ? '' : String(Number(b.qty_share)), deleted: false })),
    el: detail.elements.map((e): ElEdit => ({ element_id: e.element_id, weight: e.weight == null ? '' : String(e.weight), orig: e.weight == null ? '' : String(e.weight), deleted: false })),
  });
  const [st, setSt] = useState(init);
  const [bq, setBq] = useState('');
  const [eq, setEq] = useState('');
  const { busy, error, run } = useBusy();
  const autoQty = new Map(detail.boq.map((b) => [b.boq_item_id, Number(b.qty_share)]));
  const linkedB = new Set(st.boq.map((b) => b.boq_item_id));
  const linkedE = new Set(st.el.map((e) => e.element_id));
  const bMatches = useMemo(() => {
    const t = bq.trim().toLowerCase();
    if (!t || !items.data) return [];
    return items.data.filter((b) => !linkedB.has(b.id) && (b.item_no.toLowerCase().includes(t) || b.description.toLowerCase().includes(t))).slice(0, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bq, items.data, st.boq]);
  const eMatches = useMemo(() => {
    const t = eq.trim().toLowerCase();
    if (!t) return [];
    return L.elements.filter((e) => !linkedE.has(e.id) && L.element(e.id).toLowerCase().includes(t)).slice(0, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eq, L, st.el]);

  const dirty = st.boq.some((b) => b.orig === null || b.deleted || b.qty !== b.orig) || st.el.some((e) => e.orig === null || e.deleted || e.weight !== e.orig);
  const save = () => void run(async () => {
    const boq_links = st.boq.filter((b) => b.orig === null || b.deleted || b.qty !== b.orig)
      .filter((b) => !(b.orig === null && b.deleted))
      .map((b) => ({ boq_item_id: b.boq_item_id, ...(b.deleted ? { deleted: true } : b.qty.trim() !== '' ? { qty_share: Number(b.qty) } : {}) }));
    const element_links = st.el.filter((e) => e.orig === null || e.deleted || e.weight !== e.orig)
      .filter((e) => !(e.orig === null && e.deleted))
      .map((e) => ({ element_id: e.element_id, ...(e.deleted ? { deleted: true } : e.weight.trim() !== '' ? { weight: Number(e.weight) } : {}) }));
    await schedRpc('save_task_setup', { task_id: task.id, boq_links, element_links });
    toast.success(`${task.name}: links saved`);
  });

  if (task.is_summary) return <p className="muted">Link BoQ items and elements on the detailed tasks; the summary adds them up.</p>;
  return (
    <div className="stack">
      <ErrorBanner error={error ?? items.error} />
      <div>
        <h3 className="mb-0">BoQ items</h3>
        <p className="muted small-text">The quantity this task delivers. Leave blank to split the item's remaining quantity by duration.</p>
        {!st.boq.length ? <p className="muted">No BoQ items linked.</p> : (
          <ul className="link-list">
            {st.boq.map((b, k) => (
              <li key={b.boq_item_id} style={b.deleted ? { opacity: .5, textDecoration: 'line-through' } : undefined}>
                <span className="strong">{b.item_no}</span><span className="grow truncate" title={b.description}>{b.description}</span>
                {canEdit ? (
                  <span className="input-unit" style={{ width: 150 }}>
                    <input type="number" min={0} value={b.qty} placeholder={autoQty.has(b.boq_item_id) ? `auto ${num(autoQty.get(b.boq_item_id), 2)}` : 'auto'} disabled={b.deleted}
                      aria-label={`Quantity share for ${b.item_no}`} onChange={(e) => setSt({ ...st, boq: st.boq.map((x, j) => (j === k ? { ...x, qty: e.target.value } : x)) })} /><span>{b.unit}</span>
                  </span>
                ) : <span>{num(autoQty.get(b.boq_item_id), 3)} {b.unit}</span>}
                {canEdit && <button className="small" aria-label={b.deleted ? 'Undo remove' : `Remove ${b.item_no}`} onClick={() => setSt({ ...st, boq: st.boq.map((x, j) => (j === k ? { ...x, deleted: !x.deleted } : x)) })}>{b.deleted ? 'Undo' : <Trash2 size={14} />}</button>}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <>
            <input className="mt-2" value={bq} onChange={(e) => setBq(e.target.value)} placeholder={items.data ? 'Add BoQ item: type item no. or description…' : 'Loading BoQ…'} aria-label="Search BoQ items" style={{ width: '100%' }} />
            {bMatches.length > 0 && (
              <div className="pick-list" role="listbox">
                {bMatches.map((b) => (
                  <button key={b.id} type="button" role="option" aria-selected={false} onClick={() => { setSt({ ...st, boq: [...st.boq, { boq_item_id: b.id, item_no: b.item_no, description: b.description, unit: b.unit, qty: '', orig: null, deleted: false }] }); setBq(''); }}>
                    <Plus size={14} aria-hidden /><span className="strong">{b.item_no}</span><span className="truncate">{b.description}</span><span className="muted">{num(b.quantity, 2)} {b.unit}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div>
        <h3 className="mb-0">Elements</h3>
        <p className="muted small-text">Columns, slabs, walls… whose verified activity progress measures this task (method “From elements”).</p>
        {!st.el.length ? <p className="muted">No elements linked.</p> : (
          <ul className="link-list">
            {st.el.map((e, k) => (
              <li key={e.element_id} style={e.deleted ? { opacity: .5, textDecoration: 'line-through' } : undefined}>
                <span className="grow strong">{L.element(e.element_id)}</span>
                {canEdit ? <input type="number" min={0} value={e.weight} placeholder="weight 1" style={{ width: 100 }} disabled={e.deleted} aria-label="Weight"
                  onChange={(ev) => setSt({ ...st, el: st.el.map((x, j) => (j === k ? { ...x, weight: ev.target.value } : x)) })} /> : e.weight && <span>weight {e.weight}</span>}
                {canEdit && <button className="small" aria-label={e.deleted ? 'Undo remove' : 'Remove element'} onClick={() => setSt({ ...st, el: st.el.map((x, j) => (j === k ? { ...x, deleted: !x.deleted } : x)) })}>{e.deleted ? 'Undo' : <Trash2 size={14} />}</button>}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <>
            <input className="mt-2" value={eq} onChange={(e) => setEq(e.target.value)} placeholder="Add element: type a code (C1, S2-L3)…" aria-label="Search elements" style={{ width: '100%' }} />
            {eMatches.length > 0 && (
              <div className="pick-list" role="listbox">
                {eMatches.map((e) => (
                  <button key={e.id} type="button" role="option" aria-selected={false} onClick={() => { setSt({ ...st, el: [...st.el, { element_id: e.id, weight: '', orig: null, deleted: false }] }); setEq(''); }}>
                    <Plus size={14} aria-hidden /><span className="strong">{L.element(e.id)}</span><span className="muted">{e.element_type}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {canEdit && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {dirty && <button onClick={() => setSt(init())}>Discard</button>}
          <button className="primary" disabled={busy || !dirty} onClick={save}>{busy && <span className="spinner" />}Save links</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function LogicTab({ task, taskById, onOpenTask, canEdit }: { task: SchedTask; taskById: Map<string, SchedTask>; onOpenTask: (id: string) => void; canEdit: boolean }) {
  const q = useAsync(async () => check(await supabase.from('schedule_links').select('pred_task_id, succ_task_id, link_type, lag_days')
    .or(`pred_task_id.eq.${task.id},succ_task_id.eq.${task.id}`).is('deleted_at', null).limit(500)) as SchedLink[], [task.id], { key: 'sched-task-links' });
  const [form, setForm] = useState({ uid: '', type: 'FS' as LinkType, lag: '' });
  const { busy, error, run } = useBusy();
  const byUid = useMemo(() => new Map([...taskById.values()].map((t) => [t.msp_uid, t])), [taskById]);
  const editable = canEdit && !task.is_summary;
  const removeLink = (l: SchedLink) => void run(async () => {
    const r = await editRpc('edit_schedule', { action: 'delete_link', pred_task_id: l.pred_task_id, succ_task_id: l.succ_task_id, link_type: l.link_type });
    toast.success(`${String(r.summary)}${Number(r.moved) ? ` · ${String(r.moved)} task(s) moved` : ''}`);
    q.reload();
  });
  const addPred = () => void run(async () => {
    const p = byUid.get(Number(form.uid));
    if (!p) throw new Error(`Task UID ${form.uid} is not in this schedule`);
    const lag = form.lag.trim();
    const pct = lag.endsWith('%');
    const r = await editRpc('edit_schedule', { action: 'add_link', pred_task_id: p.id, succ_task_id: task.id, link_type: form.type,
      ...(lag ? (pct ? { lag_pct: Number(lag.slice(0, -1)) } : { lag_days: Number(lag.replace(/d$/i, '')) }) : {}) });
    toast.success(`${String(r.summary)}${Number(r.moved) ? ` · ${String(r.moved)} task(s) moved` : ''}`);
    setForm({ uid: '', type: 'FS', lag: '' });
    q.reload();
  });
  if (q.error) return <ErrorBanner error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading lines={3} />;
  const preds = q.data.filter((l) => l.succ_task_id === task.id);
  const succs = q.data.filter((l) => l.pred_task_id === task.id);
  const lag = (l: SchedLink) => `${l.link_type}${Number(l.lag_days) ? `${Number(l.lag_days) > 0 ? '+' : ''}${num(l.lag_days, 1)} d` : ''}`;
  const list = (rows: SchedLink[], key: 'pred_task_id' | 'succ_task_id') => (
    <ul className="link-list">
      {rows.map((l) => {
        const t = taskById.get(l[key]);
        return (
          <li key={l[key] + l.link_type}>
            <span className="chip">{lag(l)}</span>
            <button className="link-btn grow" style={{ textAlign: 'left' }} onClick={() => onOpenTask(l[key])}>{t ? `${t.wbs ?? t.msp_uid} ${t.name}` : 'Task'}</button>
            {t?.is_critical && <Flame size={14} className="danger-text" aria-label="Critical" />}
            {t && <span className="muted small-text">{d2(t.forecast_start ?? t.planned_start)} → {d2(t.forecast_finish ?? t.planned_finish)}</span>}
            {canEdit && !task.is_summary && !t?.is_summary && <button className="link-btn" disabled={busy} onClick={() => removeLink(l)} aria-label="Remove link">Remove</button>}
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className="stack">
      {task.is_summary && <p className="muted small-text">Links on a summary apply to all its detailed tasks.</p>}
      <div><h3 className="mb-0">Predecessors ({preds.length})</h3>{preds.length ? list(preds, 'pred_task_id') : <p className="muted">None{!task.is_summary ? ' — a task without a predecessor floats freely (check the schedule logic)' : ''}.</p>}</div>
      <div><h3 className="mb-0">Successors ({succs.length})</h3>{succs.length ? list(succs, 'succ_task_id') : <p className="muted">None.</p>}</div>
      <ErrorBanner error={error} />
      {editable && (
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Add predecessor (task UID)"><input value={form.uid} inputMode="numeric" onChange={(e) => setForm({ ...form, uid: e.target.value.replace(/\D/g, '') })} style={{ width: 120 }} placeholder="e.g. 12" /></Field>
          <Field label="Type"><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as LinkType })}>{(['FS', 'SS', 'FF', 'SF'] as LinkType[]).map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Lag" hint="days, or % of the predecessor"><input value={form.lag} onChange={(e) => setForm({ ...form, lag: e.target.value })} style={{ width: 90 }} placeholder="2d / -1 / 50%" /></Field>
          <button className="primary small" disabled={busy || !form.uid} onClick={addPred}>{busy && <span className="spinner" />}Add link</button>
        </div>
      )}
      <p className="muted small-text">{canEdit ? 'Changes re-plan the dates with the critical path. A re-import from MS Project replaces them — export to MS Project (XML) first.' : 'Planners change the logic on Schedule › Edit plan.'}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
function SetupTab({ task, detail, L, canEdit }: { task: SchedTask; detail: TaskDetail; L: Lookups; canEdit: boolean }) {
  const auth = useAuth();
  const [method, setMethod] = useState<EvMethod>(task.ev_method);
  const [startPct, setStartPct] = useState(task.start_pct == null ? '' : String(task.start_pct));
  const [block, setBlock] = useState(task.block_id ?? '');
  const [level, setLevel] = useState(task.level_id ?? '');
  const [comment, setComment] = useState('');
  const { busy, error, run } = useBusy();
  const needs = (m: EvMethod) => (m === 'units' && !detail.boq.length ? 'Link BoQ items first' : m === 'elements' && !detail.elements.length ? 'Link elements first' : m === 'steps' && !detail.steps.length ? 'No steps defined' : null);
  const dirty = method !== task.ev_method || startPct !== (task.start_pct == null ? '' : String(task.start_pct)) || block !== (task.block_id ?? '') || level !== (task.level_id ?? '');
  const save = () => void run(async () => {
    await schedRpc('save_task_setup', {
      task_id: task.id, ev_method: method, start_pct: method === '50_50' && startPct !== '' ? Number(startPct) : undefined,
      block_id: block || null, level_id: level || null, comment: comment.trim() || undefined,
    });
    toast.success(`${task.name}: measurement saved`);
  });
  const canApprove = !!auth.profile?.role && BASELINE_APPROVE_ROLES.includes(auth.profile.role);
  return (
    <div className="stack">
      <ErrorBanner error={error} />
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="strong">How is progress measured?</legend>
        <div className="choice-cards mt-2">
          {EV_METHODS.map((m) => {
            const why = needs(m);
            return (
              <label key={m} className={`choice-card${method === m ? ' active' : ''}`} title={why ?? undefined}>
                <input type="radio" name="ev" checked={method === m} disabled={!!why && m !== task.ev_method} onChange={() => setMethod(m)} />
                <span><span className="strong">{EV_METHOD_LABELS[m].en}</span><br /><span className="muted small-text">{why ?? EV_METHOD_LABELS[m].hint}</span></span>
              </label>
            );
          })}
        </div>
        {method === '50_50' && <Field label="Credit when started"><span className="input-unit" style={{ width: 120 }}><input type="number" min={0} max={100} value={startPct} placeholder="50" onChange={(e) => setStartPct(e.target.value)} /><span>%</span></span></Field>}
        <div className="form-grid mt-2">
          <Field label="Block"><select value={block} onChange={(e) => { setBlock(e.target.value); setLevel(''); }}><option value="">—</option>{L.blocks.map((b) => <option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</select></Field>
          <Field label="Level"><select value={level} onChange={(e) => setLevel(e.target.value)}><option value="">—</option>{L.levels.filter((l) => !block || l.block_id === block).map((l) => <option key={l.id} value={l.id}>{l.code} {l.name}</option>)}</select></Field>
          <Field label="Comment" wide hint="Required when changing the method after a closed period"><input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        </div>
      </fieldset>
      {canEdit ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="primary" disabled={busy || !dirty} onClick={save}>{busy && <span className="spinner" />}Save measurement</button>
        </div>
      ) : <p className="muted small-text">Only office engineers{canApprove ? '' : ', coordinators and managers'} change how tasks are measured.</p>}
    </div>
  );
}
