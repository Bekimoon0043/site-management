// Monthly Tasks Window / look-ahead test (migration 20261030000004_lookahead.sql).
// Applies all migrations + seed in PGlite with the Supabase stubs used by the
// other suites. If the schedule & calendar migration (20261030000003_*) is not in
// the folder yet, a minimal stub of its fixed interface is installed in its place.
//
// Scenario (planning "today" = Mon 26 Oct 2026, via the app.lookahead_today GUC):
// November 2026 plan, Mon–Sat calendar with a site shutdown on Sat 21 Nov,
// tasks in every window class, auto constraints (predecessor, material short with
// a late PO, hold point, drawing), material maths + flags + pack rounding,
// PR / SUR drafts, commitments → close_week PPC 75 % → RNC Pareto → roll-forward,
// regenerate keeps commitments, holidays (Jan 2027), Ethiopian month + Kiremt.
//
//   node supabase/tests/lookahead.test.mjs

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

// Temporary stand-in for 20261030000003_schedule_evm.sql (fixed interface only).
const SCHEDULE_STUB = `
create table public.public_holidays (id uuid primary key default gen_random_uuid(), on_date date not null, name text not null,
  name_am text, is_tentative boolean not null default false, country text not null default 'ET', updated_at timestamptz default now());
create table public.project_calendars (id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects (id),
  name text not null default 'Standard 6-day', working_weekdays int[] not null default '{1,2,3,4,5,6}', hours_per_day numeric not null default 8,
  saturday_factor numeric not null default 1, is_default boolean not null default true, updated_at timestamptz default now());
create table public.calendar_exceptions (id uuid primary key default gen_random_uuid(), calendar_id uuid not null references public.project_calendars (id),
  project_id uuid not null, on_date date not null, is_working boolean not null default false, name text, updated_at timestamptz default now());
create function app.is_working_day(p_project uuid, p_date date) returns boolean language sql stable as $$
  with cal as (select * from public.project_calendars where project_id = p_project and is_default limit 1)
  select coalesce(
    (select e.is_working from public.calendar_exceptions e join cal on cal.id = e.calendar_id where e.on_date = p_date limit 1),
    case when exists (select 1 from public.public_holidays h where h.on_date = p_date) then false end,
    extract(isodow from p_date)::int = any (coalesce((select working_weekdays from cal), '{1,2,3,4,5,6}')))
$$;
create function app.working_days(p_project uuid, p_from date, p_to date) returns int language sql stable as $$
  select count(*)::int from generate_series(p_from, p_to, interval '1 day') d where app.is_working_day(p_project, d::date)
$$;
create function app.add_working_days(p_project uuid, p_date date, p_n int) returns date language plpgsql stable as $$
declare d date := p_date; k int := 0;
begin
  while k < abs(p_n) loop d := d + sign(p_n)::int; if app.is_working_day(p_project, d) then k := k + 1; end if; end loop;
  return d;
end $$;
create table public.schedules (id uuid primary key, project_id uuid not null references public.projects (id), name text not null,
  status text not null default 'active', current_version_id uuid, updated_at timestamptz default now());
create table public.schedule_tasks (id uuid primary key, project_id uuid not null, schedule_id uuid not null references public.schedules (id),
  msp_uid int, msp_guid uuid, wbs text, outline_level int not null default 1, parent_id uuid references public.schedule_tasks (id),
  name text not null, is_summary boolean not null default false, is_milestone boolean not null default false,
  planned_start date, planned_finish date, baseline_start date, baseline_finish date, forecast_start date, forecast_finish date,
  actual_start date, actual_finish date, duration_days numeric, pct_complete numeric not null default 0,
  is_critical boolean not null default false, total_float_days numeric, sort_order int not null default 0,
  deleted_at timestamptz, updated_at timestamptz default now());
create table public.schedule_links (id uuid primary key default gen_random_uuid(), project_id uuid not null, schedule_id uuid not null,
  pred_task_id uuid not null references public.schedule_tasks (id), succ_task_id uuid not null references public.schedule_tasks (id),
  link_type text not null default 'FS', lag_days numeric not null default 0);
create table public.task_boq_links (id uuid primary key default gen_random_uuid(), project_id uuid not null,
  task_id uuid not null references public.schedule_tasks (id), boq_item_id uuid not null references public.boq_items (id), qty_share numeric);
create table public.task_element_links (id uuid primary key default gen_random_uuid(), project_id uuid not null,
  task_id uuid not null references public.schedule_tasks (id), element_id uuid not null references public.elements (id));
create table public.task_progress (id uuid primary key default gen_random_uuid(), project_id uuid not null, task_id uuid not null,
  status text not null default 'reported');
do $$ declare t text; begin
  foreach t in array array['project_calendars','calendar_exceptions','schedules','schedule_tasks','schedule_links',
                           'task_boq_links','task_element_links','task_progress'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy member_read on public.%I for select to authenticated using (app.is_member(project_id))', t);
  end loop;
end $$;
alter table public.public_holidays enable row level security;
create policy read_all on public.public_holidays for select to authenticated using (true);
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
const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d === null || d === undefined ? null : String(d).slice(0, 10));
const setToday = (d) => db.query(`select set_config('app.lookahead_today', $1, false)`, [d]);

async function expectError(promise, pattern, msg) {
  try { await promise; ok(false, `${msg} (no error raised)`); }
  catch (e) { ok(pattern.test(e.message), `${msg} → "${e.message}"`); }
}

async function main() {
  // ---- migrations ----------------------------------------------------------
  const files = readdirSync(join(root, 'migrations')).sort();
  const realSchedule = files.some((f) => f.startsWith('20261030000003_'));
  console.log(`Applying migrations (${realSchedule ? 'REAL schedule migration' : 'schedule STUB — 20261030000003_* not present'})…`);
  await db.exec(STUBS);
  let stubbed = false;
  for (const f of files) {
    if (!realSchedule && !stubbed && f > '20261030000003') {
      await db.exec(SCHEDULE_STUB);
      stubbed = true;
      console.log('  applied schedule stub');
    }
    await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
    console.log('  applied', f);
  }
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);
  await setToday('2026-10-26');

  // ---- users & project -------------------------------------------------------
  const U = {};
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper', 'procurement']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role }, { role }]);
  }
  const outsider = uuid();
  await db.query(`insert into auth.users (id, email, raw_app_meta_data) values ($1, 'out@test.et', '{"role":"site_engineer"}')`, [outsider]);

  const P = uuid(), B = uuid(), L2 = uuid(), S = uuid();
  const C12 = uuid(), B1 = uuid(), S1 = uuid(), W1 = uuid(), R1 = uuid(), F1 = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'BOLE', 'Bole Mixed-Use')`, [P]);
    for (const r of ['coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper', 'procurement']) {
      await db.query(`insert into project_members (project_id, user_id) values ($1, $2)`, [P, U[r]]);
    }
    await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'A', 'Block A')`, [B, P]);
    await db.query(`insert into levels (id, project_id, block_id, code, name, sort_order) values ($1, $2, $3, 'L2', 'Level 2', 2)`, [L2, P, B]);
    await db.query(`insert into stores (id, project_id, name) values ($1, $2, 'Main store')`, [S, P]);
    await db.query(`insert into elements (id, project_id, block_id, level_id, code, element_type, drawing_ref) values
      ($1, $7, $8, $9, 'C12', 'column', 'S-101 IFC'), ($2, $7, $8, $9, 'B1', 'beam', 'S-201 rev P2 draft'),
      ($3, $7, $8, $9, 'S1', 'slab', null), ($4, $7, $8, $9, 'W1', 'wall', null), ($5, $7, $8, $9, 'R1', 'slab', null),
      ($6, $7, $8, $9, 'F1', 'footing', null)`, [C12, B1, S1, W1, R1, F1, P, B, L2]);
  });
  const spec = async (name, grade) => (await one(
    `select s.id from material_specs s join materials m on m.id = s.material_id where m.name = $1 and s.grade = $2`, [name, grade])).id;
  const R16 = await spec('Rebar', 'S-400 Ø16');
  const R500 = await spec('Rebar', 'S-500 Ø16');
  const CONC = await spec('Concrete', 'C-25/30');
  const HCB = await spec('HCB', '20cm Class B');
  const CEM = await spec('Cement', 'OPC 42.5');
  const MEM = await spec('Bituminous membrane', '4mm');
  await db.query(`update material_specs set wastage_pct = 5 where id = $1`, [R16]);
  await db.query(`update material_specs set lead_time_days = 10 where id = $1`, [CONC]);
  await db.query(`update material_specs set pack_size = 50 where id = $1`, [HCB]);
  await db.query(`update material_specs set pack_size = 5 where id = $1`, [CEM]);
  const BQ1 = uuid();
  await db.query(`insert into boq_items (id, project_id, item_no, description, unit, quantity) values ($1, $2, '07.01', 'Roof membrane', 'm2', 500)`, [BQ1, P]);
  await db.query(`insert into element_takeoffs (project_id, element_id, material_spec_id, planned_qty, boq_item_id) values
    ($1, $2, $3, 400, null), ($1, $4, $5, 2000, null), ($1, $6, $7, 30, null), ($1, $8, $9, 1000, null), ($1, $8, $10, 23.3, null),
    ($1, $11, $12, 500, $13)`, [P, C12, R16, B1, R500, S1, CONC, W1, HCB, CEM, R1, MEM, BQ1]);

  // stock: rebar Ø16 300 opening − 100 issued to C12 = 200; HCB 400
  const doc = uuid();
  await db.query(`insert into stock_ledger (project_id, store_id, material_spec_id, qty, stock_status, txn_type, doc_type, doc_id, doc_number, element_id, txn_at)
    values ($1, $2, $3, 300, 'available', 'opening', 'opening', $4, 'OPENING', null, now()),
           ($1, $2, $3, -100, 'available', 'miv', 'miv', $4, 'BOLE-MIV-D001-0001', $5, now()),
           ($1, $2, $6, 400, 'available', 'opening', 'opening', $4, 'OPENING', null, now())`, [P, S, R16, doc, C12, HCB]);
  // open PO for 650 HCB arriving 1 Dec (after the need-by date)
  const SUP = uuid(), PO = uuid();
  await db.query(`insert into suppliers (id, name) values ($1, 'Habesha Blocks')`, [SUP]);
  await db.query(`insert into purchase_orders (id, project_id, number, supplier_id, delivery_store_id, status, eta)
    values ($1, $2, 'BOLE-PO-D001-0001', $3, $4, 'sent', '2026-12-01')`, [PO, P, SUP, S]);
  await db.query(`insert into po_lines (id, po_id, project_id, line_no, material_spec_id, qty) values ($1, $2, $3, 1, $4, 650)`, [uuid(), PO, P, HCB]);

  // calendar: Mon–Sat; site shutdown Sat 21 Nov; national holidays for Jan 2027
  await db.query(`insert into project_calendars (id, project_id, name, working_weekdays, hours_per_day, saturday_factor, is_default)
    select gen_random_uuid(), $1, 'Standard 6-day', '{1,2,3,4,5,6}', 8, 1, true
    where not exists (select 1 from project_calendars where project_id = $1)`, [P]);
  const CAL = (await one(`select id from project_calendars where project_id = $1 order by is_default desc limit 1`, [P])).id;
  await db.query(`insert into calendar_exceptions (id, calendar_id, project_id, on_date, is_working, name)
    values (gen_random_uuid(), $1, $2, '2026-11-21', false, 'Site shutdown')`, [CAL, P]);
  for (const [d, n, am] of [['2027-01-07', 'Genna', 'ገና'], ['2027-01-19', 'Timket', 'ጥምቀት']]) {
    await db.query(`insert into public_holidays (id, on_date, name, name_am, is_tentative, country)
      select gen_random_uuid(), $1::date, $2, $3, false, 'ET' where not exists (select 1 from public_holidays where on_date = $1::date)`, [d, n, am]);
  }

  // schedule (as imported from MS Project)
  const SCH = uuid();
  await db.query(`insert into schedules (id, project_id, name, status) values ($1, $2, 'Master programme', 'active')`, [SCH, P]);
  const T = {};
  const task = async (key, o) => {
    T[key] = uuid();
    await db.query(`insert into schedule_tasks (id, project_id, schedule_id, msp_uid, wbs, outline_level, parent_id, name, is_summary, is_milestone,
        planned_start, planned_finish, forecast_start, forecast_finish, pct_complete, is_critical, sort_order, duration_days)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [T[key], P, SCH, o.uid, o.wbs, o.parent ? 2 : 1, o.parent ? T[o.parent] : null, o.name, !!o.summary, !!o.milestone,
       o.s, o.f, o.fs ?? null, o.ff ?? null, o.pct ?? 0, !!o.critical, o.uid, o.dur ?? 1]);
  };
  await task('SUM', { uid: 1, wbs: '1', name: 'Block A structure', summary: true, s: '2026-10-01', f: '2027-01-31' });
  await task('T1', { uid: 2, wbs: '1.1', parent: 'SUM', name: 'Excavation & footings Block A', s: '2026-10-05', f: '2026-10-24', pct: 80 });
  await task('T2', { uid: 3, wbs: '1.2', parent: 'SUM', name: 'Columns C1–C24 L2', s: '2026-10-19', f: '2026-11-10', pct: 40, critical: true });
  await task('T3', { uid: 4, wbs: '1.3', parent: 'SUM', name: 'Beams L2 formwork & rebar', s: '2026-11-03', f: '2026-11-12' });
  await task('T4', { uid: 5, wbs: '1.4', parent: 'SUM', name: 'Slab S1 L2 casting', s: '2026-11-16', f: '2026-11-17' });
  await task('T9', { uid: 6, wbs: '1.5', parent: 'SUM', name: 'L2 slab poured', milestone: true, s: '2026-11-17', f: '2026-11-17' });
  await task('T5', { uid: 7, wbs: '1.6', parent: 'SUM', name: 'Blockwork L2', s: '2026-11-23', f: '2026-12-05' });
  await task('T6', { uid: 8, wbs: '1.7', parent: 'SUM', name: 'Roof waterproofing', s: '2026-12-07', f: '2026-12-19' });
  await task('T7', { uid: 9, wbs: '1.8', parent: 'SUM', name: 'Finishes L1 (forecast late)', s: '2026-11-20', f: '2026-11-30', fs: '2026-12-16', ff: '2026-12-30' });
  await task('T8', { uid: 10, wbs: '1.9', parent: 'SUM', name: 'Lift installation', s: '2026-10-01', f: '2026-12-31', pct: 10 });
  await task('T10', { uid: 11, wbs: '1.10', parent: 'SUM', name: 'Site mobilisation', s: '2026-11-02', f: '2026-11-04', pct: 100 });
  await task('T12', { uid: 12, wbs: '1.11', parent: 'SUM', name: 'Plastering L1', s: '2027-01-04', f: '2027-01-23' });
  await task('T11', { uid: 13, wbs: '1.12', parent: 'SUM', name: 'Footing concrete Block B', s: '2027-07-12', f: '2027-07-20' });
  for (const [t, e] of [['T2', C12], ['T3', B1], ['T4', S1], ['T5', W1], ['T11', F1]]) {
    await db.query(`insert into task_element_links (id, project_id, task_id, element_id) values (gen_random_uuid(), $1, $2, $3)`, [P, T[t], e]);
  }
  await db.query(`insert into task_boq_links (id, project_id, task_id, boq_item_id, qty_share) values (gen_random_uuid(), $1, $2, $3, 250)`, [P, T.T6, BQ1]);
  await db.query(`insert into schedule_links (id, project_id, schedule_id, pred_task_id, succ_task_id, link_type, lag_days)
    values (gen_random_uuid(), $1, $2, $3, $4, 'FS', 0)`, [P, SCH, T.T2, T.T3]);

  // ---- calendar helpers ----------------------------------------------------
  console.log('\nCalendar & window');
  ok(num((await one(`select app.la_wd($1, '2026-11-01', '2026-11-30') n`, [P])).n) === 24,
    'Nov 2026 has 24 working days (Mon–Sat = 25, minus the Sat 21 Nov shutdown)');
  ok(iso((await one(`select app.la_shift($1, '2026-11-23', -3) d`, [P])).d) === '2026-11-18',
    'la_shift(23 Nov, −3) skips Sunday + the shutdown → 18 Nov');
  ok(iso((await one(`select app.la_shift($1, '2027-01-08', -1) d`, [P])).d) === '2027-01-06', 'la_shift skips Genna (Thu 7 Jan 2027)');

  // preview (read-only)
  const prev = await as(U.site_engineer, () => rpc('get_lookahead_preview', { project_id: P, calendar_mode: 'gregorian', year: 2026, month: 11 }));
  ok(prev.items.length === 8 && prev.weeks.length === 7 && prev.plan_id === null,
    `preview: 8 candidate tasks, 7 weeks, nothing persisted (${prev.items.length} items, ${prev.weeks.length} weeks)`);

  // ---- generation ----------------------------------------------------------
  console.log('\nGenerate November 2026');
  await expectError(as(U.site_engineer, () => rpc('generate_lookahead', { project_id: P, year: 2026, month: 11 })),
    /not allowed/, 'site engineer cannot generate a look-ahead');
  const genOp = uuid();
  const gen = await as(U.office_engineer, () => rpc('generate_lookahead', { op_id: genOp, project_id: P, calendar_mode: 'gregorian', month: '2026-11' }));
  const PLAN = gen.plan_id;
  ok(gen.ok && gen.new === 8 && gen.items === 8, `plan generated with 8 items (new ${gen.new})`);
  ok(iso(gen.period_start) === '2026-11-01' && iso(gen.period_end) === '2026-11-30' && iso(gen.horizon_end) === '2026-12-14',
    'window = 1–30 Nov + 2 weeks (horizon 14 Dec)');
  const replay = await as(U.office_engineer, () => rpc('generate_lookahead', { op_id: genOp, project_id: P, month: '2026-11' }));
  ok(JSON.stringify(replay) === JSON.stringify(gen), 'replay with the same op_id returns the first result');
  const plan = await one(`select * from lookahead_plans where id = $1`, [PLAN]);
  ok(plan.period_label === '2026-11' && num(plan.working_days) === 24 && plan.status === 'draft',
    `plan label ${plan.period_label}, 24 working days, draft (am: ${plan.period_label_am})`);
  const weeks = await all(`select week_no, week_start, week_end, working_days, in_buffer from lookahead_weeks where plan_id = $1 order by week_no`, [PLAN]);
  const wkStr = weeks.map((w) => `${iso(w.week_start)}..${iso(w.week_end)}:${num(w.working_days)}${w.in_buffer ? 'b' : ''}`).join(' ');
  ok(wkStr === '2026-11-02..2026-11-07:6 2026-11-09..2026-11-14:6 2026-11-16..2026-11-21:5 2026-11-23..2026-11-28:6 '
    + '2026-11-30..2026-12-05:6 2026-12-07..2026-12-12:6b 2026-12-14..2026-12-14:1b', `Mon–Sat weeks with working days: ${wkStr}`);

  const items = Object.fromEntries((await all(`select i.*, st.msp_uid from lookahead_items i join schedule_tasks st on st.id = i.schedule_task_id
    where i.plan_id = $1`, [PLAN])).map((r) => [Object.keys(T).find((k) => T[k] === r.schedule_task_id), r]));
  const roles = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.window_role]));
  ok(roles.T1 === 'late' && roles.T2 === 'finishing' && roles.T3 === 'starting' && roles.T4 === 'starting' && roles.T9 === 'starting'
    && roles.T5 === 'starting' && roles.T6 === 'starting_next' && roles.T8 === 'ongoing', `classes: ${JSON.stringify(roles)}`);
  ok(!items.SUM && !items.T7 && !items.T10, 'summary, 100 % task and task forecast beyond the horizon are excluded');
  ok(items.T2.group_name === 'Block A structure' && items.T2.element_id === C12 && items.T9.is_milestone && items.T2.is_critical,
    'group header, primary element, milestone and critical flags captured');
  ok(JSON.stringify(items.T2.week_days) === JSON.stringify({ '2026-11-02': 6, '2026-11-09': 2 }),
    `T2 working days per week ${JSON.stringify(items.T2.week_days)}`);
  ok(num(items.T8.target_pct_end_of_period) > 0 && num(items.T8.target_pct_end_of_period) < 100 && num(items.T3.target_pct_end_of_period) === 100,
    `expected % at period end: lift ${items.T8.target_pct_end_of_period}, beams 100`);

  // ---- material needs ------------------------------------------------------
  console.log('\nMaterial needs');
  const need = async (t, sp) => one(`select * from v_lookahead_material_needs where plan_id = $1 and item_id = $2 and material_spec_id = $3`,
    [PLAN, items[t].id, sp]);
  const n2 = await need('T2', R16);
  ok(num(n2.total_need) === 420 && num(n2.remaining) === 252 && num(n2.window_need) === 144,
    `columns rebar: 400×1.05 = 420, remaining 420 − max(40 %, 100 issued) = 252, in window 252×8/14 = ${n2.window_need}`);
  ok(iso(n2.need_by) === '2026-10-29' && num(n2.from_stock) === 144 && num(n2.short_firm) === 0 && n2.suggest_sur && n2.need_status === 'covered',
    'need-by 29 Oct (3 safety days before 1 Nov), covered from stock → suggest a site-use request');
  ok(num(n2.weekly_need['2026-11-02']) === 108 && num(n2.weekly_need['2026-11-09']) === 36, `weekly need ${JSON.stringify(n2.weekly_need)}`);
  const n3 = await need('T3', R500);
  ok(num(n3.window_need) === 2060 && iso(n3.need_by) === '2026-10-30' && iso(n3.order_by) === '2026-10-19' && n3.late_order && n3.raise_pr_now,
    `beam rebar S-500: 2060 kg, need-by 30 Oct, order-by 19 Oct (10-day lead) → late order (${n3.need_status})`);
  const n4 = await need('T4', CONC);
  ok(num(n4.window_need) === 30.6 && iso(n4.order_by) === '2026-10-31' && n4.raise_pr_now && !n4.late_order && num(n4.suggested_qty) === 31,
    'slab concrete 30.6 m³, order by 31 Oct (≤ today+7) → raise PR now, 31 m³ after rounding');
  const n5 = await need('T5', HCB);
  ok(num(n5.window_need) === 1050 && iso(n5.need_by) === '2026-11-18' && num(n5.from_stock) === 400 && num(n5.from_po) === 0
    && num(n5.from_po_late) === 650 && num(n5.short_firm) === 650 && num(n5.to_order) === 0 && n5.arrives_late && iso(n5.late_po_eta) === '2026-12-01',
    'HCB: 1050 needed, 400 in stock, PO 650 arrives 1 Dec after need-by 18 Nov → short 650 (arrives late), nothing to order');
  const n5c = await need('T5', CEM);
  ok(num(n5c.to_order) === 23.766 && num(n5c.suggested_qty) === 25 && !n5c.raise_pr_now,
    'cement 23.766 qtl short, rounded up to pack of 5 → 25; order-by 14 Nov not yet urgent');
  const n6 = await need('T6', MEM);
  ok(num(n6.total_need) === 270 && num(n6.window_need) === 157.5 && num(n6.suggested_qty) === 158,
    `roof membrane via BoQ link (250 of 500 m² → 500×1.08×0.5 = 270), 7 of 12 working days in window → ${n6.window_need}`);
  const summ = await all(`select * from v_lookahead_material_summary where plan_id = $1 order by label`, [PLAN]);
  ok(summ.length === 6 && summ.filter((s) => s.raise_pr_now).length === 2, `summary: 6 materials, 2 to order now`);
  ok(gen.material_shortfalls === 5 && gen.raise_pr_now === 2 && gen.late_order === 1, `generate summary ${gen.material_shortfalls}/${gen.raise_pr_now}/${gen.late_order}`);

  // ---- constraints & readiness ---------------------------------------------
  console.log('\nConstraints & readiness');
  const cons = async (t) => all(`select * from lookahead_constraints where item_id = $1 order by ctype, source_type`, [items[t].id]);
  const c3 = await cons('T3');
  const pred = c3.find((c) => c.ctype === 'predecessor');
  ok(pred && pred.auto && pred.source_id === T.T2 && iso(pred.due_date) === '2026-10-31' && /40% complete/.test(pred.description),
    `beams: predecessor "${pred?.description}" due 31 Oct`);
  ok(c3.some((c) => c.ctype === 'material' && c.material_spec_id === R500 && num(c.qty_short) === 2060 && c.status === 'open'),
    'beams: material constraint for S-500 rebar (2060 short)');
  ok(c3.some((c) => c.ctype === 'information' && c.source_id === B1), 'beams: drawing marked draft → information constraint');
  const c4 = await cons('T4');
  const insp = c4.find((c) => c.ctype === 'inspection');
  ok(insp && /Pre-pour inspection/.test(insp.description) && iso(insp.due_date) === '2026-11-13', `slab casting: ${insp?.description}`);
  const c5 = await cons('T5');
  const hcbC = c5.find((c) => c.material_spec_id === HCB);
  ok(hcbC && hcbC.status === 'in_progress' && hcbC.owner_role === 'procurement' && /arrives 01 Dec 2026 \(late\)/.test(hcbC.description),
    `HCB short with late PO → in progress, owner procurement: "${hcbC?.description}"`);
  const ready = Object.fromEntries((await all(`select schedule_task_id, readiness from lookahead_items where plan_id = $1`, [PLAN]))
    .map((r) => [Object.keys(T).find((k) => T[k] === r.schedule_task_id), r.readiness]));
  ok(ready.T1 === 'ready' && ready.T2 === 'ready' && ready.T8 === 'ready' && ready.T9 === 'ready', 'late / finishing / ongoing / milestone items without constraints are ready');
  ok(ready.T3 === 'at_risk' && ready.T4 === 'at_risk' && ready.T5 === 'at_risk' && ready.T6 === 'at_risk',
    `items with constraints due in the future are at risk (${ready.T3}, ${ready.T4}, ${ready.T5}, ${ready.T6})`);
  const rd = await one(`select * from v_lookahead_readiness where item_id = $1`, [items.T3.id]);
  ok(num(rd.open_total) === 3 && num(rd.predecessor_open) === 1 && rd.readiness_live === 'at_risk', 'v_lookahead_readiness counts by type');

  await setToday('2026-11-01');
  ok((await one(`select app.la_readiness_of($1) r`, [items.T3.id])).r === 'not_ready', 'after its due date passes the item becomes not ready');
  await setToday('2026-10-26');

  // manual constraints
  const MC = uuid();
  await as(U.site_engineer, () => rpc('update_constraint', { op_id: uuid(), id: MC, item_id: items.T8.id, ctype: 'equipment',
    description: 'Tower crane slot for lift rails', owner_id: U.site_engineer, due_date: '2026-11-06' }));
  ok((await one(`select readiness from lookahead_items where id = $1`, [items.T8.id])).readiness === 'at_risk', 'manual equipment constraint → lift at risk');
  await as(U.site_engineer, () => rpc('update_constraint', { op_id: uuid(), id: MC, status: 'cleared', comment: 'Crane booked Tue' }));
  ok((await one(`select readiness from lookahead_items where id = $1`, [items.T8.id])).readiness === 'ready', 'cleared → ready again');
  ok((await one(`select count(*)::int n from constraint_events where constraint_id = $1`, [MC])).n === 2, 'constraint log has create + clear');
  await expectError(as(U.site_engineer, () => rpc('update_constraint', { id: hcbC.id, status: 'cleared' })),
    /needs a comment/, 'clearing a material auto constraint by hand needs a comment');
  await expectError(as(U.site_engineer, () => rpc('update_constraint', { id: hcbC.id, status: 'waived' })),
    /reason is required/, 'waiving needs a reason');
  const info = c3.find((c) => c.ctype === 'information');
  await as(U.office_engineer, () => rpc('update_constraint', { op_id: uuid(), id: info.id, status: 'cleared', comment: 'Rev C01 IFC issued' }));
  await as(U.office_engineer, () => rpc('refresh_lookahead', { plan_id: PLAN }));
  ok((await one(`select status, cleared_by from lookahead_constraints where id = $1`, [info.id])).status === 'cleared',
    'manually cleared auto constraint stays cleared on refresh');

  // ---- PR / SUR drafts -----------------------------------------------------
  console.log('\nPurchase & site-use requests from the look-ahead');
  await as(U.office_engineer, () => rpc('assign_lookahead_item', { op_id: uuid(), item_ids: [items.T1.id, items.T2.id, items.T3.id, items.T8.id],
    responsible_id: U.site_engineer }));
  ok((await one(`select owner_id from lookahead_constraints where id = $1`, [pred.id])).owner_id === U.site_engineer,
    'assigning the predecessor task makes its site engineer the owner of the predecessor constraint');
  const inbox = await as(U.site_engineer, () => all(`select * from v_my_approvals where kind = 'lookahead_constraint'`));
  ok(inbox.some((x) => x.entity_id === pred.id), 'constraint shows in the owner\'s inbox (v_my_approvals)');

  await expectError(as(U.site_engineer, () => rpc('create_prs_from_lookahead', { plan_id: PLAN })), /not allowed/, 'site engineer cannot raise PRs');
  const pr = await as(U.office_engineer, () => rpc('create_prs_from_lookahead', { op_id: uuid(), plan_id: PLAN }));
  const prRow = await one(`select * from material_requests where id = $1`, [pr.id]);
  const prLines = await all(`select material_spec_id, qty, lookahead_item_id, required_date from mr_lines where mr_id = $1 and deleted_at is null`, [pr.id]);
  const q = (sp) => num(prLines.find((l) => l.material_spec_id === sp)?.qty);
  ok(prRow.status === 'draft' && prRow.is_lookahead && prRow.lookahead_plan_id === PLAN && pr.number === 'BOLE-PR-LA2611-0001'
    && (prRow.request_type === undefined || prRow.request_type === 'purchase'),
    `draft purchase request ${pr.number} (request_type ${prRow.request_type ?? 'n/a'}) linked to the plan`);
  ok(prLines.length === 4 && q(R500) === 2060 && q(CONC) === 31 && q(CEM) === 25 && q(MEM) === 158 && !prLines.some((l) => l.material_spec_id === HCB),
    `PR lines rounded to pack size: ${prLines.map((l) => num(l.qty)).join(', ')} (HCB covered by the late PO)`);
  ok(prLines.find((l) => l.material_spec_id === R500).lookahead_item_id === items.T3.id, 'mr_lines.lookahead_item_id set');
  const n3b = await need('T3', R500);
  ok(num(n3b.to_order) === 0 && !n3b.raise_pr_now && num(n3b.from_pending_pr) === 2060 && n3b.mr_numbers.includes(pr.number),
    'after the PR the need shows as pending PR, no longer "raise now"');
  const m3 = (await cons('T3')).find((c) => c.ctype === 'material');
  ok(m3.status === 'in_progress' && m3.linked_mr_id === pr.id, 'material constraint in progress, linked to the PR');
  ok((await one(`select count(*)::int n from constraint_events where constraint_id = $1 and action = 'pr_raised'`, [m3.id])).n === 1, 'pr_raised logged');

  const sur = await as(U.site_engineer, () => rpc('create_sur_from_lookahead', { op_id: uuid(), item_id: items.T2.id }));
  const surLines = await all(`select l.id, l.qty, l.material_spec_id, l.lookahead_item_id, (select sum(qty) from mr_line_elements e where e.mr_line_id = l.id and e.deleted_at is null) split
    from mr_lines l where l.mr_id = $1`, [sur.id]);
  const surRow = await one(`select * from material_requests where id = $1`, [sur.id]);
  ok(sur.number === 'BOLE-SR-LA2611-0001' && surRow.status === 'draft' && (surRow.request_type ?? 'site_use') === 'site_use'
    && surLines.length === 1 && num(surLines[0].qty) === 144 && num(surLines[0].split) === 144 && surLines[0].lookahead_item_id === items.T2.id,
    'draft site-use request for the columns: 144 kg rebar from stock, split to C12');
  await expectError(as(U.site_engineer, () => rpc('create_sur_from_lookahead', { item_id: items.T4.id })),
    /Nothing in stock/, 'no site-use request when nothing is in stock');

  // ---- publish & commitments -----------------------------------------------
  console.log('\nPublish & weekly commitments');
  const W = Object.fromEntries((await all(`select week_no, id from lookahead_weeks where plan_id = $1`, [PLAN])).map((w) => [w.week_no, w.id]));
  await expectError(as(U.site_engineer, () => rpc('commit_lookahead_item', { item_id: items.T1.id, week_id: W[2] })),
    /once the look-ahead is published/, 'cannot commit before publishing');
  const pub = await as(U.office_engineer, () => rpc('publish_lookahead', { op_id: uuid(), plan_id: PLAN }));
  ok(pub.status === 'published', 'office engineer publishes the plan');
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and entity_type = 'lookahead_plan'`, [U.site_engineer])).n === 1
    && (await one(`select count(*)::int n from notifications where user_id = $1 and entity_type = 'lookahead_plan'`, [U.office_engineer])).n === 0
    && (await one(`select count(*)::int n from notifications where user_id = $1 and entity_type = 'lookahead_plan'`, [U.procurement])).n === 0,
    'assigned site engineer notified; nothing left to order now (PR drafted), so no procurement alert');

  const CM = {};
  for (const t of ['T1', 'T2', 'T8']) {
    CM[t] = uuid();
    const r = await as(U.site_engineer, () => rpc('commit_lookahead_item', { op_id: uuid(), id: CM[t], item_id: items[t].id, week_id: W[2],
      description: `Week 2: ${items[t].name}`, target_pct: 100 }));
    ok(r.readiness_at_commit === 'ready', `committed ready task ${items[t].name}`);
  }
  await expectError(as(U.site_engineer, () => rpc('commit_lookahead_item', { item_id: items.T3.id, week_id: W[2], description: 'Beams' })),
    /not ready/, 'committing an at-risk task without a reason fails');
  CM.T3 = uuid();
  const ovr = await as(U.site_engineer, () => rpc('commit_lookahead_item', { op_id: uuid(), id: CM.T3, item_id: items.T3.id, week_id: W[2],
    description: 'Beams B1–B12 formwork', override_reason: 'Rebar promised by supplier for 6 Nov', target_pct: 60 }));
  ok(ovr.readiness_at_commit === 'at_risk', 'override with reason → at-risk commitment');
  await expectError(as(U.store_keeper, () => rpc('commit_lookahead_item', { item_id: items.T9.id, week_id: W[2] })), /not allowed/,
    'store keeper cannot commit');
  await expectError(as(U.manager, () => rpc('commit_lookahead_item', { item_id: items.T9.id, week_id: W[1] })), /not allowed/,
    'manager views but does not commit');

  // regenerate after a schedule update: keeps commitments, drops removed tasks
  await db.query(`update schedule_tasks set deleted_at = now() where id = $1`, [T.T6]);
  await db.query(`update schedule_tasks set forecast_start = '2026-11-24', forecast_finish = '2026-12-07' where id = $1`, [T.T5]);
  const regen = await as(U.coordinator, () => rpc('generate_lookahead', { op_id: uuid(), plan_id: PLAN }));
  ok(regen.plan_id === PLAN && regen.new === 0 && regen.dropped === 1 && regen.status === 'published', `regenerated: 0 new, ${regen.dropped} dropped`);
  ok((await one(`select status from lookahead_items where id = $1`, [items.T6.id])).status === 'dropped', 'removed roof task dropped (row kept)');
  ok((await one(`select count(*)::int n from weekly_commitments where plan_id = $1`, [PLAN])).n === 4, 'all 4 commitments kept');
  ok(iso((await one(`select planned_start from lookahead_items where id = $1`, [items.T5.id])).planned_start) === '2026-11-24',
    'forecast dates win over planned dates');
  ok(/Regenerated/.test((await one(`select notes from lookahead_plans where id = $1`, [PLAN])).notes), 're-baseline note added to the published plan');
  await as(U.site_engineer, () => rpc('refresh_lookahead', { op_id: uuid(), plan_id: PLAN }));
  ok((await one(`select count(*)::int n from weekly_commitments where plan_id = $1`, [PLAN])).n === 4, 'refresh keeps commitments');

  // hold point passes during the week → auto-cleared on time
  await setToday('2026-11-10');
  await db.query(`update element_activities set verified_pct = 100 where element_id = $1 and is_hold_point`, [S1]);
  await as(U.site_engineer, () => rpc('refresh_lookahead', { plan_id: PLAN }));
  const insp2 = await one(`select status, cleared_on, cleared_by from lookahead_constraints where id = $1`, [insp.id]);
  ok(insp2.status === 'cleared' && insp2.cleared_by === null && iso(insp2.cleared_on) === '2026-11-10', 'hold point passed → inspection constraint auto-cleared');
  ok((await one(`select count(*)::int n from constraint_events where constraint_id = $1 and action = 'auto_cleared'`, [insp.id])).n === 1, 'auto_cleared logged');

  // ---- report & close week ---------------------------------------------------
  console.log('\nClose week · PPC · RNC · roll-forward');
  await setToday('2026-11-12');
  await as(U.site_engineer, () => rpc('report_commitment', { op_id: uuid(), commitment_id: CM.T1, outcome: 'completed', actual_pct: 100 }));
  await expectError(as(U.coordinator, () => rpc('close_week', { week_id: W[2], results: [] })), /can be closed from/, 'week cannot be closed before its last day');
  await setToday('2026-11-14');
  const coordInbox = await as(U.coordinator, () => all(`select * from v_my_approvals where kind = 'lookahead_week_close'`));
  ok(coordInbox.some((x) => x.entity_id === W[2]), 'week to close shows in the coordinator inbox');
  await expectError(as(U.site_engineer, () => rpc('close_week', { week_id: W[2], results: [] })), /not allowed/, 'site engineer cannot close the week');
  await expectError(as(U.coordinator, () => rpc('close_week', { week_id: W[2], results: [
    { commitment_id: CM.T2, outcome: 'completed' }, { commitment_id: CM.T8, outcome: 'completed' }] })),
    /still need an outcome/, 'all commitments need an outcome');
  await expectError(as(U.coordinator, () => rpc('close_week', { week_id: W[2], results: [
    { commitment_id: CM.T2, outcome: 'completed' }, { commitment_id: CM.T8, outcome: 'completed' },
    { commitment_id: CM.T3, outcome: 'not_completed' }] })), /choose a reason/, 'not completed needs a reason (RNC)');
  const closed = await as(U.coordinator, () => rpc('close_week', { op_id: uuid(), week_id: W[2], results: [
    { commitment_id: CM.T2, outcome: 'completed', actual_pct: 100 }, { commitment_id: CM.T8, outcome: 'completed', actual_pct: 30 },
    { commitment_id: CM.T3, outcome: 'not_completed', actual_pct: 20, rnc_code: 'materials', rnc_note: 'S-500 rebar not delivered' }] }));
  ok(closed.committed === 4 && closed.completed === 3 && num(closed.ppc) === 75, `PPC = 3/4 = ${closed.ppc} %`);
  ok(num(closed.pcr) === 50, `PCR week 2 = ${closed.pcr} % (hold point cleared on time, concrete still open)`);
  ok(closed.rolled === 1 && closed.ta !== undefined, `1 commitment rolled forward (TA ${closed.ta})`);
  const rolled = await one(`select c.*, w.week_no from weekly_commitments c join lookahead_weeks w on w.id = c.week_id where c.rolled_from_id = $1`, [CM.T3]);
  ok(rolled && rolled.kind === 'candidate' && rolled.week_no === 3 && rolled.outcome === 'pending'
    && (await one(`select rolled_to_id from weekly_commitments where id = $1`, [CM.T3])).rolled_to_id === rolled.id,
    'not-completed beams rolled into week 3 as a candidate, linked both ways');
  const ppcRow = await as(U.manager, () => one(`select * from v_ppc where week_id = $1`, [W[2]]));
  ok(num(ppcRow.ppc) === 75 && num(ppcRow.ppc_rolling_4w) === 75 && ppcRow.status === 'closed' && num(ppcRow.overrides) === 1,
    'manager reads v_ppc (75 %, rolling 75 %, 1 override)');
  const par = await as(U.manager, () => all(`select * from v_rnc_pareto where project_id = $1`, [P]));
  ok(par.length === 1 && par[0].rnc_code === 'materials' && num(par[0].total) === 1 && num(par[0].cumulative_pct) === 100, 'RNC Pareto: materials 100 %');
  ok((await one(`select count(*)::int n from rnc_reasons where is_lci`)).n === 12, 'rnc_reasons seeded with the LCI 12');
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and entity_type = 'lookahead_week'`, [U.manager])).n === 1,
    'manager notified with the PPC summary');
  const pcrView = await as(U.coordinator, () => all(`select * from v_constraint_removal where plan_id = $1`, [PLAN]));
  ok(pcrView.length > 0 && pcrView.some((r) => r.ctype === 'inspection' && num(r.cleared_on_time) === 1), 'v_constraint_removal by owner/type');
  await expectError(as(U.site_engineer, () => rpc('report_commitment', { commitment_id: CM.T1, outcome: 'completed' })), /closed/,
    'closed week cannot be re-reported');
  // candidate must be re-committed by the site engineer (coordinator may on day 1)
  await setToday('2026-11-16');
  const conf = await as(U.coordinator, () => rpc('commit_lookahead_item', { op_id: uuid(), id: rolled.id, item_id: items.T3.id,
    override_reason: 'Rebar delivery confirmed for Mon' }));
  ok(conf.ok && (await one(`select kind from weekly_commitments where id = $1`, [rolled.id])).kind === 'commitment', 'coordinator confirms the rolled candidate on day 1');

  // predecessor completes → constraint auto-cleared, task leaves the active list
  await db.query(`update schedule_tasks set pct_complete = 100, actual_finish = '2026-11-12' where id = $1`, [T.T2]);
  await as(U.office_engineer, () => rpc('refresh_lookahead', { plan_id: PLAN }));
  ok((await one(`select status from lookahead_constraints where id = $1`, [pred.id])).status === 'cleared', 'predecessor complete → constraint auto-cleared');
  ok((await one(`select status from lookahead_items where id = $1`, [items.T2.id])).status === 'done', 'finished task marked done');

  // ---- RLS ------------------------------------------------------------------
  console.log('\nAccess');
  ok((await as(outsider, () => all(`select * from lookahead_plans`))).length === 0, 'non-member sees no look-ahead');
  ok((await as(U.store_keeper, () => all(`select * from v_lookahead_material_summary where plan_id = $1`, [PLAN]))).length > 0,
    'store keeper sees the material needs');
  await expectError(as(U.site_engineer, () => db.query(`insert into lookahead_plans (project_id, period_year, period_month, period_label, period_start, period_end, horizon_end)
    values ($1, 2027, 2, 'x', '2027-02-01', '2027-02-28', '2027-03-14')`, [P])), /row-level security/, 'tables are written through RPCs only');

  // ---- holidays & Ethiopian month -------------------------------------------
  console.log('\nHolidays, Ethiopian month, Kiremt, cron');
  await setToday('2026-12-20');
  const jan = await as(U.coordinator, () => rpc('generate_lookahead', { op_id: uuid(), project_id: P, calendar_mode: 'gregorian', year: 2027, month: 1 }));
  const janPlan = await one(`select * from lookahead_plans where id = $1`, [jan.plan_id]);
  const janWeeks = (await all(`select working_days from lookahead_weeks where plan_id = $1 order by week_no`, [jan.plan_id])).map((w) => num(w.working_days));
  ok(num(janPlan.working_days) === 24 && JSON.stringify(janWeeks) === JSON.stringify([2, 5, 6, 5, 6, 6, 6]),
    `Jan 2027: 26 Mon–Sat days − Genna − Timket = ${janPlan.working_days}; weeks ${JSON.stringify(janWeeks)}`);
  const plast = await one(`select week_days from lookahead_items where plan_id = $1 and schedule_task_id = $2`, [jan.plan_id, T.T12]);
  ok(JSON.stringify(plast.week_days) === JSON.stringify({ '2027-01-04': 5, '2027-01-11': 6, '2027-01-18': 5 }), `plastering days per week ${JSON.stringify(plast.week_days)}`);

  await setToday('2027-06-20');
  const eth = await as(U.coordinator, () => rpc('generate_lookahead', { op_id: uuid(), project_id: P, calendar_mode: 'ethiopian', year: 2019, month: 11 }));
  const ethPlan = await one(`select p.*, app.from_ethiopian(2019, 11, 1) s, app.from_ethiopian(2019, 11, 30) e from lookahead_plans p where id = $1`, [eth.plan_id]);
  ok(ethPlan.period_label === 'Hamle 2019' && ethPlan.period_label_am === 'ሐምሌ 2019' && iso(ethPlan.period_start) === iso(ethPlan.s)
    && iso(ethPlan.period_end) === iso(ethPlan.e), `Ethiopian month Hamle 2019 = ${iso(ethPlan.period_start)} – ${iso(ethPlan.period_end)}`);
  const kiremt = await one(`select c.* from lookahead_constraints c join lookahead_items i on i.id = c.item_id
    where i.plan_id = $1 and i.schedule_task_id = $2 and c.ctype = 'external'`, [eth.plan_id, T.T11]);
  ok(kiremt && kiremt.advisory && kiremt.auto && /Kiremt/.test(kiremt.description), 'footing concrete in July → Kiremt weather advisory');
  const mes = await as(U.site_engineer, () => rpc('get_lookahead_preview', { project_id: P, calendar_mode: 'ethiopian', year: 2020, month: 1 }));
  const pag = await one(`select app.from_ethiopian(2019, 13, 1) s, app.from_ethiopian(2020, 1, 30) e`);
  ok(iso(mes.period_start) === iso(pag.s) && iso(mes.period_end) === iso(pag.e), `Meskerem 2020 includes Pagume 2019 (${iso(mes.period_start)} – ${iso(mes.period_end)})`);
  await expectError(as(U.site_engineer, () => rpc('get_lookahead_preview', { project_id: P, calendar_mode: 'ethiopian', year: 2019, month: 13 })),
    /Pagume is planned together with Meskerem/, 'Pagume cannot be planned on its own');

  await setToday('2026-11-25');
  const cronGen = await one(`select app.cron_generate_lookaheads() r`);
  const dec = await one(`select status, period_label from lookahead_plans where project_id = $1 and calendar_mode = 'gregorian' and period_start = '2026-12-01'`, [P]);
  ok(cronGen.r.generated === 1 && dec?.status === 'draft', `25th-of-month job generated ${dec?.period_label} as draft`);
  const cronRef = await one(`select app.cron_refresh_lookaheads() r`);
  ok(cronRef.r.ok && cronRef.r.errors.length === 0 && cronRef.r.refreshed >= 2, `nightly refresh ran for ${cronRef.r.refreshed} plans`);
  ok((await one(`select status from lookahead_weeks where id = $1`, [W[3]])).status === 'committed', 'started weeks are locked (committed)');
  const cronRem = await one(`select app.cron_lookahead_reminders() r`);
  ok(cronRem.r.ok, `Friday reminders sent (${cronRem.r.notifications})`);
  await expectError(as(U.coordinator, () => db.query(`select app.cron_refresh_lookaheads()`)), /permission denied/, 'cron functions are not callable by users');

  console.log(`\n${passed} passed, ${failed} failed (${realSchedule ? 'real schedule migration' : 'schedule stub'})`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
