// Schedule editing test (migration 20261103000030_schedule_editing.sql). Applies ALL migrations + seed in PGlite.
//
// Scenario: a small schedule is imported, then edited in the app like MS Project: add / rename / duration /
// start constraint, predecessors (FS, SS with % lag), loop rejection, CPM re-plan, summary / indent / outdent /
// move, delete safeguards, undo, edit history; resource sheet, assignments, costs (price roles only), weekly
// usage with over-allocation, baseline costed from resources; re-import (MS Project wins, no undo across it).
//
//   node supabase/tests/schedule-editing.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const MINE = '20261103000030_schedule_editing.sql';
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
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer']) {
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
  const task = async (uid) => one(`select * from schedule_tasks where schedule_id = $1 and msp_uid = $2 and deleted_at is null`, [SCH, uid]);
  const ed = (p, who = U.office_engineer) => as(who, () => rpc('edit_schedule', { op_id: uuid(), schedule_id: SCH, ...p }));
  const d10 = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

  // =====================================================================
  console.log('\nRoles');
  await expectError(ed({ action: 'add_task', name: 'X' }, U.site_engineer), /not allowed/, 'site engineer cannot edit the schedule');

  console.log('\nAdd / rename / duration');
  const t4 = await task(4);
  const r1 = await ed({ action: 'add_task', name: 'Survey & setting out', after_task_id: t4.id, duration_days: 3 });
  ok(r1.ok && r1.task_id, `task added (${r1.summary}) in ${r1.moved ?? 0} moved`);
  const nt = await one(`select * from schedule_tasks where id = $1`, [r1.task_id]);
  ok(nt.msp_uid === 11 && nt.origin === 'app' && nt.parent_id === t4.parent_id && nt.edited_by === U.office_engineer, `new UID 11, same parent as task 4, origin app`);
  ok(nt.sort_order === t4.sort_order + 1 || (await one(`select count(*)::int c from schedule_tasks where schedule_id = $1 and deleted_at is null and sort_order between $2 and $3`, [SCH, t4.sort_order, nt.sort_order])).c === 2,
    'placed right after task 4');
  ok(nt.wbs === '1.2.1.3' && /\.3$/.test(nt.outline_number), `WBS ${nt.wbs} = parent WBS + position (outline ${nt.outline_number})`);
  await ed({ action: 'update_task', task_id: nt.id, name: 'Survey and setting out' });
  ok((await one(`select name from schedule_tasks where id = $1`, [nt.id])).name === 'Survey and setting out', 'renamed');
  await expectError(ed({ action: 'update_task', task_id: nt.id, name: '  ' }), /cannot be empty/, 'empty name refused');
  await expectError(ed({ action: 'update_task', task_id: (await task(1)).id, duration_days: 4 }), /summary/, 'summary duration refused');

  console.log('\nLinks, CPM and loops');
  const rp = await ed({ action: 'set_predecessors', task_id: nt.id, predecessors: [{ pred_uid: 4, link_type: 'FS', lag_days: 0 }] });
  const t4b = await task(4), nt2 = await one(`select * from schedule_tasks where id = $1`, [nt.id]);
  const nextWd = (await one(`select app.la_shift($1, $2::date, 1) d`, [P, d10(t4b.planned_finish)])).d;
  ok(d10(nt2.planned_start) === d10(nextWd), `FS: starts the working day after task 4 finishes (${d10(nt2.planned_finish)})`);
  ok((await one(`select count(*)::int c from schedule_links where succ_task_id = $1 and deleted_at is null and origin = 'app'`, [nt.id])).c === 1, 'link stored as an app link');
  await expectError(ed({ action: 'add_link', pred_task_id: nt.id, succ_task_id: t4.id, link_type: 'FS' }), /loop/, 'a loop is refused');
  ok((await one(`select count(*)::int c from schedule_links where pred_task_id = $1 and succ_task_id = $2 and deleted_at is null`, [nt.id, t4.id])).c === 0, 'and nothing was saved');
  await expectError(ed({ action: 'add_link', pred_task_id: (await task(2)).id, succ_task_id: nt.id }), /summary/, 'links to a summary refused');
  const t7 = await task(7);
  const r2 = await ed({ action: 'add_link', pred_task_id: nt.id, succ_task_id: (await task(9)).id, link_type: 'SS', lag_pct: 50 });
  ok(/SS\+1\.5d/.test(r2.summary), `SS with 50 % lag of a 3-day task = 1.5 d (${r2.summary})`);
  const t3 = await task(3), t7b = await task(7);
  const r3 = await ed({ action: 'update_task', task_id: t3.id, duration_days: 8 });
  const t7c = await task(7);
  ok(Number(r3.moved) >= 3 && (await one(`select app.la_wd($1, $2::date, $3::date) n`, [P, d10(t7b.planned_start), d10(t7c.planned_start)])).n >= 4,
    `longer excavation pushes the successors (${r3.moved} tasks moved; slab ${d10(t7b.planned_start)} → ${d10(t7c.planned_start)})`);
  const sum1 = await task(1);
  ok(d10(sum1.planned_finish) === (await one(`select max(planned_finish)::text f from schedule_tasks where parent_id = $1 and deleted_at is null`, [sum1.id])).f
    || d10(sum1.planned_finish) >= d10(t7c.planned_finish), 'summary dates roll up');
  ok((await one(`select fc_finish is not null f from schedules where id = $1`, [SCH])).f, 'forecast re-run after the edit');
  await ed({ action: 'update_task', task_id: nt.id, start: '2026-10-05' });
  const nt3 = await one(`select * from schedule_tasks where id = $1`, [nt.id]);
  ok(nt3.constraint_type === 4 && d10(nt3.constraint_date) === '2026-10-05' && d10(nt3.planned_start) >= '2026-10-05', 'typing a start sets Start No Earlier Than');
  await ed({ action: 'update_task', task_id: nt.id, constraint_type: 0 });
  ok((await one(`select constraint_type, constraint_date from schedule_tasks where id = $1`, [nt.id])).constraint_date === null, 'back to As Soon As Possible');

  console.log('\nOutline: summary, indent, outdent, move');
  const rs = await ed({ action: 'add_task', name: 'Temporary works', kind: 'summary', after_task_id: (await task(9)).id });
  const rc = await ed({ action: 'add_task', name: 'Hoarding', parent_id: rs.task_id, duration_days: 4 });
  const sm = await one(`select * from schedule_tasks where id = $1`, [rs.task_id]);
  const ch = await one(`select * from schedule_tasks where id = $1`, [rc.task_id]);
  ok(sm.is_summary && ch.parent_id === sm.id && ch.outline_level === sm.outline_level + 1 && d10(sm.planned_start) === d10(ch.planned_start), 'summary with a sub-task, dates rolled up');
  const rc2 = await ed({ action: 'add_task', name: 'Site office', after_task_id: rc.task_id, duration_days: 2 });
  await ed({ action: 'indent', task_id: rc2.task_id });
  const ch2 = await one(`select * from schedule_tasks where id = $1`, [rc2.task_id]);
  const ch1 = await one(`select * from schedule_tasks where id = $1`, [rc.task_id]);
  ok(ch2.parent_id === ch1.id && ch1.is_summary, 'indent makes the task above a summary');
  await ed({ action: 'outdent', task_id: rc2.task_id });
  ok((await one(`select parent_id from schedule_tasks where id = $1`, [rc2.task_id])).parent_id === sm.id
    && !(await one(`select is_summary from schedule_tasks where id = $1`, [rc.task_id])).is_summary, 'outdent restores it; the empty summary becomes a task again');
  await expectError(ed({ action: 'indent', task_id: (await task(4)).id }), /would become a summary, but/, 'cannot indent under a task with logic');
  const before = (await one(`select outline_number from schedule_tasks where id = $1`, [rc2.task_id])).outline_number;
  await ed({ action: 'move', task_id: rc2.task_id, direction: 'up' });
  const after = (await one(`select outline_number from schedule_tasks where id = $1`, [rc2.task_id])).outline_number;
  ok(before !== after && after.endsWith('.1'), `moved up (${before} → ${after})`);
  await expectError(ed({ action: 'move', task_id: rc2.task_id, direction: 'up' }), /cannot move further/, 'top of its group');

  console.log('\nDelete safeguards and undo');
  await expectError(ed({ action: 'delete_task', task_id: (await task(3)).id }), /BoQ|progress/, 'task with BoQ / progress cannot be deleted');
  const nLinks = (await one(`select count(*)::int c from schedule_links where (pred_task_id = $1 or succ_task_id = $1) and deleted_at is null`, [nt.id])).c;
  const rd = await ed({ action: 'delete_task', task_id: nt.id });
  ok(/Deleted/.test(rd.summary) && (await one(`select deleted_at is not null d from schedule_tasks where id = $1`, [nt.id])).d
    && (await one(`select count(*)::int c from schedule_links where (pred_task_id = $1 or succ_task_id = $1) and deleted_at is null`, [nt.id])).c === 0,
    `deleted with its ${nLinks} links`);
  const ru = await as(U.coordinator, () => rpc('undo_schedule_edit', { op_id: uuid(), schedule_id: SCH }));
  ok(/Deleted/.test(ru.undone) && (await one(`select deleted_at is null d from schedule_tasks where id = $1`, [nt.id])).d
    && (await one(`select count(*)::int c from schedule_links where (pred_task_id = $1 or succ_task_id = $1) and deleted_at is null`, [nt.id])).c === nLinks,
    'undo brings the task and its links back');
  const edits = await one(`select count(*)::int n, count(*) filter (where undone_at is not null)::int u, bool_and(created_by is not null) by from schedule_edits where schedule_id = $1`, [SCH]);
  ok(edits.n >= 12 && edits.u === 1 && edits.by, `edit history: ${edits.n} edits, ${edits.u} undone`);

  console.log('\nResources');
  const res = async (p, who = U.coordinator) => (await as(who, () => rpc('save_schedule_resource', { op_id: uuid(), project_id: P, ...p }))).id;
  const MSN = await res({ code: 'MSN', name: 'Mason crew', kind: 'labour', max_units: 6, std_rate: 900, unit: 'man-day' });
  const EXC = await res({ code: 'EXC', name: 'Excavator 20 t', kind: 'equipment', max_units: 1, std_rate: 12000, cost_per_use: 5000 });
  const C25 = await res({ code: 'C25', name: 'Concrete C-25', kind: 'material', unit: 'm3', std_rate: 6500 });
  await expectError(res({ code: 'msn', name: 'Dup', kind: 'labour' }), /already used/, 'resource codes are unique');
  await res({ id: MSN, code: 'MSN', name: 'Mason crew', kind: 'labour', max_units: 6, std_rate: 950 }, U.office_engineer);
  ok(Number((await one(`select std_rate from schedule_resource_rates where resource_id = $1`, [MSN])).std_rate) === 900, 'non-price role cannot change the rate');
  const asg = (taskId, list) => as(U.office_engineer, () => rpc('assign_resources', { op_id: uuid(), task_id: taskId, assignments: list }));
  const t3n = await task(3), t7n = await task(7), t9n = await task(9);
  await asg(t3n.id, [{ resource_id: EXC, units: 1 }, { resource_id: MSN, units: 2 }]);
  await asg(t7n.id, [{ resource_id: EXC, units: 1 }, { resource_id: C25, units: 420 }, { resource_id: MSN, units: 8 }]);
  await asg(t9n.id, [{ resource_id: EXC, units: 1 }]);
  await expectError(asg((await task(1)).id, [{ resource_id: MSN, units: 1 }]), /summary/, 'no resources on summaries');
  await expectError(asg(t3n.id, [{ resource_id: MSN, units: 0 }]), /more than 0/, 'units must be positive');
  const costCo = await as(U.coordinator, () => all(`select code, work, cost from v_task_resource_cost where task_id = $1 order by code`, [t7n.id]));
  const dur7 = Number(t7n.duration_days);
  ok(costCo.length === 3 && Number(costCo.find((c) => c.code === 'C25').cost) === 420 * 6500
    && Number(costCo.find((c) => c.code === 'EXC').cost) === dur7 * 12000 + 5000 && Number(costCo.find((c) => c.code === 'MSN').work) === 8 * dur7,
    `cost = units × days × rate + per use; material = qty × rate (${costCo.map((c) => `${c.code} ${c.cost}`).join(', ')})`);
  const costOe = await as(U.office_engineer, () => all(`select cost from v_task_resource_cost where task_id = $1`, [t7n.id]));
  ok(costOe.length === 3 && costOe.every((c) => c.cost === null), 'office engineer sees the assignments but not their cost');
  await asg(t3n.id, [{ resource_id: EXC, units: 1 }]);
  ok((await one(`select count(*)::int c from task_assignments where task_id = $1 and deleted_at is null`, [t3n.id])).c === 1, 'assignments replaced (mason removed)');
  const use = await as(U.office_engineer, () => rpc('get_resource_usage', { schedule_id: SCH }));
  const exc = use.resources.find((r) => r.code === 'EXC'), msn = use.resources.find((r) => r.code === 'MSN');
  const overW = exc.weeks.filter((w) => w.over);
  ok(overW.length > 0 && overW.every((w) => Number(w.peak) > 1) && overW[0].tasks.length >= 2, `excavator over-allocated in ${overW.length} week(s) (two tasks at once)`);
  ok(overW[0].tasks.some((x) => x.total_float_days !== undefined), 'over-allocated weeks list the tasks with their float (levelling hint)');
  ok(msn.weeks.some((w) => w.over) && Number(msn.weeks.find((w) => w.over).peak) === 8, 'mason crew 8 > 6 flagged');
  ok(!use.resources.find((r) => r.code === 'C25').weeks.some((w) => w.over), 'materials are never over-allocated');

  console.log('\nBaseline costed from resources');
  await expectError(as(U.office_engineer, () => rpc('set_baseline', { op_id: uuid(), schedule_id: SCH, cost_source: 'resources', source: 'current_plan' })), /price roles/, 'non-price role cannot');
  const bl = await as(U.coordinator, () => rpc('set_baseline', { op_id: uuid(), schedule_id: SCH, cost_source: 'resources', source: 'current_plan' }));
  const b7 = await one(`select c.bac_cost, c.bac_value from schedule_baseline_task_costs c where c.baseline_id = $1 and c.task_id = $2`, [bl.id, t7n.id]);
  const exp7 = costCo.reduce((s, c) => s + Number(c.cost), 0);
  ok(bl.cost_source === 'resources' && Math.abs(Number(b7.bac_cost) - exp7) < 0.01, `task BAC cost = its resource cost (${b7.bac_cost})`);
  ok((await one(`select cost_source from schedule_baselines where id = $1`, [bl.id])).cost_source === 'resources', 'baseline records the cost source');
  const bl2 = await as(U.manager, () => rpc('approve_baseline', { op_id: uuid(), baseline_id: bl.id, approve: true }));
  ok(bl2.ok, 'and it can be approved');

  console.log('\nRe-import: MS Project wins');
  await as(U.coordinator, () => rpc('import_schedule', { op_id: uuid(), project_id: P, schedule_id: SCH, schedule: { ...file, file_sha256: 'apt-2' } }));
  ok((await one(`select deleted_at is not null d from schedule_tasks where id = $1`, [nt.id])).d, 'tasks created in the app are dropped when the file does not have them');
  await expectError(as(U.coordinator, () => rpc('undo_schedule_edit', { op_id: uuid(), schedule_id: SCH })), /imported from MS Project/, 'no undo across an import');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
