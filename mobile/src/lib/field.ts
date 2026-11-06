// Field & quality read helpers over the local store (diary, inspections, snags,
// pours, cubes, rebar). Pure reads — writes go through enqueue() in sync.ts and
// are applied locally by optimistic-field.ts. Everything here works offline.
import { get, list } from './db';
import { jf, rowsWhere } from './counts';
import { elementLabel, specLabel } from './queries';
import { addDays, fmtQty, isoDate, today } from './format';
import type { Element, ElementActivity, ElementTakeoff, Grn, Material, MaterialSpec, Miv, ProgressUpdate, StockLedgerEntry } from './contract';
import type {
  BbsLine, BbsSchedule, ChecklistItemType, ChecklistTemplate, ChecklistTemplateItem, CubeResult, CubeSet, DiaryAddendum,
  DiaryDelay, DiaryElement, DiaryEquipment, DiaryInstruction, DiaryLabour, DiaryVisitor, Inspection, InspectionOutcome,
  ItemResponse, LabourTrade, MixDesign, Pour, PourBatch, PourElement, PourTruck, RebarFlag, SiteDiary, Snag, TruckWarning,
} from './contract-field';

// ---------------------------------------------------------------------------
// Shared rules (mirrors of the SQL helpers in 20261029000006_field_quality.sql)
// ---------------------------------------------------------------------------

/** Local calendar date of a timestamp (device time zone = site time zone). */
export const localDate = (ts: string | null | undefined) => (ts ? isoDate(new Date(ts)) : '');
/** [start, end) ISO bounds of a local day, for range filters on timestamp columns. */
export const dayBounds = (date: string) => [new Date(`${date}T00:00:00`).toISOString(), new Date(`${addDays(date, 1)}T00:00:00`).toISOString()] as const;

export const specDiameter = (grade: string | null | undefined): number | null => {
  const m = /(?:Ø|ø|Φ|φ|dia\.?\s*)\s*(\d{1,2})/i.exec(grade ?? '');
  return m ? Number(m[1]) : null;
};
export const uomKg = (uom: string | null | undefined): number | null => {
  const u = (uom ?? '').trim().toLowerCase();
  return u === 'kg' ? 1 : u === 'qtl' || u === 'quintal' ? 100 : u === 'tonne' || u === 't' || u === 'ton' ? 1000 : u === 'bag' || u === 'bag (50kg)' ? 50 : null;
};
export const gradeCubeStrength = (grade: string | null | undefined): number | null => {
  const g = grade ?? '';
  const pair = /(\d+)\s*\/\s*(\d+)/.exec(g);
  if (pair) return Number(pair[2]);
  const one = /(\d+)/.exec(g);
  return one ? Number(one[1]) : null;
};
export const cubeAgeFactor = (age: number) =>
  age >= 28 ? 1 : age >= 21 ? 0.95 : age >= 14 ? 0.85 : age >= 7 ? 0.65 : age >= 3 ? 0.4 : 0.25;
export const cubePasses = (strength: number, age: number, fck: number) => (age >= 28 ? strength >= fck - 4 : strength >= fck * cubeAgeFactor(age));
export const cubeStrength = (loadKn: number, sizeMm: number) => Math.round((loadKn * 1000 / (sizeMm * sizeMm)) * 100) / 100;

export function truckWarnings(x: { batched_at?: string | null; arrived_at?: string | null; water_added_l?: number | null; slump_mm?: number | null; concrete_temp_c?: number | null }, md: MixDesign | null): TruckWarning[] {
  const w: TruckWarning[] = [];
  if (x.batched_at && x.arrived_at && new Date(x.arrived_at).getTime() - new Date(x.batched_at).getTime() > 90 * 60e3) w.push('late_arrival');
  if ((x.water_added_l ?? 0) > 0) w.push('water_added');
  if (x.slump_mm != null && md?.target_slump_mm != null && Math.abs(x.slump_mm - md.target_slump_mm) > Number(md.slump_tolerance_mm ?? 25)) w.push('slump_out_of_range');
  if ((x.concrete_temp_c ?? 0) > 32) w.push('hot_concrete');
  return w;
}
export const WARNING_LABELS: Record<TruckWarning, string> = {
  late_arrival: 'Late (> 90 min)', water_added: 'Water added', slump_out_of_range: 'Slump out of range', hot_concrete: 'Hot concrete',
};

// ---------------------------------------------------------------------------
// Site diary
// ---------------------------------------------------------------------------

export const labourTrades = () => list<LabourTrade>('labour_trades').sort((a, b) => a.sort_order - b.sort_order);

export function diaryFor(projectId: string, date: string, blockId: string | null): (SiteDiary & { _pending?: string }) | null {
  return rowsWhere<SiteDiary>('site_diaries', projectId,
    `AND ${jf('diary_date')} = ? AND ${blockId ? `${jf('block_id')} = ?` : `${jf('block_id')} IS NULL`}`,
    blockId ? [date, blockId] : [date], `${jf('created_at')} ASC`, 1)[0] ?? null;
}

export function diaryChildren(diaryId: string) {
  return {
    labour: list<DiaryLabour>('diary_labour', { parent: diaryId }),
    equipment: list<DiaryEquipment>('diary_equipment', { parent: diaryId }),
    delays: list<DiaryDelay>('diary_delays', { parent: diaryId }),
    visitors: list<DiaryVisitor>('diary_visitors', { parent: diaryId }),
    instructions: list<DiaryInstruction>('diary_instructions', { parent: diaryId }),
    elements: list<DiaryElement>('diary_elements', { parent: diaryId }),
    addenda: list<DiaryAddendum>('diary_addenda', { parent: diaryId }).sort((a, b) => a.created_at.localeCompare(b.created_at)),
  };
}

export interface ActivityItem { kind: 'grn' | 'miv' | 'progress' | 'pour' | 'inspection' | 'snag'; id: string; number: string; summary: string; status: string; elementId: string | null }

/** Local "today on site" (same sources as v_diary_activity / get_diary_summary). */
export function daySummary(projectId: string, date: string): ActivityItem[] {
  const [a, b] = dayBounds(date);
  const out: ActivityItem[] = [];
  for (const g of rowsWhere<Grn>('grns', projectId, `AND ${jf('received_at')} >= ? AND ${jf('received_at')} < ?`, [a, b], `${jf('received_at')} ASC`)) {
    const lines = list<{ material_spec_id: string; qty_accepted: number; line_no: number }>('grn_lines', { parent: g.id }).sort((x, y) => x.line_no - y.line_no);
    out.push({ kind: 'grn', id: g.id, number: g.number, status: g.status, elementId: null,
      summary: `${g.supplier_name ?? 'Receipt'}: ${lines.map((l) => `${specLabel(l.material_spec_id)} ${fmtQty(l.qty_accepted)}`).join(', ')}` });
  }
  for (const m of rowsWhere<Miv>('mivs', projectId, `AND ${jf('issued_at')} >= ? AND ${jf('issued_at')} < ?`, [a, b], `${jf('issued_at')} ASC`)) {
    const lines = list<{ material_spec_id: string; qty: number; element_id: string; line_no: number }>('miv_lines', { parent: m.id }).sort((x, y) => x.line_no - y.line_no);
    out.push({ kind: 'miv', id: m.id, number: m.number, status: m.status, elementId: lines[0]?.element_id ?? null,
      summary: lines.slice(0, 4).map((l) => `${specLabel(l.material_spec_id)} ${fmtQty(l.qty)} → ${elementLabel(l.element_id)}`).join(', ') + (lines.length > 4 ? ` +${lines.length - 4}` : '') });
  }
  for (const u of rowsWhere<ProgressUpdate>('progress_updates', projectId, `AND ${jf('report_date')} = ?`, [date])) {
    const act = get<ElementActivity>('element_activities', u.element_activity_id);
    out.push({ kind: 'progress', id: u.id, number: elementLabel(u.element_id), status: u.status, elementId: u.element_id,
      summary: `${act?.name ?? 'Activity'} ${Number(u.pct_complete)}%${u.verified_pct != null ? ` (verified ${Number(u.verified_pct)}%)` : ''}` });
  }
  for (const p of rowsWhere<Pour>('pours', projectId, `AND ${jf('pour_date')} = ?`, [date])) {
    const md = get<MixDesign>('mix_designs', p.mix_design_id);
    const els = list<PourElement>('pour_elements', { parent: p.id });
    out.push({ kind: 'pour', id: p.id, number: p.number, status: p.status, elementId: els[0]?.element_id ?? null,
      summary: `${md?.grade ?? ''} ${fmtQty(p.actual_m3 ?? p.planned_m3)} m3 — ${els.map((e) => elementLabel(e.element_id)).join(', ')}` });
  }
  for (const i of rowsWhere<Inspection>('inspections', projectId)) {
    if (localDate(i.inspected_at ?? i.requested_at ?? i.created_at) !== date) continue;
    const tpl = get<ChecklistTemplate>('checklist_templates', i.template_id);
    out.push({ kind: 'inspection', id: i.id, number: i.number, status: i.status, elementId: i.element_id,
      summary: `${tpl?.name ?? 'Inspection'} — ${elementLabel(i.element_id)}${i.result ? `: ${i.result}` : ` (${i.status})`}` });
  }
  for (const s of rowsWhere<Snag>('snags', projectId, `AND ${jf('created_at')} >= ? AND ${jf('created_at')} < ?`, [a, b])) {
    out.push({ kind: 'snag', id: s.id, number: s.number, status: s.status, elementId: s.element_id, summary: `${s.severity}: ${s.title}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inspections
// ---------------------------------------------------------------------------

/** Active checklists that apply to an element type (and, if given, clear the named hold-point activity). */
export function templatesFor(projectId: string, elementType: string | null, activityName?: string | null): ChecklistTemplate[] {
  const et = (elementType ?? '').toLowerCase();
  const an = (activityName ?? '').toLowerCase();
  return list<ChecklistTemplate>('checklist_templates')
    .filter((t) => t.is_active && !t.deleted_at && (!t.project_id || t.project_id === projectId)
      && (!et || (t.element_types ?? []).some((x) => x.toLowerCase() === et))
      && (!an || (t.hold_activities ?? []).some((x) => x.toLowerCase() === an)))
    .sort((a, b) => a.code.localeCompare(b.code));
}
export const templateItems = (templateId: string) =>
  list<ChecklistTemplateItem>('checklist_template_items', { parent: templateId }).filter((i) => !i.deleted_at).sort((a, b) => a.seq - b.seq);

export interface ItemAnswer { response?: ItemResponse; value_num?: number; value_text?: string }

/** Same evaluation as submit_inspection: value items are checked against min/max; a critical fail → fail. */
export function evaluateItem(ti: Pick<ChecklistTemplateItem, 'item_type' | 'min_value' | 'max_value'>, a: ItemAnswer | undefined): ItemResponse | null {
  if (!a) return null;
  let resp: ItemResponse | null = a.response ?? null;
  if (ti.item_type === 'value' && resp !== 'na') {
    if (a.value_num == null || Number.isNaN(a.value_num)) return null;
    resp = (ti.min_value == null || a.value_num >= Number(ti.min_value)) && (ti.max_value == null || a.value_num <= Number(ti.max_value)) ? 'pass' : 'fail';
  } else if (ti.item_type === 'text' && !resp) {
    resp = a.value_text?.trim() ? 'pass' : 'na';
  }
  return resp;
}
export function outcomeOf(items: { is_critical: boolean; response: ItemResponse | null }[]): InspectionOutcome {
  const fails = items.filter((i) => i.response === 'fail');
  return fails.some((i) => i.is_critical) ? 'fail' : fails.length ? 'conditional' : 'pass';
}

/** Hold-point state of an activity: checklists still needing a passing latest inspection. */
export function holdPointState(projectId: string, activityId: string): { holdPoint: boolean; cleared: boolean; pending: ChecklistTemplate[] } {
  const a = get<ElementActivity>('element_activities', activityId);
  if (!a || !a.is_hold_point) return { holdPoint: false, cleared: false, pending: [] };
  if (Number(a.verified_pct) >= 100) return { holdPoint: true, cleared: true, pending: [] };
  const e = get<Element>('elements', a.element_id);
  const ins = list<Inspection>('inspections', { parent: a.element_id }).filter((i) => i.element_activity_id === a.id && i.status === 'completed');
  const pending = templatesFor(projectId, e?.element_type ?? null, a.name).filter((t) => {
    const latest = ins.filter((i) => i.template_id === t.id).sort((x, y) => (y.inspected_at ?? y.created_at).localeCompare(x.inspected_at ?? x.created_at))[0];
    return !(latest && (latest.result === 'pass' || latest.result === 'conditional'));
  });
  return { holdPoint: true, cleared: pending.length === 0, pending };
}

export const itemTypeLabel: Record<ChecklistItemType, string> = { yes_no: 'Yes / no', value: 'Measured value', photo: 'Photo', text: 'Note' };

// ---------------------------------------------------------------------------
// Pours & cubes
// ---------------------------------------------------------------------------

export const mixDesigns = (projectId: string) =>
  list<MixDesign>('mix_designs', { project: projectId }).sort((a, b) => a.code.localeCompare(b.code));
export const pourElements = (pourId: string) =>
  list<PourElement>('pour_elements', { parent: pourId }).sort((a, b) => a.element_id.localeCompare(b.element_id));
export const pourTrucks = (pourId: string) => list<PourTruck>('pour_trucks', { parent: pourId }).sort((a, b) => a.seq - b.seq);
export const pourBatches = (pourId: string) => list<PourBatch>('pour_batches', { parent: pourId }).sort((a, b) => a.seq - b.seq);
export const cubeSets = (pourId: string) => list<CubeSet>('cube_sets', { parent: pourId }).sort((a, b) => a.sampled_at.localeCompare(b.sampled_at));
export const cubeResults = (setId: string) => list<CubeResult>('cube_results', { parent: setId }).sort((a, b) => a.age_days - b.age_days || a.cube_label.localeCompare(b.cube_label));

export function pourTotals(pourId: string) {
  const trucks = pourTrucks(pourId);
  const batches = pourBatches(pourId);
  const sum = (xs: { volume_m3: number | null }[]) => xs.reduce((s, x) => s + Number(x.volume_m3 ?? 0), 0);
  const posted = trucks.filter((x) => x.status === 'posted');
  const awaiting = trucks.filter((x) => x.status === 'awaiting_receipt');
  const rejected = trucks.filter((x) => x.status === 'rejected');
  return {
    trucks, batches, posted: sum(posted), awaiting: sum(awaiting), awaitingCount: awaiting.length, rejected: sum(rejected), rejectedCount: rejected.length,
    accepted: sum(posted) + sum(awaiting), batched: sum(batches), cementBags: batches.reduce((s, b) => s + Number(b.cement_bags), 0),
  };
}

/** Split a quantity over a pour's elements pro-rata by planned m³ (same as app.pour_issue). */
export function splitOverElements(pourId: string, qty: number): { element_id: string; qty: number }[] {
  const els = pourElements(pourId).filter((e) => !e.deleted_at);
  if (!els.length) return [];
  const total = els.reduce((s, e) => s + Number(e.planned_m3 ?? 0), 0);
  let rem = qty;
  return els.map((e, i) => {
    const alloc = i === els.length - 1 ? rem : Math.round(qty * (total > 0 ? Number(e.planned_m3 ?? 0) / total : 1 / els.length) * 1000) / 1000;
    rem -= alloc;
    return { element_id: e.element_id, qty: Math.round(alloc * 1000) / 1000 };
  }).filter((x) => x.qty > 0);
}

export interface CubeDue { setId: string; number: string; pourId: string; pourNumber: string; elementId: string | null; age: number; due: string; status: 'overdue' | 'due' | 'upcoming'; lab: string | null; cubes: number }

/** Same rows as v_cubes_due: one per set and test age without results. */
export function cubesDue(projectId: string, horizonDays = 7): CubeDue[] {
  const t0 = today();
  const out: CubeDue[] = [];
  for (const c of rowsWhere<CubeSet>('cube_sets', projectId)) {
    const done = new Set(cubeResults(c.id).map((r) => Number(r.age_days)));
    const pour = get<Pour>('pours', c.pour_id);
    for (const age of c.test_ages ?? [7, 28]) {
      if (done.has(Number(age))) continue;
      const due = addDays(localDate(c.sampled_at), Number(age));
      if (due > addDays(t0, horizonDays)) continue;
      out.push({ setId: c.id, number: c.number, pourId: c.pour_id, pourNumber: pour?.number ?? '', elementId: c.element_id, age: Number(age), due,
        status: due < t0 ? 'overdue' : due === t0 ? 'due' : 'upcoming', lab: c.lab_name, cubes: c.cubes_count });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

// ---------------------------------------------------------------------------
// Rebar BBS reconciliation (local mirror of v_rebar_reconciliation)
// ---------------------------------------------------------------------------

export interface RebarRow { diameter: number; bbsKg: number; takeoffKg: number; issuedKg: number; returnedKg: number; netKg: number; basisKg: number; variancePct: number | null; allowancePct: number; flag: RebarFlag }

export function currentBbs(elementId: string): BbsSchedule | null {
  const all = list<BbsSchedule>('bbs_schedules', { parent: elementId }).filter((b) => !b.deleted_at && b.status !== 'superseded');
  return all.sort((a, b) => (Number(b.status === 'approved') - Number(a.status === 'approved')) || b.revision - a.revision)[0] ?? null;
}
export const bbsLines = (bbsId: string) => list<BbsLine>('bbs_lines', { parent: bbsId }).filter((l) => !l.deleted_at).sort((a, b) => a.line_no - b.line_no);

export function rebarReconciliation(elementId: string): RebarRow[] {
  const el = get<Element>('elements', elementId);
  if (!el) return [];
  const rebar = new Map<string, { dia: number; kgf: number; wastage: number }>();
  const isRebar = (specId: string) => {
    if (rebar.has(specId)) return rebar.get(specId)!;
    const s = get<MaterialSpec>('material_specs', specId);
    const m = s ? get<Material>('materials', s.material_id) : null;
    const dia = s ? specDiameter(s.grade) : null;
    if (!s || m?.category !== 'Reinforcement' || dia == null) return null;
    const v = { dia, kgf: uomKg(s.uom) ?? 1, wastage: Number(s.wastage_pct ?? 0) };
    rebar.set(specId, v);
    return v;
  };
  const rows = new Map<number, { bbs: number; tk: number; iss: number; ret: number; allow: number | null }>();
  const row = (d: number) => { let r = rows.get(d); if (!r) { r = { bbs: 0, tk: 0, iss: 0, ret: 0, allow: null }; rows.set(d, r); } return r; };
  const cur = currentBbs(elementId);
  if (cur) for (const l of bbsLines(cur.id)) row(Number(l.diameter_mm)).bbs += Number(l.weight_kg);
  for (const t of list<ElementTakeoff>('element_takeoffs', { parent: elementId })) {
    if (t.deleted_at) continue;
    const r = isRebar(t.material_spec_id);
    if (!r) continue;
    const x = row(r.dia); x.tk += Number(t.planned_qty) * r.kgf; x.allow = Math.max(x.allow ?? 0, r.wastage);
  }
  for (const l of rowsWhere<StockLedgerEntry>('stock_ledger', el.project_id, `AND ${jf('element_id')} = ? AND ${jf('doc_type')} IN ('miv','mrn')`, [elementId])) {
    const r = isRebar(l.material_spec_id);
    if (!r) continue;
    const x = row(r.dia);
    if (l.doc_type === 'miv') x.iss -= Number(l.qty) * r.kgf; else x.ret += Number(l.qty) * r.kgf;
    x.allow = Math.max(x.allow ?? 0, r.wastage);
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([dia, x]) => {
    const net = x.iss - x.ret;
    const basis = x.bbs > 0 ? x.bbs : x.tk;
    const allow = x.allow ?? 3;
    const vp = basis > 0 ? (net / basis - 1) * 100 : null;
    const flag: RebarFlag = basis === 0 ? (net > 0 ? 'no_basis' : 'ok') : vp! > allow ? 'over' : el.status === 'completed' && vp! < -allow ? 'under' : 'ok';
    return { diameter: dia, bbsKg: r3(x.bbs), takeoffKg: r3(x.tk), issuedKg: r3(x.iss), returnedKg: r3(x.ret), netKg: r3(net), basisKg: r3(basis),
      variancePct: vp == null ? null : Math.round(vp * 100) / 100, allowancePct: allow, flag };
  });
}

export const FLAG_INFO: Record<RebarFlag, { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' }> = {
  ok: { label: 'Within allowance', tone: 'success' }, over: { label: 'Over-issued', tone: 'danger' },
  under: { label: 'Under-issued', tone: 'warning' }, no_basis: { label: 'No BBS / take-off', tone: 'warning' },
};

/** Hold points before casting that are not cleared yet (app.require_pour_hold_points). */
export function openPourHoldPoints(elementIds: string[]): { elementId: string; activity: ElementActivity }[] {
  const out: { elementId: string; activity: ElementActivity }[] = [];
  for (const eid of elementIds) {
    const acts = list<ElementActivity>('element_activities', { parent: eid }).sort((a, b) => a.seq - b.seq);
    const castSeq = acts.find((a) => /^(cast|concret)/i.test(a.name))?.seq ?? Number.MAX_SAFE_INTEGER;
    const open = acts.find((a) => a.is_hold_point && Number(a.verified_pct) < 100 && a.seq < castSeq);
    if (open) out.push({ elementId: eid, activity: open });
  }
  return out;
}

/** Planned concrete for an element from its take-off of the mix's concrete spec. */
export function plannedConcrete(elementId: string, specId: string | null): number | null {
  if (!specId) return null;
  const t = list<ElementTakeoff>('element_takeoffs', { parent: elementId }).find((x) => !x.deleted_at && x.material_spec_id === specId);
  return t ? Number(t.planned_qty) : null;
}
