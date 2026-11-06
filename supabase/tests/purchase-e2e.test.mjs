// Purchase-flow fixes from the end-to-end run (migration 20261102000021_e2e_purchase_fixes.sql). Applies ALL
// migrations + seed in PGlite with the Supabase stubs used by the other suites.
//
// Scenario: procurement sends an RFQ and records quotations; once the minimum is reached the RFQ appears in
// management's approvals inbox ('rfq_award') and management is notified; closing for quotes notifies too;
// after the award the item disappears. Store keeper / procurement / non-members never get the item.
//
//   node supabase/tests/purchase-e2e.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const STUBS = readFileSync(join(root, 'tests', 'run.mjs'), 'utf8').match(/const STUBS = `([\s\S]*?)`;/)[1];
const GRANTS = `
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant execute on all functions in schema auth to authenticated, service_role;
`;

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ✓', msg); } else { failed++; console.log('  ✗', msg); } };
async function as(userId, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', '', false)`, [userId ?? '']);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rpc = async (name, p) => (await db.query(`select public.${name}($1::jsonb) as r`, [JSON.stringify(p)])).rows[0].r;
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const inbox = (u, P) => as(u, async () => (await db.query(`select kind, number, title from v_my_approvals where kind = 'rfq_award' and project_id = $1`, [P])).rows);
const notes = async (u, like) => (await one(`select count(*)::int n from notifications where user_id = $1 and title like $2`, [u, like])).n;

async function expectErr(pr, msg) { try { await pr; ok(false, msg + ' (no error)'); } catch (e) { ok(true, `${msg} → "${e.message}"`); } }

async function main() {
  console.log('Applying migrations…');
  await db.exec(STUBS);
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);

  const U = {};
  for (const role of ['admin', 'coordinator', 'manager', 'procurement', 'store_keeper', 'office_engineer']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role }, { role }]);
  }
  const outsiderMgr = uuid();
  await db.query(`insert into auth.users (id, email, raw_app_meta_data) values ($1, 'other-mgr@test.et', '{"role":"manager"}')`, [outsiderMgr]);
  const P = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'TWR', 'Tower')`, [P]);
    for (const r of Object.keys(U).filter((r) => r !== 'admin')) await db.query(`insert into project_members values ($1, $2)`, [P, U[r]]);
  });
  const CEM = (await one(`select id from material_specs limit 1`)).id;
  const S = [uuid(), uuid(), uuid()];
  for (const [i, s] of S.entries()) await db.query(`insert into suppliers (id, name) values ($1, $2)`, [s, `Supplier ${i + 1}`]);

  console.log('\nRFQ to award in the management inbox');
  const RFQ = uuid(), RL = uuid();
  await as(U.procurement, () => rpc('save_rfq', { op_id: uuid(), id: RFQ, project_id: P, number: 'TWR-RFQ-T-0001', title: 'Cement for the mat', send: true,
    lines: [{ id: RL, material_spec_id: CEM, qty: 450 }], suppliers: S.map((s) => ({ id: uuid(), supplier_id: s, sent_via: 'phone' })) }));
  const QL = [uuid(), uuid(), uuid()];
  const quote = (i, price) => as(U.procurement, () => rpc('record_quotation', { op_id: uuid(), id: uuid(), rfq_id: RFQ, supplier_id: S[i],
    number: `TWR-QT-T-000${i + 1}`, quote_date: '2026-11-03', delivery_days: 5, lines: [{ id: QL[i], rfq_line_id: RL, unit_price: price }] }));
  await quote(0, 1850); await quote(1, 1780);
  ok((await inbox(U.coordinator, P)).length === 0, 'below the minimum (2 of 3) nothing to award yet');
  ok(await notes(U.coordinator, 'RFQ % ready to award') === 0, 'and no notification yet');
  await quote(2, 1900);
  const ib = await inbox(U.coordinator, P);
  ok(ib.length === 1 && ib[0].number === 'TWR-RFQ-T-0001' && /3 of 3/.test(ib[0].title), `coordinator inbox: "${ib[0]?.title}"`);
  ok((await inbox(U.manager, P)).length === 1, 'manager inbox has it too');
  ok((await inbox(U.admin, P)).length === 1, 'admin inbox has it');
  ok((await inbox(U.procurement, P)).length === 0 && (await inbox(U.store_keeper, P)).length === 0, 'procurement / store keeper do not award');
  ok((await inbox(outsiderMgr, P)).length === 0, 'a manager of another project does not see it');
  ok(await notes(U.coordinator, 'RFQ TWR-RFQ-T-0001 ready to award') === 1 && await notes(U.manager, 'RFQ TWR-RFQ-T-0001 ready to award') === 1,
    'coordinator and manager notified when the minimum is reached');
  ok(await notes(U.procurement, 'RFQ % ready to award') === 0, 'the buyer who recorded the quotes is not notified');

  await as(U.coordinator, () => rpc('award_rfq', { op_id: uuid(), rfq_id: RFQ, awards: [{ id: uuid(), rfq_line_id: RL, quotation_line_id: QL[1] }] }));
  ok((await inbox(U.coordinator, P)).length === 0, 'after the award the item leaves the inbox');

  console.log('\nClosed for quotes with fewer than the minimum');
  const R2 = uuid(), RL2 = uuid(), QL2 = uuid();
  await as(U.procurement, () => rpc('save_rfq', { op_id: uuid(), id: R2, project_id: P, number: 'TWR-RFQ-T-0002', title: 'Plywood', send: true,
    lines: [{ id: RL2, material_spec_id: CEM, qty: 120 }], suppliers: S.map((s) => ({ id: uuid(), supplier_id: s, sent_via: 'phone' })) }));
  await as(U.procurement, () => rpc('record_quotation', { op_id: uuid(), id: uuid(), rfq_id: R2, supplier_id: S[0], number: 'TWR-QT-T-0004',
    quote_date: '2026-11-03', lines: [{ id: QL2, rfq_line_id: RL2, unit_price: 2750 }] }));
  ok((await inbox(U.manager, P)).length === 0, '1 of 3 quotes and still open → not yet in the inbox');
  await as(U.procurement, () => rpc('rfq_action', { op_id: uuid(), rfq_id: R2, action: 'close' }));
  const ib2 = await inbox(U.manager, P);
  ok(ib2.length === 1 && /1 of 3/.test(ib2[0].title), `closed for quotes → in the inbox ("${ib2[0]?.title}")`);
  ok(await notes(U.manager, 'RFQ TWR-RFQ-T-0002 ready to award') === 1, 'manager notified on close');
  await as(U.procurement, () => rpc('rfq_action', { op_id: uuid(), rfq_id: R2, action: 'cancel', comment: 'Re-tender' }));
  ok((await inbox(U.manager, P)).length === 0, 'cancelled RFQ leaves the inbox');

  console.log('\nPOs created by the award belong to the buyer');
  const ST = uuid();
  await db.query(`insert into stores (id, project_id, name, store_type) values ($1, $2, 'Main store', 'main')`, [ST, P]);
  const R3 = uuid(), RL3 = uuid(), Q3 = [uuid(), uuid(), uuid()];
  await as(U.procurement, () => rpc('save_rfq', { op_id: uuid(), id: R3, project_id: P, number: 'TWR-RFQ-T-0003', title: 'Rebar Ø16', send: true,
    delivery_store_id: ST, lines: [{ id: RL3, material_spec_id: CEM, qty: 24000 }], suppliers: S.map((s) => ({ id: uuid(), supplier_id: s, sent_via: 'phone' })) }));
  for (const [i, pr] of [116, 119, 117].entries()) {
    await as(U.procurement, () => rpc('record_quotation', { op_id: uuid(), id: uuid(), rfq_id: R3, supplier_id: S[i], number: `TWR-QT-T-01${i}`,
      quote_date: '2026-11-03', delivery_days: 5, lines: [{ id: Q3[i], rfq_line_id: RL3, unit_price: pr }] }));
  }
  const PO = uuid();
  await as(U.coordinator, () => rpc('award_rfq', { op_id: uuid(), rfq_id: R3, create_po: true, pos: [{ id: PO, number: 'TWR-PO-T-0001', supplier_id: S[0] }],
    awards: [{ id: uuid(), rfq_line_id: RL3, quotation_line_id: Q3[0] }] }));
  const po = await one(`select created_by, status, approved_by from purchase_orders where id = $1`, [PO]);
  ok(po.created_by === U.procurement, 'PO from the award is authored by the buyer, not the awarding coordinator');
  ok(['approved', 'submitted'].includes(po.status), `the award approves the PO within the awarder's PO limit, else submits it (status ${po.status})`);
  ok((await one(`select actor from po_events where po_id = $1 and action = 'create_from_award'`, [PO])).actor === U.coordinator, 'the award event still names the coordinator');
  ok(await notes(U.store_keeper, 'Incoming order: PO TWR-PO-T-0001%') === 1, 'store keeper is told an order is coming as soon as it is awarded');
  if (po.status === 'submitted') {
    ok(await notes(U.manager, 'PO TWR-PO-T-0001 awaiting approval') === 1, 'above the limit → manager asked to approve');
    const ap = await as(U.manager, () => rpc('po_action', { op_id: uuid(), po_id: PO, action: 'approve' }));
    ok(ap.status === 'approved', 'manager approves it');
  } else {
    ok(po.approved_by === U.coordinator && await notes(U.procurement, 'PO TWR-PO-T-0001 approved with the award%') === 1,
      'approved with the award; buyer told to send it');
  }
  const kinds = async (u) => as(u, async () => (await db.query(`select kind from v_my_approvals where entity_id = $1`, [PO])).rows.map((r) => r.kind));
  ok((await kinds(U.procurement)).includes('po_send'), 'procurement inbox: send the approved PO to the supplier');
  await as(U.procurement, () => rpc('po_action', { op_id: uuid(), po_id: PO, action: 'send' }));
  ok(!(await kinds(U.procurement)).includes('po_send'), 'sent → leaves the procurement inbox');
  await db.query(`update purchase_orders set eta = app.local_date(now()) where id = $1`, [PO]);
  ok((await kinds(U.store_keeper)).includes('po_receive'), 'due today → store keeper inbox: receive it');
  const pl = await one(`select id, qty from po_lines where po_id = $1`, [PO]);
  await as(U.store_keeper, () => rpc('post_grn', { op_id: uuid(), id: uuid(), project_id: P, number: 'TWR-GRN-T-0001', store_id: ST, po_id: PO,
    received_at: new Date().toISOString(), lines: [{ id: uuid(), material_spec_id: CEM, po_line_id: pl.id, qty_delivered: 10000 }] }));
  const bal = await as(U.store_keeper, () => one(`select coalesce(sum(qty), 0) q from v_stock_balance where store_id = $1 and material_spec_id = $2`, [ST, CEM]));
  ok(Number(bal.q) === 10000, `received against the PO without a delivery notice → stock shows ${bal.q}`);
  ok((await one(`select status from purchase_orders where id = $1`, [PO])).status === 'partially_received', 'PO partially received');
  ok((await kinds(U.store_keeper)).includes('po_receive'), 'balance still due → stays in the store keeper inbox');
  await as(U.store_keeper, () => rpc('post_grn', { op_id: uuid(), id: uuid(), project_id: P, number: 'TWR-GRN-T-0002', store_id: ST, po_id: PO,
    received_at: new Date().toISOString(), lines: [{ id: uuid(), material_spec_id: CEM, po_line_id: pl.id, qty_delivered: Number(pl.qty) - 10000 }] }));
  ok(!(await kinds(U.store_keeper)).includes('po_receive') && (await one(`select status from purchase_orders where id = $1`, [PO])).status === 'received',
    'fully received → PO received, inbox item gone');
  const retry = { op_id: uuid(), rfq_id: R3, create_po: true, pos: [{ id: uuid(), number: 'X', supplier_id: S[0] }], awards: [] };
  await expectErr(as(U.coordinator, () => rpc('award_rfq', retry)), 'awarding an awarded RFQ again is refused');

  console.log('\nAward above the awarder\'s PO limit');
  await db.query(`insert into approval_limits (project_id, role, max_value, doc_type) values ($1, 'coordinator', 1000, 'po')`, [P]);
  const R4 = uuid(), RL4 = uuid(), Q4 = uuid(), PO4 = uuid();
  await as(U.procurement, () => rpc('save_rfq', { op_id: uuid(), id: R4, project_id: P, number: 'TWR-RFQ-T-0004', title: 'Cement top-up', send: true,
    delivery_store_id: ST, lines: [{ id: RL4, material_spec_id: CEM, qty: 100 }], suppliers: [{ id: uuid(), supplier_id: S[1], sent_via: 'phone' }] }));
  await as(U.procurement, () => rpc('record_quotation', { op_id: uuid(), id: uuid(), rfq_id: R4, supplier_id: S[1], number: 'TWR-QT-T-0040',
    quote_date: '2026-11-03', delivery_days: 3, lines: [{ id: Q4, rfq_line_id: RL4, unit_price: 2800 }] }));
  await as(U.coordinator, () => rpc('award_rfq', { op_id: uuid(), rfq_id: R4, create_po: true, override_reason: 'Single source',
    pos: [{ id: PO4, number: 'TWR-PO-T-0004', supplier_id: S[1] }], awards: [{ id: uuid(), rfq_line_id: RL4, quotation_line_id: Q4 }] }));
  ok((await one(`select status from purchase_orders where id = $1`, [PO4])).status === 'submitted', 'above the limit → submitted, not approved');
  ok(await notes(U.manager, 'PO TWR-PO-T-0004 awaiting approval') === 1, 'manager asked to approve it');
  ok(!(await kinds(U.procurement)).includes('po_send') && !(await as(U.procurement, async () => (await db.query(`select 1 from v_my_approvals where entity_id = $1`, [PO4])).rows.length)),
    'not in the procurement send queue until approved');
  await as(U.manager, () => rpc('po_action', { op_id: uuid(), po_id: PO4, action: 'approve' }));
  ok(await as(U.procurement, async () => (await db.query(`select 1 from v_my_approvals where entity_id = $1 and kind = 'po_send'`, [PO4])).rows.length) === 1,
    'approved by the manager → procurement sends it');

  console.log('\nThe rest of the inbox still works');
  const base = await as(U.coordinator, () => one(`select count(*)::int n from v_my_approvals`));
  ok(Number.isInteger(base.n), `v_my_approvals still answers (${base.n} rows)`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error('FATAL:', e.message, e.where ?? ''); process.exit(1); });
