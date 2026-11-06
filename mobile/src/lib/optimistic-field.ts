// Optimistic local apply for the field & quality RPCs (contract-field.ts), mirroring
// the server rules in 20261029000006_field_quality.sql closely enough that the app
// reflects every write offline: diary sections, inspection results + auto snags +
// hold-point clearing, snag lifecycle, pours, ready-mix trucks (GRN + MIV + pending
// ledger rows, like post_grn/post_miv), material issues to pours, cubes and BBS.
// Rows are tagged with the op id and replaced by server copies on pull.
import type { Element, ElementActivity, Grn, Miv, StockLedgerEntry } from './contract';
import type {
  BbsSchedule, ChecklistTemplate, CubeSet, DiaryStatus, Inspection, InspectionStatus, MixDesign, Pour, PourTruck,
  RpcMapField, SiteDiary, Snag, SnagAction, SnagSource, SnagStatus, TruckStatus,
} from './contract-field';
import { get, kvSet, list, putPending, type Row } from './db';
import { myId, myRole } from './me';
import {
  cubeResults, cubePasses, cubeStrength, evaluateItem, gradeCubeStrength, outcomeOf, pourElements, specDiameter, splitOverElements,
  templateItems, templatesFor, truckWarnings,
} from './field';

type Name = keyof RpcMapField;
const NAMES: Record<Name, true> = {
  save_site_diary: true, sign_site_diary: true, add_diary_addendum: true, get_diary_summary: true, save_checklist_template: true,
  request_inspection: true, submit_inspection: true, cancel_inspection: true, save_snag: true, snag_action: true, save_mix_design: true,
  save_pour: true, add_pour_truck: true, receive_pour_truck: true, add_pour_batch: true, issue_pour_materials: true, close_pour: true,
  save_cube_set: true, record_cube_results: true, save_bbs: true, approve_bbs: true,
};
export const FIELD_RPCS = new Set<string>(Object.keys(NAMES));

/** Conflicts returned as data instead of an error. Returns the outbox error text, or null when the call succeeded. */
export function recordRpcConflict(rpc: string, entityId: string | null, data: unknown): string | null {
  const d = data as { ok?: boolean; conflict?: string; existing_id?: string; existing_number?: string } | null;
  if (!FIELD_RPCS.has(rpc) || !d || typeof d !== 'object' || d.ok !== false) return null;
  if (rpc === 'save_site_diary' && d.conflict === 'exists') {
    if (entityId) kvSet(`diary-conflict:${entityId}`, JSON.stringify({ existing_id: d.existing_id, existing_number: d.existing_number }));
    return `Diary ${d.existing_number ?? ''} already exists for this day. Open the diary to add your entries as an addendum.`;
  }
  return 'Rejected by the server';
}

const now = () => new Date().toISOString();
const STORE_ROLES = ['store_keeper', 'coordinator', 'manager', 'admin'];
const REVIEWERS = ['office_engineer', 'coordinator', 'manager', 'admin'];

let seq = 0;
function localRow(tbl: string, op: string, row: Row) {
  const id = `local:${op}:f${seq++}`;
  putPending(tbl, { ...row, id, created_at: now(), updated_at: now() }, op, id);
  return id;
}
function ledger(op: string, e: Omit<StockLedgerEntry, 'id' | 'created_at'>) { localRow('stock_ledger', op, e as unknown as Row); }

function put(tbl: string, row: Row, op: string) { putPending(tbl, { ...row, updated_at: now() }, op); }
function patch<T extends object>(tbl: string, id: string, changes: Partial<T>, op: string) {
  const cur = get<T>(tbl, id);
  if (!cur) return;
  const { _pending: _, ...rest } = cur as T & { _pending?: string };
  putPending(tbl, { ...rest, ...changes, updated_at: now() } as Row, op);
}
/** Replace-by-id child rows (app.replace_children): upsert sent rows, soft-delete the others. */
function replaceChildren(tbl: string, fk: string, parentId: string, projectId: string, rows: object[] | undefined, op: string, defaults: Row = {}) {
  if (!rows) return;
  const t = now();
  const keep = new Set(rows.map((r) => (r as { id: string }).id));
  for (const old of list<{ id: string }>(tbl, { parent: parentId })) if (!keep.has(old.id)) patch(tbl, old.id, { deleted_at: t }, op);
  for (const r of rows) put(tbl, { ...defaults, ...(r as Row), [fk]: parentId, project_id: projectId, deleted_at: null }, op);
}

function refreshElementProgress(elementId: string, op: string) {
  const acts = list<ElementActivity>('element_activities', { parent: elementId });
  const w = acts.reduce((s, a) => s + Number(a.weight), 0);
  const prog = w > 0 ? acts.reduce((s, a) => s + Number(a.weight) * Number(a.verified_pct), 0) / w : 0;
  patch<Element>('elements', elementId, { progress_pct: Math.round(prog * 100) / 100, status: prog >= 100 ? 'completed' : 'in_progress' }, op);
}

function createSnag(op: string, s: Partial<Snag> & { id: string; project_id: string; number: string; title: string }) {
  const el = get<Element>('elements', s.element_id ?? null);
  const t = now();
  const row: Snag = {
    element_id: null, block_id: el?.block_id ?? null, level_id: el?.level_id ?? null, location_text: null, category: null, trade: null,
    severity: 'medium', description: null, assignee_user_id: null, assignee_party: null, due_date: null, source_type: 'walk' as SnagSource,
    source_id: null, raised_by: myId(), closed_by: null, closed_at: null, created_at: t, updated_at: t,
    ...s, status: 'open',
  };
  put('snags', row as unknown as Row, op);
  localRow('snag_events', op, { snag_id: s.id, project_id: s.project_id, action: 'create', from_status: null, to_status: 'open', comment: s.description ?? null, actor: myId() });
}

const SNAG_MOVES: Record<SnagAction, { from: SnagStatus[]; to: SnagStatus }> = {
  start: { from: ['open', 'reopened'], to: 'in_progress' },
  ready: { from: ['open', 'in_progress', 'reopened'], to: 'ready_for_review' },
  close: { from: ['ready_for_review'], to: 'closed' },
  reopen: { from: ['ready_for_review', 'closed'], to: 'reopened' },
  cancel: { from: ['open', 'in_progress', 'reopened'], to: 'cancelled' },
};

/** Hold point clears once every checklist for it has a passing latest inspection (app.try_clear_hold_point). */
function tryClearHoldPoint(activityId: string, op: string) {
  const a = get<ElementActivity>('element_activities', activityId);
  if (!a || !a.is_hold_point || Number(a.verified_pct) >= 100) return;
  const e = get<Element>('elements', a.element_id);
  const ins = list<Inspection>('inspections', { parent: a.element_id }).filter((i) => i.element_activity_id === a.id && i.status === 'completed');
  const pending = templatesFor(a.project_id, e?.element_type ?? null, a.name).filter((t) => {
    const latest = ins.filter((i) => i.template_id === t.id).sort((x, y) => (y.inspected_at ?? '').localeCompare(x.inspected_at ?? ''))[0];
    return !(latest && (latest.result === 'pass' || latest.result === 'conditional'));
  });
  if (pending.length) return;
  patch<ElementActivity>('element_activities', a.id, { verified_pct: 100, reported_pct: 100 }, op);
  refreshElementProgress(a.element_id, op);
}

/** Accepted ready-mix truck → GRN into the pour's store and MIV of the same volume to the pour's elements. */
function postTruck(op: string, truck: PourTruck, pr: Pour, x: { store_id?: string; grn_id?: string; grn_number?: string; miv_id?: string; miv_number?: string }) {
  const md = get<MixDesign>('mix_designs', pr.mix_design_id);
  const store = x.store_id ?? pr.store_id;
  const t = now();
  const at = truck.discharge_start ?? truck.arrived_at ?? t;
  const grnId = x.grn_id ?? `local:${op}:grn`;
  const mivId = x.miv_id ?? `local:${op}:miv`;
  if (md?.material_spec_id && store && x.grn_number && x.miv_number) {
    const spec = md.material_spec_id;
    const g: Grn = { id: grnId, project_id: pr.project_id, number: x.grn_number, store_id: store, supplier_id: pr.supplier_id, supplier_name: truck.supplier_name ?? pr.supplier_name,
      delivery_note_no: truck.ticket_no, vehicle_plate: truck.truck_plate, driver_name: null, received_at: at, remarks: `Ready-mix ticket ${truck.ticket_no} for pour ${pr.number}`,
      supplier_signature: null, status: 'posted', confirmed_by: null, created_by: myId(), created_at: t };
    put('grns', g as unknown as Row, op);
    localRow('grn_lines', op, { grn_id: grnId, project_id: pr.project_id, line_no: 1, material_spec_id: spec, mr_line_id: null, ordered_qty: null, qty_delivered: Number(truck.volume_m3),
      qty_accepted: Number(truck.volume_m3), qty_rejected: 0, batch_no: truck.ticket_no, inspection_result: 'pass', inspection_notes: null, variance_flag: null });
    ledger(op, { project_id: pr.project_id, store_id: store, material_spec_id: spec, qty: Number(truck.volume_m3), stock_status: 'available', txn_type: 'grn', doc_type: 'grn', doc_id: grnId, doc_number: x.grn_number, element_id: null, mr_line_id: null, txn_at: at });
    issueToPour(op, pr, store, mivId, x.miv_number, [{ material_spec_id: spec, qty: Number(truck.volume_m3), batch_no: truck.ticket_no }], at, `Ready-mix ticket ${truck.ticket_no} placed in pour ${pr.number}`, truck.id, grnId);
  }
  patch<PourTruck>('pour_trucks', truck.id, { status: 'posted', grn_id: grnId, miv_id: mivId, received_by: myId() }, op);
}

/** MIV to a pour's elements, split pro-rata by planned m³ (app.pour_issue). */
function issueToPour(op: string, pr: Pour, store: string, mivId: string, number: string, lines: { material_spec_id: string; qty: number; batch_no?: string }[],
  at: string, remarks: string, truckId: string | null = null, grnId: string | null = null) {
  const t = now();
  const m: Miv = { id: mivId, project_id: pr.project_id, number, store_id: store, mr_id: pr.mr_id, issued_to: pr.created_by, issued_by: myId(), issued_at: at,
    status: 'acknowledged', acknowledged_at: t, receiver_signature: null, is_emergency: false, emergency_reason: null, regularised_at: null, remarks };
  put('mivs', { ...m, created_at: t } as unknown as Row, op);
  const mrLines = pr.mr_id ? list<{ id: string; material_spec_id: string; line_no: number; deleted_at: string | null }>('mr_lines', { parent: pr.mr_id }).filter((l) => !l.deleted_at).sort((a, b) => a.line_no - b.line_no) : [];
  let n = 0;
  for (const l of lines) {
    const mrLine = mrLines.find((x) => x.material_spec_id === l.material_spec_id)?.id ?? null;
    for (const s of splitOverElements(pr.id, l.qty)) {
      n += 1;
      localRow('miv_lines', op, { miv_id: mivId, project_id: pr.project_id, line_no: n, mr_line_id: mrLine, material_spec_id: l.material_spec_id, element_id: s.element_id, qty: s.qty, batch_no: l.batch_no ?? null, substitution_reason: null });
      ledger(op, { project_id: pr.project_id, store_id: store, material_spec_id: l.material_spec_id, qty: -s.qty, stock_status: 'available', txn_type: 'miv', doc_type: 'miv', doc_id: mivId, doc_number: number, element_id: s.element_id, mr_line_id: mrLine, txn_at: at });
    }
  }
  localRow('pour_issues', op, { project_id: pr.project_id, pour_id: pr.id, miv_id: mivId, grn_id: grnId, truck_id: truckId });
}

function startPour(pourId: string, at: string | null | undefined, op: string) {
  const pr = get<Pour>('pours', pourId);
  if (pr?.status === 'planned') patch<Pour>('pours', pourId, { status: 'in_progress', start_at: pr.start_at ?? at ?? now() }, op);
}

export function applyOptimisticField<N extends Name>(rpc: N, payload: RpcMapField[N], op: string): void {
  const t = now();
  switch (rpc) {
    // ----------------------------------------------------------------- diary
    case 'save_site_diary': {
      const x = payload as RpcMapField['save_site_diary'];
      const prev = get<SiteDiary>('site_diaries', x.id);
      if (prev?.status === 'signed') break;
      const status: DiaryStatus = x.submit ? (prev?.status === 'submitted' ? 'submitted' : 'submitted') : prev?.status === 'submitted' ? 'draft' : prev?.status ?? 'draft';
      const d: SiteDiary = {
        id: x.id, project_id: x.project_id, number: prev?.number ?? x.number, diary_date: x.diary_date, block_id: x.block_id ?? null,
        weather_am: x.weather_am ?? null, weather_pm: x.weather_pm ?? null, rain_hours: x.rain_hours ?? null, temp_min: x.temp_min ?? null, temp_max: x.temp_max ?? null,
        weather_source: x.weather_source ?? 'manual', work_summary: x.work_summary || null, safety_notes: x.safety_notes || null, notes: x.notes || null,
        status, version: (prev?.version ?? 0) + 1, created_by: prev?.created_by ?? myId(),
        submitted_at: x.submit && prev?.status !== 'submitted' ? t : prev?.submitted_at ?? null,
        signed_by: null, signed_at: null, sign_comment: prev?.sign_comment ?? null, created_at: prev?.created_at ?? t, updated_at: t,
      };
      put('site_diaries', d as unknown as Row, op);
      replaceChildren('diary_labour', 'diary_id', x.id, x.project_id, x.labour, op, { trade_id: null, trade_name: null, subcontractor: null, hours: null });
      replaceChildren('diary_equipment', 'diary_id', x.id, x.project_id, x.equipment, op, { qty: 1, status: 'working', hours_worked: null, hours_idle: null, idle_reason: null, note: null });
      replaceChildren('diary_delays', 'diary_id', x.id, x.project_id, x.delays, op, { hours_lost: null, element_id: null, description: null });
      replaceChildren('diary_visitors', 'diary_id', x.id, x.project_id, x.visitors, op, { organisation: null, purpose: null, time_in: null, time_out: null });
      replaceChildren('diary_instructions', 'diary_id', x.id, x.project_id, x.instructions, op, { given_by: null, organisation: null, element_id: null });
      replaceChildren('diary_elements', 'diary_id', x.id, x.project_id, x.elements, op, { note: null });
      break;
    }
    case 'sign_site_diary': {
      const x = payload as RpcMapField['sign_site_diary'];
      const approve = x.approve ?? true;
      patch<SiteDiary>('site_diaries', x.diary_id, approve
        ? { status: 'signed', signed_by: myId(), signed_at: t, sign_comment: x.comment ?? null }
        : { status: 'draft', signed_by: null, signed_at: null, sign_comment: x.comment ?? null }, op);
      break;
    }
    case 'add_diary_addendum': {
      const x = payload as RpcMapField['add_diary_addendum'];
      const d = get<SiteDiary>('site_diaries', x.diary_id);
      put('diary_addenda', { id: x.id, diary_id: x.diary_id, project_id: d?.project_id ?? null, text: x.text.trim(), created_by: myId(), created_at: t }, op);
      break;
    }

    // ---------------------------------------------------------- inspections
    case 'save_checklist_template': {
      const x = payload as RpcMapField['save_checklist_template'];
      const prev = get<ChecklistTemplate>('checklist_templates', x.id);
      put('checklist_templates', {
        ...(prev ?? {}), id: x.id, project_id: x.project_id ?? null, code: x.code.trim(), name: x.name.trim(), name_am: x.name_am ?? null, description: x.description ?? null,
        element_types: (x.element_types ?? prev?.element_types ?? []).map((s) => s.toLowerCase()),
        hold_activities: (x.hold_activities ?? prev?.hold_activities ?? []).map((s) => s.toLowerCase()),
        version: prev?.version ?? 1, is_active: x.is_active ?? prev?.is_active ?? true, deleted_at: null,
      }, op);
      replaceChildren('checklist_template_items', 'template_id', x.id, x.project_id ?? (null as unknown as string),
        x.items.map((it, i) => ({ ...it, seq: it.seq ?? i + 1 })), op,
        { item_type: 'yes_no', photo_required: false, is_critical: false, min_value: null, max_value: null, unit: null, text_am: null });
      break;
    }
    case 'request_inspection': {
      const x = payload as RpcMapField['request_inspection'];
      const i: Inspection = { id: x.id, project_id: x.project_id, number: x.number, template_id: x.template_id, template_version: null, element_id: x.element_id,
        element_activity_id: x.element_activity_id ?? null, status: 'requested', result: null, requested_by: myId(), requested_at: t, requested_for: x.requested_for ?? null,
        inspector_id: null, inspected_at: null, consultant_name: null, remarks: x.remarks ?? null, reinspection_of: x.reinspection_of ?? null, created_at: t };
      put('inspections', i as unknown as Row, op);
      break;
    }
    case 'submit_inspection': {
      const x = payload as RpcMapField['submit_inspection'];
      const prev = get<Inspection>('inspections', x.id);
      if (prev && prev.status !== 'requested') break;
      const projectId = prev?.project_id ?? x.project_id!;
      const templateId = prev?.template_id ?? x.template_id!;
      const elementId = prev?.element_id ?? x.element_id!;
      const number = prev?.number ?? x.number!;
      const tpl = get<ChecklistTemplate>('checklist_templates', templateId);
      const evaluated: { is_critical: boolean; response: ReturnType<typeof evaluateItem> }[] = [];
      for (const ti of templateItems(templateId)) {
        const xi = x.items.find((a) => a.template_item_id === ti.id);
        const resp = evaluateItem(ti, xi) ?? 'na';
        evaluated.push({ is_critical: ti.is_critical, response: resp });
        let snagId: string | null = null;
        if (resp === 'fail' && (ti.is_critical || xi?.create_snag)) {
          snagId = xi?.snag_id ?? `local:${op}:snag${ti.seq}`;
          createSnag(op, {
            id: snagId, project_id: projectId, number: xi?.snag_number || `${number}-S${ti.seq}`, element_id: elementId,
            severity: ti.is_critical ? 'high' : 'medium', category: 'quality', trade: x.snag_defaults?.trade ?? null,
            title: `${ti.text} — failed (${tpl?.code ?? ''})`,
            description: [`Inspection ${number}`, xi?.value_num != null ? `Value ${xi.value_num}${ti.unit ? ` ${ti.unit}` : ''}` : '', xi?.value_text?.trim() ?? ''].filter(Boolean).join(' · '),
            assignee_user_id: x.snag_defaults?.assignee_user_id ?? null, assignee_party: x.snag_defaults?.assignee_party ?? null,
            due_date: x.snag_defaults?.due_date ?? null, source_type: 'inspection', source_id: x.id,
          });
        }
        if (xi) {
          put('inspection_items', { id: xi.id, inspection_id: x.id, project_id: projectId, template_item_id: ti.id, seq: ti.seq, text: ti.text, item_type: ti.item_type,
            is_critical: ti.is_critical, response: resp, value_num: xi.value_num ?? null, value_text: xi.value_text?.trim() || null, snag_id: snagId }, op);
        }
      }
      const result = outcomeOf(evaluated);
      const i: Inspection = {
        ...(prev ?? { requested_by: myId(), requested_at: t, requested_for: null, created_at: t, reinspection_of: x.reinspection_of ?? null } as Inspection),
        id: x.id, project_id: projectId, number, template_id: templateId, element_id: elementId,
        element_activity_id: prev?.element_activity_id ?? x.element_activity_id ?? null, status: 'completed' as InspectionStatus, result,
        template_version: tpl?.version ?? null, inspector_id: myId(), inspected_at: x.inspected_at ?? t, consultant_name: x.consultant_name ?? null,
        remarks: x.remarks || prev?.remarks || null,
      };
      put('inspections', i as unknown as Row, op);
      if (result !== 'fail' && i.element_activity_id) tryClearHoldPoint(i.element_activity_id, op);
      break;
    }
    case 'cancel_inspection': {
      const x = payload as RpcMapField['cancel_inspection'];
      const i = get<Inspection>('inspections', x.inspection_id);
      if (i?.status === 'requested') patch<Inspection>('inspections', i.id, { status: 'cancelled', remarks: x.comment || i.remarks }, op);
      break;
    }

    // ---------------------------------------------------------------- snags
    case 'save_snag': {
      const x = payload as RpcMapField['save_snag'];
      const prev = get<Snag>('snags', x.id);
      if (!prev) {
        createSnag(op, {
          id: x.id, project_id: x.project_id, number: x.number ?? '', title: x.title.trim(), element_id: x.element_id ?? null, location_text: x.location_text ?? null,
          category: x.category ?? null, trade: x.trade ?? null, severity: x.severity ?? 'medium', description: x.description ?? null,
          assignee_user_id: x.assignee_user_id ?? null, assignee_party: x.assignee_party ?? null, due_date: x.due_date ?? null,
          source_type: x.source_type ?? 'walk', source_id: x.source_id ?? null,
          ...(x.block_id ? { block_id: x.block_id } : {}), ...(x.level_id ? { level_id: x.level_id } : {}),
        });
      } else if (prev.status !== 'closed' && prev.status !== 'cancelled') {
        patch<Snag>('snags', x.id, { element_id: x.element_id ?? null, location_text: x.location_text ?? null, category: x.category ?? null, trade: x.trade ?? null,
          severity: x.severity ?? prev.severity, title: x.title.trim(), description: x.description ?? null, assignee_user_id: x.assignee_user_id ?? null,
          assignee_party: x.assignee_party ?? null, due_date: x.due_date ?? null }, op);
        localRow('snag_events', op, { snag_id: x.id, project_id: prev.project_id, action: 'edit', from_status: prev.status, to_status: prev.status, comment: null, actor: myId() });
      }
      break;
    }
    case 'snag_action': {
      const x = payload as RpcMapField['snag_action'];
      const s = get<Snag>('snags', x.snag_id);
      const mv = SNAG_MOVES[x.action];
      if (!s || !mv || !mv.from.includes(s.status)) break;
      patch<Snag>('snags', s.id, {
        status: mv.to,
        closed_by: mv.to === 'closed' ? myId() : mv.to === 'reopened' ? null : s.closed_by,
        closed_at: mv.to === 'closed' ? t : mv.to === 'reopened' ? null : s.closed_at,
      }, op);
      localRow('snag_events', op, { snag_id: s.id, project_id: s.project_id, action: x.action, from_status: s.status, to_status: mv.to, comment: x.comment?.trim() || null, actor: myId() });
      break;
    }

    // ---------------------------------------------------------------- pours
    case 'save_mix_design': {
      const x = payload as RpcMapField['save_mix_design'];
      put('mix_designs', {
        id: x.id, project_id: x.project_id, code: x.code?.trim() || x.grade.trim(), grade: x.grade.trim(), source: x.source, material_spec_id: x.material_spec_id ?? null,
        target_strength_mpa: x.target_strength_mpa ?? gradeCubeStrength(x.grade) ?? 0, cement_spec_id: x.cement_spec_id ?? null, cement_kg_per_m3: x.cement_kg_per_m3 ?? null,
        water_cement_ratio: x.water_cement_ratio ?? null, sand_m3_per_m3: x.sand_m3_per_m3 ?? null, aggregate_m3_per_m3: x.aggregate_m3_per_m3 ?? null,
        target_slump_mm: x.target_slump_mm ?? null, slump_tolerance_mm: x.slump_tolerance_mm ?? 25, remarks: x.remarks ?? null, deleted_at: null,
      }, op);
      break;
    }
    case 'save_pour': {
      const x = payload as RpcMapField['save_pour'];
      const prev = get<Pour>('pours', x.id);
      const md = get<MixDesign>('mix_designs', x.mix_design_id);
      const p: Pour = {
        id: x.id, project_id: x.project_id, number: prev?.number ?? x.number, pour_date: x.pour_date, mix_design_id: x.mix_design_id,
        method: x.method ?? (md?.source === 'site' ? 'site_batched' : 'ready_mix'), supplier_id: x.supplier_id ?? null, supplier_name: x.supplier_name ?? null,
        store_id: x.store_id ?? null, mr_id: x.mr_id ?? null, planned_m3: x.planned_m3, actual_m3: prev?.actual_m3 ?? null, start_at: prev?.start_at ?? null,
        end_at: prev?.end_at ?? null, weather: x.weather ?? null, curing_method: x.curing_method ?? null, status: prev?.status ?? 'planned', remarks: x.remarks ?? null,
        created_by: prev?.created_by ?? myId(), closed_by: prev?.closed_by ?? null, created_at: prev?.created_at ?? t,
      };
      put('pours', p as unknown as Row, op);
      // same element keeps its existing row id (as the server does)
      const existing = new Map(pourElements(x.id).map((e) => [e.element_id, e.id]));
      replaceChildren('pour_elements', 'pour_id', x.id, x.project_id,
        x.elements.map((e) => ({ ...e, id: existing.get(e.element_id) ?? e.id, planned_m3: e.planned_m3 ?? null })), op);
      break;
    }
    case 'add_pour_truck': {
      const x = payload as RpcMapField['add_pour_truck'];
      const pr = get<Pour>('pours', x.pour_id);
      if (!pr) break;
      const md = get<MixDesign>('mix_designs', pr.mix_design_id);
      const isStore = STORE_ROLES.includes(myRole() ?? '');
      const status: TruckStatus = !x.accepted ? 'rejected' : 'awaiting_receipt';
      const seqNo = x.seq ?? list<PourTruck>('pour_trucks', { parent: pr.id }).reduce((m, k) => Math.max(m, k.seq), 0) + 1;
      const truck: PourTruck = {
        id: x.id, pour_id: pr.id, project_id: pr.project_id, seq: seqNo, ticket_no: x.ticket_no.trim(), supplier_name: x.supplier_name ?? null, truck_plate: x.truck_plate ?? null,
        volume_m3: x.volume_m3, batched_at: x.batched_at ?? null, arrived_at: x.arrived_at ?? null, discharge_start: x.discharge_start ?? null, discharge_end: x.discharge_end ?? null,
        slump_mm: x.slump_mm ?? null, concrete_temp_c: x.concrete_temp_c ?? null, water_added_l: x.water_added_l ?? null, accepted: x.accepted, reject_reason: x.reject_reason ?? null,
        status, warnings: truckWarnings(x, md), grn_id: null, miv_id: null, recorded_by: myId(), received_by: null, created_at: t,
      };
      put('pour_trucks', truck as unknown as Row, op);
      startPour(pr.id, x.discharge_start ?? x.arrived_at, op);
      if (x.accepted && isStore) postTruck(op, truck, get<Pour>('pours', pr.id) ?? pr, x);
      break;
    }
    case 'receive_pour_truck': {
      const x = payload as RpcMapField['receive_pour_truck'];
      const truck = get<PourTruck>('pour_trucks', x.truck_id);
      const pr = truck ? get<Pour>('pours', truck.pour_id) : null;
      if (!truck || !pr || truck.status !== 'awaiting_receipt') break;
      postTruck(op, truck, pr, x);
      break;
    }
    case 'add_pour_batch': {
      const x = payload as RpcMapField['add_pour_batch'];
      const pr = get<Pour>('pours', x.pour_id);
      if (!pr) break;
      const at = x.batched_at ?? t;
      const seqNo = x.seq ?? list<{ seq: number }>('pour_batches', { parent: pr.id }).reduce((m, k) => Math.max(m, k.seq), 0) + 1;
      put('pour_batches', { id: x.id, pour_id: pr.id, project_id: pr.project_id, seq: seqNo, volume_m3: x.volume_m3 ?? null, cement_bags: x.cement_bags, sand_m3: x.sand_m3 ?? null,
        aggregate_m3: x.aggregate_m3 ?? null, water_l: x.water_l ?? null, slump_mm: x.slump_mm ?? null, mixer: x.mixer ?? null, batched_at: at, recorded_by: myId(), created_at: t }, op);
      startPour(pr.id, at, op);
      break;
    }
    case 'issue_pour_materials': {
      const x = payload as RpcMapField['issue_pour_materials'];
      const pr = get<Pour>('pours', x.pour_id);
      const store = x.store_id ?? pr?.store_id;
      if (!pr || !store) break;
      issueToPour(op, pr, store, x.miv_id, x.number, x.lines, x.issued_at ?? t, x.remarks || `Issued to pour ${pr.number}`);
      break;
    }
    case 'close_pour': {
      const x = payload as RpcMapField['close_pour'];
      const pr = get<Pour>('pours', x.pour_id);
      if (!pr || (pr.status !== 'planned' && pr.status !== 'in_progress')) break;
      if (x.cancel) { patch<Pour>('pours', pr.id, { status: 'cancelled', closed_by: myId(), remarks: x.remarks || pr.remarks }, op); break; }
      const vol = pr.method === 'ready_mix'
        ? list<PourTruck>('pour_trucks', { parent: pr.id }).filter((k) => k.status === 'posted').reduce((s, k) => s + Number(k.volume_m3), 0)
        : list<{ volume_m3: number | null }>('pour_batches', { parent: pr.id }).reduce((s, b) => s + Number(b.volume_m3 ?? 0), 0);
      const end = x.end_at ?? t;
      patch<Pour>('pours', pr.id, { status: 'completed', actual_m3: x.actual_m3 ?? vol, closed_by: myId(), end_at: end, start_at: pr.start_at ?? end, remarks: x.remarks || pr.remarks }, op);
      for (const pe of pourElements(pr.id)) {
        if (pe.deleted_at) continue;
        const cast = list<ElementActivity>('element_activities', { parent: pe.element_id })
          .filter((a) => /^(cast|concret)/i.test(a.name) && Number(a.reported_pct) < 100).sort((a, b) => a.seq - b.seq)[0];
        if (!cast) continue;
        patch<ElementActivity>('element_activities', cast.id, { reported_pct: 100 }, op);
        const el = get<Element>('elements', pe.element_id);
        if (el?.status === 'not_started') patch<Element>('elements', el.id, { status: 'in_progress', actual_start: el.actual_start ?? pr.pour_date }, op);
      }
      break;
    }

    // ---------------------------------------------------------------- cubes
    case 'save_cube_set': {
      const x = payload as RpcMapField['save_cube_set'];
      const pr = get<Pour>('pours', x.pour_id);
      if (!pr) break;
      const md = get<MixDesign>('mix_designs', pr.mix_design_id);
      const c: CubeSet = { id: x.id, project_id: pr.project_id, number: x.number, pour_id: pr.id, truck_id: x.truck_id ?? null, element_id: x.element_id ?? null,
        sampled_at: x.sampled_at ?? t, cubes_count: x.cubes_count ?? 3, cube_size_mm: x.cube_size_mm ?? 150, test_ages: [...(x.test_ages ?? [7, 28])].sort((a, b) => a - b),
        lab_name: x.lab_name ?? null, required_strength_mpa: Number(md?.target_strength_mpa ?? 0), result_early: null, result_28d: null, mean_28d_mpa: null, snag_id: null };
      put('cube_sets', { ...c, created_by: myId(), created_at: t }, op);
      break;
    }
    case 'record_cube_results': {
      const x = payload as RpcMapField['record_cube_results'];
      const c = get<CubeSet>('cube_sets', x.cube_set_id);
      if (!c) break;
      const fck = Number(c.required_strength_mpa);
      for (const r of x.results) {
        const str = r.strength_mpa ?? (r.load_kn != null ? cubeStrength(r.load_kn, c.cube_size_mm) : NaN);
        if (!Number.isFinite(str)) continue;
        const tested = r.tested_on ?? (() => { const d = new Date(c.sampled_at); d.setDate(d.getDate() + r.age_days); return d.toISOString().slice(0, 10); })();
        put('cube_results', { id: r.id, cube_set_id: c.id, project_id: c.project_id, cube_label: r.cube_label || 'cube', age_days: r.age_days, tested_on: tested,
          load_kn: r.load_kn ?? null, strength_mpa: str, density_kg_m3: r.density_kg_m3 ?? null, failure_mode: r.failure_mode ?? null,
          passed: cubePasses(str, r.age_days, fck), recorded_by: myId(), created_at: t }, op);
      }
      const all = cubeResults(c.id);
      const early = all.filter((r) => r.age_days < 28);
      const late = all.filter((r) => r.age_days >= 28);
      const resultEarly = early.length ? (early.every((r) => r.passed) ? 'ok' : 'low') : c.result_early;
      const mean = late.length ? late.reduce((s, r) => s + Number(r.strength_mpa), 0) / late.length : null;
      const min = late.length ? Math.min(...late.map((r) => Number(r.strength_mpa))) : null;
      const result28 = mean != null && min != null ? (mean >= fck && min >= fck - 4 ? 'pass' : 'fail') : c.result_28d;
      let snagId = c.snag_id;
      if (result28 === 'fail' && c.result_28d !== 'fail') {
        const pr = get<Pour>('pours', c.pour_id);
        const el = c.element_id ?? pourElements(c.pour_id).filter((e) => !e.deleted_at).sort((a, b) => Number(b.planned_m3 ?? 0) - Number(a.planned_m3 ?? 0))[0]?.element_id ?? null;
        snagId = x.snag?.id ?? `local:${op}:cube`;
        createSnag(op, { id: snagId, project_id: c.project_id, number: x.snag?.number || `${c.number}-S1`, element_id: el, severity: 'critical', category: 'concrete strength', trade: 'concrete',
          title: `28-day cube failure ${c.number} (${mean!.toFixed(1)} < ${fck} MPa)`,
          description: `Pour ${pr?.number ?? ''}: mean ${mean!.toFixed(1)} MPa, min ${min!.toFixed(1)} MPa vs required ${fck} MPa. Consider cores / structural review.`,
          assignee_user_id: x.snag?.assignee_user_id ?? null, source_type: 'cube', source_id: c.id });
      }
      patch<CubeSet>('cube_sets', c.id, { result_early: resultEarly, result_28d: result28, mean_28d_mpa: mean != null ? Math.round(mean * 100) / 100 : c.mean_28d_mpa, snag_id: snagId }, op);
      break;
    }

    // ------------------------------------------------------------------ BBS
    case 'save_bbs': {
      const x = payload as RpcMapField['save_bbs'];
      const prev = get<BbsSchedule>('bbs_schedules', x.id);
      if (prev && prev.status !== 'draft') break;
      const rev = x.revision ?? prev?.revision ?? (list<BbsSchedule>('bbs_schedules', { parent: x.element_id }).reduce((m, b) => Math.max(m, b.revision + 1), 0));
      put('bbs_schedules', { id: x.id, project_id: x.project_id, number: prev?.number ?? x.number, element_id: x.element_id, revision: rev, drawing_ref: x.drawing_ref ?? null,
        remarks: x.remarks ?? null, status: 'draft', created_by: prev?.created_by ?? myId(), approved_by: null, approved_at: null, deleted_at: null, created_at: t }, op);
      replaceChildren('bbs_lines', 'bbs_id', x.id, x.project_id, x.lines.map((l, i) => {
        const spec = l.material_spec_id ? get<{ grade: string }>('material_specs', l.material_spec_id) : null;
        const dia = l.diameter_mm ?? specDiameter(spec?.grade) ?? 0;
        const n = l.no_of_members ?? 1;
        return { ...l, line_no: i + 1, diameter_mm: dia, no_of_members: n, material_spec_id: l.material_spec_id ?? null, shape_code: l.shape_code ?? null,
          total_length_m: Math.round(n * l.bars_per_member * l.cut_length_m * 1000) / 1000, unit_weight_kg_m: Math.round(dia * dia / 162 * 10000) / 10000,
          weight_kg: Math.round(n * l.bars_per_member * l.cut_length_m * dia * dia / 162 * 1000) / 1000 };
      }), op);
      break;
    }
    case 'approve_bbs': {
      const x = payload as RpcMapField['approve_bbs'];
      const b = get<BbsSchedule>('bbs_schedules', x.bbs_id);
      if (!b || b.status !== 'draft') break;
      for (const o of list<BbsSchedule>('bbs_schedules', { parent: b.element_id })) {
        if (o.id !== b.id && o.status === 'approved') patch<BbsSchedule>('bbs_schedules', o.id, { status: 'superseded' }, op);
      }
      patch<BbsSchedule>('bbs_schedules', b.id, { status: 'approved', approved_by: myId(), approved_at: t }, op);
      break;
    }
    default:
      break;
  }
}

/** Reviewer roles (snag close/reopen/cancel, inspection perform) — UI helper. */
export const isReviewer = () => REVIEWERS.includes(myRole() ?? '');
