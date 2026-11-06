// Client portal security: external clients see only assigned project identity
// and the narrow progress views; internal tables and all writes stay blocked.

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant execute on all functions in schema auth to authenticated, service_role;
`;

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ✓', msg); } else { failed++; console.log('  ✗', msg); } };
async function as(userId, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', '', false)`, [userId]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
async function expectError(promise, pattern, msg) {
  try { await promise; ok(false, `${msg} (no error)`); }
  catch (e) { ok(pattern.test(e.message), `${msg} → ${e.message}`); }
}

try {
  await db.exec(STUBS);
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
  }
  await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated`);

  const manager = uuid(), client = uuid(), other = uuid(), project = uuid(), schedule = uuid();
  for (const [id, role] of [[manager, 'manager'], [client, 'client'], [other, 'site_engineer']]) {
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [id, `${role}@test.et`, { full_name: role }, { role }]);
  }
  await db.query(`insert into projects (id, code, name, client) values ($1, 'CLT', 'Client portal test', 'Owner')`, [project]);
  await db.query(`insert into project_members (project_id, user_id) values ($1, $2), ($1, $3)`, [project, manager, client]);
  await db.query(`insert into materials (id, category, name) values ($1, 'Internal', 'Internal material')`, [uuid()]);
  await db.query(`insert into schedules (id, project_id, code, name, status_date) values ($1, $2, 'MASTER', 'Published programme', '2026-11-04')`, [schedule, project]);
  const summary = uuid(), task = uuid();
  await db.query(`insert into schedule_tasks
    (id, project_id, schedule_id, msp_uid, msp_id, wbs, outline_level, parent_id, sort_order, name, is_summary, planned_start, planned_finish, pct_complete)
    values ($1,$3,$4,10,10,'1',1,null,10,'Works',true,'2026-01-01','2026-12-31',40),
           ($2,$3,$4,20,20,'1.1',2,$1,20,'Foundations',false,'2026-01-01','2026-02-28',100)`,
    [summary, task, project, schedule]);
  await db.query(`insert into client_contracts (project_id, contract_no, contract_sum, updated_by)
    values ($1, 'OWNER-01', 1000000, $2)`, [project, manager]);
  await db.query(`insert into site_diaries
    (id, project_id, number, diary_date, work_summary, safety_notes, notes, status, created_by)
    values ($1, $2, 'DR-001', '2026-11-04', 'Foundation concrete completed', 'Internal safety note', 'Internal diary note', 'signed', $3)`,
    [uuid(), project, manager]);
  const photo = uuid(), risk = uuid(), variation = uuid();
  await db.query(`insert into attachments
    (id, project_id, entity_type, entity_id, kind, storage_path, mime_type, caption, created_by)
    values ($1, $2, 'site', $2, 'photo', $3, 'image/jpeg', 'Approved foundation progress', $4)`,
    [photo, project, `${project}/site/${photo}.jpg`, manager]);
  await db.query(`insert into risks
    (id, project_id, number, kind, title, description, category, likelihood, impact, response, cost_exposure, created_by)
    values ($1, $2, 'R-001', 'risk', 'Internal risk title', 'Private root cause', 'design', 4, 4, 'Private response', 900000, $3)`,
    [risk, project, manager]);
  await db.query(`insert into variations
    (id, project_id, number, title, status, amount, completion_date_impact_days, revised_completion_date, created_by, approved_by, decided_at)
    values ($1, $2, 'VO-001', 'Approved client change', 'approved', 125000, 7, '2027-01-07', $3, $3, now())`,
    [variation, project, manager]);
  await db.query(`update schedule_tasks set is_milestone = true where id = $1`, [task]);

  console.log('\nClient read boundary');
  ok((await as(client, () => all(`select id from profiles`))).length === 1, 'client sees only their own profile');
  ok((await as(client, () => all(`select id from projects`))).length === 1, 'client sees the assigned project');
  ok((await as(client, () => all(`select id from materials`))).length === 0, 'global internal master data is hidden');
  ok((await as(client, () => all(`select id from schedules`))).length === 0, 'base schedule table is hidden');
  ok((await as(client, () => all(`select project_id from client_contracts`))).length === 0, 'base commercial table is hidden');
  ok((await as(client, () => all(`select id from v_client_schedules`))).length === 1, 'safe schedule header is visible');
  const tasks = await as(client, () => all(`select task_no, wbs, name from v_client_schedule_tasks order by task_no`));
  ok(tasks.length === 2 && tasks[0].task_no === 1 && tasks[1].task_no === 2, 'client Task IDs are dense 1..N');
  ok(!('notes' in tasks[0]) && !('custom' in tasks[0]), 'client task rows omit internal notes and custom fields');
  const evm = await as(client, () => all(`select * from v_client_dashboard_evm`));
  ok(evm.length === 1 && !('ac' in evm[0]) && !('cpi' in evm[0]), 'client EVM omits contractor actual cost and CPI');
  const finance = await as(client, () => all(`select current_contract_value from v_client_financial_summary`));
  ok(finance.length === 1 && Number(finance[0].current_contract_value) === 1000000, 'client sees the owner-facing contract total');
  const daily = await as(client, () => all(`select * from v_client_daily_updates`));
  ok(daily.length === 1 && daily[0].work_summary === 'Foundation concrete completed' && !('notes' in daily[0]) && !('safety_notes' in daily[0]),
    'client daily update includes the public summary but omits internal notes');
  ok((await as(client, () => all(`select id from v_client_photos`))).length === 0, 'unapproved photos are hidden from the client');
  ok((await as(client, () => all(`select id from v_client_risks`))).length === 0, 'unpublished risks are hidden from the client');
  await as(manager, () => db.query(`select set_attachment_client_visibility($1::jsonb)`, [JSON.stringify({ id: photo, visible: true })]));
  await as(manager, () => db.query(`select set_risk_client_visibility($1::jsonb)`, [JSON.stringify({ id: risk, visible: true, summary: 'Design information may affect one work area', mitigation: 'Weekly design review is in progress' })]));
  await as(manager, () => db.query(`select set_client_milestone_update($1::jsonb)`, [JSON.stringify({ task_id: task, recovery_action: 'Add a second work front and review weekly' })]));
  const photos = await as(client, () => all(`select * from v_client_photos`));
  ok(photos.length === 1 && photos[0].caption === 'Approved foundation progress' && photos[0].approved_by_role === 'manager' && !('created_by' in photos[0]) && !('client_approved_by' in photos[0]), 'client sees approved photo metadata and approver role, never identity');
  const risks = await as(client, () => all(`select * from v_client_risks`));
  ok(risks.length === 1 && risks[0].summary.includes('Design information') && risks[0].approved_by_role === 'manager' && !('description' in risks[0]) && !('cost_exposure' in risks[0]) && !('client_approved_by' in risks[0]),
    'client risk view exposes approved wording and approver role, not internal cause, cost or identity');
  const milestones = await as(client, () => all(`select * from v_client_milestones`));
  ok(milestones.length === 1 && milestones[0].recovery_action.includes('second work front') && milestones[0].recovery_updated_by_role === 'manager' && !('client_recovery_updated_by' in milestones[0]), 'client sees the published milestone recovery action and approver role, not identity');
  const variations = await as(client, () => all(`select * from v_client_variations`));
  ok(variations.length === 1 && Number(variations[0].amount) === 125000 && variations[0].completion_date_impact_days === 7 && variations[0].approved_by_role === 'manager' && !('approved_by' in variations[0]),
    'client sees approved variation value, date effect and approver role, not identity');
  const history = await as(client, () => all(`select * from client_progress_history($1, 'week', 3)`, [schedule]));
  ok(history.length === 3 && history.every((x) => !('ac' in x) && !('cpi' in x)), 'client progress history returns three safe planned/verified points');
  const publication = await as(client, () => all(`select * from v_client_publication_status`));
  ok(publication.length === 1 && publication[0].last_updated, 'client sees last-updated and verified-through metadata');
  ok((await as(client, () => all(`select app.storage_path_visible($1) visible`, [`${project}/site/${photo}.jpg`])))[0].visible === true,
    'client storage access is allowed for the approved photo');

  console.log('\nClient write boundary');
  await as(client, () => db.query(`update profiles set full_name = 'Changed' where id = $1`, [client]));
  ok((await db.query(`select full_name from profiles where id = $1`, [client])).rows[0].full_name === 'client', 'client cannot update even their own profile');
  await expectError(as(client, () => db.query(`insert into schedules (project_id, code, name) values ($1, 'X', 'No')`, [project])), /row-level security|policy/, 'client cannot create schedule data');
  await expectError(as(client, () => db.query(`select set_risk_client_visibility($1::jsonb)`, [JSON.stringify({ id: risk, visible: false })])), /role|allowed|action/i,
    'client cannot publish or unpublish risks');

  console.log('\nInternal roles unchanged');
  ok((await as(manager, () => all(`select id from materials`))).length === 1, 'internal role still sees master data');
  ok((await as(manager, () => all(`select id from schedules where project_id = $1`, [project]))).length === 1, 'internal role still sees schedule table');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  await db.close();
}
