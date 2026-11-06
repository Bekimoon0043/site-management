// Material procurement flows (purchase / site use) — client helpers on top of contract-flows.ts.
// Loaders, typed RPC wrapper, timeline model, "your turn" logic. UI lives in components/flows/*.
import type { AppRole, MaterialRequest, MrEvent, ProjectSettings } from './contract';
import {
  flowSteps, isTerminal, nextActor, stepIndex,
  type DeliveryNotice, type FlowActor, type FlowMrStatus, type MaterialRequestFlowFields, type MrApproval, type MrEstimate,
  type MrLineFlowFields, type MrWorkflowRow, type PostGrnFlowFields, type ProjectSettingsFlowFields, type RequestType, type RpcMapFlows,
  type StockAvailableToIssueRow,
} from './contract-flows';
import type { PostGrnPoPayload } from './contract-procurement';
import { check, supabase } from './supabase';
import { invalidateAfterWrite } from './query';
import type { Lookups } from './hooks';

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

type FlowRpcMap = RpcMapFlows & { post_grn: PostGrnPoPayload & PostGrnFlowFields & { po_id?: string } };
type FlowPayload<N extends keyof FlowRpcMap> = Omit<FlowRpcMap[N], 'op_id'> & { op_id?: string };

/** Transactional flow RPC with a fresh op_id; invalidates cached lists on success. */
export async function flowRpc<N extends keyof FlowRpcMap>(name: N, payload: FlowPayload<N>): Promise<Record<string, unknown>> {
  const p = { op_id: crypto.randomUUID(), ...payload };
  const { data, error } = await supabase.rpc(name, { p });
  if (error) throw new Error(error.message);
  invalidateAfterWrite();
  return (data ?? {}) as Record<string, unknown>;
}

/** Runs a query, returning [] when the table/view is not readable for this role (RLS / price rules). */
export async function safeRows<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  try { const r = await q; return r.error ? [] : ((r.data ?? []) as T[]); } catch { return []; }
}

// ---------------------------------------------------------------------------
// Settings & labels
// ---------------------------------------------------------------------------

export type FlowSettings = ProjectSettings & Partial<ProjectSettingsFlowFields>;
export const flowOpts = (s: FlowSettings | null | undefined) => ({
  requireReview: s?.require_review ?? true,
  requireCoordinatorReview: s?.pr_require_coordinator_review ?? true,
});

export const ACTOR_LABEL: Record<FlowActor, string> = {
  requester: 'Requester', site_engineer: 'Site engineer', office_engineer: 'Office engineer', coordinator: 'Coordinator',
  manager: 'Management', procurement: 'Procurement', store_keeper: 'Store keeper', admin: 'Admin', security: 'Security', finance: 'Finance', client: 'Client',
};

/** Status → badge tone (statuses missing from the shared Badge map). */
export const FLOW_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'primary' | 'violet'> = {
  draft: 'neutral', submitted: 'info', returned: 'warning', reviewed: 'info', reviewed_by_coordinator: 'info',
  approved: 'success', approved_by_management: 'success', with_procurement: 'primary', sourced: 'primary', ordered: 'primary',
  delivery_expected: 'violet', partially_received: 'violet', partially_issued: 'violet', issued: 'primary', received: 'success',
  closed: 'neutral', rejected: 'danger', cancelled: 'neutral',
};

export const isPurchase = (r: { request_type?: string | null; number?: string }) =>
  r.request_type === 'purchase' || (!r.request_type && !!r.number && /(^|-)PR-/.test(r.number));

/** Hours → "5 h" / "2.5 d". */
export function ageText(h: number | null | undefined) {
  if (h === null || h === undefined || !Number.isFinite(h)) return '';
  if (h < 48) return `${Math.max(0, Math.round(h))} h`;
  const d = h / 24;
  return `${d < 10 ? Math.round(d * 10) / 10 : Math.round(d)} d`;
}
/** 'ok' | 'warn' (> SLA) | 'late' (> 2× SLA). */
export function slaState(hours: number | null | undefined, sla: number | null | undefined): 'ok' | 'warn' | 'late' {
  if (!sla || hours === null || hours === undefined) return 'ok';
  return hours > 2 * sla ? 'late' : hours > sla ? 'warn' : 'ok';
}

/** Is the signed-in user the one who must act next? Admin can act on every non-requester step. */
export function isMyTurn(actor: FlowActor | null, me: { id?: string | null; role?: AppRole | null }, requestedBy: string) {
  if (!actor || !me.role) return false;
  if (actor === 'requester') return !!me.id && me.id === requestedBy;
  return me.role === actor || me.role === 'admin';
}

// ---------------------------------------------------------------------------
// Detail extras (flow columns, sign-offs, SLA, estimate, traceability)
// ---------------------------------------------------------------------------

export type FlowMr = MaterialRequest & Partial<MaterialRequestFlowFields>;
export type FlowLineExtra = { id: string } & MrLineFlowFields;
export interface TraceDoc { kind: 'SUR' | 'PR' | 'RFQ' | 'PO' | 'DN' | 'GRN' | 'MIV'; id: string; label: string; status: string; to?: string }

export async function loadFlowExtras(mr: FlowMr, opts: { withPrices: boolean }) {
  const id = mr.id;
  const [lines, approvals, wf, est, children, source] = await Promise.all([
    safeRows<FlowLineExtra>(supabase.from('mr_lines').select('id, reviewed_qty, source_mr_line_id, lookahead_item_id, qty_received, line_status').eq('mr_id', id).is('deleted_at', null)),
    safeRows<MrApproval>(supabase.from('mr_approvals').select('*').eq('mr_id', id).order('created_at')),
    safeRows<MrWorkflowRow>(supabase.from('v_mr_workflow').select('*').eq('id', id).limit(1)),
    opts.withPrices ? safeRows<MrEstimate>(supabase.from('mr_estimates').select('*').eq('mr_id', id).limit(1)) : Promise.resolve([] as MrEstimate[]),
    safeRows<{ id: string; number: string; status: FlowMrStatus; request_type: RequestType }>(supabase.from('material_requests').select('id, number, status, request_type').eq('source_mr_id', id).order('created_at')),
    mr.source_mr_id ? safeRows<{ id: string; number: string; status: FlowMrStatus }>(supabase.from('material_requests').select('id, number, status').eq('id', mr.source_mr_id).limit(1)) : Promise.resolve([]),
  ]);
  return {
    lines: new Map(lines.map((l) => [l.id, l])), approvals, wf: wf[0] ?? null, estimate: est[0] ?? null,
    children, source: source[0] ?? null,
  };
}
export type FlowExtras = Awaited<ReturnType<typeof loadFlowExtras>>;

/** Document chain for a request: SUR → PR → RFQ → PO → delivery notice → GRN → MIV. */
export async function loadTrace(mr: FlowMr, lineIds: string[], children: { id: string; number: string; status: string; request_type: string }[]) {
  const purchase = isPurchase(mr);
  const out: TraceDoc[] = [];
  if (!purchase) {
    for (const c of children) out.push({ kind: 'PR', id: c.id, label: c.number, status: c.status, to: `/requests/${c.id}` });
    const mivs = await safeRows<{ id: string; number: string; status: string }>(supabase.from('mivs').select('id, number, status').eq('mr_id', mr.id).order('issued_at'));
    for (const m of mivs) out.push({ kind: 'MIV', id: m.id, label: m.number, status: m.status, to: `/store?open=${m.id}#miv` });
    return out;
  }
  if (!lineIds.length) return out;
  const [rfq, po, grn] = await Promise.all([
    safeRows<{ rfqs: { id: string; number: string; status: string } | null }>(supabase.from('rfq_lines').select('rfqs(id, number, status)').in('mr_line_id', lineIds).is('deleted_at', null)),
    safeRows<{ purchase_orders: { id: string; number: string; status: string } | null }>(supabase.from('po_lines').select('purchase_orders(id, number, status)').in('mr_line_id', lineIds).is('deleted_at', null)),
    safeRows<{ grns: { id: string; number: string; status: string } | null }>(supabase.from('grn_lines').select('grns(id, number, status)').in('mr_line_id', lineIds)),
  ]);
  const uniq = <T extends { id: string }>(xs: (T | null)[]) => [...new Map(xs.filter((x): x is T => !!x).map((x) => [x.id, x])).values()];
  const rfqs = uniq(rfq.map((r) => r.rfqs)), pos = uniq(po.map((r) => r.purchase_orders)), grns = uniq(grn.map((r) => r.grns));
  const notices = pos.length ? await safeRows<Pick<DeliveryNotice, 'id' | 'po_id' | 'expected_date' | 'status'>>(
    supabase.from('delivery_notices').select('id, po_id, expected_date, status').in('po_id', pos.map((p) => p.id)).order('expected_date')) : [];
  for (const r of rfqs) out.push({ kind: 'RFQ', id: r.id, label: r.number, status: r.status, to: `/procurement/rfq/${r.id}` });
  for (const p of pos) out.push({ kind: 'PO', id: p.id, label: p.number, status: p.status, to: `/procurement/po/${p.id}` });
  for (const n of notices) out.push({ kind: 'DN', id: n.id, label: `Delivery ${n.expected_date.slice(5)}`, status: n.status, to: `/deliveries?open=${n.id}` });
  for (const g of grns) out.push({ kind: 'GRN', id: g.id, label: g.number, status: g.status, to: `/store?open=${g.id}#grn` });
  if (mr.source_mr_id) {
    const mivs = await safeRows<{ id: string; number: string; status: string }>(supabase.from('mivs').select('id, number, status').eq('mr_id', mr.source_mr_id).order('issued_at'));
    for (const m of mivs) out.push({ kind: 'MIV', id: m.id, label: m.number, status: m.status, to: `/store?open=${m.id}#miv` });
  }
  return out;
}

/** Available-to-issue per store for the given specs (site-use review). */
export async function loadAti(projectId: string, specIds: string[]) {
  if (!specIds.length) return [] as StockAvailableToIssueRow[];
  return check(await supabase.from('v_stock_available_to_issue').select('*').eq('project_id', projectId).in('material_spec_id', specIds)) as StockAvailableToIssueRow[];
}

/** Planned take-off (incl. wastage not applied) for elements × specs — the BoQ quantity behind a line. */
export async function loadTakeoffs(elementIds: string[], specIds: string[]) {
  if (!elementIds.length || !specIds.length) return [] as { element_id: string; material_spec_id: string; planned_qty: number }[];
  return safeRows<{ element_id: string; material_spec_id: string; planned_qty: number }>(supabase.from('element_takeoffs')
    .select('element_id, material_spec_id, planned_qty').in('element_id', elementIds).in('material_spec_id', specIds).is('deleted_at', null));
}

// ---------------------------------------------------------------------------
// Timeline model
// ---------------------------------------------------------------------------

export type StepState = 'done' | 'current' | 'waiting' | 'returned' | 'rejected' | 'skipped';
export interface TimelineStep {
  key: string; label: string; actor: FlowActor | null; state: StepState;
  who?: string; at?: string | null; comment?: string | null; note?: string;
  since?: string | null; hours?: number | null; slaHours?: number | null; assignees?: string[];
}

const ACTION_VERB: Record<string, string> = {
  raise: 'submit this request', request: 'submit this request', review: 'review this request', approve: 'approve this request',
  accept: 'accept this purchase request', buy: 'source this request (RFQ / PO)', notify: 'notify the store of the delivery',
  deliver: 'accept the delivery and post the GRN', issue: 'issue the materials (MIV)', acknowledge: 'acknowledge receipt',
};
export const stepVerb = (key: string, type: RequestType) =>
  key === 'approve' && type === 'site_use' ? 'approve this request as a store order' : ACTION_VERB[key] ?? 'act on this request';

export function buildTimeline(args: {
  type: RequestType; status: FlowMrStatus; events: MrEvent[]; approvals: MrApproval[]; wf: MrWorkflowRow | null;
  settings: FlowSettings | null | undefined; requestedBy: string; submittedAt: string | null; createdAt: string; L: Lookups;
}): TimelineStep[] {
  const { type, status, L } = args;
  const steps = flowSteps(type);
  const ev = [...args.events].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const terminal = status === 'rejected' || status === 'cancelled';
  const finished = status === 'closed' || (status === 'received');
  let cur = stepIndex(status, type);
  if (terminal) {
    const last = [...ev].reverse().find((e) => e.to_status === status);
    cur = Math.max(0, last?.from_status ? stepIndex(last.from_status as FlowMrStatus, type) : 0);
  }
  if (cur < 0) cur = 0;
  const live = args.approvals.filter((a) => !a.superseded);
  const endorse = live.filter((a) => a.step === 'endorse');
  const actor = nextActor(status, type, flowOpts(args.settings));
  // Review switched off (require_review / pr_require_coordinator_review): the review step is skipped.
  if (status === 'submitted' && actor && steps[cur]?.actor !== actor && steps[cur + 1]?.actor === actor) cur += 1;
  const names = (role: FlowActor | null) => {
    if (!role) return [];
    if (role === 'requester') return [L.person(args.requestedBy)];
    const ps = L.profiles.filter((p) => p.role === role && p.is_active).map((p) => p.full_name || p.email || '?');
    return ps.length > 3 ? [...ps.slice(0, 3), `+${ps.length - 3}`] : ps;
  };
  const exitOf = (statuses: FlowMrStatus[]) => [...ev].reverse().find((e) => e.from_status && statuses.includes(e.from_status as FlowMrStatus)
    && (!e.to_status || !statuses.includes(e.to_status as FlowMrStatus)) && !['returned', 'rejected', 'cancelled'].includes(String(e.to_status)));

  return steps.map((s, i): TimelineStep => {
    const base: TimelineStep = { key: s.key, label: s.label, actor: s.actor, state: 'waiting' };
    const last = i === steps.length - 1;
    if (finished && last) {
      const e = [...ev].reverse().find((x) => String(x.to_status) === 'received' || x.to_status === 'closed');
      return { ...base, state: 'done', who: e?.actor ? L.person(e.actor) : undefined, at: e?.created_at ?? null };
    }
    if (i < cur) {
      const e = exitOf(s.statuses);
      if (!e) return { ...base, state: i === 0 ? 'done' : 'skipped', at: i === 0 ? args.submittedAt : null, who: i === 0 ? L.person(args.requestedBy) : undefined,
        note: i === 0 ? undefined : 'Skipped' };
      const ap = live.find((a) => a.created_at.slice(0, 16) === e.created_at.slice(0, 16) && a.step !== 'endorse');
      const deleg = ap?.delegated_from ? ` (for ${L.person(ap.delegated_from)})` : '';
      const note = s.key === 'approve' && endorse.length ? `Endorsed by ${endorse.map((x) => L.person(x.actor)).join(', ')}` : undefined;
      return { ...base, state: 'done', who: (e.actor ? L.person(e.actor) : 'system') + deleg, at: e.created_at, comment: e.comment, note };
    }
    if (i === cur) {
      const lastEv = ev[ev.length - 1];
      if (terminal) return { ...base, state: 'rejected', who: lastEv?.actor ? L.person(lastEv.actor) : undefined, at: lastEv?.created_at, comment: lastEv?.comment,
        note: status === 'rejected' ? 'Rejected' : 'Cancelled' };
      const since = args.wf?.status_since ?? lastEv?.created_at ?? args.submittedAt ?? args.createdAt;
      const hours = args.wf?.hours_in_status ?? (since ? (Date.now() - new Date(since).getTime()) / 3600000 : null);
      const note = s.key === 'approve' && endorse.length ? `Endorsed by ${endorse.map((x) => L.person(x.actor)).join(', ')} — waiting for an approver with a higher limit` : undefined;
      if (status === 'returned') {
        const ret = [...ev].reverse().find((x) => x.to_status === 'returned');
        return { ...base, state: 'returned', who: ret?.actor ? L.person(ret.actor) : undefined, at: ret?.created_at, comment: ret?.comment,
          note: 'Returned for clarification — requester to fix and resubmit', actor: 'requester', assignees: names('requester'), since, hours };
      }
      return { ...base, state: 'current', actor: actor ?? s.actor, since, hours, slaHours: args.wf?.sla_hours ?? null, assignees: names(actor ?? s.actor), note };
    }
    return base;
  });
}

export const currentStep = (steps: TimelineStep[]) => steps.find((s) => s.state === 'current' || s.state === 'returned') ?? null;
export { isTerminal };
