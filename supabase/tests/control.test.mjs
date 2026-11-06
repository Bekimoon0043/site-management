// Database test for migration 20261029000007_control_comms.sql: gate passes,
// vehicle log, alerts, QR signing, attachment geofence, Telegram linking and
// run-as actions, approvals inbox, Ethiopian calendar. Applies ONLY 0001–0004
// + 0007 + seed in PGlite with the same Supabase stubs as run.mjs.
//
//   node supabase/tests/control.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid, createHmac } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const C = await import('../../shared/contract-control.ts');   // Node ≥ 22.18 strips TS types
const db = new PGlite();

const MIGRATIONS = [
  '20261029000001_schema.sql', '20261029000002_security.sql', '20261029000003_functions.sql',
  '20261029000004_views.sql', '20261029000005_procurement.sql', '20261029000006_field_quality.sql',
  '20261029000007_control_comms.sql', '20261030000001_mr_flow_enums.sql', '20261030000002_mr_flows.sql',
];

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
// Edge Functions call with the service-role key: no sub, role = service_role.
async function asService(fn) {
  await db.query(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', 'service_role', false)`);
  await db.exec('set role service_role');
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.role', '', false)`);
  }
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
  for (const f of MIGRATIONS) {
    await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
    console.log('  applied', f);
  }
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);

  // ---- users & project ---------------------------------------------------
  const U = {};
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper', 'procurement', 'security']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, phone, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4, $5)`,
      [U[role], `${role}@test.et`, `+2519${Math.floor(10000000 + Math.random() * 8e7)}`, { full_name: role }, { role }]);
  }
  const P = uuid(), B = uuid(), L2 = uuid(), S = uuid(), C12 = uuid();
  const SITE = { lat: 9.0108, lng: 38.7613 };
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name, site_lat, site_lng, site_radius_m) values ($1, 'BOLE', 'Bole Mixed-Use', $2, $3, 300)`,
      [P, SITE.lat, SITE.lng]);
    for (const r of Object.keys(U).filter((r) => r !== 'admin')) {
      await db.query(`insert into project_members (project_id, user_id) values ($1, $2)`, [P, U[r]]);
    }
    await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'A', 'Block A')`, [B, P]);
    await db.query(`insert into levels (id, project_id, block_id, code, name) values ($1, $2, $3, 'L2', 'Level 2')`, [L2, P, B]);
    await db.query(`insert into stores (id, project_id, name) values ($1, $2, 'Main store')`, [S, P]);
    await db.query(`insert into elements (id, project_id, block_id, level_id, code, element_type) values ($1, $2, $3, $4, 'C12', 'column')`,
      [C12, P, B, L2]);
  });
  const spec = async (name, grade) => (await one(
    `select s.id from material_specs s join materials m on m.id = s.material_id where m.name = $1 and s.grade = $2`, [name, grade])).id;
  const REBAR = await spec('Rebar', 'S-400 Ø16');
  const TIMBER = await spec('Formwork timber', 'Eucalyptus 4x5');
  await as(U.office_engineer, () => db.query(
    `insert into element_takeoffs (project_id, element_id, material_spec_id, planned_qty) values ($1, $2, $3, 400)`, [P, C12, REBAR]));
  await as(U.coordinator, () => rpc('post_opening_balance', { op_id: uuid(), project_id: P, store_id: S,
    lines: [{ material_spec_id: REBAR, qty: 1000 }, { material_spec_id: TIMBER, qty: 200 }] }));
  const bal = async (sp, st = 'available') => Number((await one(
    `select coalesce(sum(qty),0) q from stock_ledger where store_id = $1 and material_spec_id = $2 and stock_status = $3`, [S, sp, st])).q);
  const dev = await as(U.store_keeper, () => rpc('register_device', { device_id: uuid(), name: 'Tecno' }));
  const num = (type, n) => C.docNumberControl('BOLE', type, dev.prefix, n);

  // ---- security role -----------------------------------------------------
  console.log('\nSecurity role');
  ok((await one(`select 'security' = any (enum_range(null::app_role)::text[]) as x`)).x, 'app_role enum has security');
  ok((await one(`select role::text r from profiles where id = $1`, [U.security])).r === 'security', 'guard profile created with role security');
  ok((await as(U.security, () => all(`select * from stock_ledger`))).length === 0, 'guard cannot read the stock ledger');
  ok((await as(U.store_keeper, () => all(`select * from stock_ledger`))).length > 0, 'store keeper still reads the stock ledger');

  // ---- returnable gate pass ---------------------------------------------
  console.log('\nReturnable gate pass (formwork to repair yard)');
  const GP1 = uuid(), GP1L = uuid();
  const yesterday = (await one(`select (app.eat_now()::date - 1)::text d`)).d;
  await expectError(as(U.store_keeper, () => rpc('save_gate_pass', { op_id: uuid(), id: GP1, project_id: P, number: num('GP', 1),
    pass_type: 'returnable', store_id: S, destination: 'Yard', purpose: 'Repair', lines: [{ id: GP1L, material_spec_id: TIMBER, qty: 50 }] })),
    /Expected return/, 'returnable pass needs an expected return date');
  const s1 = await as(U.store_keeper, () => rpc('save_gate_pass', { op_id: uuid(), id: GP1, project_id: P, number: num('GP', 1),
    pass_type: 'returnable', store_id: S, destination: 'Kality repair yard', purpose: 'Formwork repair', vehicle_plate: '3-A 12345',
    driver_name: 'Abebe', expected_return: yesterday, submit: true, lines: [{ id: GP1L, material_spec_id: TIMBER, qty: 50 }] }));
  ok(s1.status === 'pending', 'gate pass submitted (pending)');
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and entity_type = 'gate_pass'`, [U.coordinator])).n === 1,
    'coordinator notified to approve');
  await expectError(as(U.security, () => rpc('gate_pass_action', { gate_pass_id: GP1, action: 'approve' })), /not allowed/, 'guard cannot approve');
  await expectError(as(U.security, () => rpc('verify_gate_pass', { id: uuid(), gate_pass_id: GP1, matches: true })),
    /not approved for exit/, 'unapproved pass cannot be checked out');
  await as(U.coordinator, () => rpc('gate_pass_action', { op_id: uuid(), gate_pass_id: GP1, action: 'approve' }));
  const gp1 = await one(`select status, qr_code from gate_passes where id = $1`, [GP1]);
  ok(gp1.status === 'approved' && gp1.qr_code.startsWith(`SM1:gate_pass:${P}:${GP1}:`), 'coordinator approved; signed QR stored on pass');
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and entity_id = $2`, [U.security, GP1])).n === 1, 'guard notified of approved pass');

  const mis = await as(U.security, () => rpc('verify_gate_pass', { op_id: uuid(), id: uuid(), gate_pass_id: GP1, plate_seen: '3-B 99999', matches: true }));
  ok(mis.matched === false && mis.status === 'approved', 'different plate recorded as mismatch; pass not released');
  ok((await one(`select count(*)::int n from alerts where rule = 'gate_mismatch' and entity_id = $1 and severity = 'critical'`, [GP1])).n === 1,
    'mismatch raised a critical alert');
  ok(await bal(TIMBER) === 200, 'no stock moved on mismatch');
  const ex = await as(U.security, () => rpc('verify_gate_pass', { op_id: uuid(), id: uuid(), gate_pass_id: GP1, plate_seen: '3a12345', matches: true }));
  ok(ex.matched && ex.status === 'exited', 'guard checked the vehicle out (plate normalised)');
  ok(await bal(TIMBER) === 150 && await bal(TIMBER, 'on_loan') === 50, 'returnable: 50 moved available → on_loan');
  ok((await one(`select count(*)::int n from gate_events where gate_pass_id = $1 and actor = $2`, [GP1, U.security])).n === 2,
    'gate events recorded by the guard');
  ok((await one(`select count(*)::int n from stock_ledger where doc_id = $1 and txn_type = 'gate_out'`, [GP1])).n === 2, 'ledger has gate_out entries');
  await as(U.security, () => rpc('return_gate_pass', { op_id: uuid(), id: uuid(), gate_pass_id: GP1, lines: [{ gate_pass_line_id: GP1L, qty_returned: 20 }] }));
  ok((await one(`select status from gate_passes where id = $1`, [GP1])).status === 'partially_returned', 'partial return');
  ok(await bal(TIMBER) === 170 && await bal(TIMBER, 'on_loan') === 30, 'gate_in: 20 back to available, 30 still on loan');
  await expectError(as(U.security, () => rpc('return_gate_pass', { id: uuid(), gate_pass_id: GP1, lines: [{ gate_pass_line_id: GP1L, qty_returned: 31 }] })),
    /only 30(\.0+)? is out/, 'cannot return more than is out');
  await expectError(db.query(`update gate_events set note = 'x'`), /immutable/, 'gate events are immutable');

  // ---- non-returnable ----------------------------------------------------
  console.log('\nNon-returnable gate pass (scrap sale)');
  const GP2 = uuid();
  await as(U.site_engineer, () => rpc('save_gate_pass', { op_id: uuid(), id: GP2, project_id: P, number: num('GP', 2),
    pass_type: 'non_returnable', store_id: S, destination: 'Scrap buyer, Merkato', purpose: 'Scrap sale', submit: true,
    lines: [{ id: uuid(), material_spec_id: REBAR, qty: 100 }, { id: uuid(), description: 'Empty cement bags', qty: 300, uom: 'pcs' }] }));
  await expectError(as(U.coordinator, () => rpc('gate_pass_action', { gate_pass_id: GP2, action: 'reject' })), /reason/, 'reject needs a reason');
  await as(U.manager, () => rpc('gate_pass_action', { op_id: uuid(), gate_pass_id: GP2, action: 'approve' }));
  await as(U.security, () => rpc('verify_gate_pass', { op_id: uuid(), id: uuid(), gate_pass_id: GP2, matches: true }));
  ok(await bal(REBAR) === 900 && await bal(REBAR, 'on_loan') === 0, 'non-returnable reduced available stock (1000 → 900), nothing on loan');
  const GP3 = uuid();
  await as(U.store_keeper, () => rpc('save_gate_pass', { op_id: uuid(), id: GP3, project_id: P, number: num('GP', 3),
    pass_type: 'non_returnable', store_id: S, destination: 'Other site', purpose: 'Return to supplier', submit: true,
    lines: [{ id: uuid(), material_spec_id: REBAR, qty: 5000 }] }));
  await expectError(as(U.coordinator, () => rpc('gate_pass_action', { gate_pass_id: GP3, action: 'approve' })),
    /Insufficient available stock/, 'approval checks stock availability');
  await as(U.coordinator, () => rpc('gate_pass_action', { op_id: uuid(), gate_pass_id: GP3, action: 'reject', comment: 'Wrong qty' }));
  ok((await one(`select status from gate_passes where id = $1`, [GP3])).status === 'rejected', 'pass rejected with reason');

  // ---- vehicle log -------------------------------------------------------
  console.log('\nVehicle log');
  const V1 = await as(U.security, () => rpc('log_vehicle', { op_id: uuid(), id: uuid(), project_id: P, number: num('VEH', 1),
    direction: 'out', plate: '3-c 55555', loaded: true, purpose: 'Unknown load' }));
  ok(V1.flagged === true, 'loaded exit without document is flagged');
  ok((await one(`select count(*)::int n from alerts where rule = 'unmatched_vehicle_exit'`)).n === 1, 'unmatched exit alert raised');
  const V2 = await as(U.security, () => rpc('log_vehicle', { op_id: uuid(), id: uuid(), project_id: P, number: num('VEH', 2),
    direction: 'out', plate: '3-A12345', loaded: true, linked_doc_type: 'gate_pass', linked_doc_id: GP1 }));
  ok(V2.flagged === false, 'exit linked to gate pass is not flagged');
  await expectError(as(U.site_engineer, () => rpc('log_vehicle', { id: uuid(), project_id: P, number: 'X', direction: 'in', plate: 'A1' })),
    /not allowed/, 'site engineer cannot log vehicles');

  // ---- QR ----------------------------------------------------------------
  console.log('\nQR labels');
  const QS = uuid(), QE = uuid();
  const reg = await as(U.store_keeper, () => rpc('register_qr_labels', { op_id: uuid(), project_id: P, labels: [
    { id: QS, entity_type: 'store', entity_id: S, label: 'Main store' }, { id: QE, entity_type: 'element', entity_id: C12, label: 'C12' }] }));
  ok(reg.labels.length === 2 && (await one(`select count(*)::int n from qr_labels where project_id = $1`, [P])).n === 2, 'labels registered with codes');
  await expectError(as(U.site_engineer, () => rpc('get_qr_key', { project_id: P })), /not allowed/, 'site engineer cannot fetch QR key');
  const key = await as(U.security, () => rpc('get_qr_key', { project_id: P }));
  ok(/^[0-9a-f]{64}$/.test(key.key_hex), 'guard fetched 32-byte project key for offline checks');
  ok((await as(U.security, () => all(`select * from project_keys`))).length === 0, 'project_keys hidden from clients');
  const code = reg.labels.find((l) => l.id === QE).code;
  const msg = code.slice(0, code.lastIndexOf(':'));
  const nodeSig = createHmac('sha256', Buffer.from(key.key_hex, 'hex')).update(msg, 'utf8').digest().subarray(0, 16).toString('base64url');
  ok(code.endsWith(':' + nodeSig), 'SQL signature = node:crypto HMAC-SHA256/128 base64url');
  const keyFor = (pid) => (pid === P ? key.key_hex : undefined);
  ok(C.verifyQr(code, keyFor)?.valid === true, 'contract verifyQr accepts the label offline');
  ok(C.verifyQr(gp1.qr_code, keyFor)?.valid === true, 'contract verifyQr accepts the gate pass QR');
  const forged = code.replace(C12, GP1);
  ok(C.verifyQr(forged, keyFor)?.valid === false, 'tampered entity id fails offline verification');
  ok(C.signQr(key.key_hex, 'element', P, C12) === code, 'contract signQr reproduces the server code');
  ok((await as(U.site_engineer, () => rpc('verify_qr', { code }))).valid === true, 'verify_qr RPC accepts genuine code');
  ok((await as(U.site_engineer, () => rpc('verify_qr', { code: forged }))).valid === false, 'verify_qr RPC rejects forged code');
  ok(C.sha256(C.utf8('abc')).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '') ===
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'contract sha256 matches test vector');

  // ---- attachments evidence ---------------------------------------------
  console.log('\nAttachment evidence');
  const GRN = uuid();
  const att = (lat, lng, extra = {}) => as(U.store_keeper, () => one(`insert into attachments
      (id, project_id, entity_type, entity_id, kind, storage_path, latitude, longitude, gps_accuracy_m, sha256, source, captured_at, outside_site)
      values ($1, $2, 'grn', $3, $4, 'p/x.jpg', $5, $6, 8, $7, $8, now(), $9) returning outside_site, kind, source`,
    [uuid(), P, GRN, extra.kind ?? 'photo', lat, lng, extra.sha ?? 'AB'.repeat(32), extra.source ?? 'camera', extra.claim ?? null]));
  ok((await att(9.0110, 38.7615)).outside_site === false, 'photo 30 m from site centre → inside geofence');
  const far = await att(9.0560, 38.7613, { claim: false, kind: 'batch_ticket', source: 'gallery' });
  ok(far.outside_site === true, 'photo 5 km away → outside_site (client claim ignored)');
  ok(far.kind === 'batch_ticket' && far.source === 'gallery', 'new kind batch_ticket and source gallery accepted');
  ok((await att(null, null, { kind: 'proforma' })).outside_site === null, 'no GPS → outside_site unknown');
  await expectError(att(9.01, 38.76, { sha: 'nothex' }), /sha256/, 'sha256 must be 64 hex chars');

  // ---- inbox -------------------------------------------------------------
  console.log('\nApprovals inbox (v_my_approvals)');
  const EMIV = uuid(), ADJ = uuid(), MR = uuid(), GP4 = uuid(), GP5 = uuid();
  await as(U.store_keeper, () => rpc('post_miv', { op_id: uuid(), id: EMIV, project_id: P, store_id: S, number: `BOLE-MIV-${dev.prefix}-0001`,
    issued_to: U.site_engineer, is_emergency: true, emergency_reason: 'Pour in progress',
    issued_at: new Date(Date.now() - 30 * 3600e3).toISOString(),
    lines: [{ id: uuid(), material_spec_id: REBAR, element_id: C12, qty: 150 }] }));
  await as(U.store_keeper, () => rpc('create_adjustment', { op_id: uuid(), id: ADJ, project_id: P, store_id: S, number: 'BOLE-ADJ-D001-0001',
    adj_type: 'wastage', reason_code: 'Off-cuts', lines: [{ id: uuid(), material_spec_id: REBAR, qty: 150 }] }));
  await as(U.site_engineer, () => rpc('save_mr', { op_id: uuid(), id: MR, project_id: P, number: 'BOLE-MR-D001-0001', block_id: B,
    priority: 'urgent', required_date: '2026-11-10', delivery_location: 'Main store', submit: true,
    lines: [{ id: uuid(), material_spec_id: REBAR, qty: 50, elements: [{ id: uuid(), element_id: C12, qty: 50 }] }] }));
  const act1 = (await one(`select id from element_activities where element_id = $1 and seq = 1`, [C12])).id;
  const PU = uuid();
  await as(U.site_engineer, () => rpc('report_progress', { op_id: uuid(), id: PU, element_activity_id: act1, pct_complete: 100 }));
  for (const [id, n] of [[GP4, 4], [GP5, 5]]) {
    await as(U.store_keeper, () => rpc('save_gate_pass', { op_id: uuid(), id, project_id: P, number: num('GP', n), pass_type: 'returnable',
      store_id: S, destination: 'Hire company', purpose: 'Scaffold return', expected_return: '2026-12-01', submit: true,
      lines: [{ id: uuid(), material_spec_id: TIMBER, qty: 5 }] }));
  }
  await as(U.coordinator, () => rpc('gate_pass_action', { op_id: uuid(), gate_pass_id: GP5, action: 'approve' }));
  const inbox = async (role) => as(U[role], () => all(`select kind, entity_id, actions from v_my_approvals`));
  const kinds = (rows) => rows.map((r) => r.kind).sort().join(',');
  const coordInbox = await inbox('coordinator');
  ok(kinds(coordInbox) === 'adjustment,gate_pass_approve,progress_verify', `coordinator: ${kinds(coordInbox)}`);
  const oeInbox = await inbox('office_engineer');
  ok(kinds(oeInbox) === 'mr_review,progress_verify', `office engineer: ${kinds(oeInbox)}`);
  const secInbox = await inbox('security');
  ok(kinds(secInbox) === 'gate_exit' && secInbox[0].entity_id === GP5, `security: ${kinds(secInbox)} (approved pass awaiting exit)`);
  const seInbox = await inbox('site_engineer');
  ok(kinds(seInbox) === 'miv_ack' && seInbox[0].entity_id === EMIV, `site engineer: ${kinds(seInbox)}`);
  ok((await inbox('store_keeper')).length === 0, 'store keeper: nothing waiting');
  await expectError(as(U.site_engineer, () => all(`select * from app.approvals_for($1)`, [U.coordinator])), /Not allowed/,
    "user cannot read someone else's inbox");

  // ---- alerts ------------------------------------------------------------
  console.log('\nAlert rules');
  await as(U.manager, () => rpc('decide_adjustment', { op_id: uuid(), adjustment_id: ADJ, approve: true }));
  await db.query(`update elements set progress_pct = 10 where id = $1`, [C12]);   // earned 40 kg vs 150 issued
  const ev = await as(U.coordinator, () => rpc('evaluate_alerts', { project_id: P }));
  const rules = (await all(`select rule from alerts where project_id = $1 and status <> 'closed' order by rule`, [P])).map((r) => r.rule);
  ok(ev.created === 5, `evaluate_alerts created ${ev.created} alerts`);
  for (const r of ['consumption_variance', 'large_adjustment', 'emergency_not_regularised', 'gate_pass_overdue', 'delivery_outside_geofence']) {
    ok(rules.includes(r), `rule ${r} fired`);
  }
  ok((await one(`select app.run_alert_rules() n`)).n === 0, 'pg_cron re-run is idempotent (no duplicate open alerts)');
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and entity_type = 'alert'`, [U.manager])).n >= 7,
    'managers notified of alerts');
  await expectError(as(U.store_keeper, () => rpc('evaluate_alerts', { project_id: P })), /not allowed/, 'store keeper cannot run rules');
  const AL = (await one(`select id from alerts where rule = 'large_adjustment'`)).id;
  await as(U.manager, () => rpc('alert_action', { op_id: uuid(), alert_id: AL, action: 'acknowledge' }));
  await expectError(as(U.manager, () => rpc('alert_action', { alert_id: AL, action: 'close' })), /closing note/, 'closing needs a note');
  await as(U.manager, () => rpc('alert_action', { op_id: uuid(), alert_id: AL, action: 'close', note: 'Off-cuts reused as chairs' }));
  ok((await one(`select status from alerts where id = $1`, [AL])).status === 'closed', 'alert acknowledged then closed');
  await as(U.store_keeper, () => rpc('return_gate_pass', { op_id: uuid(), id: uuid(), gate_pass_id: GP1, lines: [{ gate_pass_line_id: GP1L, qty_returned: 30 }] }));
  ok((await one(`select status from gate_passes where id = $1`, [GP1])).status === 'returned' && await bal(TIMBER, 'on_loan') === 0
    && await bal(TIMBER) === 200, 'full return: on_loan back to 0, available 200');
  ok((await one(`select status from alerts where rule = 'gate_pass_overdue' and entity_id = $1`, [GP1])).status === 'closed',
    'overdue alert auto-closed on return');

  // ---- Telegram ----------------------------------------------------------
  console.log('\nTelegram linking & actions');
  const lc = await as(U.office_engineer, () => rpc('create_telegram_link_code', {}));
  ok(/^[A-Za-z0-9_-]{12}$/.test(lc.code), `link code ${lc.code} fits /start parameter`);
  await expectError(as(U.office_engineer, () => rpc('tg_link_chat', { code: lc.code, chat_id: 1 })), /permission denied/,
    'clients cannot call service-only tg_link_chat');
  const old = await as(U.coordinator, () => rpc('create_telegram_link_code', {}));
  await db.query(`update telegram_link_codes set expires_at = now() - interval '1 minute' where code = $1`, [old.code]);
  ok((await asService(() => rpc('tg_link_chat', { code: old.code, chat_id: 1001 }))).ok === false, 'expired link code refused');
  ok((await asService(() => rpc('tg_link_chat', { code: lc.code, chat_id: 1002, username: 'oe_bot_user' }))).ok === true, 'office engineer linked chat 1002');
  ok((await asService(() => rpc('tg_link_chat', { code: lc.code, chat_id: 1003 }))).ok === false, 'link code is single-use');
  const lc2 = await as(U.coordinator, () => rpc('create_telegram_link_code', {}));
  await asService(() => rpc('tg_link_chat', { code: lc2.code, chat_id: 1001 }));
  ok((await as(U.coordinator, () => all(`select chat_id from telegram_links`))).length === 1, 'user sees only own telegram link');

  const nOE = (await one(`select id from notifications where user_id = $1 and entity_id = $2`, [U.office_engineer, MR])).id;
  const plan = await asService(() => rpc('notification_dispatch_plan', { notification_id: nOE }));
  const btns = plan.telegram?.reply_markup?.inline_keyboard?.[0] ?? [];
  ok(plan.telegram?.chat_id == 1002 && btns.map((b) => b.text).join('/') === 'Review/Return', `dispatch plan: Telegram with buttons ${btns.map((b) => b.text).join('/')}`);
  ok(btns.every((b) => Buffer.byteLength(b.callback_data) <= 64 && C.parseTelegramCallback(b.callback_data)), 'callback data ≤ 64 bytes and parseable');
  const rv = C.parseTelegramCallback(btns[0].callback_data);
  const res = await asService(() => rpc('tg_run_action', { token: rv.token, action: rv.code, chat_id: 1002 }));
  const mr1 = await one(`select status, reviewed_by from material_requests where id = $1`, [MR]);
  ok(res.ok && mr1.status === 'reviewed' && mr1.reviewed_by === U.office_engineer, 'Telegram "Review" ran mr_action as the linked office engineer');
  ok((await one(`select count(*)::int n from audit_log where table_name = 'material_requests' and record_id = $1 and user_id = $2`,
    [MR, U.office_engineer])).n >= 1, 'audit trail attributes the change to that user');
  await expectError(asService(() => rpc('tg_run_action', { token: rv.token, action: 'rv', chat_id: 1002 })), /already used/, 'token is single-use');
  const rt = C.parseTelegramCallback(btns[1].callback_data);
  await expectError(asService(() => rpc('tg_run_action', { token: rt.token, action: 'rt', chat_id: 1002 })), /already used/,
    'sibling button of the same message is consumed too');

  const nCO = (await one(`select id from notifications where user_id = $1 and entity_id = $2`, [U.coordinator, MR])).id;
  const plan2 = await asService(() => rpc('notification_dispatch_plan', { notification_id: nCO }));
  const b2 = Object.fromEntries((plan2.telegram?.reply_markup?.inline_keyboard?.[0] ?? []).map((b) => [b.text, C.parseTelegramCallback(b.callback_data)]));
  ok(b2.Approve && b2.Reject && b2.Return, 'coordinator gets Approve/Reject/Return after review');
  await expectError(asService(() => rpc('tg_run_action', { token: b2.Approve.token, action: 'ap', chat_id: 9999 })), /not linked/,
    'button pressed from another chat is refused');
  await expectError(asService(() => rpc('tg_run_action', { token: b2.Reject.token, action: 'rj', chat_id: 1001 })), /reason is required/,
    'reject without reason fails (approval rules apply)');
  ok((await one(`select used_at from telegram_action_tokens where token = $1`, [b2.Reject.token])).used_at === null, 'failed action leaves token usable');
  const apOnly = (await one(`select app.issue_action_token($1, $2, 'material_request', $3, '{approve}') t`, [U.coordinator, P, MR])).t;
  await expectError(asService(() => rpc('tg_run_action', { token: apOnly, action: 'rj', chat_id: 1001, comment: 'x' })), /not allowed here/,
    "token's action set enforced (approve-only token can't reject)");
  await asService(() => rpc('tg_run_action', { token: b2.Approve.token, action: 'ap', chat_id: 1001 }));
  const mr2 = await one(`select status, approved_by from material_requests where id = $1`, [MR]);
  ok(mr2.status === 'approved' && mr2.approved_by === U.coordinator, 'Telegram "Approve" approved as coordinator');
  ok((await one(`select count(*)::int n from app.processed_ops where user_id = $1 and fn = 'mr_action'`, [U.coordinator])).n === 1, 'outbox op recorded for the coordinator');
  const expTok = (await one(`select app.issue_action_token($1, $2, 'material_request', $3, '{approve}', interval '-1 hour') t`, [U.coordinator, P, MR])).t;
  await expectError(asService(() => rpc('tg_run_action', { token: expTok, action: 'ap', chat_id: 1001 })), /expired/, 'expired token refused');
  await expectError(as(U.coordinator, () => rpc('tg_run_action', { token: expTok, action: 'ap' })), /permission denied/,
    'clients cannot call tg_run_action');

  // GP4 approved from Telegram by the coordinator too
  const nGP = (await one(`select id from notifications where user_id = $1 and entity_id = $2`, [U.coordinator, GP4])).id;
  const plan3 = await asService(() => rpc('notification_dispatch_plan', { notification_id: nGP }));
  const gpBtn = C.parseTelegramCallback(plan3.telegram.reply_markup.inline_keyboard[0][0].callback_data);
  await asService(() => rpc('tg_run_action', { token: gpBtn.token, action: gpBtn.code, chat_id: 1001 }));
  ok((await one(`select status, approved_by from gate_passes where id = $1`, [GP4])).approved_by === U.coordinator, 'gate pass approved from Telegram');

  // preferences: quiet hours suppress push/Telegram for non-critical
  await as(U.office_engineer, () => rpc('set_notification_prefs', { op_id: uuid(), prefs: [{ event: '*', quiet_from: '00:00', quiet_to: '23:59:59' }] }));
  const nPU = (await one(`select id from notifications where user_id = $1 and entity_id = $2 and not is_critical`, [U.office_engineer, PU])).id;
  const plan4 = await asService(() => rpc('notification_dispatch_plan', { notification_id: nPU }));
  ok(plan4.quiet === true && plan4.push === false && plan4.telegram === null, 'quiet hours: no push / Telegram for normal notification');
  const plan4c = await asService(() => rpc('notification_dispatch_plan', { notification_id: nOE }));
  ok(plan4c.quiet === false && plan4c.push === true && plan4c.telegram, 'critical (urgent MR) notification ignores quiet hours');
  await as(U.office_engineer, () => rpc('set_notification_prefs', { op_id: uuid(), prefs: [{ event: '*' }, { event: 'material_request', push: false, telegram: true }] }));
  const plan5 = await asService(() => rpc('notification_dispatch_plan', { notification_id: nOE }));
  ok(plan5.push === false && plan5.telegram && !plan5.telegram.reply_markup, 'per-event pref: push off, Telegram on (no buttons once actioned)');

  // daily summary
  await as(U.coordinator, () => rpc('save_project_channel', { op_id: uuid(), id: uuid(), project_id: P, chat_id: -100123, title: 'BOLE site', kinds: ['daily_summary'] }));
  const today = (await one(`select app.eat_now()::date::text d`)).d;
  const ds = await asService(() => rpc('daily_summary_plan', { date: today }));
  ok(ds.messages.length === 1 && ds.messages[0].chat_id == -100123 && /Gate: 2 passes out, 1 MISMATCH/.test(ds.messages[0].text)
    && /E\.C\./.test(ds.messages[0].text), 'daily summary for the project channel (gate counts, both calendars)');
  console.log('    ' + ds.messages[0].text.split('\n').join('\n    '));

  // ---- Ethiopian calendar ------------------------------------------------
  console.log('\nEthiopian calendar');
  const known = [
    ['2026-09-11', 'Meskerem 1, 2019'], ['2026-09-10', 'Pagume 5, 2018'], ['2023-09-11', 'Pagume 6, 2015'],
    ['2023-09-12', 'Meskerem 1, 2016'], ['2025-01-07', 'Tahsas 29, 2017'], ['2000-01-01', 'Tahsas 22, 1992'],
    ['2026-10-29', 'Tikimt 19, 2019'], ['2024-09-11', 'Meskerem 1, 2017'],
  ];
  for (const [g, e] of known) {
    const sql = (await one(`select app.to_ethiopian($1::date) t`, [g])).t;
    const ts = C.formatEthiopian(g);
    const p = C.toEthiopian(g);
    const back = (await one(`select app.from_ethiopian($1, $2, $3)::text d`, [p.year, p.month, p.day])).d;
    ok(sql === e && ts === e && back === g && C.fromEthiopian(p.year, p.month, p.day) === g, `${g} = ${e} (SQL, TS, round trip)`);
  }
  ok((await one(`select app.to_ethiopian('2026-09-11', 'am') t`)).t === 'መስከረም 1, 2019' && C.formatEthiopian('2026-09-11', 'am') === 'መስከረም 1, 2019',
    'Amharic month names');
  await expectError(db.query(`select app.from_ethiopian(2018, 13, 6)`), /Invalid Ethiopian date/, 'Pagume 6 only in leap years (2018 is not)');
  const hamle1 = C.fromEthiopian(2016, 11, 1);
  ok((await one(`select app.eth_fiscal_year($1::date) a, app.eth_fiscal_year($1::date - 1) b`, [hamle1])).a === 2017 && C.ethiopianFiscalYear(hamle1) === 2017,
    `fiscal year starts Hamle 1 (${hamle1} → EFY 2017)`);
  await as(U.store_keeper, () => rpc('set_my_locale', { locale: 'am', calendar: 'ethiopian' }));
  ok((await one(`select locale, calendar from profiles where id = $1`, [U.store_keeper])).calendar === 'ethiopian', 'profile locale/calendar saved');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e.message, e.position ? `at position ${e.position}` : '', e.where ?? ''); process.exit(1); });
