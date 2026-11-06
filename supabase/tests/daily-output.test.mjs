// Daily output test (migrations 20261102000001_daily_output.sql, 20261102000023_e2e_progress_fixes.sql). Applies ALL migrations + seed in PGlite with the
// Supabase stubs used by the other suites.
//
// Scenario: a schedule with BoQ columns is imported and its BoQ created; a site engineer then records daily output
// on activities picked from the schedule → cumulative task progress + a line in that day's site diary (the diary is
// opened as a draft when missing); validation, roles, verification, and outputs added after the diary was signed.
//
//   node supabase/tests/daily-output.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const MINE = '20261102000001_daily_output.sql';
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
  const exc = await task(3), mile = await task(10), clear = await task(4);
  const link = await one(`select boq_item_id from task_boq_links where task_id = $1`, [exc.id]);
  ok(exc.ev_method === 'units' && !!link, 'excavation is measured by BoQ quantity');

  // =====================================================================
  console.log('\nDaily output by the site engineer');
  const D1 = '2026-10-30';
  const out = (p) => as(U.site_engineer, () => rpc('report_daily_output', { op_id: uuid(), id: uuid(), ...p }));
  const r1 = await out({ task_id: exc.id, date: D1, output: [{ boq_item_id: link.boq_item_id, qty_today: 120 }], headcount: 12, labour_hours: 96,
    equipment: 'Excavator ×1, dump truck ×2', remarks: 'Grid A–C', diary_number: 'APT-SD-W1-0001' });
  ok(r1.ok && r1.diary_number === 'APT-SD-W1-0001' && r1.diary_status === 'draft', `diary opened as draft (${r1.diary_number})`);
  ok(near(r1.pct_complete, 120 / 850 * 100), `task at ${r1.pct_complete}% (120 of 850 m3)`);
  const tp1 = await one(`select * from task_progress where id = $1`, [r1.task_progress_id]);
  ok(tp1 && tp1.status_date.toISOString().slice(0, 10) === D1 && n(tp1.qty[0].qty_to_date) === 120 && tp1.reported_by === U.site_engineer,
    'task progress reported, dated the output day, cumulative 120');
  const a1 = await one(`select * from diary_activities where id = $1`, [r1.id]);
  ok(a1 && a1.diary_id === r1.diary_id && a1.headcount === 12 && n(a1.labour_hours) === 96 && /Excavator/.test(a1.equipment)
    && n(a1.output[0].qty_today) === 120 && a1.output[0].unit === 'm3', 'diary line holds output, manpower and equipment');

  const r2 = await out({ task_id: exc.id, date: D1, output: [{ boq_item_id: link.boq_item_id, qty_today: 80 }], headcount: 8 });
  ok(r2.diary_id === r1.diary_id, 'second output the same day goes to the same diary (no number needed)');
  ok(n(r2.output[0].qty_to_date) === 200 && near(r2.pct_complete, 200 / 850 * 100), `outputs add up (to date ${r2.output[0].qty_to_date})`);
  ok(n((await one(`select reported_qty q from task_boq_links where task_id = $1`, [exc.id])).q) === 200, 'BoQ link shows 200 reported');
  ok((await one(`select count(*)::int c from site_diaries where project_id = $1 and diary_date = $2`, [P, D1])).c === 1, 'one diary per day');

  await expectError(out({ task_id: exc.id, date: '2026-10-31', output: [{ boq_item_id: link.boq_item_id, qty_today: 5 }] }),
    /diary_number is required/, 'a new day needs the diary number from the client');
  await expectError(out({ task_id: exc.id, date: '2099-01-01', output: [{ boq_item_id: link.boq_item_id, qty_today: 5 }], diary_number: 'X' }),
    /future/, 'no outputs in the future');
  await expectError(out({ task_id: exc.id, date: D1, output: [{ boq_item_id: link.boq_item_id, qty_today: 0 }] }),
    /quantity done today/, 'zero output is refused');
  await expectError(out({ task_id: exc.id, date: D1, output: [{ boq_item_id: link.boq_item_id, qty_today: -3 }] }),
    /negative/, 'negative output is refused');
  await expectError(out({ task_id: exc.id, date: D1, output: [{ boq_item_id: link.boq_item_id, qty_today: 700 }] }),
    /more than planned/, 'over-measure (900 > 850) needs a remark');
  const r3 = await out({ task_id: exc.id, date: D1, output: [{ boq_item_id: link.boq_item_id, qty_today: 700 }], remarks: 'Extra depth at lift pit (re-measured)' });
  ok(n(r3.output[0].qty_to_date) === 900, 'over-measure accepted with a remark');
  await expectError(out({ task_id: uuid(), date: D1, output: [] }), /Choose an activity/, 'unknown activity is refused');
  await expectError(as(U.store_keeper, () => rpc('report_daily_output', { op_id: uuid(), task_id: exc.id, date: D1, pct_complete: 10 })),
    /not allowed/, 'store keeper cannot report daily output');
  await expectError(out({ task_id: (await task(1)).id, date: D1, pct_complete: 10 }), /summary/, 'summary tasks are not reported');

  const pay = { op_id: uuid(), id: uuid(), task_id: exc.id, date: D1, output: [{ boq_item_id: link.boq_item_id, qty_today: 1 }], remarks: 'Re-measured' };
  const i1 = await as(U.site_engineer, () => rpc('report_daily_output', pay));
  const i2 = await as(U.site_engineer, () => rpc('report_daily_output', pay));
  ok(i1.id === i2.id && (await one(`select count(*)::int c from diary_activities where id = $1`, [i1.id])).c === 1, 'retried offline op is applied once');

  console.log('\nOther EV methods');
  const rm = await out({ task_id: mile.id, date: D1, pct_complete: 100, actual_finish: D1 });
  const am = await one(`select * from diary_activities where id = $1`, [rm.id]);
  ok(n(rm.pct_complete) === 100 && ['milestone', '0_100'].includes(am.method) && n(am.pct_to_date) === 100 && am.output.length === 0, 'milestone reached is recorded with 100 %');
  await expectError(out({ task_id: mile.id, date: D1, pct_complete: 40 }), /0\/100/, 'milestone only takes 0 or 100');

  console.log('\nVerification, then more output');
  await as(U.office_engineer, () => rpc('verify_task_progress', { op_id: uuid(), progress_id: i1.task_progress_id, approve: true }));
  const r4 = await out({ task_id: exc.id, date: D1, output: [{ boq_item_id: link.boq_item_id, qty_today: 9 }], remarks: 'Re-measured' });
  ok(n(r4.output[0].qty_to_date) === 910, `adds to the latest figure after verification (${r4.output[0].qty_to_date})`);

  console.log('\nDiary signed, then late output');
  const dia = await one(`select * from site_diaries where id = $1`, [r1.diary_id]);
  await as(U.site_engineer, () => rpc('save_site_diary', { op_id: uuid(), id: dia.id, project_id: P, diary_date: D1, weather_am: 'sunny', work_summary: 'Excavation', submit: true }));
  const acts = await one(`select count(*)::int c from diary_activities where diary_id = $1`, [dia.id]);
  ok(acts.c >= 5, `saving the diary keeps its ${acts.c} activities`);
  await as(U.office_engineer, () => rpc('sign_site_diary', { op_id: uuid(), diary_id: dia.id, approve: true }));
  const clearLink = await one(`select boq_item_id from task_boq_links where task_id = $1`, [clear.id]);
  const r5 = await out({ task_id: clear.id, date: D1, output: [{ boq_item_id: clearLink.boq_item_id, qty_today: 300 }] });
  const a5 = await one(`select * from diary_activities where id = $1`, [r5.id]);
  const add = await one(`select text from diary_addenda where diary_id = $1 order by created_at desc limit 1`, [dia.id]);
  ok(r5.diary_status === 'signed' && a5.after_signoff === true, 'output after sign-off is kept and flagged');
  ok(add && /after sign-off/.test(add.text) && /300 m2/.test(add.text), `and written to the signed diary as an addendum ("${add?.text}")`);
  ok((await one(`select status from site_diaries where id = $1`, [dia.id])).status === 'signed', 'the signed diary itself is unchanged');


  console.log('\nRejected / adjusted reports reset the reported figures (20261102000023)');
  const rebar = await task(9);   // 54000 kg, units
  const rbLink = await one(`select boq_item_id from task_boq_links where task_id = $1`, [rebar.id]);
  const diaryNo = { '2026-10-31': 'APT-SD-W1-0101', '2026-11-02': 'APT-SD-W1-0102' };
  const rq = (d, qty, extra = {}) => out({ task_id: rebar.id, date: d, diary_number: diaryNo[d], output: [{ boq_item_id: rbLink.boq_item_id, qty_today: qty }], ...extra });
  const g1 = await rq('2026-10-31', 4000);
  const g2 = await rq('2026-10-31', 2500);
  ok(n(g2.output[0].qty_to_date) === 6500, 'two outputs → 6500 kg reported');
  await as(U.office_engineer, () => rpc('verify_task_progress', { op_id: uuid(), progress_id: g2.task_progress_id, approve: false, comment: 'Not fixed yet — counted twice' }));
  const afterReject = await one(`select l.reported_qty q, t.reported_pct p from task_boq_links l join schedule_tasks t on t.id = l.task_id where l.task_id = $1`, [rebar.id]);
  ok(n(afterReject.q) === 4000, `rejecting the latest report puts the reported quantity back to 4000 (got ${afterReject.q})`);
  ok(near(afterReject.p, 4000 / 54000 * 100), `and the reported % back to ${afterReject.p}`);
  const g3 = await rq('2026-11-02', 1000);
  ok(n(g3.output[0].qty_to_date) === 5000, `next output builds on the standing 4000 → ${g3.output[0].qty_to_date}`);
  await as(U.office_engineer, () => rpc('verify_task_progress', { op_id: uuid(), progress_id: g1.task_progress_id, approve: true }));
  await as(U.office_engineer, () => rpc('verify_task_progress', { op_id: uuid(), progress_id: g3.task_progress_id, approve: true,
    verified_qty: [{ boq_item_id: rbLink.boq_item_id, qty_to_date: 4800 }], comment: 'Measured 4.8 t on site' }));
  const afterAdj = await one(`select l.reported_qty q, l.verified_qty v from task_boq_links l where l.task_id = $1`, [rebar.id]);
  ok(n(afterAdj.q) === 4800 && n(afterAdj.v) === 4800, `adjusting to the measured 4800 resets reported to it (reported ${afterAdj.q}, verified ${afterAdj.v})`);
  const g4 = await rq('2026-11-02', 200);
  ok(n(g4.output[0].qty_to_date) === 5000, `next output builds on the measured 4800 → ${g4.output[0].qty_to_date}`);
  await as(U.office_engineer, () => rpc('verify_task_progress', { op_id: uuid(), progress_id: g4.task_progress_id, approve: false, comment: 'Duplicate' }));
  ok(n((await one(`select reported_qty q from task_boq_links where task_id = $1`, [rebar.id])).q) === 4800, 'rejecting again falls back to the adjusted report (4800)');

  console.log('\nDaily output labour hours feed cost control (20261102000023)');
  const use1 = await one(`select * from resource_usage where id = $1`, [r1.id]);
  ok(use1 && use1.kind === 'labour' && n(use1.qty) === 96 && use1.uom === 'man-hour' && use1.task_id === exc.id && use1.diary_id === r1.diary_id,
    'the first output (12 people, 96 h) is recorded as 96 labour man-hours on the task and diary');
  ok(!(await one(`select 1 x from resource_usage where id = $1`, [rm.id])), 'outputs without labour hours record no usage');
  await as(U.coordinator, () => rpc('save_cost_rate', { op_id: uuid(), id: uuid(), project_id: P, kind: 'labour', uom: 'man-hour', rate: 125, valid_from: '2026-09-01' }));
  const est = await as(U.coordinator, () => rpc('estimate_costs_from_usage', { op_id: uuid(), project_id: P, from: '2026-10-01', to: '2026-11-02' }));
  const ce = await one(`select * from cost_entries where source_ref = $1`, ['usage:' + r1.id]);
  ok(est.created >= 1 && ce && n(ce.amount) === 12000 && ce.task_id === exc.id && ce.is_estimate === true,
    `"Estimate from site diary hours" prices it: 96 h × 125 = ${ce?.amount} ETB on the task`);
  console.log('\nBlock diaries and access');
  const blk = uuid();
  await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'B', 'Block B')`, [blk, P]);
  const r6 = await out({ task_id: clear.id, date: D1, block_id: blk, diary_number: 'APT-SD-W1-0002',
    output: [{ boq_item_id: clearLink.boq_item_id, qty_today: 10 }] });
  ok(r6.diary_id !== r1.diary_id && r6.diary_number === 'APT-SD-W1-0002', 'a block gets its own diary for the day');
  const seen = await as(U.store_keeper, () => one(`select count(*)::int c from diary_activities`));
  ok(seen.c > 0, `project members can read diary activities (${seen.c})`);
  const outsider = uuid();
  await db.query(`insert into auth.users (id, email, raw_app_meta_data) values ($1, 'out@test.et', '{"role":"site_engineer"}')`, [outsider]);
  ok((await as(outsider, () => one(`select count(*)::int c from diary_activities`))).c === 0, 'non-members see nothing');
  await expectError(as(outsider, () => rpc('report_daily_output', { op_id: uuid(), task_id: exc.id, date: D1, output: [{ boq_item_id: link.boq_item_id, qty_today: 1 }] })),
    /assigned|member|not allowed/i, 'non-members cannot report');
  await expectError(db.query(`delete from diary_activities where id = $1`, [r6.id]), /./, 'diary activities cannot be deleted');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
