// Schedule & EVM test (migration 20261030000003_schedule_evm.sql). Applies ALL
// migrations in order + seed in PGlite with the Supabase stubs used by the other
// suites. Migrations owned by other agents (procurement flows 0001/0002,
// look-ahead 0004) are skipped with a notice if they fail to apply.
//
// Scenarios: 30-task MSP import (WBS, summaries, milestones, links incl. a summary
// link, baselines, costs dropped for a non-price importer) → diff; re-import of the
// same file (no-op) and a changed file (dates, rename, new, removed with/without
// progress, UID change matched by GUID); Ethiopian holiday in working days & PV;
// CPM on a small network with SS/FF + lag before and after progress; progress
// report → verify drives EV; element-linked task derives % from verified element
// progress; actual cost from issued materials + cost entries (incl. reversal and the
// materials-only basis); hand-checked EVM numbers; period close (variance note,
// immutable snapshot, late report & cost roll into the next period, reopen);
// price visibility; baseline approval & re-baseline.
//
//   node supabase/tests/schedule.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = await import('../../shared/contract-schedule.ts');   // Node ≥ 22.18 strips TS types
const db = new PGlite();
const MINE = '20261030000003_schedule_evm.sql';
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
const d = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10));
const n = (v) => (v == null ? null : Number(v));

// Mon–Sat date arithmetic for building test schedules (holidays not needed there)
const addDays = (s, k) => { const x = new Date(s + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const nextWd = (s) => { let x = addDays(s, 1); while (new Date(x + 'T00:00:00Z').getUTCDay() === 0) x = addDays(x, 1); return x; };
const plusWd = (s, k) => { let x = s; for (let i = 0; i < k; i++) x = nextWd(x); return x; };

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
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper', 'procurement']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role }, { role }]);
  }
  const spec = async (name, grade) => (await one(
    `select s.id from material_specs s join materials m on m.id = s.material_id where m.name = $1 and s.grade = $2`, [name, grade])).id;
  const REBAR = await spec('Rebar', 'S-400 Ø16');

  // =====================================================================
  console.log('\nCalendar & Ethiopian holidays');
  const Q = uuid(), BQ = uuid(), LQ = uuid(), SQ = uuid(), E1 = uuid(), BOQ_EXC = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'QNET', 'Q network')`, [Q]);
    for (const r of Object.keys(U).filter((r) => r !== 'admin')) await db.query(`insert into project_members values ($1, $2)`, [Q, U[r]]);
    await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'A', 'Block A')`, [BQ, Q]);
    await db.query(`insert into levels (id, project_id, block_id, code, name) values ($1, $2, $3, 'GF', 'Ground')`, [LQ, Q, BQ]);
    await db.query(`insert into stores (id, project_id, name) values ($1, $2, 'Main')`, [SQ, Q]);
    await db.query(`insert into elements (id, project_id, block_id, level_id, code, element_type) values ($1, $2, $3, $4, 'C1', 'column')`, [E1, Q, BQ, LQ]);
    await db.query(`insert into boq_items (id, project_id, item_no, description, unit, quantity) values ($1, $2, 'Q-01', 'Excavation', 'm3', 300)`, [BOQ_EXC, Q]);
  });
  await as(U.coordinator, async () => {
    await db.query(`insert into boq_rates (boq_item_id, rate) values ($1, 200)`, [BOQ_EXC]);
    await db.query(`insert into spec_prices (material_spec_id, unit_price) values ($1, 100) on conflict (material_spec_id) do update set unit_price = 100`, [REBAR]);
  });
  await as(U.office_engineer, () => db.query(
    `insert into element_takeoffs (project_id, element_id, material_spec_id, planned_qty) values ($1, $2, $3, 400)`, [Q, E1, REBAR]));

  const cal = await one(`select * from project_calendars where project_id = $1 and is_default`, [Q]);
  ok(cal && cal.working_weekdays.join() === '1,2,3,4,5,6' && n(cal.hours_per_day) === 8, 'new project gets a default Mon–Sat, 8 h calendar');
  ok((await one(`select count(*)::int c from public_holidays where on_date between '2026-01-01' and '2027-12-31'`)).c === 26, '26 Ethiopian public holidays seeded for 2026–2027');
  ok((await one(`select count(*)::int c from public_holidays where is_tentative and on_date between '2026-01-01' and '2027-12-31'`)).c === 6, 'lunar (Islamic) holidays flagged tentative');
  ok((await one(`select app.is_working_day($1, '2026-09-11') w`, [Q])).w === false, 'Enkutatash (Fri 11 Sep 2026) is not a working day');
  ok((await one(`select app.working_days($1, '2026-09-07', '2026-09-12') w`, [Q])).w === 5, 'working_days Mon 7 – Sat 12 Sep 2026 = 5 (holiday removed)');
  ok((await one(`select app.working_days($1, '2026-11-01', '2026-11-30') w`, [Q])).w === 25, 'November 2026 has 25 working days (Mon–Sat, no holiday)');
  ok(d((await one(`select app.add_working_days($1, '2027-04-29', 1) x`, [Q])).x) === '2027-05-03', 'add_working_days(29 Apr 2027, 1) skips Siklet, Labour Day, Fasika → 3 May');
  ok(d((await one(`select app.add_working_days($1, '2026-09-14', -2) x`, [Q])).x) === '2026-09-10', 'add_working_days with negative n goes back over the holiday');
  // calendar days change through edit_calendar_days (20261105000010_project_calendar.sql)
  await as(U.office_engineer, () => db.query(`select public.edit_calendar_days($1::jsonb)`,
    [JSON.stringify({ op_id: uuid(), project_id: Q, dates: ['2026-10-04'], kind: 'working', name: 'Sunday pour' })]));
  ok((await one(`select app.working_days($1, '2026-10-04', '2026-10-10') w`, [Q])).w === 7, 'working exception makes a Sunday count');
  await as(U.office_engineer, () => db.query(`select public.edit_calendar_days($1::jsonb)`,
    [JSON.stringify({ op_id: uuid(), project_id: Q, dates: ['2026-10-04'], kind: 'normal' })]));
  ok(n((await one(`select app.day_capacity($1, '2026-09-11') c`, [Q])).c) === 0, 'day_capacity of a holiday is 0');

  // =====================================================================
  console.log('\nSmall network import (Q) by a price role');
  const bl = (s, f, dur, cost) => [{ number: 0, start: s + 'T08:00:00', finish: f + 'T17:00:00', duration_days: dur, cost }];
  const T = (uid, name, lvl, s, f, dur, extra = {}) => ({ uid, guid: `G-${uid}`, id: uid, name, wbs: `1.${uid}`, outline_level: lvl,
    is_summary: false, is_milestone: false, start: s + 'T08:00:00', finish: f + 'T17:00:00', duration_days: dur, ...extra });
  const qFile = {
    source: 'mspdi', file_name: 'qnet.xml', file_sha256: 'q-1',
    header: { name: 'Q network', start_date: '2026-09-01', minutes_per_day: 480, minutes_per_week: 2880, days_per_month: 26, currency_code: 'ETB', baseline_for_ev: 0 },
    calendars: [], project_calendar_uid: 1, warnings: [],
    tasks: [
      { uid: 0, name: 'Project summary', outline_level: 0, is_summary: true, is_milestone: false, start: '2026-09-01', finish: '2026-09-16', duration_days: 13 },
      { ...T(1, 'Works', 1, '2026-09-01', '2026-09-16', 13), wbs: '1', is_summary: true },
      T(2, 'A Excavation', 2, '2026-09-01', '2026-09-07', 6, { custom: { Text1: 'Q-01' }, baselines: bl('2026-09-01', '2026-09-07', 6, 60000), cost: 60000 }),
      T(3, 'B Footings', 2, '2026-09-08', '2026-09-14', 5, { baselines: bl('2026-09-08', '2026-09-14', 5, 50000), cost: 50000 }),
      T(4, 'C Plinth beams', 2, '2026-09-10', '2026-09-15', 4, { baselines: bl('2026-09-10', '2026-09-15', 4, 40000), cost: 40000 }),
      T(5, 'D Columns', 2, '2026-09-14', '2026-09-16', 3, { custom: { Text2: 'C1@GF' }, baselines: bl('2026-09-14', '2026-09-16', 3, 30000), cost: 30000 }),
      T(6, 'M Frame complete', 2, '2026-09-16', '2026-09-16', 0, { is_milestone: true, baselines: bl('2026-09-16', '2026-09-16', 0, 0) }),
      T(7, 'E Site cleanup', 2, '2026-09-08', '2026-09-09', 2, { baselines: bl('2026-09-08', '2026-09-09', 2, 10000), cost: 10000 }),
    ],
    links: [
      { pred_uid: 2, succ_uid: 3, type: 'FS', lag_days: 0 }, { pred_uid: 3, succ_uid: 4, type: 'SS', lag_days: 2 },
      { pred_uid: 4, succ_uid: 5, type: 'FF', lag_days: 1 }, { pred_uid: 2, succ_uid: 5, type: 'FS', lag_days: 0 },
      { pred_uid: 3, succ_uid: 6, type: 'FS', lag_days: 0 }, { pred_uid: 5, succ_uid: 6, type: 'FS', lag_days: 0 },
      { pred_uid: 2, succ_uid: 7, type: 'FS', lag_days: 0 }, { pred_uid: 7, succ_uid: 6, type: 'FS', lag_days: 0 },
    ],
  };
  const SCHQ = uuid();
  const rq = await as(U.coordinator, () => rpc('import_schedule', { op_id: uuid(), project_id: Q, schedule_id: SCHQ, schedule: qFile,
    mapping: { boq_field: 'Text1', element_field: 'Text2' } }));
  ok(rq.added === 7 && rq.links === 8 && rq.removed === 0, `Q imported: 7 tasks (project summary skipped), 8 links (${rq.added}/${rq.links})`);
  const tq = async () => Object.fromEntries((await all(`select * from schedule_tasks where schedule_id = $1`, [SCHQ])).map((t) => [t.msp_uid, t]));
  let q = await tq();
  ok(q[2].parent_id === q[1].id && q[1].is_summary, 'parent from outline level');
  ok(q[2].ev_method === 'units' && q[5].ev_method === 'elements' && q[6].ev_method === '0_100' && q[3].ev_method === '0_100',
    `default EV methods: BoQ→units, elements→elements, milestone/short→0_100 (${q[2].ev_method},${q[5].ev_method},${q[6].ev_method},${q[3].ev_method})`);
  ok(n((await one(`select qty_share q from task_boq_links where task_id = $1`, [q[2].id])).q) === 300, 'BoQ code from custom field Text1 linked; whole qty 300 auto-assigned');
  ok((await one(`select count(*)::int c from task_element_links where task_id = $1 and element_id = $2`, [q[5].id, E1])).c === 1, 'element code C1@GF linked');
  ok(n((await as(U.coordinator, () => one(`select msp_cost c from schedule_task_costs where task_id = $1`, [q[2].id]))).c) === 60000, 'coordinator import keeps MSP costs (price table)');
  ok((await as(U.site_engineer, () => all(`select * from schedule_task_costs`))).length === 0, 'site engineer cannot read task costs');
  ok(d(q[3].forecast_start) === '2026-09-08' && d(q[2].baseline_start) === '2026-09-01', 'forecast = plan, baseline = file baseline before approval');

  await as(U.office_engineer, () => rpc('save_task_setup', { op_id: uuid(), tasks: [{ task_id: q[3].id, ev_method: 'pct' }, { task_id: q[4].id, ev_method: 'pct' }] }));
  await expectError(as(U.office_engineer, () => rpc('save_task_setup', { op_id: uuid(), task_id: q[7].id, ev_method: 'units' })),
    /Link BoQ items/, 'units method needs BoQ links');
  await expectError(as(U.site_engineer, () => rpc('save_task_setup', { op_id: uuid(), task_id: q[3].id, ev_method: 'pct' })),
    /not allowed/, 'site engineer cannot change task setup');

  // =====================================================================
  console.log('\nCPM before progress (status 31 Aug 2026)');
  const f0 = await as(U.office_engineer, () => rpc('run_forecast', { op_id: uuid(), schedule_id: SCHQ, status_date: '2026-08-31' }));
  q = await tq();
  ok(d(f0.fc_finish) === '2026-09-16', `forecast finish 16 Sep (${d(f0.fc_finish)})`);
  ok(d(q[4].forecast_start) === '2026-09-10' && d(q[4].forecast_finish) === '2026-09-15', `C starts SS+2 after B: 10–15 Sep (${d(q[4].forecast_start)}–${d(q[4].forecast_finish)})`);
  ok(d(q[5].forecast_start) === '2026-09-14' && d(q[5].forecast_finish) === '2026-09-16', `D driven by FF+1 from C: 14–16 Sep (${d(q[5].forecast_start)}–${d(q[5].forecast_finish)})`);
  ok(d(q[6].forecast_finish) === '2026-09-16', 'milestone M on 16 Sep');
  ok(n(q[7].total_float_days) === 5 && n(q[7].free_float_days) === 5 && !q[7].is_critical, `E has 5 days total & free float (${q[7].total_float_days}/${q[7].free_float_days})`);
  ok([2, 3, 4, 5, 6].every((u) => q[u].is_critical && n(q[u].total_float_days) === 0), 'critical path A–B–C–D–M (float 0)');
  ok(q[1].is_critical && d(q[1].forecast_finish) === '2026-09-16', 'summary rolled up');

  // =====================================================================
  console.log('\nBaseline approval');
  const BLQ = uuid();
  const sb = await as(U.office_engineer, () => rpc('set_baseline', { op_id: uuid(), id: BLQ, schedule_id: SCHQ, source: 'msp_baseline', cost_source: 'msp_baseline_cost' }));
  ok(sb.status === 'proposed' && sb.tasks === 6 && sb.bac_cost === undefined, 'office engineer proposes baseline (6 leaf tasks, no totals shown without price access)');
  ok((await as(U.manager, () => all(`select * from v_my_approvals where kind = 'baseline_approve'`))).length === 1, 'manager inbox: baseline to approve');
  await expectError(as(U.office_engineer, () => rpc('approve_baseline', { op_id: uuid(), baseline_id: BLQ, approve: true })), /not allowed/, 'office engineer cannot approve a baseline');
  await expectError(as(U.manager, () => rpc('approve_baseline', { op_id: uuid(), baseline_id: BLQ, approve: false })), /comment is required/, 'rejecting needs a comment');
  await as(U.manager, () => rpc('approve_baseline', { op_id: uuid(), baseline_id: BLQ, approve: true }));
  const bac = await as(U.coordinator, () => one(`select sum(bac_cost) c, sum(bac_value) v from schedule_baseline_task_costs where baseline_id = $1`, [BLQ]));
  ok(n(bac.c) === 190000 && n(bac.v) === 190000, `BAC 190 000 (cost = MSP baseline cost; value: A from BoQ 300 × 200) (${bac.c}/${bac.v})`);
  ok((await as(U.site_engineer, () => all(`select * from schedule_baseline_task_costs`))).length === 0, 'BAC hidden from site engineer');

  // =====================================================================
  console.log('\nProgress: site reports → office verifies');
  const rep = (p) => as(U.site_engineer, () => rpc('report_task_progress', { op_id: uuid(), id: uuid(), ...p }));
  const ver = (id, extra = {}) => as(U.office_engineer, () => rpc('verify_task_progress', { op_id: uuid(), progress_id: id, approve: true, ...extra }));
  const ra = await rep({ task_id: q[2].id, status_date: '2026-09-07', qty_done: 300, actual_start: '2026-09-01', actual_finish: '2026-09-07' });
  ok(n(ra.pct_complete) === 100, 'A: 300 m³ reported = 100 %');
  ok(n((await one(`select pct_complete p from schedule_tasks where id = $1`, [q[2].id])).p) === 0, 'unverified report does not change the task %');
  ok((await as(U.office_engineer, () => all(`select * from v_my_approvals where kind = 'task_progress_verify'`))).length === 1, 'office engineer inbox: task progress to verify');
  await expectError(as(U.office_engineer, () => rpc('verify_task_progress', { op_id: uuid(), progress_id: ra.id, approve: false })), /comment is required/, 'reject needs a comment');
  await ver(ra.id);
  const rb = await rep({ task_id: q[3].id, status_date: '2026-09-12', pct_complete: 60, actual_start: '2026-09-08' });
  const vb = await ver(rb.id, { verified_pct: 50, comment: 'Second footing not cast' });
  ok(vb.status === 'adjusted' && n(vb.verified_pct) === 50, 'B adjusted 60 → 50 % with comment');
  await ver((await rep({ task_id: q[4].id, status_date: '2026-09-12', pct_complete: 25, actual_start: '2026-09-10' })).id);
  await expectError(rep({ task_id: q[7].id, status_date: '2026-09-09', pct_complete: 50 }), /0\/100/, '0/100 task rejects 50 %');
  await ver((await rep({ task_id: q[7].id, status_date: '2026-09-09', pct_complete: 100, actual_start: '2026-09-08', actual_finish: '2026-09-09' })).id);
  await expectError(rep({ task_id: q[5].id, status_date: '2026-09-12', pct_complete: 10 }), /from its elements/, 'element-linked task cannot be reported directly');
  await expectError(rep({ task_id: q[1].id, pct_complete: 10 }), /summary/, 'summary task cannot be reported');
  await expectError(rep({ task_id: q[3].id, status_date: '2099-01-01', pct_complete: 70 }), /future/, 'future-dated report rejected');

  console.log('\nElement-linked task derives % from verified element activities');
  const acts = await all(`select id, seq from element_activities where element_id = $1 order by seq`, [E1]);
  const ep = [];
  for (const a of acts.slice(0, 2)) {
    const id = uuid(); ep.push(id);
    await as(U.site_engineer, () => rpc('report_progress', { op_id: uuid(), id, element_activity_id: a.id, pct_complete: 100, report_date: '2026-09-12' }));
  }
  ok(n((await one(`select pct_complete p from schedule_tasks where id = $1`, [q[5].id])).p) === 0, 'reported (unverified) element progress does not count');
  for (const id of ep) await as(U.office_engineer, () => rpc('verify_progress', { op_id: uuid(), progress_id: id, approve: true }));
  q = await tq();
  ok(n(q[5].pct_complete) === 30 && d(q[5].actual_start) === '2026-09-12', `D = 30 % (prep 5 + rebar 25 of 100), started 12 Sep (${q[5].pct_complete})`);
  ok(n(q[2].pct_complete) === 100 && d(q[2].actual_finish) === '2026-09-07' && n(q[3].pct_complete) === 50, 'A 100 % finished 7 Sep, B 50 %');
  ok(n((await one(`select verified_qty v from task_boq_links where task_id = $1`, [q[2].id])).v) === 300, 'BoQ link verified qty 300');

  // =====================================================================
  console.log('\nActual cost: issued materials + cost entries');
  await as(U.coordinator, () => rpc('post_opening_balance', { op_id: uuid(), project_id: Q, store_id: SQ, lines: [{ material_spec_id: REBAR, qty: 1000 }] }));
  await as(U.store_keeper, () => rpc('post_miv', { op_id: uuid(), id: uuid(), project_id: Q, store_id: SQ, number: 'QNET-MIV-T-0001',
    issued_to: U.site_engineer, issued_at: '2026-09-10T10:00:00+03:00', is_emergency: true, emergency_reason: 'Column pour',
    lines: [{ id: uuid(), material_spec_id: REBAR, element_id: E1, qty: 100 }] }));
  const ce = (p) => as(U.coordinator, () => rpc('record_actual_cost', { op_id: uuid(), id: uuid(), project_id: Q, ...p }));
  await ce({ number: 'QNET-CE-1', entry_date: '2026-09-05', category: 'labour', task_id: q[2].id, description: 'Excavation gang', qty: 600, rate: 50 });
  await ce({ number: 'QNET-CE-2', entry_date: '2026-09-10', category: 'equipment', task_id: q[3].id, description: 'Excavator hire', amount: 20000 });
  await ce({ number: 'QNET-CE-3', entry_date: '2026-09-12', category: 'overhead', description: 'Site office', amount: 5000 });
  await ce({ number: 'QNET-CE-4', entry_date: '2026-09-20', category: 'labour', task_id: q[4].id, description: 'Later week', amount: 4000 });
  const wrong = uuid();
  await as(U.coordinator, () => rpc('record_actual_cost', { op_id: uuid(), id: wrong, project_id: Q, number: 'QNET-CE-5', entry_date: '2026-09-11',
    category: 'labour', task_id: q[4].id, description: 'Posted twice', amount: 7000 }));
  await as(U.coordinator, () => rpc('reverse_cost_entry', { op_id: uuid(), id: uuid(), number: 'QNET-CE-5R', reversal_of: wrong, reason: 'Duplicate' }));
  await expectError(as(U.coordinator, () => rpc('reverse_cost_entry', { op_id: uuid(), id: uuid(), number: 'QNET-CE-5R2', reversal_of: wrong, reason: 'again' })),
    /already reversed/, 'a cost entry can be reversed only once');
  await expectError(as(U.office_engineer, () => rpc('record_actual_cost', { op_id: uuid(), id: uuid(), project_id: Q, number: 'X', entry_date: '2026-09-05',
    category: 'labour', description: 'x', amount: 1 })), /not allowed to view or enter prices/, 'office engineer (not a price role) cannot enter money');
  await expectError(db.query(`update cost_entries set amount = 1 where id = $1`, [wrong]), /immutable/, 'cost entries are append-only');
  await as(U.office_engineer, () => rpc('record_resource_usage', { op_id: uuid(), id: uuid(), project_id: Q, usage_date: '2026-09-05', kind: 'labour',
    task_id: q[2].id, qty: 48, uom: 'man-hours' }));
  ok((await as(U.site_engineer, () => all(`select * from resource_usage`))).length === 1 && (await as(U.site_engineer, () => all(`select * from cost_entries`))).length === 0,
    'resource usage (hours) visible to members, cost entries not');
  const alloc = await as(U.coordinator, () => all(`select * from v_ac_material_alloc where project_id = $1`, [Q]));
  ok(alloc.length === 1 && alloc[0].task_id === q[5].id && n(alloc[0].amount) === 10000, 'MIV of 100 kg rebar to C1 valued 10 000 and allocated to D (element link)');

  // =====================================================================
  console.log('\nCPM after progress (status 12 Sep 2026, retained logic)');
  await as(U.office_engineer, () => rpc('run_forecast', { op_id: uuid(), schedule_id: SCHQ, status_date: '2026-09-12' }));
  q = await tq();
  ok(d(q[3].forecast_finish) === '2026-09-16' && n(q[3].total_float_days) === 1 && !q[3].is_critical, `B remaining 3 d → 16 Sep, float 1 (${d(q[3].forecast_finish)}, ${q[3].total_float_days})`);
  ok(d(q[4].forecast_finish) === '2026-09-16' && q[4].is_critical, `C remaining 3 d → 16 Sep, critical (${d(q[4].forecast_finish)})`);
  ok(d(q[5].forecast_finish) === '2026-09-17' && q[5].is_critical, `D held by FF+1 from C → 17 Sep (${d(q[5].forecast_finish)})`);
  ok(d(q[6].forecast_finish) === '2026-09-17' && q[6].is_critical, 'milestone M slips to 17 Sep');
  ok(!q[2].is_critical && q[2].total_float_days === null && d(q[2].forecast_finish) === '2026-09-07', 'finished A keeps actual dates, no float');
  ok(d((await one(`select fc_finish f from schedules where id = $1`, [SCHQ])).f) === '2026-09-17', 'schedule CPM forecast finish 17 Sep');

  // =====================================================================
  console.log('\nEVM at status date 12 Sep 2026 (hand-checked)');
  // PV: A 60k×1 + B 50k×4/5 (holiday 11 Sep removed) + C 40k×2/4 + E 10k×1 = 130 000
  // EV: A 60k + B 25k + C 10k + D 30k×30 % + E 10k = 114 000; AC: 10k rebar + 30k + 20k + 5k = 65 000
  const pj = await as(U.coordinator, () => one(`select * from v_evm_project where schedule_id = $1`, [SCHQ]));
  ok(n(pj.bac) === 190000 && n(pj.pv) === 130000 && n(pj.ev) === 114000 && n(pj.ac) === 65000, `BAC/PV/EV/AC = 190k/130k/114k/65k (${pj.bac}/${pj.pv}/${pj.ev}/${pj.ac})`);
  ok(near(pj.spi, 0.8769, 0.0001) && near(pj.cpi, 1.7538, 0.0001), `SPI 0.8769, CPI 1.7538 (${pj.spi}, ${pj.cpi})`);
  ok(near(pj.eac, 108333.33) && near(pj.etc, 43333.33) && near(pj.vac, 81666.67) && near(pj.tcpi, 0.608, 0.0001),
    `EAC = BAC/CPI 108 333.33, ETC 43 333.33, VAC 81 666.67, TCPI 0.608 (${pj.eac}, ${pj.etc}, ${pj.vac}, ${pj.tcpi})`);
  ok(n(pj.sv) === -16000 && n(pj.cv) === 49000 && pj.spi_status === 'critical', 'SV −16 000, CV +49 000, SPI band critical (< 0.90)');
  ok(n(pj.ac_unallocated) === 5000 && near(pj.ac_coverage_pct, 92.3, 0.05), 'site overhead 5 000 unallocated (AC coverage 92.3 %)');
  ok(near(pj.es_days, 9.2) && pj.at_days === 10 && pj.pd_days === 13 && near(pj.spi_t, 0.92, 0.0001) && near(pj.sv_t_days, -0.8),
    `Earned schedule: ES 9.2 of AT 10 wd → SPI(t) 0.92, SV(t) −0.8 d, PD 13 (${pj.es_days}, ${pj.at_days}, ${pj.spi_t})`);
  ok(d(pj.es_finish) === '2026-09-18' && d(pj.fc_finish) === '2026-09-17', `ES forecast finish 18 Sep (13/0.92 = 14.1 → 15 wd), CPM 17 Sep (${d(pj.es_finish)})`);
  const tb = await as(U.coordinator, () => one(`select * from v_evm_task where task_id = $1`, [q[3].id]));
  ok(n(tb.pv) === 40000 && n(tb.ev) === 25000 && n(tb.ac) === 20000 && near(tb.spi, 0.625, 0.0001), 'task B: PV 40k, EV 25k, AC 20k, SPI 0.625');
  const wb = await as(U.coordinator, () => one(`select * from v_evm_wbs where task_id = $1`, [q[1].id]));
  ok(n(wb.pv) === 130000 && n(wb.ev) === 114000 && n(wb.ac) === 60000, 'WBS "Works" rolls up PV/EV/AC (overhead stays unallocated)');
  const ts = await as(U.coordinator, () => all(`select * from v_evm_timeseries where schedule_id = $1 and grain = 'week' order by period_end`, [SCHQ]));
  const w12 = ts.find((r) => d(r.period_end) === '2026-09-12');
  ok(ts.length === 3 && w12 && n(w12.ev) === 114000 && n(w12.ac) === 65000 && n(ts[2].pv) === 190000 && ts[2].ev === null,
    'weekly S-curve: cumulative PV to 190k, EV/AC up to the status week only');
  ok((await as(U.coordinator, () => one(`select get_evm_timeseries($1::jsonb) r`, [JSON.stringify({ schedule_id: SCHQ, grain: 'day' })]))).r.length === 16, 'daily curve via get_evm_timeseries (1–16 Sep)');
  await as(U.manager, () => db.query(`update project_settings set evm_cost_basis = 'materials' where project_id = $1`, [Q]));
  ok(n((await as(U.coordinator, () => one(`select ac from v_evm_project where schedule_id = $1`, [SCHQ]))).ac) === 10000, 'evm_cost_basis = materials → AC = issued materials only (10 000)');
  await as(U.manager, () => db.query(`update project_settings set evm_cost_basis = 'full' where project_id = $1`, [Q]));

  console.log('\nPrice visibility');
  ok((await as(U.site_engineer, () => all(`select * from v_evm_project`))).length === 0, 'site engineer: v_evm_project empty');
  ok((await as(U.office_engineer, () => all(`select * from v_evm_task`))).length === 0, 'office engineer: v_evm_task empty');
  ok((await as(U.store_keeper, () => all(`select * from v_ac_material_alloc`))).length === 0, 'store keeper: material cost allocation empty');
  const po = await as(U.site_engineer, () => one(`select * from v_progress_overview where schedule_id = $1 and level = 'project'`, [SCHQ]));
  ok(near(po.pct_planned, 68.42) && near(po.pct_earned, 60) && near(po.spi, 0.8769, 0.0001) && near(po.spi_t, 0.92, 0.0001) && po.critical_tasks === 3,
    `site engineer sees % planned 68.42 / earned 60, SPI, SPI(t), 3 critical tasks — no money (${po.pct_planned}/${po.pct_earned})`);
  ok(!Object.keys(po).some((k) => ['pv', 'ev', 'ac', 'bac'].includes(k)), 'progress overview has no money columns');
  ok((await as(U.site_engineer, () => all(`select * from v_boq_progress where schedule_id = $1`, [SCHQ]))).some((r) => n(r.qty_to_date) === 300), 'BoQ quantity progress visible without money');

  // =====================================================================
  console.log('\nPeriod close');
  const PER = uuid();
  await as(U.office_engineer, () => rpc('open_period', { op_id: uuid(), id: PER, schedule_id: SCHQ, kind: 'monthly', period_start: '2026-09-01', status_date: '2026-09-12' }));
  const pending = await rep({ task_id: q[4].id, status_date: '2026-09-12', pct_complete: 30 });
  const prep1 = await as(U.office_engineer, () => rpc('prepare_period_close', { op_id: uuid(), period_id: PER }));
  ok(prep1.blocking.some((b) => b.issue === 'unverified_progress'), 'unverified report before cut-off blocks the close');
  await expectError(as(U.manager, () => rpc('close_period', { op_id: uuid(), period_id: PER })), /needs verification|Cannot close/, 'cannot close with pending verification');
  await as(U.office_engineer, () => rpc('verify_task_progress', { op_id: uuid(), progress_id: pending.id, approve: false, comment: 'Duplicate of the earlier report' }));
  const prep = await as(U.office_engineer, () => rpc('prepare_period_close', { op_id: uuid(), period_id: PER }));
  ok(prep.blocking.length === 0 && prep.breaches.some((b) => b.indicator === 'spi' && b.band === 'critical') && prep.ev === undefined,
    'prepared: SPI critical breach listed, no money in the summary');
  ok((await as(U.manager, () => all(`select * from v_my_approvals where kind = 'period_close'`))).length === 1, 'manager inbox: period to close');
  await expectError(as(U.office_engineer, () => rpc('close_period', { op_id: uuid(), period_id: PER })), /not allowed/, 'office engineer cannot close a period');
  await expectError(as(U.manager, () => rpc('close_period', { op_id: uuid(), period_id: PER })), /Variance explanation needed.*SPI/, 'critical SPI needs a variance note');
  await as(U.office_engineer, () => rpc('save_variance_note', { op_id: uuid(), id: uuid(), period_id: PER, indicator: 'spi',
    cause: 'Footing rebar delivered late', impact: '1 day on frame', corrective_action: 'Second bar-bending gang' }));
  const cl = await as(U.coordinator, () => rpc('close_period', { op_id: uuid(), period_id: PER }));
  ok(cl.status === 'closed', 'coordinator closes the period');
  const snap = await as(U.coordinator, () => one(`select * from evm_snapshots where period_id = $1 and level = 'project'`, [PER]));
  ok(n(snap.pv) === 130000 && n(snap.ev) === 114000 && n(snap.ac) === 65000 && near(snap.spi_t, 0.92, 0.0001), 'project snapshot PV/EV/AC/SPI(t) frozen');
  ok((await as(U.site_engineer, () => all(`select * from evm_snapshots`))).length === 0, 'money snapshot hidden from site engineer');
  const st = await as(U.site_engineer, () => one(`select * from evm_task_status where period_id = $1 and level = 'project'`, [PER]));
  ok(st && near(st.pct_earned, 60) && near(st.spi, 0.8769, 0.0001), 'non-price status snapshot readable by site engineer');
  const pbp = await one(`select * from period_boq_progress where period_id = $1 and boq_item_id = $2`, [PER, BOQ_EXC]);
  ok(pbp && n(pbp.qty_to_date) === 300 && n(pbp.qty_this_period) === 300, 'BoQ quantity at cut-off for the IPC: Q-01 300 m³');
  await expectError(db.query(`update evm_snapshots set ev = 1 where period_id = $1`, [PER]), /closed/, 'closed snapshot is immutable (even for SQL owner)');
  await expectError(db.query(`delete from period_boq_progress where period_id = $1`, [PER]), /closed/, 'closed BoQ snapshot cannot be deleted');
  ok((await one(`select count(*)::int c from alerts where project_id = $1 and rule = 'evm_spi'`, [Q])).c === 1, 'SPI alert raised at close');

  console.log('\nLate (offline) report and late cost after the close');
  const late = await rep({ task_id: q[4].id, status_date: '2026-09-11', pct_complete: 40 });
  ok(late.rolled_to_next_period && d(late.status_date) === '2026-09-13', `report dated 11 Sep rolled to 13 Sep (${d(late.status_date)})`);
  const lr = await one(`select * from task_progress where id = $1`, [late.id]);
  ok(d(lr.original_status_date) === '2026-09-11' && lr.rolled_from_period_id === PER, 'original date and missed period kept');
  ok((await as(U.office_engineer, () => all(`select * from v_my_approvals where entity_id = $1`, [late.id])))[0]?.is_urgent === true, 'late report flagged in the inbox');
  await ver(late.id);
  ok(n((await as(U.coordinator, () => one(`select ev from v_evm_project where schedule_id = $1`, [SCHQ]))).ev) === 114000, 'live EV at the closed cut-off unchanged (114 000)');
  ok(n((await one(`select app.task_earned_pct($1, '2026-09-13') p`, [q[4].id])).p) === 40, 'late progress counts from 13 Sep (next period)');
  const lc = await ce({ number: 'QNET-CE-6', entry_date: '2026-09-10', category: 'subcontract', task_id: q[3].id, description: 'Late invoice', amount: 3000 });
  ok(lc.rolled_to_next_period && d(lc.entry_date) === '2026-09-13', 'cost dated in the closed period rolls to 13 Sep');
  ok((await as(U.coordinator, () => one(`select relates_to_period_id r from cost_entries where number = 'QNET-CE-6'`))).r === PER, 'late cost keeps relates_to_period_id');
  ok(n((await as(U.coordinator, () => one(`select ac from v_evm_project where schedule_id = $1`, [SCHQ]))).ac) === 65000, 'AC at the closed cut-off unchanged');
  await expectError(as(U.office_engineer, () => rpc('save_task_setup', { op_id: uuid(), task_id: q[7].id, ev_method: 'pct' })),
    /needs a comment/, 'EV method change after a closed period needs a comment');

  console.log('\nReopen');
  await expectError(as(U.coordinator, () => rpc('reopen_period', { op_id: uuid(), period_id: PER, reason: 'x' })), /not allowed/, 'only a manager reopens');
  await expectError(as(U.manager, () => rpc('reopen_period', { op_id: uuid(), period_id: PER })), /reason/, 'reopen needs a reason');
  await as(U.manager, () => rpc('reopen_period', { op_id: uuid(), period_id: PER, reason: 'Missed subcontract certificate' }));
  ok((await one(`select status from evm_periods where id = $1`, [PER])).status === 'open'
     && (await one(`select count(*)::int c from evm_snapshots where period_id = $1`, [PER])).c === 0
     && (await one(`select count(*)::int c from audit_log where table_name = 'evm_periods' and action = 'reopen'`)).c === 1,
    'reopened: snapshot removed, audited copy kept');

  // =====================================================================
  console.log('\n30-task import, re-import and progress preservation (P)');
  const P = uuid(), BOQ_P = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'BOLE', 'Bole tower')`, [P]);
    for (const r of Object.keys(U).filter((r) => r !== 'admin')) await db.query(`insert into project_members values ($1, $2)`, [P, U[r]]);
    await db.query(`insert into boq_items (id, project_id, item_no, description, unit, quantity) values ($1, $2, '01.01', 'Concrete C-25', 'm3', 100)`, [BOQ_P, P]);
  });
  const build = (variant) => {
    const tasks = [{ uid: 0, name: 'Bole tower', outline_level: 0, is_summary: true, is_milestone: false, start: '2026-11-02', finish: '2027-02-01', duration_days: 70 }];
    const links = [];
    let cur = '2026-11-02';
    for (let s = 0; s < 3; s++) {
      const su = s * 10 + 1;
      const start = cur;
      const kids = [];
      let prev = s > 0 ? s * 10 : null;   // previous milestone
      for (let k = 1; k <= 8; k++) {
        let uid = su + k;
        if (variant === 2 && (uid === 7 || uid === 8)) continue;
        if (variant === 2 && uid === 9) uid = 99;
        const st = cur, fi = plusWd(cur, 4);
        let name = `Task ${uid}`;
        let s2 = st, f2 = fi;
        if (variant === 2 && uid === 5) { s2 = plusWd(st, 2); f2 = plusWd(fi, 2); }
        if (variant === 2 && uid === 6) name = 'Task 6 renamed';
        kids.push({ uid, guid: `P-${su + k}`, id: uid, name, wbs: `${s + 1}.${k}`, outline_level: 2, is_summary: false, is_milestone: false,
          start: s2 + 'T08:00:00', finish: f2 + 'T17:00:00', duration_days: 5, cost: 1000 * uid,
          baselines: [{ number: 0, start: st, finish: fi, duration_days: 5, cost: 1000 * uid }],
          ...(uid === 2 ? { boq_codes: '01.01;99.99' } : {}) });
        if (prev != null) links.push({ pred_uid: prev, succ_uid: uid, type: 'FS', lag_days: 0 });
        prev = uid;
        cur = nextWd(fi);
      }
      if (variant === 2 && s === 0) {   // new task 40 at the end of the first summary
        kids.push({ uid: 40, guid: 'P-40', id: 40, name: 'Task 40 (new)', wbs: '1.9', outline_level: 2, is_summary: false, is_milestone: false,
          start: cur + 'T08:00:00', finish: plusWd(cur, 2) + 'T17:00:00', duration_days: 3 });
        links.push({ pred_uid: prev, succ_uid: 40, type: 'FS', lag_days: 0 }); prev = 40;
      }
      const mu = (s + 1) * 10;
      kids.push({ uid: mu, guid: `P-${mu}`, id: mu, name: `Milestone ${s + 1}`, wbs: `${s + 1}.M`, outline_level: 2, is_summary: false, is_milestone: true,
        start: cur + 'T08:00:00', finish: cur + 'T08:00:00', duration_days: 0, baselines: [{ number: 0, start: cur, finish: cur, duration_days: 0 }] });
      links.push({ pred_uid: prev, succ_uid: mu, type: 'FS', lag_days: 0 });
      tasks.push({ uid: su, guid: `P-${su}`, id: su, name: `Section ${s + 1}`, wbs: `${s + 1}`, outline_level: 1, is_summary: true, is_milestone: false,
        start: start + 'T08:00:00', finish: cur + 'T17:00:00', duration_days: 40 }, ...kids);
    }
    links.push({ pred_uid: 11, succ_uid: 30, type: 'FS', lag_days: 0 });   // summary → milestone: expanded to the summary's leaves
    return { source: 'mspdi', file_name: `bole-v${variant}.xml`, file_sha256: `bole-${variant}`, warnings: ['parser: 1 inactive task skipped'],
      header: { name: 'Bole tower', start_date: '2026-11-02', minutes_per_day: 480, minutes_per_week: 2880, days_per_month: 26, currency_code: 'ETB', baseline_for_ev: 0 },
      calendars: [{ uid: 1, name: 'Six-day', is_base: true, week: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, working: dow !== 0, minutes: dow === 0 ? 0 : dow === 6 ? 240 : 480 })),
        exceptions: [{ from: '2026-12-31', to: '2027-01-01', working: false, name: 'Year-end shutdown' }] }],
      project_calendar_uid: 1, tasks, links };
  };
  const v1 = build(1);
  ok(v1.tasks.length === 31, '30 tasks + project summary in the file');
  const SCHP = uuid();
  const i1 = await as(U.office_engineer, () => rpc('import_schedule', { op_id: uuid(), project_id: P, schedule_id: SCHP, schedule: v1 }));
  ok(i1.added === 30 && i1.changed === 0 && i1.removed === 0 && i1.version_no === 1, `v1: 30 added (${i1.added})`);
  ok(i1.links === 35 && i1.quality.summary_links_expanded === 9, `35 links (26 + summary link expanded to 9 leaf links) (${i1.links}, ${i1.quality.summary_links_expanded})`);
  ok(i1.warnings.some((w) => /not saved: your role cannot see prices/.test(w)) && i1.warnings.some((w) => /99\.99 not found/.test(w))
     && i1.warnings.some((w) => /inactive/.test(w)), 'warnings: costs dropped (non-price importer), unknown BoQ code, parser warnings');
  ok((await one(`select count(*)::int c from schedule_task_costs k join schedule_tasks t on t.id = k.task_id where t.schedule_id = $1`, [SCHP])).c === 0, 'no costs stored');
  const pc = await one(`select * from project_calendars where project_id = $1 and is_default`, [P]);
  ok(pc.working_weekdays.join() === '1,2,3,4,5,6' && n(pc.saturday_factor) === 0.5 && pc.source === 'msp_import', 'MSP calendar: Mon–Sat, Saturday half day');
  ok((await one(`select app.is_working_day($1, '2027-01-01') w`, [P])).w === false && (await one(`select count(*)::int c from calendar_exceptions where calendar_id = $1`, [pc.id])).c === 2,
    'MSP calendar exceptions imported (31 Dec – 1 Jan)');
  ok(i1.quality.leaf_tasks === 27 && i1.quality.summary_tasks === 3 && i1.quality.milestones === 3, 'quality report counts');
  let p1 = Object.fromEntries((await all(`select * from schedule_tasks where schedule_id = $1`, [SCHP])).map((t) => [t.msp_uid, t]));
  ok(p1[2].parent_id === p1[1].id && p1[12].parent_id === p1[11].id && p1[10].is_milestone, 'WBS hierarchy and milestones');
  const dup = await as(U.office_engineer, () => rpc('import_schedule', { op_id: uuid(), project_id: P, schedule_id: SCHP, schedule: v1 }));
  ok(dup.duplicate === true && dup.version_no === 1, 'same file again → no-op, earlier result returned');

  // progress before re-import: 7 verified, 5 reported only
  const r7 = await rep({ task_id: p1[7].id, status_date: '2026-10-30', pct_complete: 100, actual_start: '2026-10-28', actual_finish: '2026-10-30' });
  await ver(r7.id);
  const r5 = await rep({ task_id: p1[5].id, status_date: '2026-10-30', pct_complete: 0 });
  // self-verification is not allowed
  const own = await as(U.office_engineer, () => rpc('report_task_progress', { op_id: uuid(), id: uuid(), task_id: p1[3].id, status_date: '2026-10-30', pct_complete: 0 }));
  await expectError(as(U.office_engineer, () => rpc('verify_task_progress', { op_id: uuid(), progress_id: own.id, approve: true })), /own progress/, 'cannot verify own report');

  const i2 = await as(U.office_engineer, () => rpc('import_schedule', { op_id: uuid(), project_id: P, schedule_id: SCHP, schedule: build(2) }));
  const chUids = i2.diff.changed.map((c) => c.uid);
  ok(i2.added === 1 && i2.diff.added[0].uid === 40, `v2: task 40 added (${i2.added})`);
  ok(chUids.includes(5) && chUids.includes(6) && chUids.includes(99), `changed: 5 (dates), 6 (renamed), 9→99 (UID, matched by GUID) (${chUids})`);
  ok(i2.diff.changed.find((c) => c.uid === 6).fields.name[1] === 'Task 6 renamed', 'diff shows old/new name');
  ok(i2.removed === 1 && i2.diff.removed[0].uid === 8, 'task 8 (no progress) soft-deleted');
  ok(i2.kept_progress === 1 && i2.diff.kept_progress[0].uid === 7, 'task 7 (verified progress) kept, flagged removed in source');
  const p2 = Object.fromEntries((await all(`select * from schedule_tasks where schedule_id = $1`, [SCHP])).map((t) => [t.msp_uid, t]));
  ok(p2[7].deleted_at === null && p2[7].source_state === 'removed_in_source' && n(p2[7].pct_complete) === 100, 'task 7 keeps 100 % and its id');
  ok(p2[8].deleted_at !== null && p2[99].id === p1[9].id && p2[9] === undefined, 'task 8 deleted; task 9 is now UID 99 with the same id');
  ok(p2[5].id === p1[5].id && (await one(`select count(*)::int c from task_progress where task_id = $1`, [p1[5].id])).c === 1
     && d(p2[5].planned_start) !== d(p1[5].planned_start), 'task 5: new dates, same id, its progress report still attached');
  ok((await one(`select count(*)::int c from schedule_links where (pred_task_id = $1 or succ_task_id = $1) and deleted_at is null`, [p1[7].id])).c === 0,
    'links of the removed task replaced');
  ok(p2[40].ev_method === '0_100' && d(p2[2].baseline_start) === d(p1[2].baseline_start), 'new task gets a default method; mapping/baseline kept');
  ok((await one(`select count(*)::int c from task_boq_links where task_id = $1 and deleted_at is null`, [p1[2].id])).c === 1, 'BoQ mapping preserved across re-import');
  void r5;

  console.log('\nRe-baseline (P)');
  const B1 = uuid(), B2 = uuid();
  await as(U.office_engineer, () => rpc('set_baseline', { op_id: uuid(), id: B1, schedule_id: SCHP, source: 'current_plan' }));
  await expectError(as(U.office_engineer, () => rpc('set_baseline', { op_id: uuid(), id: uuid(), schedule_id: SCHP })), /waiting for approval/, 'one proposal at a time');
  await as(U.coordinator, () => rpc('approve_baseline', { op_id: uuid(), baseline_id: B1, approve: true }));
  await expectError(as(U.office_engineer, () => rpc('set_baseline', { op_id: uuid(), id: uuid(), schedule_id: SCHP })), /needs a reason/, 're-baseline needs a reason');
  await as(U.coordinator, () => rpc('set_baseline', { op_id: uuid(), id: B2, schedule_id: SCHP, source: 'current_plan', reason: 'Change order 3' }));
  await expectError(as(U.coordinator, () => rpc('approve_baseline', { op_id: uuid(), baseline_id: B2, approve: true })), /you proposed/, 'proposer cannot approve own baseline');
  await as(U.manager, () => rpc('approve_baseline', { op_id: uuid(), baseline_id: B2, approve: true }));
  const bls = await all(`select baseline_no, status from schedule_baselines where schedule_id = $1 order by baseline_no`, [SCHP]);
  ok(bls.length === 2 && bls[0].status === 'superseded' && bls[1].status === 'approved', 'all baselines kept: #1 superseded, #2 approved');
  ok((await one(`select approved_baseline_id b from schedules where id = $1`, [SCHP])).b === B2, 'schedule points at baseline #2');

  console.log('\nIdempotency & contract helpers');
  const opId = uuid();
  const x1 = await as(U.office_engineer, () => rpc('run_forecast', { op_id: opId, schedule_id: SCHP, status_date: '2026-10-30' }));
  const x2 = await as(U.office_engineer, () => rpc('run_forecast', { op_id: opId, schedule_id: SCHP, status_date: '2026-10-30' }));
  ok(JSON.stringify(x1) === JSON.stringify(x2), 'replayed op returns the first result');
  ok(C.isoDurToDays('PT16H0M0S', 7, 480) === 2 && C.isoDurToDays('PT168H0M0S', 8, 480) === 7, 'ISO duration → days (working and elapsed)');
  ok(C.tenthsToDays(48000, 7, 480) === 10 && C.tenthsToDays(-4800, 7, 480) === -1, 'LinkLag tenths of a minute → days');
  ok(C.mspCost('6000000') === 60000 && C.MSP_LINK_TYPE[3] === 'SS', 'currency ÷100, link type codes');
  ok(JSON.stringify(C.parsePredecessors('12FS+2d;15SS;18FF-1d', 20).map((l) => [l.pred_uid, l.type, l.lag_days])) === '[[12,"FS",2],[15,"SS",0],[18,"FF",-1]]',
    'Unique ID Predecessors parsed');
  ok(C.evmBand(0.877) === 'critical' && C.evmBand(0.93) === 'warning' && C.evmBand(1) === 'ok', 'band helper matches thresholds');
  ok(C.SYNC_TABLES_SCHEDULE.every((t) => !C.PRICE_TABLES_SCHEDULE.some((p) => p.name === t.name)), 'sync list has no price tables');

  if (skipped.length) console.log(`\nNOTE: skipped parallel migrations: ${skipped.join(', ')}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
