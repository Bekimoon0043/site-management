// Site operations test (migration 20261105000030_site_ops.sql): HSE incidents (report → investigate → close, labour-office notification rule), toolbox talks, permits to work
// (precautions, no self-approval, expiry), plant register + daily log (meter checks, breakdown), inbox items and access.
//
//   node supabase/tests/site-ops.test.mjs

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
const rpc = async (name, p) => (await db.query(`select public.${name}($1::jsonb) as r`, [JSON.stringify({ op_id: uuid(), ...p })])).rows[0].r;
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
async function expectError(promise, pattern, msg) {
  try { await promise; ok(false, `${msg} (no error raised)`); }
  catch (e) { ok(pattern.test(e.message), `${msg} → "${e.message}"`); }
}
const inbox = (u, id) => as(u, () => all(`select * from v_my_approvals where entity_id = $1`, [id]));
const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);

async function main() {
  console.log('Applying migrations…');
  await db.exec(STUBS);
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    try { await db.exec(readFileSync(join(root, 'migrations', f), 'utf8')); }
    catch (e) {
      // other modules' migrations written in parallel may not apply yet; this module's must
      if (f.startsWith('20261105000030') || f < '20261105') throw new Error(`${f}: ${e.message}`);
      console.log('  SKIPPED (other module, failed to apply)', f, '—', e.message);
    }
  }
  await db.exec(readFileSync(join(root, 'migrations', '20261105000030_site_ops.sql'), 'utf8'));   // re-runnable
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);
  ok(true, 'migrations applied, site ops migration re-runs cleanly');

  const U = {};
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper', 'procurement']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role }, { role }]);
  }
  const P = uuid(), P2 = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'TWR', 'Tower'), ($2, 'OTH', 'Other')`, [P, P2]);
    for (const r of Object.keys(U).filter((r) => r !== 'admin')) await db.query(`insert into project_members values ($1, $2)`, [P, U[r]]);
  });

  // =====================================================================
  console.log('\nHSE incidents');
  const I = uuid();
  await expectError(as(U.store_keeper, () => rpc('report_incident', { id: I, project_id: P, kind: 'injury', occurred_at: new Date().toISOString(), description: 'Cut hand' })),
    /name of the injured/, 'injury needs the injured person');
  await expectError(as(U.store_keeper, () => rpc('report_incident', { id: I, project_id: P, kind: 'near_miss', occurred_at: new Date(Date.now() + 86400e3).toISOString(), description: 'x' })),
    /future/, 'cannot happen in the future');
  const inc = await as(U.store_keeper, () => rpc('report_incident', { id: I, project_id: P, kind: 'injury', severity: 'serious', occurred_at: new Date(Date.now() - 3600e3).toISOString(),
    description: 'Labourer fell from 2nd floor scaffold, broken arm', injured_name: 'Tesfaye G.', injured_party: 'own', hospital: true, lost_time: true, days_lost: 21,
    immediate_action: 'First aid, taken to hospital' }));
  ok(inc.number === 'TWR-INC-0001' && inc.status === 'reported', `anyone on the project can report (${inc.number}, store keeper)`);
  const crit = await as(U.manager, () => one(`select is_critical from notifications where entity_id = $1`, [I]));
  ok(crit?.is_critical === true, 'manager gets a critical notification');
  ok((await inbox(U.coordinator, I))[0]?.is_urgent === true, 'coordinator inbox: investigate (urgent)');
  await expectError(as(U.site_engineer, () => rpc('incident_action', { incident_id: I, action: 'investigate', root_cause: 'x', corrective_action: 'y' })), /not allowed/, 'site engineer cannot investigate');
  await expectError(as(U.coordinator, () => rpc('incident_action', { incident_id: I, action: 'close' })), /Investigate/, 'cannot close before investigation');
  await as(U.coordinator, () => rpc('incident_action', { incident_id: I, action: 'investigate', root_cause: 'Missing guard rail and toe board on scaffold bay 4',
    corrective_action: 'Install guard rails on all bays; daily scaffold inspection tag', action_owner: U.site_engineer, action_due: day(2) }));
  ok((await inbox(U.site_engineer, I))[0]?.actions[0] === 'action', 'action owner gets the corrective action in the inbox');
  await expectError(as(U.coordinator, () => rpc('incident_action', { incident_id: I, action: 'close' })), /labour inspection/, 'lost-time injury needs the labour-office notification before closing');
  await as(U.coordinator, () => rpc('incident_action', { incident_id: I, action: 'close', reported_to_authority: true, authority_ref: 'AA LSA 2026/118', close_note: 'Rails installed' }));
  ok((await one(`select status, authority_ref from hse_incidents where id = $1`, [I])).status === 'closed', 'closed after recording the notification');
  const NM = uuid();
  await as(U.site_engineer, () => rpc('report_incident', { id: NM, project_id: P, kind: 'near_miss', occurred_at: new Date().toISOString(), description: 'Bucket swung near workers' }));
  ok((await one(`select number from hse_incidents where id = $1`, [NM])).number === 'TWR-INC-0002', 'near miss numbered next');
  await expectError(as(U.store_keeper, () => rpc('report_incident', { id: NM, project_id: P, kind: 'near_miss', occurred_at: new Date().toISOString(), description: 'edit' })),
    /Only the reporter/, 'others cannot edit a report');

  // =====================================================================
  console.log('\nToolbox talks');
  const T = uuid();
  await expectError(as(U.site_engineer, () => rpc('save_toolbox_talk', { id: T, project_id: P, held_on: day(0), topic: 'Scaffold safety', attendees_count: 0 })), /attended/, 'attendance required');
  await expectError(as(U.site_engineer, () => rpc('save_toolbox_talk', { id: T, project_id: P, held_on: day(2), topic: 'x', attendees_count: 3 })), /future/, 'no future dates');
  const tb = await as(U.site_engineer, () => rpc('save_toolbox_talk', { id: T, project_id: P, held_on: day(0), topic: 'Working at height after the fall', hazards: 'Open edges, scaffold',
    attendees_count: 34, trades: ['Mason', 'Daily labourer'], ppe_checked: true, ppe_issues: '3 without harness — issued' }));
  ok(tb.number === 'TWR-TBT-0001' && (await one(`select trades from toolbox_talks where id = $1`, [T])).trades.length === 2, `toolbox talk ${tb.number} with trades`);
  await expectError(as(U.store_keeper, () => rpc('save_toolbox_talk', { id: uuid(), project_id: P, held_on: day(0), topic: 'x', attendees_count: 3 })), /not allowed/, 'store keeper does not record toolbox talks');

  // =====================================================================
  console.log('\nPermits to work');
  const W = uuid();
  const from = new Date(Date.now() - 600e3).toISOString(), to = new Date(Date.now() + 8 * 3600e3).toISOString();
  await expectError(as(U.site_engineer, () => rpc('request_permit', { id: W, project_id: P, permit_type: 'hot_work', description: 'Weld stair', valid_from: from, valid_to: to, precautions: [] })),
    /precautions/, 'precautions required');
  await expectError(as(U.site_engineer, () => rpc('request_permit', { id: W, project_id: P, permit_type: 'hot_work', description: 'Weld', valid_from: from,
    valid_to: new Date(Date.now() + 9 * 86400e3).toISOString(), precautions: [{ text: 'x', done: true }] })), /at most 7 days/, 'max 7 days');
  const pw = await as(U.site_engineer, () => rpc('request_permit', { id: W, project_id: P, permit_type: 'hot_work', description: 'Weld steel stair to landing beam', location_text: 'Core B, L3',
    valid_from: from, valid_to: to, crew_size: 2, supervisor_name: 'Foreman Abel',
    precautions: [{ text: 'Fire extinguisher at the work place', done: true }, { text: 'Combustibles removed 10 m', done: false }, { text: 'Fire watch 30 min after', done: true }] }));
  ok(pw.number === 'TWR-PTW-0001', `requested ${pw.number}`);
  ok((await inbox(U.coordinator, W)).length === 1 && (await inbox(U.site_engineer, W)).length === 0, 'coordinator inbox (not the requester)');
  await expectError(as(U.site_engineer, () => rpc('permit_action', { permit_id: W, action: 'approve' })), /not allowed/, 'site engineer cannot approve');
  await expectError(as(U.coordinator, () => rpc('permit_action', { permit_id: W, action: 'approve' })), /Not all precautions/, 'all precautions must be in place');
  await as(U.coordinator, () => rpc('permit_action', { permit_id: W, action: 'approve', precautions: [{ text: 'Fire extinguisher at the work place', done: true },
    { text: 'Combustibles removed 10 m', done: true }, { text: 'Fire watch 30 min after', done: true }] }));
  ok((await one(`select status, approved_by from work_permits where id = $1`, [W])).approved_by === U.coordinator, 'approved after checking precautions');
  const W2 = uuid();
  await as(U.coordinator, () => rpc('request_permit', { id: W2, project_id: P, permit_type: 'lifting', description: 'Lift precast stairs', valid_from: from, valid_to: to,
    precautions: [{ text: 'Lifting plan', done: true }] }));
  await expectError(as(U.coordinator, () => rpc('permit_action', { permit_id: W2, action: 'approve' })), /own permit/, 'no self-approval');
  await expectError(as(U.manager, () => rpc('permit_action', { permit_id: W2, action: 'reject' })), /why/, 'reject needs a reason');
  await as(U.manager, () => rpc('permit_action', { permit_id: W2, action: 'reject', comment: 'Crane certificate expired' }));
  ok((await one(`select status from work_permits where id = $1`, [W2])).status === 'rejected', 'manager rejected with a reason');
  await db.query(`update work_permits set valid_to = now() - interval '1 hour', valid_from = now() - interval '9 hours' where id = $1`, [W]);
  ok((await inbox(U.site_engineer, W))[0]?.actions[0] === 'close', 'expired permit asks the requester to close it');
  await as(U.site_engineer, () => rpc('permit_action', { permit_id: W, action: 'close', comment: 'Work finished, area checked' }));
  ok((await one(`select status from work_permits where id = $1`, [W])).status === 'closed', 'closed');

  // =====================================================================
  console.log('\nPlant & equipment');
  const X = uuid();
  await expectError(as(U.store_keeper, () => rpc('save_plant', { id: X, project_id: P, code: 'EX-01', name: 'Excavator' })), /not allowed/, 'store keeper cannot add plant');
  await as(U.site_engineer, () => rpc('save_plant', { id: X, project_id: P, code: 'EX-01', name: 'CAT 320 excavator', category: 'excavator', ownership: 'hired', supplier: 'Abay Rental', last_meter: 1200 }));
  await expectError(as(U.site_engineer, () => rpc('save_plant', { id: uuid(), project_id: P, code: 'EX-01', name: 'dup' })), /already used/, 'plant code unique');
  const L1 = uuid();
  const l1 = await as(U.store_keeper, () => rpc('log_plant', { id: L1, plant_id: X, log_date: day(-2), operator_name: 'Kebede', meter_start: 1200, meter_end: 1208.5, hours_idle: 1, fuel_litres: 120, work_done: 'Bulk excavation zone A' }));
  ok(Number(l1.hours_worked) === 8.5, `hours from the meter: ${l1.hours_worked} (store keeper / timekeeper logs)`);
  await expectError(as(U.site_engineer, () => rpc('log_plant', { id: uuid(), plant_id: X, log_date: day(-2), meter_start: 1208.5, meter_end: 1210 })), /already logged/, 'one log per machine per day');
  await expectError(as(U.site_engineer, () => rpc('log_plant', { id: uuid(), plant_id: X, log_date: day(-1), meter_start: 1205, meter_end: 1210 })), /lower than the last reading/, 'meter cannot go backwards');
  await expectError(as(U.site_engineer, () => rpc('log_plant', { id: uuid(), plant_id: X, log_date: day(-1), meter_start: 1210, meter_end: 1209 })), /closing meter/i, 'closing below opening');
  await expectError(as(U.site_engineer, () => rpc('log_plant', { id: uuid(), plant_id: X, log_date: day(0), status: 'breakdown' })), /Describe the breakdown/, 'breakdown needs a note');
  const L2 = uuid();
  await as(U.site_engineer, () => rpc('log_plant', { id: L2, plant_id: X, log_date: day(-1), meter_start: 1208.5, meter_end: 1212.5, hours_breakdown: 5, fuel_litres: 60,
    status: 'breakdown', breakdown_note: 'Hydraulic hose burst' }));
  const px = await one(`select status, last_meter from plant_items where id = $1`, [X]);
  ok(px.status === 'under_repair' && Number(px.last_meter) === 1212.5, 'breakdown puts it under repair; last meter updated');
  ok((await as(U.coordinator, () => one(`select count(*)::int n from notifications where entity_id = $1`, [L2]))).n === 1, 'coordinator told about the breakdown');
  await as(U.site_engineer, () => rpc('log_plant', { id: uuid(), plant_id: X, log_date: day(0), meter_start: 1212.5, meter_end: 1219.5, fuel_litres: 100 }));
  ok((await one(`select status from plant_items where id = $1`, [X])).status === 'active', 'working again → active');
  const u = await as(U.coordinator, () => one(`select * from plant_utilisation($1, $2, $3)`, [P, day(-7), day(0)]));
  ok(u.days_logged === 3 && Number(u.hours_worked) === 19.5 && Number(u.utilisation_pct) === 76.5 && Number(u.litres_per_hour) === 14.36,
    `utilisation ${u.utilisation_pct} % (19.5 worked of 25.5 h), ${u.litres_per_hour} l/h`);

  // =====================================================================
  console.log('\nAccess');
  await expectError(as(U.site_engineer, () => db.query(`insert into toolbox_talks (id, project_id, number, held_on, topic, attendees_count, created_by) values ($1, $2, 'x', current_date, 'x', 1, $3)`, [uuid(), P, U.site_engineer])),
    /row-level security|permission/, 'no direct table writes');
  await expectError(as(U.site_engineer, () => rpc('save_toolbox_talk', { id: uuid(), project_id: P2, held_on: day(0), topic: 'x', attendees_count: 2 })), /not assigned to this project/, 'not on the other project');
  ok((await as(U.procurement, () => one(`select count(*)::int n from hse_incidents`))).n === 2, 'every project member reads the HSE register');
  ok((await as(U.site_engineer, () => one(`select count(*)::int n from plant_utilisation($1, $2, $3)`, [P2, day(-7), day(0)]))).n === 0, 'utilisation of another project is empty');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
