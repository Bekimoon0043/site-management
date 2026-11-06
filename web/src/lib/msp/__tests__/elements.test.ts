// Elements from the schedule: a slice shaped like the client's 2B+G+15 master schedule (floor × trade × element in
// the super-structure, trade × element with the level in the name in the sub-structure).
import { describe, expect, it } from 'vitest';
import {
  activityRange, concreteSpecFor, defaultNorms, detectElements, elementTakeoffs, matchLevel, parseElementType, parseLevel, parseTrade,
  type BoqLinkLite, type ElTask, type SpecLite,
} from '../index';

let seq = 0;
const tasks: ElTask[] = [];
const add = (name: string, parent: string | null, summary = false, wbs?: string) => {
  const id = `t${++seq}`;
  tasks.push({ id, name, parent_id: parent, is_summary: summary, wbs: wbs ?? null, start: `2026-11-${String((seq % 28) + 1).padStart(2, '0')}`, finish: `2026-12-${String((seq % 28) + 1).padStart(2, '0')}` });
  return id;
};
const root = add('2B+G+15 Apartment Building Master Schedule', null, true, '1');
const sub = add(' SUB STRUCTURE', root, true, '1.2');
const exc = add(' 1. EXCAVATION & EARTHWORK', sub, true);
add('Bulk excavation in ordinary soil to a depth not exceeding 1500mm', exc);
add('Fill around Footing, Foundation Columns and RC Retaining wall', exc);
const shor = add(' 2. Shoring work', sub, true);
add('Reinforcement Steel Fabrication & Fixing for piles', shor);
add('Reinforcement bars for shotcrete wall', shor);
const conc = add(' 4. SUB-STRUCTURAL CONCRETE WORK', sub, true);
const fw = add(' 4.1 FORMWORK', conc, true);
const rb = add(' 4.2 REBAR', conc, true);
const cc = add(' 4.3 CONCRETE CASTING', conc, true);
const sc = add('Structural concrtete', cc, true);
add('Lean concrete', cc);
const mat = { f: add(' a) In Flat Mat slab', fw), r: add(' a) In Flat Mat slab', rb), c: add(' a) In Flat Mat slab', sc) };
add(' e) In basement level columns', fw); add(' e) In basement level columns', rb); add(' e) In basement level columns', sc);
add(' h) In 20cm thick Ground Floor Slab and Beam', fw); add(' i) In 1st Basement floor slab', rb);
const sup = add(' SUPER STRUCTURE', root, true, '1.4');
const ssc = add(' 1. SUPER STRUCTURAL CONCRETE WORK', sup, true);
for (const fl of ['Ground Floor', '1st Floor', '2nd Floor', '15th Floor']) {
  const f = add(fl, ssc, true);
  for (const [tr, label] of [['A] FORMWORK', 'f'], ['B] REBAR', 'r'], ['C] CONCRETE CASTING', 'c']] as const) {
    const g = add(tr, f, true);
    add(' a) To elevation lift Shaft', g); add(' b) To elevation shearwall', g); add(' c) To elevation Columns', g); add(' d) To Stair case', g);
    if (fl !== 'Ground Floor') add(' e) To Floor slab and Beam', g);
    void label;
  }
}
const roof = add('Roof', ssc, true);
add('To 15cm thick Roof slab and Beam', add('A] Form work', roof, true));
const bw = add(' 2. BLOCK WORK', sup, true);
add('20cm HCB Blockwork', bw);
const pl = add(' 5. PLASTERING WORK', sup, true);
add(' d) To stair case and Landing soffits (1st Basement to 15th Floor )', add(' Apply two coats of plastering', pl, true));

describe('parseLevel', () => {
  it.each([
    ['Ground Floor', 'G'], ['1st Floor', 'L1'], ['15th Floor', 'L15'], ['Floor 3', 'L3'], ['Level 7', 'L7'], ['L-4 slab', 'L4'],
    ['i) In 1st Basement floor slab', 'B1'], ['Basement 2 walls', 'B2'], ['B1 columns', 'B1'], ['second basement', 'B2'],
    ['e) In basement level columns', 'B?'], ['To 15cm thick Roof slab and Beam', 'RF'], ['3ኛ ፎቅ ኮለን', 'L3'], ['G+1 slab', 'L1'],
    ['2B+G+15 Apartment Building Master Schedule', null], ['G+4 building', null], ['ROOFING WORK', null], ['20cm HCB Blockwork', null],
  ])('%s → %s', (t, want) => expect(parseLevel(t)).toBe(want));
});

describe('parseElementType / parseTrade', () => {
  it.each([
    ['a) To elevation lift Shaft', 'LS'], ['b) To elevation shearwall', 'SW'], ['c) To elevation Columns', 'COL'], ['d) To Stair case', 'ST'],
    ['e) To Floor slab and Beam', 'SLB'], ['a) In Flat Mat slab', 'MAT'], ['b) In retaining wall', 'RW'], ['c) In Basement floor beam', 'BM'],
    ['grade beam GB-1', 'GB'], ['isolated footing F1', 'FTG'], ['20cm HCB Blockwork', 'BW'], ['colums C1-C12', 'COL'],
  ])('%s → %s', (t, code) => expect((parseElementType(t) as { code: string }).code).toBe(code));
  it('excludes work that is not a building element', () => {
    for (const t of ['Lean concrete', 'Bulk excavation', 'Supply and fix 4mm damp proof membrane', 'Boring holes for vertical shoring piles', 'Fill around footing'])
      expect(parseElementType(t)).toBe('excluded');
  });
  it('reads the trade', () => {
    expect([parseTrade('A] FORMWORK'), parseTrade('B] REBAR'), parseTrade('Structural concrtete'), parseTrade('4.3 CONCRETE CASTING'), parseTrade('20cm HCB Blockwork')])
      .toEqual(['formwork', 'rebar', 'concrete', 'concrete', 'masonry']);
  });
});

describe('detectElements on the 2B+G+15 slice', () => {
  const d = detectElements(tasks, { projectName: '2B+G+15 Apartment Building' });
  const el = (code: string) => d.elements.find((e) => e.code === code);
  it('finds the basements and the levels in elevation order', () => {
    expect(d.basements).toBe(2);
    expect(d.levels.map((l) => l.code)).toEqual(['B2', 'B1', 'G', 'L1', 'L2', 'L15', 'RF']);
  });
  it('one element per level × type, linked to its formwork / rebar / concrete tasks', () => {
    expect(el('L1-COL')!.tasks.map((t) => t.trade)).toEqual(['formwork', 'rebar', 'concrete']);
    expect(el('L1-COL')!.confidence).toBe('high');
    expect(el('L15-SLB')!.label).toBe('Floor slab & beams, 15th floor');
    expect(el('RF-SLB')!.label).toBe('Roof slab & beams, Roof');
    expect(el('G-SLB')!.tasks).toHaveLength(1);          // from the sub-structure "Ground Floor Slab and Beam"
    expect(el('B1-SLB')!.tasks[0].trade).toBe('rebar');
  });
  it('places sub-structure items without a number on the lowest basement, flagged for review', () => {
    expect(el('B2-MAT')!.tasks.map((t) => t.task_id)).toEqual([mat.f, mat.r, mat.c]);
    expect(el('B2-MAT')!.tasks.map((t) => t.trade)).toEqual(['formwork', 'rebar', 'concrete']);
    expect(el('B2-COL')!.confidence).toBe('medium');
    expect(el('B2-COL')!.note).toMatch(/lowest basement/);
  });
  it('blockwork not split by floor is one block-wide element; earthworks, shoring and plastering are not elements', () => {
    expect(el('BW')!.level_code).toBeNull();
    expect(d.elements.some((e) => /PL|GB|WL/.test(e.type_code))).toBe(false);
    expect(d.elements.flatMap((e) => e.tasks).some((t) => /plaster|soffit|shotcrete|piles|Fill/i.test(t.name))).toBe(false);
    expect(d.other_tasks).toBe(6);
  });
  it('matches existing project levels by code or name', () => {
    const existing = [{ code: 'GF', name: 'Ground floor' }, { code: '1F', name: '1st Floor' }, { code: 'B2', name: 'Basement 2' }];
    expect(matchLevel('G', existing)?.code).toBe('GF');
    expect(matchLevel('L1', existing)?.code).toBe('1F');
    expect(matchLevel('B2', existing)?.code).toBe('B2');
    expect(matchLevel('L7', existing)).toBeUndefined();
  });
});

describe('activities and take-offs', () => {
  const column = [{ seq: 1, name: 'Preparation' }, { seq: 2, name: 'Rebar fixing' }, { seq: 3, name: 'Formwork' }, { seq: 4, name: 'Rebar & formwork inspection' },
    { seq: 5, name: 'Casting' }, { seq: 6, name: 'Curing' }, { seq: 7, name: 'Stripping' }];
  it('maps a trade to its activity range', () => {
    expect(activityRange('formwork', column)).toEqual({ from: 3, to: 4 });
    expect(activityRange('concrete', column)).toEqual({ from: 5, to: 6 });
    expect(activityRange(null, column)).toBeNull();
  });
  const specs: SpecLite[] = [
    { id: 'c25', material_name: 'Concrete', grade: 'C-25/30', uom: 'm3', label: 'Concrete C-25/30' },
    { id: 'c30', material_name: 'Concrete', grade: 'C-30/37', uom: 'm3', label: 'Concrete C-30/37' },
    { id: 'r16', material_name: 'Rebar', grade: 'S-400 Ø16', uom: 'kg', label: 'Rebar S-400 Ø16' },
    { id: 'r12', material_name: 'Rebar', grade: 'S-400 Ø12', uom: 'kg', label: 'Rebar S-400 Ø12' },
    { id: 'bw', material_name: 'Binding wire', grade: 'No. 18', uom: 'kg', label: 'Binding wire No. 18' },
    { id: 'hcb', material_name: 'HCB', grade: '20cm Class B', uom: 'pcs', label: 'HCB 20cm' },
    { id: 'ppc', material_name: 'Cement', grade: 'PPC 32.5', uom: 'qtl', label: 'Cement PPC' },
    { id: 'sand', material_name: 'Sand', grade: '', uom: 'm3', label: 'Sand' },
  ];
  const n = defaultNorms(specs);
  const d = detectElements(tasks);
  const col = d.elements.find((e) => e.code === 'L1-COL')!;
  const [, r, c] = col.tasks;
  const links: BoqLinkLite[] = [
    { task_id: r.task_id, boq_item_id: 'b-rebar', qty_share: 2.5, unit: 'ton', description: 'Reinforcement S-400' },
    { task_id: c.task_id, boq_item_id: 'b-conc', qty_share: 18, unit: 'm³', description: 'C-30 concrete to columns' },
  ];
  it('rebar (t → kg) + binding wire and concrete (grade from the BoQ text) per element', () => {
    expect(elementTakeoffs(col, links, n, concreteSpecFor(specs))).toEqual([
      { material_spec_id: 'r16', boq_item_id: 'b-rebar', qty: 2500 },
      { material_spec_id: 'bw', boq_item_id: 'b-rebar', qty: 22.5 },
      { material_spec_id: 'c30', boq_item_id: 'b-conc', qty: 18 },
    ]);
  });
  it('blockwork m2 → blocks + mortar', () => {
    const w = d.elements.find((e) => e.code === 'BW')!;
    const t = elementTakeoffs(w, [{ task_id: w.tasks[0].task_id, boq_item_id: 'b-hcb', qty_share: 100, unit: 'm2', description: 'HCB' }], n);
    expect(t.map((x) => [x.material_spec_id, x.qty])).toEqual([['hcb', 1250], ['ppc', 8], ['sand', 3]]);
  });
});
