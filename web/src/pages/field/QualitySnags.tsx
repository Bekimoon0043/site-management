import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Plus } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups, type Lookups } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { SNAG_STATUS_LABELS, canField, type Snag, type SnagAction, type SnagEvent, type SnagSeverity } from '../../lib/contract-field';
import { nextNumber, optStr, rpcx, uuid } from '../../lib/fieldx';
import { date, dateTime, dueIn, humanize, today, since } from '../../lib/format';
import { useUrlFilters, useUrlParam } from '../../lib/url';
import { Attachments } from '../../components/Attachments';
import { SBadge } from '../../components/field/StatusBadge';
import {
  DataTable, Drawer, Empty, ErrorBanner, Field, FilterBar, FilterSelect, FilterToggle, Loading, ReasonModal, SearchInput, toast, useBusy,
} from '../../components/ui';

const OPEN = ['open', 'in_progress', 'ready_for_review', 'reopened'];
const SEVERITIES: SnagSeverity[] = ['low', 'medium', 'high', 'critical'];
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SOURCE_LINK: Record<string, (id: string) => string> = {
  inspection: (id) => `/quality/inspections/${id}`, pour: (id) => `/concrete/pours/${id}`, diary: (id) => `/diary/${id}`,
};

export function SnagsTab() {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const q = useAsync(() => fetchAll<Snag>((a, b) => supabase.from('snags').select('*').eq('project_id', projectId).order('created_at', { ascending: false }).range(a, b)),
    [projectId], { key: 'snags' });
  const [f, setF, { active, clear }] = useUrlFilters({ status: 'active', severity: '', trade: '', assignee: '', element: '', block: '', overdue: '', q: '' }, 's_');
  const [peek, setPeek] = useUrlParam('peek');
  const [editing, setEditing] = useState<Snag | 'new' | null>(null);
  const L = lk.data;
  const t = today();
  const all = q.data ?? [];
  const trades = [...new Set(all.map((s) => s.trade).filter(Boolean) as string[])].sort();
  const term = f.q.toLowerCase();
  const rows = useMemo(() => all.filter((s) =>
    (f.status === 'active' ? OPEN.includes(s.status) : f.status === 'any' || s.status === f.status)
    && (!f.severity || s.severity === f.severity) && (!f.trade || s.trade === f.trade)
    && (!f.assignee || (f.assignee === 'none' ? !s.assignee_user_id && !s.assignee_party : s.assignee_user_id === f.assignee))
    && (!f.element || s.element_id === f.element) && (!f.block || s.block_id === f.block)
    && (!f.overdue || (OPEN.includes(s.status) && !!s.due_date && s.due_date < t))
    && (!term || s.number.toLowerCase().includes(term) || s.title.toLowerCase().includes(term) || (s.location_text ?? '').toLowerCase().includes(term)))
    .sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || b.created_at.localeCompare(a.created_at)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [all, f.status, f.severity, f.trade, f.assignee, f.element, f.block, f.overdue, term]);
  const current = all.find((s) => s.id === peek) ?? null;

  return (
    <>
      <ErrorBanner error={q.error ?? lk.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={clear}
        right={canField(auth.profile?.role, 'snag.create') && <button className="primary" onClick={() => setEditing('new')}><Plus size={14} aria-hidden />New snag</button>}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Snag no., title, location" />
        <FilterSelect label="Status" value={f.status === 'active' ? '' : f.status} onChange={(v) => setF('status', v || 'active')} allLabel="Open (all active)"
          options={[{ value: 'any', label: 'Any status' }, ...Object.entries(SNAG_STATUS_LABELS).map(([k, v]) => ({ value: k, label: v }))]} />
        <FilterSelect label="Severity" value={f.severity} onChange={(v) => setF('severity', v)} options={SEVERITIES.map((s) => ({ value: s, label: humanize(s) }))} />
        <FilterSelect label="Trade" value={f.trade} onChange={(v) => setF('trade', v)} options={trades.map((x) => ({ value: x, label: x }))} />
        <FilterSelect label="Assignee" value={f.assignee} onChange={(v) => setF('assignee', v)}
          options={[{ value: 'none', label: 'Unassigned' }, ...(L?.profiles ?? []).map((p) => ({ value: p.id, label: p.full_name || p.email || p.id }))]} />
        <FilterSelect label="Block" value={f.block} onChange={(v) => setF('block', v)} options={(L?.blocks ?? []).map((b) => ({ value: b.id, label: b.code }))} />
        <FilterSelect label="Element" value={f.element} onChange={(v) => setF('element', v)} options={(L?.elements ?? []).map((e) => ({ value: e.id, label: L!.element(e.id) }))} />
        <FilterToggle label="Overdue" checked={!!f.overdue} onChange={(v) => setF('overdue', v ? '1' : '')} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data || !L} error={q.error} onRetry={q.reload} urlKey="s_" stickyFirst exportName="snag-list" viewKey="snags"
        filtered={active > 0} onClearFilters={clear} onRowClick={(r) => setPeek(r.id, true)} activeKey={peek}
        empty={{ title: 'No snags', body: 'Defects raised on site, from failed inspection items or failed cubes appear here.' }}
        columns={[
          { key: 'number', label: 'Snag', id: true },
          { key: 'severity', label: 'Severity', value: (r) => SEV_RANK[r.severity], render: (r) => <SBadge value={r.severity} /> },
          { key: 'title', label: 'Title' },
          { key: 'status', label: 'Status', value: (r) => SNAG_STATUS_LABELS[r.status], render: (r) => <SBadge value={r.status} /> },
          { key: 'where', label: 'Element / location', value: (r) => [L?.element(r.element_id), r.location_text].filter(Boolean).join(' · ') },
          { key: 'trade', label: 'Trade' },
          { key: 'assignee', label: 'Assignee', value: (r) => L?.person(r.assignee_user_id) || r.assignee_party },
          { key: 'due_date', label: 'Due', value: (r) => r.due_date, render: (r) => {
            const d = OPEN.includes(r.status) ? dueIn(r.due_date) : null;
            return r.due_date ? <span className="nowrap">{date(r.due_date)}{d?.text && <span className={`small-text ${d.late ? 'danger-text' : 'muted'}`}> · {d.text}</span>}</span> : '';
          } },
          { key: 'source_type', label: 'Source', value: (r) => humanize(r.source_type) },
          { key: 'block', label: 'Block', hidden: true, value: (r) => L?.block(r.block_id) },
          { key: 'category', label: 'Category', hidden: true },
          { key: 'raised_by', label: 'Raised by', hidden: true, value: (r) => L?.person(r.raised_by) },
          { key: 'created_at', label: 'Raised', hidden: true, value: (r) => r.created_at, render: (r) => date(r.created_at) },
        ]} />
      {current && L && !editing && <SnagDrawer snag={current} L={L} onClose={() => setPeek(null)} onEdit={() => setEditing(current)} />}
      {editing && <SnagForm snag={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); setPeek(id); }} />}
    </>
  );
}

const ACTION_LABEL: Record<SnagAction, string> = { start: 'Start work', ready: 'Mark fixed — ready for review', close: 'Verify & close', reopen: 'Reopen…', cancel: 'Cancel snag…' };

function SnagDrawer({ snag, L, onClose, onEdit }: { snag: Snag; L: Lookups; onClose: () => void; onEdit: () => void }) {
  const auth = useAuth();
  const ev = useAsync(async () => check(await supabase.from('snag_events').select('*').eq('snag_id', snag.id).order('created_at', { ascending: false })) as SnagEvent[],
    [snag.id, snag.status], { key: 'snag-events' });
  const [dialog, setDialog] = useState<'reopen' | 'cancel' | null>(null);
  const { busy, error, run } = useBusy();
  const role = auth.profile?.role;
  const reviewer = canField(role, 'snag.review');
  const worker = reviewer || role === 'site_engineer' || snag.assignee_user_id === auth.profile?.id;
  const act = (action: SnagAction, comment?: string) => rpcx('snag_action', { snag_id: snag.id, action, comment })
    .then(() => { toast.success(`${snag.number}: ${humanize(action === 'ready' ? 'ready for review' : action === 'close' ? 'closed' : action === 'start' ? 'in progress' : action === 'reopen' ? 'reopened' : 'cancelled')}`); });
  const can: Record<SnagAction, boolean> = {
    start: worker && ['open', 'reopened'].includes(snag.status),
    ready: worker && ['open', 'in_progress', 'reopened'].includes(snag.status),
    close: reviewer && snag.status === 'ready_for_review',
    reopen: reviewer && ['ready_for_review', 'closed'].includes(snag.status),
    cancel: reviewer && ['open', 'in_progress', 'reopened'].includes(snag.status),
  };
  const primary: SnagAction | null = can.close ? 'close' : can.ready ? 'ready' : null;
  const due = OPEN.includes(snag.status) ? dueIn(snag.due_date) : null;
  const srcLink = snag.source_id && SOURCE_LINK[snag.source_type]?.(snag.source_id);
  return (
    <Drawer size="lg" title={<>{snag.number} <SBadge value={snag.status} /> <SBadge value={snag.severity} /></>} subtitle={snag.title} onClose={onClose}
      footer={<>
        {canField(role, 'snag.create') && !['closed', 'cancelled'].includes(snag.status) && <button onClick={onEdit}><Pencil size={14} aria-hidden />Edit</button>}
        {can.cancel && <button disabled={busy} onClick={() => setDialog('cancel')}>{ACTION_LABEL.cancel}</button>}
        {can.reopen && <button disabled={busy} onClick={() => setDialog('reopen')}>{ACTION_LABEL.reopen}</button>}
        {can.start && <button disabled={busy} onClick={() => void run(() => act('start'))}>{ACTION_LABEL.start}</button>}
        <span className="spacer" />
        {primary && <button className="primary" disabled={busy} onClick={() => void run(() => act(primary))}>{busy && <span className="spinner" />}{ACTION_LABEL[primary]}</button>}
      </>}>
      <ErrorBanner error={error} />
      <dl className="kv">
        <dt>Element</dt><dd>{L.element(snag.element_id) || '—'}</dd>
        <dt>Location</dt><dd>{[L.block(snag.block_id) && `Block ${L.block(snag.block_id)}`, L.level(snag.level_id) && `Level ${L.level(snag.level_id)}`, snag.location_text].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>Category / trade</dt><dd>{[snag.category, snag.trade].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>Assignee</dt><dd>{L.person(snag.assignee_user_id) || snag.assignee_party || <span className="muted">Unassigned</span>}</dd>
        <dt>Due</dt><dd>{snag.due_date ? <>{date(snag.due_date)}{due?.text && <span className={due.late ? 'danger-text' : 'muted'}> · {due.text}</span>}</> : '—'}</dd>
        <dt>Source</dt><dd>{humanize(snag.source_type)}{srcLink && <> · <Link to={srcLink}>open source</Link></>}</dd>
        <dt>Raised</dt><dd>{L.person(snag.raised_by)} · {dateTime(snag.created_at)}</dd>
        {snag.closed_at && <><dt>Closed</dt><dd>{L.person(snag.closed_by)} · {dateTime(snag.closed_at)}</dd></>}
      </dl>
      {snag.description && <p style={{ whiteSpace: 'pre-wrap' }}>{snag.description}</p>}
      <h3>Photos</h3>
      <Attachments entityType="snag" entityId={snag.id} canAdd={canField(role, 'snag.create') || reviewer} tags={['before', 'after']} groupByTag addLabel="Add before / after photos" />
      <h3 className="mt-2">History</h3>
      <ErrorBanner error={ev.error} onRetry={ev.reload} />
      {!ev.data ? <Loading lines={3} /> : !ev.data.length ? <Empty inline>No events.</Empty> : (
        <ul className="timeline">
          {ev.data.map((e) => (
            <li key={e.id}>
              <div><strong>{humanize(e.action)}</strong>{e.to_status && e.to_status !== e.from_status && <> → <SBadge value={e.to_status} /></>}</div>
              <div className="t-meta">{L.person(e.actor) || 'system'} · <span title={dateTime(e.created_at)}>{since(e.created_at)}</span></div>
              {e.comment && <div className="t-comment">{e.comment}</div>}
            </li>
          ))}
        </ul>
      )}
      {dialog && <ReasonModal title={dialog === 'reopen' ? `Reopen ${snag.number}` : `Cancel ${snag.number}`} label={dialog === 'reopen' ? 'Why is it not fixed?' : 'Reason'}
        danger={dialog === 'cancel'} confirm={dialog === 'reopen' ? 'Reopen snag' : 'Cancel snag'} onClose={() => setDialog(null)} onSubmit={(c) => act(dialog, c)} />}
    </Drawer>
  );
}

function SnagForm({ snag, onClose, onSaved }: { snag: Snag | null; onClose: () => void; onSaved: (id: string) => void }) {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const L = lk.data;
  const [form, setForm] = useState({
    title: snag?.title ?? '', severity: snag?.severity ?? 'medium', element_id: snag?.element_id ?? '', block_id: snag?.block_id ?? '',
    location_text: snag?.location_text ?? '', category: snag?.category ?? '', trade: snag?.trade ?? '', description: snag?.description ?? '',
    assignee_user_id: snag?.assignee_user_id ?? '', assignee_party: snag?.assignee_party ?? '', due_date: snag?.due_date ?? '',
  });
  const set = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v });
  const { busy, error, run } = useBusy();
  const save = () => run(async () => {
    if (!form.title.trim()) throw new Error('Title is required.');
    const id = snag?.id ?? uuid();
    const number = snag ? snag.number : await nextNumber(auth.project?.code ?? 'PRJ', 'SNG', 'snags');
    await rpcx('save_snag', {
      id, project_id: projectId, number, title: form.title.trim(), severity: form.severity as SnagSeverity,
      element_id: optStr(form.element_id), block_id: optStr(form.block_id), location_text: optStr(form.location_text), category: optStr(form.category),
      trade: optStr(form.trade), description: optStr(form.description), assignee_user_id: optStr(form.assignee_user_id),
      assignee_party: optStr(form.assignee_party), due_date: optStr(form.due_date), ...(snag ? {} : { source_type: 'walk' as const }),
    });
    toast.success(snag ? `${number} saved` : `${number} raised`);
    onSaved(id);
  });
  return (
    <Drawer title={snag ? `Edit ${snag.number}` : 'New snag'} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}{snag ? 'Save' : 'Raise snag'}</button>
    </>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Title" required wide><input data-autofocus value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Honeycombing at column base" /></Field>
        <Field label="Severity" required>
          <select value={form.severity} onChange={(e) => set('severity', e.target.value)}>{SEVERITIES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
        </Field>
        <Field label="Due date"><input type="date" value={form.due_date} onChange={(e) => set('due_date', e.target.value)} /></Field>
        <Field label="Element">
          <select value={form.element_id} onChange={(e) => set('element_id', e.target.value)}>
            <option value="">—</option>
            {(L?.elements ?? []).map((e) => <option key={e.id} value={e.id}>{L!.element(e.id)}</option>)}
          </select>
        </Field>
        <Field label="Block" hint="Taken from the element when set">
          <select value={form.block_id} onChange={(e) => set('block_id', e.target.value)} disabled={!!form.element_id}>
            <option value="">—</option>
            {(L?.blocks ?? []).map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}
          </select>
        </Field>
        <Field label="Location"><input value={form.location_text} onChange={(e) => set('location_text', e.target.value)} placeholder="Grid B/3, north face" /></Field>
        <Field label="Category"><input value={form.category} list="snag-cats" onChange={(e) => set('category', e.target.value)} /></Field>
        <datalist id="snag-cats">{['Concrete honeycomb', 'Rebar cover', 'Alignment', 'Finishing', 'Safety', 'Waterproofing'].map((c) => <option key={c} value={c} />)}</datalist>
        <Field label="Trade"><input value={form.trade} onChange={(e) => set('trade', e.target.value)} placeholder="concrete, masonry…" /></Field>
        <Field label="Assignee (user)">
          <select value={form.assignee_user_id} onChange={(e) => set('assignee_user_id', e.target.value)}>
            <option value="">—</option>
            {(L?.profiles ?? []).filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
          </select>
        </Field>
        <Field label="Or subcontractor"><input value={form.assignee_party} onChange={(e) => set('assignee_party', e.target.value)} /></Field>
        <Field label="Description" wide><textarea rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} /></Field>
      </div>
    </Drawer>
  );
}
