// Rich demo data for the local server: ~10 weeks of a running project (DEMO)
// plus a smaller second project (CMC), generated THROUGH THE REAL RPCs as the
// right role users, so statuses, ledger, notifications and audit are consistent.
//
// How time works
//   The timeline is in working days W0..W60 (Mon–Sat; W60 = today). Every event
//   has a simulated time and all events run in simulated order, so stock checks
//   done "now" are the same as stock checks over simulated time (the ledger can
//   never go negative at any point of the backdated history).
//   Each RPC runs in its own transaction; its now() (transaction time) is
//   recorded together with the event's simulated time. At the end every
//   timestamptz column of every table is remapped real → simulated in one pass,
//   as the superuser with session_replication_role = replica (immutability,
//   audit and updated_at triggers off). Rows created by migrations / the base
//   seed (between process start and the start of this seed) get the project
//   set-up time. Explicit simulated timestamps passed to RPCs (received_at,
//   issued_at, report_date …) are always before process start, so they are
//   never touched by the remap.
//
// Procurement follows the two request flows of 20261030000002_mr_flows.sql:
//   site use (SUR)  site engineer → office engineer review → coordinator approves
//                   = store order (store + issue-by date) → store keeper issues →
//                   site engineer acknowledges → received → closed. Approved
//                   quantities reserve stock first-come-first-served, so issues
//                   happen in approval order (or after the stock for a later
//                   approval has arrived).
//   purchase (PR)   office engineer → coordinator review → manager approval →
//                   procurement accepts → RFQ / PO (award by the coordinator, PO
//                   approved by someone else, or automatically when traced to the
//                   management-approved PR at the lowest quotation) → delivery
//                   notice to the store → GRN against the notice.
// Nobody approves their own request or PO.
//
// Schedule / EVM / look-ahead: local-server/fixtures/demo-tower-schedule.json is
// the import_schedule payload of docs/samples/demo-tower-schedule.xml (generated
// by web/scripts/gen-demo-schedule-fixture.test.ts — this file is plain Node and
// cannot run the TypeScript MSPDI parser). Its dates are shifted by whole weeks so
// the programme lines up with the simulated history, then it is imported (manager:
// price role, keeps MSP costs), mapped to a DEMO BoQ, baselined (manager) and
// approved (coordinator). Task progress, actual cost entries, monthly EVM periods,
// forecasts and two monthly look-aheads (commitments, PPC, constraints) follow the
// same timeline. Look-ahead RPCs see the simulated date through the GUC
// app.lookahead_today (app.la_today()).

import { randomUUID as uuid } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'demo-tower-schedule.json');

const EAT = 3 * 3600e3, DAY = 864e5, MIN = 60e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY = Symbol('retry');
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const sum = (a) => a.reduce((s, x) => s + x, 0);

// Deterministic PRNG so every reset produces the same data.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seedRichDemo({ db, asUser, createAuthUser }) {
  const t0 = Date.now();
  console.log('  generating rich demo history (~10 weeks)…');
  const rnd = prng(20261030);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const between = (a, b, d = 1) => round(a + rnd() * (b - a), d);

  // ---------------------------------------------------------------------------
  // Clock & calendar
  // ---------------------------------------------------------------------------
  const BOOT = Math.floor(performance.timeOrigin) - 1000;   // lower bound of migration/base-seed timestamps
  const CAP = BOOT - 2 * MIN;                                // every simulated time is before this
  const todayStr = new Date(CAP + EAT).toISOString().slice(0, 10);
  const todayMs = Date.parse(`${todayStr}T00:00:00Z`);      // local (EAT) midnight, as a UTC day number
  const isSun = (ms) => new Date(ms).getUTCDay() === 0;
  const WD = new Map([[60, todayMs]]);
  for (let k = 59, d = todayMs; k >= -20; k--) { do d -= DAY; while (isSun(d)); WD.set(k, d); }
  for (let k = 61, d = todayMs; k <= 160; k++) { do d += DAY; while (isSun(d)); WD.set(k, d); }
  const ds = (k) => new Date(WD.get(k)).toISOString().slice(0, 10);
  const dsCal = (ms) => new Date(ms).toISOString().slice(0, 10);
  // Simulated instant of working day k at local hh:mm. Today's events are squeezed into
  // the last ~3 hours before start-up so they are always in the past (and stay in order).
  const T = (k, h = 9, m = 0) => (k >= 60
    ? CAP - Math.max(2, (18 * 60 - (h * 60 + m)) / 3.5) * MIN
    : WD.get(k) - EAT + (h * 60 + m) * MIN);
  const iso = (ms) => new Date(Math.min(ms, CAP)).toISOString();
  const kOfCal = (ms) => { for (let k = -20; k <= 160; k++) if (WD.get(k) >= ms) return k; return 999; };

  // ---------------------------------------------------------------------------
  // Transactions with time capture
  // ---------------------------------------------------------------------------
  const tsmap = [];
  const used = new Set();
  const superTx = async (fn) => {
    await db.exec('begin');
    try { const out = await fn(); await db.exec('commit'); return out; } catch (e) { await db.exec('rollback'); throw e; }
  };
  async function inTx(user, t, fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        const run = async () => {
          const real = (await db.query('select now()::text as r')).rows[0].r;
          if (used.has(real)) throw RETRY;     // PGlite's clock is millisecond-grained
          const out = await fn();
          used.add(real);
          tsmap.push([real, iso(t)]);
          return out;
        };
        return user ? await asUser(user, run) : await superTx(run);
      } catch (e) {
        if (e === RETRY && attempt < 200) { await sleep(2); continue; }
        throw e;
      }
    }
  }
  const rpc = (user, t, fn, p) => inTx(user, t, async () =>
    (await db.query(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)])).rows[0].r);
  // Look-ahead RPCs plan against app.la_today(): give them the simulated date of working day k.
  const rpcLA = (user, k, t, fn, p) => inTx(user, t, async () => {
    await db.query(`select set_config('app.lookahead_today', $1, true)`, [ds(k)]);
    return (await db.query(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(p)])).rows[0].r;
  });
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  // Events: everything after set-up runs in simulated order.
  const events = [];
  let evSeq = 0;
  const at = (k, h, m, label, fn) => events.push({ t: T(k, h, m), s: evSeq++, label, fn });

  // Document numbers (assigned when the event runs, so they are chronological).
  const ctr = new Map();
  const no = (P, type, dev) => {
    const key = `${P.code}|${type}|${dev}`;
    const n = (ctr.get(key) ?? 0) + 1;
    ctr.set(key, n);
    return `${P.code}-${type}-${dev}-${String(n).padStart(4, '0')}`;
  };

  // ---------------------------------------------------------------------------
  // Users, specs, projects
  // ---------------------------------------------------------------------------
  const uidOf = async (email) => (await one('select id from auth.users where email = $1', [email]))?.id;
  if (!(await uidOf('gate@site.local'))) {
    await createAuthUser({ email: 'gate@site.local', password: 'demo1234', full_name: 'Getachew Gate Security', role: 'security' });
  }
  const U = {
    admin: await uidOf('admin@site.local'), manager: await uidOf('manager@site.local'),
    coordinator: await uidOf('coordinator@site.local'), office: await uidOf('office@site.local'),
    site: await uidOf('site@site.local'), store: await uidOf('store@site.local'),
    proc: await uidOf('procurement@site.local'), security: await uidOf('gate@site.local'),
  };
  const ROLE_ORDER = ['site', 'store', 'office', 'proc', 'coordinator', 'manager', 'security'];

  const specId = async (name, grade) => (await one(
    `select s.id from material_specs s join materials m on m.id = s.material_id where m.name = $1 and s.grade = $2`, [name, grade])).id;
  const S = {
    c25: await specId('Concrete', 'C-25/30'), c30: await specId('Concrete', 'C-30/37'),
    r8: await specId('Rebar', 'S-400 Ø8'), r12: await specId('Rebar', 'S-400 Ø12'), r16: await specId('Rebar', 'S-400 Ø16'),
    opc: await specId('Cement', 'OPC 42.5'), sand: await specId('Sand', ''), agg: await specId('Coarse aggregate', '02 (12–20mm)'),
    hcb: await specId('HCB', '20cm Class B'), hcb15: await specId('HCB', '15cm Class B'), wire: await specId('Binding wire', 'No. 18'),
    timber: await specId('Formwork timber', 'Eucalyptus 4x5'), membrane: await specId('Bituminous membrane', '4mm'),
  };
  const YARD_SPECS = new Set(['sand', 'agg', 'hcb', 'hcb15', 'timber', 'membrane']);

  const demoRow = await one(`select id from projects where code = 'DEMO'`);
  const PRJ = {
    DEMO: { code: 'DEMO', id: demoRow.id },
    CMC: { code: 'CMC', id: uuid() },
  };
  const D = PRJ.DEMO, C = PRJ.CMC;
  D.A = (await one(`select id from blocks where project_id = $1 and code = 'A'`, [D.id])).id;
  D.B = uuid();
  for (const r of await q(`select id, code from levels where project_id = $1`, [D.id])) D[`lv${r.code}`] = r.id;
  D.lvBG = uuid();
  for (const r of await q(`select id, store_type from stores where project_id = $1`, [D.id])) D[r.store_type === 'yard' ? 'YARD' : 'MAIN'] = r.id;
  Object.assign(C, { A: uuid(), lvG: uuid(), lvL1: uuid(), lvL2: uuid(), lvL3: uuid(), lvL4: uuid(), MAIN: uuid(), YARD: uuid() });
  const storeOf = (P, sp) => (YARD_SPECS.has(sp) ? P.YARD : P.MAIN);

  const SUP = {};
  for (const r of await q('select id, name from suppliers')) SUP[r.name] = r.id;

  // ---------------------------------------------------------------------------
  // Set-up (before W0): second project, extra elements, suppliers, prices, devices
  // ---------------------------------------------------------------------------
  const plus = (k, days) => dsCal(WD.get(k) + days * DAY);
  await inTx(U.admin, T(-12, 10), async () => {
    await db.query(`update projects set start_date = $2, end_date = $3, site_lat = 8.99584, site_lng = 38.78917, site_radius_m = 250,
      location = 'Bole Sub-city, Woreda 03, Addis Ababa', client = 'Demo Client PLC' where id = $1`, [D.id, ds(0), plus(0, 420)]);
    await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'B', 'Block B — Annex')`, [D.B, D.id]);
    await db.query(`insert into levels (id, project_id, block_id, code, name, sort_order) values ($1, $2, $3, 'G', 'Ground / Foundation', 0)`,
      [D.lvBG, D.id, D.B]);
    await db.query(`insert into projects (id, code, name, location, client, start_date, end_date, site_lat, site_lng, site_radius_m)
      values ($1, 'CMC', 'CMC Apartments G+4', 'CMC area, Yeka Sub-city, Addis Ababa', 'Sunshine Real Estate S.C.', $2, $3, 9.02031, 38.84612, 200)`,
      [C.id, ds(25), plus(25, 360)]);
    for (const u of [U.manager, U.coordinator, U.office, U.site, U.store, U.proc, U.security]) {
      await db.query('insert into project_members (project_id, user_id) values ($1, $2) on conflict do nothing', [C.id, u]);
    }
    await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'A', 'Block A')`, [C.A, C.id]);
    await db.query(`insert into levels (id, project_id, block_id, code, name, sort_order) values
      ($1, $7, $8, 'G', 'Ground / Foundation', 0), ($2, $7, $8, 'L1', 'Level 1', 1), ($3, $7, $8, 'L2', 'Level 2', 2),
      ($4, $7, $8, 'L3', 'Level 3', 3), ($5, $7, $8, 'L4', 'Level 4', 4), ($6, $7, $8, 'R', 'Roof', 5)`,
      [C.lvG, C.lvL1, C.lvL2, C.lvL3, C.lvL4, uuid(), C.id, C.A]);
    await db.query(`insert into stores (id, project_id, name, store_type) values ($1, $3, 'Main store', 'main'), ($2, $3, 'Open yard', 'yard')`,
      [C.MAIN, C.YARD, C.id]);
  });

  // Elements: [key, project, block, level, code, type, grid, planned start k, planned finish k, take-offs]
  const TK = {
    footing: { c25: 6.5, r16: 420, r12: 160, wire: 6 },
    annex: { c25: 5.0, r16: 380, r12: 140, wire: 5 },
    gbeam: { c25: 3.0, r16: 260, r8: 60, wire: 3 },
    column: { c25: 1.6, r16: 190, r8: 45, wire: 2 },
    beam: { c25: 3.2, r16: 280, r8: 70, wire: 3 },
    slab: { c25: 38, r12: 2600, wire: 20 },
    stair: { c25: 4.5, r12: 420, r8: 60, wire: 4 },
    wall: { hcb: 1450, opc: 24, sand: 6 },
    cFooting: { c25: 4.2, r16: 300, r12: 110, wire: 4 },
    cColumn: { c25: 1.2, r16: 150, r8: 36, wire: 2 },
    cSlab: { c25: 30, r12: 2100, wire: 16 },
  };
  const ELDEF = [];
  for (let i = 1; i <= 4; i++) ELDEF.push([`F${i}`, D, D.A, D.lvG, `F${i}`, 'footing', `A/${i}`, 3 + i, 13 + i, TK.footing]);
  for (let i = 5; i <= 8; i++) ELDEF.push([`F${i}`, D, D.A, D.lvG, `F${i}`, 'footing', `C/${i - 4}`, 4 + i, 14 + i, TK.footing]);
  for (let i = 1; i <= 4; i++) ELDEF.push([`GB${i}`, D, D.A, D.lvG, `GB${i}`, 'beam', `A-C/${i}`, i < 4 ? 25 : 28, i < 4 ? 35 : 38, TK.gbeam]);
  for (let i = 1; i <= 4; i++) ELDEF.push([`FB${i}`, D, D.B, D.lvBG, `FB${i}`, 'footing', `D/${i}`, i <= 2 ? 20 : 31, i <= 2 ? 32 : 43, TK.annex]);
  for (let i = 1; i <= 8; i++) ELDEF.push([`C${i}`, D, D.A, D.lvL1, `C${i}`, 'column', `B/${i}`, i <= 4 ? 34 : 39, i <= 4 ? 46 : 51, TK.column]);
  for (let i = 1; i <= 4; i++) ELDEF.push([`B${i}`, D, D.A, D.lvL1, `B${i}`, 'beam', `A-B/${i}-${i + 1}`, i <= 2 ? 47 : 53, i <= 2 ? 58 : 64, TK.beam]);
  ELDEF.push(['S1', D, D.A, D.lvL1, 'S1', 'slab', 'A-C/1-4', 52, 70, TK.slab]);
  ELDEF.push(['ST1', D, D.A, D.lvL1, 'ST1', 'staircase', 'C-D/4-5', 57, 68, TK.stair]);
  ELDEF.push(['W1', D, D.A, D.lvL1, 'W1', 'wall', 'A/1-4', 73, 90, TK.wall]);
  for (let i = 9; i <= 14; i++) ELDEF.push([`C${i}`, D, D.A, D.lvL2, `C${i}`, 'column', `B/${i - 8}`, 59 + i, 71 + i, TK.column]);
  ELDEF.push(['S2', D, D.A, D.lvL2, 'S2', 'slab', 'A-C/1-4', 80, 98, TK.slab]);
  for (let i = 1; i <= 6; i++) ELDEF.push([`cF${i}`, C, C.A, C.lvG, `F${i}`, 'footing', `${i <= 3 ? 'A' : 'B'}/${((i - 1) % 3) + 1}`, i <= 3 ? 27 : 33, i <= 3 ? 37 : 43, TK.cFooting]);
  for (let i = 1; i <= 6; i++) ELDEF.push([`cC${i}`, C, C.A, C.lvL1, `C${i}`, 'column', `A/${i}`, i <= 3 ? 45 : 48, i <= 3 ? 57 : 58, TK.cColumn]);
  ELDEF.push(['cS1', C, C.A, C.lvL1, 'S1', 'slab', 'A-B/1-3', 58, 75, TK.cSlab]);

  const EL = {};
  const drawing = { footing: 'S-FT-01 Rev B', beam: 'S-BM-02 Rev A', column: 'S-CL-01 Rev C', slab: 'S-SL-01 Rev A', staircase: 'S-ST-01 Rev B', wall: 'A-WL-03 Rev A' };
  await inTx(U.office, T(-10, 10), async () => {
    for (const [key, P, block, level, code, type, grid, ps, pf, tk] of ELDEF) {
      const ex = await one('select id from elements where project_id = $1 and level_id = $2 and code = $3', [P.id, level, code]);
      let id = ex?.id;
      if (id) {
        await db.query('update elements set planned_start = $2, planned_finish = $3, grid = $4, drawing_ref = $5 where id = $1',
          [id, ds(ps), ds(pf), grid, drawing[type]]);
      } else {
        id = uuid();
        await db.query(`insert into elements (id, project_id, block_id, level_id, code, element_type, grid, drawing_ref, planned_start, planned_finish)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [id, P.id, block, level, code, type, grid, drawing[type], ds(ps), ds(pf)]);
      }
      for (const [sp, qty] of Object.entries(tk)) {
        await db.query(`insert into element_takeoffs (project_id, element_id, material_spec_id, planned_qty) values ($1, $2, $3, $4)
          on conflict (element_id, material_spec_id) do update set planned_qty = excluded.planned_qty, deleted_at = null`, [P.id, id, S[sp], qty]);
      }
      EL[key] = { id, P, key, code, type, block, tk };
    }
    // Minimum / reorder levels so the low-stock and reorder views mean something.
    for (const [sp, min, reo] of [['r16', 800, 1500], ['r12', 400, 800], ['r8', 80, 150], ['opc', 20, 40], ['wire', 15, 30],
      ['sand', 5, 10], ['agg', 4, 8], ['hcb', 300, 500], ['timber', 100, 200]]) {
      await db.query('update material_specs set min_level = $2, reorder_level = $3 where id = $1', [S[sp], min, reo]);
    }
  });
  // Unused demo elements from the base seed that the rich plan does not know about are left as they are.
  const E = (key) => { const e = EL[key]; if (!e) throw new Error(`unknown element ${key}`); return e; };

  await inTx(U.proc, T(-9, 11), async () => {
    for (const [name, person, phone, cats, rating, tin, terms] of [
      ['Kality Metal Works', 'Biniam', '+251911000011', '{Reinforcement}', 3.9, '0045123456', '30 days'],
      ['Habesha Steel Mills', 'Mesfin', '+251911000012', '{Reinforcement}', 4.0, '0045987654', 'Advance 30%, balance on delivery'],
      ['Mugher Cement Enterprise', 'Aster', '+251911000013', '{Cement}', 4.1, '0001234567', 'Cash on delivery'],
      ['National Cement S.C.', 'Dereje', '+251911000014', '{Cement}', 3.7, '0007654321', '15 days'],
      ['Lucy Blocks & Pavers', 'Lucy', '+251911000015', '{Blocks}', 3.6, '0033221144', 'Cash on delivery'],
      ['Sheger Aggregates', 'Tadesse', '+251911000016', '{Aggregate}', 3.4, '0055443322', 'Cash on delivery'],
      ['Merkato Hardware', 'Kedir', '+251911000017', '{Accessories}', 3.2, null, 'Cash'],
      ['Ethio Timber Supply', 'Alemu', '+251911000018', '{Formwork}', 3.5, '0066778899', '15 days'],
    ]) {
      const id = uuid();
      await db.query(`insert into suppliers (id, name, contact_person, phone, categories, rating, tin, payment_terms) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, name, person, phone, cats, rating, tin, terms]);
      SUP[name] = id;
    }
    for (const [name, tin, terms] of [['Abyssinia Steel PLC', '0012345678', '30 days'], ['Derba Cement', '0023456789', 'Advance payment'],
      ['Addis Ready-Mix', '0034567890', '15 days'], ['Akaki Aggregates', '0045678901', 'Cash on delivery']]) {
      await db.query('update suppliers set tin = $2, payment_terms = $3 where id = $1', [SUP[name], tin, terms]);
    }
  });
  await inTx(U.manager, T(-9, 14), async () => {
    await db.query(`insert into spec_prices (material_spec_id, unit_price) values ($1, 180), ($2, 28), ($3, 450), ($4, 8600)
      on conflict (material_spec_id) do nothing`, [S.timber, S.hcb15, S.membrane, S.c30]);
    await db.query(`update project_settings set variance_thresholds = '{"Reinforcement": 3, "Concrete": 2}'::jsonb, escalation_hours = 24
      where project_id = any ($1::uuid[])`, [[D.id, C.id]]);
  });

  const DEV = {};
  for (const [i, r] of ROLE_ORDER.entries()) {
    const out = await rpc(U[r], T(-8, 8, i * 7), 'register_device', { device_id: uuid(), name: `${r} phone` });
    DEV[r] = out.prefix;
  }

  const ACT = {};
  for (const r of await q('select id, element_id, seq, name, weight, is_hold_point from element_activities order by seq')) {
    (ACT[r.element_id] ??= []).push(r);
  }
  const act = (key, seq) => {
    const a = (ACT[E(key).id] ?? []).find((x) => x.seq === seq);
    if (!a) throw new Error(`no activity ${seq} for ${key}`);
    return a;
  };
  const castSeq = (key) => (ACT[E(key).id] ?? []).find((a) => /^cast/i.test(a.name))?.seq;
  const holdSeq = (key) => (ACT[E(key).id] ?? []).find((a) => a.is_hold_point)?.seq;

  const TPL = {};
  for (const t of await q('select id, code, name from checklist_templates where project_id is null')) {
    TPL[t.code] = { ...t, items: await q('select id, seq, item_type, min_value, max_value, is_critical from checklist_template_items where template_id = $1 and deleted_at is null order by seq', [t.id]) };
  }
  const TRADE = {};
  for (const r of await q('select id, name from labour_trades')) TRADE[r.name] = r.id;

  // ---------------------------------------------------------------------------
  // Shared state between events + work log for the diaries
  // ---------------------------------------------------------------------------
  const ST = { snag: {}, po: {}, rfq: {}, pour: {}, truck: {}, gp: {}, insp: {}, grn: [], alerts: [] };
  const WORK = new Map();   // `${P.code}|${k}` -> Map(elementKey -> [notes])
  const work = (P, k, key, note) => {
    const m = WORK.get(`${P.code}|${k}`) ?? new Map();
    m.set(key, [...(m.get(key) ?? []), note]);
    WORK.set(`${P.code}|${k}`, m);
  };
  const VEH = [];           // deliveries the gate guard logs: { P, k, h, m, plate, driver, purpose, doc, docId }
  const plate = () => `3-${pick(['A', 'B', 'C'])}${Math.floor(10000 + rnd() * 89999)}`;
  const DRIVERS = ['Abebe K.', 'Mulugeta T.', 'Solomon A.', 'Girma B.', 'Tesfaye H.', 'Kebede M.', 'Yohannes D.', 'Bekele W.'];

  // ===========================================================================
  // A. Opening stock, budgets, market prices
  // ===========================================================================
  at(0, 7, 30, 'DEMO opening stock', async (t) => {
    await rpc(U.manager, t, 'post_opening_balance', { project_id: D.id, store_id: D.MAIN, lines: [
      { material_spec_id: S.r16, qty: 2400 }, { material_spec_id: S.r12, qty: 900 }, { material_spec_id: S.r8, qty: 120 },
      { material_spec_id: S.opc, qty: 80 }, { material_spec_id: S.wire, qty: 35 }] });
    await rpc(U.manager, t + MIN, 'post_opening_balance', { project_id: D.id, store_id: D.YARD, lines: [
      { material_spec_id: S.sand, qty: 7 }, { material_spec_id: S.agg, qty: 21 }, { material_spec_id: S.hcb, qty: 600 },
      { material_spec_id: S.timber, qty: 800 }] });
  });
  at(25, 8, 0, 'CMC opening stock', async (t) => {
    await rpc(U.manager, t, 'post_opening_balance', { project_id: C.id, store_id: C.MAIN, lines: [
      { material_spec_id: S.r16, qty: 2000 }, { material_spec_id: S.r12, qty: 800 }, { material_spec_id: S.r8, qty: 260 },
      { material_spec_id: S.opc, qty: 60 }, { material_spec_id: S.wire, qty: 30 }] });
    await rpc(U.manager, t + MIN, 'post_opening_balance', { project_id: C.id, store_id: C.YARD, lines: [
      { material_spec_id: S.sand, qty: 10 }, { material_spec_id: S.agg, qty: 14 }, { material_spec_id: S.hcb, qty: 500 },
      { material_spec_id: S.timber, qty: 300 }] });
  });

  const budget = (P, k, lines) => at(k, 10, 0, `${P.code} budget`, (t) => rpc(U.manager, t, 'save_budget', {
    project_id: P.id, lines: lines.map(([sp, cat, desc, qty, rate, amount]) => ({ id: uuid(), material_spec_id: sp ? S[sp] : null, category: cat,
      description: desc, budget_qty: qty, budget_rate: rate, budget_amount: amount })) }));
  budget(D, 1, [
    ['c25', null, 'Structural concrete C-25/30', 520, 7800], ['r16', null, 'Rebar Ø16', 18000, 95], ['r12', null, 'Rebar Ø12', 9500, 92],
    ['r8', null, 'Rebar Ø8 (links)', 2600, 98], ['opc', null, 'Cement OPC 42.5', 700, 1450], ['hcb', null, 'HCB 20 cm walls', 14000, 32],
    [null, 'Aggregate', 'Sand & coarse aggregate', null, null, 650000], [null, 'Accessories', 'Binding wire & sundries', null, null, 180000],
    [null, 'Formwork', 'Formwork timber', null, null, 320000], [null, 'Waterproofing', 'Membrane & waterproofing', null, null, 120000],
  ]);
  budget(C, 26, [
    ['c25', null, 'Structural concrete C-25/30', 380, 7900], ['r16', null, 'Rebar Ø16', 11000, 96], ['r12', null, 'Rebar Ø12', 7000, 93],
    ['r8', null, 'Rebar Ø8 (links)', 1500, 99], ['opc', null, 'Cement OPC 42.5', 450, 1460], [null, 'Aggregate', 'Sand & aggregate', null, null, 380000],
    [null, 'Accessories', 'Binding wire & sundries', null, null, 90000],
  ]);

  // Weekly market survey (Merkato); cement spikes during the W42–W47 shortage.
  const MARKET = {
    opc: [[1, 1440], [7, 1450], [13, 1455], [19, 1470], [25, 1480], [31, 1490], [37, 1505], [43, 1820], [45, 1880], [49, 1760], [52, 1690], [55, 1640], [58, 1610]],
    r16: [[1, 93], [7, 93.5], [13, 94], [19, 95], [25, 95.5], [31, 96.5], [37, 97], [43, 98.5], [49, 99.5], [55, 100.5], [58, 101]],
    r12: [[1, 91], [7, 91], [13, 92], [19, 92.5], [25, 93], [31, 94], [37, 95], [43, 96], [49, 97], [55, 98], [58, 98.5]],
    r8: [[1, 96], [13, 97], [25, 98], [37, 99.5], [49, 102], [58, 104]],
    hcb: [[1, 31], [19, 31.5], [37, 32], [49, 33], [58, 33.5]],
    sand: [[1, 1080], [19, 1100], [37, 1120], [55, 1150]],
  };
  for (const [sp, pts] of Object.entries(MARKET)) {
    for (const [k, price] of pts) {
      at(k, 11, 30, `market ${sp}`, (t) => rpc(U.proc, t, 'log_market_price', { id: uuid(), project_id: D.id, material_spec_id: S[sp],
        unit_price: price, observed_on: ds(k), location: pick(['Merkato', 'Merkato', 'Kality', 'Lebu']),
        note: k >= 43 && k <= 47 && sp === 'opc' ? 'Factory rationing — very limited supply' : 'Weekly market survey' }));
    }
  }

  // ===========================================================================
  // B. Material requests (43 in DEMO, 7 in CMC) and their issues
  // ===========================================================================
  const MR = {};
  const split = (codes, qtyOrFn) => Object.fromEntries(codes.map((c) => [c, typeof qtyOrFn === 'function' ? qtyOrFn(c) : qtyOrFn]));
  const tk = (sp) => (code) => E(code).tk[sp];
  const range = (prefix, a, b) => Array.from({ length: b - a + 1 }, (_, i) => `${prefix}${a + i}`);
  const mivAck = [];
  function mr(key, o) {
    const P = o.P ?? D;
    const by = o.by ?? 'site';
    const lines = o.lines.map(([sp, sp_split, reason]) => ({ id: uuid(), sp, split: sp_split, reason }));
    const rec = { id: uuid(), P, by, lines, o };
    MR[key] = rec;
    const firstEl = Object.keys(lines[0].split)[0];
    at(o.k, o.h ?? 9, o.m ?? 0, `${key} create`, async (t) => {
      rec.number = no(P, 'MR', DEV[by]);
      await rpc(U[by], t, 'save_mr', {
        id: rec.id, project_id: P.id, number: rec.number, request_type: 'site_use', block_id: E(firstEl).block, priority: o.priority ?? 'normal',
        required_date: ds(o.req ?? o.k + 6), store_id: storeOf(P, lines[0].sp),
        delivery_location: YARD_SPECS.has(lines[0].sp) ? 'Open yard' : 'Main store', purpose: o.purpose,
        drawing_ref: drawing[E(firstEl).type], is_lookahead: !!o.lookahead, submit: o.submit !== false,
        lines: lines.map((l) => ({ id: l.id, material_spec_id: S[l.sp], qty: round(sum(Object.values(l.split))), over_boq_reason: l.reason,
          remarks: l.reason ? 'Over take-off — see reason' : undefined,
          elements: Object.entries(l.split).map(([code, qty]) => ({ id: uuid(), element_id: E(code).id, qty })) })),
      });
    });
    for (const [k, h, action, arg = {}] of o.flow ?? []) {
      if (action === 'issue') { issue(rec, k, h, arg); continue; }
      const who = arg.by ?? { review: 'office', approve: 'coordinator', reject: 'coordinator', return: 'office', close: 'store', cancel: by,
        convert_shortfall: 'office' }[action];
      at(k, h, arg.m ?? 0, `${key} ${action}`, async (t) => {
        const extra = {};
        // approval = store order: which store issues, and by when
        if (action === 'approve') Object.assign(extra, { store_id: storeOf(P, lines[0].sp), issue_by: ds(arg.issueBy ?? Math.max(k + 1, o.req ?? o.k + 6)) });
        if (action === 'convert_shortfall') {
          const prRec = PR[arg.pr];
          Object.assign(extra, { pr_id: prRec.id, lines: Object.entries(arg.lines).map(([sp, qty]) => {
            const pl = prRec.lines.find((x) => x.sp === sp);
            return { id: lines.find((l) => l.sp === sp).id, qty, pr_line_id: pl.id };
          }) });
          const r = await rpc(U[who], t, 'mr_action', { mr_id: rec.id, action, comment: arg.comment, ...extra });
          prRec.number = r.pr_number;
          return r;
        }
        return rpc(U[who], t, 'mr_action', {
          mr_id: rec.id, action, comment: arg.comment,
          lines: arg.approve ? Object.entries(arg.approve).map(([sp, qty]) => ({ id: lines.find((l) => l.sp === sp).id, approved_qty: qty }))
            : arg.review ? Object.entries(arg.review).map(([sp, qty]) => ({ id: lines.find((l) => l.sp === sp).id, reviewed_qty: qty })) : undefined,
          ...extra,
        });
      });
    }
    return rec;
  }

  // Purchase request (Flow A): raised by the office engineer for stock to be bought.
  // lines: [[spec, qty, {element: qty}?]]; flow: [[k, h, action, arg]] with actions
  // review (coordinator) → approve (manager) → accept (procurement), return / reject / cancel / close.
  // `shortfall: true` = created by convert_shortfall on a site-use request (no save_mr here).
  const PR = {};
  function pr(key, o) {
    const P = o.P ?? D;
    const by = o.by ?? 'office';
    const lines = o.lines.map(([sp, qty, split]) => ({ id: uuid(), sp, qty, split }));
    const rec = { id: uuid(), P, by, lines, o, kind: 'purchase' };
    PR[key] = rec;
    MR[key] = rec;   // RFQ / PO lines refer to request lines by key
    if (!o.shortfall) {
      at(o.k, o.h ?? 10, o.m ?? 0, `${key} create`, async (t) => {
        rec.number = no(P, 'PR', DEV[by]);
        await rpc(U[by], t, 'save_mr', {
          id: rec.id, project_id: P.id, number: rec.number, request_type: 'purchase', priority: o.priority ?? 'normal',
          required_date: ds(o.req ?? o.k + 10), store_id: storeOf(P, lines[0].sp),
          delivery_location: YARD_SPECS.has(lines[0].sp) ? 'Open yard' : 'Main store', purpose: o.purpose,
          is_lookahead: !!o.lookahead, submit: o.submit !== false,
          lines: lines.map((l) => ({ id: l.id, material_spec_id: S[l.sp], qty: l.qty, remarks: l.remarks,
            elements: Object.entries(l.split ?? {}).map(([code, qty]) => ({ id: uuid(), element_id: E(code).id, qty })) })),
        });
      });
    }
    for (const [k, h, action, arg = {}] of o.flow ?? []) {
      const who = arg.by ?? { review: 'coordinator', approve: 'manager', accept: 'proc', return: 'coordinator', reject: 'manager',
        cancel: by, close: 'proc' }[action];
      at(k, h, arg.m ?? 0, `${key} ${action}`, (t) => rpc(U[who], t, 'mr_action', {
        mr_id: rec.id, action, comment: arg.comment,
        lines: arg.approve ? Object.entries(arg.approve).map(([sp, qty]) => ({ id: lines.find((l) => l.sp === sp).id, approved_qty: qty }))
          : arg.review ? Object.entries(arg.review).map(([sp, qty]) => ({ id: lines.find((l) => l.sp === sp).id, reviewed_qty: qty })) : undefined,
      }));
    }
    return rec;
  }
  // Issue against a request: one MIV per store. `lines` = [[spec, element, qty]] or 'all'.
  function issue(rec, k, h, arg) {
    const P = rec.P;
    const want = arg.lines === undefined || arg.lines === 'all'
      ? rec.lines.flatMap((l) => Object.entries(l.split).map(([code, qty]) => [l.sp, code, qty]))
      : arg.lines;
    const byStore = new Map();
    for (const [sp, code, qty] of want) {
      const st = storeOf(P, sp);
      byStore.set(st, [...(byStore.get(st) ?? []), [sp, code, qty]]);
    }
    let i = 0;
    for (const [store, ls] of byStore) {
      const id = uuid();
      const m = (arg.m ?? 0) + 10 * i++;
      at(k, h, m, `issue ${rec.o.purpose}`, async (t) => {
        await rpc(U.store, t, 'post_miv', {
          id, project_id: P.id, store_id: store, number: no(P, 'MIV', DEV.store), mr_id: rec.id, issued_to: U.site, issued_at: iso(t),
          remarks: arg.remarks ?? `Against ${rec.number}`,
          lines: ls.map(([sp, code, qty]) => ({ id: uuid(), mr_line_id: rec.lines.find((l) => l.sp === sp).id, material_spec_id: S[sp],
            element_id: E(code).id, qty })),
        });
      });
      for (const [, code] of ls) work(P, k, code, 'materials issued');
      if (arg.ack !== false && k <= 57) mivAck.push([k, h + 2, m, id]);
    }
  }

  const F14 = range('F', 1, 4), F58 = range('F', 5, 8), GB = range('GB', 1, 4), FB12 = ['FB1', 'FB2'];
  const C14 = range('C', 1, 4), C58 = range('C', 5, 8), B14 = range('B', 1, 4), C914 = range('C', 9, 14);

  mr('M1', { k: 2, purpose: 'Footings F1–F4 reinforcement', lines: [['r16', split(F14, 420)], ['r12', split(F14, 160)], ['wire', split(F14, 6)]],
    flow: [[2, 14, 'review'], [3, 9, 'approve', { m: 30 }], [8, 8, 'issue', { m: 30 }], [16, 16, 'close']] });
  mr('M2', { k: 4, h: 8, priority: 'urgent', purpose: 'Blinding F1–F4 (site mix)', lines: [['opc', split(F14, 1.5)], ['sand', split(F14, 0.5)], ['agg', split(F14, 0.75)]],
    flow: [[4, 10, 'review'], [4, 11, 'approve', { by: 'manager' }], [5, 8, 'issue'], [16, 16, 'close', { m: 10 }]] });
  mr('M3', { k: 9, purpose: 'Footings F5–F8 reinforcement',
    lines: [['r16', split(F58, 420)], ['r12', { F5: 160, F6: 160, F7: 175, F8: 160 }, 'F7 carries extra starter bars for the lift-shaft wall (RFI-07)'], ['wire', split(F58, 6)]],
    flow: [[9, 13, 'review'], [10, 9, 'approve'], [12, 8, 'issue', { m: 30, lines: [...F58.map((c) => ['r16', c, 420]), ...F58.map((c) => ['wire', c, 6])] }],
      [13, 8, 'issue', { m: 30, lines: [['r12', 'F5', 160], ['r12', 'F6', 160], ['r12', 'F7', 175], ['r12', 'F8', 160]] }], [22, 16, 'close']] });
  mr('M4', { k: 9, h: 11, purpose: 'Blinding F5–F8 (site mix)', lines: [['opc', split(F58, 1.5)], ['sand', split(F58, 0.5)], ['agg', split(F58, 0.75)]],
    flow: [[9, 14, 'review'], [10, 9, 'approve', { m: 20 }], [10, 13, 'issue'], [22, 16, 'close', { m: 10 }]] });
  mr('M5', { k: 10, h: 10, priority: 'urgent', purpose: 'Formwork timber for footings F5–F8', lines: [['timber', split(F58, 50)]],
    flow: [[10, 14, 'review'], [11, 9, 'reject', { comment: 'Use the 800 pcs in the yard and re-use the F1–F4 forms' }]] });
  mr('M6', { k: 10, h: 15, priority: 'urgent', purpose: 'Additional Ø16 for F3 — bars cut short', lines: [['r16', { F3: 50 }, 'Bars cut 300 mm short by the bar bender; re-cut required']],
    flow: [[10, 16, 'review'], [11, 8, 'approve', { by: 'manager' }], [12, 7, 'issue', { m: 40, remarks: 'Issued as soon as PO-0001 steel was received (stock reserved for F5–F8)' }],
      [16, 16, 'close', { m: 20 }]] });
  mr('M36', { k: 12, h: 10, purpose: 'Formwork timber — footing form repairs', lines: [['timber', split([...F14, ...F58], 10)]],
    flow: [[12, 14, 'review'], [13, 8, 'approve'], [13, 10, 'issue'], [22, 16, 'close', { m: 30 }]] });
  mr('M38', { k: 15, h: 8, purpose: 'Sand bedding for F1–F4 backfill', lines: [['sand', split(F14, 0.5)]],
    flow: [[15, 10, 'review'], [15, 11, 'approve'], [16, 8, 'issue'], [24, 16, 'close']] });
  mr('M42', { k: 18, purpose: 'Membrane under footings F5–F8', lines: [['membrane', split(F58, 10)]],
    flow: [[18, 11, 'review'], [18, 15, 'approve'], [19, 9, 'issue', { ack: true }], [22, 16, 'close', { m: 40 }]] });
  mr('M8', { k: 21, purpose: 'Annex footings FB1–FB4 reinforcement', lines: [['r16', split(range('FB', 1, 4), 380)], ['r12', split(range('FB', 1, 4), 140)], ['wire', split(range('FB', 1, 4), 5)]],
    flow: [[21, 14, 'review'], [22, 9, 'approve'], [24, 8, 'issue', { lines: FB12.flatMap((c) => [['r16', c, 380], ['r12', c, 140], ['wire', c, 5]]) }],
      [46, 8, 'issue', { lines: [['r16', 'FB3', 105], ['r12', 'FB3', 38], ['wire', 'FB3', 1]] }]] });
  mr('M33', { k: 21, h: 11, purpose: 'Blinding FB1–FB2', lines: [['opc', split(FB12, 1.5)], ['sand', split(FB12, 0.5)], ['agg', split(FB12, 0.75)]],
    flow: [[21, 15, 'review'], [22, 9, 'approve', { m: 15 }], [22, 11, 'issue'], [30, 16, 'close']] });
  mr('M7', { k: 22, purpose: 'Ground beams GB1–GB4 reinforcement', lines: [['r16', split(GB, 260)], ['r8', split(GB, 60)], ['wire', split(GB, 3)]],
    flow: [[22, 15, 'review'], [23, 9, 'approve', { approve: { r8: 201 }, comment: 'Ø8 for GB4 limited to 21 kg until PO-0006 links arrive' }], [29, 8, 'issue', { lines: GB.slice(0, 3).flatMap((c) => [['r16', c, 260], ['r8', c, 60], ['wire', c, 3]]) }],
      [38, 9, 'issue', { lines: [['r16', 'GB4', 90], ['r8', 'GB4', 21], ['wire', 'GB4', 1]], remarks: 'Partial — rest when Ø8 arrives' }]] });
  mr('M9', { k: 25, purpose: 'Site-batched concrete FB1–FB2 (cement & aggregates)', lines: [['opc', split(FB12, 20)], ['sand', split(FB12, 3)], ['agg', split(FB12, 4)]],
    flow: [[25, 14, 'review'], [26, 9, 'approve'], [30, 16, 'close', { comment: 'Pour complete — balance not required' }]] });
  mr('M10', { k: 26, h: 8, purpose: 'Formwork timber for ground beams', lines: [['timber', split(GB, 30)]],
    flow: [[26, 10, 'review'], [26, 11, 'approve'], [27, 8, 'issue']] });
  mr('M34', { k: 26, h: 9, purpose: 'Blinding GB1–GB4', lines: [['opc', split(GB, 1)], ['sand', split(GB, 0.3)], ['agg', split(GB, 0.4)]],
    flow: [[26, 11, 'review', { m: 20 }], [26, 14, 'approve'], [27, 9, 'issue'], [38, 16, 'close']] });
  mr('M39', { k: 31, purpose: 'HCB for site store partition (W1 grid line)', lines: [['hcb', { W1: 200 }]],
    flow: [[31, 14, 'review'], [32, 9, 'approve'], [32, 11, 'issue']] });
  mr('M11', { k: 33, purpose: 'Columns C1–C4 reinforcement',
    lines: [['r16', { C1: 190, C2: 215, C3: 190, C4: 190 }, 'C2 lap length increased per consultant instruction CI-03'], ['r8', split(C14, 45)], ['wire', split(C14, 2)]],
    flow: [[33, 14, 'review'], [34, 9, 'approve', { by: 'manager' }], [35, 8, 'issue'], [45, 16, 'close']] });
  mr('M37', { k: 33, h: 11, purpose: 'Formwork timber for columns C1–C8', lines: [['timber', split([...C14, ...C58], 20)]],
    flow: [[33, 15, 'review'], [34, 9, 'approve', { m: 20 }], [35, 10, 'issue', { lines: C14.map((c) => ['timber', c, 20]) }],
      [44, 9, 'issue', { lines: [['timber', 'C5', 20], ['timber', 'C6', 20]] }], [52, 16, 'close', { comment: 'C7–C8 forms re-used from C1–C4' }]] });
  mr('M7b', { k: 37, purpose: 'Columns C5–C8 reinforcement', lines: [['r16', split(C58, 190)], ['r8', split(C58, 45)], ['wire', split(C58, 2)]],
    flow: [[37, 14, 'review'], [38, 9, 'approve'], [43, 8, 'issue', { lines: ['C5', 'C6'].flatMap((c) => [['r16', c, 190], ['r8', c, 45], ['wire', c, 2]]) }],
      [50, 8, 'issue', { lines: [['r16', 'C7', 95], ['r8', 'C7', 22], ['wire', 'C7', 1]] }]] });
  mr('M13', { k: 38, h: 10, purpose: 'Extra binding wire for ground beams', lines: [['wire', { GB1: 50 }, 'Wire consumption higher than allowance']],
    flow: [[38, 14, 'review'], [39, 10, 'reject', { by: 'manager', comment: 'Excessive — BoQ allowance already issued; check wastage first' }]] });
  mr('M14', { k: 39, purpose: 'Site-batched concrete C1–C4 (cement & aggregates)', lines: [['opc', split(C14, 7)], ['sand', split(C14, 1)], ['agg', split(C14, 1.25)]],
    flow: [[39, 14, 'review'], [40, 9, 'approve'], [44, 16, 'close', { comment: 'Pour P5 complete' }]] });
  mr('M15', { k: 40, h: 10, purpose: 'Formwork timber C1–C4 (duplicate)', lines: [['timber', split(C14, 10)]],
    flow: [[40, 15, 'cancel', { comment: 'Duplicate of the C1–C8 timber request' }]] });
  mr('M43', { k: 42, h: 8, priority: 'urgent', purpose: 'Cement for FB3 blinding', lines: [['opc', { FB3: 2 }]],
    flow: [[42, 10, 'review'], [43, 9, 'reject', { comment: 'Cement reserved for the C1–C4 pour during the shortage; resubmit after PO-0007 delivery' }]] });
  mr('M16', { k: 44, purpose: 'C5–C6 site-batched concrete materials', lines: [['opc', { C5: 3, C6: 3 }]],
    flow: [[45, 9, 'review'], [45, 14, 'return', { by: 'coordinator', comment: 'Cement shortage — switch C5–C6 to ready-mix; resubmit only if needed' }]] });
  mr('M35', { k: 44, h: 11, purpose: 'Blinding FB3–FB4', lines: [['opc', { FB3: 1.5, FB4: 1.5 }], ['sand', { FB3: 0.5, FB4: 0.5 }], ['agg', { FB3: 0.75, FB4: 0.75 }]],
    flow: [[44, 15, 'review'], [45, 9, 'approve'], [47, 8, 'issue', { lines: [['opc', 'FB3', 1.5], ['sand', 'FB3', 0.5], ['agg', 'FB3', 0.75]] }]] });
  mr('M40', { k: 46, purpose: 'Ready-mix concrete C5–C6', lines: [['c25', split(['C5', 'C6'], 1.6)]],
    flow: [[46, 14, 'review'], [47, 9, 'approve'], [53, 16, 'close', { comment: 'Supplied as ready-mix pour P6' }]] });
  mr('M41', { k: 48, purpose: 'Formwork timber FB3–FB4', lines: [['timber', { FB3: 20, FB4: 20 }]],
    flow: [[48, 14, 'review'], [49, 8, 'approve'], [49, 10, 'issue']] });
  mr('M17', { k: 51, purpose: 'Beams B1–B4 reinforcement', lines: [['r16', split(B14, 280)], ['r8', split(B14, 70)], ['wire', split(B14, 3)]],
    flow: [[51, 14, 'review'], [52, 9, 'approve'], [54, 8, 'issue', { lines: [['r16', 'B1', 70], ['r16', 'B2', 70], ['r8', 'B1', 17], ['r8', 'B2', 17]] }]] });
  mr('M18', { k: 52, purpose: 'Slab S1 reinforcement', lines: [['r12', { S1: 2600 }], ['wire', { S1: 20 }]],
    flow: [[53, 9, 'review'], [53, 14, 'approve', { by: 'manager', approve: { r12: 1800 }, comment: 'Approve 1 800 kg now; balance after PO-0006 delivery' }],
      [58, 8, 'issue', { lines: [['r12', 'S1', 320], ['wire', 'S1', 2]], ack: false }]] });
  mr('M19', { k: 53, by: 'office', purpose: 'HCB for wall W1', lines: [['hcb', { W1: 1250 }]],
    flow: [[54, 9, 'approve']] });
  mr('M20', { k: 54, purpose: 'Slab S1 formwork timber', lines: [['timber', { S1: 250 }]],
    flow: [[54, 14, 'review'], [55, 8, 'approve'], [55, 10, 'issue']] });
  mr('M21', { k: 54, h: 11, purpose: 'Staircase ST1 reinforcement', lines: [['r12', { ST1: 420 }], ['r8', { ST1: 60 }]],
    flow: [[55, 9, 'review'], [55, 11, 'return', { comment: 'Confirm bar sizes against revised drawing S-ST-01 Rev C' }]] });
  mr('M32', { k: 55, by: 'office', submit: false, purpose: 'L2 slab S2 formwork timber (draft)', lines: [['timber', { S2: 300 }]] });
  mr('M22', { k: 56, lookahead: true, req: 66, purpose: 'Level 2 columns C9–C14 reinforcement (look-ahead)', lines: [['r16', split(C914, 190)], ['r8', split(C914, 45)]],
    flow: [[56, 14, 'review'], [57, 9, 'approve', { by: 'manager' }],
      [57, 10, 'convert_shortfall', { pr: 'PR8', lines: { r8: 270 }, comment: 'No Ø8 in stock for the L2 links — purchase the shortfall' }]] });
  mr('M23', { k: 57, h: 8, by: 'office', purpose: 'Wall W1 mortar — cement & sand', lines: [['opc', { W1: 24 }], ['sand', { W1: 6 }]],
    flow: [[58, 9, 'approve']] });
  mr('M29', { k: 57, h: 10, by: 'office', lookahead: true, req: 75, purpose: 'Slab S2 (L2) reinforcement look-ahead', lines: [['r12', { S2: 2600 }], ['wire', { S2: 20 }]] });
  mr('M25', { k: 57, h: 11, purpose: 'Staircase ST1 formwork timber', lines: [['timber', { ST1: 60 }]], flow: [[58, 10, 'review']] });
  mr('M24', { k: 58, h: 8, purpose: 'Beams B3–B4 formwork timber (top-up; B1–B2 forms re-used)', lines: [['timber', { B3: 15, B4: 15 }]],
    flow: [[58, 11, 'review'], [59, 9, 'approve'], [59, 14, 'issue', { ack: false }]] });
  mr('M30', { k: 58, h: 11, purpose: 'Ready-mix concrete for staircase ST1', lines: [['c25', { ST1: 4.5 }]], flow: [[59, 9, 'review']] });
  mr('M26', { k: 59, h: 14, priority: 'urgent', purpose: 'Waterproofing membrane FB1–FB2 retaining face', lines: [['membrane', { FB1: 30, FB2: 30 }]], flow: [[60, 9, 'review']] });
  mr('M27', { k: 59, h: 16, purpose: 'Formwork timber for L2 columns C9–C14', lines: [['timber', split(C914, 30)]] });
  mr('M31', { k: 60, h: 7, submit: false, purpose: 'Lintels for W1 (draft)', lines: [['r8', { W1: 40 }]] });
  mr('M28', { k: 60, h: 8, priority: 'critical', purpose: 'Timber props for S1 bay 3 shoring', lines: [['timber', { S1: 60 }]] });

  // CMC requests
  const cF13 = ['cF1', 'cF2', 'cF3'], cF46 = ['cF4', 'cF5', 'cF6'], cC13 = ['cC1', 'cC2', 'cC3'];
  mr('CM1', { P: C, k: 27, purpose: 'Footings F1–F3 reinforcement', lines: [['r16', split(cF13, 300)], ['r12', split(cF13, 110)], ['wire', split(cF13, 4)]],
    flow: [[27, 14, 'review'], [28, 9, 'approve'], [30, 8, 'issue'], [38, 16, 'close']] });
  mr('CM2', { P: C, k: 33, purpose: 'Footings F4–F6 reinforcement', lines: [['r16', split(cF46, 300)], ['r12', split(cF46, 110)], ['wire', split(cF46, 4)]],
    flow: [[33, 14, 'review'], [34, 9, 'approve'], [40, 8, 'issue']] });
  mr('CM6', { P: C, k: 39, purpose: 'Extra Ø16 for F4', lines: [['r16', { cF4: 40 }, 'Additional dowels requested by site']],
    flow: [[39, 14, 'review'], [40, 10, 'reject', { comment: 'Not in the approved drawings — raise an RFI first' }]] });
  mr('CM3', { P: C, k: 45, purpose: 'Columns C1–C6 reinforcement', lines: [['r16', split(range('cC', 1, 6), 150)], ['r8', split(range('cC', 1, 6), 36)], ['wire', split(range('cC', 1, 6), 2)]],
    flow: [[45, 14, 'review'], [46, 9, 'approve'], [52, 8, 'issue', { lines: cC13.flatMap((c) => [['r16', c, 26], ['r8', c, 6]]) }]] });
  mr('CM5', { P: C, k: 57, purpose: 'Formwork timber for columns C4–C6', lines: [['timber', split(['cC4', 'cC5', 'cC6'], 25)]], flow: [[59, 10, 'review']] });
  mr('CM4', { P: C, k: 58, purpose: 'Slab S1 reinforcement (look-ahead)', lookahead: true, req: 70, lines: [['r12', { cS1: 2100 }], ['wire', { cS1: 16 }]] });
  mr('CM7', { P: C, k: 59, submit: false, purpose: 'Blinding for C4–C6 kickers (draft)', lines: [['opc', split(['cC4', 'cC5', 'cC6'], 1)]] });

  for (const [k, h, m, id] of mivAck) at(k, h, m, 'ack MIV', (t) => rpc(U.site, t, 'acknowledge_miv', { miv_id: id }));

  // Emergency issues (BR-01): one regularised next day, one still open (> 24 h → critical alert).
  const EMG1 = uuid(), EMG2 = uuid();
  at(38, 18, 30, 'emergency MIV 1', (t) => rpc(U.store, t, 'post_miv', { id: EMG1, project_id: D.id, store_id: D.YARD, number: no(D, 'MIV', DEV.store),
    is_emergency: true, emergency_reason: 'Night shift — C1 formwork panel failed during setting out', issued_to: U.site, issued_at: iso(t),
    lines: [{ id: uuid(), material_spec_id: S.timber, element_id: E('C1').id, qty: 20 }] }));
  at(39, 9, 0, 'regularise MIV 1', (t) => rpc(U.store, t, 'regularise_miv', { miv_id: EMG1, mr_id: MR.M37.id }));
  at(58, 17, 40, 'emergency MIV 2', (t) => rpc(U.store, t, 'post_miv', { id: EMG2, project_id: D.id, store_id: D.YARD, number: no(D, 'MIV', DEV.store),
    is_emergency: true, emergency_reason: 'Beam B1 soffit props — formwork settled after rain', issued_to: U.site, issued_at: iso(t),
    lines: [{ id: uuid(), material_spec_id: S.timber, element_id: E('B1').id, qty: 15 }] }));
  at(59, 8, 0, 'ack emergency', (t) => rpc(U.site, t, 'acknowledge_miv', { miv_id: EMG2 }));

  // ===========================================================================
  // C. Procurement: purchase requests, RFQs, quotations, awards, POs, delivery notices, GRNs
  // ===========================================================================
  // RFQ from purchase-request lines (o.pr; create_rfq_from_prs) or free lines (o.lines; save_rfq).
  function rfq(key, o) {
    // o: { k, title, pr | lines: [[spec, qty]], suppliers: [names], quotes: [[k, supplier, {spec: price|null}, {days, vat, transport:{spec: cost}, terms}]],
    //      award: [k, by, [[spec, supplier, reason?]], [[supplier, orderK, expectedK, poKey]]], close: k, cancel: [k, reason], send: bool }
    const src = o.pr ? PR[o.pr] : null;
    const rec = {
      id: uuid(), quotes: {},
      lines: src ? src.lines.map((l) => ({ id: null, sp: l.sp, qty: l.qty, prLine: l.id }))
        : o.lines.map(([sp, qty]) => ({ id: uuid(), sp, qty })),
    };
    ST.rfq[key] = rec;
    at(o.k, o.h ?? 11, 0, `${key} create`, async (t) => {
      rec.number = no(D, 'RFQ', DEV.proc);
      if (src) {
        const r = await rpc(U.proc, t, 'create_rfq_from_prs', { id: rec.id, number: rec.number, title: o.title, required_by: ds(o.k + (o.lead ?? 8)),
          notes: o.notes, send: o.send !== false, mr_line_ids: rec.lines.map((l) => l.prLine), supplier_ids: o.suppliers.map((s) => SUP[s]),
          sent_via: pick(['telegram', 'email', 'phone']) });
        for (const m of r.lines) rec.lines.find((l) => l.prLine === m.mr_line_id).id = m.rfq_line_id;
        return r;
      }
      return rpc(U.proc, t, 'save_rfq', { id: rec.id, project_id: D.id, number: rec.number, title: o.title, required_by: ds(o.k + (o.lead ?? 8)),
        delivery_store_id: storeOf(D, rec.lines[0].sp), notes: o.notes, send: o.send !== false,
        lines: rec.lines.map((l) => ({ id: l.id, material_spec_id: S[l.sp], qty: l.qty })),
        suppliers: o.suppliers.map((s) => ({ supplier_id: SUP[s], sent_via: pick(['telegram', 'email', 'phone', 'in_person']) })) });
    });
    for (const [k, sup, prices, x = {}] of o.quotes ?? []) {
      const qid = uuid();
      rec.quotes[sup] = { id: qid, lines: {} };
      at(k, 14, 0, `${key} quote ${sup}`, async (t) => {
        await rpc(U.proc, t, 'record_quotation', { id: qid, rfq_id: rec.id, supplier_id: SUP[sup], number: no(D, 'QT', DEV.proc),
          quote_ref: `PF-${Math.floor(1000 + rnd() * 8999)}`, quote_date: ds(k), valid_until: ds(k + 12), prices_include_vat: !!x.vat,
          delivery_days: x.days ?? 5, payment_terms: x.terms ?? 'Cash on delivery', transport_included: !x.transport,
          lines: rec.lines.map((l) => {
            const id = uuid();
            rec.quotes[sup].lines[l.sp] = id;
            const price = prices[l.sp];
            return price == null ? { id, rfq_line_id: l.id, available: false, remarks: 'Not available' }
              : { id, rfq_line_id: l.id, unit_price: price, transport_cost: x.transport?.[l.sp] ?? 0 };
          }) });
      });
    }
    if (o.close) at(o.close, 9, 0, `${key} close`, (t) => rpc(U.proc, t, 'rfq_action', { rfq_id: rec.id, action: 'close' }));
    if (o.cancel) at(o.cancel[0], 9, 0, `${key} cancel`, (t) => rpc(U.proc, t, 'rfq_action', { rfq_id: rec.id, action: 'cancel', comment: o.cancel[1] }));
    if (o.award) {
      const [k, by, awards, pos] = o.award;
      for (const [sup, , , poKey] of pos) ST.po[poKey] = { id: uuid(), sup };
      at(k, 15, 30, `${key} award`, async (t) => {
        const poDefs = pos.map(([sup, ok, ek, poKey]) => {
          ST.po[poKey].number = no(D, 'PO', DEV.proc);
          return { supplier_id: SUP[sup], id: ST.po[poKey].id, number: ST.po[poKey].number, order_date: ds(ok), expected_date: ds(ek) };
        });
        // The coordinator awards (and so creates the PO); approval is somebody else's — or automatic (traced PR, lowest quote).
        await rpc(U[by], t, 'award_rfq', { rfq_id: rec.id, create_po: true, pos: poDefs,
          awards: awards.map(([sp, sup, reason]) => ({ rfq_line_id: rec.lines.find((l) => l.sp === sp).id,
            quotation_line_id: rec.quotes[sup].lines[sp], reason })) });
      });
    }
    return rec;
  }
  // PO lifecycle steps on an existing (award-created or manual) PO.
  //   notice: procurement announces a delivery (notify_store_delivery) — the store keeper accepts it
  //   (or asks for another date) and the GRN later closes it; { dn: key, eta, lines?: {spec: qty} }.
  ST.dn = {};
  function poSteps(poKey, steps) {
    for (const [k, h, action, arg = {}] of steps) {
      if (action === 'notice') {
        const dn = ST.dn[arg.dn] = { id: uuid(), plate: plate(), driver: pick(DRIVERS) };
        at(k, h, arg.m ?? 0, `${poKey} delivery notice`, async (t) => {
          const po = ST.po[poKey];
          const pls = await q('select id, material_spec_id from po_lines where po_id = $1 and deleted_at is null', [po.id]);
          return rpc(U.proc, t, 'notify_store_delivery', { id: dn.id, po_id: po.id, expected_date: ds(arg.eta), expected_window: arg.window ?? '07:00–09:00',
            vehicle_plate: dn.plate, driver_name: dn.driver, driver_phone: `+2519${Math.floor(10000000 + rnd() * 89999999)}`, note: arg.note,
            lines: arg.lines ? Object.entries(arg.lines).map(([sp, qty]) => ({ po_line_id: pls.find((x) => x.material_spec_id === S[sp]).id, qty })) : undefined });
        });
        if (arg.reschedule) {
          const [kr, proposed, note] = arg.reschedule;
          at(kr, h + 1, 0, `${poKey} notice reschedule`, (t) => rpc(U.store, t, 'acknowledge_delivery_notice', { id: dn.id, decision: 'reschedule',
            proposed_date: ds(proposed), note }));
        }
        if (arg.ack !== false) {
          const [ka, ha] = arg.ackAt ?? [k, h + 1];
          at(ka, ha, 30, `${poKey} notice accepted`, (t) => rpc(U.store, t, 'acknowledge_delivery_notice', { id: dn.id, decision: 'accept',
            note: arg.ackNote ?? pick(['Space cleared in the yard; unloading crew ready', 'OK — receive at the main store', 'Accepted; forklift booked']) }));
        }
        continue;
      }
      at(k, h, arg.m ?? 0, `${poKey} ${action}`, async (t) => {
        const po = ST.po[poKey];
        if (action === 'delivery') {
          return rpc(U.proc, t, 'update_po_delivery', { po_id: po.id, status: arg.status, eta: arg.eta != null ? ds(arg.eta) : undefined, note: arg.note });
        }
        if (action === 'approve') {
          // POs traced to management-approved PRs at the lowest quotation are approved automatically on submit.
          const cur = await one('select status, auto_approved from purchase_orders where id = $1', [po.id]);
          if (cur?.status === 'approved' && cur.auto_approved) return cur;
        }
        const who = arg.by ?? { submit: 'proc', approve: 'manager', reject: 'manager', send: 'proc', cancel: 'proc', close: 'proc' }[action];
        return rpc(U[who], t, 'po_action', { po_id: po.id, action, comment: arg.comment });
      });
    }
  }
  function manualPo(poKey, k, o) {
    const id = uuid();
    ST.po[poKey] = { id, sup: o.sup };
    const P = o.P ?? D;
    at(k, o.h ?? 10, 30, `${poKey} create`, async (t) => {
      ST.po[poKey].number = no(P, 'PO', DEV.proc);
      await rpc(U.proc, t, 'save_po', { id, project_id: P.id, number: ST.po[poKey].number, supplier_id: SUP[o.sup], delivery_store_id: storeOf(P, o.lines[0][0]),
        order_date: ds(k), expected_date: ds(o.exp ?? k + 6), payment_terms: o.terms, delivery_terms: o.delivery ?? 'Delivered to site, unloading by supplier',
        remarks: o.remarks, submit: !!o.submit,
        lines: o.lines.map(([sp, qty, price, mrKey]) => ({ id: uuid(), material_spec_id: S[sp], qty, unit_price: price,
          mr_line_id: mrKey ? MR[mrKey].lines.find((x) => x.sp === sp).id : undefined })) });
    });
  }
  // GRN against a PO (lines: [[spec, delivered, rejected?, note?]], dn: delivery notice key) or a local purchase (no PO).
  function grn(k, h, o) {
    const id = uuid();
    const P = o.P ?? D;
    const dn = o.dn ? ST.dn[o.dn] : null;
    if (o.dn && !dn) throw new Error(`unknown delivery notice ${o.dn}`);
    const pl = dn?.plate ?? plate(), driver = dn?.driver ?? pick(DRIVERS);
    at(k, h, o.m ?? 0, `GRN ${o.poKey ?? o.supplier}`, async (t) => {
      const po = o.poKey ? ST.po[o.poKey] : null;
      const poLines = po ? await q('select id, material_spec_id from po_lines where po_id = $1 and deleted_at is null', [po.id]) : [];
      const number = no(P, 'GRN', DEV.store);
      ST.grn.push({ id, number, P, k });
      await rpc(U.store, t, 'post_grn', { id, project_id: P.id, store_id: storeOf(P, o.lines[0][0]), number, po_id: po?.id, delivery_notice_id: dn?.id,
        supplier_id: po ? undefined : SUP[o.supplier], supplier_name: o.supplierName, delivery_note_no: `DN-${Math.floor(10000 + rnd() * 89999)}`,
        vehicle_plate: pl, driver_name: driver, received_at: iso(t), remarks: o.remarks,
        lines: o.lines.map(([sp, del, rej = 0, note]) => ({ id: uuid(), material_spec_id: S[sp],
          po_line_id: po ? poLines.find((x) => x.material_spec_id === S[sp]).id : undefined,
          qty_delivered: del, qty_rejected: rej, inspection_result: rej > 0 ? 'conditional' : 'pass', inspection_notes: note,
          batch_no: ['r8', 'r12', 'r16', 'opc'].includes(sp) ? `${sp.toUpperCase()}-${ds(k).replace(/-/g, '').slice(2)}-${Math.floor(10 + rnd() * 89)}` : undefined })) });
    });
    VEH.push({ P, k, h, m: o.m ?? 0, plate: pl, driver, purpose: `Delivery — ${o.label ?? o.lines.map((l) => l[0]).join(', ')}`, doc: 'grn', docId: id,
      inDoc: dn ? 'delivery_notice' : undefined, inDocId: dn?.id });
    return id;
  }

  // --- PR-1 → RFQ-1 → PO-1 (Abyssinia, both lines; Ø12 not the lowest → reason → manager approves the PO)
  pr('PR1', { k: 2, purpose: 'Reinforcement for footings F1–F8 (stock)', req: 11, lines: [['r16', 3000], ['r12', 1500]],
    flow: [[2, 14, 'review', { m: 30, comment: 'Quantities checked against the F1–F8 take-off' }], [3, 8, 'approve', { m: 30 }], [3, 10, 'accept']] });
  rfq('R1', { k: 3, pr: 'PR1', title: 'Reinforcement for footings F1–F8',
    suppliers: ['Abyssinia Steel PLC', 'Kality Metal Works', 'Habesha Steel Mills'],
    quotes: [[4, 'Abyssinia Steel PLC', { r16: 94.5, r12: 92 }, { days: 5, terms: '30 days' }],
      [4, 'Kality Metal Works', { r16: 96, r12: 91 }, { days: 18, transport: { r16: 4500 }, terms: '30 days' }],
      [5, 'Habesha Steel Mills', { r16: 112, r12: 109 }, { days: 7, vat: true }]],
    award: [5, 'coordinator', [['r16', 'Abyssinia Steel PLC'], ['r12', 'Abyssinia Steel PLC', 'Single delivery with the Ø16; Kality lead time 18 days']],
      [['Abyssinia Steel PLC', 5, 11, 'PO1']]] });
  poSteps('PO1', [[5, 16, 'submit'], [6, 9, 'approve'], [6, 11, 'send'], [8, 10, 'delivery', { status: 'confirmed', eta: 12 }],
    [11, 10, 'notice', { dn: 'PO1-1', eta: 12, window: '06:30–08:00', note: 'Truck leaves Akaki 06:00' }],
    [11, 16, 'delivery', { status: 'dispatched', eta: 12, note: 'Truck leaves Akaki 06:00' }], [16, 11, 'close']]);
  grn(12, 7, { poKey: 'PO1', dn: 'PO1-1', lines: [['r16', 3000], ['r12', 1500]], remarks: 'Mill certificates attached' });

  // Local purchases without PO
  grn(12, 7, { m: 30, supplier: 'Merkato Hardware', supplierName: 'Merkato Hardware', lines: [['wire', 50]], remarks: 'Local purchase — petty cash' });
  grn(18, 14, { supplier: 'Merkato Hardware', supplierName: 'Merkato Hardware', lines: [['membrane', 50]], remarks: 'Local purchase — membrane rolls' });
  grn(34, 15, { supplier: 'Merkato Hardware', supplierName: 'Merkato Hardware', lines: [['wire', 30]], remarks: 'Local purchase — petty cash (wire for C1–C4)' });

  // PO-7 sand & aggregate (manual PO by procurement, approved by the coordinator)
  manualPo('PO7', 18, { sup: 'Sheger Aggregates', lines: [['sand', 14, 1150], ['agg', 14, 1380]], exp: 20, terms: 'Cash on delivery' });
  poSteps('PO7', [[18, 11, 'submit'], [18, 14, 'approve', { by: 'coordinator' }], [18, 15, 'send'],
    [19, 15, 'notice', { dn: 'PO7-1', eta: 20, lines: { sand: 14 }, note: 'Two trucks of sand' }],
    [36, 15, 'notice', { dn: 'PO7-2', eta: 37, lines: { agg: 14 }, note: 'Aggregate balance — two trucks' }]]);
  grn(20, 9, { poKey: 'PO7', dn: 'PO7-1', lines: [['sand', 14]], label: 'sand 2 trucks' });
  grn(37, 9, { poKey: 'PO7', dn: 'PO7-2', lines: [['agg', 14]], label: 'aggregate 2 trucks' });

  // --- PR-2 → RFQ-2 → PO-2 (Kality Ø16) + PO-3 (Habesha Ø8): lowest quotes on a management-approved PR → auto-approved POs.
  //     PO-3: 15 kg rejected, short-closed; the PR is short-closed for the waived balance.
  pr('PR2', { k: 19, purpose: 'Reinforcement for ground beams and annex footings', req: 26, lines: [['r16', 2500], ['r8', 400]],
    flow: [[19, 15, 'review'], [20, 9, 'approve'], [20, 10, 'accept'],
      [31, 11, 'close', { comment: 'Ø8 balance of 15 kg waived — supplier credit note CN-118' }]] });
  rfq('R2', { k: 20, pr: 'PR2', title: 'Reinforcement for ground beams and annex footings',
    suppliers: ['Abyssinia Steel PLC', 'Kality Metal Works', 'Habesha Steel Mills'],
    quotes: [[21, 'Abyssinia Steel PLC', { r16: 97.5, r8: 100 }, { days: 4 }], [21, 'Kality Metal Works', { r16: 96.8, r8: 101 }, { days: 3 }],
      [21, 'Habesha Steel Mills', { r16: 98, r8: 99 }, { days: 3 }]],
    award: [22, 'coordinator', [['r16', 'Kality Metal Works'], ['r8', 'Habesha Steel Mills']],
      [['Kality Metal Works', 22, 25, 'PO2'], ['Habesha Steel Mills', 22, 26, 'PO3']]] });
  poSteps('PO2', [[22, 16, 'submit'], [23, 9, 'approve'], [23, 10, 'send'], [24, 11, 'notice', { dn: 'PO2-1', eta: 25 }]]);
  poSteps('PO3', [[22, 16, 'submit', { m: 10 }], [23, 9, 'approve', { m: 10 }], [23, 10, 'send', { m: 10 }], [25, 11, 'notice', { dn: 'PO3-1', eta: 26 }],
    [31, 10, 'close', { comment: 'Balance 15 kg waived — supplier credit note CN-118' }]]);
  grn(25, 8, { poKey: 'PO2', dn: 'PO2-1', lines: [['r16', 2500]] });
  grn(26, 8, { poKey: 'PO3', dn: 'PO3-1', lines: [['r8', 400, 15, '15 kg heavily rusted — quarantined, credit note requested']] });

  rfq('R9', { k: 29, title: 'Sand & aggregate top-up', lines: [['sand', 7], ['agg', 7]], suppliers: ['Sheger Aggregates', 'Akaki Aggregates'],
    cancel: [30, 'Bought locally on PO-0007 balance'] });

  // --- PR-3 → RFQ-3 → PO-4 (Derba, not the lowest → reason; awarded by the coordinator, approved by the manager)
  pr('PR3', { k: 30, purpose: 'Cement OPC 42.5 for annex footings and L1 columns', req: 35, lines: [['opc', 100]],
    flow: [[30, 14, 'review'], [31, 9, 'approve'], [31, 10, 'accept']] });
  rfq('R3', { k: 31, pr: 'PR3', title: 'Cement OPC 42.5 for annex & columns', suppliers: ['Derba Cement', 'Mugher Cement Enterprise', 'National Cement S.C.'],
    quotes: [[32, 'Derba Cement', { opc: 1520 }, { days: 2 }], [32, 'Mugher Cement Enterprise', { opc: 1495 }, { days: 15 }],
      [32, 'National Cement S.C.', { opc: 1540 }, { days: 4 }]],
    award: [33, 'coordinator', [['opc', 'Derba Cement', 'Mugher lead time 15 days — cement needed for GB/C1–C4 pours']], [['Derba Cement', 33, 35, 'PO4']]] });
  poSteps('PO4', [[33, 16, 'submit'], [33, 17, 'approve'], [34, 9, 'send'], [34, 10, 'notice', { dn: 'PO4-1', eta: 35 }]]);
  grn(35, 8, { poKey: 'PO4', dn: 'PO4-1', lines: [['opc', 100]] });

  // --- PR-4 → RFQ-4 → PO-5 (Abyssinia; partially received and delayed → PR partially received)
  pr('PR4', { k: 38, purpose: 'Reinforcement for L1 columns, beams and slab', req: 46, lines: [['r16', 3000], ['r12', 2600], ['r8', 400]],
    flow: [[38, 14, 'review'], [39, 9, 'approve'], [39, 10, 'accept', { m: 30 }]] });
  rfq('R4', { k: 39, pr: 'PR4', title: 'Reinforcement for L1 columns, beams and slab',
    suppliers: ['Abyssinia Steel PLC', 'Kality Metal Works', 'Habesha Steel Mills'],
    quotes: [[40, 'Abyssinia Steel PLC', { r16: 99.5, r12: 97, r8: 101 }, { days: 5, terms: '30 days' }],
      [40, 'Kality Metal Works', { r16: 100.2, r12: 96.5, r8: null }, { days: 10 }],
      [40, 'Habesha Steel Mills', { r16: 101, r12: 98, r8: 103 }, { days: 6 }]],
    award: [41, 'coordinator', [['r16', 'Abyssinia Steel PLC'], ['r12', 'Abyssinia Steel PLC', 'One supplier for the slab steel — Kality cannot supply Ø8'], ['r8', 'Abyssinia Steel PLC']],
      [['Abyssinia Steel PLC', 41, 46, 'PO5']]] });
  poSteps('PO5', [[41, 16, 'submit'], [42, 9, 'approve'], [42, 10, 'send'], [43, 11, 'delivery', { status: 'confirmed', eta: 45 }],
    [44, 10, 'notice', { dn: 'PO5-1', eta: 45, lines: { r16: 1000 }, note: 'First lot Ø16' }],
    [46, 10, 'delivery', { status: 'delayed', eta: 53, note: 'Mill rolling schedule slipped — Ø12 and Ø8 next week' }],
    [51, 10, 'notice', { dn: 'PO5-2', eta: 52, lines: { r8: 100 }, note: 'Part delivery Ø8' }],
    [53, 15, 'delivery', { status: 'delayed', eta: 57, note: 'Ø12 dispatched in two lots' }],
    [55, 10, 'notice', { dn: 'PO5-3', eta: 56, lines: { r12: 1300 }, note: 'Ø12 lot 1', reschedule: [55, 57, 'Crane busy with the S1 formwork on the 56th — deliver next day'],
      ackAt: [56, 9] }],
    [58, 14, 'delivery', { status: 'delayed', eta: 64, note: 'Balance: Ø16 2 000 kg, Ø12 1 300 kg, Ø8 300 kg' }]]);
  grn(45, 8, { poKey: 'PO5', dn: 'PO5-1', lines: [['r16', 1000]], remarks: 'First lot' });
  grn(52, 8, { poKey: 'PO5', dn: 'PO5-2', lines: [['r8', 100]], remarks: 'Part delivery Ø8' });
  grn(57, 8, { poKey: 'PO5', dn: 'PO5-3', lines: [['r12', 1300]], remarks: 'Ø12 lot 1' });

  // --- PR-5 (urgent) → RFQ-5 → PO-6 (Mugher, cement shortage; part delivered, balance announced → delivery expected)
  pr('PR5', { k: 42, h: 9, priority: 'urgent', purpose: 'Cement OPC 42.5 — shortage cover', req: 47, lines: [['opc', 120]],
    flow: [[42, 15, 'review', { comment: 'Market rationing — cover the C1–C8 and FB3 pours' }], [43, 8, 'approve', { m: 30 }], [43, 9, 'accept', { m: 30 }]] });
  rfq('R5', { k: 43, h: 10, pr: 'PR5', title: 'Cement OPC 42.5 — shortage cover', lead: 4, suppliers: ['Derba Cement', 'Mugher Cement Enterprise', 'National Cement S.C.'],
    quotes: [[44, 'Derba Cement', { opc: null }, { days: 20 }], [44, 'Mugher Cement Enterprise', { opc: 1780 }, { days: 4 }],
      [44, 'National Cement S.C.', { opc: 1820 }, { days: 6 }]],
    award: [44, 'coordinator', [['opc', 'Mugher Cement Enterprise']], [['Mugher Cement Enterprise', 44, 48, 'PO6']]] });
  poSteps('PO6', [[44, 16, 'submit'], [44, 17, 'approve'], [45, 9, 'send'], [47, 10, 'delivery', { status: 'delayed', eta: 52, note: 'Factory rationing — allocation reduced' }],
    [53, 10, 'notice', { dn: 'PO6-1', eta: 54, lines: { opc: 40 }, note: 'Partial allocation 40 qtl' }],
    [55, 10, 'delivery', { status: 'delayed', eta: 58, note: 'Remaining 80 qtl awaiting factory allocation' }],
    [59, 11, 'notice', { dn: 'PO6-2', eta: 61, lines: { opc: 80 }, note: 'Factory released the balance — truck on Monday' }]]);
  grn(54, 8, { poKey: 'PO6', dn: 'PO6-1', lines: [['opc', 40]], remarks: 'Partial allocation 40 qtl' });

  manualPo('PO12', 45, { sup: 'National Cement S.C.', lines: [['opc', 50, 1800]], exp: 49 });
  poSteps('PO12', [[45, 14, 'submit'], [46, 9, 'approve'], [47, 9, 'cancel', { comment: 'Duplicate of PO-0007 allocation' }]]);
  manualPo('PO11', 48, { sup: 'Addis Ready-Mix', lines: [['c30', 50, 8900]], exp: 55, remarks: 'Standing order ready-mix' });
  poSteps('PO11', [[48, 11, 'submit'], [48, 15, 'reject', { comment: 'Grade not required — design is C-25/30' }]]);

  // PO-8 HCB (manual; 120 broken → quarantine)
  manualPo('PO8', 50, { sup: 'Lucy Blocks & Pavers', lines: [['hcb', 2000, 33]], exp: 62, terms: 'Cash on delivery' });
  poSteps('PO8', [[50, 11, 'submit'], [51, 9, 'approve', { by: 'coordinator' }], [51, 10, 'send'], [52, 14, 'notice', { dn: 'PO8-1', eta: 53, note: 'Two trucks, 1 000 pcs each' }]]);
  grn(53, 9, { poKey: 'PO8', dn: 'PO8-1', lines: [['hcb', 2000, 120, '120 pcs broken during unloading']], label: 'HCB' });

  // --- PR-6 → RFQ-6 (sent, 2 of 3 quotations) and PR-7 → RFQ-7 (closed, awaiting award): both "sourcing"
  pr('PR6', { k: 54, purpose: 'HCB for L1 partitions and aggregate top-up', req: 64, lines: [['hcb', 1250], ['agg', 21]],
    flow: [[54, 14, 'review'], [55, 9, 'approve']] });
  rfq('R6', { k: 55, pr: 'PR6', title: 'HCB for L1 walls and aggregate', suppliers: ['Lucy Blocks & Pavers', 'Akaki Aggregates', 'Sheger Aggregates'],
    quotes: [[57, 'Lucy Blocks & Pavers', { hcb: 33.5, agg: null }, { days: 5 }], [58, 'Akaki Aggregates', { hcb: 34, agg: 1390 }, { days: 3 }]] });
  pr('PR7', { k: 55, purpose: 'Ø8 links and binding wire for L1 beams / L2 columns', req: 63, lines: [['r8', 600], ['wire', 100]],
    flow: [[55, 15, 'review'], [56, 9, 'approve'], [56, 10, 'accept']] });
  rfq('R7', { k: 56, pr: 'PR7', title: 'Ø8 links and binding wire', suppliers: ['Abyssinia Steel PLC', 'Kality Metal Works', 'Habesha Steel Mills'],
    quotes: [[57, 'Abyssinia Steel PLC', { r8: 104, wire: 150 }, { days: 6 }], [57, 'Kality Metal Works', { r8: 102.5, wire: 155 }, { days: 9 }],
      [58, 'Habesha Steel Mills', { r8: 105, wire: 146 }, { days: 4 }]], close: 59 });
  rfq('R8', { k: 60, title: 'Bituminous membrane for basement walls', send: false, lines: [['membrane', 200]], suppliers: ['Akaki Aggregates'] });

  // --- PR-8: shortfall of the L2 column request (M22, Ø8) converted to a PR by the office engineer → manual PO-15 → ordered
  pr('PR8', { k: 57, shortfall: true, lines: [['r8', 270]],
    flow: [[57, 15, 'review'], [58, 9, 'approve'], [58, 10, 'accept']] });
  manualPo('PO15', 58, { h: 11, sup: 'Habesha Steel Mills', lines: [['r8', 270, 103, 'PR8']], exp: 66, terms: 'Advance 30%, balance on delivery',
    remarks: 'Direct order — Habesha quoted 103 on RFQ-0008 and can deliver in 4 days' });
  poSteps('PO15', [[58, 12, 'submit'], [58, 14, 'approve'], [58, 15, 'send']]);

  // --- Approval cover: the manager is at head office for the tender board; PR approvals delegated to the coordinator.
  at(57, 16, 0, 'approval delegation', (t) => rpc(U.manager, t, 'save_approval_delegation', { id: uuid(), project_id: D.id, from_user: U.manager,
    to_user: U.coordinator, doc_type: 'purchase_request', valid_from: ds(59), valid_to: ds(66),
    reason: 'Manager at head office for the tender board — purchase request approvals delegated' }));
  // PR-9: approved by the coordinator under the delegation, accepted by procurement → with procurement
  pr('PR9', { k: 58, purpose: 'Formwork timber for the L2 roof slab', req: 70, lines: [['timber', 600]],
    flow: [[58, 14, 'review'], [59, 15, 'approve', { by: 'coordinator', comment: 'Approved under delegation (manager at head office)' }],
      [60, 9, 'accept', { comment: 'Will ask Ethio Timber and two others' }]] });
  // PR-10: approved (delegate), not yet picked up by procurement
  pr('PR10', { k: 59, h: 9, purpose: 'Sand for wall W1 mortar and floor screeds', req: 66, lines: [['sand', 14]],
    flow: [[59, 11, 'review'], [60, 10, 'approve', { by: 'coordinator', comment: 'Approved under delegation' }]] });
  // PR-11: reviewed by the coordinator, waiting for approval
  pr('PR11', { k: 59, h: 14, purpose: 'HCB 15 cm for L1 internal partitions', req: 70, lines: [['hcb15', 1500]],
    flow: [[60, 9, 'review', { m: 30, comment: 'Matches the partition layout A-WL-04' }]] });
  // PR-12: submitted; PR-13: draft
  pr('PR12', { k: 60, h: 8, purpose: 'Binding wire top-up', req: 65, lines: [['wire', 60]] });
  pr('PR13', { k: 60, h: 7, submit: false, purpose: 'Bituminous membrane for basement retaining walls (draft)', lines: [['membrane', 200]] });
  // PR-14 rejected, PR-15 cancelled, PR-16 returned for clarification
  pr('PR14', { k: 46, purpose: 'Ready-mix concrete C-30/37 standing order', req: 55, lines: [['c30', 50]],
    flow: [[46, 14, 'review'], [47, 10, 'reject', { comment: 'Grade not required — design is C-25/30' }]] });
  pr('PR15', { k: 50, purpose: 'Formwork timber for L1 beams (duplicate)', req: 56, lines: [['timber', 300]],
    flow: [[50, 15, 'cancel', { comment: 'Duplicate — timber covered by stock and the yard re-use plan' }]] });
  pr('PR16', { k: 52, purpose: 'Rebar Ø12 for slab S2 (L2)', req: 70, lines: [['r12', 2600]],
    flow: [[53, 10, 'return', { comment: 'S2 BBS not approved yet — check the quantity against the L2 take-off' }]] });

  // Manual POs in other states (no PR)
  manualPo('PO13', 59, { sup: 'Sheger Aggregates', lines: [['sand', 14, 1160]], exp: 63 });
  poSteps('PO13', [[59, 11, 'submit'], [59, 15, 'approve', { by: 'coordinator' }]]);
  manualPo('PO9', 59, { sup: 'Merkato Hardware', lines: [['wire', 80, 150]], exp: 62, submit: true, remarks: 'Urgent top-up while RFQ-0008 is evaluated' });
  manualPo('PO10', 60, { sup: 'Ethio Timber Supply', lines: [['timber', 500, 185]], exp: 66, submit: true });
  manualPo('PO14', 60, { sup: 'Akaki Aggregates', lines: [['agg', 21, 1390]], exp: 66 });

  // CMC procurement (manual POs by procurement, approved by the manager)
  manualPo('CPO1', 43, { P: C, sup: 'Kality Metal Works', lines: [['r16', 1500, 99]], exp: 49 });
  poSteps('CPO1', [[43, 14, 'submit'], [44, 9, 'approve'], [44, 10, 'send'], [48, 10, 'notice', { dn: 'CPO1-1', eta: 49 }]]);
  grn(49, 8, { P: C, poKey: 'CPO1', dn: 'CPO1-1', lines: [['r16', 1500]] });
  manualPo('CPO2', 52, { P: C, sup: 'Mugher Cement Enterprise', lines: [['opc', 50, 1700]], exp: 57 });
  poSteps('CPO2', [[52, 14, 'submit'], [53, 9, 'approve'], [53, 10, 'send']]);
  grn(42, 9, { P: C, supplier: 'Sheger Aggregates', supplierName: 'Sheger Aggregates', lines: [['sand', 7]], remarks: 'Cash purchase' });

  // ===========================================================================
  // D. Progress, inspections, pours, cubes
  // ===========================================================================
  let elIdx = 0;
  const elMin = {};
  const mOf = (key) => (elMin[key] ??= (elIdx++ * 3) % 50);
  // Report an activity (site engineer) and verify it (office engineer).
  function prog(key, seq, pct, kr, kv, v = {}) {
    const pid = uuid();
    const P = E(key).P, mm = mOf(key);
    const a = () => act(key, seq);
    at(kr, v.hr ?? 16, mm, `report ${key}#${seq}`, (t) => rpc(U.site, t, 'report_progress', { id: pid, element_activity_id: a().id, pct_complete: pct,
      report_date: ds(kr), remarks: v.remarks }));
    work(P, kr, key, `${(ACT[E(key).id] ?? []).find((x) => x.seq === seq)?.name ?? 'work'} ${pct}%`);
    if (kv != null && kv <= 60) {
      at(kv, v.hv ?? 9, mm, `verify ${key}#${seq}`, (t) => rpc(U.office, t, 'verify_progress', { progress_id: pid,
        approve: v.reject ? false : true, verified_pct: v.pct, comment: v.comment }));
    }
  }
  // Pre-casting activities spread between start and the day before the inspection.
  function preCast(key, s, c) {
    const pre = (ACT[E(key).id] ?? []).filter((a) => a.seq < castSeq(key) && !a.is_hold_point);
    const span = Math.max(pre.length, c - 1 - s);
    let prev = s - 1;
    pre.forEach((a, i) => {
      const done = Math.max(prev, s + Math.floor(((i + 1) * span) / pre.length) - 1);
      if (Number(a.weight) >= 20 && done - prev >= 2) {
        const mid = prev + Math.floor((done - prev) / 2);
        prog(key, a.seq, 50, mid, mid + 1);
      }
      prog(key, a.seq, 100, done, done + 1);
      prev = done;
    });
  }
  function postCast(key, steps) { for (const [seq, k, v] of steps) if (k <= 60) prog(key, seq, 100, k, k + 1, v); }

  // Hold-point inspections: request (site) the day before, checklists (office) on kIns.
  const itemsFor = (code, over = {}) => TPL[code].items.map((it) => {
    const o = over[it.seq];
    if (o) return { template_item_id: it.id, ...o };
    if (it.item_type === 'value') {
      const lo = it.min_value == null ? null : Number(it.min_value), hi = it.max_value == null ? null : Number(it.max_value);
      const v = lo != null && hi != null ? round(lo + (hi - lo) * between(0.25, 0.55, 2), 0) : 200;
      return { template_item_id: it.id, value_num: v };
    }
    return { template_item_id: it.id, response: 'pass' };
  });
  // submit_inspection records the hold point as passed "today" (real date): put it on the inspection day
  // straight away, so element-driven schedule tasks earn on the right date during the seed.
  const fixHoldPoints = (k) => superTx(async () => {
    await db.exec('set local session_replication_role = replica');
    const rows = (await db.query(`update progress_updates set report_date = $1 where remarks like 'Hold point passed%' and report_date > $1
      returning element_id`, [ds(k)])).rows;
    if (!rows.length || !SCH.id) return;
    await db.query(`select app.refresh_task_progress(x.task_id, false) from (select distinct l.task_id from task_element_links l
      join schedule_tasks t on t.id = l.task_id where l.element_id = any ($1::uuid[]) and l.deleted_at is null and t.ev_method = 'elements') x`,
    [rows.map((r) => r.element_id)]);
    await db.query('select app.rollup_summaries($1)', [SCH.id]);
  });
  function inspections(key, kReq, kIns, o = {}) {
    const el = E(key), P = el.P;
    const codes = ['slab', 'staircase'].includes(el.type) ? ['PREPOUR-SLAB'] : ['REBAR', 'FORMWORK'];
    codes.forEach((code, i) => {
      const id = uuid();
      ST.insp[`${key}:${code}`] = id;
      at(kReq, 15, mOf(key) + i, `request ${code} ${key}`, (t) => rpc(U.site, t, 'request_inspection', { id, project_id: P.id, number: no(P, 'INS', DEV.site),
        template_id: TPL[code].id, element_id: el.id, element_activity_id: act(key, holdSeq(key)).id, requested_for: new Date(WD.get(kIns) - EAT + 9 * 3600e3).toISOString(),
        remarks: `${TPL[code].name} before casting ${el.code}` }));
      if (o.pending) return;
      const fail = o.fail === code, cond = o.conditional === code;
      at(kIns, 10, i * 20 + mOf(key) % 15, `inspect ${code} ${key}`, async (t) => {
        const r = await rpc(U.office, t, 'submit_inspection', { id, consultant_name: pick(['Eng. Mekdes (consultant)', 'Eng. Samuel (consultant)', 'Eng. Hirut (consultant)']),
          inspected_at: iso(t), remarks: fail ? 'Cover below minimum at two faces — re-inspect after correction' : cond ? 'Minor grout leaks — seal joints before pour' : 'OK to proceed',
          snag_defaults: { assignee_user_id: U.site, due_date: ds(kIns + 1), trade: code === 'REBAR' ? 'Bar bending' : 'Carpentry' },
          items: itemsFor(code, fail ? { 5: { value_num: 15 } } : cond ? { 4: { response: 'fail', create_snag: true } } : {}) });
        if (r.snag_ids?.length) ST.snag[`${key}:${code}`] = r.snag_ids[0];
        await fixHoldPoints(kIns);
      });
      if (fail) {
        at(kIns, 13, 0, `snag start ${key}`, (t) => rpc(U.site, t, 'snag_action', { snag_id: ST.snag[`${key}:${code}`], action: 'start' }));
        at(kIns, 14, 30, `snag ready ${key}`, (t) => rpc(U.site, t, 'snag_action', { snag_id: ST.snag[`${key}:${code}`], action: 'ready', comment: 'Spacer blocks added, cover 40 mm' }));
        at(kIns, 16, 0, `reinspect ${code} ${key}`, async (t) => {
          await rpc(U.office, t, 'submit_inspection', { id: uuid(), project_id: P.id, number: no(P, 'INS', DEV.office),
            template_id: TPL[code].id, element_id: el.id, element_activity_id: act(key, holdSeq(key)).id, reinspection_of: id,
            consultant_name: 'Eng. Mekdes (consultant)', inspected_at: iso(t), remarks: 'Re-inspection after correction — passed', items: itemsFor(code) });
          await fixHoldPoints(kIns);
        });
        at(kIns, 16, 30, `snag close ${key}`, (t) => rpc(U.office, t, 'snag_action', { snag_id: ST.snag[`${key}:${code}`], action: 'close', comment: 'Verified at re-inspection' }));
      }
      if (cond) {
        at(kIns, 15, 0, `snag ready ${key}`, (t) => rpc(U.site, t, 'snag_action', { snag_id: ST.snag[`${key}:${code}`], action: 'ready', comment: 'Joints sealed with foam tape' }));
        at(kIns + 1, 8, 0, `snag close ${key}`, (t) => rpc(U.office, t, 'snag_action', { snag_id: ST.snag[`${key}:${code}`], action: 'close', comment: 'Checked before pour' }));
      }
    });
    work(P, kIns, key, 'hold-point inspection');
  }

  // Mix designs
  const MIX = { rm: uuid(), site: uuid(), cmc: uuid() };
  at(2, 10, 0, 'mix designs', async (t) => {
    await rpc(U.office, t, 'save_mix_design', { id: MIX.rm, project_id: D.id, code: 'C25-RM', grade: 'C-25/30', source: 'ready_mix', material_spec_id: S.c25,
      cement_kg_per_m3: 360, water_cement_ratio: 0.5, target_slump_mm: 100, slump_tolerance_mm: 25, remarks: 'Addis Ready-Mix design AR-25-07' });
    await rpc(U.office, t + MIN, 'save_mix_design', { id: MIX.site, project_id: D.id, code: 'C25-SITE', grade: 'C-25/30', source: 'site', cement_spec_id: S.opc,
      cement_kg_per_m3: 350, water_cement_ratio: 0.5, sand_m3_per_m3: 0.45, aggregate_m3_per_m3: 0.68, target_slump_mm: 75, slump_tolerance_mm: 25,
      remarks: 'Site mix 1:2:3 by weight, 7 bags per m³' });
  });
  at(26, 10, 0, 'CMC mix design', (t) => rpc(U.office, t, 'save_mix_design', { id: MIX.cmc, project_id: C.id, code: 'C25-RM', grade: 'C-25/30',
    source: 'ready_mix', material_spec_id: S.c25, cement_kg_per_m3: 360, water_cement_ratio: 0.5, target_slump_mm: 100 }));

  // Pours. trucks: [volume, slump, extra]; batches: [volume, bags, sand, agg]; cubes: [[ages-results…]]
  function pour(key, o) {
    const P = o.P ?? D;
    const id = uuid();
    const rec = { id, trucks: [] };
    ST.pour[key] = rec;
    const els = o.els.map((code) => ({ id: uuid(), element_id: E(code).id, planned_m3: E(code).tk.c25 }));
    const planned = round(sum(els.map((e) => e.planned_m3)));
    at(o.k - 1, 15, 30, `${key} plan`, async (t) => {
      rec.number = no(P, 'POUR', DEV.site);
      await rpc(U.site, t, 'save_pour', { id, project_id: P.id, number: rec.number, pour_date: ds(o.k), mix_design_id: o.mix,
        method: o.method, supplier_id: o.method === 'ready_mix' ? SUP['Addis Ready-Mix'] : undefined, supplier_name: o.method === 'ready_mix' ? 'Addis Ready-Mix' : undefined,
        store_id: P.MAIN, mr_id: o.mr ? MR[o.mr].id : undefined, planned_m3: planned, weather: o.weather ?? 'Sunny, 22 °C',
        curing_method: o.curing ?? 'Wet hessian, 7 days', remarks: o.remarks, elements: els });
    });
    if (o.future) return rec;
    for (const code of o.els) work(P, o.k, code, 'casting');
    if (o.method === 'ready_mix') {
      o.trucks.forEach(([vol, slump, x = {}], i) => {
        const tid = uuid();
        rec.trucks.push(tid);
        const arrive = T(o.k, 7, 40 + i * 55);
        const ticket = `AR-${ds(o.k).replace(/-/g, '').slice(4)}-${String(i + 1).padStart(2, '0')}`;
        const by = o.byStore ? 'store' : 'site';
        at(o.k, 7, 40 + i * 55, `${key} truck ${i + 1}`, (t) => rpc(U[by], t, 'add_pour_truck', {
          id: tid, pour_id: id, ticket_no: ticket, supplier_name: 'Addis Ready-Mix', truck_plate: plate(), volume_m3: vol,
          batched_at: iso(arrive - (x.late ? 105 : 45) * MIN), arrived_at: iso(arrive), discharge_start: iso(arrive + 10 * MIN),
          discharge_end: iso(arrive + 35 * MIN), slump_mm: slump, concrete_temp_c: x.temp ?? between(21, 27), water_added_l: x.water,
          accepted: !x.reject, reject_reason: x.reject,
          ...(o.byStore && !x.reject ? { grn_number: no(P, 'GRN', DEV.store), miv_number: no(P, 'MIV', DEV.store) } : {}) }));
        if (!o.byStore && !x.reject) {
          at(o.k, 7, 40 + i * 55 + 20, `${key} receive ${i + 1}`, (t) => rpc(U.store, t, 'receive_pour_truck', { truck_id: tid,
            grn_number: no(P, 'GRN', DEV.store), miv_number: no(P, 'MIV', DEV.store) }));
        }
        if (!x.reject) VEH.push({ P, k: o.k, h: 7, m: 30 + i * 55, plate: '3-RM' + (4100 + i), driver: pick(DRIVERS), purpose: `Ready-mix ${ticket}`, doc: 'other' });
      });
    } else {
      for (const [store, lines] of o.issue) {
        at(o.k, 7, store === 'yard' ? 20 : 10, `${key} issue ${store}`, (t) => rpc(U.store, t, 'issue_pour_materials', { pour_id: id, miv_id: uuid(),
          number: no(P, 'MIV', DEV.store), store_id: store === 'yard' ? P.YARD : P.MAIN, issued_at: iso(t),
          lines: lines.map(([sp, qty]) => ({ material_spec_id: S[sp], qty })) }));
      }
      o.batches.forEach(([vol, bags, sand, agg], i) => at(o.k, 8, i * 22, `${key} batch ${i + 1}`, (t) => rpc(U.site, t, 'add_pour_batch', { id: uuid(),
        pour_id: id, volume_m3: vol, cement_bags: bags, sand_m3: sand, aggregate_m3: agg, water_l: round(bags * 50 * 0.5, 0),
        slump_mm: Math.round(between(65, 90, 0)), mixer: '750 L drum mixer #1', batched_at: iso(t) })));
    }
    const endH = o.method === 'ready_mix' ? 8 + Math.ceil(o.trucks.length * 0.95) : 8 + Math.ceil(o.batches.length * 0.37);
    at(o.k, endH, 50, `${key} close`, (t) => rpc(U.site, t, 'close_pour', { pour_id: id, end_at: iso(t), remarks: o.closeRemarks }));
    // the office engineer verifies the casting reported by close_pour
    if (o.k + 1 <= 60) {
      at(o.k + 1, 10, 0, `${key} verify casting`, async (t) => {
        for (const code of o.els) {
          const pu = await one(`select id from progress_updates where element_id = $1 and element_activity_id = $2 and status = 'reported'`,
            [E(code).id, act(code, castSeq(code)).id]);
          if (pu) await rpc(U.office, t, 'verify_progress', { progress_id: pu.id, approve: true });
        }
      });
    }
    // cube sets: [[sample truck index | null, {7: [..], 28: [..]}, {skip28, label}]]
    (o.cubes ?? []).forEach(([truckIdx, res, x = {}], ci) => {
      const cid = uuid();
      at(o.k, 12, ci * 20, `${key} cube set ${ci + 1}`, (t) => rpc(U.site, t, 'save_cube_set', { id: cid, pour_id: id,
        number: no(P, 'CUBE', DEV.site), truck_id: truckIdx != null ? rec.trucks[truckIdx] : undefined,
        element_id: x.el ? E(x.el).id : undefined, sampled_at: iso(t), cubes_count: 3, test_ages: [7, 28], lab_name: 'Addis Testing Laboratory' }));
      for (const age of [7, 28]) {
        if (!res[age] || (age === 28 && x.skip28)) continue;
        const target = WD.get(o.k) + age * DAY;
        const kt = kOfCal(target);
        if (kt >= 60) continue;   // due today or later → shows in "cubes due"
        const r = res[age], fails = age >= 28 && (sum(r) / r.length < 30 || Math.min(...r) < 26);
        at(kt, 11, ci * 5, `${key} cubes ${age}d`, (t) => rpc(U.office, t, 'record_cube_results', { cube_set_id: cid,
          snag: fails ? { id: uuid(), number: no(P, 'SNG', DEV.office), assignee_user_id: U.site } : undefined,
          results: res[age].map((mpa, j) => ({ id: uuid(), cube_label: `${String.fromCharCode(65 + j)}${age}`, age_days: age, tested_on: dsCal(Math.min(target, WD.get(kt))),
            strength_mpa: mpa, load_kn: round(mpa * 22.5, 1), density_kg_m3: round(between(2360, 2440, 0), 0), failure_mode: 'Satisfactory (hour-glass)' })) }));
      }
    });
    return rec;
  }

  // --- DEMO footings F1–F4 (P1), F5–F8 (P2) ---
  F14.forEach((c, i) => preCast(c, 4 + i, 15));
  F14.forEach((c) => inspections(c, 13, 14));
  F14.forEach((c) => postCast(c, [[7, 19], [8, 21]]));
  pour('P1', { k: 15, els: F14, mix: MIX.rm, method: 'ready_mix', byStore: true,
    trucks: [[7.0, 95], [7.0, 110], [7.0, 100, { water: 20 }], [5.4, 90]],
    cubes: [[0, { 7: [23.1, 24.0, 22.6], 28: [34.2, 35.1, 33.8] }], [2, { 7: [22.4, 21.9, 23.0], 28: [33.0, 32.6, 34.1] }]] });
  F58.forEach((c, i) => preCast(c, 9 + i, 21));
  F58.forEach((c) => inspections(c, 19, 20, c === 'F6' ? { conditional: 'FORMWORK' } : {}));
  F58.forEach((c) => postCast(c, [[7, 25], [8, 27]]));
  pour('P2', { k: 21, els: F58, mix: MIX.rm, method: 'ready_mix',
    trucks: [[7.0, 180, { reject: 'Slump 180 mm (max 125 mm) — returned to plant' }], [7.0, 105], [7.0, 95, { late: true }], [6.5, 100], [6.0, 110]],
    cubes: [[1, { 7: [17.9, 18.4, 18.8], 28: [27.2, 26.4, 26.9] }, { el: 'F6' }], [3, { 7: [21.5, 22.8, 22.1], 28: [33.4, 32.1, 34.0] }]] });

  // --- Annex FB1–FB2 site-batched (P3) ---
  FB12.forEach((c) => preCast(c, 22, 28));
  FB12.forEach((c) => inspections(c, 26, 27));
  FB12.forEach((c) => postCast(c, [[7, 32], [8, 34]]));
  pour('P3', { k: 28, els: FB12, mix: MIX.site, method: 'site_batched', mr: 'M9',
    issue: [['main', [['opc', 37]]], ['yard', [['sand', 5.3], ['agg', 7.4]]]],
    batches: Array.from({ length: 10 }, () => [1.05, 7.5, 0.53, 0.74]),
    cubes: [[null, { 7: [21.0, 22.3, 20.8], 28: [31.5, 32.2, 30.9] }, { skip28: true }]] });

  // --- Ground beams GB1–GB3 (P4); GB4 in progress ---
  GB.slice(0, 3).forEach((c) => preCast(c, 27, 34));
  GB.slice(0, 3).forEach((c) => inspections(c, 32, 33));
  GB.slice(0, 3).forEach((c) => postCast(c, [[5, 38], [6, 41]]));
  pour('P4', { k: 34, els: GB.slice(0, 3), mix: MIX.rm, method: 'ready_mix', byStore: true, trucks: [[6.0, 100], [3.1, 95]],
    cubes: [[0, { 7: [22.0, 23.4, 22.9], 28: [33.9, 34.6, 33.1] }]] });
  prog('GB4', 1, 50, 38, 39); prog('GB4', 1, 100, 40, 41);
  prog('GB4', 2, 40, 46, 47, { remarks: 'Stopped — waiting for Ø8 links' }); prog('GB4', 2, 60, 59, null);

  // --- Columns C1–C4 site-batched (P5); C3 fails rebar inspection first ---
  C14.forEach((c) => preCast(c, 36, 41));
  C14.forEach((c) => inspections(c, 39, 40, c === 'C3' ? { fail: 'REBAR' } : {}));
  C14.forEach((c) => postCast(c, [[6, 44], [7, 46]]));
  pour('P5', { k: 41, els: C14, mix: MIX.site, method: 'site_batched', mr: 'M14',
    issue: [['main', [['opc', 25]]], ['yard', [['sand', 3.2], ['agg', 4.5]]]],
    batches: Array.from({ length: 8 }, () => [0.8, 6, 0.4, 0.56]),
    closeRemarks: 'Cement used above design — mixer operator replaced',
    cubes: [[null, { 7: [22.6, 21.8, 23.5], 28: [33.0, 34.0, 32.8] }]] });

  // --- Columns C5–C6 ready-mix over-pour (P6); C7–C8 in progress; P7 planned ---
  ['C5', 'C6'].forEach((c) => preCast(c, 43, 52));
  ['C5', 'C6'].forEach((c) => inspections(c, 50, 51));
  ['C5', 'C6'].forEach((c) => postCast(c, [[6, 55], [7, 57]]));
  pour('P6', { k: 52, els: ['C5', 'C6'], mix: MIX.rm, method: 'ready_mix', byStore: true, trucks: [[4.0, 115, { temp: 29.5 }]],
    remarks: 'Switched to ready-mix during the cement shortage (minimum load 4 m³)', closeRemarks: 'Surplus 0.8 m³ used for kerbs at the gate',
    cubes: [[0, { 7: [18.6, 19.1, 18.2], 28: [31.0, 30.6, 32.2] }]] });
  for (const c of ['C7', 'C8']) prog(c, 1, 100, 51, 52);
  prog('C7', 2, 50, 53, 54); prog('C7', 2, 100, 55, 56); prog('C7', 3, 100, 59, 60, { hv: 8 });
  inspections('C7', 60, 61, { pending: true });
  prog('C8', 2, 80, 57, 58, { reject: true, comment: 'Links not as per BBS — re-fix at 150 mm spacing' }); prog('C8', 2, 100, 59, null);
  pour('P7', { k: 62, els: ['C7', 'C8'], mix: MIX.rm, method: 'ready_mix', future: true, remarks: 'Book pump for 07:30' });

  // --- Annex FB3 in progress (FB4 not started → delayed) ---
  prog('FB3', 1, 100, 46, 47); prog('FB3', 2, 100, 48, 49);
  prog('FB3', 3, 30, 53, 54); prog('FB3', 3, 60, 58, 59, { pct: 50, comment: 'Starter bars not yet fixed — 50 %' });
  // --- Beams B1–B2, slab S1 ---
  for (const c of ['B1', 'B2']) { prog(c, 1, 50, 55, 56); prog(c, 1, 100, 57, 58); prog(c, 2, 50, 59, null); }
  prog('S1', 1, 30, 56, 57); prog('S1', 1, 60, 58, 59, { pct: 50, comment: 'Bay 3 shoring incomplete — 50 %' }); prog('S1', 2, 20, 60, null, { hr: 15 });

  // --- CMC footings (CP1, CP2) and columns ---
  cF13.forEach((c) => preCast(c, 28, 36));
  cF13.forEach((c) => inspections(c, 34, 35));
  cF13.forEach((c) => postCast(c, [[7, 40], [8, 42]]));
  pour('CP1', { P: C, k: 36, els: cF13, mix: MIX.cmc, method: 'ready_mix', byStore: true, trucks: [[7.0, 100], [5.8, 105]],
    cubes: [[0, { 7: [22.8, 23.2, 22.1], 28: [33.5, 34.2, 33.0] }]] });
  cF46.forEach((c) => preCast(c, 38, 47));
  cF46.forEach((c) => inspections(c, 45, 46, c === 'cF5' ? { conditional: 'FORMWORK' } : {}));
  cF46.forEach((c) => postCast(c, [[7, 51], [8, 53]]));
  pour('CP2', { P: C, k: 47, els: cF46, mix: MIX.cmc, method: 'ready_mix', byStore: true, trucks: [[7.0, 95], [5.7, 100]],
    cubes: [[0, { 7: [21.9, 22.5, 23.0], 28: [32.1, 33.3, 32.7] }]] });
  for (const c of cC13) { prog(c, 1, 100, 53, 54); prog(c, 2, 50, 57, 58); }
  prog('cC1', 2, 100, 59, null);

  // ===========================================================================
  // E. Store control: adjustments, counts, returns, transfers
  // ===========================================================================
  function adjustment(k, o) {
    const id = uuid(), P = o.P ?? D;
    at(k, o.h ?? 15, 0, `adjustment ${o.reason}`, (t) => rpc(U.store, t, 'create_adjustment', { id, project_id: P.id, number: no(P, 'ADJ', DEV.store),
      store_id: storeOf(P, o.sp), adj_type: o.type, reason_code: o.reason, remarks: o.remarks,
      lines: [{ id: uuid(), material_spec_id: S[o.sp], element_id: o.el ? E(o.el).id : undefined, stock_status: o.status, qty: o.qty }] }));
    if (o.decide) {
      const [kd, approve, comment] = o.decide;
      at(kd, 10, 30, 'decide adjustment', (t) => rpc(U.manager, t, 'decide_adjustment', { adjustment_id: id, approve, comment }));
    }
  }
  adjustment(18, { sp: 'r12', qty: 25, type: 'wastage', reason: 'Off-cuts', el: 'F2', remarks: 'Ø12 off-cuts from footing mats F1–F4', decide: [19, true, 'Within 3 % allowance'] });
  adjustment(35, { sp: 'opc', qty: 3, type: 'damage', reason: 'Hardened (moisture)', remarks: '6 bags hardened — roof leak in cement store', decide: [36, true, 'Fix the store roof'] });
  adjustment(49, { sp: 'timber', qty: 30, type: 'wastage', reason: 'Broken forms', remarks: 'Timber broken while stripping GB forms', decide: [50, false, 'Timber is reusable — return to yard and sort'] });
  adjustment(55, { sp: 'r8', qty: 15, type: 'write_off', reason: 'Rejected at receipt (rust)', status: 'quarantine', remarks: 'GRN against PO-0004 — supplier credit received', decide: [56, true, 'Credit note CN-118 received'] });
  adjustment(56, { sp: 'hcb', qty: 120, type: 'damage', reason: 'Broken in unloading', status: 'quarantine', remarks: 'Rejected HCB from PO-0010 delivery', decide: [58, true, 'Supplier replacing 60 pcs; rest written off'] });
  adjustment(58, { sp: 'sand', qty: 1.5, type: 'wastage', reason: 'Washed away by rain', remarks: 'Stockpile not covered during the storm' });
  adjustment(60, { sp: 'wire', qty: 4, type: 'loss', reason: 'Missing at count', h: 9, remarks: 'One coil missing from the store shelf' });
  adjustment(50, { P: C, sp: 'r12', qty: 12, type: 'wastage', reason: 'Off-cuts', remarks: 'Footing mats F1–F3', decide: [51, true, null] });

  // Stock counts: one approved with variance, one pending. Counted = system balance + delta at the time.
  function stockCount(k, P, store, deltas, decide) {
    const id = uuid();
    at(k, 17, 0, 'stock count', async (t) => {
      const lines = [];
      for (const [sp, delta] of deltas) {
        const bal = Number((await one(`select coalesce(sum(qty), 0) as q from stock_ledger where store_id = $1 and material_spec_id = $2 and stock_status = 'available'`,
          [store, S[sp]])).q);
        lines.push({ id: uuid(), material_spec_id: S[sp], counted_qty: Math.max(0, round(bal + delta)) });
      }
      await rpc(U.store, t, 'submit_stock_count', { id, project_id: P.id, number: no(P, 'CNT', DEV.store), store_id: store, count_type: 'periodic',
        counted_at: iso(t), remarks: 'Month-end count with the site accountant', lines });
    });
    if (decide) at(decide, 9, 30, 'decide stock count', (t) => rpc(U.manager, t, 'decide_stock_count', { count_id: id, approve: true, comment: 'Variance investigated — accepted' }));
  }
  stockCount(30, D, D.MAIN, [['r16', 0], ['r12', 0], ['r8', -2], ['wire', -3], ['opc', 0]], 31);
  stockCount(59, D, D.YARD, [['sand', -0.6], ['agg', 0.4], ['hcb', -12], ['timber', -5]]);

  // Returns (MRN)
  function mrn(k, o) {
    at(k, o.h ?? 16, 0, 'MRN', (t) => rpc(U.store, t, 'post_mrn', { id: uuid(), project_id: D.id, number: no(D, 'MRN', DEV.store), store_id: o.store ?? D.MAIN,
      returned_by: U.site, returned_at: iso(t), remarks: o.remarks,
      lines: o.lines.map(([sp, el, qty, condition = 'good']) => ({ id: uuid(), material_spec_id: S[sp], element_id: E(el).id, qty, condition })) }));
  }
  mrn(23, { lines: [['r16', 'F8', 20], ['wire', 'F8', 2]], remarks: 'Unused Ø16 after F8 mat — good condition' });
  mrn(44, { lines: [['r8', 'C4', 6]], remarks: 'Unused links C4' });
  mrn(57, { store: D.YARD, lines: [['timber', 'GB2', 40, 'damaged']], remarks: 'Damaged forms from GB stripping — to quarantine' });

  // Transfers between the projects: DEMO → CMC (received), CMC → DEMO (in transit)
  const TR1 = uuid(), TR2 = uuid();
  at(39, 14, 0, 'transfer DEMO→CMC', (t) => rpc(U.store, t, 'send_transfer', { id: TR1, project_id: D.id, number: no(D, 'TRF', DEV.store),
    from_store_id: D.MAIN, to_store_id: C.MAIN, sent_at: iso(t), remarks: 'Loan to CMC for footing mats; to be returned in kind',
    lines: [{ id: uuid(), material_spec_id: S.r12, qty: 300 }, { id: uuid(), material_spec_id: S.opc, qty: 20 }] }));
  at(40, 9, 0, 'receive transfer', (t) => rpc(U.store, t, 'receive_transfer', { transfer_id: TR1, received_at: iso(t) }));
  at(59, 15, 0, 'transfer CMC→DEMO', (t) => rpc(U.store, t, 'send_transfer', { id: TR2, project_id: C.id, number: no(C, 'TRF', DEV.store),
    from_store_id: C.MAIN, to_store_id: D.MAIN, sent_at: iso(t), remarks: 'Return in kind — Ø16 surplus from CMC',
    lines: [{ id: uuid(), material_spec_id: S.r16, qty: 200 }] }));
  VEH.push({ P: D, k: 39, h: 14, m: 20, plate: '3-B70422', driver: 'Mulugeta T.', purpose: 'Transfer to CMC Apartments', doc: 'transfer', docId: TR1, out: true });

  // ===========================================================================
  // F. Snags (walk-arounds), BBS
  // ===========================================================================
  function snag(key, k, o) {
    const id = uuid(), P = o.P ?? D;
    ST.snag[key] = id;
    at(k, o.h ?? 11, 0, `snag ${key}`, (t) => rpc(U[o.by ?? 'site'], t, 'save_snag', { id, project_id: P.id, number: no(P, 'SNG', DEV[o.by ?? 'site']),
      element_id: o.el ? E(o.el).id : undefined, location_text: o.loc, category: o.cat ?? 'quality', trade: o.trade, severity: o.sev ?? 'medium',
      title: o.title, description: o.desc, assignee_user_id: o.assignee === false ? undefined : U.site, assignee_party: o.party,
      due_date: ds(o.due ?? k + 4), source_type: 'walk' }));
    for (const [ka, ha, action, comment] of o.flow ?? []) {
      const who = ['start', 'ready'].includes(action) ? 'site' : 'office';
      at(ka, ha, 0, `snag ${key} ${action}`, (t) => rpc(U[who], t, 'snag_action', { snag_id: id, action, comment }));
    }
  }
  snag('honeycomb', 16, { el: 'F2', sev: 'high', trade: 'Concrete', title: 'Honeycombing at footing F2 edge', desc: 'Approx. 0.3 m² at the north face',
    flow: [[17, 9, 'start'], [18, 15, 'ready', 'Hacked and repaired with non-shrink grout'], [19, 10, 'close', 'Repair accepted']] });
  snag('curing', 37, { el: 'GB2', trade: 'Concrete', title: 'Curing not maintained on GB2', desc: 'Hessian dry at 14:00', due: 38,
    flow: [[37, 14, 'start'], [38, 9, 'ready', 'Water tank and hose assigned'], [38, 15, 'close', 'OK']] });
  snag('cover', 38, { el: 'GB1', trade: 'Concrete', title: 'Exposed rebar at GB1 soffit', desc: 'Insufficient cover after stripping, 2 locations', due: 44,
    flow: [[39, 9, 'start'], [52, 15, 'ready', 'Repair mortar applied'], [54, 10, 'reopen', 'Repair mortar not cured — cracks visible']] });
  snag('plumb', 47, { el: 'C2', trade: 'Carpentry', title: 'Column C2 out of plumb 12 mm', desc: 'Measured over 3 m with plumb bob', due: 52,
    flow: [[48, 9, 'start'], [51, 16, 'ready', 'Corrected with plaster build-up per consultant']] });
  snag('backfill', 52, { el: 'FB1', sev: 'low', trade: 'Earthworks', title: 'Backfill compaction not adequate around FB1', desc: 'Settlement after rain', due: 56 });
  snag('housekeeping', 54, { sev: 'low', loc: 'Near the main store', cat: 'housekeeping', title: 'Rebar off-cuts scattered near stores', due: 55,
    flow: [[55, 9, 'cancel', 'Duplicate of the weekly housekeeping item']] });
  snag('spill', 55, { el: 'C5', sev: 'low', trade: 'Concrete', title: 'Over-pour spill on C5 kicker', desc: 'Surplus ready-mix left on the kicker', party: 'Addis Ready-Mix', due: 58, assignee: false });
  snag('props', 57, { el: 'B1', sev: 'high', trade: 'Carpentry', title: 'Beam B1 props on soft ground', desc: 'Sole plates missing under 4 props', due: 59,
    flow: [[58, 9, 'start']] });
  snag('shoring', 60, { h: 8, el: 'S1', sev: 'critical', by: 'office', trade: 'Carpentry', title: 'S1 shoring spacing exceeds 1.2 m in bay 3',
    desc: 'Measured 1.5 m between props — stop rebar fixing in bay 3 until corrected', due: 60, loc: 'Bay 3 (grid B-C/2-3)' });
  snag('scaffold', 59, { sev: 'medium', by: 'office', loc: 'North elevation', cat: 'safety', trade: 'Scaffolding', title: 'Scaffold toe boards missing on north elevation', due: 61 });
  snag('cmc1', 37, { P: C, el: 'cF2', sev: 'high', trade: 'Concrete', title: 'Honeycombing at base of F2', flow: [[38, 9, 'start'], [39, 15, 'ready', 'Repaired'], [40, 10, 'close', 'OK']] });
  snag('cmc2', 58, { P: C, el: 'cC2', trade: 'Bar bending', title: 'C2 link spacing not as per drawing', due: 61 });
  snag('cmc3', 58, { P: C, sev: 'low', loc: 'Site access road', cat: 'housekeeping', title: 'Debris on site access road', flow: [[59, 9, 'start']] });

  // Cube failure snag (auto-created by record_cube_results) moves to in progress.
  at(46, 9, 0, 'cube snag start', async (t) => {
    const s = await one(`select id from snags where source_type = 'cube' and status = 'open' order by created_at limit 1`);
    if (s) await rpc(U.site, t, 'snag_action', { snag_id: s.id, action: 'start', comment: 'Cores ordered from Addis Testing Laboratory' });
  });

  function bbs(key, k, el, lines, o = {}) {
    const id = uuid(), P = E(el).P;
    at(k, 10, 15, `BBS ${key}`, (t) => rpc(U.office, t, 'save_bbs', { id, project_id: P.id, number: no(P, 'BBS', DEV.office), element_id: E(el).id,
      revision: o.rev, drawing_ref: drawing[E(el).type], remarks: o.remarks,
      lines: lines.map(([mark, sp, members, bars, len, shape]) => ({ id: uuid(), bar_mark: mark, material_spec_id: S[sp], no_of_members: members,
        bars_per_member: bars, cut_length_m: len, shape_code: shape })) }));
    if (o.approve) at(o.approve, 9, 15, `approve BBS ${key}`, (t) => rpc(U.office, t, 'approve_bbs', { bbs_id: id }));
  }
  const footingBbs = [['B1', 'r16', 1, 17, 3.2, '21'], ['B2', 'r16', 1, 17, 3.2, '21'], ['B3', 'r16', 1, 16, 3.2, '21'], ['B4', 'r16', 1, 16, 3.2, '21'],
    ['S1', 'r16', 1, 12, 3.0, '11'], ['D1', 'r12', 2, 29, 3.0, '00']];
  bbs('F1', 6, 'F1', footingBbs, { approve: 7 });
  bbs('F3', 6, 'F3', footingBbs, { approve: 7 });
  bbs('GB1', 26, 'GB1', [['T1', 'r16', 1, 4, 9.8, '21'], ['B1', 'r16', 1, 4, 9.8, '21'], ['L1', 'r8', 1, 62, 1.55, '51']], { approve: 27 });
  const colBbs = (len) => [['V1', 'r16', 2, 12, len, '00'], ['L1', 'r8', 1, 95, 1.2, '51']];
  bbs('C1', 33, 'C1', colBbs(4.9), { approve: 34 });
  bbs('C2r0', 33, 'C2', colBbs(4.9), { approve: 34 });
  bbs('C2r1', 35, 'C2', colBbs(5.4), { approve: 36, remarks: 'Rev 1 — lap length per CI-03' });
  bbs('S1', 53, 'S1', [['B1', 'r12', 1, 64, 12.0, '00'], ['B2', 'r12', 1, 64, 12.0, '00'], ['T1', 'r12', 1, 52, 12.0, '00'], ['T2', 'r12', 1, 52, 12.0, '00'],
    ['E1', 'r12', 1, 110, 1.6, '21']], { approve: 54 });
  bbs('B1', 55, 'B1', [['T1', 'r16', 1, 4, 6.2, '21'], ['B1', 'r16', 1, 4, 6.2, '21'], ['L1', 'r8', 1, 48, 1.7, '51']], { remarks: 'Draft — awaiting consultant comments' });

  // ===========================================================================
  // G. Gate passes, vehicle log, QR labels
  // ===========================================================================
  function gatePass(key, k, o) {
    const id = uuid(), lines = o.lines.map(([sp, desc, qty, uom]) => ({ id: uuid(), material_spec_id: sp ? S[sp] : undefined, description: desc, qty, uom }));
    const pl = o.plate ?? plate();
    ST.gp[key] = { id, lines };
    at(k, o.h ?? 9, 0, `GP ${key}`, (t) => rpc(U[o.by ?? 'store'], t, 'save_gate_pass', { id, project_id: D.id, number: no(D, 'GP', DEV[o.by ?? 'store']),
      pass_type: o.type, store_id: lines.some((l) => l.material_spec_id) ? D.YARD : undefined, destination: o.dest, purpose: o.purpose,
      vehicle_plate: pl, driver_name: pick(DRIVERS), driver_phone: `+2519${Math.floor(10000000 + rnd() * 89999999)}`,
      expected_return: o.ret != null ? ds(o.ret) : undefined, lines, submit: true }));
    for (const [ka, ha, action, arg = {}] of o.flow ?? []) {
      at(ka, ha, arg.m ?? 0, `GP ${key} ${action}`, (t) => {
        if (action === 'exit') return rpc(U.security, t, 'verify_gate_pass', { id: uuid(), gate_pass_id: id, matches: !arg.mismatch,
          plate_seen: arg.mismatch ? arg.plateSeen : pl, note: arg.note, at: iso(t) });
        if (action === 'return') return rpc(U.security, t, 'return_gate_pass', { id: uuid(), gate_pass_id: id, plate_seen: pl, at: iso(t), note: arg.note,
          lines: lines.map((l, i) => ({ gate_pass_line_id: l.id, qty_returned: arg.qty?.[i] ?? l.qty })) });
        return rpc(U[arg.by ?? 'coordinator'], t, 'gate_pass_action', { gate_pass_id: id, action, comment: arg.comment });
      });
      if (action === 'exit' && !arg.mismatch) VEH.push({ P: D, k: ka, h: ha, m: (arg.m ?? 0) + 2, plate: pl, driver: pick(DRIVERS), purpose: `Gate pass ${key}`, doc: 'gate_pass', docId: id, out: true, loaded: true });
    }
  }
  gatePass('vibrator', 17, { type: 'returnable', dest: 'Mekanisa workshop (repair)', purpose: 'Poker vibrators for motor rewinding', ret: 21,
    lines: [[null, 'Poker vibrator 50 mm', 2, 'pcs']], flow: [[17, 11, 'approve'], [18, 8, 'exit'], [21, 15, 'return']] });
  gatePass('scrapform', 27, { type: 'non_returnable', dest: 'Kolfe timber recycler', purpose: 'Sale of broken formwork timber', h: 10,
    lines: [['timber', null, 30, 'pcs']], flow: [[27, 14, 'approve', { by: 'manager' }], [28, 8, 'exit']] });
  gatePass('timberloan', 38, { type: 'returnable', dest: 'Selam Formwork workshop, Kality', purpose: 'Beam form panels prefabrication', ret: 48,
    lines: [['timber', null, 150, 'pcs']], flow: [[38, 14, 'approve'], [39, 8, 'exit'], [50, 16, 'return', { qty: [100], note: '50 pcs still at the workshop' }]] });
  gatePass('plywood', 42, { type: 'returnable', dest: 'Bole Bulbula private site', purpose: 'Plywood loan requested by subcontractor', ret: 46, by: 'site',
    lines: [[null, 'Plywood sheets 18 mm', 20, 'sheets']], flow: [[42, 15, 'reject', { by: 'manager', comment: 'Plywood belongs to client stock — not to leave site' }]] });
  gatePass('totalstation', 46, { type: 'returnable', dest: 'CMC Apartments site', purpose: 'Setting out of CMC footings', ret: 54, by: 'office',
    lines: [[null, 'Total station Leica TS06 + tripod', 1, 'set']], flow: [[46, 11, 'approve'], [47, 8, 'exit']] });
  gatePass('cancelled', 49, { type: 'non_returnable', dest: 'Head office', purpose: 'Office furniture', lines: [[null, 'Office chairs', 4, 'pcs']],
    flow: [[49, 15, 'cancel', { by: 'store' }]] });
  gatePass('scrap', 53, { type: 'non_returnable', dest: 'Kality scrap dealer', purpose: 'Sale of rebar off-cuts (scrap)', plate: '3-B54321',
    lines: [[null, 'Rebar off-cuts (scrap)', 350, 'kg']], flow: [[53, 14, 'approve', { by: 'manager' }],
      [54, 7, 'exit', { m: 40, mismatch: true, plateSeen: '3-A12345', note: 'Different truck arrived; load looked larger than 350 kg' }], [54, 8, 'exit', { m: 10 }]] });
  gatePass('mixer', 59, { type: 'returnable', dest: 'CMC Apartments site', purpose: 'Concrete mixer for CMC blinding', ret: 70,
    lines: [[null, 'Concrete mixer 750 L', 1, 'pcs']], flow: [[60, 9, 'approve']] });
  gatePass('bags', 60, { type: 'non_returnable', dest: 'Paper recycler, Merkato', purpose: 'Sale of empty cement bags', h: 8,
    lines: [[null, 'Empty cement bags', 400, 'pcs']] });
  gatePass('couplers', 60, { type: 'returnable', dest: 'Scaffold rental, Gerji', purpose: 'Return of rented couplers for exchange', ret: 66, h: 10,
    lines: [[null, 'Scaffolding couplers', 200, 'pcs']] });

  // Vehicle log by the gate guard from W36 (deliveries, pour trucks, gate passes, visitors).
  for (let k = 36; k <= 60; k++) {
    if (rnd() < 0.7) VEH.push({ P: D, k, h: 7, m: 15, plate: '3-A' + (31000 + k), driver: 'Site water truck', purpose: 'Water delivery', doc: null, inOut: true });
    if (k % 6 === 0) VEH.push({ P: D, k, h: 10, m: 30, plate: '3-A' + (52000 + k), driver: 'Client representative', purpose: 'Client site visit', doc: null, inOut: true });
  }
  VEH.push({ P: D, k: 57, h: 17, m: 20, plate: '3-C88112', driver: 'Unknown', purpose: 'Isuzu FSR loaded with excavated soil — no document shown', doc: null, out: true, loaded: true });
  for (const v of VEH.filter((x) => x.k >= 36 && x.P === D)) {
    const inAt = [v.k, v.h, Math.max(0, v.m - 10)], outAt = [v.k, v.h, v.m + 35];
    // the document is linked on the way out (a GRN does not exist yet when the truck enters)
    const log = (when, direction, loaded) => at(when[0], when[1], when[2], `vehicle ${direction}`, (t) => rpc(U.security, t, 'log_vehicle', { id: uuid(), project_id: D.id,
      number: no(D, 'VEH', DEV.security), direction, plate: v.plate, driver_name: v.driver, purpose: v.purpose, loaded,
      linked_doc_type: direction === 'out' ? v.doc ?? undefined : v.inDoc, linked_doc_id: direction === 'out' ? v.docId : v.inDocId, at: iso(t) }));
    if (!v.out) log(inAt, 'in', v.doc === 'grn');
    log(outAt, 'out', !!v.loaded);
  }

  at(30, 15, 0, 'QR labels', async (t) => {
    const labels = [
      { entity_type: 'store', entity_id: D.MAIN, label: 'Main store' }, { entity_type: 'store', entity_id: D.YARD, label: 'Open yard' },
      ...['r16', 'r12', 'r8', 'opc', 'wire', 'sand', 'agg', 'hcb', 'timber'].map((sp) => ({ entity_type: 'spec', entity_id: S[sp], label: `Bin — ${sp.toUpperCase()}` })),
      ...[...C14, ...C58, 'GB1', 'GB2', 'GB3', 'GB4'].map((c) => ({ entity_type: 'element', entity_id: E(c).id, label: `Element ${c}` })),
      { entity_type: 'tool', entity_id: uuid(), label: 'Poker vibrator #1' }, { entity_type: 'tool', entity_id: uuid(), label: 'Total station TS06' },
    ].map((l) => ({ id: uuid(), ...l }));
    await rpc(U.store, t, 'register_qr_labels', { project_id: D.id, labels });
    await rpc(U.store, t + 20 * MIN, 'mark_qr_printed', { ids: labels.slice(0, -4).map((l) => l.id) });
  });

  // ===========================================================================
  // H. Site diaries (every working day; signed next morning)
  // ===========================================================================
  const delayPlan = (P, k) => {
    const out = [];
    if (P === D) {
      if (k >= 42 && k <= 47) out.push({ cause: 'cement_shortage', hours_lost: k === 44 || k === 45 ? 6 : 3, el: k < 45 ? 'FB3' : 'C5',
        description: 'No cement on the market — site batching stopped; waiting for PO-0007 allocation' });
      if (k >= 44 && k <= 47) out.push({ cause: 'material_shortage', hours_lost: 4, el: 'GB4', description: 'Ø8 links not delivered (PO-0006 delayed) — GB4 rebar stopped' });
      if (k === 30 || k === 48) out.push({ cause: 'power_cut', hours_lost: 3, description: 'EEU power interruption 09:00–12:00; bar bending by hand' });
      if (k === 38) out.push({ cause: 'equipment', hours_lost: 2, description: 'Drum mixer gearbox failure — repaired by 11:00' });
      if (k === 53) out.push({ cause: 'design_info', hours_lost: 2, el: 'ST1', description: 'Staircase drawing Rev C awaited (RFI-12)' });
      if (k === 21) out.push({ cause: 'other', hours_lost: 1, el: 'F5', description: 'Truck 1 rejected for slump — 60 min wait for replacement' });
    }
    return out;
  };
  const diaryDays = [];
  for (let k = 1; k <= 60; k++) diaryDays.push([D, k]);
  for (let k = 27; k <= 60; k++) diaryDays.push([C, k]);
  for (const [P, k] of diaryDays) {
    if ((P === D && (k === 17 || k === 33)) || (P === C && k === 41)) continue;   // a few missed days
    const wet = k < 25 ? 0.55 : k < 45 ? 0.3 : 0.12;
    const rainPm = rnd() < wet, rainAm = rainPm && rnd() < 0.25;
    const rainH = rainPm ? between(0.5, rainAm ? 4 : 2.5) : 0;
    const wk = WORK.get(`${P.code}|${k}`) ?? new Map();
    const pouring = [...wk.values()].some((n) => n.includes('casting'));
    const scale = P === D ? 1 : 0.6;
    const n = (base, spread) => Math.max(0, Math.round((base + rnd() * spread) * scale));
    const labour = [
      ['Foreman', 1, 0], ['Daily labourer', n(14, 10) + (pouring ? 8 : 0), 0], ['Bar bender', n(k < 5 ? 1 : 5, 4), 0], ['Carpenter', n(k < 5 ? 2 : 6, 5), 0],
      ['Mason', n(2, 3), 0], ['Guard', 2, 0], ...(k < 14 || (k > 43 && k < 48) ? [['Equipment operator', 1, 0]] : []),
      ...(k > 50 ? [['Electrician', n(1, 2), 0]] : []),
    ].filter(([, h]) => h > 0).map(([trade, headcount]) => ({ id: uuid(), trade_id: TRADE[trade], headcount, hours: 8,
      subcontractor: trade === 'Bar bender' && P === D ? 'Tigist Rebar Works' : undefined }));
    const delays = delayPlan(P, k).map((d) => ({ id: uuid(), cause: d.cause, hours_lost: d.hours_lost, element_id: d.el ? E(d.el).id : undefined, description: d.description }));
    if (rainH >= 1.5) delays.push({ id: uuid(), cause: 'rain', hours_lost: round(rainH, 1), description: 'Heavy afternoon rain — work stopped' });
    const equipment = [
      { id: uuid(), equipment: 'Bar bending machine', qty: 1, hours_worked: 7, status: 'working' },
      ...(k < 14 || (k >= 22 && k <= 24) || (k >= 45 && k <= 47) ? [{ id: uuid(), equipment: 'Backhoe loader', qty: 1, hours_worked: 6, hours_idle: 2, idle_reason: 'Waiting for setting out', status: 'working' }] : []),
      ...(pouring ? [{ id: uuid(), equipment: 'Poker vibrator', qty: 2, hours_worked: 5, status: 'working' }] : []),
      ...(k === 38 && P === D ? [{ id: uuid(), equipment: 'Drum mixer 750 L', qty: 1, hours_worked: 5, hours_idle: 2, idle_reason: 'Gearbox failure', status: 'breakdown' }]
        : (k === 28 || k === 41) && P === D ? [{ id: uuid(), equipment: 'Drum mixer 750 L', qty: 1, hours_worked: 7, status: 'working' }] : []),
      ...(rainH >= 1 ? [{ id: uuid(), equipment: 'Dewatering pump 3"', qty: 1, hours_worked: 3, status: 'working' }] : []),
      ...((k === 30 || k === 48) && P === D ? [{ id: uuid(), equipment: 'Generator 60 kVA', qty: 1, hours_worked: 3, status: 'working', note: 'Power cut' }] : []),
    ];
    const elements = [...wk.entries()].map(([key, notes]) => ({ id: uuid(), element_id: E(key).id, note: [...new Set(notes)].join(', ') }));
    const visitors = k % 6 === 2 ? [{ id: uuid(), name: pick(['Eng. Mekdes', 'Eng. Samuel', 'Eng. Hirut']), organisation: 'Consultant', purpose: 'Weekly site meeting', time_in: '10:00', time_out: '12:00' }] : [];
    if (k % 12 === 6) visitors.push({ id: uuid(), name: 'Ato Berhanu', organisation: P === D ? 'Demo Client PLC' : 'Sunshine Real Estate', purpose: 'Progress review', time_in: '14:00', time_out: '15:00' });
    const instructions = [];
    if (P === D && k === 33) instructions.push({ id: uuid(), given_by: 'Eng. Mekdes', organisation: 'Consultant', instruction: 'CI-03: increase column lap length to 50Ø for C2', element_id: E('C2').id });
    if (P === D && k === 20) instructions.push({ id: uuid(), given_by: 'Eng. Samuel', organisation: 'Consultant', instruction: 'Extend wet curing of footings to 7 days', element_id: E('F5').id });
    if (P === D && k === 54) instructions.push({ id: uuid(), given_by: 'Meron Manager', organisation: 'Management', instruction: 'Prioritise S1 formwork; second carpentry gang from Monday' });
    const summary = elements.length
      ? `Work on ${[...wk.keys()].map((x) => E(x).code).join(', ')}: ${[...new Set([...wk.values()].flat())].slice(0, 4).join('; ')}.`
      : pick(['Site clearing and housekeeping.', 'Formwork fabrication in the yard.', 'Bar bending for upcoming elements.', 'Setting out and levelling.']);
    const id = uuid();
    const status = k <= 57 ? 'signed' : k <= 59 ? 'submitted' : 'draft';
    at(k, 17, P === D ? 30 : 40, `diary ${P.code} ${k}`, (t) => rpc(U.site, t, 'save_site_diary', { id, project_id: P.id, number: no(P, 'SD', DEV.site),
      diary_date: ds(k), weather_am: rainAm ? 'rain' : pick(['sunny', 'sunny', 'cloudy']), weather_pm: rainPm ? (rainH > 2 ? 'heavy_rain' : 'rain') : pick(['sunny', 'cloudy', 'windy']),
      rain_hours: rainH, temp_min: between(9, 13), temp_max: between(19, 25), work_summary: summary,
      safety_notes: pick(['Toolbox talk: working at height.', 'PPE check — 2 workers without helmets warned.', 'Toolbox talk: rebar caps.', 'No incidents.', 'No incidents.']),
      notes: delays.length ? `Delays: ${delays.map((d) => d.cause.replace('_', ' ')).join(', ')}` : undefined,
      labour, equipment, delays, visitors, instructions, elements, submit: status !== 'draft' }));
    if (status === 'signed') {
      at(k + 1, 8, P === D ? 15 : 25, `sign diary ${P.code} ${k}`, (t) => rpc(U[k % 9 === 0 ? 'manager' : 'office'], t, 'sign_site_diary', { diary_id: id, approve: true }));
    }
  }

  // ===========================================================================
  // I. Alerts (rules evaluated during the project), escalations
  // ===========================================================================
  const evaluate = (k, h) => at(k, h, 0, 'evaluate alerts', async (t) => {
    for (const P of [D, C]) await rpc(U.manager, t + (P === C ? MIN : 0), 'evaluate_alerts', { project_id: P.id });
  });
  // Close variance alerts that are no longer over the limit (element finished within allowance).
  const tidyAlerts = (k, h = 9) => at(k, h, 40, 'tidy alerts', async (t) => {
    const open = await q(`select a.id, a.entity_id, a.details from alerts a where a.rule = 'consumption_variance' and a.status <> 'closed'`);
    let i = 0;
    for (const a of open) {
      const v = await one(`select variance_pct from v_element_consumption where element_id = $1 and material_spec_id = $2`, [a.entity_id, a.details.material_spec_id]);
      if (v && (v.variance_pct == null || Number(v.variance_pct) <= Number(a.details.limit_pct))) {
        await rpc(U.manager, t + i++ * MIN, 'alert_action', { alert_id: a.id, action: 'close', note: 'Element progressed — consumption now within allowance' });
      }
    }
  });
  evaluate(24, 18); tidyAlerts(30); evaluate(42, 18); tidyAlerts(50); evaluate(52, 18); tidyAlerts(58); tidyAlerts(60, 11); evaluate(60, 12);
  at(60, 13, 0, 'acknowledge alerts', async (t) => {
    const a = await one(`select id from alerts where rule = 'gate_pass_overdue' and status = 'open' order by created_at limit 1`);
    if (a) await rpc(U.manager, t, 'alert_action', { alert_id: a.id, action: 'acknowledge' });
    const v = await one(`select id from alerts where rule = 'consumption_variance' and status = 'open' and title like '%F7%' limit 1`);
    if (v) await rpc(U.manager, t + MIN, 'alert_action', { alert_id: v.id, action: 'acknowledge' });
  });
  // FR-WF-04 escalation of stale approvals (pg_cron job in production).
  at(60, 7, 0, 'escalations', (t) => inTx(null, t, () => db.query('select public.escalate_pending_requests()')));

  // ===========================================================================
  // J. Programme (MS Project import), BoQ mapping, task progress, actual cost, EVM periods
  // ===========================================================================
  const FIX = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const dayMs = (d) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  const kOfDate = (d) => kOfCal(dayMs(d));
  // The programme starts on the Monday before W0: shift it by whole weeks (weekdays stay weekdays).
  // The file's own progress is dropped — progress is reported and verified in the app.
  const SHIFT = 7 * Math.round((WD.get(0) - 4 * DAY - dayMs(FIX.schedule.header.start_date)) / (7 * DAY));
  const shiftDate = (d) => (d ? dsCal(dayMs(d) + SHIFT * DAY) + d.slice(10) : d);
  const sched = structuredClone(FIX.schedule);
  sched.header.start_date = shiftDate(sched.header.start_date);
  sched.header.finish_date = shiftDate(sched.header.finish_date);
  delete sched.header.status_date;
  for (const t of sched.tasks) {
    t.start = shiftDate(t.start);
    t.finish = shiftDate(t.finish);
    t.constraint_date = shiftDate(t.constraint_date);
    for (const b of t.baselines ?? []) { b.start = shiftDate(b.start); b.finish = shiftDate(b.finish); }
    for (const f of ['pct_complete', 'physical_pct', 'actual_start', 'actual_finish']) delete t[f];
  }
  const schedStart = sched.header.start_date.slice(0, 10);

  // DEMO bill of quantities for the codes used in the programme (Text1 "BoQ Code"). Rates = MSP baseline
  // cost of the code × 1.12 (contract value incl. margin) / quantity.
  const BOQ_DEF = {
    '1.1.1': ['Site mobilisation, hoarding and access road', 'LS', 1], '1.1.2': ['Temporary site office, stores and toilets', 'LS', 1],
    '1.1.3': ['Setting out and survey', 'LS', 1], '1.1.4': ['Mobilise concrete mixer and vibrators', 'LS', 1],
    '1.2.1': ['Site overheads and supervision', 'month', 7],
    '2.1.1': ['Bulk excavation to formation level', 'm³', 850], '2.1.2': ['Trench excavation for grade beams', 'm³', 120],
    '2.1.3': ['Anti-termite soil treatment', 'm²', 420], '2.2.1': ['Blinding concrete C-15, 50 mm', 'm³', 21],
    '2.3.1': ['RC C-25/30 isolated footings incl. reinforcement and formwork', 'm³', 52],
    '2.4.1': ['RC grade beams incl. reinforcement and formwork', 'm³', 12], '2.4.2': ['RC column stubs to plinth level', 'm³', 4.8],
    '2.5.1': ['Backfill and compaction in 200 mm layers', 'm³', 560], '2.6.1': ['Hardcore, DPM and 100 mm ground slab on grade', 'm²', 410],
    '3.1.1': ['RC columns L1 incl. reinforcement and formwork', 'm³', 9.6], '3.2.1': ['RC beams L1 incl. reinforcement and formwork', 'm³', 12.8],
    '3.3.1': ['Slab S1 formwork, shoring and reinforcement', 'm²', 380], '3.3.2': ['Slab S1 concrete C-25/30, pour and curing', 'm³', 38],
    '3.4.1': ['RC staircase GF–L1', 'm³', 4.5],
    '4.1.1': ['RC columns L2', 'm³', 9.6], '4.2.1': ['RC beams L2', 'm³', 12.8], '4.3.1': ['Roof slab formwork and reinforcement', 'm²', 380],
    '4.3.2': ['Roof slab concrete, pour and curing', 'm³', 38], '4.4.1': ['Staircase L1–L2 and parapet walls', 'm³', 6],
    '4.5.1': ['Roof waterproofing membrane', 'm²', 420],
    '5.1.1': ['HCB 20 cm external walls L1', 'm²', 310], '5.1.2': ['HCB 15 cm internal partitions L1', 'm²', 240],
    '5.2.1': ['HCB walls and partitions L2', 'm²', 520], '5.3.1': ['Lintels, sills and stiffener columns', 'm', 180],
    '6.1.1': ['Electrical conduits and boxes', 'point', 160], '6.1.2': ['Wiring and cable pulling', 'point', 160],
    '6.1.3': ['Lighting fixtures, sockets and distribution boards', 'point', 160], '6.1.4': ['Earthing and lightning protection', 'LS', 1],
    '6.2.1': ['Plumbing rough-in and sleeves', 'point', 48], '6.2.2': ['Sewer line and manholes', 'm', 85],
    '6.2.3': ['Water tank, pump and roof plumbing', 'LS', 1], '6.2.4': ['Sanitary fixtures', 'set', 24],
    '6.3.1': ['Fire alarm and detection', 'LS', 1], '6.4.1': ['Testing and commissioning', 'LS', 1],
    '7.1.1': ['Internal plastering', 'm²', 1900], '7.1.2': ['External plastering', 'm²', 820], '7.2.1': ['Cement-sand floor screed', 'm²', 760],
    '7.2.2': ['Ceramic floor and wall tiling', 'm²', 680], '7.2.3': ['Marble cladding to staircase', 'm²', 60], '7.3.1': ['Gypsum false ceiling', 'm²', 640],
    '7.4.1': ['Metal windows and glazing', 'm²', 210], '7.4.2': ['Doors and ironmongery', 'nr', 36], '7.5.1': ['Painting internal and external', 'm²', 3400],
    '7.6.1': ['Kitchen cabinets and worktops', 'set', 6], '7.7.1': ['Balustrades and handrails', 'm', 48],
    '8.1.1': ['Snagging and defects rectification', 'LS', 1], '8.1.2': ['Final cleaning and handover documents', 'LS', 1],
  };
  const boqCost = {};
  for (const t of sched.tasks) {
    if (t.is_summary || !t.boq_codes) continue;
    for (const code of String(t.boq_codes).split(/\s*[;,]\s*/).filter(Boolean)) {
      boqCost[code] = (boqCost[code] ?? 0) + Number(t.baselines?.[0]?.cost ?? t.cost ?? 0);
    }
  }
  const BQ = Object.fromEntries(Object.keys(boqCost).map((code) => [code, uuid()]));
  const boqQty = (code) => (BOQ_DEF[code] ?? [null, null, 1])[2];
  // take-off lines → BoQ item (material issues are allocated to tasks through it)
  const TK_BOQ = [
    ...range('F', 1, 8).map((c) => [c, '2.3.1']), ...range('GB', 1, 4).map((c) => [c, '2.4.1']), ...range('C', 1, 8).map((c) => [c, '3.1.1']),
    ...range('B', 1, 4).map((c) => [c, '3.2.1']), ['S1', '3.3.1', ['r12', 'wire']], ['S1', '3.3.2', ['c25']], ['ST1', '3.4.1'], ['W1', '5.1.1'],
    ...range('C', 9, 14).map((c) => [c, '4.1.1']), ['S2', '4.3.1', ['r12', 'wire']], ['S2', '4.3.2', ['c25']],
  ];
  at(-10, 15, 0, 'DEMO BoQ', (t) => inTx(U.manager, t, async () => {
    for (const [code, cost] of Object.entries(boqCost)) {
      const [desc, unit, qty] = BOQ_DEF[code] ?? [`BoQ item ${code}`, 'LS', 1];
      await db.query('insert into boq_items (id, project_id, item_no, description, unit, quantity) values ($1, $2, $3, $4, $5, $6)',
        [BQ[code], D.id, code, desc, unit, qty]);
      await db.query('insert into boq_rates (boq_item_id, rate) values ($1, $2)', [BQ[code], round(Math.max(cost, 1000) * 1.12 / qty, 2)]);
    }
    for (const [el, code, specs] of TK_BOQ) {
      await db.query(`update element_takeoffs set boq_item_id = $1 where element_id = $2 and ($3::uuid[] is null or material_spec_id = any ($3::uuid[]))`,
        [BQ[code], E(el).id, specs ? specs.map((sp) => S[sp]) : null]);
    }
  }));

  const SCH = { id: null, bl: uuid(), task: {} };   // task: msp uid → schedule_tasks.id
  const T_ = (uid) => { const id = SCH.task[uid]; if (!id) throw new Error(`schedule task ${uid} not found`); return id; };
  at(-9, 15, 0, 'import programme', async (t) => {
    // manager imports: a price role, so the MSP costs are kept (BAC basis)
    const r = await rpc(U.manager, t, 'import_schedule', { project_id: D.id, schedule: sched, mapping: FIX.mapping, options: FIX.options });
    SCH.id = r.schedule_id;
    for (const x of await q('select id, msp_uid from schedule_tasks where schedule_id = $1', [SCH.id])) SCH.task[x.msp_uid] = x.id;
    return r;
  });
  at(-9, 16, 30, 'programme set-up', (t) => {
    const cs = castSeq('S1');
    return rpc(U.office, t, 'save_task_setup', { tasks: [
      { task_id: T_(6), ev_method: 'loe', comment: 'Site overheads earn with time (level of effort)' },
      // the C-row footings F5–F8 are built with the A-row footings of the same axis
      ...[16, 17, 18, 19].map((uid, i) => ({ task_id: T_(uid), element_links: [{ element_id: E(`F${i + 5}`).id }],
        comment: `F${i + 5} cast with F${i + 1}` })),
      { task_id: T_(39), element_links: [{ element_id: E('S1').id, activity_seq_from: 1, activity_seq_to: cs - 1 }], comment: 'S1 activities before the pour' },
      { task_id: T_(40), element_links: [{ element_id: E('S1').id, activity_seq_from: cs, activity_seq_to: 99 }], comment: 'S1 pour, curing and stripping' },
    ] });
  });
  at(-8, 10, 0, 'propose baseline', (t) => rpc(U.manager, t, 'set_baseline', { id: SCH.bl, schedule_id: SCH.id, name: 'Contract baseline',
    source: 'msp_baseline', msp_baseline_number: 0, cost_source: 'msp_baseline_cost', effective_from: schedStart,
    reason: 'Programme submitted with the tender, MSP baseline 0' }));
  at(-7, 11, 0, 'approve baseline', (t) => rpc(U.coordinator, t, 'approve_baseline', { baseline_id: SCH.bl, approve: true,
    comment: 'Approved as the performance measurement baseline' }));
  at(-7, 12, 0, 'first forecast', (t) => rpc(U.office, t, 'run_forecast', { schedule_id: SCH.id, status_date: ds(-7) }));

  // Progress of the tasks that are not driven by elements (site engineer reports, office engineer verifies next morning).
  // [uid, k, value (BoQ qty to date, or % for 0/100 tasks), opts]
  const TPROG = [
    [2, -4, 100], [3, -2, 0.6], [3, 1, 1], [4, 1, 0.5], [4, 4, 1], [5, 3, 1], [7, 3, 1],
    [11, 4, 200], [11, 8, 520], [11, 11, 850], [12, 19, 60], [12, 24, 120], [13, 12, 420],
    [14, 5, 6], [14, 10, 12], [14, 22, 15], [14, 27, 21],
    [21, 36, 2.4], [21, 41, 4.8],
    [22, 30, 140], [22, 38, 300], [22, 46, 470, { adjust: 440, comment: 'Re-measured: 30 m³ around FB1 failed the compaction test' }], [22, 53, 560],
    [23, 50, 90], [23, 55, 230, { reject: 'DPM not laid yet — report hardcore only' }], [23, 56, 190], [23, 59, 280],
    [24, 44, 25], [24, 50, 50], [24, 56, 68], [24, 59, 76],
    [71, 57, 12], [71, 59, 24], [71, 60, 32], [72, 58, 6], [72, 60, 9],
  ];
  const isQty = (uid) => !!sched.tasks.find((x) => x.uid === uid)?.boq_codes;
  const boqOf = (uid) => BQ[String(sched.tasks.find((x) => x.uid === uid).boq_codes).split(/[;,]/)[0]];
  for (const [uid, k, v, o = {}] of TPROG) {
    const pid = uuid();
    const over = isQty(uid) && v > boqQty(String(sched.tasks.find((x) => x.uid === uid).boq_codes));
    at(k, 16, 20, `task progress ${uid}`, (t) => rpc(U.site, t, 'report_task_progress', { id: pid, task_id: T_(uid), status_date: ds(k),
      ...(isQty(uid) ? { qty_done: v } : { pct_complete: v }), remarks: over ? 'Over-measure on site' : o.remarks }));
    if (k + 1 > 60) continue;
    at(k + 1, 9, 30, `verify task progress ${uid}`, (t) => rpc(U.office, t, 'verify_task_progress', { progress_id: pid,
      approve: !o.reject, comment: o.reject ?? o.comment,
      verified_qty: o.adjust != null ? [{ boq_item_id: boqOf(uid), qty_to_date: o.adjust }] : undefined }));
  }

  // Weekly actual cost (labour payroll, equipment hire, subcontract invoices, site overheads) next to the
  // issued materials. The site accountant books what the week cost; over the project that runs at a CPI
  // a little under 1 (worst during the cement shortage). Costs are booked on the tasks that progressed.
  const KIND = (uid) => (uid === 6 ? 'overhead' : [11, 12, 13, 22, 23].includes(uid) ? 'earth' : [3, 4, 5, 7].includes(uid) ? 'prelim'
    : [24, 71, 72].includes(uid) ? 'mep' : 'concrete');
  const SPLIT = {
    overhead: [['overhead', 1, 'Site staff salaries, guards and site office running', 'coordinator']],
    earth: [['subcontract', 0.6, 'Earthworks subcontract — Kality Earthmoving PLC', 'proc', 'Kality Earthmoving PLC'], ['equipment', 0.4, 'Excavator and roller hire', 'proc']],
    prelim: [['labour', 0.5, 'Mobilisation labour', 'coordinator'], ['other', 0.5, 'Hoarding, water and power connection', 'coordinator']],
    concrete: [['labour', 0.55, 'Concrete and formwork gang payroll', 'coordinator'], ['subcontract', 0.25, 'Rebar fixing — Tigist Rebar Works', 'proc', 'Tigist Rebar Works'],
      ['equipment', 0.2, 'Mixer, vibrators and pump hire', 'proc']],
    mep: [['subcontract', 0.8, 'MEP subcontract — Abay Electromechanical', 'proc', 'Abay Electromechanical'], ['labour', 0.2, 'MEP helpers', 'coordinator']],
  };
  const cpiT = (k) => 0.965 - 0.04 * Math.exp(-(((k - 46) / 7) ** 2)) + 0.006 * Math.sin(k / 3);
  let evPrev = new Map();
  const uidOfTask = (id) => Number(Object.entries(SCH.task).find(([, v]) => v === id)?.[0]);
  function weeklyCost(k) {
    at(k, 17, 45, 'weekly actual cost', async (t) => {
      const date = ds(k);
      const evNow = new Map((await q('select task_id, ev from app.evm_rows($1, $2::date)', [SCH.id, date])).map((r) => [r.task_id, Number(r.ev)]));
      const evTot = sum([...evNow.values()]);
      const ac = Number((await one('select coalesce(sum(amount), 0) as a from app.ac_rows($1, $2::date)', [D.id, date])).a);
      const dEV = [...evNow].map(([id, ev]) => [id, ev - (evPrev.get(id) ?? 0)]).filter(([, d]) => d > 1);
      evPrev = evNow;
      const dTot = sum(dEV.map((d) => d[1]));
      const cpi = cpiT(k);
      const amount = Math.max(evTot / cpi - ac, 0.3 * dTot / cpi + 12000);
      // by task (small ones together, no task) and category
      const parts = new Map();
      for (const [id, d] of dEV.length ? dEV : [[null, 1]]) {
        const share = dEV.length ? d / dTot : 1;
        const uid = id ? uidOfTask(id) : null;
        const key = id && share >= 0.04 ? id : null;
        for (const [cat, f, desc, who, sub] of SPLIT[uid ? KIND(uid) : 'concrete']) {
          const pk = `${key}|${cat}|${desc}`;
          const cur = parts.get(pk) ?? { task: key, cat, desc: key ? desc : `${desc} (general)`, who, sub, amt: 0 };
          cur.amt += amount * share * f;
          parts.set(pk, cur);
        }
      }
      let i = 0;
      for (const x of parts.values()) {
        const amt = round(x.amt, 2);
        if (amt < 50) continue;
        const md = x.cat === 'labour' ? Math.max(1, Math.round(amt / 480)) : null;
        await rpc(U[x.who], t + i++ * 30e3, 'record_actual_cost', { id: uuid(), project_id: D.id, number: no(D, 'CE', DEV[x.who]), entry_date: date,
          category: x.cat, task_id: x.task ?? undefined, description: `${x.desc} — week ending ${date}`, subcontractor: x.sub,
          qty: md ?? undefined, uom: md ? 'man-day' : undefined, rate: md ? round(amt / md, 2) : undefined, amount: amt,
          source: x.cat === 'labour' || x.cat === 'overhead' ? 'payroll' : 'invoice', source_ref: x.cat === 'labour' ? `Payroll ${date}` : undefined });
      }
    });
  }
  const isSat = (k) => new Date(WD.get(k)).getUTCDay() === 6;
  for (let k = kOfDate(schedStart); k <= 60; k++) {
    if (isSat(k) || k === 60) {
      weeklyCost(k);
      at(k, 18, 0, 'weekly forecast', (t) => rpc(U.office, t, 'run_forecast', { schedule_id: SCH.id, status_date: ds(k) }));
    }
  }

  // Monthly EVM periods from the programme start; every complete month is prepared and closed on the
  // second working day of the next month (variance notes for the breached indicators), the current one stays open.
  const PER = [];
  for (let ms = schedStart; ms <= ds(60);) {
    const d = new Date(dayMs(ms));
    const end = dsCal(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    PER.push({ id: uuid(), start: ms, end });
    ms = dsCal(dayMs(end) + DAY);
  }
  const VAR_TEXT = {
    spi: ['Footing and grade-beam works started late; Ø8 links for GB4 delayed (PO-0006)', 'Second carpentry gang; ready-mix for C5–C6',
      'Planned value slips about two weeks until the L1 columns are cast'],
    cpi: ['Blinding and site-batched concrete used more cement than the mix design; cement price spike during the shortage',
      'Mixer operator replaced; cement issued against the pour volume', 'About 3 % over budget on the substructure'],
    spi_t: ['Earned schedule behind by the late grade beams', 'Recovery programme for L1', 'Forecast finish later than the baseline'],
    tcpi: ['Remaining work must be done below budget to recover the CPI', 'Value engineering on finishes', 'Limited'],
  };
  at(kOfDate(schedStart), 8, 0, 'open EVM period 1', (t) => rpc(U.office, t, 'open_period', { id: PER[0].id, schedule_id: SCH.id, kind: 'monthly',
    period_start: PER[0].start, status_date: PER[0].end }));
  PER.forEach((pe, i) => {
    const kc = kOfDate(dsCal(dayMs(pe.end) + DAY)) + 1;     // second working day of the next month
    if (i === PER.length - 1 || kc > 60) return;
    at(kc, 11, 0, `prepare EVM period ${i + 1}`, (t) => rpc(U.office, t, 'prepare_period_close', { period_id: pe.id }));
    at(kc, 13, 0, `variance notes period ${i + 1}`, async (t) => {
      const ep = await one('select prepared_summary from evm_periods where id = $1', [pe.id]);
      let j = 0;
      for (const b of ep.prepared_summary?.breaches ?? []) {
        const [cause, action, impact] = VAR_TEXT[b.indicator] ?? VAR_TEXT.spi;
        await rpc(U.office, t + j++ * MIN, 'save_variance_note', { id: uuid(), period_id: pe.id, indicator: b.indicator, cause,
          corrective_action: action, impact, owner_id: U.site, due_date: ds(kc + 12) });
      }
    });
    at(kc, 15, 0, `close EVM period ${i + 1}`, (t) => rpc(U[i % 2 ? 'coordinator' : 'manager'], t, 'close_period', { period_id: pe.id,
      comment: `Monthly progress report ${pe.end.slice(0, 7)} issued to the client` }));
    at(kc, 16, 0, `open EVM period ${i + 2}`, (t) => rpc(U.office, t, 'open_period', { id: PER[i + 1].id, schedule_id: SCH.id, kind: 'monthly',
      period_start: PER[i + 1].start, status_date: PER[i + 1].end }));
  });

  // ===========================================================================
  // K. Monthly look-ahead (current and next month): make-ready, weekly commitments, PPC
  // ===========================================================================
  const nextYm = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
  const lastOf = (ym) => { const [y, m] = ym.split('-').map(Number); return dsCal(Date.UTC(y, m, 0)); };
  // JS mirror of app.la_weeks: Mon–Sat weeks from the 1st (Sunday skipped) plus two make-ready buffer weeks.
  const laWeeks = (start, end) => {
    const out = [];
    const hor = dayMs(end) + 14 * DAY;
    let d = dayMs(start);
    if (new Date(d).getUTCDay() === 0) d += DAY;
    while (d <= hor) {
      const we = Math.min(d + ((6 - new Date(d).getUTCDay() + 7) % 7) * DAY, hor);
      out.push({ start: dsCal(d), end: dsCal(we), buffer: d > dayMs(end) });
      d = we + DAY;
      if (new Date(d).getUTCDay() === 0) d += DAY;
    }
    return out;
  };
  const RNC = (name, k) => (/grade beam/i.test(name) ? ['materials', 'Ø8 links for GB4 not delivered (PO-0006 delayed)']
    : /column/i.test(name) && k >= 42 && k <= 49 ? ['materials', 'No cement on the market — pour moved to ready-mix']
      : /slab|beam/i.test(name) ? ['prerequisite_work', 'Columns below not stripped in time']
        : /backfill|hardcore/i.test(name) ? ['weather', 'Afternoon rain — fill too wet to compact']
          : /sewer/i.test(name) ? ['subcontractor', 'Plumbing subcontractor crew on another site']
            : pick([['labour', 'Carpenters moved to the S1 formwork'], ['equipment', 'Mixer breakdown'], ['bad_planning', 'Too much committed for one gang']]));
  const planWeekId = async (planId, start) => (await one('select id from lookahead_weeks where plan_id = $1 and week_start = $2', [planId, start]))?.id;

  function lookahead(ym, o) {
    const plan = { id: uuid(), ym, start: `${ym}-01`, end: lastOf(ym) };
    const genK = Math.min(o.genK, 58), pubK = Math.min(genK + 1, 59);
    at(genK, 10, 0, `look-ahead ${ym} generate`, (t) => rpcLA(U.office, genK, t, 'generate_lookahead', { plan_id: plan.id, project_id: D.id,
      schedule_id: SCH.id, month: ym }));
    at(genK, 11, 0, `look-ahead ${ym} assign`, async (t) => {
      const items = await q(`select id from lookahead_items where plan_id = $1 and status = 'active'`, [plan.id]);
      return rpcLA(U.office, genK, t, 'assign_lookahead_item', { item_ids: items.map((x) => x.id), responsible_id: U.site });
    });
    // manual constraints (created before publishing); [name regex, type, description, owner, due k, [k, status, comment] | null]
    const manual = (o.manual ?? []).map((m) => ({ id: uuid(), m, made: false }));
    at(genK, 14, 0, `look-ahead ${ym} constraints`, async (t) => {
      const items = await q(`select id, name from lookahead_items where plan_id = $1 and status = 'active' order by planned_start`, [plan.id]);
      let i = 0;
      for (const c of manual) {
        const [re, ctype, description, owner, dueK] = c.m;
        const it = items.find((x) => re.test(x.name));
        if (!it) continue;
        await rpcLA(U.office, genK, t + i++ * MIN, 'update_constraint', { id: c.id, item_id: it.id, ctype, description, owner_id: U[owner],
          due_date: ds(dueK) });
        c.made = true;
      }
    });
    for (const c of manual) {
      const [, , , owner, , clear] = c.m;
      if (!clear || clear[0] > 60) continue;
      const [ck, status, comment] = clear;
      at(ck, 10, 30, `look-ahead ${ym} constraint ${status}`, (t) => (c.made ? rpcLA(U[owner], ck, t, 'update_constraint', { id: c.id, status, comment }) : null));
    }
    at(pubK, 9, 0, `look-ahead ${ym} publish`, (t) => rpcLA(U.office, pubK, t, 'publish_lookahead', { plan_id: plan.id }));
    // make-ready: the office engineer works the automatic constraints
    for (const [k, ctype, status, comment] of o.auto ?? []) {
      if (k > 60) continue;
      at(k, 11, 0, `look-ahead ${ym} ${ctype} ${status}`, async (t) => {
        const c = await one(`select c.id from lookahead_constraints c join lookahead_items i on i.id = c.item_id
          where i.plan_id = $1 and c.ctype = $2 and c.status in ('open','in_progress','blocked') order by c.due_date, c.created_at limit 1`, [plan.id, ctype]);
        if (!c) return null;
        return rpcLA(U.office, k, t, 'update_constraint', { id: c.id, status, comment, owner_id: U.office });
      });
    }
    // weekly cycle: commit on the last working day before the week, report and close on its Saturday
    for (const w of laWeeks(plan.start, plan.end).filter((x) => !x.buffer)) {
      // (the week after today is committed today, i.e. on the Friday)
      const commitK = Math.min(kOfDate(w.start) - 1, 60);
      if (commitK < pubK || kOfDate(w.start) - commitK > 3) continue;
      const commits = [];
      at(commitK, 15, 0, `look-ahead ${ym} commit ${w.start}`, async (t) => {
        const wid = await planWeekId(plan.id, w.start);
        const items = await q(`select i.id, i.name, st.pct_complete from lookahead_items i join schedule_tasks st on st.id = i.schedule_task_id
          where i.plan_id = $1 and i.status = 'active' and not i.is_milestone and st.ev_method <> 'loe' and st.pct_complete < 100
            and (coalesce((i.week_days ->> $2)::numeric, 0) > 0 or i.window_role = 'late')
          order by (i.window_role = 'late') desc, i.planned_start, i.sort_key limit $3`, [plan.id, w.start, o.perWeek ?? 5]);
        let i = 0;
        for (const it of items) {
          const cand = await one(`select id from weekly_commitments where week_id = $1 and item_id = $2 and kind = 'candidate'`, [wid, it.id]);
          const id = cand?.id ?? uuid();
          const pct = Number(it.pct_complete);
          const target = pct >= 75 ? 100 : Math.min(100, Math.round((pct + 20) / 5) * 5);
          await rpcLA(U.site, commitK, t + i++ * MIN, 'commit_lookahead_item', { id, item_id: it.id, week_id: wid,
            description: `${it.name} — reach ${target} %`, target_pct: target,
            override_reason: 'Crew and materials confirmed at the Friday coordination meeting' });
          commits.push({ id, name: it.name, task: it.id, target });
        }
      });
      const endK = kOfDate(w.end);
      const closable = w.end <= ds(60);
      at(closable ? endK : 60, closable ? 14 : 13, 0, `look-ahead ${ym} report ${w.start}`, async (t) => {
        let i = 0;
        for (const c of commits) {
          const cur = await one(`select st.pct_complete from lookahead_items i join schedule_tasks st on st.id = i.schedule_task_id where i.id = $1`, [c.task]);
          const pct = Number(cur.pct_complete);
          const done = pct >= c.target - 0.5;
          if (!done && !closable) continue;       // week still running: only the finished work is reported
          const [rnc, note] = RNC(c.name, closable ? endK : 60);
          await rpcLA(U.site, closable ? endK : 60, t + i++ * MIN, 'report_commitment', { commitment_id: c.id, outcome: done ? 'completed' : 'not_completed',
            actual_pct: pct, rnc_code: done ? undefined : rnc, rnc_note: done ? undefined : note });
        }
      });
      if (closable) {
        at(endK, 16, 0, `look-ahead ${ym} close week ${w.start}`, async (t) => rpcLA(U.coordinator, endK, t, 'close_week',
          { week_id: await planWeekId(plan.id, w.start) }));
      }
    }
    // keep readiness / progress current
    for (let k = pubK + 1; k <= 60; k++) {
      if (new Date(WD.get(k)).getUTCDay() === 1) at(k, 7, 0, `look-ahead ${ym} refresh`, (t) => rpcLA(U.office, k, t, 'refresh_lookahead', { plan_id: plan.id }));
    }
    return plan;
  }
  const curYm = ds(60).slice(0, 7), nxtYm = nextYm(curYm);
  const genKFor = (ym) => kOfCal(dayMs(`${ym}-01`) - 7 * DAY);
  lookahead(curYm, { genK: genKFor(curYm),
    manual: [[/Staircase GF/i, 'information', 'Staircase drawing S-ST-01 Rev C awaited (RFI-12)', 'office', genKFor(curYm) + 12, [53 + 4, 'cleared', 'Rev C received from the consultant']],
      [/Slab S1 — formwork/i, 'equipment', 'Additional props for bay 3 shoring (rented from Gerji)', 'proc', genKFor(curYm) + 18, [genKFor(curYm) + 16, 'cleared', 'Props delivered']],
      [/Backfill/i, 'labour', 'Compaction crew shared with the CMC site', 'coordinator', genKFor(curYm) + 8, [genKFor(curYm) + 9, 'waived', 'Plate compactor hired instead — crew not needed']],
      [/Beam B1/i, 'inspection', 'Consultant to approve the B1 rebar before casting', 'office', 62, null]],
    auto: [[genKFor(curYm) + 2, 'material', 'cleared', 'Cement covered by PO-0005 (Derba) delivery'], [genKFor(curYm) + 3, 'predecessor', 'in_progress', 'Following up daily'],
      [genKFor(curYm) + 9, 'material', 'cleared', 'Steel on site (PO-0006 first lot)'], [genKFor(curYm) + 15, 'predecessor', 'waived', 'Work can start on the free bays']] });
  lookahead(nxtYm, { genK: genKFor(nxtYm), perWeek: 4,
    manual: [[/L2 columns/i, 'material', 'Ø8 links for the L2 columns (PR / PO-0011)', 'proc', 63, null],
      [/Wall W1/i, 'labour', 'Masonry subcontractor mobilisation', 'coordinator', 61, [59, 'cleared', 'Masonry subcontract signed']]],
    auto: [[genKFor(nxtYm) + 2, 'material', 'cleared', 'HCB in the yard (PO-0010)'], [genKFor(nxtYm) + 3, 'predecessor', 'waived', 'Columns can start on the cast grid lines']] });

  // ===========================================================================
  // Run everything in simulated order
  // ===========================================================================
  events.sort((a, b) => a.t - b.t || a.s - b.s);
  const failures = [];
  let done = 0;
  for (const ev of events) {
    try { await ev.fn(ev.t); done++; } catch (e) { failures.push(`${new Date(ev.t + EAT).toISOString().slice(0, 16)} ${ev.label}: ${e.message}`); }
  }

  // ===========================================================================
  // Backdate: real transaction times → simulated times
  // ===========================================================================
  const setupAt = iso(T(-14, 9));
  const richStart = tsmap.length ? tsmap[0][0] : new Date().toISOString();   // transactions ran in order
  await superTx(async () => {
    await db.exec('set local session_replication_role = replica');
    await db.exec('create temp table _tsmap (real timestamptz primary key, sim timestamptz not null) on commit drop');
    await db.query(`insert into _tsmap select (x ->> 0)::timestamptz, (x ->> 1)::timestamptz from jsonb_array_elements($1::jsonb) x`, [JSON.stringify(tsmap)]);
    const cols = await q(`select c.table_schema, c.table_name, c.column_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.data_type = 'timestamp with time zone' and c.table_schema in ('public', 'auth', 'app') and c.table_name not like '\\_%'`);
    for (const { table_schema: s, table_name: tb, column_name: c } of cols) {
      const rel = `"${s}"."${tb}"`, col = `"${c}"`;
      // rows written by migrations / the base seed → project set-up time
      await db.query(`update ${rel} set ${col} = $1 where ${col} >= $2 and ${col} < $3`, [setupAt, new Date(BOOT).toISOString(), richStart]);
      await db.query(`update ${rel} x set ${col} = m.sim from _tsmap m where x.${col} = m.real`);
    }
    // A ready-mix truck's GRN and MIV share one transaction (same txn_at / created_at):
    // order the receipt first so bin-card running balances never dip below zero.
    await db.exec(`update stock_ledger set created_at = created_at + interval '1 second'
      where doc_type = 'miv' and doc_id in (select miv_id from pour_issues where grn_id is not null)`);
    // Dates derived from current_date inside the RPCs.
    await db.exec(`update progress_updates set report_date = (created_at at time zone 'Africa/Addis_Ababa')::date
      where remarks like 'Hold point passed%' or report_date > (created_at at time zone 'Africa/Addis_Ababa')::date`);
    await db.exec(`update elements e set actual_finish = x.d from (
        select element_id, max((coalesce(verified_at, created_at) at time zone 'Africa/Addis_Ababa')::date) d
        from progress_updates where status in ('verified','adjusted') group by element_id) x
      where x.element_id = e.id and e.status = 'completed'`);
    // Element-driven schedule tasks: re-derive % / actual dates from the corrected progress dates.
    if (SCH.id) {
      await db.query(`select app.refresh_task_progress(id, false) from schedule_tasks
        where schedule_id = $1 and not is_summary and deleted_at is null and ev_method = 'elements'`, [SCH.id]);
      await db.query('select app.rollup_summaries($1)', [SCH.id]);
    }
    // Older notifications have been read.
    await db.exec(`update notifications set read_at = created_at + interval '3 hours'
      where read_at is null and created_at < now() - interval '2 days' and not is_critical`);
    await db.exec(`update notifications set read_at = created_at + interval '1 hour'
      where read_at is null and created_at < now() - interval '6 days'`);
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  rich demo: ${done}/${events.length} events, ${tsmap.length} transactions backdated in ${secs}s`);
  if (failures.length) {
    console.warn(`  rich demo: ${failures.length} event(s) failed:`);
    for (const f of failures.slice(0, 200)) console.warn('   -', f);
  }
}
