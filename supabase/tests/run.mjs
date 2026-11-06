// End-to-end database test: runs all migrations + seed in PGlite (in-process
// Postgres) with minimal Supabase auth/storage stubs, then drives the full
// request → approval → receipt → issue → return → count cycle through the
// same RPCs the apps use, as real roles under RLS.
//
//   npm run test:db

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();

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
grant usage on schema public, auth, storage to anon, authenticated;
`;

const GRANTS = `
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant execute on all functions in schema auth to authenticated;
`;

let passed = 0;
let failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.log('  ✗', msg); }
};

async function as(userId, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
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

async function main() {
  console.log('Applying migrations…');
  await db.exec(STUBS);
  for (const f of readdirSync(join(root, 'migrations')).sort()) {
    await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
    console.log('  applied', f);
  }
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);

  // ---- users -------------------------------------------------------------
  const U = {};
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper', 'procurement']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role.replace('_', ' ') }, { role }]);
  }
  const outsider = uuid();
  await db.query(`insert into auth.users (id, email, raw_app_meta_data) values ($1, 'out@test.et', '{"role":"site_engineer"}')`, [outsider]);
  ok((await one(`select count(*)::int n from profiles`)).n === 8, 'profiles created from auth users with app_metadata role');

  // ---- setup as admin ----------------------------------------------------
  console.log('\nProject setup');
  const P = uuid(), B = uuid(), L2 = uuid(), S = uuid(), C12 = uuid(), S1 = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'BOLE', 'Bole Mixed-Use')`, [P]);
    for (const r of ['coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper', 'procurement']) {
      await db.query(`insert into project_members (project_id, user_id) values ($1, $2)`, [P, U[r]]);
    }
    await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'A', 'Block A')`, [B, P]);
    await db.query(`insert into levels (id, project_id, block_id, code, name, sort_order) values ($1, $2, $3, 'L2', 'Level 2', 2)`, [L2, P, B]);
    await db.query(`insert into stores (id, project_id, name) values ($1, $2, 'Main store')`, [S, P]);
    await db.query(`insert into elements (id, project_id, block_id, level_id, code, element_type, planned_finish)
                    values ($1, $3, $4, $5, 'C12', 'column', current_date - 1), ($2, $3, $4, $5, 'S1', 'slab', current_date + 30)`,
      [C12, S1, P, B, L2]);
  });
  const spec = async (name, grade) => (await one(
    `select s.id from material_specs s join materials m on m.id = s.material_id where m.name = $1 and s.grade = $2`, [name, grade])).id;
  const REBAR16 = await spec('Rebar', 'S-400 Ø16');
  const REBAR500 = await spec('Rebar', 'S-500 Ø16');
  const CONC = await spec('Concrete', 'C-25/30');
  await as(U.office_engineer, async () => {
    await db.query(`insert into element_takeoffs (project_id, element_id, material_spec_id, planned_qty) values
      ($1, $2, $3, 400), ($1, $2, $4, 2.5), ($1, $5, $4, 30)`, [P, C12, REBAR16, CONC, S1]);
  });
  await as(U.manager, () => db.query(`insert into spec_prices (material_spec_id, unit_price) values ($1, 95), ($2, 7800)`, [REBAR16, CONC]));
  ok((await one(`select count(*)::int n from element_activities where element_id = $1`, [C12])).n === 7, 'column C12 got its 7-step activity sequence');
  ok((await one(`select count(*)::int n from project_settings where project_id = $1`, [P])).n === 1, 'project settings defaulted');

  // ---- RLS ---------------------------------------------------------------
  console.log('\nAccess control');
  ok((await as(outsider, () => all(`select * from projects`))).length === 0, 'non-member cannot see the project (FR-ACC-04)');
  ok((await as(U.site_engineer, () => all(`select * from spec_prices`))).length === 0, 'site engineer cannot see prices (FR-ACC-03)');
  ok((await as(U.coordinator, () => all(`select * from spec_prices`))).length === 2, 'coordinator can see prices');
  await expectError(as(U.site_engineer, () => db.query(`insert into blocks (project_id, code, name) values ($1, 'B', 'B')`, [P])),
    /row-level security/, 'site engineer cannot edit master data');
  await expectError(as(U.site_engineer, () => db.query(`update profiles set role = 'admin' where id = $1`, [U.site_engineer])),
    /administrator/, 'user cannot promote themselves');

  // ---- material request --------------------------------------------------
  console.log('\nMaterial request & approval');
  const dev = await as(U.site_engineer, () => rpc('register_device', { device_id: uuid(), name: 'Tecno' }));
  ok(/^D\d{3}$/.test(dev.prefix), `device registered with prefix ${dev.prefix}`);
  const MR = uuid(), L1 = uuid(), L2line = uuid();
  const mrPayload = (over) => ({
    op_id: uuid(), id: MR, project_id: P, number: `BOLE-MR-${dev.prefix}-0001`, block_id: B, priority: 'urgent',
    required_date: '2026-11-05', delivery_location: 'Main store', submit: true,
    lines: [
      { id: L1, material_spec_id: REBAR16, qty: 500, over_boq_reason: over,
        elements: [{ id: uuid(), element_id: C12, qty: 500 }] },
      { id: L2line, material_spec_id: CONC, qty: 2.5, elements: [{ id: uuid(), element_id: C12, qty: 2.5 }] },
    ],
  });
  await expectError(as(U.site_engineer, () => rpc('save_mr', { ...mrPayload(), lines: [{ ...mrPayload().lines[0], elements: [] }] })),
    /structural element is required/, 'MR line without element is rejected (FR-MR-01)');
  // the failed call rolled back; drafts never reached the DB
  await expectError(as(U.site_engineer, () => rpc('save_mr', mrPayload())),
    /exceeds the BoQ balance/, 'quantity over take-off+wastage needs a reason (FR-MR-04)');
  const saved = await as(U.site_engineer, () => rpc('save_mr', mrPayload('Lap lengths revised per RFI-12')));
  ok(saved.status === 'submitted', 'request submitted with over-BoQ reason');
  ok((await one(`select exceeds_boq from mr_lines where id = $1`, [L1])).exceeds_boq === true, 'line flagged as exceeding BoQ (BR-03)');
  ok((await one(`select count(*)::int n from notifications where user_id = $1`, [U.procurement])).n === 1, 'urgent request notified procurement (FR-WF-05)');

  await expectError(as(U.site_engineer, () => rpc('mr_action', { mr_id: MR, action: 'approve' })), /not allowed/, 'site engineer cannot approve');
  await expectError(as(U.office_engineer, () => rpc('mr_action', { mr_id: MR, action: 'approve' })), /not allowed/, 'office engineer can only recommend');
  await as(U.office_engineer, () => rpc('mr_action', { op_id: uuid(), mr_id: MR, action: 'review', comment: 'Qty checked' }));
  await expectError(as(U.coordinator, () => rpc('mr_action', { mr_id: MR, action: 'reject' })), /reason is required/, 'reject requires a reason (FR-WF-03)');
  await as(U.coordinator, () => rpc('mr_action', { op_id: uuid(), mr_id: MR, action: 'approve', lines: [{ id: L1, approved_qty: 420 }] }));
  const mr = await one(`select status from material_requests where id = $1`, [MR]);
  ok(mr.status === 'approved', 'coordinator approved');
  ok((await one(`select approved_qty from mr_lines where id = $1`, [L1])).approved_qty == 420, 'partial approval recorded (420 of 500)');
  ok((await one(`select count(*)::int n from mr_events where mr_id = $1 and action = 'partial_approve'`, [MR])).n === 1, 'history shows partial approval (FR-WF-06)');

  // ---- receiving ---------------------------------------------------------
  console.log('\nReceiving (GRN)');
  const GRN = uuid();
  await expectError(as(U.site_engineer, () => rpc('post_grn', { id: GRN, project_id: P, store_id: S, number: 'X', lines: [] })),
    /not allowed/, 'only store keeper/management can post GRN (BR-04)');
  await as(U.store_keeper, () => rpc('post_grn', {
    op_id: uuid(), id: GRN, project_id: P, store_id: S, number: 'BOLE-GRN-D002-0001', supplier_name: 'Abyssinia Steel',
    delivery_note_no: 'DN-881', vehicle_plate: '3-A12345',
    lines: [
      { id: uuid(), material_spec_id: REBAR16, mr_line_id: L1, ordered_qty: 420, qty_delivered: 400, qty_rejected: 20,
        inspection_result: 'conditional', inspection_notes: '20kg rusted' },
      { id: uuid(), material_spec_id: CONC, mr_line_id: L2line, qty_delivered: 2.5 },
    ],
  }));
  const bal = async (sp, st = 'available') => Number((await one(
    `select coalesce(sum(qty),0) q from stock_ledger where store_id = $1 and material_spec_id = $2 and stock_status = $3`, [S, sp, st])).q);
  ok(await bal(REBAR16) === 380, 'accepted rebar in available stock (380)');
  ok(await bal(REBAR16, 'quarantine') === 20, 'rejected rebar quarantined (FR-RC-04)');
  ok((await one(`select variance_flag from grn_lines where grn_id = $1 and line_no = 1`, [GRN])).variance_flag === 'shortage', 'shortage flagged (FR-RC-02)');
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and entity_type = 'grn'`, [U.site_engineer])).n >= 1, 'requester notified of arrival (FR-RC-07)');

  // ---- issue -------------------------------------------------------------
  console.log('\nIssue (MIV)');
  const MIV = uuid(), mivOp = uuid();
  const mivPayload = (qty, extra = {}) => ({
    op_id: mivOp, id: MIV, project_id: P, store_id: S, number: 'BOLE-MIV-D002-0001', mr_id: MR, issued_to: U.site_engineer,
    lines: [{ id: uuid(), mr_line_id: L1, material_spec_id: REBAR16, element_id: C12, qty, ...extra }],
  });
  await expectError(as(U.store_keeper, () => rpc('post_miv', { ...mivPayload(400), op_id: uuid() })),
    /Insufficient available stock/, 'cannot issue more than available stock (FR-ST-03)');
  await expectError(as(U.store_keeper, () => rpc('post_miv', { ...mivPayload(10), op_id: uuid(), lines: [{ ...mivPayload(10).lines[0], material_spec_id: REBAR500 }] })),
    /substitution reason/, 'grade substitution needs a reason (BR-05)');
  await expectError(as(U.store_keeper, () => rpc('post_miv', { ...mivPayload(10), op_id: uuid(), mr_id: null })),
    /approved request/, 'no issue without approved request (BR-01)');
  const r1 = await as(U.store_keeper, () => rpc('post_miv', mivPayload(300)));
  const r2 = await as(U.store_keeper, () => rpc('post_miv', mivPayload(300)));
  ok(r1.id === r2.id && await bal(REBAR16) === 80, 'replayed outbox op is idempotent (stock 80, not -220)');
  ok((await one(`select status from material_requests where id = $1`, [MR])).status === 'partially_issued', 'request partially issued (FR-ST-04)');
  await as(U.site_engineer, () => rpc('acknowledge_miv', { miv_id: MIV }));
  ok((await one(`select status from mivs where id = $1`, [MIV])).status === 'acknowledged', 'receiver acknowledged issue');

  await expectError(db.query(`update stock_ledger set qty = 1`), /immutable/, 'stock ledger is append-only (BR-07)');
  await expectError(db.query(`delete from grns`), /immutable/, 'posted GRN cannot be deleted (FR-AU-02)');

  // emergency issue and regularisation
  const EMIV = uuid();
  await as(U.store_keeper, () => rpc('post_miv', {
    op_id: uuid(), id: EMIV, project_id: P, store_id: S, number: 'BOLE-MIV-D002-0002', issued_to: U.site_engineer,
    is_emergency: true, emergency_reason: 'Pour in progress', receiver_signature: 'M0,0L10,10',
    lines: [{ id: uuid(), material_spec_id: CONC, element_id: C12, qty: 1 }],
  }));
  await as(U.coordinator, () => rpc('regularise_miv', { op_id: uuid(), miv_id: EMIV, mr_id: MR }));
  ok((await one(`select mr_line_id from miv_lines where miv_id = $1`, [EMIV])).mr_line_id === L2line, 'emergency issue regularised against request (BR-01)');

  // ---- return, wastage, count --------------------------------------------
  console.log('\nReturns, wastage, stock count');
  await as(U.store_keeper, () => rpc('post_mrn', {
    op_id: uuid(), id: uuid(), project_id: P, store_id: S, number: 'BOLE-MRN-D002-0001', miv_id: MIV, returned_by: U.site_engineer,
    lines: [{ id: uuid(), material_spec_id: REBAR16, element_id: C12, mr_line_id: L1, qty: 15, condition: 'good' },
            { id: uuid(), material_spec_id: REBAR16, element_id: C12, qty: 5, condition: 'damaged' }],
  }));
  ok(await bal(REBAR16) === 95 && await bal(REBAR16, 'quarantine') === 25, 'good return restored, damaged quarantined');
  const ADJ = uuid();
  await as(U.store_keeper, () => rpc('create_adjustment', {
    op_id: uuid(), id: ADJ, project_id: P, store_id: S, number: 'BOLE-ADJ-D002-0001', adj_type: 'damage', reason_code: 'Rusted',
    lines: [{ id: uuid(), material_spec_id: REBAR16, stock_status: 'quarantine', qty: 25 }],
  }));
  ok(await bal(REBAR16, 'quarantine') === 25, 'adjustment waits for approval (FR-ST-07)');
  await as(U.manager, () => rpc('decide_adjustment', { op_id: uuid(), adjustment_id: ADJ, approve: true }));
  ok(await bal(REBAR16, 'quarantine') === 0, 'approved write-off posted');
  const CNT = uuid();
  await as(U.store_keeper, () => rpc('submit_stock_count', {
    op_id: uuid(), id: CNT, project_id: P, store_id: S, number: 'BOLE-CNT-D002-0001',
    lines: [{ id: uuid(), material_spec_id: REBAR16, counted_qty: 92 }],
  }));
  ok(Number((await one(`select variance from stock_count_lines where count_id = $1`, [CNT])).variance) === -3, 'count variance computed (-3)');
  await as(U.coordinator, () => rpc('decide_stock_count', { op_id: uuid(), count_id: CNT, approve: true }));
  ok(await bal(REBAR16) === 92, 'approved count adjusted stock to physical (FR-ST-08)');

  // ---- reversal ----------------------------------------------------------
  console.log('\nReversal');
  await expectError(as(U.store_keeper, () => rpc('reverse_document', { doc_type: 'miv', doc_id: EMIV })), /reason/, 'reversal needs a reason');
  await as(U.store_keeper, () => rpc('reverse_document', { op_id: uuid(), doc_type: 'miv', doc_id: EMIV, reason: 'Wrong element' }));
  ok(await bal(CONC) === 2.5, 'MIV reversal restored concrete stock (2.5)');
  ok((await one(`select count(*)::int n from stock_ledger where doc_id = $1 and txn_type = 'reversal'`, [EMIV])).n === 1, 'reversal posted as a new ledger entry');
  ok((await one(`select status from material_requests where id = $1`, [MR])).status === 'partially_issued', 'request status recomputed (rebar still partially issued)');

  // ---- progress ----------------------------------------------------------
  console.log('\nProgress');
  const acts = await all(`select id, seq, name from element_activities where element_id = $1 order by seq`, [C12]);
  await expectError(as(U.site_engineer, () => rpc('report_progress', { id: uuid(), element_activity_id: acts[4].id, pct_complete: 50 })),
    /Hold point/, 'casting blocked until inspection signed off (FR-PG-05)');
  for (const a of acts.slice(0, 4)) {
    const pid = uuid();
    await as(U.site_engineer, () => rpc('report_progress', { op_id: uuid(), id: pid, element_activity_id: a.id, pct_complete: 100, report_date: '2026-10-28' }));
    await as(U.office_engineer, () => rpc('verify_progress', { op_id: uuid(), progress_id: pid, approve: true }));
  }
  const pid = uuid();
  await as(U.site_engineer, () => rpc('report_progress', { op_id: uuid(), id: pid, element_activity_id: acts[4].id, pct_complete: 100 }));
  await expectError(as(U.office_engineer, () => rpc('verify_progress', { progress_id: pid, verified_pct: 80 })), /comment/, 'adjusting progress needs a comment (FR-PG-03)');
  await as(U.office_engineer, () => rpc('verify_progress', { op_id: uuid(), progress_id: pid, verified_pct: 80, comment: 'Top lift pending' }));
  const el = await one(`select progress_pct, status, actual_start from elements where id = $1`, [C12]);
  ok(Number(el.progress_pct) === 79, `element progress weighted = ${el.progress_pct}% (FR-PG-06)`);

  // ---- reports -----------------------------------------------------------
  console.log('\nReports');
  const cons = await as(U.coordinator, () => one(`select * from v_element_consumption where element_id = $1 and material_spec_id = $2`, [C12, REBAR16]));
  ok(Number(cons.issued_qty) === 280 && Number(cons.planned_qty) === 400, `consumption view: planned ${cons.planned_qty}, net issued ${cons.issued_qty} (300 issued − 20 returned)`);
  const sb = await as(U.store_keeper, () => all(`select label, stock_status, qty from v_stock_balance where project_id = $1`, [P]));
  ok(sb.length >= 2, `stock balance view: ${sb.map((r) => `${r.label}=${r.qty}`).join(', ')}`);
  ok((await as(U.site_engineer, () => all(`select * from v_element_cost`))).length === 0, 'cost view empty for site roles (NFR-05)');
  ok((await as(U.coordinator, () => all(`select * from v_element_cost`))).length > 0, 'cost view populated for coordinator (FR-CC-03)');
  const audit = await as(U.manager, () => one(`select count(*)::int n from audit_log where project_id = $1`, [P]));
  ok(audit.n > 10, `audit log has ${audit.n} project entries (FR-AU-01)`);
  ok((await as(U.site_engineer, () => all(`select * from audit_log`))).length === 0, 'audit log hidden from site roles');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e.message, e.position ? `at position ${e.position}` : "", e.where ?? ""); process.exit(1); });
