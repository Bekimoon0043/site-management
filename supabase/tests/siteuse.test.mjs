// Site-use / look-ahead fixes (migration 20261102000022_e2e_siteuse_fixes.sql), found in the end-to-end run on the
// real 2B+G+15 schedule: (1) an element linked to several schedule tasks must not give every task its whole
// take-off — a take-off tagged with a BoQ item counts only for the tasks delivering that item; (2) a look-ahead
// "request from store" on a schedule item without its own element takes the block of the task's elements.
//
//   node supabase/tests/siteuse.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const MINE = '20261102000022_e2e_siteuse_fixes.sql';
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
  const skipped = [];
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
      console.log('  applied', f);
    } catch (e) {
      if (f === MINE || !OTHERS.includes(f)) throw new Error(`${f}: ${e.message}`);
      skipped.push(f); console.log('  SKIPPED (parallel work, failed to apply)', f, '—', e.message);
    }
  }
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);

  const U = {};
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role }, { role }]);
  }
  const P = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'APT', 'Apartment 2B+G+4')`, [P]);
    for (const r of Object.keys(U).filter((r) => r !== 'admin')) await db.query(`insert into project_members values ($1, $2)`, [P, U[r]]);
  });

  // =====================================================================
  console.log('\nImport a schedule in the "BoQ in the schedule" format');
  const amt = (q, r) => String(Math.round(q * r * 1.15 * 100) / 100);
  const T = (uid, wbs, lvl, name, s, f, dur, extra = {}) => ({ uid, guid: `G-${uid}`, id: uid, name, wbs, outline_number: wbs, outline_level: lvl,
    is_summary: false, is_milestone: false, start: s, finish: f, duration_days: dur, ...extra });
  const B = (unit, q, r) => ({ custom: { Text1: unit, Number1: String(q), Number2: String(r), Cost1: amt(q, r) }, cost: Number(amt(q, r)) });
  const junk = { custom: { Number1: '45', Number2: '2', Cost1: '999999' } };      // MSP roll-up on summaries
  const file = {
    source: 'mspdi', file_name: 'apt.xml', file_sha256: 'apt-1',
    header: { name: 'Apartment', start_date: '2026-09-01', minutes_per_day: 480, minutes_per_week: 2880, days_per_month: 26, currency_code: 'ETB', baseline_for_ev: 0 },
    calendars: [{ uid: 1, name: 'Apt calendar (6days work week)', is_base: true,
      week: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, working: dow !== 0, minutes: dow ? 480 : 0 })), exceptions: [] }],
    project_calendar_uid: 1, warnings: [],
    custom_fields: [{ field_id: 188743731, field_name: 'Text1', alias: 'Unit' }, { field_id: 188743767, field_name: 'Number1', alias: 'Qty' },
      { field_id: 188743768, field_name: 'Number2', alias: 'Rate' }, { field_id: 188743786, field_name: 'Cost1', alias: 'Amount' }],
    tasks: [
      { ...T(1, '1.2', 1, 'SUB STRUCTURE', '2026-09-01', '2026-09-26', 22), is_summary: true, ...junk },
      { ...T(2, '1.2.1', 2, '1. EXCAVATION & EARTHWORK', '2026-09-01', '2026-09-10', 9), is_summary: true, ...junk },
      T(3, '1.2.1.1', 3, 'Bulk excavation in ordinary soil to a depth not exceeding 1500mm from RL.', '2026-09-01', '2026-09-05', 5, B('m³', 850, 180)),
      T(4, '1.2.1.2', 3, 'Site clearing', '2026-09-07', '2026-09-08', 2, B('m2', 1200, 35)),
      { ...T(5, '1.2.2', 2, '4. SUB-STRUCTURAL CONCRETE WORK', '2026-09-09', '2026-09-26', 15), is_summary: true, ...junk },
      { ...T(6, '1.2.2.1', 3, 'Concrete C-25 in…', '2026-09-09', '2026-09-26', 15), is_summary: true, ...junk },
      T(7, '1.2.2.1.1', 4, 'a) In Flat Mat slab', '2026-09-09', '2026-09-15', 6, B('m3', 420, 6500)),
      T(8, '1.2.2.1.2', 4, 'b) In retaining wall', '2026-09-16', '2026-09-26', 10, B('M3', 160, 6800)),
      T(9, '1.2.3', 2, 'Reinforcement bar', '2026-09-09', '2026-09-22', 12, B('Kg', 54000, 120)),
      T(10, '1.2.4', 2, 'Sub-structure complete', '2026-09-26', '2026-09-26', 0, { is_milestone: true }),
    ],
    links: [{ pred_uid: 3, succ_uid: 4, type: 'FS', lag_days: 0 }, { pred_uid: 4, succ_uid: 7, type: 'FS', lag_days: 0 },
      { pred_uid: 7, succ_uid: 8, type: 'FS', lag_days: 0 }, { pred_uid: 4, succ_uid: 9, type: 'SS', lag_days: 0 }, { pred_uid: 8, succ_uid: 10, type: 'FS', lag_days: 0 }],
  };
  const SCH = uuid();
  const ri = await as(U.coordinator, () => rpc('import_schedule', { op_id: uuid(), project_id: P, schedule_id: SCH, schedule: file }));
  ok(ri.added === 10, `schedule imported (${ri.added} tasks)`);
  const cal = await one(`select c.use_public_holidays u, c.name, (select count(*)::int from calendar_exceptions e where e.calendar_id = c.id) x
                         from project_calendars c where project_id = $1 and is_default`, [P]);
  ok(cal.u === true && cal.x === 0 && /6days/.test(cal.name), 'imported calendar without exceptions still uses Ethiopian public holidays');
  ok((await one(`select app.is_working_day($1, '2026-09-11') w`, [P])).w === false, 'Enkutatash is a non-working day on the imported calendar');

  await as(U.coordinator, () => rpc('create_boq_from_schedule', { op_id: uuid(), schedule_id: SCH, unit_field: 'Unit', qty_field: 'Qty',
    rate_field: 'Rate', amount_field: 'Amount', vat_included: true }));
  const task = async (uid) => one(`select * from schedule_tasks where schedule_id = $1 and msp_uid = $2`, [SCH, uid]);
  const conc = await task(7), rebar = await task(9), clear = await task(4);
  const boq = async (no) => (await one(`select id from boq_items where project_id = $1 and item_no = $2`, [P, no])).id;
  const spec = async (name, grade) => (await one(
    `select s.id from material_specs s join materials m on m.id = s.material_id where m.name = $1 and s.grade = $2`, [name, grade])).id;
  const R20 = await spec('Rebar', 'S-500 Ø20'), CONC = await spec('Concrete', 'C-25/30'), CEM = await spec('Cement', 'OPC 42.5');
  const BLK = uuid(), S = uuid(), MAT = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'A', 'Block A')`, [BLK, P]);
    await db.query(`insert into stores (id, project_id, name, store_type) values ($1, $2, 'Main store', 'main')`, [S, P]);
    await db.query(`insert into elements (id, project_id, block_id, code, element_type) values ($1, $2, $3, 'MAT-1', 'footing')`, [MAT, P, BLK]);
  });
  await db.query(`insert into element_takeoffs (project_id, element_id, material_spec_id, planned_qty, boq_item_id) values
    ($1, $2, $3, 420, $4), ($1, $2, $5, 30000, $6), ($1, $2, $7, 60, null)`, [P, MAT, CONC, await boq('1.2.2.1.1'), R20, await boq('1.2.3'), CEM]);
  await db.query(`insert into stock_ledger (project_id, store_id, material_spec_id, qty, stock_status, txn_type, doc_type, doc_id, doc_number, txn_at)
    values ($1, $2, $3, 5000, 'available', 'opening', 'opening', $4, 'OPENING', now()), ($1, $2, $5, 100, 'available', 'opening', 'opening', $4, 'OPENING', now())`, [P, S, R20, uuid(), CEM]);
  // one mat-slab element linked to its concrete task and its rebar task (as an office engineer does in the task drawer)
  for (const t of [conc, rebar]) await as(U.office_engineer, () => rpc('save_task_setup', { op_id: uuid(), task_id: t.id, element_links: [{ element_id: MAT }] }));
  ok((await one(`select count(*)::int c from task_element_links where element_id = $1 and deleted_at is null`, [MAT])).c === 2, 'element MAT-1 linked to 2 tasks');

  console.log('\nLook-ahead material needs per task');
  await db.query(`select set_config('app.lookahead_today', '2026-08-25', false)`);
  const gen = await as(U.office_engineer, () => rpc('generate_lookahead', { op_id: uuid(), project_id: P, calendar_mode: 'gregorian', month: '2026-09' }));
  const PLAN = gen.plan_id ?? gen.id;
  ok(!!PLAN, `September look-ahead generated (${PLAN})`);
  const needs = await all(`select i.schedule_task_id t, c.material_spec_id s, c.total_need n from app.la_material_calc($1) c join lookahead_items i on i.id = c.item_id`, [PLAN]);
  const on = (t, s) => needs.filter((x) => x.t === t.id && x.s === s);
  ok(on(rebar, R20).length === 1 && on(conc, R20).length === 0, 'rebar take-off (BoQ 1.2.3) counts only for the rebar task, not the concrete task');
  ok(on(conc, CONC).length === 1 && on(rebar, CONC).length === 0, 'concrete take-off (BoQ 1.2.2.1.1) counts only for the concrete task');
  ok(on(rebar, CEM).length === 1 && on(conc, CEM).length === 1, 'an untagged take-off still counts for every linked task');
  ok(needs.filter((x) => x.s === R20).reduce((a, x) => a + Number(x.n), 0) >= 30000 && needs.filter((x) => x.s === R20).reduce((a, x) => a + Number(x.n), 0) < 2 * 30000,
    'the rebar is needed once, not once per linked task');
  const cl = await one(`select id from lookahead_items where plan_id = $1 and schedule_task_id = $2`, [PLAN, clear.id]);
  ok(!!cl && on(clear, R20).length === 0, 'a task without elements gets nothing from MAT-1');

  console.log('\nRequest from store on a schedule item without its own element');
  // TWR case: the item carries no element of its own (elements are linked to the task, BoQ-driven schedule)
  await db.query(`update lookahead_items set element_id = null where plan_id = $1 and schedule_task_id = $2`, [PLAN, rebar.id]);
  const it = await one(`select id, element_id from lookahead_items where plan_id = $1 and schedule_task_id = $2`, [PLAN, rebar.id]);
  ok(it && it.element_id === null, 'the rebar item has no element of its own');
  const sur = await as(U.site_engineer, () => rpc('create_sur_from_lookahead', { op_id: uuid(), item_id: it.id, submit: true }));
  const mr = await one(`select block_id, status, request_type from material_requests where id = $1`, [sur.id]);
  ok(mr.block_id === BLK && mr.status === 'submitted' && mr.request_type === 'site_use', `site-use request submitted with the block of the task's element (${sur.number})`);
  const ln = await all(`select material_spec_id, qty from mr_lines where mr_id = $1 and deleted_at is null`, [sur.id]);
  ok(ln.some((l) => l.material_spec_id === R20 && Number(l.qty) === 5000), 'requests the 5000 kg of Ø20 in stock');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
