// Material costing test (migration 20261103000020_material_costing.sql): materials are cost when USED.
// Moving weighted average per project × spec; receipts at PO price (standard price without PO); issues, returns,
// wastage, count variances = actual cost; transfers neutral; reversals at the reversed cost; quarantine not valued.
// Hand-checked sequence (cement, ETB/qtl):
//   GRN1 +100 @1000 (PO)             pool 100 / 100,000 / 1000      (+4 rejected → quarantine, no value)
//   GRN2  +50 @1150 (PO)             pool 150 / 157,500 / 1050
//   MIV-A −60 @1050 = 63,000 used    pool  90 /  94,500 / 1050
//   transfer S1→S2 30 @1050          pool  90 /  94,500 (neutral)
//   MRN   +10 @1050 = −10,500 used   pool 100 / 105,000 / 1050
//   opening +20 @900 (standard)      pool 120 / 123,000 / 1025
//   MIV-B −10 @1025 = 10,250 used    pool 110 / 112,750 / 1025
//   wastage −5 @1025 = 5,125 used    pool 105 / 107,625 / 1025
//   count +2 @1025 = −2,050 used     pool 107 / 109,675 / 1025
//   reverse MIV-B +10 @1025          pool 117 / 119,925 / 1025
//   used = 63,000 − 10,500 + 10,250 + 5,125 − 2,050 − 10,250 = 55,575;  receipts 175,500 − used 55,575 = 119,925 on hand.
//
//   node supabase/tests/material-costing.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const MINE = '20261103000020_material_costing.sql';
const OTHERS = ['20261030000001_mr_flow_enums.sql', '20261030000002_mr_flows.sql', '20261030000004_lookahead.sql'];

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text, phone text,
  raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
`;
const GRANTS = `
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant execute on all functions in schema auth to authenticated, service_role;
`;

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ✓', msg); } else { failed++; console.log('  ✗', msg); } };
const near = (a, b, eps = 0.01) => a != null && Math.abs(Number(a) - b) <= eps;
async function as(userId, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', '', false)`, [userId ?? '']);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rpc = async (name, p) => (await db.query(`select public.${name}($1::jsonb) as r`, [JSON.stringify(p)])).rows[0].r;
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
async function expectError(promise, pattern, msg) {
  try { await promise; ok(false, `${msg} (no error raised)`); }
  catch (e) { ok(pattern.test(e.message), `${msg} → "${e.message}"`); }
}
const n = (v) => (v == null ? null : Number(v));

async function main() {
  console.log('Applying migrations…');
  await db.exec(STUBS);
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
  }
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);

  const U = {};
  for (const role of ['admin', 'manager', 'site_engineer', 'store_keeper']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role }, { role }]);
  }
  const P = uuid(), B = uuid(), LV = uuid(), S1 = uuid(), S2 = uuid(), E1 = uuid(), BQ = uuid(), SUP = uuid();
  await db.query(`insert into projects (id, code, name) values ($1, 'MC', 'Costing test')`, [P]);
  for (const r of ['manager', 'site_engineer', 'store_keeper']) await db.query(`insert into project_members (project_id, user_id) values ($1, $2)`, [P, U[r]]);
  await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'A', 'Block A')`, [B, P]);
  await db.query(`insert into levels (id, project_id, block_id, code, name) values ($1, $2, $3, 'G', 'Ground')`, [LV, P, B]);
  await db.query(`insert into stores (id, project_id, name, store_type) values ($1, $2, 'Main store', 'main'), ($3, $2, 'Site store', 'satellite')`, [S1, P, S2]);
  await db.query(`insert into elements (id, project_id, block_id, level_id, code, element_type) values ($1, $2, $3, $4, 'F1', 'footing')`, [E1, P, B, LV]);
  await db.query(`insert into boq_items (id, project_id, item_no, description, unit, quantity) values ($1, $2, '4.1', 'Concrete C-25 in footings', 'm3', 100)`, [BQ, P]);
  const CEM = (await one(`select s.id from material_specs s join materials m on m.id = s.material_id where m.name = 'Cement' and s.grade = 'OPC 42.5'`)).id;
  await db.query(`insert into element_takeoffs (project_id, element_id, material_spec_id, planned_qty, boq_item_id) values ($1, $2, $3, 300, $4)`, [P, E1, CEM, BQ]);
  await db.query(`insert into spec_prices (material_spec_id, unit_price) values ($1, 900) on conflict (material_spec_id) do update set unit_price = 900`, [CEM]);
  await db.query(`insert into suppliers (id, name) values ($1, 'Abyssinia Cement')`, [SUP]);

  // approved MR line tied to the BoQ item (so receipts / issues carry it)
  const MR = uuid(), ML = uuid();
  await as(U.site_engineer, () => rpc('save_mr', { op_id: uuid(), id: MR, project_id: P, number: 'MC-MR-1', block_id: B, required_date: '2026-11-20',
    delivery_location: 'Main store', store_id: S1, submit: false,
    lines: [{ id: ML, material_spec_id: CEM, qty: 160, elements: [{ id: uuid(), element_id: E1, qty: 160 }] }] }));
  await db.query(`update mr_lines set boq_item_id = $2 where id = $1`, [ML, BQ]);

  // PO with two lines at different prices
  const PO = uuid(), PL1 = uuid(), PL2 = uuid();
  await db.query(`insert into purchase_orders (id, project_id, number, supplier_id, delivery_store_id, status) values ($1, $2, 'MC-PO-1', $3, $4, 'sent')`, [PO, P, SUP, S1]);
  await db.query(`insert into po_lines (id, po_id, project_id, line_no, material_spec_id, qty, mr_line_id) values ($1, $3, $4, 1, $5, 120, $6), ($2, $3, $4, 2, $5, 50, $6)`, [PL1, PL2, PO, P, CEM, ML]);
  await db.query(`insert into po_line_prices (po_line_id, project_id, unit_price) values ($1, $3, 1000), ($2, $3, 1150)`, [PL1, PL2, P]);

  const at = (d) => `2026-10-${String(d).padStart(2, '0')}T08:00:00Z`;
  const ledger = (store, qty, status, txn, docType, doc, line, el, mrl, d, rev = null) => db.query(
    `select app.post_ledger($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, null, $13::timestamptz, $14)`,
    [P, store, CEM, qty, status, txn, docType, doc, `${docType.toUpperCase()}-${String(doc).slice(0, 4)}`, line, el, mrl, at(d), rev]);
  const grn = async (n, poLine, acc, rej, d) => {
    const G = uuid(), GL = uuid();
    await db.query(`insert into grns (id, project_id, number, store_id, received_at, created_by, status) values ($1, $2, $3, $4, $5, $6, 'posted')`, [G, P, `MC-GRN-${n}`, S1, at(d), U.store_keeper]);
    await db.query(`insert into grn_lines (id, grn_id, project_id, line_no, material_spec_id, qty_delivered, qty_accepted, qty_rejected, po_line_id, mr_line_id) values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)`,
      [GL, G, P, CEM, acc + rej, acc, rej, poLine, ML]);
    await db.query(`update po_lines set qty_received = qty_received + $2, qty_accepted = qty_accepted + $3, qty_rejected = qty_rejected + $4 where id = $1`, [poLine, acc + rej, acc, rej]);
    await ledger(S1, acc, 'available', 'grn', 'grn', G, GL, null, ML, d);
    if (rej) await ledger(S1, rej, 'quarantine', 'grn', 'grn', G, GL, null, ML, d);
    return G;
  };
  const cost = async () => one(`select qty, value, avg_cost from stock_cost_pool where project_id = $1 and material_spec_id = $2`, [P, CEM]);
  const last = async () => one(`select c.* from stock_ledger_costs c join stock_ledger l on l.id = c.ledger_id where l.project_id = $1 order by l.created_at desc, c.created_at desc limit 1`, [P]);
  const pool = async (q, v, a, msg) => { const c = await cost(); ok(near(c.qty, q, 0.001) && near(c.value, v) && near(c.avg_cost, a, 0.0001), `${msg} → pool ${c.qty} / ${c.value} / ${c.avg_cost}`); };

  console.log('\nReceipts at PO price');
  await grn(1, PL1, 100, 4, 1);
  const q1 = await one(`select count(*)::int n, sum(value) v from stock_ledger_costs where cost_kind = 'quarantine' and project_id = $1`, [P]);
  ok(q1.n === 1 && Number(q1.v) === 0, 'rejected 4 qtl go to quarantine without value');
  await pool(100, 100000, 1000, 'GRN1 100 @ PO 1000');
  await grn(2, PL2, 50, 0, 2);
  await pool(150, 157500, 1050, 'GRN2 50 @ PO 1150 → average 1050');

  console.log('\nIssue, transfer, return, opening, wastage, count, reversal');
  const MIVA = uuid(), MIVB = uuid(), TR = uuid(), MRN = uuid(), OPEN = uuid(), WA = uuid(), CNT = uuid();
  await ledger(S1, -60, 'available', 'miv', 'miv', MIVA, null, E1, ML, 3);
  let c = await last(); ok(c.cost_kind === 'issue' && c.is_consumption && near(c.unit_cost, 1050) && near(c.value, -63000), `MIV-A 60 @1050 = ${c.value}`);
  await pool(90, 94500, 1050, 'after MIV-A');
  await ledger(S1, -30, 'available', 'transfer_out', 'transfer', TR, null, null, null, 4);
  await ledger(S2, 30, 'available', 'transfer_in', 'transfer', TR, null, null, null, 4);
  await pool(90, 94500, 1050, 'transfer S1→S2 is cost-neutral');
  await ledger(S2, 10, 'available', 'mrn', 'mrn', MRN, null, E1, null, 5);
  c = await last(); ok(c.cost_kind === 'return' && near(c.value, 10500), `MRN 10 credited @1050 = ${c.value}`);
  await pool(100, 105000, 1050, 'after return');
  await ledger(S1, 20, 'available', 'opening', 'opening', OPEN, null, null, null, 6);
  await pool(120, 123000, 1025, 'opening 20 @ standard 900 → average 1025');
  await ledger(S1, -10, 'available', 'miv', 'miv', MIVB, null, E1, ML, 7);
  await pool(110, 112750, 1025, 'MIV-B 10 @1025');
  const MIVB_ROW = (await one(`select id from stock_ledger where doc_id = $1`, [MIVB])).id;
  await db.query(`insert into adjustments (id, project_id, number, store_id, adj_type, requested_by, status) values ($1, $3, 'MC-ADJ-1', $4, 'wastage', $5, 'approved'), ($2, $3, 'MC-ADJ-2', $4, 'count_variance', $5, 'approved')`, [WA, CNT, P, S1, U.store_keeper]);
  await ledger(S1, -5, 'available', 'adjustment', 'adjustment', WA, null, null, null, 8);
  c = await last(); ok(c.cost_kind === 'wastage' && c.is_consumption && near(c.value, -5125), `wastage 5 @1025 = ${c.value}`);
  await ledger(S1, 2, 'available', 'adjustment', 'adjustment', CNT, null, null, null, 9);
  c = await last(); ok(c.cost_kind === 'count' && near(c.value, 2050), `count gain 2 @1025 = ${c.value}`);
  await pool(107, 109675, 1025, 'after wastage and count');
  await ledger(S1, 10, 'available', 'reversal', 'miv', MIVB, null, E1, ML, 10, MIVB_ROW);
  c = await last(); ok(c.cost_kind === 'issue' && near(c.unit_cost, 1025) && near(c.value, 10250), 'reversal of MIV-B carries its own cost (+10,250)');
  await pool(117, 119925, 1025, 'after reversal');

  console.log('\nActual cost = consumption, not purchases');
  const ac = await one(`select sum(amount) a from app.material_alloc($1)`, [P]);
  ok(near(ac.a, 55575), `EVM material AC = ${ac.a} (55,575 used; 175,500 received is NOT cost)`);
  const ac2 = await one(`select sum(amount) a from app.ac_rows($1, '2026-12-31') where source = 'material_issue'`, [P]);
  ok(near(ac2.a, 55575), `ac_rows material = ${ac2.a}`);

  // budget line on the BoQ item
  await db.query(`insert into budget_lines (id, project_id, boq_item_id, budget_amount, description) values (gen_random_uuid(), $1, $2, 200000, 'Footing concrete materials')`, [P, BQ]);

  console.log('\nPrice roles see money, others do not');
  const mgr = await as(U.manager, async () => ({
    inv: await all(`select store_id, qty, value, avg_cost from v_inventory_value where project_id = $1`, [P]),
    cc: await one(`select * from v_cost_control where project_id = $1`, [P]),
    mc: await all(`select * from v_material_cost where project_id = $1`, [P]),
    led: await one(`select count(*)::int n from v_stock_ledger_value where project_id = $1`, [P]),
  }));
  const s1 = mgr.inv.find((r) => r.store_id === S1), s2 = mgr.inv.find((r) => r.store_id === S2);
  ok(s1 && near(s1.qty, 77, 0.001) && near(s1.value, 78925) && s2 && near(s2.qty, 40, 0.001) && near(s2.value, 41000),
    `inventory: main store 77 = ${s1?.value}, site store 40 = ${s2?.value} (total 119,925)`);
  ok(mgr.cc && near(mgr.cc.received, 157500) && near(mgr.cc.used, 52500) && near(mgr.cc.issued, 52500) && near(mgr.cc.remaining, 147500),
    `cost control BoQ 4.1: received ${mgr.cc?.received}, used ${mgr.cc?.used}, remaining ${mgr.cc?.remaining} (budget − used)`);
  ok(near(mgr.cc?.pct_used, 26.3, 0.05), `pct used = used / budget = ${mgr.cc?.pct_used}%`);
  ok(near(mgr.cc?.committed, 20000) && near(mgr.cc?.remaining_uncommitted, 200000 - 157500 - 20000),
    `committed (open PO 20 @1000) ${mgr.cc?.committed}; free to buy ${mgr.cc?.remaining_uncommitted}`);
  const mcAll = mgr.mc.reduce((s, r) => s + Number(r.used_value), 0), mcW = mgr.mc.reduce((s, r) => s + Number(r.wastage_qty), 0);
  ok(near(mcAll, 55575) && near(mcW, 5, 0.001), `material actuals: used ${mcAll}, wastage ${mcW} qtl (shown without budget lines)`);
  ok(mgr.led.n >= 11, `valued ledger rows visible to the manager (${mgr.led.n})`);
  const se = await as(U.site_engineer, async () => ({
    costs: await one(`select count(*)::int n from stock_ledger_costs`),
    pool: await one(`select count(*)::int n from stock_cost_pool`),
    inv: await one(`select count(*)::int n from v_inventory_value`),
    mc: await one(`select count(*)::int n from v_material_cost`),
    led: await one(`select count(*)::int n from stock_ledger where project_id = $1`, [P]),
  }));
  ok(se.costs.n === 0 && se.pool.n === 0 && se.inv.n === 0 && se.mc.n === 0, 'site engineer sees no costs, pool, inventory value or material cost');
  ok(se.led.n >= 12, 'site engineer still sees the quantity ledger');

  console.log('\nBack-fill and idempotence');
  const before = await one(`select count(*)::int n from stock_ledger_costs`);
  await db.exec(readFileSync(join(root, 'migrations', MINE), 'utf8'));
  const after = await one(`select count(*)::int n from stock_ledger_costs`);
  await pool(117, 119925, 1025, 're-running the migration changes nothing');
  ok(before.n === after.n, `no duplicate cost rows (${after.n})`);
  const unvalued = await one(`select count(*)::int n from stock_ledger l where not exists (select 1 from stock_ledger_costs c where c.ledger_id = l.id)`);
  ok(unvalued.n === 0, 'every ledger row has a cost row');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
