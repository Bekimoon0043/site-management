// Look-ahead item drawer: readiness constraints (clear / waive / due / owner / add), assignee,
// weekly commitments, material needs for the item.
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { date, num, qty } from '../../lib/format';
import { canCommitWeek, CONSTRAINT_LABELS, type ConstraintStatus, type ConstraintType, type LookaheadConstraint, type LookaheadMaterialNeed, type LookaheadPlan } from '../../lib/contract-lookahead';
import { Badge } from '../Badge';
import { DataTable } from '../DataTable';
import { Drawer, Modal, ReasonModal } from '../Dialog';
import { Banner, ErrorBanner, Loading } from '../Page';
import { Field, useBusy } from '../Form';
import { toast } from '../toast';
import { eatToday, isAm, planRpc, tr } from '../evm/data';
import { ConstraintStatusBadge, NeedBadge, ReadyBadge } from './chips';
import { DailyOutputForm } from '../schedule/DailyOutputForm';
import { Attachments } from '../Attachments';
import { can, ctypeLabel, roleLabel, type LaItem, type LaWeek } from './la';

const MANUAL_TYPES: ConstraintType[] = ['information', 'labour', 'equipment', 'space', 'external', 'approval', 'inspection', 'material', 'predecessor'];
const OPEN: ConstraintStatus[] = ['open', 'in_progress', 'blocked'];

export function ItemDrawer({ item, plan, weeks, L, onClose }: { item: LaItem; plan: LookaheadPlan | null; weeks: LaWeek[]; L: Lookups; onClose: () => void }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const today = eatToday();
  const [adding, setAdding] = useState(false);
  const [act, setAct] = useState<{ c: LookaheadConstraint; status: ConstraintStatus } | null>(null);
  const [commitFor, setCommitFor] = useState<LaWeek | null>(null);
  const { busy, error, run } = useBusy();
  const q = useAsync(async () => {
    if (item.preview) return { cons: [] as LookaheadConstraint[], needs: [] as LookaheadMaterialNeed[] };
    const [cons, needs] = await Promise.all([
      supabase.from('lookahead_constraints').select('*').eq('item_id', item.id).order('status').order('due_date', { nullsFirst: false }).then(check) as Promise<LookaheadConstraint[]>,
      supabase.from('v_lookahead_material_needs').select('*').eq('plan_id', item.plan_id!).eq('item_id', item.id).order('need_by').then(check) as Promise<LookaheadMaterialNeed[]>,
    ]);
    return { cons, needs };
  }, [item.id, item.preview], { key: 'la-item' });
  const editable = !!plan && plan.status !== 'closed' && !item.preview;
  const canCons = editable && can(role, 'lookahead.constraint');
  const members = L.profiles.filter((p) => p.is_active);

  const assign = (responsible_id: string) => run(async () => {
    await planRpc('assign_lookahead_item', { item_id: item.id, responsible_id: responsible_id || null });
    toast.success(responsible_id ? `Assigned to ${L.person(responsible_id)}` : 'Unassigned');
  });
  const patch = (c: LookaheadConstraint, p: { due_date?: string; owner_id?: string | null }) => run(async () => {
    await planRpc('update_constraint', { id: c.id, ...p });
    toast.success('Constraint updated');
  });
  const requestStore = () => run(async () => {
    const r = await planRpc('create_sur_from_lookahead', { item_id: item.id, submit: true });
    toast.success(`Site-use request ${String(r.number ?? '')} created from stock`);
  });

  const cons = q.data?.cons ?? [];
  const openCons = cons.filter((c) => OPEN.includes(c.status));
  const doneCons = cons.filter((c) => !OPEN.includes(c.status));
  const itemWeeks = weeks.filter((w) => w.id && (item.week_days[w.week_start] ?? 0) > 0);

  return (
    <Drawer title={item.name} size="lg" onClose={onClose}
      subtitle={<span className="row">
        <Badge tone="primary" label={roleLabel(item.window_role)} icon={null} outline />
        <ReadyBadge item={item} />
        {item.is_critical && <Badge tone="danger" value="critical" label={tr('Critical', 'ወሳኝ')} />}
        {item.is_milestone && <Badge tone="violet" label={tr('Milestone', 'ምዕራፍ')} icon={null} />}
      </span>}>
      <ErrorBanner error={error ?? q.error} onRetry={q.reload} />
      {item.preview && <Banner tone="info">Preview only. Generate the look-ahead to check constraints, materials and take commitments.</Banner>}
      <dl className="kv">
        <dt>{tr('Dates', 'ቀናት')}</dt><dd>{date(item.start)} → {date(item.finish)}{item.total_float_days != null ? ` · ${tr('float', 'ተጨማሪ ጊዜ')} ${num(item.total_float_days, 1)} d` : ''}</dd>
        <dt>{tr('Progress', 'ሂደት')}</dt><dd>{num(item.pct, 0)} %{item.target_pct != null ? ` · ${tr('target at month end', 'በወሩ መጨረሻ ዒላማ')} ${num(item.target_pct, 0)} %` : ''}</dd>
        {item.wbs && <><dt>WBS</dt><dd>{item.wbs}{item.group_name ? ` · ${item.group_name}` : ''}</dd></>}
        {item.element_code && <><dt>{tr('Element', 'መዋቅር')}</dt><dd>{item.element_code}</dd></>}
        <dt>{tr('Responsible', 'ኃላፊ')}</dt>
        <dd>{editable && can(role, 'lookahead.assign') ? (
          <select value={item.responsible_id ?? ''} disabled={busy} onChange={(e) => void assign(e.target.value)} aria-label="Responsible">
            <option value="">— {tr('nobody', 'ማንም')} —</option>
            {members.filter((p) => ['site_engineer', 'office_engineer', 'coordinator'].includes(p.role)).map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
          </select>
        ) : item.responsible_name ?? L.person(item.responsible_id) ?? '—'}</dd>
      </dl>

      {item.schedule_task_id && (
        <section className="mt-4" aria-label="Daily output">
          <DailyOutputForm taskId={item.schedule_task_id} title={tr('Record today’s output', 'የዛሬን ሥራ መዝግብ')} />
        </section>
      )}

      {!item.preview && (
        <section className="stack tight mt-4" aria-label="Readiness">
          <div className="row"><h3 className="mb-0 grow">{tr('Readiness', 'ዝግጁነት')} · {openCons.length} {tr('open', 'ክፍት')}</h3>
            {canCons && <button className="small" onClick={() => setAdding(true)}><Plus size={12} aria-hidden />{tr('Add constraint', 'እንቅፋት ጨምር')}</button>}</div>
          {!q.data ? <Loading lines={3} /> : !cons.length ? <p className="muted mb-0">{tr('No constraints — the task is ready.', 'እንቅፋት የለም — ሥራው ዝግጁ ነው።')}</p> : (
            <DataTable rows={[...openCons, ...doneCons]} rowKey={(c) => c.id} maxHeight="none" columns={[
              { key: 'ctype', label: tr('Type', 'ዓይነት'), render: (c) => <>{ctypeLabel(c.ctype)}{c.auto && <div className="xs-text muted">{c.advisory ? 'advisory' : 'automatic'}</div>}</> },
              { key: 'description', label: tr('What is needed', 'የሚያስፈልገው'), render: (c) => <>{c.description}{c.qty_short ? <span className="muted"> · short {num(c.qty_short)}</span> : null}</> },
              { key: 'owner_id', label: tr('Owner', 'ኃላፊ'), render: (c) => (canCons && OPEN.includes(c.status) ? (
                <select value={c.owner_id ?? ''} disabled={busy} onChange={(e) => void patch(c, { owner_id: e.target.value || null })} aria-label="Owner">
                  <option value="">{c.owner_role ? `(${c.owner_role.replace('_', ' ')})` : '—'}</option>
                  {members.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
                </select>) : L.person(c.owner_id) || (c.owner_role ?? '')) },
              { key: 'due_date', label: tr('Due', 'ቀን'), render: (c) => (canCons && OPEN.includes(c.status)
                ? <input type="date" value={c.due_date ?? ''} disabled={busy} onChange={(e) => e.target.value && void patch(c, { due_date: e.target.value })} aria-label="Due date" className={c.due_date && c.due_date < today ? 'danger-text' : ''} />
                : date(c.due_date)) },
              { key: 'status', label: tr('Status', 'ሁኔታ'), render: (c) => <ConstraintStatusBadge status={c.status} /> },
              { key: 'act', label: '', sortable: false, noExport: true, render: (c) => canCons && (
                <span className="row nowrap">
                  {OPEN.includes(c.status) ? <>
                    <button className="small" onClick={() => setAct({ c, status: 'cleared' })}>{tr('Clear', 'ፍታ')}</button>
                    {!c.auto && <button className="small ghost" onClick={() => setAct({ c, status: 'waived' })}>{tr('Waive', 'እለፍ')}</button>}
                    {c.status !== 'blocked' && <button className="small ghost" onClick={() => setAct({ c, status: 'blocked' })}>{tr('Blocked', 'ታግዷል')}</button>}
                  </> : <button className="small ghost" onClick={() => setAct({ c, status: 'open' })}>{tr('Reopen', 'ክፈት')}</button>}
                </span>
              ) },
            ]} />
          )}
        </section>
      )}

      {!item.preview && (
        <section className="stack tight mt-4" aria-label="Commitments">
          <h3 className="mb-0">{tr('Weekly commitments', 'ሳምንታዊ ቃል')}</h3>
          {!itemWeeks.length && !item.commitments.length ? <p className="muted mb-0">{tr('The task has no working days in this window.', 'በዚህ ጊዜ የሥራ ቀን የለውም።')}</p> : (
            <ul className="summary-list">
              {weeks.filter((w) => w.id && ((item.week_days[w.week_start] ?? 0) > 0 || item.commitments.some((c) => c.week_id === w.id))).map((w) => {
                const cs = item.commitments.filter((c) => c.week_id === w.id);
                const commit = cs.find((c) => c.kind === 'commitment');
                const cand = cs.find((c) => c.kind === 'candidate');
                const open = !!role && plan?.status === 'published' && can(role, 'lookahead.commit') && canCommitWeek({ status: w.status as 'open', week_start: w.week_start }, today, role);
                return (
                  <li key={w.id!}>
                    <span className="no strong">W{w.week_no}</span>
                    <span className="muted">{date(w.week_start)} · {item.week_days[w.week_start] ?? 0} d</span>
                    <span className="grow">
                      {commit ? <><Badge value={commit.outcome === 'completed' ? 'completed' : commit.outcome === 'not_completed' ? 'rejected' : 'pending'}
                        label={commit.outcome === 'completed' ? tr('Done', 'ተጠናቋል') : commit.outcome === 'not_completed' ? tr('Not done', 'አልተጠናቀቀም') : tr('Committed', 'ቃል ተገብቷል')} />
                        {' '}{commit.description !== item.name ? commit.description : ''}{commit.target_pct != null ? ` → ${num(commit.target_pct, 0)} %` : ''}</>
                        : cand ? <Badge tone="warning" label={tr('Rolled forward — confirm', 'የተሸጋገረ — ያረጋግጡ')} icon={null} /> : <span className="muted">—</span>}
                    </span>
                    {!commit && open && <button className="small" onClick={() => setCommitFor(w)}>{cand ? tr('Confirm', 'አረጋግጥ') : tr('Commit', 'ቃል ግባ')}</button>}
                  </li>
                );
              })}
            </ul>
          )}
          {plan?.status === 'draft' && <p className="muted small-text mb-0">Commitments open once the look-ahead is published.</p>}
        </section>
      )}

      {!item.preview && (
        <section className="stack tight mt-4" aria-label="Material needs">
          <div className="row"><h3 className="mb-0 grow">{tr('Materials for this task', 'ለዚህ ሥራ የሚያስፈልግ ግብዓት')}</h3>
            {editable && can(role, 'lookahead.raise_sur') && (q.data?.needs ?? []).some((n) => n.suggest_sur || Number(n.from_stock) > 0) &&
              <button className="small" disabled={busy} onClick={() => void requestStore()}>{tr('Request from store', 'ከመጋዘን ጠይቅ')}</button>}</div>
          <DataTable rows={q.data?.needs ?? []} loading={!q.data} rowKey={(n) => n.material_spec_id} maxHeight="none"
            empty={tr('No take-off quantities linked to this task.', 'ከዚህ ሥራ ጋር የተያያዘ መጠን የለም።')} columns={[
              { key: 'label', label: tr('Material', 'ግብዓት') },
              { key: 'window_need', label: tr('Need', 'ፍላጎት'), align: 'right', render: (n) => `${qty(n.window_need, n.uom)} ${n.uom}` },
              { key: 'need_by', label: tr('Need by', 'የሚያስፈልግበት'), render: (n) => date(n.need_by) },
              { key: 'order_by', label: tr('Order by', 'የሚታዘዝበት'), render: (n) => <span className={n.order_by < today && Number(n.to_order) > 0 ? 'danger-text' : ''}>{date(n.order_by)}</span> },
              { key: 'from_stock', label: tr('From stock', 'ከመጋዘን'), align: 'right', render: (n) => qty(n.from_stock, n.uom) },
              { key: 'from_po', label: tr('On order', 'የታዘዘ'), align: 'right', render: (n) => <>{qty(Number(n.from_po) + Number(n.from_po_late), n.uom)}{n.po_numbers.length ? <div className="xs-text muted">{n.po_numbers.join(', ')}</div> : null}</> },
              { key: 'to_order', label: tr('To order', 'የሚታዘዝ'), align: 'right', render: (n) => (Number(n.to_order) > 0 ? <strong>{qty(n.to_order, n.uom)}</strong> : '0') },
              { key: 'need_status', label: tr('Status', 'ሁኔታ'), render: (n) => <NeedBadge status={n.need_status} /> },
            ]} />
        </section>
      )}

      {adding && <AddConstraintModal item={item} members={members} onClose={() => setAdding(false)} />}
      {act && (
        <ReasonModal title={`${act.status === 'cleared' ? 'Clear' : act.status === 'waived' ? 'Waive' : act.status === 'blocked' ? 'Mark blocked' : 'Reopen'}: ${ctypeLabel(act.c.ctype)}`}
          label={tr('Comment', 'አስተያየት')} required={act.status === 'waived' || (act.status === 'cleared' && act.c.auto && act.c.ctype === 'material')}
          confirm={act.status === 'cleared' ? tr('Clear', 'ፍታ') : act.status === 'waived' ? tr('Waive', 'እለፍ') : tr('Save', 'አስቀምጥ')} danger={act.status === 'waived'}
          onClose={() => setAct(null)}
          onSubmit={async (comment) => {
            const r = await planRpc('update_constraint', { id: act.c.id, status: act.status, comment: comment || undefined });
            toast.success(`Constraint ${act.status === 'cleared' ? 'cleared' : act.status} · task is ${String(r.readiness ?? '').replace('_', ' ')}`);
          }}>
          <p className="muted small-text mb-0">{act.c.description}{act.status === 'waived' ? ' — waiving accepts the risk and needs a reason.' : act.c.auto && act.c.ctype === 'material' && act.status === 'cleared' ? ' — say how it was confirmed (e.g. delivery confirmed by phone).' : ''}</p>
        </ReasonModal>
      )}
      <h3 className="mt-3">Photos &amp; documents</h3>
      <Attachments entityType="lookahead_item" entityId={item.id} canAdd={!!role && role !== 'store_keeper' && role !== 'security'}
        kinds={['photo', 'drawing', 'document']} tags={['progress', 'issue', 'other']} emptyText="No photos yet — e.g. a blocked access, missing drawing or readiness check." />
      {commitFor && <CommitModal item={item} week={commitFor} candidateId={item.commitments.find((c) => c.week_id === commitFor.id && c.kind === 'candidate')?.id} onClose={() => setCommitFor(null)} />}
    </Drawer>
  );
}

function AddConstraintModal({ item, members, onClose }: { item: LaItem; members: { id: string; full_name: string; email: string | null }[]; onClose: () => void }) {
  const [f, setF] = useState({ ctype: 'information' as ConstraintType, description: '', owner_id: '', due_date: '' });
  const { busy, error, run } = useBusy();
  const save = () => run(async () => {
    await planRpc('update_constraint', { id: crypto.randomUUID(), item_id: item.id, ctype: f.ctype, description: f.description.trim(), owner_id: f.owner_id || undefined, due_date: f.due_date || undefined });
    toast.success('Constraint added');
    onClose();
  });
  return (
    <Modal title={tr('Add constraint', 'እንቅፋት ጨምር')} subtitle={item.name} onClose={onClose} size="md" footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !f.description.trim()} onClick={() => void save()}>{busy && <span className="spinner" />}Add</button>
    </>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Type" required><select value={f.ctype} onChange={(e) => setF({ ...f, ctype: e.target.value as ConstraintType })}>
          {MANUAL_TYPES.map((t) => <option key={t} value={t}>{isAm() ? CONSTRAINT_LABELS[t].am : CONSTRAINT_LABELS[t].en}</option>)}
        </select></Field>
        <Field label="Owner"><select value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })}>
          <option value="">—</option>{members.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
        </select></Field>
        <Field label="Due date" hint="Default: 2 working days before the task starts"><input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
        <Field label="What is needed" required wide><input value={f.description} data-autofocus onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Revised slab drawing rev C from consultant" /></Field>
      </div>
    </Modal>
  );
}

export function CommitModal({ item, week, candidateId, onClose }: { item: Pick<LaItem, 'id' | 'name' | 'readiness' | 'worst_description' | 'target_pct'>; week: LaWeek; candidateId?: string; onClose: () => void }) {
  const notReady = item.readiness !== 'ready';
  const [f, setF] = useState({ description: '', target: item.target_pct != null ? String(Math.round(item.target_pct)) : '', reason: '' });
  const { busy, error, run } = useBusy();
  const save = () => run(async () => {
    await planRpc('commit_lookahead_item', { id: candidateId ?? crypto.randomUUID(), item_id: item.id, week_id: week.id ?? undefined, description: f.description.trim() || undefined,
      target_pct: f.target ? Number(f.target) : undefined, override_reason: notReady ? f.reason.trim() : undefined });
    toast.success(`Committed "${item.name}" for week ${week.week_no}`);
    onClose();
  });
  return (
    <Modal title={`${tr('Commit for week', 'ለሳምንት ቃል ግባ')} ${week.week_no}`} subtitle={`${item.name} · ${date(week.week_start)} – ${date(week.week_end)}`} onClose={onClose} size="md" footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || (notReady && !f.reason.trim())} onClick={() => void save()}>{busy && <span className="spinner" />}{tr('We commit to finish this', 'ይህን ለመጨረስ ቃል እንገባለን')}</button>
    </>}>
      <ErrorBanner error={error} />
      {notReady && <Banner tone="warn">This task is not ready{item.worst_description ? `: ${item.worst_description}` : ''}. Only commit work you are sure you can finish — give a reason to commit anyway.</Banner>}
      <div className="form-grid">
        <Field label="What exactly will be finished" wide hint="Blank = the whole task step"><input value={f.description} data-autofocus onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={item.name} /></Field>
        <Field label="Target % at week end"><input type="number" min={0} max={100} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></Field>
        {notReady && <Field label="Reason to commit anyway" required wide><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. plywood arrives Monday, confirmed by supplier" /></Field>}
      </div>
    </Modal>
  );
}
