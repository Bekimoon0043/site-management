// Demo users and a small project, created on first start of the local server.

import { randomUUID as uuid } from 'node:crypto';

const USERS = [
  ['admin@site.local', 'Abebe Admin', 'admin'],
  ['manager@site.local', 'Meron Manager', 'manager'],
  ['coordinator@site.local', 'Kebede Coordinator', 'coordinator'],
  ['office@site.local', 'Hana Office Engineer', 'office_engineer'],
  ['site@site.local', 'Dawit Site Engineer', 'site_engineer'],
  ['store@site.local', 'Selam Store Keeper', 'store_keeper'],
  ['procurement@site.local', 'Yonas Procurement', 'procurement'],
  ['gate@site.local', 'Getachew Gate Security', 'security'],
  ['client@site.local', 'Demo Client Representative', 'client'],
];

// Base demo (users, project DEMO, elements, take-offs, prices). With
// `activity: true` it also posts the original small activity set (opening
// stock, footing progress, one request); the rich demo (demo-rich.mjs) passes
// `activity: false` and generates ~10 weeks of backdated history instead.
export async function seedDemo({ db, asUser, createAuthUser }, { activity = true } = {}) {
  console.log('  creating demo users and project');
  const U = {};
  for (const [email, name, role] of USERS) {
    U[role] = await createAuthUser({ email, password: 'demo1234', full_name: name, role });
  }

  const P = uuid(), A = uuid(), G = uuid(), L1 = uuid(), L2 = uuid(), MAIN = uuid(), YARD = uuid();
  const spec = async (name, grade) => (await db.query(
    `select s.id from material_specs s join materials m on m.id = s.material_id where m.name = $1 and s.grade = $2`, [name, grade])).rows[0].id;
  const S = {
    c25: await spec('Concrete', 'C-25/30'), r12: await spec('Rebar', 'S-400 Ø12'), r16: await spec('Rebar', 'S-400 Ø16'),
    r8: await spec('Rebar', 'S-400 Ø8'), opc: await spec('Cement', 'OPC 42.5'), sand: await spec('Sand', ''),
    agg: await spec('Coarse aggregate', '02 (12–20mm)'), hcb: await spec('HCB', '20cm Class B'), wire: await spec('Binding wire', 'No. 18'),
  };

  const elements = [];
  await asUser(U.admin, async () => {
    await db.query(`insert into projects (id, code, name, location, client, start_date, end_date)
      values ($1, 'DEMO', 'Demo Tower (G+2)', 'Bole, Addis Ababa', 'Demo Client PLC', current_date - 60, current_date + 300)`, [P]);
    for (const role of Object.keys(U).filter((r) => r !== 'admin')) {
      await db.query('insert into project_members (project_id, user_id) values ($1, $2)', [P, U[role]]);
    }
    await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'A', 'Block A')`, [A, P]);
    await db.query(`insert into levels (id, project_id, block_id, code, name, sort_order) values
      ($1, $4, $5, 'G', 'Ground / Foundation', 0), ($2, $4, $5, 'L1', 'Level 1', 1), ($3, $4, $5, 'L2', 'Level 2', 2)`, [G, L1, L2, P, A]);
    await db.query(`insert into stores (id, project_id, name, store_type) values ($1, $3, 'Main store', 'main'), ($2, $3, 'Open yard', 'yard')`, [MAIN, YARD, P]);
    await db.query(`insert into suppliers (name, contact_person, phone, categories, rating) values
      ('Abyssinia Steel PLC', 'Tesfaye', '+251911000001', '{Reinforcement}', 4.2),
      ('Derba Cement', 'Lulit', '+251911000002', '{Cement}', 4.5),
      ('Addis Ready-Mix', 'Samuel', '+251911000003', '{Concrete}', 3.8),
      ('Akaki Aggregates', 'Girma', '+251911000004', '{Aggregate,Blocks}', 3.5)`);

    const add = async (code, type, level, grid, start, finish, takeoffs) => {
      const id = uuid();
      await db.query(`insert into elements (id, project_id, block_id, level_id, code, element_type, grid, drawing_ref, planned_start, planned_finish)
        values ($1, $2, $3, $4, $5, $6, $7, $8, current_date + $9::int, current_date + $10::int)`,
        [id, P, A, level, code, type, grid, `S-${type.slice(0, 2).toUpperCase()}-01 Rev B`, start, finish]);
      for (const [s, qty] of takeoffs) {
        await db.query('insert into element_takeoffs (project_id, element_id, material_spec_id, planned_qty) values ($1, $2, $3, $4)', [P, id, s, qty]);
      }
      elements.push({ id, code });
      return id;
    };
    for (let i = 1; i <= 4; i++) await add(`F${i}`, 'footing', G, `A/${i}`, -40 + i * 2, -25 + i * 2, [[S.c25, 6.5], [S.r16, 420], [S.r12, 160], [S.wire, 6]]);
    for (let i = 1; i <= 6; i++) await add(`C${i}`, 'column', L1, `B/${i}`, -10 + i, 5 + i, [[S.c25, 1.6], [S.r16, 190], [S.r8, 45], [S.wire, 2]]);
    await add('B1', 'beam', L1, 'A-B/1-3', 5, 20, [[S.c25, 3.2], [S.r16, 280], [S.r8, 70]]);
    await add('S1', 'slab', L1, 'A-C/1-4', 10, 30, [[S.c25, 38], [S.r12, 2600], [S.wire, 20]]);
    await add('W1', 'wall', L1, 'A/1-4', 35, 55, [[S.hcb, 1450], [S.opc, 24], [S.sand, 6]]);
  });

  await asUser(U.manager, () => db.query(`insert into spec_prices (material_spec_id, unit_price) values
      ($1, 7800), ($2, 92), ($3, 95), ($4, 98), ($5, 1450), ($6, 1100), ($7, 1350), ($8, 32), ($9, 140)`,
      [S.c25, S.r12, S.r16, S.r8, S.opc, S.sand, S.agg, S.hcb, S.wire]));
  if (!activity) return;

  await asUser(U.manager, async () => {
    await db.query(`select public.post_opening_balance($1::jsonb)`, [JSON.stringify({
      project_id: P, store_id: MAIN,
      lines: [{ material_spec_id: S.r16, qty: 2400 }, { material_spec_id: S.r12, qty: 900 }, { material_spec_id: S.r8, qty: 120 },
              { material_spec_id: S.opc, qty: 80 }, { material_spec_id: S.wire, qty: 35 }],
    })]);
    await db.query(`select public.post_opening_balance($1::jsonb)`, [JSON.stringify({
      project_id: P, store_id: YARD, lines: [{ material_spec_id: S.sand, qty: 14 }, { material_spec_id: S.agg, qty: 21 }, { material_spec_id: S.hcb, qty: 600 }],
    })]);
  });

  // Footings are done; first columns under way.
  await asUser(U.site_engineer, () => db.query(`select public.register_device($1::jsonb)`, [JSON.stringify({ device_id: uuid(), name: 'seed' })]));
  const acts = (await db.query(`select a.id, e.code, a.seq from element_activities a join elements e on e.id = a.element_id
     where e.code in ('F1','F2','F3','F4','C1') order by e.code, a.seq`)).rows;
  for (const a of acts) {
    if (a.code === 'C1' && a.seq > 2) continue;
    const pid = uuid();
    await asUser(U.site_engineer, () => db.query(`select public.report_progress($1::jsonb)`,
      [JSON.stringify({ id: pid, element_activity_id: a.id, pct_complete: 100 })]));
    await asUser(U.office_engineer, () => db.query(`select public.verify_progress($1::jsonb)`,
      [JSON.stringify({ progress_id: pid, approve: true })]));
  }

  // One request waiting for review so the approval flow has something in it.
  const c2 = elements.find((e) => e.code === 'C2').id, c3 = elements.find((e) => e.code === 'C3').id;
  await asUser(U.site_engineer, () => db.query(`select public.save_mr($1::jsonb)`, [JSON.stringify({
    id: uuid(), project_id: P, number: 'DEMO-MR-D001-0001', block_id: A, priority: 'urgent',
    required_date: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), delivery_location: 'Main store', store_id: MAIN,
    purpose: 'Columns C2–C3 rebar and casting', submit: true,
    lines: [
      { id: uuid(), material_spec_id: S.r16, qty: 380, elements: [{ id: uuid(), element_id: c2, qty: 190 }, { id: uuid(), element_id: c3, qty: 190 }] },
      { id: uuid(), material_spec_id: S.c25, qty: 3.2, elements: [{ id: uuid(), element_id: c2, qty: 1.6 }, { id: uuid(), element_id: c3, qty: 1.6 }] },
    ],
  })]));
}
