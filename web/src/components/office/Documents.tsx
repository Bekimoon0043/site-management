// Drawing / document register with revisions (current revision on site) and submittals with review codes A–D.
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { date, humanize } from '../../lib/format';
import {
  DISCIPLINES, REVIEW_CODES, REV_STATUS_LABELS, SUBMITTAL_STATUS_LABELS, type DocType, type ProjectDocument, type ReviewCode, type RevStatus,
  type SubmittalKind, type SubmittalRow, type SubmittalStatus,
} from '../../lib/contract-office';
import { Attachments } from '../Attachments';
import { Badge, Banner, Card, DataTable, Drawer, ErrorBanner, Field, Kpi, ReasonModal, SearchInput, toast, useBusy, type Tone } from '../ui';
import { canOffice, loadDocuments, loadRevisions, loadSubmittalRevisions, loadSubmittals, officeRpc, todayEat } from './data';

const DOC_TYPES: DocType[] = ['drawing', 'specification', 'report', 'calculation', 'schedule', 'other'];

export function DocumentRegister({ projectId }: { projectId: string }) {
  const auth = useAuth();
  const q = useAsync(() => loadDocuments(projectId), [projectId], { key: 'documents' });
  const [open, setOpen] = useState<ProjectDocument | 'new' | null>(null);
  const [term, setTerm] = useState('');
  const t = term.trim().toLowerCase();
  const rows = (q.data ?? []).filter((d) => !t || d.doc_no.toLowerCase().includes(t) || d.title.toLowerCase().includes(t));
  const edit = canOffice(auth.profile?.role, 'documents');
  return (
    <div className="stack">
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <Card flush title="Drawing & document register" sub="Every drawing with its current revision — build only from the revision marked current."
        actions={<div className="row" style={{ gap: 6 }}><SearchInput value={term} onChange={setTerm} placeholder="No. or title" />
          {edit && <button className="primary small" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />Add document</button>}</div>}>
        <DataTable rows={rows} rowKey={(r) => r.id} loading={!q.data} onRowClick={(r) => setOpen(r)} exportName="drawing-register"
          empty={{ title: 'No documents registered', body: 'Register the drawings and specifications received from the consultant, with their revisions.' }}
          columns={[
            { key: 'doc_no', label: 'No.', id: true },
            { key: 'title', label: 'Title' },
            { key: 'discipline', label: 'Discipline', value: (r) => r.discipline ?? '', render: (r) => (r.discipline ? humanize(r.discipline) : '—') },
            { key: 'doc_type', label: 'Type', render: (r) => humanize(r.doc_type) },
            { key: 'current_rev', label: 'Current rev', render: (r) => (r.current_rev ? <b>{r.current_rev}</b> : '—') },
            { key: 'current_status', label: 'Status', value: (r) => r.current_status ?? '', render: (r) => (r.current_status
              ? <Badge tone={r.current_status === 'for_construction' || r.current_status === 'as_built' ? 'success' : 'info'} label={REV_STATUS_LABELS[r.current_status]} icon={null} /> : '—') },
            { key: 'updated_at', label: 'Updated', value: (r) => r.updated_at, render: (r) => date(r.updated_at) },
          ]} />
      </Card>
      {open && <DocumentDrawer key={open === 'new' ? 'new' : open.id} projectId={projectId} doc={open === 'new' ? null : open} edit={edit} onClose={() => { setOpen(null); q.reload(); }} />}
    </div>
  );
}

function DocumentDrawer({ projectId, doc, edit, onClose }: { projectId: string; doc: ProjectDocument | null; edit: boolean; onClose: () => void }) {
  const lk = useLookups(projectId);
  const rq = useAsync(() => (doc ? loadRevisions(doc.id) : Promise.resolve([])), [doc?.id], { key: 'doc-revisions' });
  const [f, setF] = useState({ doc_no: doc?.doc_no ?? '', title: doc?.title ?? '', discipline: doc?.discipline ?? '', doc_type: doc?.doc_type ?? 'drawing' as DocType });
  const [rv, setRv] = useState({ rev: '', rev_date: '', status: 'for_construction' as RevStatus, received_on: todayEat(), transmittal_ref: '', notes: '' });
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    const r = await officeRpc('save_document', { id: doc?.id ?? crypto.randomUUID(), project_id: projectId, ...f, discipline: f.discipline as never,
      revision: rv.rev.trim() ? { ...rv, rev_date: rv.rev_date || undefined } : undefined });
    toast.success(rv.rev.trim() ? `${f.doc_no} rev ${String(r.current_rev)} registered` : 'Saved');
    onClose();
  });
  return (
    <Drawer size="lg" onClose={onClose} title={doc ? `${doc.doc_no} · ${doc.title}` : 'Add a document'} subtitle={doc?.current_rev ? `Current revision ${doc.current_rev}` : undefined}>
      <ErrorBanner error={error} />
      <fieldset disabled={!edit} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Document no." required><input value={f.doc_no} onChange={(e) => setF({ ...f, doc_no: e.target.value })} placeholder="S-04" /></Field>
        <Field label="Title" required wide><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Discipline"><select value={f.discipline} onChange={(e) => setF({ ...f, discipline: e.target.value as never })}><option value="">—</option>{DISCIPLINES.map((d) => <option key={d} value={d}>{humanize(d)}</option>)}</select></Field>
        <Field label="Type"><select value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value as DocType })}>{DOC_TYPES.map((d) => <option key={d} value={d}>{humanize(d)}</option>)}</select></Field>
      </fieldset>
      {edit && (
        <>
          <h3 className="mt-4">{doc ? 'Register a new revision' : 'First revision'}</h3>
          <div className="form-grid">
            <Field label="Revision"><input value={rv.rev} onChange={(e) => setRv({ ...rv, rev: e.target.value })} placeholder="A, B, 0, 1…" style={{ width: 90 }} /></Field>
            <Field label="Purpose"><select value={rv.status} onChange={(e) => setRv({ ...rv, status: e.target.value as RevStatus })}>{(Object.keys(REV_STATUS_LABELS) as RevStatus[]).map((s) => <option key={s} value={s}>{REV_STATUS_LABELS[s]}</option>)}</select></Field>
            <Field label="Revision date"><input type="date" value={rv.rev_date} onChange={(e) => setRv({ ...rv, rev_date: e.target.value })} /></Field>
            <Field label="Received on"><input type="date" value={rv.received_on} max={todayEat()} onChange={(e) => setRv({ ...rv, received_on: e.target.value })} /></Field>
            <Field label="Transmittal ref."><input value={rv.transmittal_ref} onChange={(e) => setRv({ ...rv, transmittal_ref: e.target.value })} /></Field>
            <Field label="What changed" wide><input value={rv.notes} onChange={(e) => setRv({ ...rv, notes: e.target.value })} /></Field>
          </div>
          {rv.rev.trim() && doc?.current_rev && <Banner tone="info">Rev {doc.current_rev} will be marked superseded; site staff are told to withdraw it.</Banner>}
          <div className="row mt-2"><button className="primary" disabled={busy || !f.doc_no.trim() || !f.title.trim()} onClick={save}>{busy && <span className="spinner" />}Save</button></div>
        </>
      )}
      {doc && (
        <>
          <h3 className="mt-4">Revisions</h3>
          <DataTable rows={rq.data ?? []} rowKey={(r) => r.id} loading={!rq.data}
            columns={[
              { key: 'rev', label: 'Rev', id: true },
              { key: 'status', label: 'Purpose', render: (r) => REV_STATUS_LABELS[r.status] },
              { key: 'received_on', label: 'Received', render: (r) => date(r.received_on) },
              { key: 'transmittal_ref', label: 'Transmittal', render: (r) => r.transmittal_ref ?? '—' },
              { key: 'notes', label: 'Changes', render: (r) => r.notes ?? '—' },
              { key: 'superseded_at', label: 'State', value: (r) => (r.superseded_at ? 'superseded' : 'current'),
                render: (r) => (r.superseded_at ? <Badge tone="neutral" label="Superseded" icon={null} /> : <Badge tone="success" label="Current" icon={null} />) },
              { key: 'by', label: 'By', value: (r) => lk.data?.person(r.created_by) ?? '' },
            ]} />
          <h3 className="mt-4">Files</h3>
          <Attachments entityType="document" entityId={doc.id} />
        </>
      )}
    </Drawer>
  );
}

const SUB_TONE: Record<SubmittalStatus, Tone> = {
  draft: 'neutral', submitted: 'warning', approved: 'success', approved_as_noted: 'success', revise_resubmit: 'danger', rejected: 'danger', void: 'neutral',
};
const SUB_KINDS: SubmittalKind[] = ['material', 'shop_drawing', 'method_statement', 'sample', 'test_report', 'other'];

export function Submittals({ projectId }: { projectId: string }) {
  const auth = useAuth();
  const lk = useLookups(projectId);
  const q = useAsync(() => loadSubmittals(projectId), [projectId], { key: 'submittals' });
  const [open, setOpen] = useState<SubmittalRow | 'new' | null>(null);
  const rows = q.data ?? [];
  const pending = rows.filter((r) => r.status === 'submitted');
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="With the reviewer" value={pending.length} />
        <Kpi label="Review overdue" value={pending.filter((r) => r.days_overdue > 0).length} status={pending.some((r) => r.days_overdue > 0) ? 'danger' : 'ok'} />
        <Kpi label="To resubmit" value={rows.filter((r) => ['revise_resubmit', 'rejected'].includes(r.status)).length} />
        <Kpi label="Approval needed within 14 days" value={rows.filter((r) => r.at_risk).length} status={rows.some((r) => r.at_risk) ? 'warning' : 'ok'} />
      </div>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <Card flush title="Submittals & material approvals" sub="Product data, samples, shop drawings and method statements sent for approval before ordering or starting work."
        actions={canOffice(auth.profile?.role, 'createSubmittal') ? <button className="primary small" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />New submittal</button> : undefined}>
        <DataTable rows={rows} rowKey={(r) => r.id} loading={!q.data} onRowClick={(r) => setOpen(r)} exportName="submittal-register"
          rowClass={(r) => (r.days_overdue > 0 || r.at_risk ? 'row-warn' : undefined)}
          empty={{ title: 'No submittals', body: 'Send materials and shop drawings for approval before ordering — unapproved materials get rejected on site.' }}
          columns={[
            { key: 'number', label: 'No.', id: true },
            { key: 'title', label: 'Title' },
            { key: 'kind', label: 'Type', render: (r) => humanize(r.kind) },
            { key: 'material', label: 'Material', value: (r) => (r.material_spec_id ? lk.data?.spec(r.material_spec_id) ?? '' : ''), render: (r) => (r.material_spec_id ? lk.data?.spec(r.material_spec_id) : '—') },
            { key: 'rev', label: 'Rev', align: 'right', value: (r) => r.current_rev ?? -1, render: (r) => (r.current_rev == null ? '—' : r.current_rev) },
            { key: 'response_due', label: 'Response due', value: (r) => r.response_due ?? '', render: (r) => (r.status === 'submitted' && r.response_due
              ? <span className={r.days_overdue > 0 ? 'danger-text strong' : undefined}>{date(r.response_due)}{r.days_overdue > 0 ? ` (+${r.days_overdue} d)` : ''}</span> : '—') },
            { key: 'required_by', label: 'Needed by', value: (r) => r.required_by ?? '', render: (r) => (r.required_by ? date(r.required_by) : '—') },
            { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Badge tone={SUB_TONE[r.status]} label={SUBMITTAL_STATUS_LABELS[r.status]} icon={null} /> },
          ]} />
      </Card>
      {open && <SubmittalDrawer key={open === 'new' ? 'new' : open.id} projectId={projectId} s={open === 'new' ? null : open} onClose={() => { setOpen(null); q.reload(); }} />}
    </div>
  );
}

function SubmittalDrawer({ projectId, s, onClose }: { projectId: string; s: SubmittalRow | null; onClose: () => void }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const lk = useLookups(projectId);
  const rq = useAsync(() => (s ? loadSubmittalRevisions(s.id) : Promise.resolve([])), [s?.id, s?.status], { key: 'submittal-revisions' });
  const editable = !s || (s.status !== 'void' && canOffice(role, 'createSubmittal'));
  const decide = canOffice(role, 'decideSubmittal');
  const [f, setF] = useState({ title: s?.title ?? '', kind: s?.kind ?? 'material' as SubmittalKind, spec_section: s?.spec_section ?? '', material_spec_id: s?.material_spec_id ?? '',
    supplier: s?.supplier ?? '', required_by: s?.required_by ?? '', notes: s?.notes ?? '' });
  const [sub, setSub] = useState({ submitted_on: todayEat(), response_due: '', transmittal_ref: '' });
  const [resp, setResp] = useState({ code: 'A' as ReviewCode, responded_on: todayEat(), reviewer: '', comments: '' });
  const [voiding, setVoiding] = useState(false);
  const { busy, error, run } = useBusy();
  const save = (then?: 'submit') => void run(async () => {
    const id = s?.id ?? crypto.randomUUID();
    const r = await officeRpc('save_submittal', { id, project_id: projectId, ...f, material_spec_id: f.material_spec_id || null, required_by: f.required_by || null });
    if (then === 'submit') await officeRpc('decide_submittal', { submittal_id: id, action: 'submit', ...sub, response_due: sub.response_due || undefined });
    toast.success(then ? `${String(r.number)} submitted` : `${String(r.number)} saved`);
    onClose();
  });
  const respond = () => void run(async () => {
    await officeRpc('decide_submittal', { submittal_id: s!.id, action: 'respond', ...resp });
    toast.success(`Code ${resp.code} recorded`);
    onClose();
  });
  const canSubmit = !s || ['draft', 'revise_resubmit', 'rejected'].includes(s.status);
  return (
    <Drawer size="lg" onClose={onClose} title={s ? `${s.number} · ${s.title}` : 'New submittal'}
      subtitle={s ? <Badge tone={SUB_TONE[s.status]} label={SUBMITTAL_STATUS_LABELS[s.status]} icon={null} /> : undefined}>
      <ErrorBanner error={error} />
      <fieldset disabled={!editable} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Title" required wide><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="SBS membrane 4 mm — product data" /></Field>
        <Field label="Type"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as SubmittalKind })}>{SUB_KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</select></Field>
        <Field label="Spec section"><input value={f.spec_section} onChange={(e) => setF({ ...f, spec_section: e.target.value })} /></Field>
        <Field label="Material" hint="Procurement is told when it is approved">
          <select value={f.material_spec_id} onChange={(e) => setF({ ...f, material_spec_id: e.target.value })}>
            <option value="">—</option>{(lk.data?.specs ?? []).map((sp) => <option key={sp.id} value={sp.id}>{lk.data?.spec(sp.id)}</option>)}
          </select>
        </Field>
        <Field label="Supplier / manufacturer"><input value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></Field>
        <Field label="Approval needed by"><input type="date" value={f.required_by} onChange={(e) => setF({ ...f, required_by: e.target.value })} /></Field>
        <Field label="Notes" wide><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </fieldset>
      {editable && (
        <>
          {canSubmit && decide && (
            <div className="form-grid mt-2">
              <Field label="Submitted on"><input type="date" value={sub.submitted_on} max={todayEat()} onChange={(e) => setSub({ ...sub, submitted_on: e.target.value })} /></Field>
              <Field label="Response due" hint="Empty = submittal response days from the settings"><input type="date" value={sub.response_due} onChange={(e) => setSub({ ...sub, response_due: e.target.value })} /></Field>
              <Field label="Transmittal ref."><input value={sub.transmittal_ref} onChange={(e) => setSub({ ...sub, transmittal_ref: e.target.value })} /></Field>
            </div>
          )}
          <div className="row mt-2" style={{ flexWrap: 'wrap' }}>
            <button disabled={busy || !f.title.trim()} onClick={() => save()}>Save</button>
            {canSubmit && decide && <button className="primary" disabled={busy || !f.title.trim()} onClick={() => save('submit')}>{busy && <span className="spinner" />}{s && s.current_rev != null ? `Resubmit as rev ${s.current_rev + 1}` : 'Submit for approval'}</button>}
            {s && decide && s.status !== 'void' && <button disabled={busy} onClick={() => setVoiding(true)}>Void…</button>}
          </div>
        </>
      )}
      {s?.status === 'submitted' && decide && (
        <>
          <h3 className="mt-4">Reviewer's response (rev {s.current_rev})</h3>
          <div className="form-grid">
            <Field label="Code"><select value={resp.code} onChange={(e) => setResp({ ...resp, code: e.target.value as ReviewCode })}>
              {(Object.keys(REVIEW_CODES) as ReviewCode[]).map((c) => <option key={c} value={c}>{c} — {REVIEW_CODES[c]}</option>)}</select></Field>
            <Field label="Responded on"><input type="date" value={resp.responded_on} onChange={(e) => setResp({ ...resp, responded_on: e.target.value })} /></Field>
            <Field label="Reviewer"><input value={resp.reviewer} onChange={(e) => setResp({ ...resp, reviewer: e.target.value })} /></Field>
            <Field label="Comments" wide required={resp.code !== 'A'}><textarea rows={2} value={resp.comments} onChange={(e) => setResp({ ...resp, comments: e.target.value })} /></Field>
          </div>
          <div className="row mt-2"><button className="primary" disabled={busy || (resp.code !== 'A' && !resp.comments.trim())} onClick={respond}>Record response</button></div>
        </>
      )}
      {s && (
        <>
          <h3 className="mt-4">Submissions</h3>
          <DataTable rows={rq.data ?? []} rowKey={(r) => r.id} loading={!rq.data}
            columns={[
              { key: 'rev', label: 'Rev', id: true },
              { key: 'submitted_on', label: 'Submitted', render: (r) => date(r.submitted_on) },
              { key: 'response_due', label: 'Due', render: (r) => date(r.response_due) },
              { key: 'code', label: 'Code', render: (r) => (r.code ? `${r.code} · ${REVIEW_CODES[r.code]}` : 'Waiting') },
              { key: 'responded_on', label: 'Answered', render: (r) => (r.responded_on ? date(r.responded_on) : '—') },
              { key: 'comments', label: 'Comments', render: (r) => r.comments ?? '—' },
            ]} />
          <h3 className="mt-4">Files</h3>
          <Attachments entityType="submittal" entityId={s.id} />
        </>
      )}
      {voiding && s && <ReasonModal title={`Void ${s.number}`} label="Why" onClose={() => setVoiding(false)}
        onSubmit={async (c) => { await officeRpc('decide_submittal', { submittal_id: s.id, action: 'void', comment: c }); setVoiding(false); toast.success('Void'); onClose(); }} />}
    </Drawer>
  );
}
