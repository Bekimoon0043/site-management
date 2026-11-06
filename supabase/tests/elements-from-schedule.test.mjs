// Elements from the schedule (migration 20261103000040_elements_from_schedule.sql). Applies ALL migrations + seed in
// PGlite with the Supabase stubs used by the other suites.
//
// Scenario: a schedule shaped like the client's 2B+G+15 file (floor × trade × element; BoQ in custom fields) is
// imported and its BoQ created; the elements the web detector finds are written with create_elements_from_schedule:
// block / levels / elements matched or created, activity sequences, task links with activity ranges, take-offs tagged
// with BoQ items; idempotent re-runs, hand-made links kept, roles; the elements drive the look-ahead material needs.
//
//   node supabase/tests/elements-from-schedule.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const MINE = '20261103000040_elements_from_schedule.sql';
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
  console.log('\nImport a 2B+G+4 schedule shaped like the client file (floor × trade × element)');
  const amt = (q, r) => String(Math.round(q * r * 1.15 * 100) / 100);
  const T = (uid, parent, wbs, lvl, name, s, f, extra = {}) => ({ uid, guid: `G-${uid}`, id: uid, name, wbs, outline_number: wbs, outline_level: lvl,
    parent_uid: parent, is_summary: false, is_milestone: false, start: s, finish: f, duration_days: 5, ...extra });
  const S = (uid, parent, wbs, lvl, name) => T(uid, parent, wbs, lvl, name, '2026-11-02', '2026-11-30', { is_summary: true });
  const B = (unit, q, r) => ({ custom: { Text1: unit, Number1: String(q), Number2: String(r), Cost1: amt(q, r) }, cost: Number(amt(q, r)) });
  const file = {
    source: 'mspdi', file_name: 'apt.xml', file_sha256: 'apt-els-1',
    header: { name: '2B+G+4 Apartment', start_date: '2026-11-02', minutes_per_day: 480, minutes_per_week: 2880, days_per_month: 26, currency_code: 'ETB', baseline_for_ev: 0 },
    calendars: [{ uid: 1, name: 'Std', is_base: true, week: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, working: dow !== 0, minutes: dow ? 480 : 0 })), exceptions: [] }],
    project_calendar_uid: 1, warnings: [],
    custom_fields: [{ field_id: 188743731, field_name: 'Text1', alias: 'Unit' }, { field_id: 188743767, field_name: 'Number1', alias: 'Qty' },
      { field_id: 188743768, field_name: 'Number2', alias: 'Rate' }, { field_id: 188743786, field_name: 'Cost1', alias: 'Amount' }],
    tasks: [
      S(1, null, '1', 1, '2B+G+4 Apartment Building Master Schedule'),
      S(2, 1, '1.2', 2, ' SUB STRUCTURE'),
      S(3, 2, '1.2.5', 3, ' 4.2 REBAR'),
      T(4, 3, '1.2.5.1', 4, ' a) In Flat Mat slab', '2026-11-03', '2026-11-12', B('Kg', 42000, 120)),
      S(10, 1, '1.4', 2, ' SUPER STRUCTURE'),
      S(11, 10, '1.4.1', 3, 'Ground Floor'),
      S(12, 11, '1.4.1.1', 4, 'A] FORMWORK'),
      T(13, 12, '1.4.1.1.1', 5, ' c) To elevation Columns', '2026-11-13', '2026-11-16', B('m2', 220, 450)),
      S(14, 11, '1.4.1.2', 4, 'B] REBAR'),
      T(15, 14, '1.4.1.2.1', 5, ' c) To elevation Columns', '2026-11-13', '2026-11-17', B('kg', 9000, 120)),
      S(16, 11, '1.4.1.3', 4, 'C] CONCRETE CASTING'),
      T(17, 16, '1.4.1.3.1', 5, ' c) To elevation Columns', '2026-11-18', '2026-11-19', B('m3', 36, 6500)),
      S(20, 10, '1.4.2', 3, '1st Floor'),
      S(21, 20, '1.4.2.3', 4, 'C] CONCRETE CASTING'),
      T(22, 21, '1.4.2.3.1', 5, ' e) To Floor slab and Beam', '2026-11-20', '2026-11-24', B('m3', 110, 6600)),
    ],
    links: [{ pred_uid: 4, succ_uid: 13, type: 'FS', lag_days: 0 }, { pred_uid: 13, succ_uid: 15, type: 'SS', lag_days: 0 },
      { pred_uid: 15, succ_uid: 17, type: 'FS', lag_days: 0 }, { pred_uid: 17, succ_uid: 22, type: 'FS', lag_days: 0 }],
  };
  const SCH = uuid();
  const ri = await as(U.coordinator, () => rpc('import_schedule', { op_id: uuid(), project_id: P, schedule_id: SCH, schedule: file }));
  ok(ri.added === 15, `schedule imported (${ri.added} tasks)`);
  await as(U.coordinator, () => rpc('create_boq_from_schedule', { op_id: uuid(), schedule_id: SCH, unit_field: 'Unit', qty_field: 'Qty',
    rate_field: 'Rate', amount_field: 'Amount', vat_included: true }));
  const tid = async (uid) => (await one(`select id from schedule_tasks where schedule_id = $1 and msp_uid = $2`, [SCH, uid])).id;
  const boq = async (uid) => (await one(`select boq_item_id from task_boq_links where task_id = $1`, [await tid(uid)])).boq_item_id;
  ok((await one(`select parent_id from schedule_tasks where id = $1`, [await tid(17)])).parent_id === await tid(16), 'task tree kept (parents)');
  const spec = async (mat, grade) => (await one(`select s.id from material_specs s join materials m on m.id = s.material_id where m.name = $1 and s.grade = $2`, [mat, grade])).id;
  const R20 = await spec('Rebar', 'S-400 Ø20'), R16 = await spec('Rebar', 'S-400 Ø16'), C25 = await spec('Concrete', 'C-25/30');

  // the payload the web review screen sends (detector + norms) — see web/src/components/schedule/ElementsFromSchedule.tsx
  const payload = async () => ({
    schedule_id: SCH, block: { code: 'A', name: 'Main building' },
    levels: [{ code: 'B2', name: 'Basement 2', sort_order: -2 }, { code: 'G', name: 'Ground floor', sort_order: 0 }, { code: 'L1', name: '1st floor', sort_order: 1 }],
    elements: [
      { level_code: 'B2', code: 'B2-MAT', element_type: 'footing', planned_start: '2026-11-03', planned_finish: '2026-11-12',
        tasks: [{ task_id: await tid(4), activity_seq_from: 3, activity_seq_to: 3 }], takeoffs: [{ material_spec_id: R20, boq_item_id: await boq(4), qty: 42000 }] },
      { level_code: 'G', code: 'G-COL', element_type: 'column', planned_start: '2026-11-13', planned_finish: '2026-11-19',
        tasks: [{ task_id: await tid(13), activity_seq_from: 3, activity_seq_to: 4 }, { task_id: await tid(15), activity_seq_from: 2, activity_seq_to: 2 },
          { task_id: await tid(17), activity_seq_from: 5, activity_seq_to: 6 }],
        takeoffs: [{ material_spec_id: R16, boq_item_id: await boq(15), qty: 9000 }, { material_spec_id: C25, boq_item_id: await boq(17), qty: 36 }] },
      { level_code: 'L1', code: 'L1-SLB', element_type: 'slab', planned_start: '2026-11-20', planned_finish: '2026-11-24',
        tasks: [{ task_id: await tid(22), activity_seq_from: 5, activity_seq_to: 6 }], takeoffs: [{ material_spec_id: C25, boq_item_id: await boq(22), qty: 110 }] },
    ],
    replace_links: true,
  });

  // =====================================================================
  console.log('\ncreate_elements_from_schedule');
  await expectError(as(U.site_engineer, async () => rpc('create_elements_from_schedule', { op_id: uuid(), ...(await payload()) })), /not allowed/, 'site engineer cannot create elements');
  await expectError(as(U.store_keeper, async () => rpc('create_elements_from_schedule', { op_id: uuid(), ...(await payload()) })), /not allowed/, 'store keeper cannot create elements');
  await expectError(as(U.office_engineer, async () => rpc('create_elements_from_schedule', { op_id: uuid(), schedule_id: SCH, elements: [] })), /No elements/, 'empty list refused');
  await expectError(as(U.office_engineer, async () => rpc('create_elements_from_schedule', { op_id: uuid(), ...(await payload()), levels: [] })),
    /Level B2 is not in the levels list/, 'every element level must be sent');
  await expectError(as(U.office_engineer, async () => rpc('create_elements_from_schedule', { op_id: uuid(), schedule_id: uuid(), elements: [{ code: 'X', element_type: 'slab' }] })),
    /Schedule not found/, 'unknown schedule refused');

  const op = uuid();
  const r1 = await as(U.office_engineer, async () => rpc('create_elements_from_schedule', { op_id: op, ...(await payload()) }));
  ok(r1.ok && r1.blocks_created === 1 && r1.levels_created === 3 && r1.elements_created === 3 && r1.links === 5 && r1.takeoffs === 4,
    `block, 3 levels, 3 elements, 5 task links, 4 take-offs (${JSON.stringify({ b: r1.blocks_created, l: r1.levels_created, e: r1.elements_created, k: r1.links, t: r1.takeoffs })})`);
  const lv = await all(`select code, sort_order from levels where project_id = $1 order by sort_order`, [P]);
  ok(lv.map((l) => l.code).join(',') === 'B2,G,L1', `levels in elevation order (${lv.map((l) => l.code)})`);
  const col = await one(`select e.*, l.code lvl from elements e join levels l on l.id = e.level_id where e.project_id = $1 and e.code = 'G-COL'`, [P]);
  ok(col && col.element_type === 'column' && col.lvl === 'G' && String(col.planned_start).length > 0, 'G-COL on the ground floor, type column, planned dates set');
  ok((await one(`select count(*)::int c from element_activities where element_id = $1`, [col.id])).c === 7, 'activity sequence from the column template');
  const lk = await all(`select t.msp_uid, l.activity_seq_from f, l.activity_seq_to t2, l.source from task_element_links l join schedule_tasks t on t.id = l.task_id
    where l.element_id = $1 and l.deleted_at is null order by t.msp_uid`, [col.id]);
  ok(lk.map((x) => `${x.msp_uid}:${x.f}-${x.t2}:${x.source}`).join(' ') === '13:3-4:file 15:2-2:file 17:5-6:file', `formwork / rebar / concrete tasks linked to their activities (${lk.map((x) => `${x.msp_uid}:${x.f}-${x.t2}`)})`);
  const tk = await all(`select material_spec_id, boq_item_id, planned_qty from element_takeoffs where element_id = $1 order by planned_qty`, [col.id]);
  ok(tk.length === 2 && n(tk[0].planned_qty) === 36 && tk[0].boq_item_id === await boq(17) && n(tk[1].planned_qty) === 9000, 'take-offs tagged with their BoQ items');

  const again = await as(U.office_engineer, async () => rpc('create_elements_from_schedule', { op_id: op, ...(await payload()) }));
  ok(again.elements_created === 3 && (await one(`select count(*)::int c from elements where project_id = $1`, [P])).c === 3, 'retried op is applied once');
  const r2 = await as(U.office_engineer, async () => rpc('create_elements_from_schedule', { op_id: uuid(), ...(await payload()) }));
  ok(r2.elements_created === 0 && r2.elements_matched === 3 && r2.levels_created === 0 && r2.blocks_created === 0, 're-run matches the existing block, levels and elements');
  ok((await one(`select count(*)::int c from elements where project_id = $1`, [P])).c === 3
    && (await one(`select count(*)::int c from task_element_links where project_id = $1 and deleted_at is null`, [P])).c === 5
    && (await one(`select count(*)::int c from element_takeoffs where project_id = $1 and deleted_at is null`, [P])).c === 4, 'no duplicates after a re-run');

  console.log('\nRe-run after edits: dropped task, hand-made link, block by id');
  const p3 = await payload();
  p3.elements[1].tasks = p3.elements[1].tasks.slice(1);                      // formwork task no longer on G-COL
  await db.query(`update task_element_links set source = 'ui', activity_seq_from = 1, activity_seq_to = 7 where task_id = $1 and element_id = $2`, [await tid(17), col.id]);
  const blk = (await one(`select id from blocks where project_id = $1 and code = 'A'`, [P])).id;
  const r3 = await as(U.coordinator, async () => rpc('create_elements_from_schedule', { op_id: uuid(), ...p3, block: { id: blk } }));
  ok(r3.links_removed === 1, `the formwork link that is no longer sent is removed (${r3.links_removed})`);
  const keep = await one(`select activity_seq_from f, activity_seq_to t from task_element_links where task_id = $1 and element_id = $2`, [await tid(17), col.id]);
  ok(keep.f === 1 && keep.t === 7, 'a link edited by hand (source ui) is not overwritten');
  await db.query(`update elements set status = 'in_progress', planned_start = '2026-11-14' where id = $1`, [col.id]);
  await as(U.coordinator, async () => rpc('create_elements_from_schedule', { op_id: uuid(), ...p3, block: { id: blk } }));
  ok(String((await one(`select planned_start::text d from elements where id = $1`, [col.id])).d) === '2026-11-14', 'started elements keep their dates');

  console.log('\nElements drive the look-ahead material needs');
  await as(U.coordinator, async () => rpc('create_elements_from_schedule', { op_id: uuid(), ...(await payload()) }));
  const g = await as(U.coordinator, () => rpc('generate_lookahead', { op_id: uuid(), project_id: P, calendar_mode: 'gregorian', year: 2026, month: 11 }));
  const plan = g.plan_id ?? g.id ?? (await one(`select id from lookahead_plans where project_id = $1 order by created_at desc limit 1`, [P])).id;
  const needs = await all(`select material_spec_id, sum(total_need) need from app.la_material_calc($1) group by material_spec_id`, [plan]);
  const need = (s) => n(needs.find((x) => x.material_spec_id === s)?.need ?? 0);
  ok(need(R16) > 9000 && need(C25) > 140 && need(R20) > 42000, `rebar Ø16 ${need(R16)} kg, concrete ${need(C25)} m³, rebar Ø20 ${need(R20)} kg needed (take-offs + wastage)`);

  console.log('\nOther schedules');
  const other = uuid();
  await as(U.coordinator, () => rpc('import_schedule', { op_id: uuid(), project_id: P, schedule_id: other, code: 'B', schedule: { ...file, file_sha256: 'b-1' } }));
  const foreign = (await one(`select id from schedule_tasks where schedule_id = $1 and msp_uid = 13`, [other])).id;
  const p4 = await payload(); p4.elements[1].tasks = [{ task_id: foreign }];
  await expectError(as(U.coordinator, async () => rpc('create_elements_from_schedule', { op_id: uuid(), ...p4 })), /not in this schedule/, 'tasks of another schedule are refused');
  const p5 = await payload(); p5.elements[1].tasks = [{ task_id: await tid(11) }];
  const r5 = await as(U.coordinator, async () => rpc('create_elements_from_schedule', { op_id: uuid(), ...p5 }));
  ok(r5.warnings.length === 1 && /Summary task/.test(r5.warnings[0]), 'summary tasks are skipped with a warning');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
