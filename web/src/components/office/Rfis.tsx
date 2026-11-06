// RFIs (questions to the consultant) and site instructions received, with due dates, ball in court, answers,
// cost / time impact and links to a variation or an EOT claim.
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { date, humanize, money, num } from '../../lib/format';
import {
  DISCIPLINES, IMPACT_LABELS, RFI_STATUS_LABELS, type Impact, type RfiKind, type RfiRow, type RfiStatus,
} from '../../lib/contract-office';
import { Attachments } from '../Attachments';
import { Badge, Banner, Card, DataTable, Drawer, ErrorBanner, Field, Kpi, ReasonModal, Tabs, toast, useBusy, type Tone } from '../ui';
import { canOffice, loadClaims, loadRfis, loadSettings, loadUnregisteredInstructions, loadVariationOptions, officeRpc, todayEat, addDays } from './data';

const TONE: Record<RfiStatus, Tone> = { open: 'warning', answered: 'info', closed: 'success', void: 'neutral' };
type Filter = 'all' | 'rfi' | 'si' | 'open';

export function Rfis({ projectId }: { projectId: string }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const lk = useLookups(projectId);
  const q = useAsync(() => loadRfis(projectId), [projectId], { key: 'rfis' });
  const [filter, setFilter] = useState<Filter>('open');
  const [open, setOpen] = useState<RfiRow | { kind: RfiKind; fromDiary?: boolean } | null>(null);
  const rows = q.data ?? [];
  const shown = rows.filter((r) => filter === 'all' || (filter === 'open' ? ['open', 'answered'].includes(r.status) : r.kind === filter));
  const overdue = rows.filter((r) => r.kind === 'rfi' && r.status === 'open' && r.days_overdue > 0).length;
  const avgDays = (() => { const a = rows.filter((r) => r.kind === 'rfi' && r.answered_on); return a.length ? a.reduce((s, r) => s + r.days_open, 0) / a.length : null; })();
  const impact = rows.filter((r) => r.status !== 'void' && (r.cost_impact !== 'none' || r.time_impact !== 'none') && !r.variation_id && !r.eot_claim_id).length;
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Open RFIs" value={rows.filter((r) => r.kind === 'rfi' && r.status === 'open').length} />
        <Kpi label="Overdue with the consultant" value={overdue} status={overdue ? 'danger' : 'ok'} />
        <Kpi label="Open site instructions" value={rows.filter((r) => r.kind === 'si' && r.status === 'open').length} />
        <Kpi label="Average answer time" value={avgDays == null ? '—' : num(avgDays, 1)} unit={avgDays == null ? undefined : 'days'} />
        <Kpi label="Impact not yet claimed" value={impact} status={impact ? 'warning' : 'ok'} hint="Cost / time impact without a variation or EOT" />
      </div>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <Card flush title="RFIs & site instructions" actions={canOffice(role, 'raiseRfi') ? (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="primary small" onClick={() => setOpen({ kind: 'rfi' })}><Plus size={14} aria-hidden />New RFI</button>
          <button className="small" onClick={() => setOpen({ kind: 'si' })}><Plus size={14} aria-hidden />Site instruction</button>
          <button className="small" onClick={() => setOpen({ kind: 'si', fromDiary: true })}>From site diary…</button>
        </div>) : undefined}>
        <div style={{ padding: '0 var(--sp-3)' }}>
          <Tabs variant="segmented" value={filter} onChange={setFilter} tabs={[{ key: 'open', label: 'Open & answered' }, { key: 'rfi', label: 'RFIs' }, { key: 'si', label: 'Site instructions' }, { key: 'all', label: 'All' }]} />
        </div>
        <DataTable rows={shown} rowKey={(r) => r.id} loading={!q.data} onRowClick={(r) => setOpen(r)} exportName="rfi-register"
          rowClass={(r) => (r.days_overdue > 0 ? 'row-warn' : undefined)}
          empty={{ title: 'Nothing here yet', body: 'Raise an RFI when the drawings are unclear; register every instruction the consultant gives on site.' }}
          columns={[
            { key: 'number', label: 'No.', id: true },
            { key: 'subject', label: 'Subject', render: (r) => <span>{r.subject}{r.priority === 'urgent' && <> <Badge tone="danger" label="urgent" icon={null} /></>}</span> },
            { key: 'discipline', label: 'Discipline', value: (r) => r.discipline ?? '', render: (r) => (r.discipline ? humanize(r.discipline) : '—') },
            { key: 'raised_on', label: 'Raised', value: (r) => r.raised_on, render: (r) => date(r.raised_on) },
            { key: 'due_date', label: 'Due', value: (r) => r.due_date ?? '', render: (r) => (r.due_date ? <span className={r.days_overdue > 0 ? 'danger-text strong' : undefined}>{date(r.due_date)}{r.days_overdue > 0 ? ` (+${r.days_overdue} d)` : ''}</span> : '—') },
            { key: 'ball', label: 'Ball in court', value: (r) => r.ball_in_court, render: (r) => (r.status === 'open' ? humanize(r.ball_in_court) : '—') },
            { key: 'impact', label: 'Impact', value: (r) => `${r.cost_impact}/${r.time_impact}`, render: (r) => impactText(r) },
            { key: 'link', label: 'Raised as', value: (r) => [r.variation_number, r.eot_number].filter(Boolean).join(' '), render: (r) => [r.variation_number, r.eot_number].filter(Boolean).join(' · ') || '—' },
            { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Badge tone={TONE[r.status]} label={RFI_STATUS_LABELS[r.status]} icon={null} /> },
            { key: 'by', label: 'By', value: (r) => lk.data?.person(r.created_by) ?? '' },
          ]} />
      </Card>
      {open && ('id' in open
        ? <RfiDrawer key={open.id} projectId={projectId} rfi={open} kind={open.kind} onClose={() => { setOpen(null); q.reload(); }} />
        : <RfiDrawer key={`new-${open.kind}-${open.fromDiary ? 'd' : ''}`} projectId={projectId} rfi={null} kind={open.kind} fromDiary={open.fromDiary}
            registered={new Set(rows.map((r) => r.diary_instruction_id).filter((x): x is string => !!x))} onClose={() => { setOpen(null); q.reload(); }} />)}
    </div>
  );
}

function impactText(r: Pick<RfiRow, 'cost_impact' | 'cost_amount' | 'time_impact' | 'time_days'>) {
  const parts: string[] = [];
  if (r.cost_impact === 'yes') parts.push(`cost ${money(r.cost_amount)}`); else if (r.cost_impact === 'tbd') parts.push('cost TBD');
  if (r.time_impact === 'yes') parts.push(`${num(r.time_days, 1)} d`); else if (r.time_impact === 'tbd') parts.push('time TBD');
  return parts.join(' · ') || '—';
}

function RfiDrawer({ projectId, rfi, kind, fromDiary, registered, onClose }: {
  projectId: string; rfi: RfiRow | null; kind: RfiKind; fromDiary?: boolean; registered?: Set<string>; onClose: () => void;
}) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const sq = useAsync(() => loadSettings(projectId), [projectId], { key: 'ca-settings' });
  const dq = useAsync(() => (fromDiary ? loadUnregisteredInstructions(projectId, registered ?? new Set()) : Promise.resolve([])), [projectId, fromDiary], { key: 'diary-instr' });
  const isOffice = canOffice(role, 'answerRfi');
  const editable = !rfi || (['open', 'answered'].includes(rfi.status) && (rfi.created_by === auth.profile?.id || isOffice));
  const [f, setF] = useState({
    subject: rfi?.subject ?? '', description: rfi?.description ?? '', discipline: rfi?.discipline ?? '', location: rfi?.location ?? '',
    drawing_refs: rfi?.drawing_refs ?? '', priority: rfi?.priority ?? 'normal', addressed_to: rfi?.addressed_to ?? '', issued_by: rfi?.issued_by ?? '',
    raised_on: rfi?.raised_on ?? todayEat(), due_date: rfi?.due_date ?? '', cost_impact: rfi?.cost_impact ?? 'none' as Impact,
    cost_amount: rfi?.cost_amount == null ? '' : String(rfi.cost_amount), time_impact: rfi?.time_impact ?? 'none' as Impact,
    time_days: rfi?.time_days == null ? '' : String(rfi.time_days), diary_instruction_id: '',
  });
  const [ans, setAns] = useState({ answer: rfi?.answer ?? '', answered_on: rfi?.answered_on ?? todayEat(), answered_by: rfi?.answered_by ?? '' });
  const [voiding, setVoiding] = useState(false);
  const { busy, error, run } = useBusy();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const defDays = kind === 'si' ? sq.data?.si_response_days : sq.data?.rfi_response_days;
  const nm = (v: string) => (v === '' ? null : Number(v));
  const save = () => void run(async () => {
    const r = await officeRpc('save_rfi', { id: rfi?.id ?? crypto.randomUUID(), project_id: projectId, kind, subject: f.subject, description: f.description,
      discipline: f.discipline as never, location: f.location, drawing_refs: f.drawing_refs, priority: f.priority as 'normal' | 'urgent',
      addressed_to: f.addressed_to, issued_by: f.issued_by, raised_on: f.raised_on, due_date: f.due_date || undefined,
      cost_impact: f.cost_impact, cost_amount: nm(f.cost_amount), time_impact: f.time_impact, time_days: nm(f.time_days),
      diary_instruction_id: f.diary_instruction_id || undefined });
    toast.success(`${String(r.number)} saved`);
    onClose();
  });
  const decide = (action: 'answer' | 'close' | 'reopen', extra: Record<string, unknown> = {}) => void run(async () => {
    await officeRpc('decide_rfi', { rfi_id: rfi!.id, action, ...extra });
    toast.success({ answer: kind === 'si' ? 'Compliance recorded' : 'Answer recorded', close: 'Closed', reopen: 'Reopened' }[action]);
    onClose();
  });
  const title = rfi ? `${rfi.number} · ${rfi.subject}` : kind === 'si' ? 'Register a site instruction' : 'New RFI';
  return (
    <Drawer size="lg" onClose={onClose} title={title}
      subtitle={rfi ? <Badge tone={TONE[rfi.status]} label={RFI_STATUS_LABELS[rfi.status]} icon={null} /> : kind === 'si' ? 'Instruction from the engineer / client' : 'Question to the consultant'}>
      <ErrorBanner error={error} />
      {rfi?.void_reason && <Banner tone="warn">Void: {rfi.void_reason}</Banner>}
      {fromDiary && !rfi && (
        <Field label="Instruction recorded in a site diary" hint={dq.data && !dq.data.length ? 'Every diary instruction is already registered.' : undefined}>
          <select value={f.diary_instruction_id} onChange={(e) => {
            const d = dq.data?.find((x) => x.id === e.target.value);
            setF({ ...f, diary_instruction_id: e.target.value, description: d?.instruction ?? f.description, issued_by: d ? [d.given_by, d.organisation].filter(Boolean).join(', ') : f.issued_by,
              subject: d && !f.subject ? d.instruction.slice(0, 80) : f.subject, raised_on: d?.site_diaries?.diary_date ?? f.raised_on });
          }}>
            <option value="">Pick an instruction…</option>
            {(dq.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.site_diaries ? `${date(d.site_diaries.diary_date)} · ` : ''}{d.given_by ?? '?'}: {d.instruction.slice(0, 80)}</option>)}
          </select>
        </Field>
      )}
      <fieldset disabled={!editable} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Subject" required wide><input value={f.subject} onChange={set('subject')} placeholder={kind === 'si' ? 'e.g. Add trimmer bars at slab opening' : 'e.g. Lintel depth at grid C'} /></Field>
        <Field label={kind === 'si' ? 'Instruction (as given)' : 'Question'} required wide><textarea rows={4} value={f.description} onChange={set('description')} /></Field>
        <Field label="Discipline"><select value={f.discipline} onChange={set('discipline')}><option value="">—</option>{DISCIPLINES.map((d) => <option key={d} value={d}>{humanize(d)}</option>)}</select></Field>
        <Field label="Location / element"><input value={f.location} onChange={set('location')} placeholder="Block A, 2nd floor, grid C/4" /></Field>
        <Field label="Drawings / spec refs"><input value={f.drawing_refs} onChange={set('drawing_refs')} placeholder="S-04 rev B, A-12" /></Field>
        {kind === 'rfi'
          ? <Field label="Addressed to"><input value={f.addressed_to} onChange={set('addressed_to')} placeholder="Consultant / designer" /></Field>
          : <Field label="Given by"><input value={f.issued_by} onChange={set('issued_by')} placeholder="Resident engineer, MH Engineering" /></Field>}
        <Field label={kind === 'si' ? 'Received on' : 'Raised on'}><input type="date" value={f.raised_on} max={todayEat()} onChange={set('raised_on')} /></Field>
        <Field label={kind === 'si' ? 'Comply by' : 'Answer due'} hint={!rfi && !f.due_date && defDays ? `Default ${date(addDays(f.raised_on, defDays))} (${defDays} days)` : undefined}>
          <input type="date" value={f.due_date} onChange={set('due_date')} /></Field>
        <Field label="Priority"><select value={f.priority} onChange={set('priority')}><option value="normal">Normal</option><option value="urgent">Urgent — work is stopped</option></select></Field>
        <Field label="Cost impact"><select value={f.cost_impact} onChange={set('cost_impact')}>{(Object.keys(IMPACT_LABELS) as Impact[]).map((k) => <option key={k} value={k}>{IMPACT_LABELS[k]}</option>)}</select></Field>
        {f.cost_impact === 'yes' && <Field label="Cost (ETB, ex VAT)"><input type="number" min={0} step="0.01" value={f.cost_amount} onChange={set('cost_amount')} /></Field>}
        <Field label="Time impact"><select value={f.time_impact} onChange={set('time_impact')}>{(Object.keys(IMPACT_LABELS) as Impact[]).map((k) => <option key={k} value={k}>{IMPACT_LABELS[k]}</option>)}</select></Field>
        {f.time_impact === 'yes' && <Field label="Days"><input type="number" min={0} step="0.5" value={f.time_days} onChange={set('time_days')} /></Field>}
      </fieldset>
      {editable && <div className="row mt-2"><button className="primary" disabled={busy || !f.subject.trim() || !f.description.trim()} onClick={save}>{busy && <span className="spinner" />}{rfi ? 'Save' : kind === 'si' ? 'Register instruction' : 'Raise RFI'}</button></div>}

      {rfi && (
        <>
          <h3 className="mt-4">{kind === 'si' ? 'Compliance' : 'Answer'}</h3>
          {rfi.answer && <p style={{ whiteSpace: 'pre-wrap' }}>{rfi.answer}<br /><span className="muted small-text">{rfi.answered_by ? `${rfi.answered_by} · ` : ''}{date(rfi.answered_on)}</span></p>}
          {isOffice && ['open', 'answered'].includes(rfi.status) && (
            <div className="form-grid">
              <Field label={kind === 'si' ? 'What was done' : 'Consultant\'s answer'} wide><textarea rows={3} value={ans.answer} onChange={(e) => setAns({ ...ans, answer: e.target.value })} /></Field>
              <Field label={kind === 'si' ? 'Done on' : 'Answered on'}><input type="date" value={ans.answered_on} onChange={(e) => setAns({ ...ans, answered_on: e.target.value })} /></Field>
              {kind === 'rfi' && <Field label="Answered by"><input value={ans.answered_by} onChange={(e) => setAns({ ...ans, answered_by: e.target.value })} /></Field>}
            </div>
          )}
          <div className="row mt-2" style={{ flexWrap: 'wrap' }}>
            {isOffice && ['open', 'answered'].includes(rfi.status) && <button className="primary" disabled={busy || !ans.answer.trim()}
              onClick={() => decide('answer', { ...ans, cost_impact: f.cost_impact, cost_amount: nm(f.cost_amount), time_impact: f.time_impact, time_days: nm(f.time_days) })}>
              {kind === 'si' ? 'Record compliance' : 'Record answer'}</button>}
            {isOffice && (rfi.status === 'answered' || (kind === 'si' && rfi.status === 'open')) && <button disabled={busy} onClick={() => decide('close')}>Close</button>}
            {isOffice && rfi.status === 'closed' && <button disabled={busy} onClick={() => decide('reopen')}>Reopen</button>}
            {isOffice && ['open', 'answered'].includes(rfi.status) && <button disabled={busy} onClick={() => setVoiding(true)}>Void…</button>}
          </div>
          {isOffice && rfi.status !== 'void' && <LinkBox projectId={projectId} rfi={rfi} onDone={onClose} />}
          <h3 className="mt-4">Attachments</h3>
          <Attachments entityType="rfi" entityId={rfi.id} />
        </>
      )}
      {voiding && rfi && <ReasonModal title={`Void ${rfi.number}`} label="Why" onClose={() => setVoiding(false)}
        onSubmit={async (c) => { await officeRpc('decide_rfi', { rfi_id: rfi.id, action: 'void', comment: c }); setVoiding(false); toast.success('Void'); onClose(); }} />}
    </Drawer>
  );
}

function LinkBox({ projectId, rfi, onDone }: { projectId: string; rfi: RfiRow; onDone: () => void }) {
  const vq = useAsync(() => loadVariationOptions(projectId), [projectId], { key: 'variation-options' });
  const cq = useAsync(() => loadClaims(projectId), [projectId], { key: 'eot-claims' });
  const [v, setV] = useState(rfi.variation_id ?? '');
  const [e, setE] = useState(rfi.eot_claim_id ?? '');
  const { busy, error, run } = useBusy();
  const claims = useMemo(() => cq.data?.claims ?? [], [cq.data]);
  if (rfi.cost_impact === 'none' && rfi.time_impact === 'none' && !rfi.variation_id && !rfi.eot_claim_id) return null;
  return (
    <>
      <h3 className="mt-4">Raised as</h3>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Variation" hint={vq.data && !vq.data.length ? 'No variations you can see (price access needed)' : undefined}>
          <select value={v} onChange={(x) => setV(x.target.value)}><option value="">—</option>{(vq.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.number} · {o.title}</option>)}</select>
        </Field>
        <Field label="EOT / delay claim">
          <select value={e} onChange={(x) => setE(x.target.value)}><option value="">—</option>{claims.map((o) => <option key={o.id} value={o.id}>{o.number} · {o.title}</option>)}</select>
        </Field>
      </div>
      <div className="row mt-2"><button disabled={busy} onClick={() => void run(async () => {
        await officeRpc('decide_rfi', { rfi_id: rfi.id, action: 'link', variation_id: v || null, eot_claim_id: e || null });
        toast.success('Links saved'); onDone();
      })}>Save links</button></div>
    </>
  );
}
