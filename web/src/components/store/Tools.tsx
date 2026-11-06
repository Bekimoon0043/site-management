// Store tab "Tools": register of returnable tools & small equipment — issue / return with condition check, repair,
// loss, write-off (save_tool, tool_action; 20261105000051). Overdue returns are flagged and sit in the store keeper's inbox.
import { useMemo, useState } from 'react';
import { Plus, Wrench } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { dateTime, humanize, shortDate } from '../../lib/format';
import { useUrlParam } from '../../lib/url';
import {
  TOOL_CATEGORY_LABELS, TOOL_ROLES, TOOL_STATUS_LABELS, type ToolActionName, type ToolCategory, type ToolCondition, type ToolRow, type ToolStatus,
} from '../../lib/contract-store';
import { Badge, Banner, DataTable, Drawer, ErrorBanner, Field, FilterBar, FilterSelect, Kpi, Loading, SearchInput, toast, useBusy, type Tone } from '../ui';
import { loadToolMovements, loadTools, storeRpc } from './data';

const STATUS_TONE: Record<ToolStatus, Tone> = { in_store: 'success', issued: 'info', repair: 'warning', lost: 'danger', disposed: 'neutral' };
const COND_TONE: Record<ToolCondition, Tone> = { good: 'success', fair: 'warning', damaged: 'danger' };
const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

export function ToolsTab({ L, projectId }: { L: Lookups; projectId: string }) {
  const auth = useAuth();
  const role = auth.profile?.role ?? '';
  const canManage = (TOOL_ROLES.manage as readonly string[]).includes(role);
  const q = useAsync(() => loadTools(projectId), [projectId], { key: 'tools' });
  const [term, setTerm] = useState('');
  const [status, setStatus] = useUrlParam('tstatus');
  const [openId, setOpenId] = useUrlParam('tool');
  const [adding, setAdding] = useState(false);
  const rows = q.data ?? [];
  const t = term.trim().toLowerCase();
  const shown = rows.filter((r) => (status === 'overdue' ? r.is_overdue : !status || r.status === status)
    && (!t || r.tag.toLowerCase().includes(t) || r.name.toLowerCase().includes(t) || (r.holder ?? '').toLowerCase().includes(t) || (r.serial_no ?? '').toLowerCase().includes(t)));
  const n = (s: ToolStatus) => rows.filter((r) => r.status === s).length;
  const overdue = rows.filter((r) => r.is_overdue).length;
  const open = rows.find((r) => r.id === openId);

  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="In store" value={n('in_store')} compact />
        <Kpi label="Issued" value={n('issued')} compact />
        <Kpi label="Overdue returns" value={overdue} status={overdue ? 'danger' : 'ok'} compact />
        <Kpi label="Under repair" value={n('repair')} status={n('repair') ? 'warning' : undefined} compact />
        <Kpi label="Lost" value={n('lost')} status={n('lost') ? 'danger' : undefined} compact />
      </div>
      {overdue > 0 && <Banner tone="warn" action={<button className="link-btn" onClick={() => setStatus('overdue')}>Show them</button>}>
        {overdue} tool{overdue === 1 ? ' is' : 's are'} past the agreed return date.</Banner>}
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <DataTable rows={shown} loading={!q.data} rowKey={(r) => r.id} onRowClick={(r) => setOpenId(r.id)} activeKey={openId} exportName="tools-register"
        rowClass={(r) => (r.is_overdue ? 'row-error' : undefined)}
        toolbar={(
          <FilterBar right={canManage ? <button className="primary small" onClick={() => setAdding(true)}><Plus size={14} aria-hidden />Register tool</button> : undefined}>
            <SearchInput value={term} onChange={setTerm} placeholder="Tag, name, holder, serial" />
            <FilterSelect label="Status" value={(status ?? '') as ToolStatus | 'overdue' | ''} onChange={(v) => setStatus(v || null)}
              options={[...(Object.keys(TOOL_STATUS_LABELS) as ToolStatus[]).map((s) => ({ value: s as ToolStatus | 'overdue', label: TOOL_STATUS_LABELS[s] })), { value: 'overdue', label: 'Overdue' }]} />
          </FilterBar>
        )}
        empty={{ title: 'No tools registered', body: 'Register drills, vibrators, levels, harnesses and other returnable items to track who has them.' }}
        columns={[
          { key: 'tag', label: 'Tag', id: true },
          { key: 'name', label: 'Tool', render: (r) => <span className="strong">{r.name}</span> },
          { key: 'category', label: 'Type', value: (r) => TOOL_CATEGORY_LABELS[r.category] },
          { key: 'status', label: 'Status', value: (r) => TOOL_STATUS_LABELS[r.status], render: (r) => <Badge tone={STATUS_TONE[r.status]} label={TOOL_STATUS_LABELS[r.status]} icon={null} /> },
          { key: 'condition', label: 'Condition', value: (r) => r.condition, render: (r) => <Badge tone={COND_TONE[r.condition]} label={humanize(r.condition)} icon={null} outline /> },
          { key: 'holder', label: 'With', value: (r) => r.holder ?? '' },
          { key: 'due_on', label: 'Return by', value: (r) => r.due_on ?? '', render: (r) => (r.due_on ? <span className={r.is_overdue ? 'danger-text strong' : undefined}>{shortDate(r.due_on)}{r.is_overdue ? ` · ${r.days_overdue} d late` : ''}</span> : '') },
          { key: 'store_name', label: 'Store', value: (r) => r.store_name ?? '' },
          { key: 'serial_no', label: 'Serial no.', hidden: true },
        ]} />
      {adding && <ToolForm L={L} projectId={projectId} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); q.reload(); }} />}
      {open && <ToolDrawer key={open.id} tool={open} L={L} projectId={projectId} canManage={canManage} canDispose={(TOOL_ROLES.dispose as readonly string[]).includes(role)}
        onClose={() => setOpenId(null)} onChanged={q.reload} />}
    </div>
  );
}

function ToolForm({ L, projectId, tool, onClose, onSaved }: { L: Lookups; projectId: string; tool?: ToolRow; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ tag: tool?.tag ?? '', name: tool?.name ?? '', category: (tool?.category ?? 'hand_tool') as ToolCategory,
    store_id: tool?.store_id ?? L.stores[0]?.id ?? '', serial_no: tool?.serial_no ?? '', notes: tool?.notes ?? '' });
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    const r = await storeRpc('save_tool', { id: tool?.id ?? crypto.randomUUID(), project_id: projectId, tag: f.tag || undefined, name: f.name,
      category: f.category, store_id: f.store_id || null, serial_no: f.serial_no || undefined, notes: f.notes || undefined });
    toast.success(`${String(r.tag)} ${tool ? 'saved' : 'registered'}`);
    onSaved();
  });
  return (
    <Drawer title={tool ? `Edit ${tool.tag}` : 'Register a tool'} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !f.name.trim()} onClick={save}>{busy && <span className="spinner" />}Save</button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Name" required wide><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Poker vibrator 38 mm" /></Field>
        <Field label="Tag no." hint="Empty = next number (T-0001 …). Paint or label it on the tool."><input value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} /></Field>
        <Field label="Type">
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as ToolCategory })}>
            {(Object.keys(TOOL_CATEGORY_LABELS) as ToolCategory[]).map((c) => <option key={c} value={c}>{TOOL_CATEGORY_LABELS[c]}</option>)}
          </select>
        </Field>
        <Field label="Store">
          <select value={f.store_id} onChange={(e) => setF({ ...f, store_id: e.target.value })}>
            <option value="">—</option>{L.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Serial no."><input value={f.serial_no} onChange={(e) => setF({ ...f, serial_no: e.target.value })} /></Field>
        <Field label="Notes" wide><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Drawer>
  );
}

function ToolDrawer({ tool, L, projectId, canManage, canDispose, onClose, onChanged }: {
  tool: ToolRow; L: Lookups; projectId: string; canManage: boolean; canDispose: boolean; onClose: () => void; onChanged: () => void;
}) {
  const hist = useAsync(() => loadToolMovements(tool.id), [tool.id, tool.updated_at], { key: 'tool-moves' });
  const [mode, setMode] = useState<ToolActionName | 'edit' | null>(null);
  const [holder, setHolder] = useState({ id: '', name: '' });
  const [due, setDue] = useState('');
  const [cond, setCond] = useState<ToolCondition>('good');
  const [note, setNote] = useState('');
  const { busy, error, run } = useBusy();
  const members = useMemo(() => [...L.profiles].sort((a, b) => a.full_name.localeCompare(b.full_name)), [L.profiles]);
  const act = (action: ToolActionName) => void run(async () => {
    await storeRpc('tool_action', { tool_id: tool.id, action, holder_id: holder.id || undefined, holder_name: holder.id ? undefined : holder.name || undefined,
      due_on: due || undefined, condition: ['return', 'repaired', 'found'].includes(action) ? cond : undefined, note: note || undefined });
    toast.success({ issue: 'Issued', return: cond === 'damaged' ? 'Returned — sent for repair' : 'Returned to store', repair: 'Sent for repair', repaired: 'Back in store',
      lost: 'Reported lost', found: 'Back in store', dispose: 'Written off' }[action]);
    setMode(null); setNote('');
    onChanged();
  });
  if (mode === 'edit') return <ToolForm L={L} projectId={projectId} tool={tool} onClose={() => setMode(null)} onSaved={() => { setMode(null); onChanged(); }} />;
  const can = (a: ToolActionName) => canManage && ({
    issue: tool.status === 'in_store' && tool.condition !== 'damaged', return: tool.status === 'issued', repair: tool.status === 'in_store',
    repaired: tool.status === 'repair', lost: tool.status === 'issued' || tool.status === 'in_store', found: tool.status === 'lost',
    dispose: canDispose && ['in_store', 'repair', 'lost'].includes(tool.status),
  } as Record<ToolActionName, boolean>)[a];
  const LABEL: Record<ToolActionName, string> = { issue: 'Issue…', return: 'Return…', repair: 'Send for repair', repaired: 'Repaired…', lost: 'Report lost…', found: 'Found…', dispose: 'Write off…' };

  return (
    <Drawer title={`${tool.tag} · ${tool.name}`} subtitle={<><Badge tone={STATUS_TONE[tool.status]} label={TOOL_STATUS_LABELS[tool.status]} icon={null} /> {TOOL_CATEGORY_LABELS[tool.category]}</>} onClose={onClose}>
      <ErrorBanner error={error} />
      <dl className="kv">
        <dt>Condition</dt><dd>{humanize(tool.condition)}</dd>
        <dt>With</dt><dd>{tool.holder ?? '—'}{tool.issued_at ? ` · since ${dateTime(tool.issued_at)}` : ''}</dd>
        <dt>Return by</dt><dd className={tool.is_overdue ? 'danger-text strong' : undefined}>{tool.due_on ? `${shortDate(tool.due_on)}${tool.is_overdue ? ` · ${tool.days_overdue} days late` : ''}` : '—'}</dd>
        <dt>Store</dt><dd>{tool.store_name ?? '—'}</dd>
        <dt>Serial no.</dt><dd>{tool.serial_no ?? '—'}</dd>
        {tool.notes && <><dt>Notes</dt><dd>{tool.notes}</dd></>}
      </dl>
      {canManage && !mode && (
        <div className="row mt-3" style={{ flexWrap: 'wrap' }}>
          {(['issue', 'return', 'repair', 'repaired', 'lost', 'found', 'dispose'] as ToolActionName[]).filter(can).map((a) => (
            <button key={a} className={a === 'issue' || a === 'return' ? 'primary' : a === 'lost' || a === 'dispose' ? 'danger' : undefined} disabled={busy}
              onClick={() => (a === 'repair' ? act('repair') : setMode(a))}>{LABEL[a]}</button>
          ))}
          <button disabled={busy} onClick={() => setMode('edit')}><Wrench size={14} aria-hidden />Edit details</button>
        </div>
      )}
      {mode && (
        <div className="card mt-3 stack" style={{ padding: 'var(--sp-3)' }}>
          {mode === 'issue' && <>
            <Field label="Issue to (staff)">
              <select value={holder.id} onChange={(e) => setHolder({ id: e.target.value, name: '' })}>
                <option value="">— a crew / worker (type below) —</option>
                {members.map((p) => <option key={p.id} value={p.id}>{p.full_name} · {humanize(p.role)}</option>)}
              </select>
            </Field>
            {!holder.id && <Field label="Crew / worker name" required><input value={holder.name} onChange={(e) => setHolder({ id: '', name: e.target.value })} placeholder="e.g. Concrete gang (Abebe)" /></Field>}
            <Field label="Return by"><input type="date" min={today()} value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          </>}
          {['return', 'repaired', 'found'].includes(mode) && (
            <Field label="Condition now" required>
              <select value={cond} onChange={(e) => setCond(e.target.value as ToolCondition)}>
                <option value="good">Good</option><option value="fair">Fair (usable, worn)</option>{mode === 'return' && <option value="damaged">Damaged → repair</option>}
              </select>
            </Field>
          )}
          <Field label={mode === 'lost' ? 'How was it lost?' : mode === 'dispose' ? 'Reason for write-off' : cond === 'damaged' && mode === 'return' ? 'Describe the damage' : 'Note'}
            required={mode === 'lost' || mode === 'dispose' || (mode === 'return' && cond === 'damaged')}>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="row">
            <button className="primary" disabled={busy || (mode === 'issue' && !holder.id && !holder.name.trim())} onClick={() => act(mode)}>{busy && <span className="spinner" />}Confirm</button>
            <button onClick={() => setMode(null)}>Cancel</button>
          </div>
        </div>
      )}
      <h3 className="mt-4">History</h3>
      {!hist.data ? <Loading lines={3} /> : !hist.data.length ? <p className="muted">No movements yet.</p> : (
        <ul className="timeline">
          {hist.data.map((m) => (
            <li key={m.id}>
              <span className="strong">{humanize(m.action)}</span>
              {m.holder_id || m.holder_name ? ` · ${m.holder_id ? L.person(m.holder_id) : m.holder_name}` : ''}
              {m.condition ? ` · ${m.condition}` : ''}{m.due_on ? ` · due ${shortDate(m.due_on)}` : ''}
              {m.note ? <> · <span className="muted">{m.note}</span></> : null}
              <div className="small-text muted">{dateTime(m.created_at)} · {L.person(m.created_by)}</div>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
