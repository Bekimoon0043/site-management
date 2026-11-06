// Materials roles test (migrations 20261105000050–53): store keeper inbox de-duplication, tools register,
// supplier performance scorecard, shelf life / FIFO stock ageing.
//
//   node supabase/tests/materials-roles.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const MINE = readdirSync(join(root, 'migrations')).filter((f) => f >= '20261105000050' && f < '20261105000060');

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
async function as(userId, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', '', false)`, [userId ?? '']);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rpc = async (name, p) => (await db.query(`select public.${name}($1::jsonb) as r`, [JSON.stringify({ op_id: uuid(), ...p })])).rows[0].r;
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
async function expectError(promise, pattern, msg) {
  try { await promise; ok(false, `${msg} (no error raised)`); }
  catch (e) { ok(pattern.test(e.message), `${msg} → "${e.message}"`); }
}
const n = (v) => (v == null ? null : Number(v));
const inbox = (u, kind) => as(u, () => all(`select * from v_my_approvals where kind = $1`, [kind]));

async function main() {
  console.log('Applying migrations…');
  await db.exec(STUBS);
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    try { await db.exec(readFileSync(join(root, 'migrations', f), 'utf8')); }
    catch (e) {
      // other agents' 5 Nov migrations may be mid-edit; ours and everything before must apply
      if (MINE.includes(f) || f < '20261105') throw new Error(`${f}: ${e.message}`);
      console.log('  SKIPPED (parallel work, failed to apply)', f, '—', e.message);
    }
  }
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);
  const today = (await one(`select app.local_date(now()) d`)).d;
  const day = (k) => new Date(new Date(today).getTime() + k * 86400000).toISOString().slice(0, 10);

  const U = {};
  for (const role of ['admin', 'store_keeper', 'procurement', 'coordinator', 'manager', 'site_engineer']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role.replace('_', ' ') }, { role }]);
  }
  const outsider = uuid();
  await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, 'other@test.et', '{"full_name":"Other"}', '{"role":"store_keeper"}')`, [outsider]);
  const P = uuid(), P2 = uuid(), S = uuid();
  await db.query(`insert into projects (id, code, name) values ($1, 'TWR', 'Tower'), ($2, 'OTH', 'Other site')`, [P, P2]);
  for (const r of Object.keys(U).filter((r) => r !== 'admin')) await db.query(`insert into project_members values ($1, $2)`, [P, U[r]]);
  await db.query(`insert into project_members values ($1, $2)`, [P2, outsider]);
  await db.query(`insert into stores (id, project_id, name) values ($1, $2, 'Main store')`, [S, P]);
  const M1 = uuid(), M2 = uuid(), C = uuid(), A = uuid(), X = uuid(), Y = uuid();
  await db.query(`insert into materials (id, category, name) values ($1, 'Cement', 'OPC cement'), ($2, 'Chemicals', 'Plasticiser admixture')`, [M1, M2]);
  await db.query(`insert into material_specs (id, material_id, grade, uom) values ($1, $2, '42.5R', 'bag'), ($3, $4, '', 'l')`, [C, M1, A, M2]);
  await db.query(`insert into suppliers (id, name) values ($1, 'Habesha Cement Trading'), ($2, 'Addis Chemicals')`, [X, Y]);

  // ===================================================================
  console.log('\nMigrations are re-runnable; cement gets a 90-day shelf life');
  for (const f of MINE) await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
  for (const f of MINE) await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
  ok(MINE.length === 4, `four migrations re-applied twice (${MINE.join(', ')})`);
  const sl = await all(`select id, shelf_life_days from material_specs where id in ($1, $2)`, [C, A]);
  ok(n(sl.find((r) => r.id === C).shelf_life_days) === 90 && sl.find((r) => r.id === A).shelf_life_days == null, 'cement 90 days, admixture no default');

  // purchase orders + receipts (direct inserts; posting is covered by the procurement tests)
  const po = async (sup, status, expected, number) => {
    const id = uuid();
    await db.query(`insert into purchase_orders (id, project_id, number, supplier_id, delivery_store_id, status, expected_date, eta, created_by)
                    values ($1, $2, $3, $4, $5, $6, $7, $7, $8)`, [id, P, number, sup, S, status, expected, U.procurement]);
    return id;
  };
  const grn = async (poId, spec, received, delivered, accepted, number) => {
    const g = uuid(), l = uuid();
    await db.query(`insert into grns (id, project_id, number, store_id, po_id, supplier_id, received_at, created_by)
                    values ($1, $2, $3, $4, $5, (select supplier_id from purchase_orders where id = $5), ($6::date + time '07:00') at time zone 'UTC', $7)`,
      [g, P, number, S, poId, received, U.store_keeper]);
    await db.query(`insert into grn_lines (id, grn_id, project_id, line_no, material_spec_id, qty_delivered, qty_accepted, qty_rejected, inspection_result)
                    values ($1, $2, $3, 1, $4, $5, $6, $7, $8)`, [l, g, P, spec, delivered, accepted, delivered - accepted, delivered > accepted ? 'conditional' : 'pass']);
    await db.query(`insert into stock_ledger (project_id, store_id, material_spec_id, qty, txn_type, doc_type, doc_id, doc_number, doc_line_id, txn_at, created_by)
                    values ($1, $2, $3, $4, 'grn', 'grn', $5, $6, $7, ($8::date + time '07:00') at time zone 'UTC', $9)`,
      [P, S, spec, accepted, g, number, l, received, U.store_keeper]);
    return { g, l };
  };
  const PO1 = await po(X, 'received', day(-100), 'PO-1');
  const PO2 = await po(X, 'received', day(-25), 'PO-2');
  const PO3 = await po(Y, 'received', day(-10), 'PO-3');
  const G1 = await grn(PO1, C, day(-100), 100, 100, 'GRN-1');
  const G2 = await grn(PO2, C, day(-20), 55, 50, 'GRN-2');
  await grn(PO3, A, day(-12), 10, 10, 'GRN-3');
  const MIV1 = uuid(), ML1 = uuid();
  await db.query(`insert into stock_ledger (id, project_id, store_id, material_spec_id, qty, txn_type, doc_type, doc_id, doc_number, txn_at, created_by)
                  values ($1, $2, $3, $4, -60, 'miv', 'miv', $5, 'MIV-1', now() - interval '5 days', $6)`, [ML1, P, S, C, MIV1, U.store_keeper]);

  // ===================================================================
  console.log('\nStock ageing (FIFO lots)');
  const lots = await as(U.store_keeper, () => all(`select * from v_stock_lots where material_spec_id = $1 order by received_on`, [C]));
  ok(lots.length === 2 && n(lots[0].remaining_qty) === 40 && n(lots[1].remaining_qty) === 50,
    `60 bags issued come out of the oldest receipt: GRN-1 40 left, GRN-2 50 left (${lots.map((l) => `${l.doc_number} ${l.remaining_qty}`).join(', ')})`);
  ok(lots[0].expiry_status === 'expired' && lots[0].age_days === 100 && lots[1].expiry_status === 'ok' && lots[1].days_to_expiry === 70,
    `GRN-1 is 100 days old → expired; GRN-2 has 70 days left (${lots[0].expiry_status}/${lots[1].days_to_expiry})`);
  const adm = await as(U.store_keeper, () => one(`select * from v_stock_lots where material_spec_id = $1`, [A]));
  ok(adm.expiry_status === 'no_expiry', 'admixture without shelf life or pack date: no expiry');
  let ex = await inbox(U.store_keeper, 'stock_expiry');
  ok(ex.length === 1 && /^Expired: OPC cement/.test(ex[0].title) && /40 bag/.test(ex[0].title) && ex[0].is_urgent, `store keeper inbox: "${ex[0]?.title}"`);
  ok((await inbox(U.site_engineer, 'stock_expiry')).length === 0, 'not in the site engineer inbox');
  await expectError(as(U.site_engineer, () => rpc('set_lot_expiry', { grn_line_id: G2.l, expiry_date: day(5) })), /not allowed/, 'site engineer cannot set an expiry date');
  await as(U.store_keeper, () => rpc('set_lot_expiry', { grn_line_id: G2.l, expiry_date: day(5) }));
  const l2 = await as(U.store_keeper, () => one(`select * from v_stock_lots where grn_line_id = $1`, [G2.l]));
  ok(l2.expiry_status === 'expiring' && l2.days_to_expiry === 5, 'printed expiry date on GRN-2 → expiring in 5 days');
  await as(U.store_keeper, () => rpc('set_lot_expiry', { grn_line_id: G1.l, expiry_date: day(400) }));
  ex = await inbox(U.store_keeper, 'stock_expiry');
  ok(ex.length === 1 && /^Use first: /.test(ex[0].title) && ex[0].status === 'expiring', `after correcting GRN-1: "${ex[0]?.title}"`);
  ok((await as(outsider, () => all(`select * from v_stock_lots`))).length === 0, 'member of another project sees no lots');
  await db.query(`insert into stock_ledger (project_id, store_id, material_spec_id, qty, txn_type, doc_type, doc_id, doc_number, doc_line_id, txn_at, created_by, reversal_of)
                  values ($1, $2, $3, 60, 'reversal', 'miv', $4, 'MIV-1', null, now(), $5, $6)`, [P, S, C, MIV1, U.store_keeper, ML1]);
  const restored = await as(U.store_keeper, () => all(`select * from v_stock_lots where material_spec_id = $1 order by received_on`, [C]));
  ok(restored.length === 2 && n(restored[0].remaining_qty) === 100 && n(restored[1].remaining_qty) === 50,
    `reversing MIV-1 restores the original FIFO lots, not a new lot (${restored.map((l) => `${l.doc_number} ${l.remaining_qty}`).join(', ')})`);
  await db.query(`insert into stock_ledger (project_id, store_id, material_spec_id, qty, txn_type, doc_type, doc_id, doc_number, doc_line_id, txn_at, created_by)
                  values ($1, $2, $3, 2, 'mrn', 'mrn', gen_random_uuid(), 'MRN-1', gen_random_uuid(), now(), $4)`, [P, S, A, U.store_keeper]);
  const ret = await as(U.store_keeper, () => one(`select * from v_stock_lots where doc_number = 'MRN-1'`));
  ok(ret.grn_line_id == null, 'a material return is not editable as a GRN receipt lot');
  const GL1 = await one(`select id from stock_ledger where doc_line_id = $1 and txn_type = 'grn'`, [G1.l]);
  await db.query(`insert into stock_ledger (project_id, store_id, material_spec_id, qty, txn_type, doc_type, doc_id, doc_number, doc_line_id, txn_at, created_by, reversal_of)
                  values ($1, $2, $3, -100, 'reversal', 'grn', $4, 'GRN-1', $5, now(), $6, $7)`, [P, S, C, G1.g, G1.l, U.store_keeper, GL1.id]);
  const afterGrnReversal = await as(U.store_keeper, () => all(`select * from v_stock_lots where material_spec_id = $1`, [C]));
  ok(afterGrnReversal.length === 1 && afterGrnReversal[0].doc_number === 'GRN-2' && n(afterGrnReversal[0].remaining_qty) === 50,
    'reversing GRN-1 removes that receipt lot without consuming the newer GRN-2 lot');

  // ===================================================================
  console.log('\nSupplier performance');
  let sp = await as(U.store_keeper, () => all(`select * from v_supplier_performance order by name`));
  const sx = sp.find((r) => r.supplier_id === X), sy = sp.find((r) => r.supplier_id === Y);
  ok(sx && n(sx.deliveries) === 2 && n(sx.on_time_pct) === 50 && n(sx.quality_pct) === 96.8 && n(sx.avg_days_late) === 2.5,
    `Habesha: 2 receipts, 1 on time (50 %), 150 of 155 accepted (96.8 %), avg 2.5 days late`);
  ok(n(sx.score) === 77.5 && sx.grade === 'C' && sx.price_index == null, `no price data → quality + delivery re-weighted: ${sx.score} (${sx.grade})`);
  ok(sy && n(sy.score) === 100 && sy.grade === 'A', `Addis Chemicals on time, all accepted → ${sy?.score} (${sy?.grade})`);
  await db.query(`insert into price_observations (project_id, material_spec_id, supplier_id, unit_price, observed_on, source, avg_90d, created_by)
                  values ($1, $2, $3, 105, $4, 'po', 100, $5)`, [P, C, X, day(-25), U.procurement]);
  const spP = await as(U.procurement, () => one(`select * from v_supplier_performance where supplier_id = $1`, [X]));
  ok(n(spP.price_index) === 1.05 && n(spP.price_score) === 90 && n(spP.score) === 79.4,
    `buyer with price access: 5 % above the 90-day average → price score 90, overall ${spP.score}`);
  const spS = await as(U.store_keeper, () => one(`select * from v_supplier_performance where supplier_id = $1`, [X]));
  ok(spS.price_index == null && n(spS.score) === 77.5, 'store keeper (no price access) does not see the price part');
  const PO4 = await po(X, 'sent', day(-3), 'PO-4');
  await db.query(`insert into po_lines (id, po_id, project_id, line_no, material_spec_id, qty) values ($1, $2, $3, 1, $4, 10)`, [uuid(), PO4, P, C]);
  ok(n((await as(U.procurement, () => one(`select overdue_orders from v_supplier_performance where supplier_id = $1`, [X]))).overdue_orders) === 1,
    'PO-4 past its promised date counts as overdue');
  const dv = await as(U.procurement, () => one(`select * from v_supplier_deliveries where grn_number = 'GRN-2'`));
  ok(dv.days_late === 5 && n(dv.qty_rejected) === 5 && n(dv.rejected_lines) === 1, 'delivery detail: GRN-2 5 days late, 5 bags rejected');

  await expectError(as(U.store_keeper, () => rpc('rate_supplier', { po_id: PO2, score: 2 })), /what went wrong/, 'a low rating needs a comment');
  await expectError(as(U.store_keeper, () => rpc('rate_supplier', { po_id: PO2, score: 6 })), /1 to 5/, 'score must be 1–5');
  await expectError(as(U.site_engineer, () => rpc('rate_supplier', { po_id: PO2, score: 4 })), /not allowed/, 'site engineer cannot rate suppliers');
  await as(U.store_keeper, () => rpc('rate_supplier', { po_id: PO2, score: 2, comment: 'Torn bags, no delivery note' }));
  await as(U.procurement, () => rpc('rate_supplier', { po_id: PO1, score: 4 }));
  await as(U.store_keeper, () => rpc('rate_supplier', { po_id: PO2, score: 3, comment: 'Torn bags' }));
  const rs = await as(U.procurement, () => one(`select service_rating, ratings from v_supplier_performance where supplier_id = $1`, [X]));
  ok(n(rs.service_rating) === 3.5 && n(rs.ratings) === 2, `re-rating replaces the person's rating: avg ${rs.service_rating} from ${rs.ratings}`);
  const PO5 = await po(Y, 'draft', day(5), 'PO-5');
  await expectError(as(U.procurement, () => rpc('rate_supplier', { po_id: PO5, score: 4 })), /once PO-5 has been sent/, 'a draft order cannot be rated');

  // ===================================================================
  console.log('\nStore keeper inbox: one item per incoming order');
  await db.exec(`update purchase_orders set eta = app.local_date(now()) where number = 'PO-4'`);
  ok((await inbox(U.store_keeper, 'po_receive')).filter((r) => r.entity_id === PO4).length === 1, 'PO-4 due today → "Receive PO-4"');
  const DN = uuid();
  await db.query(`insert into delivery_notices (id, project_id, po_id, store_id, expected_date, lines, created_by)
                  values ($1, $2, $3, $4, $5, '[]', $6)`, [DN, P, PO4, S, today, U.procurement]);
  const both = await as(U.store_keeper, () => all(`select kind from v_my_approvals where entity_id in ($1, $2)`, [PO4, DN]));
  ok(both.length === 1 && both[0].kind === 'delivery_ack', `with a delivery notice waiting: only "${both.map((b) => b.kind).join(', ')}"`);
  await db.query(`update delivery_notices set status = 'acknowledged' where id = $1`, [DN]);
  const after = await as(U.store_keeper, () => all(`select kind from v_my_approvals where entity_id in ($1, $2)`, [PO4, DN]));
  ok(after.length === 1 && after[0].kind === 'po_receive', 'after confirming the notice: "Receive PO-4" only');

  // ===================================================================
  console.log('\nTools & small equipment register');
  const T1 = uuid(), T2 = uuid();
  await expectError(as(U.site_engineer, () => rpc('save_tool', { id: uuid(), project_id: P, name: 'Drill' })), /not allowed/, 'site engineer cannot register tools');
  const t1 = await as(U.store_keeper, () => rpc('save_tool', { id: T1, project_id: P, name: 'Poker vibrator 38 mm', category: 'power_tool', store_id: S, serial_no: 'VB-2231' }));
  ok(t1.tag === 'T-0001', `auto tag ${t1.tag}`);
  await as(U.store_keeper, () => rpc('save_tool', { id: T2, project_id: P, tag: 'lvl-01', name: 'Dumpy level', category: 'measuring' }));
  await expectError(as(U.store_keeper, () => rpc('save_tool', { id: uuid(), project_id: P, tag: 'LVL-01', name: 'Second level' })), /already used/, 'tags are unique per project (case-insensitive)');
  await expectError(as(U.site_engineer, () => rpc('tool_action', { tool_id: T1, action: 'issue', holder_id: U.site_engineer })), /not allowed/, 'only the store issues tools');
  await expectError(as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'issue' })), /Who receives/, 'issue needs a receiver');
  await expectError(as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'issue', holder_id: outsider })), /not a member/, 'receiver must be on the project');
  await expectError(as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'issue', holder_id: U.site_engineer, due_on: day(-1) })), /past/, 'due date cannot be in the past');
  await as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'issue', holder_id: U.site_engineer, due_on: day(1) }));
  let v = await as(U.site_engineer, () => one(`select * from v_tools where id = $1`, [T1]));
  ok(v.status === 'issued' && v.holder === 'site engineer' && !v.is_overdue, `issued to ${v.holder}, due tomorrow`);
  await expectError(as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'issue', holder_name: 'Carpenters gang' })), /only a tool in the store/, 'cannot issue an issued tool');
  await expectError(as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'return' })), /condition/, 'return needs the condition');
  await expectError(as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'return', condition: 'damaged' })), /Describe the damage/, 'damaged return needs a description');
  await as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'return', condition: 'damaged', note: 'Needle bent' }));
  v = await one(`select * from tool_items where id = $1`, [T1]);
  ok(v.status === 'repair' && v.holder_id == null, 'returned damaged → under repair, nobody holds it');
  ok((await one(`select count(*)::int c from notifications where user_id = $1 and entity_id = $2`, [U.coordinator, T1])).c === 1, 'coordinator told about the damage');
  await expectError(as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'issue', holder_name: 'Gang A' })), /only a tool in the store/, 'a tool under repair cannot be issued');
  await as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'repaired' }));
  await as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'issue', holder_name: 'Concrete gang (Abebe)', due_on: today }));
  await db.query(`update tool_items set due_on = $2 where id = $1`, [T1, day(-2)]);
  v = await as(U.store_keeper, () => one(`select * from v_tools where id = $1`, [T1]));
  ok(v.is_overdue && v.days_overdue === 2 && v.holder === 'Concrete gang (Abebe)', 'crew holder, 2 days overdue');
  const od = await inbox(U.store_keeper, 'tool_overdue');
  ok(od.length === 1 && /Get back T-0001 Poker vibrator 38 mm from Concrete gang \(Abebe\)/.test(od[0].title), `store keeper inbox: "${od[0]?.title}"`);
  await expectError(as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'lost' })), /how the tool was lost/, 'loss needs an explanation');
  await as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'lost', note: 'Left at night shift, not found' }));
  ok((await one(`select count(*)::int c from notifications where user_id = $1 and entity_id = $2 and is_critical`, [U.manager, T1])).c === 1, 'manager gets a critical loss notice');
  ok((await inbox(U.store_keeper, 'tool_overdue')).length === 0, 'lost tool leaves the overdue list');
  await expectError(as(U.store_keeper, () => rpc('tool_action', { tool_id: T1, action: 'dispose', note: 'write off' })), /not allowed/, 'store keeper cannot write tools off');
  await as(U.coordinator, () => rpc('tool_action', { tool_id: T1, action: 'dispose', note: 'Written off after loss report' }));
  const mv = await all(`select action from tool_movements where tool_id = $1 order by created_at`, [T1]);
  ok(mv.map((m) => m.action).join(',') === 'issue,return,repaired,issue,lost,dispose', `history: ${mv.map((m) => m.action).join(' → ')}`);
  ok((await all(`select holder_name from tool_movements where tool_id = $1 and action = 'lost'`, [T1]))[0].holder_name === 'Concrete gang (Abebe)', 'loss records who had it');
  ok((await as(outsider, () => all(`select * from v_tools`))).length === 0 && (await as(outsider, () => all(`select * from tool_movements`))).length === 0,
    'other project sees no tools');
  await expectError(as(U.store_keeper, () => db.query(`insert into tool_items (id, project_id, tag, name, created_by) values ($1, $2, 'X', 'x', $3)`, [uuid(), P, U.store_keeper])),
    /row-level security|permission/, 'no direct writes — only through the functions');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
