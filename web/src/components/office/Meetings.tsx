// Meeting minutes with action items (owner, due date) and the project's action list.
import { useState } from 'react';
import { Plus, Printer, Trash2 } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { date, humanize } from '../../lib/format';
import type { Meeting, MeetingAction, MeetingKind } from '../../lib/contract-office';
import { Badge, Card, DataTable, Drawer, ErrorBanner, Field, Kpi, PrintHeader, Signatures, Tabs, toast, useBusy } from '../ui';
import { canOffice, loadMeetings, officeRpc, todayEat } from './data';

const KINDS: MeetingKind[] = ['progress', 'coordination', 'client', 'subcontractor', 'safety', 'kickoff', 'other'];

export function Meetings({ projectId }: { projectId: string }) {
  const auth = useAuth();
  const me = auth.profile?.id;
  const lk = useLookups(projectId);
  const q = useAsync(() => loadMeetings(projectId), [projectId], { key: 'meetings' });
  const [view, setView] = useState<'mine' | 'actions' | 'meetings'>('mine');
  const [open, setOpen] = useState<Meeting | 'new' | null>(null);
  const [newAction, setNewAction] = useState(false);
  const { busy, error, run } = useBusy();
  const meetings = q.data?.meetings ?? [];
  const actions = (q.data?.actions ?? []).filter((a) => !a.meeting_id || meetings.find((m) => m.id === a.meeting_id)?.status === 'issued' || canOffice(auth.profile?.role, 'office'));
  const today = todayEat();
  const openActs = actions.filter((a) => a.status === 'open');
  const shownActs = view === 'mine' ? openActs.filter((a) => a.owner_id === me) : actions;
  const mtg = (id: string | null) => meetings.find((m) => m.id === id)?.number ?? '—';
  const setStatus = (a: MeetingAction, action: 'done' | 'reopen' | 'cancel') => void run(async () => {
    await officeRpc('save_action_item', { id: a.id, project_id: projectId, action });
    toast.success(action === 'done' ? 'Marked done' : action === 'reopen' ? 'Reopened' : 'Cancelled');
    q.reload();
  });
  const canAct = (a: MeetingAction) => a.owner_id === me || canOffice(auth.profile?.role, 'office');
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="My open actions" value={openActs.filter((a) => a.owner_id === me).length} />
        <Kpi label="Open actions (project)" value={openActs.length} />
        <Kpi label="Overdue actions" value={openActs.filter((a) => a.due_date && a.due_date < today).length} status={openActs.some((a) => a.due_date && a.due_date < today) ? 'danger' : 'ok'} />
        <Kpi label="Meetings this month" value={meetings.filter((m) => m.held_on.slice(0, 7) === today.slice(0, 7)).length} />
      </div>
      <ErrorBanner error={error ?? q.error} onRetry={q.reload} />
      <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <Tabs variant="segmented" value={view} onChange={setView} tabs={[{ key: 'mine', label: 'My actions' }, { key: 'actions', label: 'All actions' }, { key: 'meetings', label: 'Minutes' }]} />
        {canOffice(auth.profile?.role, 'meetings') && (
          <div className="row" style={{ gap: 6 }}>
            <button className="primary small" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />Record a meeting</button>
            <button className="small" onClick={() => setNewAction(true)}><Plus size={14} aria-hidden />Action</button>
          </div>
        )}
      </div>
      {view === 'meetings' ? (
        <Card flush>
          <DataTable rows={meetings} rowKey={(r) => r.id} loading={!q.data} onRowClick={(r) => setOpen(r)} exportName="meetings"
            empty={{ title: 'No minutes yet', body: 'Record the weekly progress meeting and its action items — owners get them in their inbox.' }}
            columns={[
              { key: 'number', label: 'No.', id: true },
              { key: 'held_on', label: 'Date', value: (r) => r.held_on, render: (r) => date(r.held_on) },
              { key: 'title', label: 'Meeting' },
              { key: 'kind', label: 'Type', render: (r) => humanize(r.kind) },
              { key: 'actions', label: 'Open actions', align: 'right', value: (r) => actions.filter((a) => a.meeting_id === r.id && a.status === 'open').length },
              { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Badge tone={r.status === 'issued' ? 'success' : 'neutral'} label={r.status === 'issued' ? 'Issued' : 'Draft'} icon={null} /> },
            ]} />
        </Card>
      ) : (
        <Card flush>
          <DataTable rows={shownActs} rowKey={(r) => r.id} loading={!q.data} exportName="action-items"
            rowClass={(r) => (r.status === 'open' && r.due_date && r.due_date < today ? 'row-warn' : undefined)}
            empty={{ title: view === 'mine' ? 'No open actions for you' : 'No actions', body: 'Actions come from issued minutes or are added directly.' }}
            columns={[
              { key: 'description', label: 'Action', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.description}</span> },
              { key: 'owner', label: 'Owner', value: (r) => (r.owner_id ? lk.data?.person(r.owner_id) ?? '' : r.owner_name ?? ''), render: (r) => (r.owner_id ? lk.data?.person(r.owner_id) : r.owner_name) },
              { key: 'due_date', label: 'Due', value: (r) => r.due_date ?? '', render: (r) => (r.due_date ? <span className={r.status === 'open' && r.due_date < today ? 'danger-text strong' : undefined}>{date(r.due_date)}</span> : '—') },
              { key: 'meeting', label: 'From', value: (r) => mtg(r.meeting_id) },
              { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Badge tone={r.status === 'done' ? 'success' : r.status === 'open' ? 'warning' : 'neutral'} label={humanize(r.status)} icon={null} /> },
              { key: 'act', label: '', noExport: true, sortable: false, render: (r) => (canAct(r) ? (
                r.status === 'open' ? <button className="small" disabled={busy} onClick={(e) => { e.stopPropagation(); setStatus(r, 'done'); }}>Done</button>
                  : <button className="small" disabled={busy} onClick={(e) => { e.stopPropagation(); setStatus(r, 'reopen'); }}>Reopen</button>) : null) },
            ]} />
        </Card>
      )}
      {open && <MeetingDrawer key={open === 'new' ? 'new' : open.id} projectId={projectId} m={open === 'new' ? null : open}
        actions={open === 'new' ? [] : (q.data?.actions ?? []).filter((a) => a.meeting_id === open.id)} onClose={() => { setOpen(null); q.reload(); }} />}
      {newAction && <ActionDrawer projectId={projectId} onClose={() => { setNewAction(false); q.reload(); }} />}
    </div>
  );
}

interface ActDraft { id?: string; description: string; owner: string; due_date: string }

function MeetingDrawer({ projectId, m, actions, onClose }: { projectId: string; m: Meeting | null; actions: MeetingAction[]; onClose: () => void }) {
  const auth = useAuth();
  const lk = useLookups(projectId);
  const editable = canOffice(auth.profile?.role, 'meetings');
  const [f, setF] = useState({ kind: m?.kind ?? 'progress' as MeetingKind, title: m?.title ?? 'Weekly progress meeting', held_on: m?.held_on ?? todayEat(),
    location: m?.location ?? 'Site office', chaired_by: m?.chaired_by ?? '', attendees: m?.attendees ?? '', agenda: m?.agenda ?? '', minutes: m?.minutes ?? '',
    next_meeting_on: m?.next_meeting_on ?? '' });
  const [acts, setActs] = useState<ActDraft[]>(actions.filter((a) => a.status === 'open').map((a) => ({ id: a.id, description: a.description,
    owner: a.owner_id ? `u:${a.owner_id}` : `n:${a.owner_name ?? ''}`, due_date: a.due_date ?? '' })));
  const { busy, error, run } = useBusy();
  const members = lk.data?.profiles ?? [];
  const save = (issue: boolean) => void run(async () => {
    const r = await officeRpc('save_meeting', { id: m?.id ?? crypto.randomUUID(), project_id: projectId, ...f, next_meeting_on: f.next_meeting_on || null, issue,
      actions: acts.filter((a) => a.description.trim()).map((a) => ({ id: a.id, description: a.description,
        owner_id: a.owner.startsWith('u:') ? a.owner.slice(2) : null, owner_name: a.owner.startsWith('n:') ? a.owner.slice(2) : undefined, due_date: a.due_date || null })) });
    toast.success(issue ? `${String(r.number)} issued — owners notified` : `${String(r.number)} saved`);
    onClose();
  });
  const setAct = (i: number, patch: Partial<ActDraft>) => setActs(acts.map((a, k) => (k === i ? { ...a, ...patch } : a)));
  const closed = actions.filter((a) => a.status !== 'open');
  return (
    <Drawer size="lg" onClose={onClose} title={m ? `${m.number} · ${m.title}` : 'Record a meeting'}
      subtitle={m ? `${date(m.held_on)} · ${m.status === 'issued' ? 'Issued' : 'Draft'}` : 'Minutes and action items'}
      footer={m ? <button onClick={() => window.print()}><Printer size={14} aria-hidden />Print minutes</button> : undefined}>
      <div className="print-doc">
        <PrintHeader title={`Minutes of meeting ${m?.number ?? ''} — ${f.title}`} />
        <ErrorBanner error={error} />
        <fieldset disabled={!editable} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
          <Field label="Meeting" required wide><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Type"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as MeetingKind })}>{KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</select></Field>
          <Field label="Date" required><input type="date" value={f.held_on} onChange={(e) => setF({ ...f, held_on: e.target.value })} /></Field>
          <Field label="Location"><input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
          <Field label="Chaired by"><input value={f.chaired_by} onChange={(e) => setF({ ...f, chaired_by: e.target.value })} /></Field>
          <Field label="Attendees" wide><textarea rows={2} value={f.attendees} onChange={(e) => setF({ ...f, attendees: e.target.value })} placeholder="Client: …; Consultant: …; Contractor: …" /></Field>
          <Field label="Agenda" wide><textarea rows={2} value={f.agenda} onChange={(e) => setF({ ...f, agenda: e.target.value })} /></Field>
          <Field label="Minutes / decisions" wide><textarea rows={6} value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} /></Field>
          <Field label="Next meeting"><input type="date" value={f.next_meeting_on} onChange={(e) => setF({ ...f, next_meeting_on: e.target.value })} /></Field>
        </fieldset>
        <h3 className="mt-4">Action items</h3>
        {acts.map((a, i) => (
          <div key={a.id ?? i} className="row" style={{ gap: 6, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 6 }}>
            <Field label={`${i + 1}. Action`}><input value={a.description} disabled={!editable} onChange={(e) => setAct(i, { description: e.target.value })} style={{ minWidth: 260 }} /></Field>
            <Field label="Owner">
              <select value={a.owner.startsWith('u:') ? a.owner : 'n:'} disabled={!editable} onChange={(e) => setAct(i, { owner: e.target.value })}>
                <option value="n:">Outside party…</option>{members.map((p) => <option key={p.id} value={`u:${p.id}`}>{p.full_name} ({humanize(p.role)})</option>)}
              </select>
            </Field>
            {a.owner.startsWith('n:') && <Field label="Name"><input value={a.owner.slice(2)} disabled={!editable} onChange={(e) => setAct(i, { owner: `n:${e.target.value}` })} placeholder="Consultant" /></Field>}
            <Field label="Due"><input type="date" value={a.due_date} disabled={!editable} onChange={(e) => setAct(i, { due_date: e.target.value })} /></Field>
            {editable && <button type="button" className="icon-btn no-print" aria-label="Remove action" onClick={() => setActs(acts.filter((_, k) => k !== i))}><Trash2 size={14} /></button>}
          </div>
        ))}
        {editable && <button type="button" className="small no-print" onClick={() => setActs([...acts, { description: '', owner: 'n:', due_date: '' }])}><Plus size={14} aria-hidden />Add action</button>}
        {closed.length > 0 && <p className="muted small-text">Closed: {closed.map((a) => `${a.description} (${a.status})`).join('; ')}</p>}
        {editable && (
          <div className="row mt-4 no-print" style={{ flexWrap: 'wrap' }}>
            <button disabled={busy || !f.title.trim()} onClick={() => save(false)}>Save draft</button>
            <button className="primary" disabled={busy || !f.title.trim()} onClick={() => save(true)}>{busy && <span className="spinner" />}{m?.status === 'issued' ? 'Save' : 'Issue minutes'}</button>
          </div>
        )}
        <Signatures />
      </div>
    </Drawer>
  );
}

function ActionDrawer({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const lk = useLookups(projectId);
  const [f, setF] = useState({ description: '', owner_id: '', owner_name: '', due_date: '' });
  const { busy, error, run } = useBusy();
  return (
    <Drawer onClose={onClose} title="New action" subtitle="Owner gets it in the inbox">
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Action" required wide><textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Owner">
          <select value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })}>
            <option value="">Outside party…</option>{(lk.data?.profiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name} ({humanize(p.role)})</option>)}
          </select>
        </Field>
        {!f.owner_id && <Field label="Name"><input value={f.owner_name} onChange={(e) => setF({ ...f, owner_name: e.target.value })} /></Field>}
        <Field label="Due"><input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
      </div>
      <div className="row mt-2"><button className="primary" disabled={busy || !f.description.trim() || (!f.owner_id && !f.owner_name.trim())} onClick={() => void run(async () => {
        await officeRpc('save_action_item', { id: crypto.randomUUID(), project_id: projectId, description: f.description, owner_id: f.owner_id || null,
          owner_name: f.owner_name || undefined, due_date: f.due_date || null });
        toast.success('Action added'); onClose();
      })}>Add action</button></div>
    </Drawer>
  );
}
