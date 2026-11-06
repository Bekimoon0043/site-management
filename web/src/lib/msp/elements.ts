// Elements from an MS Project building schedule. Building programmes are written floor × trade × element
// ("1st Floor › B] REBAR › c) To elevation Columns") or trade × element with the level in the name
// ("4.1 FORMWORK › i) In 1st Basement floor slab"). The detector reads each work task's own name, then its
// ancestors (nearest first), for three things: the LEVEL (basement / ground / Nth floor / roof), the ELEMENT
// TYPE (columns, shear walls, lift shaft, slab & beams, staircase, mat, footing, retaining wall, blockwork …)
// and the TRADE (formwork, rebar, concrete, masonry). Work tasks with the same level × element type become one
// element (e.g. L1-COL "Columns, 1st floor") linked to its formwork, rebar and concrete tasks.
// Server side: create_elements_from_schedule (migration 20261103000040).
import { normalizeUnit } from './boq';

export interface ElTask {
  id: string; name: string; parent_id: string | null; is_summary: boolean;
  wbs?: string | null; start?: string | null; finish?: string | null;
}
export type Trade = 'formwork' | 'rebar' | 'concrete' | 'masonry';
export type Confidence = 'high' | 'medium' | 'low';
export interface LevelInfo { code: string; name: string; sort_order: number }
export interface ElTypeInfo { element_type: string; code: string; label: string }
export interface DetectedElementTask { task_id: string; name: string; trade: Trade | null }
export interface DetectedElement {
  key: string; code: string; level_code: string | null; element_type: string; type_code: string; label: string;
  confidence: Confidence; note: string | null; tasks: DetectedElementTask[]; start: string | null; finish: string | null;
}
export interface ElementDetection {
  levels: LevelInfo[]; elements: DetectedElement[]; basements: number;
  /** work tasks that are not building elements (earthworks, finishes …) */
  other_tasks: number; work_tasks: number;
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/&amp;/g, '&').replace(/[‐-―]/g, '-').toLowerCase().replace(/\s+/g, ' ').trim();

const ORD: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
};
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
export const levelInfo = (code: string): LevelInfo => {
  if (code === 'G') return { code, name: 'Ground floor', sort_order: 0 };
  if (code === 'RF') return { code, name: 'Roof', sort_order: 1000 };
  if (code === 'FDN') return { code, name: 'Foundation', sort_order: -100 };
  const b = code.match(/^B(\d+)$/); if (b) return { code, name: `Basement ${b[1]}`, sort_order: -Number(b[1]) };
  const l = code.match(/^L(\d+)$/); if (l) return { code, name: `${ordinal(Number(l[1]))} floor`, sort_order: Number(l[1]) };
  return { code, name: code, sort_order: 0 };
};

/** Level named in a text: 'B2', 'G', 'L7', 'RF', 'B?' (basement, no number) or null. */
export function parseLevel(text: string): string | null {
  // building designations ("2B+G+15 Apartment", "G+4 building") describe the whole building, not a level
  const t = norm(text).replace(/\b\d? ?b ?\+ ?g ?\+ ?\d{1,2}\b/g, ' ')
    .replace(/\bg ?\+ ?\d{1,2}(?= ?(apartment|building|mixed|residential|commercial|office|hotel|mall|master|project|tower|block))/g, ' ').trim();
  if (!t) return null;
  if (/\b(roof|roof ?top|terrace)\b|ጣሪያ/.test(t) && !/\broofing\b/.test(t)) return 'RF';
  let m = t.match(/\b(\d{1,2}) ?(st|nd|rd|th)? ?basement/) ?? t.match(/basement (?:level |floor )?(\d{1,2})\b/) ?? t.match(/\bb ?-? ?(\d)\b(?! ?\+)/);
  if (m) return `B${Number(m[1])}`;
  m = t.match(/\b(first|second|third|fourth|fifth) basement/);
  if (m) return `B${ORD[m[1]]}`;
  if (/\bbasement\b|ቤዝመንት/.test(t)) return 'B?';
  if (/\bground\b|\bg\.? ?f\b|\bg ?\+ ?0\b|ምድር ቤት/.test(t)) return 'G';
  m = t.match(/\b(\d{1,2}) ?(?:st|nd|rd|th) ?(?:floor|fl\b|fl\.|level|storey|story)/) ?? t.match(/\b(?:floor|level|storey|story) ?-? ?(\d{1,2})\b/)
    ?? t.match(/\bg ?\+ ?(\d{1,2})\b(?! ?\+)/) ?? t.match(/(\d{1,2}) ?ኛ ?ፎቅ/) ?? t.match(/\b(?:l|fl) ?-? ?(\d{1,2})\b(?! ?(?:mm|cm|m)\b)/);
  if (m) return `L${Number(m[1])}`;
  m = t.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth) (?:floor|level|storey)/);
  if (m) return `L${ORD[m[1]]}`;
  return null;
}

const NOT_ELEMENT = /lean concrete|blinding|damp ?proof|membrane|excavat|backfill|\bfill(ing)?\b|earth ?work|shoring|drain|water ?proof|plaster|paint|tile|tiling|ceiling|door|window|electrical|sanitary|plumb|mobili[sz]|clearing|setting out|survey|curing compound|scaffold|demolition|hoarding|cleaning|handover/;
// Whole sections that are not building elements, even when a task inside names one ("rebar for shoring piles",
// "plaster to stair case soffits"): any ancestor matching this excludes the task.
const NOT_ELEMENT_SECTION = /excavat|earth ?work|shoring|drain|plaster|paint|\bfinish(es|ing)?\b|tiling|\btiles?\b|ceiling|joinery|\bdoors?\b|\bwindows?\b|electrical|sanitary|plumb|water ?proof|roofing|steel structure|landscap|external works?|mechanical|\bmep\b|fire fighting|lift install|elevator install/;
const TYPES: [RegExp, ElTypeInfo][] = [
  [/\b(lift|elevator)\b/, { element_type: 'wall', code: 'LS', label: 'Lift shaft' }],
  [/shear ?-?walls?|shearwall/, { element_type: 'wall', code: 'SW', label: 'Shear walls' }],
  [/retaining ?walls?|basement walls?/, { element_type: 'wall', code: 'RW', label: 'Retaining walls' }],
  [/\b(flat )?mat\b|\braft\b/, { element_type: 'footing', code: 'MAT', label: 'Mat foundation' }],
  [/pile ?caps?/, { element_type: 'footing', code: 'PC', label: 'Pile caps' }],
  [/\b(bored |cast[- ]in[- ]place )?piles?\b/, { element_type: 'footing', code: 'PL', label: 'Piles' }],
  [/(grade|ground|tie|plinth|foundation) ?beams?/, { element_type: 'beam', code: 'GB', label: 'Grade beams' }],
  [/footings?|foundations?|ፋውንዴሽን|ፉቲንግ/, { element_type: 'footing', code: 'FTG', label: 'Footings' }],
  [/stair ?-?cases?|\bstairs?\b|ደረጃ/, { element_type: 'staircase', code: 'ST', label: 'Staircase' }],
  [/\bcol(u|o)?m(n|ns|s)?\b|colum|ኮለን|ኮሎን/, { element_type: 'column', code: 'COL', label: 'Columns' }],
  [/slabs?\b|ስላብ|\bdeck\b/, { element_type: 'slab', code: 'SLB', label: 'Slab & beams' }],
  [/\bbeams?\b|ቢም/, { element_type: 'beam', code: 'BM', label: 'Beams' }],
  [/\bhcb\b|block ?-?work|masonry|brick|partition/, { element_type: 'wall', code: 'BW', label: 'Block walls' }],
  [/parapet/, { element_type: 'wall', code: 'PW', label: 'Parapet walls' }],
  [/\bwalls?\b|ግድግዳ/, { element_type: 'wall', code: 'WL', label: 'Walls' }],
];

/** Element type named in a text, or null ('excluded' for work that is not a building element). */
export function parseElementType(text: string): ElTypeInfo | 'excluded' | null {
  const t = norm(text);
  if (!t) return null;
  if (NOT_ELEMENT.test(t)) return 'excluded';
  for (const [re, info] of TYPES) {
    if (!re.test(t)) continue;
    if (info.code === 'PL' && /shoring|sheet/.test(t)) return 'excluded';
    if (info.code === 'SLB') {
      const roof = /roof/.test(t);
      const beams = /beam/.test(t);
      return { ...info, label: `${roof ? 'Roof slab' : 'Floor slab'}${beams ? ' & beams' : ''}` };
    }
    return info;
  }
  return null;
}

export function parseTrade(text: string): Trade | null {
  const t = norm(text);
  if (/form ?-?work|shutter/.test(t)) return 'formwork';
  if (/re-?bar|reinforc|steel bar|bar bending/.test(t)) return 'rebar';
  if (/\bhcb\b|block ?-?work|masonry|brick/.test(t)) return 'masonry';
  if (/concr|casting|\bpour|ኮንክሪት/.test(t)) return 'concrete';
  return null;
}

const firstOf = <T,>(texts: string[], f: (s: string) => T | null): T | null => {
  for (const s of texts) { const v = f(s); if (v != null) return v; }
  return null;
};

export function detectElements(tasks: ElTask[], opts: { projectName?: string | null; scheduleName?: string | null } = {}): ElementDetection {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const chain = (t: ElTask) => {
    const out: string[] = [t.name];
    let p = t.parent_id ? byId.get(t.parent_id) : undefined;
    for (let i = 0; p && i < 20; i++) { out.push(p.name); p = p.parent_id ? byId.get(p.parent_id) : undefined; }
    return out;
  };
  // basements: "2B+G+15" in the project / schedule / top task name, else the highest numbered basement used
  let basements = 0;
  for (const s of [opts.projectName, opts.scheduleName, ...tasks.filter((t) => !t.parent_id).map((t) => t.name)]) {
    const m = norm(s).match(/(\d)? ?b ?\+ ?g\b/);
    if (m) { basements = Math.max(basements, Number(m[1] ?? 1)); }
  }
  const work = tasks.filter((t) => !t.is_summary);
  for (const t of work) for (const s of chain(t)) { const l = parseLevel(s); const b = l?.match(/^B(\d+)$/); if (b) basements = Math.max(basements, Number(b[1])); }

  const groups = new Map<string, DetectedElement>();
  let other = 0;
  for (const t of work) {
    const names = chain(t);
    // element type: own name; a generic leaf ("Structural concrete", "Formwork") takes it from its parent
    let type: ElTypeInfo | null = null;
    let excluded = false;
    for (const s of names) {
      const r = parseElementType(s);
      if (r === 'excluded') { if (s === t.name) excluded = true; break; }
      if (r) { type = r; break; }
    }
    if (excluded || !type || names.slice(1).some((s) => NOT_ELEMENT_SECTION.test(norm(s)))) { other++; continue; }
    const inSub = names.some((s) => /sub ?-?structur|substructur|below ground/.test(norm(s)));
    let level = firstOf(names, parseLevel);
    let confidence: Confidence = 'high';
    let note: string | null = null;
    if (level === 'B?') {
      level = basements > 1 ? `B${basements}` : 'B1';
      if (basements > 1) { confidence = 'medium'; note = `“Basement” without a number — put on the lowest basement (B${basements}); change it if it covers all basements`; }
    }
    if (!level && (inSub || type.element_type === 'footing')) {
      level = basements > 0 ? `B${basements}` : 'FDN';
      confidence = 'medium';
      note = basements > 0 ? `Sub-structure item without a level — put on B${basements}` : 'Foundation level';
    }
    if (!level && type.code === 'BW') { note = 'Not split by floor in the schedule — one element for the whole block'; confidence = 'medium'; }
    else if (!level) { confidence = 'low'; note = 'No level found in the task or its parents'; }
    const key = `${level ?? '-'}|${type.code}`;
    let g = groups.get(key);
    if (!g) {
      const lv = level ? levelInfo(level) : null;
      g = { key, code: level ? `${level}-${type.code}` : type.code, level_code: level, element_type: type.element_type, type_code: type.code,
        label: `${type.label}${lv ? `, ${lv.name}` : ''}`, confidence, note, tasks: [], start: null, finish: null };
      groups.set(key, g);
    } else if (confidence !== 'high' && g.confidence === 'high') { g.confidence = confidence; g.note = note; }
    g.tasks.push({ task_id: t.id, name: t.wbs ? `${t.wbs} ${t.name}` : t.name, trade: firstOf(names, parseTrade) });
    if (t.start && (!g.start || t.start < g.start)) g.start = t.start;
    if (t.finish && (!g.finish || t.finish > g.finish)) g.finish = t.finish;
  }
  const elements = [...groups.values()].sort((a, b) =>
    (levelInfo(a.level_code ?? '').sort_order - levelInfo(b.level_code ?? '').sort_order) || (a.level_code ?? '').localeCompare(b.level_code ?? '') || a.code.localeCompare(b.code));
  const levels = [...new Set(elements.map((e) => e.level_code).filter((x): x is string => !!x))].map(levelInfo).sort((a, b) => a.sort_order - b.sort_order);
  return { levels, elements, basements, other_tasks: other, work_tasks: work.length };
}

/** Existing level for a detected code: same code, or a name that parses to it ("1st Floor" → L1). */
export function matchLevel<T extends { code: string; name: string }>(code: string, existing: T[]): T | undefined {
  const up = code.toUpperCase();
  return existing.find((l) => l.code.toUpperCase() === up) ?? existing.find((l) => parseLevel(l.name) === code || parseLevel(l.code) === code);
}

// ---------------------------------------------------------------------------
// Activities and take-offs
// ---------------------------------------------------------------------------
const TRADE_ACTIVITY: Record<Trade, RegExp> = {
  formwork: /formwork|shoring/i, rebar: /rebar/i, concrete: /casting|curing/i, masonry: /blockwork|masonry/i,
};
/** Activity range of an element type's template that a trade covers, e.g. concrete → Casting..Curing. */
export function activityRange(trade: Trade | null, templates: { seq: number; name: string }[]): { from: number; to: number } | null {
  if (!trade) return null;
  const seqs = templates.filter((t) => TRADE_ACTIVITY[trade].test(t.name)).map((t) => t.seq);
  return seqs.length ? { from: Math.min(...seqs), to: Math.max(...seqs) } : null;
}

export interface SpecLite { id: string; material_name: string; grade: string; uom: string; label: string }
export interface BoqLinkLite { task_id: string; boq_item_id: string; qty_share: number; unit: string | null; description: string }
export interface Norms {
  concrete_spec: string | null;                    // spec id (m3 of ready-mix per m3)
  rebar_spec: Record<string, string | null>;      // element_type → spec id (kg)
  binding_wire_spec: string | null; binding_wire_per_kg: number;
  hcb_spec: string | null; hcb_per_m2: number;
  cement_spec: string | null; mortar_cement_per_m2: number;   // qtl per m2 of blockwork
  sand_spec: string | null; mortar_sand_per_m2: number;       // m3 per m2
}
const find = (specs: SpecLite[], mat: RegExp, grade?: RegExp) =>
  specs.find((s) => mat.test(s.material_name) && (!grade || grade.test(s.grade)))?.id ?? null;

export function defaultNorms(specs: SpecLite[]): Norms {
  // first preferred diameter that exists in the catalogue, else any rebar
  const rebar = (...gs: RegExp[]) => gs.map((g) => find(specs, /rebar|reinforc/i, g)).find(Boolean) ?? find(specs, /rebar|reinforc/i);
  return {
    concrete_spec: find(specs, /concrete/i, /c-?25/i) ?? find(specs, /concrete/i),
    rebar_spec: { footing: rebar(/ø ?20\b/i, /ø ?16\b/i), column: rebar(/ø ?16\b/i, /ø ?20\b/i), wall: rebar(/ø ?12\b/i), slab: rebar(/ø ?12\b/i, /ø ?10\b/i),
      beam: rebar(/ø ?16\b/i, /ø ?14\b/i), staircase: rebar(/ø ?12\b/i) },
    binding_wire_spec: find(specs, /binding/i), binding_wire_per_kg: 0.009,
    hcb_spec: find(specs, /hcb|block/i, /20/), hcb_per_m2: 12.5,
    cement_spec: find(specs, /cement/i, /ppc/i) ?? find(specs, /cement/i), mortar_cement_per_m2: 0.08,
    sand_spec: find(specs, /^sand/i), mortar_sand_per_m2: 0.03,
  };
}

const toKg = (unit: string | null) => { const u = (normalizeUnit(unit) ?? '').toLowerCase(); return u === 'kg' ? 1 : /^(t|ton|tonne|tons|tonnes)$/.test(u) ? 1000 : u === 'qtl' ? 100 : null; };
const isUnit = (unit: string | null, u: string) => (normalizeUnit(unit) ?? '').toLowerCase() === u;

export interface Takeoff { material_spec_id: string; boq_item_id: string | null; qty: number }
/** Planned material per element from its tasks' BoQ quantities × norms (one row per material). */
export function elementTakeoffs(el: DetectedElement, links: BoqLinkLite[], n: Norms, concreteFor?: (desc: string) => string | null): Takeoff[] {
  const out = new Map<string, Takeoff>();
  const add = (spec: string | null, boq: string, qty: number) => {
    if (!spec || !(qty > 0)) return;
    const cur = out.get(spec);
    if (cur) { cur.qty += qty; if (cur.boq_item_id !== boq) cur.boq_item_id = cur.boq_item_id ?? boq; }
    else out.set(spec, { material_spec_id: spec, boq_item_id: boq, qty });
  };
  for (const t of el.tasks) {
    for (const l of links.filter((x) => x.task_id === t.task_id)) {
      const q = Number(l.qty_share) || 0;
      if (t.trade === 'concrete' && isUnit(l.unit, 'm3')) add(concreteFor?.(l.description) ?? n.concrete_spec, l.boq_item_id, q);
      else if (t.trade === 'rebar') {
        const k = toKg(l.unit);
        if (k) { add(n.rebar_spec[el.element_type] ?? null, l.boq_item_id, q * k); add(n.binding_wire_spec, l.boq_item_id, q * k * n.binding_wire_per_kg); }
      } else if (t.trade === 'masonry' && isUnit(l.unit, 'm2')) {
        add(n.hcb_spec, l.boq_item_id, q * n.hcb_per_m2);
        add(n.cement_spec, l.boq_item_id, q * n.mortar_cement_per_m2);
        add(n.sand_spec, l.boq_item_id, q * n.mortar_sand_per_m2);
      }
    }
  }
  return [...out.values()].map((x) => ({ ...x, qty: Math.round(x.qty * 1000) / 1000 }));
}

/** Concrete spec named in a BoQ description ("C-25", "C 30/37"), else null. */
export function concreteSpecFor(specs: SpecLite[]): (desc: string) => string | null {
  const conc = specs.filter((s) => /concrete/i.test(s.material_name));
  return (desc) => {
    const m = desc.match(/\bc ?-? ?(\d{2})\b/i);
    if (!m) return null;
    return conc.find((s) => new RegExp(`c-?${m[1]}\\b`, 'i').test(s.grade))?.id ?? null;
  };
}
