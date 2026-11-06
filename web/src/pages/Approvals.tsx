import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, Flame } from 'lucide-react';
import { useAuth, useProjectId } from '../lib/auth';
import { useAsync, useLookups, type Lookups } from '../lib/hooks';
import { rpc } from '../lib/supabase';
import { FLOW_QUEUE_KINDS, PLAN_QUEUE_KINDS, loadQueue, mrStatusesFor, queueTypesFor, QUEUE_LABEL, type FlowQueueRow, type AdjQueueRow, type CountQueueRow, type EmergencyQueueRow, type DiaryQueueRow, type GatePassQueueRow, type MrQueueRow, type PoQueueRow, type ProgressQueueRow, type QueueType, type PlanQueueKind } from '../lib/approvals';
import { procRpc } from '../lib/procurement';
import { PoPreview } from '../components/procurement/PoPreview';
import { GatePassPreview } from '../components/control/GatePassPreview';
import { DiaryPreview } from '../components/field/DiaryPreview';
import { rpcx } from '../lib/fieldx';
import { hoursSince, humanize, num } from '../lib/format';
import { useUrlFilters } from '../lib/url';
import { AdjustmentPreview, CountPreview, EmergencyPreview, MrPreview, ProgressPreview, type PreviewActions } from '../components/approval/Previews';
import { Badge, Empty, ErrorBanner, Loading, Page, PriorityBadge, Tabs, confirm, toast } from '../components/ui';
import { DeliveryPreview, IssuePreview, PrPreview } from '../components/flows/FlowPreviews';
import { flowRpc } from '../lib/flows';
import { PURCHASE_STATUS_LABELS, type PurchaseStatus } from '../lib/contract-flows';
import type { BaselineQueueRow, TaskProgressQueueRow } from '../lib/approvals';
import { BaselinePreview, TaskProgressPreview, taskProgressClean, withPrevPct } from '../components/schedule/ApprovalPreviews';
import { schedRpc } from '../components/schedule/data';
import type { PlanQueueRow } from '../lib/approvals';
import { ConstraintPreview, PeriodClosePreview, WeekClosePreview } from '../components/lookahead/ApprovalPreviews';
import { RfqAwardPreview } from '../components/procurement/RfqAwardPreview';
import { PaymentPreview } from '../components/payments/PaymentPreview';
import { PoReceivePreview, PoSendPreview } from '../components/procurement/PoFlowPreviews';
import { ClientIpcPreview, VariationPreview } from '../components/billing/BillingPreviews';
import { StockExpiryPreview, ToolOverduePreview } from '../components/store/StorePreviews';
import { HolidayPreview } from '../components/calendar/HolidayPreview';
import { SiteOpsPreview } from '../components/site/SiteOpsPreview';
import { FinanceDocPreview } from '../components/approval/FinanceDocPreview';
import { OfficePreview } from '../components/approval/OfficePreview';

const FLOW_KIND_LABEL: Record<FlowQueueRow['kind'], string> = {
  pr_review: 'Coordinator review', pr_approve: 'Management approval', pr_accept: 'Procurement: accept & buy', sur_issue: 'Store order to issue', delivery_ack: 'Delivery to accept',
};

type Raw = FlowQueueRow | MrQueueRow | AdjQueueRow | CountQueueRow | ProgressQueueRow | EmergencyQueueRow | PoQueueRow | GatePassQueueRow | DiaryQueueRow | TaskProgressQueueRow | BaselineQueueRow | PlanQueueRow;
interface Item { type: QueueType; id: string; title: string; sub: string; at: string; critical: boolean; priority?: string; raw: Raw; bulkOk: boolean }
const isPlanQueueType = (t: QueueType): t is PlanQueueKind => (PLAN_QUEUE_KINDS as readonly QueueType[]).includes(t);

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

function toItems(type: QueueType, input: Raw[], L: Lookups): Item[] {
  const rows: Raw[] = type === 'task_progress' ? withPrevPct(input as TaskProgressQueueRow[]) : input;
  return rows.map((raw): Item => {
    switch (type) {
      case 'pr': case 'issue': case 'delivery': {
        const r = raw as FlowQueueRow;
        return { type, id: r.entity_id, title: r.kind === 'delivery_ack' ? `PO ${r.number}` : r.number, at: r.requested_at ?? new Date().toISOString(), critical: r.is_urgent, raw,
          bulkOk: r.kind === 'delivery_ack' || r.kind === 'pr_accept',
          sub: `${FLOW_KIND_LABEL[r.kind]} · ${r.kind === 'delivery_ack' ? r.title.replace(/^Confirm delivery of PO \S+ /, '') : r.kind === 'sur_issue' ? `to ${L.person(r.requested_by)}` : `${PURCHASE_STATUS_LABELS[r.status as PurchaseStatus] ?? humanize(r.status)} · ${L.person(r.requested_by)}`}` };
      }
      case 'mr': {
        const r = raw as MrQueueRow;
        const lines = r.mr_lines.filter((l) => !l.deleted_at);
        const first = lines[0];
        return { type, id: r.id, title: r.number, at: r.submitted_at ?? r.created_at, critical: r.priority === 'critical', priority: r.priority, raw,
          sub: `${first ? L.spec(first.material_spec_id) : 'No lines'}${lines.length > 1 ? ` +${lines.length - 1} line${lines.length > 2 ? 's' : ''}` : ''} · Blk ${L.block(r.block_id) || '—'} · ${humanize(r.status)}`,
          bulkOk: !lines.some((l) => l.exceeds_boq) };
      }
      case 'adjustment': {
        const r = raw as AdjQueueRow;
        return { type, id: r.id, title: r.number, at: r.created_at, critical: false, raw, bulkOk: true,
          sub: `${humanize(r.adj_type)} · ${r.adjustment_lines.length} line${r.adjustment_lines.length === 1 ? '' : 's'} · ${L.store(r.store_id)}` };
      }
      case 'count': {
        const r = raw as CountQueueRow;
        const v = r.stock_count_lines.filter((l) => Number(l.variance) !== 0).length;
        return { type, id: r.id, title: r.number, at: r.counted_at, critical: false, raw, bulkOk: true,
          sub: `${humanize(r.count_type)} count · ${v} variance${v === 1 ? '' : 's'} · ${L.store(r.store_id)}` };
      }
      case 'progress': {
        const r = raw as ProgressQueueRow;
        return { type, id: r.id, title: `${L.element(r.element_id)} · ${r.element_activities?.name ?? ''}`, at: r.created_at, critical: false, raw,
          bulkOk: !r.element_activities?.is_hold_point, sub: `Reported ${num(r.pct_complete, 0)} % → verify${r.element_activities?.is_hold_point ? ' · hold point' : ''} · ${L.person(r.reported_by)}` };
      }
      case 'po': {
        const r = raw as PoQueueRow;
        return { type, id: r.id, title: r.number, at: r.submitted_at ?? r.created_at, critical: false, raw, bulkOk: !r.approved_at,
          sub: `Purchase order · ${r.suppliers?.name ?? '?'} · ${L.store(r.delivery_store_id)}${r.revision ? ` · rev ${r.revision} (amended)` : ''}` };
      }
      case 'gate_pass': {
        const r = raw as GatePassQueueRow;
        const n = r.gate_pass_lines.filter((l) => !l.deleted_at).length;
        return { type, id: r.id, title: r.number, at: r.submitted_at ?? r.created_at, critical: r.pass_type === 'non_returnable', raw, bulkOk: true,
          sub: `${r.pass_type === 'returnable' ? 'Returnable' : 'Non-returnable'} gate pass · ${n} item${n === 1 ? '' : 's'} · to ${r.destination} · ${L.person(r.requested_by)}` };
      }
      case 'diary': {
        const r = raw as DiaryQueueRow;
        return { type, id: r.id, title: r.number, at: r.submitted_at ?? r.created_at, critical: false, raw, bulkOk: true,
          sub: `Site diary · ${r.diary_date} · ${r.block_id ? `Blk ${L.block(r.block_id)}` : 'whole site'} · ${L.person(r.created_by)}` };
      }
      case 'task_progress': {
        const r = raw as TaskProgressQueueRow;
        const t = r.schedule_tasks;
        const was = r.prev_pct ?? Number(t?.pct_complete ?? 0);
        const jump = Number(r.pct_complete ?? 0) - was;
        return { type, id: r.id, title: `${t?.wbs ? `${t.wbs} ` : ''}${t?.name ?? 'Task'}`, at: r.created_at, critical: !!t?.is_critical, raw, bulkOk: taskProgressClean(r),
          sub: `Task progress ${num(was, 0)} → ${num(r.pct_complete, 0)} %${jump > 25 ? ` · ⚠ +${num(jump, 0)} pts jump` : ''}${r.original_status_date ? ' · late report' : ''} · ${L.person(r.reported_by)}` };
      }
      case 'baseline': {
        const r = raw as BaselineQueueRow;
        return { type, id: r.id, title: `BL-${r.baseline_no} ${r.name}`, at: r.proposed_at, critical: false, raw, bulkOk: false,
          sub: `Baseline to approve · ${r.task_count} tasks · ${r.reason ?? (r.source === 'msp_baseline' ? 'from the MS Project baseline' : 'from the current plan')} · ${L.person(r.proposed_by)}` };
      }
      case 'rfq_award': {
        const r = raw as PlanQueueRow;
        return { type, id: r.entity_id, title: r.title, at: r.requested_at ?? new Date().toISOString(), critical: r.is_urgent, raw, bulkOk: false,
          sub: `RFQ ${r.number} · compare the quotations and award${r.is_urgent ? ' · quotes due date passed' : ''}` };
      }
      case 'po_send': case 'po_receive': {
        const r = raw as PlanQueueRow;
        return { type, id: r.entity_id, title: r.title, at: r.requested_at ?? new Date().toISOString(), critical: r.is_urgent, raw, bulkOk: false,
          sub: type === 'po_send' ? `${r.number} · approved — send it to the supplier` : `${r.number} · ${r.is_urgent ? 'late — ' : ''}receive with a GRN when it arrives` };
      }
      case 'payment': {
        const r = raw as PlanQueueRow;
        const step = r.actions[0] === 'check' ? 'check' : r.actions[0] === 'approve' ? 'approve' : r.actions[0] === 'pay' ? 'pay' : 'correct and resubmit';
        const kind = r.entity_type === 'payroll' ? 'labour payroll' : r.entity_type === 'supplier_invoice' ? 'supplier invoice'
          : r.entity_type === 'petty_cash' ? 'petty cash replenishment' : 'subcontractor certificate';
        return { type, id: r.entity_id, title: r.title, at: r.requested_at ?? new Date().toISOString(), critical: r.is_urgent, raw, bulkOk: false,
          sub: `${r.number} · ${kind} · ${step}${r.is_urgent ? ' · payment due' : ''}` };
      }
      case 'office': {
        const r = raw as PlanQueueRow;
        return { type, id: r.entity_id, title: r.title, at: r.requested_at ?? new Date().toISOString(), critical: r.is_urgent, raw, bulkOk: false,
          sub: `${r.number} · ${humanize(r.entity_type)}${r.actions.length ? ` · ${r.actions.join(', ')}` : ''}` };
      }
      case 'tool_overdue': case 'stock_expiry': {
        const r = raw as PlanQueueRow;
        return { type, id: r.entity_id, title: r.title, at: r.requested_at ?? new Date().toISOString(), critical: r.is_urgent, raw, bulkOk: false,
          sub: type === 'tool_overdue' ? `Tool ${r.number} · not returned on time` : `${r.number} · ${r.status === 'expired' ? 'past its shelf life' : 'expires within 14 days — issue first'}` };
      }
      case 'site_ops': {
        const r = raw as PlanQueueRow;
        return { type, id: r.entity_id, title: r.title, at: r.requested_at ?? new Date().toISOString(), critical: r.is_urgent, raw, bulkOk: false,
          sub: `${r.number} · ${r.entity_type === 'work_permit' ? 'permit to work' : 'safety incident'} · ${r.actions[0] ?? ''}` };
      }
      case 'holiday': {
        const r = raw as PlanQueueRow;
        return { type, id: r.entity_id, title: r.title, at: r.requested_at ?? new Date().toISOString(), critical: r.is_urgent, raw, bulkOk: false,
          sub: `${r.number} · public holiday${r.is_urgent ? ' · within a week' : ''} · undecided = no work` };
      }
      case 'client_ipc': case 'variation': {
        const r = raw as PlanQueueRow;
        return { type, id: r.entity_id, title: r.title, at: r.requested_at ?? new Date().toISOString(), critical: r.is_urgent, raw, bulkOk: false,
          sub: type === 'client_ipc' ? `${r.number} · client payment certificate` : `${r.number} · variation / change order` };
      }
      case 'lookahead_constraint': case 'lookahead_week_close': case 'period_close': {
        const r = raw as PlanQueueRow;
        return { type, id: r.entity_id, title: r.title, at: r.requested_at ?? new Date().toISOString(), critical: r.is_urgent, raw, bulkOk: false,
          sub: `${r.kind === 'lookahead_constraint' ? `Look-ahead constraint · ${r.number}${r.is_urgent ? ' · overdue' : ''}` : r.kind === 'lookahead_week_close' ? `Weekly plan · ${r.number} · record results and close` : `Progress period ${r.number} · ready to close`}${r.requested_by ? ` · ${L.person(r.requested_by)}` : ''}` };
      }
      default: {
        const r = raw as EmergencyQueueRow;
        return { type, id: r.id, title: r.number, at: r.issued_at, critical: hoursSince(r.issued_at) > 24, raw, bulkOk: false,
          sub: `Emergency issue · ${r.miv_lines.length} line${r.miv_lines.length === 1 ? '' : 's'} · ${L.person(r.issued_to)}` };
      }
    }
  });
}

/**
 * Unified approval inbox (spec §1.5/§4): MR review/approve (partial per line), adjustments,
 * stock counts, progress verification, emergency-issue regularisation. Split view, J/K/A/R, auto-advance.
 */
export function Approvals() {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const types = queueTypesFor(auth.can, auth.profile?.role);
  const statuses = mrStatusesFor(auth.can);
  const [f, setF] = useUrlFilters({ type: 'all', id: '' });
  const q = useAsync(async () => {
    const out: Partial<Record<QueueType, Raw[]>> = {};
    await Promise.all(types.map(async (t) => {
      if (t === 'pr' || t === 'issue' || t === 'delivery') out[t] = await loadQueue.flow(projectId, FLOW_QUEUE_KINDS[t]).catch(() => []);
      else if (isPlanQueueType(t)) out[t] = await loadQueue.plan(projectId, t);
      else out[t] = t === 'mr' ? await loadQueue.mr(projectId, statuses) : await loadQueue[t](projectId);
    }));
    return out;
  }, [projectId, types.join(), statuses.join()], { key: 'approvals', staleTime: 15_000 });

  const L = lk.data;
  const all = useMemo(() => {
    if (!q.data || !L) return [];
    const items = types.flatMap((t) => toItems(t, q.data![t] ?? [], L));
    // Critical pinned on top, then oldest first.
    return items.sort((a, b) => (Number(b.critical) - Number(a.critical)) || a.at.localeCompare(b.at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, L]);
  const type = (f.type === 'all' || types.includes(f.type as QueueType) ? f.type : 'all') as QueueType | 'all';
  const list = type === 'all' ? all : all.filter((i) => i.type === type);
  const current = list.find((i) => i.id === f.id) ?? list[0];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const actions = useRef<PreviewActions>({});
  const listRef = useRef<HTMLDivElement>(null);
  const [lastDone, setLastDone] = useState<string | null>(null);

  const select = (id: string | undefined) => { if (id) setF('id', id); };
  const move = (d: number) => {
    if (!list.length) return;
    const i = Math.max(0, list.findIndex((x) => x.id === current?.id));
    const n = list[Math.max(0, Math.min(list.length - 1, i + d))];
    select(n.id);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-id="${n.id}"]`)?.scrollIntoView({ block: 'nearest' }));
  };

  // After an action: toast + auto-advance to the next item.
  const onDone = (msg: string) => {
    const i = list.findIndex((x) => x.id === current?.id);
    const next = list[i + 1] ?? list[i - 1];
    toast.success(msg);
    setLastDone(msg);
    if (next) select(next.id); else setF('id', '');
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || document.querySelector('dialog[open]')) return;
      const k = e.key.toLowerCase();
      if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (k === 'a') { e.preventDefault(); actions.current.approve?.(); }
      else if (k === 'r') { e.preventDefault(); actions.current.reject?.(); }
      else if (k === 'x' && current) { e.preventDefault(); toggle(current.id); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selItems = list.filter((i) => selected.has(i.id));
  const homogeneous = selItems.length > 0 && selItems.every((i) => i.type === selItems[0].type) && selItems.every((i) => i.bulkOk) && selItems[0].type !== 'emergency';
  const bulkApprove = async () => {
    const t = selItems[0].type;
    if (!(await confirm({ title: `Approve ${selItems.length} ${QUEUE_LABEL[t].toLowerCase()}?`, body: <p className="muted mb-0">{t === 'task_progress' ? 'Each task report is verified at the reported % (clean reports only: jump ≤ 25 points, not late, not a finish claim).' : t === 'pr' ? 'Each approved purchase request is accepted by you (with procurement).' : t === 'delivery' ? 'Each announced delivery is accepted; receive it with a GRN when it arrives.' : t === 'mr' ? 'Requests are approved in full.' : t === 'progress' ? 'Each report is verified at the reported %.' : t === 'po' ? 'Each purchase order is approved within your approval limit.' : t === 'gate_pass' ? 'Each gate pass is approved; the guard can then check the vehicle out.' : t === 'diary' ? 'Each diary is signed and locked.' : 'Each is approved and posted to the stock ledger.'}</p>, confirm: `Approve ${selItems.length}` }))) return;
    let ok = 0;
    for (const it of selItems) {
      try {
        if (t === 'pr') await flowRpc('mr_action', { mr_id: it.id, action: 'accept', assign_to: auth.profile?.id });
        else if (t === 'delivery') await flowRpc('acknowledge_delivery_notice', { id: it.id, decision: 'accept' });
        else if (t === 'mr') await rpc('mr_action', { mr_id: it.id, action: auth.can('mr.approve') ? 'approve' : 'review' });
        else if (t === 'adjustment') await rpc('decide_adjustment', { adjustment_id: it.id, approve: true });
        else if (t === 'count') await rpc('decide_stock_count', { count_id: it.id, approve: true });
        else if (t === 'po') await procRpc('po_action', { po_id: it.id, action: 'approve' });
        else if (t === 'gate_pass') await rpcx('gate_pass_action', { gate_pass_id: it.id, action: 'approve' });
        else if (t === 'diary') await rpcx('sign_site_diary', { diary_id: it.id, approve: true });
        else if (t === 'task_progress') await schedRpc('verify_task_progress', { progress_id: it.id, approve: true });
        else if (t === 'progress') await rpc('verify_progress', { progress_id: it.id, approve: true, verified_pct: Number((it.raw as ProgressQueueRow).pct_complete) });
        ok++;
      } catch (e) { toast.error(`${it.title}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    setSelected(new Set());
    if (ok) toast.success(`${ok} approved`);
  };

  const counts = Object.fromEntries(types.map((t) => [t, all.filter((i) => i.type === t).length])) as Record<QueueType, number>;
  const props = current && L ? { L, onDone, onActions: (a: PreviewActions) => { actions.current = a; } } : null;

  return (
    <Page title="Approvals" subtitle="Everything waiting for your decision, oldest first · J/K to move, A approve, R return/reject">
      {types.length === 0 ? <Empty title="Nothing to approve">Your role doesn't approve requests, stock or progress.</Empty> : (
        <>
          <Tabs label="Queue type" value={type} onChange={(t) => { setSelected(new Set()); setF('type', t); }}
            tabs={[...types.map((t) => ({ key: t as QueueType | 'all', label: QUEUE_LABEL[t], count: counts[t], hot: true })), { key: 'all', label: 'All', count: all.length }]} />
          <ErrorBanner error={q.error ?? lk.error} onRetry={q.reload} />
          {!q.data || !L ? <div className="inbox"><div className="inbox-list"><Loading lines={8} /></div><div className="inbox-preview"><Loading lines={8} /></div></div>
          : !list.length ? (
            <Empty icon={<CheckCheck size={32} className="ok-text" aria-hidden />} title="You're all caught up">
              Nothing is waiting for your approval{type !== 'all' ? ` in ${QUEUE_LABEL[type as QueueType].toLowerCase()}` : ''}.{lastDone ? ` Last: ${lastDone}.` : ''}
            </Empty>
          ) : (
            <div className="inbox">
              <div className="inbox-list">
                <div className="inbox-list-head">
                  <input type="checkbox" aria-label="Select all" checked={selItems.length === list.length}
                    ref={(el) => { if (el) el.indeterminate = selItems.length > 0 && selItems.length < list.length; }}
                    onChange={() => setSelected(selItems.length === list.length ? new Set() : new Set(list.map((i) => i.id)))} />
                  <span className="grow">{list.length} waiting · oldest first</span>
                  {selItems.length > 0 && <button className="small primary" disabled={!homogeneous} title={homogeneous ? undefined : 'Bulk approve needs items of one type that pass the quick checks (no big jump, late report or finish claim; no over-BoQ lines or hold points) — open the others one by one'} onClick={() => void bulkApprove()}>Approve {selItems.length}</button>}
                </div>
                <div className="inbox-items" ref={listRef} role="listbox" aria-label="Approval queue">
                  {list.map((it) => {
                    const h = hoursSince(it.at);
                    return (
                      <div key={it.id} data-id={it.id} role="option" aria-selected={it.id === current?.id} tabIndex={it.id === current?.id ? 0 : -1}
                        className={`inbox-item${it.id === current?.id ? ' active' : ''}`} onClick={() => select(it.id)}>
                        <input type="checkbox" aria-label={`Select ${it.title}`} checked={selected.has(it.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(it.id)} />
                        <div className="grow">
                          <div className="l1">
                            {it.critical && <Flame size={14} className="danger-text" aria-label="Critical" />}
                            <span className="no">{it.title}</span>
                            {it.priority && <PriorityBadge value={it.priority} />}
                            {type === 'all' && <Badge tone="neutral" label={QUEUE_LABEL[it.type].replace(/s$/, '')} icon={null} />}
                            <span className={`age${h > 48 ? ' late' : ''}`}>{num(h, 0)} h</span>
                          </div>
                          <div className="l2">{it.sub}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="inbox-preview" aria-live="polite">
                {props && current.type === 'pr' && <PrPreview key={current.id} row={current.raw as FlowQueueRow} {...props} />}
                {props && current.type === 'issue' && <IssuePreview key={current.id} row={current.raw as FlowQueueRow} {...props} />}
                {props && current.type === 'delivery' && <DeliveryPreview key={current.id} row={current.raw as FlowQueueRow} {...props} />}
                {props && current.type === 'mr' && <MrPreview key={current.id} row={current.raw as MrQueueRow} {...props} />}
                {props && current.type === 'adjustment' && <AdjustmentPreview key={current.id} row={current.raw as AdjQueueRow} {...props} />}
                {props && current.type === 'count' && <CountPreview key={current.id} row={current.raw as CountQueueRow} {...props} />}
                {props && current.type === 'progress' && <ProgressPreview key={current.id} row={current.raw as ProgressQueueRow} {...props} />}
                {props && current.type === 'po' && <PoPreview key={current.id} row={current.raw as PoQueueRow} {...props} />}
                {props && current.type === 'gate_pass' && <GatePassPreview key={current.id} row={current.raw as GatePassQueueRow} {...props} />}
                {props && current.type === 'diary' && <DiaryPreview key={current.id} row={current.raw as DiaryQueueRow} {...props} />}
                {props && current.type === 'task_progress' && <TaskProgressPreview key={current.id} row={current.raw as TaskProgressQueueRow} {...props} />}
                {props && current.type === 'baseline' && <BaselinePreview key={current.id} row={current.raw as BaselineQueueRow} {...props} />}
                {props && current.type === 'lookahead_constraint' && <ConstraintPreview key={current.id} row={current.raw as PlanQueueRow} {...props} />}
                {props && current.type === 'lookahead_week_close' && <WeekClosePreview key={current.id} row={current.raw as PlanQueueRow} {...props} />}
                {props && current.type === 'period_close' && <PeriodClosePreview key={current.id} row={current.raw as PlanQueueRow} {...props} />}
                {props && current.type === 'rfq_award' && <RfqAwardPreview key={current.id} row={current.raw as PlanQueueRow} {...props} />}
                {props && current.type === 'po_send' && <PoSendPreview key={current.id} row={current.raw as PlanQueueRow} {...props} />}
                {props && current.type === 'po_receive' && <PoReceivePreview key={current.id} row={current.raw as PlanQueueRow} {...props} />}
                {props && current.type === 'client_ipc' && <ClientIpcPreview key={current.id} row={current.raw as PlanQueueRow} {...props} />}
                {props && current.type === 'variation' && <VariationPreview key={current.id} row={current.raw as PlanQueueRow} {...props} />}
                {props && current.type === 'payment' && (['supplier_invoice', 'petty_cash'].includes((current.raw as PlanQueueRow).entity_type)
                  ? <FinanceDocPreview key={current.id} row={current.raw as PlanQueueRow} onDone={props.onDone} onActions={props.onActions} />
                  : <PaymentPreview key={current.id} row={current.raw as PlanQueueRow} {...props} />)}
                {props && current.type === 'tool_overdue' && <ToolOverduePreview key={current.id} row={current.raw as PlanQueueRow} {...props} />}
                {props && current.type === 'stock_expiry' && <StockExpiryPreview key={current.id} row={current.raw as PlanQueueRow} {...props} />}
                {props && current.type === 'site_ops' && <SiteOpsPreview key={current.id} row={current.raw as PlanQueueRow} {...props} />}
                {props && current.type === 'holiday' && <HolidayPreview key={current.id} row={current.raw as PlanQueueRow} {...props} />}
                {props && current.type === 'office' && <OfficePreview key={current.id} row={current.raw as PlanQueueRow} onDone={props.onDone} onActions={props.onActions} />}
                {props && current.type === 'emergency' && <EmergencyPreview key={current.id} row={current.raw as EmergencyQueueRow} projectId={projectId} {...props} />}
              </div>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
