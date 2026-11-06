// Period close checklist + variance notes + close/reopen (used by /evm/periods and the /approvals preview).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, OctagonAlert, TriangleAlert } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { check, countRows, fetchAll, supabase } from '../../lib/supabase';
import { date, dateTime, num } from '../../lib/format';
import type { PeriodChecks } from '../../lib/contract-schedule';
import { Badge } from '../Badge';
import { Banner, ErrorBanner, Loading } from '../Page';
import { Field, useBusy } from '../Form';
import { Modal, ReasonModal } from '../Dialog';
import { toast } from '../toast';
import { has, idx, moneyShort, PERIOD_CLOSE_ROLES, PERIOD_OPEN_ROLES, PERIOD_REOPEN_ROLES, planRpc, tr, type PeriodRow } from './data';

const INDICATOR_LABEL: Record<string, string> = { spi: 'Schedule performance (SPI)', cpi: 'Cost performance (CPI)', spi_t: 'Time performance SPI(t)', tcpi: 'Needed efficiency (TCPI)', other: 'Other' };
interface Note { id: string; indicator: string; cause: string; impact: string | null; corrective_action: string | null; owner_id: string | null; due_date: string | null; task_id: string | null; created_at: string }

export function PeriodStatusBadge({ status }: { status: string }) {
  return status === 'closed' ? <Badge value="closed" label={tr('Closed', 'የተዘጋ')} />
    : status === 'prepared' ? <Badge tone="info" value="pending" label={tr('Ready to close', 'ለመዝጋት ዝግጁ')} />
      : <Badge tone="primary" value="in_progress" label={tr('Open', 'ክፍት')} />;
}

export function PeriodPanel({ period, L, latestClosedId, onDone }: { period: PeriodRow; L: Lookups; latestClosedId?: string | null; onDone?: (msg: string) => void }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const money = auth.canSeePrices;
  const currency = auth.project?.currency ?? 'ETB';
  const [carry, setCarry] = useState(false);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const { busy, error, run } = useBusy();

  const q = useAsync(async () => {
    const [pending, notes, costCount, snap, status] = await Promise.all([
      fetchAll<{ id: string }>((a, b) => supabase.from('task_progress').select('id, schedule_tasks!inner(schedule_id)').eq('schedule_tasks.schedule_id', period.schedule_id)
        .eq('status', 'reported').lte('status_date', period.status_date).range(a, b)),
      supabase.from('evm_variance_notes').select('*').eq('period_id', period.id).order('created_at').then(check) as Promise<Note[]>,
      money ? countRows(() => supabase.from('cost_entries').select('id', { count: 'exact', head: true }).eq('project_id', period.project_id)
        .gte('entry_date', period.period_start).lte('entry_date', period.status_date)) : Promise.resolve(null),
      money && period.status === 'closed' ? supabase.from('evm_snapshots').select('bac, pv, ev, ac, spi, cpi, eac, vac').eq('period_id', period.id).eq('level', 'project').maybeSingle().then(check) : Promise.resolve(null),
      period.status === 'closed' ? supabase.from('evm_task_status').select('pct_planned, pct_earned, spi, spi_t, sv_t_days, forecast_finish').eq('period_id', period.id).eq('level', 'project').maybeSingle().then(check) : Promise.resolve(null),
    ]);
    return { pending, notes, costCount, snap: snap as Record<string, number> | null, status: status as Record<string, number | string | null> | null };
  }, [period.id, period.status, money], { key: 'evm-period-panel' });

  const chk = period.prepared_summary as (PeriodChecks & { carry_ids?: string[]; sv_t_days?: number | null }) | null;
  const notes = q.data?.notes ?? [];
  const hasNote = (ind: string) => notes.some((x) => x.indicator === ind && !x.task_id);
  const criticalMissing = (chk?.breaches ?? []).filter((b) => b.band === 'critical' && !hasNote(b.indicator));
  const blocking = chk?.blocking ?? [];
  const canPrepare = has(PERIOD_OPEN_ROLES, role) && period.status !== 'closed';
  const canClose = has(PERIOD_CLOSE_ROLES, role) && period.status === 'prepared';
  const canReopen = has(PERIOD_REOPEN_ROLES, role) && period.status === 'closed' && (latestClosedId === undefined || latestClosedId === period.id);
  const label = `${period.kind === 'weekly' ? tr('Week', 'ሳምንት') : tr('Period', 'ወቅት')} ${period.period_no}`;

  const prepare = () => run(async () => {
    const carry_ids = carry ? (q.data?.pending ?? []).map((p) => p.id) : undefined;
    const r = await planRpc('prepare_period_close', { period_id: period.id, carry_ids });
    const b = (r.blocking as unknown[] | undefined)?.length ?? 0;
    toast.success(b ? `${label}: checklist ready · ${b} item${b === 1 ? '' : 's'} block closing` : `${label} is ready to close`);
  });

  return (
    <div className="stack">
      <ErrorBanner error={error ?? q.error} onRetry={q.reload} />
      <dl className="kv">
        <dt>{tr('Window', 'ጊዜ')}</dt><dd>{date(period.period_start)} – {date(period.status_date)} ({tr('cut-off', 'መቁረጫ')})</dd>
        <dt>{tr('Status', 'ሁኔታ')}</dt><dd><PeriodStatusBadge status={period.status} /></dd>
        {period.prepared_at && <><dt>{tr('Prepared', 'የተዘጋጀ')}</dt><dd>{L.person(period.prepared_by)} · {dateTime(period.prepared_at)}</dd></>}
        {period.closed_at && <><dt>{tr('Closed', 'የተዘጋ')}</dt><dd>{L.person(period.closed_by)} · {dateTime(period.closed_at)}{period.close_comment ? ` · "${period.close_comment}"` : ''}</dd></>}
        {period.reopen_count > 0 && <><dt>{tr('Reopened', 'እንደገና የተከፈተ')}</dt><dd>{period.reopen_count}× · {period.reopened_reason}</dd></>}
      </dl>

      {period.status === 'closed' && q.data?.status && (
        <div className="card-lite">
          <strong>{tr('Snapshot (frozen)', 'የተቀመጠ ቅጽበታዊ')}</strong>
          <p className="small-text mb-0">
            {tr('Planned', 'የታቀደ')} {num(q.data.status.pct_planned, 1)} % · {tr('Earned', 'የተሰራ')} {num(q.data.status.pct_earned, 1)} % · SPI {idx(q.data.status.spi)} · SPI(t) {idx(q.data.status.spi_t)}
            {q.data.status.sv_t_days != null ? ` · ${num(q.data.status.sv_t_days, 0)} wd` : ''} · {tr('Forecast finish', 'የሚጠበቅ ማጠናቀቂያ')} {date(q.data.status.forecast_finish)}
          </p>
          {q.data.snap && <p className="small-text mb-0">BAC {moneyShort(q.data.snap.bac, currency)} · PV {moneyShort(q.data.snap.pv, currency)} · EV {moneyShort(q.data.snap.ev, currency)} · AC {moneyShort(q.data.snap.ac, currency)} · CPI {idx(q.data.snap.cpi)} · EAC {moneyShort(q.data.snap.eac, currency)}</p>}
        </div>
      )}

      {period.status !== 'closed' && (
        <section className="stack tight" aria-label="Close checklist">
          <h3 className="mb-0">{tr('Close checklist', 'የመዝጊያ ማረጋገጫ')}</h3>
          {!q.data ? <Loading lines={3} /> : (
            <ul className="check-list">
              <li>{q.data.pending.length ? <OctagonAlert size={16} className="bad" aria-hidden /> : <CircleCheck size={16} className="ok" aria-hidden />}
                <span className="grow">{q.data.pending.length
                  ? <>{q.data.pending.length} progress report{q.data.pending.length === 1 ? '' : 's'} dated on or before {date(period.status_date)} still need verification · <Link to="/approvals?type=task_progress">{tr('Open queue', 'ዝርዝሩን ክፈት')}</Link></>
                  : tr('All progress up to the cut-off is verified', 'እስከ መቁረጫው ያለው ሂደት ተረጋግጧል')}
                  {q.data.pending.length > 0 && canPrepare && (
                    <label className="row small-text mt-2"><input type="checkbox" checked={carry} onChange={(e) => setCarry(e.target.checked)} />
                      Close anyway: move these reports to the next period</label>
                  )}
                </span></li>
              {money && q.data.costCount !== null && (
                <li>{q.data.costCount ? <CircleCheck size={16} className="ok" aria-hidden /> : <TriangleAlert size={16} className="warn" aria-hidden />}
                  <span className="grow">{q.data.costCount
                    ? `${q.data.costCount} cost entr${q.data.costCount === 1 ? 'y' : 'ies'} (labour, equipment, subcontract, overhead) in this period`
                    : <>No labour / equipment / subcontract costs recorded in this period · <Link to="/costs">{tr('Record costs', 'ወጪ መዝግብ')}</Link></>}</span></li>
              )}
              {blocking.filter((b) => b.issue !== 'unverified_progress').map((b) => (
                <li key={b.issue}><OctagonAlert size={16} className="bad" aria-hidden /><span>{b.message}</span></li>
              ))}
              {(chk?.warnings ?? []).map((w) => <li key={w}><TriangleAlert size={16} className="warn" aria-hidden /><span>{w}</span></li>)}
              {(chk?.breaches ?? []).map((b) => (
                <li key={b.indicator}>
                  {hasNote(b.indicator) ? <CircleCheck size={16} className="ok" aria-hidden /> : b.band === 'critical' ? <OctagonAlert size={16} className="bad" aria-hidden /> : <TriangleAlert size={16} className="warn" aria-hidden />}
                  <span className="grow">{INDICATOR_LABEL[b.indicator] ?? b.indicator} {idx(b.value)} is {b.band === 'critical' ? 'beyond the action threshold — an explanation is required' : 'in the watch band — an explanation is recommended'}
                    {hasNote(b.indicator) ? ' · explained' : ''}</span>
                  {has(PERIOD_OPEN_ROLES, role) && <button className="small" onClick={() => setNoteFor(b.indicator)}>{hasNote(b.indicator) ? tr('Add note', 'ማስታወሻ') : tr('Explain…', 'ያብራሩ…')}</button>}
                </li>
              ))}
              {!chk && <li><TriangleAlert size={16} className="warn" aria-hidden /><span className="muted">Run "Prepare close" to check thresholds (SPI, CPI, SPI(t), TCPI) and refresh the forecast.</span></li>}
            </ul>
          )}
          {chk && <p className="muted small-text mb-0">At cut-off: planned {num(chk.pct_planned, 1)} % · earned {num(chk.pct_earned, 1)} % · SPI {idx(chk.spi)}{money ? ` · CPI ${idx(chk.cpi)}` : ''} · SPI(t) {idx(chk.spi_t)}</p>}
        </section>
      )}

      {notes.length > 0 && (
        <section className="stack tight" aria-label="Variance notes">
          <h3 className="mb-0">{tr('Variance explanations', 'የልዩነት ማብራሪያ')}</h3>
          {notes.map((x) => (
            <div key={x.id} className="card-lite small-text">
              <strong>{INDICATOR_LABEL[x.indicator] ?? x.indicator}</strong> — {x.cause}
              {x.impact && <div><span className="muted">Impact:</span> {x.impact}</div>}
              {x.corrective_action && <div><span className="muted">Action:</span> {x.corrective_action}{x.owner_id ? ` · ${L.person(x.owner_id)}` : ''}{x.due_date ? ` · due ${date(x.due_date)}` : ''}</div>}
            </div>
          ))}
        </section>
      )}

      <div className="row end">
        {canReopen && <button onClick={() => setReopening(true)}>{tr('Reopen…', 'እንደገና ክፈት…')}</button>}
        {canPrepare && <button className={canClose ? '' : 'primary'} disabled={busy} onClick={() => void prepare()}>{busy && <span className="spinner" />}{period.status === 'prepared' ? tr('Re-check', 'እንደገና አረጋግጥ') : tr('Prepare close', 'ለመዝጋት አዘጋጅ')}</button>}
        {canClose && (
          <button className="primary" disabled={blocking.length > 0 || criticalMissing.length > 0} onClick={() => setClosing(true)}
            title={blocking.length ? 'Resolve the blocking items first' : criticalMissing.length ? `Explain ${criticalMissing.map((b) => b.indicator.toUpperCase()).join(', ')} first` : undefined}>
            {tr('Close', 'ዝጋ')} {label}
          </button>
        )}
      </div>
      {period.status === 'prepared' && !has(PERIOD_CLOSE_ROLES, role) && <Banner tone="info">A coordinator or manager closes the period.</Banner>}

      {noteFor && <NoteModal period={period} indicator={noteFor} L={L} onClose={() => setNoteFor(null)} />}
      {closing && (
        <ReasonModal title={`${tr('Close', 'ዝጋ')} ${label}?`} label={tr('Comment (optional)', 'አስተያየት')} required={false} confirm={`${tr('Close', 'ዝጋ')} ${label}`}
          onClose={() => setClosing(false)}
          onSubmit={async (comment) => {
            await planRpc('close_period', { period_id: period.id, comment: comment || undefined });
            const msg = `${label} closed — numbers are frozen`;
            if (onDone) onDone(msg); else toast.success(msg);
          }}>
          <p className="muted small-text mb-0">Once closed, the numbers for {date(period.period_start)} – {date(period.status_date)} are frozen. Late changes go to the next period.</p>
        </ReasonModal>
      )}
      {reopening && (
        <ReasonModal title={`${tr('Reopen', 'እንደገና ክፈት')} ${label}?`} danger confirm={tr('Reopen', 'እንደገና ክፈት')} onClose={() => setReopening(false)}
          onSubmit={async (reason) => { await planRpc('reopen_period', { period_id: period.id, reason }); toast.success(`${label} reopened`); }}>
          <p className="muted small-text mb-0">The frozen snapshot is kept in the audit log and removed; the period must be prepared and closed again.</p>
        </ReasonModal>
      )}
    </div>
  );
}

function NoteModal({ period, indicator, L, onClose }: { period: PeriodRow; indicator: string; L: Lookups; onClose: () => void }) {
  const [f, setF] = useState({ cause: '', impact: '', action: '', owner: '', due: '' });
  const { busy, error, run } = useBusy();
  const save = () => run(async () => {
    await planRpc('save_variance_note', { id: crypto.randomUUID(), period_id: period.id, indicator, cause: f.cause.trim(), impact: f.impact.trim() || undefined,
      corrective_action: f.action.trim() || undefined, owner_id: f.owner || undefined, due_date: f.due || undefined });
    toast.success('Variance explanation saved');
    onClose();
  });
  return (
    <Modal title={`Explain ${INDICATOR_LABEL[indicator] ?? indicator}`} onClose={onClose} size="md" footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !f.cause.trim()} onClick={() => void save()}>{busy && <span className="spinner" />}Save</button>
    </>}>
      <ErrorBanner error={error} />
      <div className="form-grid one">
        <Field label="Cause" required><textarea rows={2} value={f.cause} data-autofocus onChange={(e) => setF({ ...f, cause: e.target.value })} placeholder="e.g. Rebar delivery 2 weeks late; crew moved to Block B" /></Field>
        <Field label="Impact"><textarea rows={2} value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value })} /></Field>
        <Field label="Corrective action"><textarea rows={2} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} /></Field>
      </div>
      <div className="form-grid mt-3">
        <Field label="Owner"><select value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}>
          <option value="">—</option>{L.profiles.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
        </select></Field>
        <Field label="Due date"><input type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
