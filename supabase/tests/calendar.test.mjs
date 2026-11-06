// Project calendar test (migration 20261105000010_project_calendar.sql): Ethiopian holiday generator, work / no-work
// decisions per project (propose → manager decides), inbox and reminders, day edits (rain day, overtime, half day),
// role split, holiday moves, and the schedule re-dating through the CPM.
//
//   node supabase/tests/calendar.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const STUBS = readFileSync(join(root, 'tests', 'client-billing.test.mjs'), 'utf8').match(/const STUBS = `([\s\S]*?)`;/)[1];
const GRANTS = `
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant execute on all functions in schema auth to authenticated, service_role;
`;
const TODAY = '2026-12-15';

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ✓', msg); } else { failed++; console.log('  ✗', msg); } };
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
const d = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

async function main() {
  console.log('Applying migrations…');
  await db.exec(STUBS);
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    try { await db.exec(readFileSync(join(root, 'migrations', f), 'utf8')); }
    catch (e) { throw new Error(`${f}: ${e.message}`); }
  }
  await db.exec(readFileSync(join(root, 'migrations', '20261105000010_project_calendar.sql'), 'utf8'));
  console.log('  calendar migration runs twice without errors');
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);
  // Freeze "today" so the 30-day window is deterministic.
  await db.exec(`create or replace function app.eat_date(p_ts timestamptz) returns date language sql stable as $$ select '${TODAY}'::date $$`);

  console.log('\nHoliday generator');
  const hol = async (name, from, to) => (await all(`select on_date, is_tentative from public_holidays where name like $1 and on_date between $2 and $3 and deleted_at is null order by on_date`, [name, from, to]));
  const yrs = await all(`select extract(year from on_date)::int y, count(*)::int n from public_holidays where country = 'ET' and deleted_at is null group by 1 order by 1`);
  ok(yrs.length >= 10 && yrs.filter((r) => r.y >= 2026 && r.y <= 2035).every((r) => r.n >= 12 && r.n <= 13), `12–13 current public holidays every year 2026–2035 (${yrs.map((r) => `${r.y}:${r.n}`).join(' ')})`);
  ok(d((await hol('Fasika%', '2028-01-01', '2028-12-31'))[0].on_date) === '2028-04-16' && d((await hol('Fasika%', '2030-01-01', '2030-12-31'))[0].on_date) === '2030-04-28',
    'Fasika from the Orthodox computus (16 Apr 2028, 28 Apr 2030)');
  ok(d((await hol('Siklet%', '2029-01-01', '2029-12-31'))[0].on_date) === '2029-04-06', 'Siklet = Fasika − 2 (6 Apr 2029)');
  ok(d((await hol('Genna%', '2028-01-01', '2028-12-31'))[0].on_date) === '2028-01-07', 'Genna stays 7 Jan after a Pagume-6 year (Tahsas 28)');
  ok(d((await hol('Timket%', '2028-01-01', '2028-12-31'))[0].on_date) === '2028-01-20', 'Timket = Tir 11 → 20 Jan in 2028');
  ok(d((await hol('Enkutatash%', '2027-01-01', '2027-12-31'))[0].on_date) === '2027-09-12' && d((await hol('Enkutatash%', '2028-01-01', '2028-12-31'))[0].on_date) === '2028-09-11',
    'Enkutatash 12 Sep 2027 (after a Pagume-6 year), 11 Sep 2028');
  ok(d((await hol('Meskel', '2027-01-01', '2027-12-31'))[0].on_date) === '2027-09-28', 'Meskel = Meskerem 17 → 28 Sep 2027');
  ok(d((await one(`select app.orthodox_easter(2100) d`)).d) === '2100-05-02', 'Julian computus uses the 14-day Gregorian offset from 2100');
  ok((await hol('Downfall of the Derg', '2026-01-01', '2035-12-31')).length === 0, 'Derg Downfall is not a non-working holiday under Proclamation 1334/2024');
  const fitr26 = await hol('Eid al-Fitr', '2026-01-01', '2026-12-31');
  ok(fitr26.length === 1 && d(fitr26[0].on_date) === '2026-03-20', 'generated Eid al-Fitr 2026 matches the seeded date, no duplicate');
  ok((await hol('Eid al-Adha%', '2031-01-01', '2031-12-31')).every((r) => r.is_tentative), 'lunar holidays generated as tentative');
  const dup = await one(`select count(*)::int n from public_holidays a join public_holidays b on a.name = b.name and a.id < b.id and abs(a.on_date - b.on_date) <= 5 where a.deleted_at is null and b.deleted_at is null`);
  ok(dup.n === 0, 'no holiday twice within 5 days');

  // ---------------------------------------------------------------------------
  const U = {};
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role }, { role }]);
  }
  const P = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'CAL', 'Calendar test')`, [P]);
    for (const r of Object.keys(U).filter((r) => r !== 'admin')) await db.query(`insert into project_members values ($1, $2)`, [P, U[r]]);
  });

  console.log('\nSchedule across Genna (Thu 7 Jan 2027)');
  const T = (uid, name, s, f, dur) => ({ uid, guid: `G-${uid}`, id: uid, name, wbs: String(uid), outline_number: String(uid), outline_level: 1,
    is_summary: false, is_milestone: false, start: s, finish: f, duration_days: dur });
  const SCH = uuid();
  await as(U.coordinator, () => rpc('import_schedule', { op_id: uuid(), project_id: P, schedule_id: SCH, schedule: {
    source: 'mspdi', file_name: 'cal.xml', file_sha256: 'cal-1',
    header: { name: 'Cal', start_date: '2027-01-05', minutes_per_day: 480, minutes_per_week: 2880, days_per_month: 26, currency_code: 'ETB', baseline_for_ev: 0 },
    calendars: [], project_calendar_uid: null, warnings: [], custom_fields: [],
    tasks: [T(1, 'Blockwork level 3', '2027-01-05', '2027-01-09', 4), T(2, 'Plastering level 3', '2027-01-11', '2027-01-12', 2)],
    links: [{ pred_uid: 1, succ_uid: 2, type: 'FS', lag_days: 0 }] } }));
  const task = async (uid) => one(`select planned_start, planned_finish from schedule_tasks where schedule_id = $1 and msp_uid = $2`, [SCH, uid]);
  ok(d((await task(1)).planned_finish) === '2027-01-09', 'blockwork 5→9 Jan skips Genna (holiday = no work by default)');
  ok((await one(`select app.is_working_day($1, '2027-01-07') w`, [P])).w === false, 'Genna is a non-working day until decided');

  console.log('\nDecisions and reminders');
  const sync = await as(U.site_engineer, () => rpc('calendar_sync', { project_id: P }));
  const genna = await one(`select hd.* from holiday_decisions hd join public_holidays h on h.id = hd.holiday_id where hd.project_id = $1 and h.name like 'Genna%' and hd.on_date = '2027-01-07'`, [P]);
  ok(genna && genna.status === 'pending', 'Genna 2027 has a pending decision for the project');
  ok(sync.notified >= 1 && (await one(`select count(*)::int n from notifications where entity_id = $1`, [genna.id])).n === 3,
    'manager, coordinator and office engineer reminded 30 days ahead');
  await as(U.site_engineer, () => rpc('calendar_sync', { project_id: P }));
  ok((await one(`select count(*)::int n from notifications where entity_id = $1`, [genna.id])).n === 3, 'reminder sent once');
  ok(!(await one(`select 1 x from holiday_decisions hd join public_holidays h on h.id = hd.holiday_id where hd.project_id = $1 and h.name like 'Fasika%'`, [P])),
    'Fasika (always a Sunday) needs no decision on a Mon–Sat calendar');
  ok((await one(`select count(*)::int n from holiday_decisions where project_id = $1 and on_date = '2027-01-19'`, [P])).n === 1, 'Timket decision exists too (35 days ahead)');

  const inbox = async (u) => as(u, () => all(`select * from v_my_approvals where kind = 'holiday' and project_id = $1`, [P]));
  const mi = await inbox(U.manager);
  ok(mi.length === 1 && mi[0].entity_id === genna.id && /Decide: work on Genna/.test(mi[0].title), `manager inbox: "${mi[0]?.title}" (Timket is beyond 30 days)`);
  ok((await inbox(U.coordinator)).length === 1, 'coordinator inbox asks for a proposal');
  ok((await inbox(U.site_engineer)).length === 0 && (await inbox(U.store_keeper)).length === 0, 'site engineer / store keeper inbox: none');

  await expectError(as(U.store_keeper, () => rpc('propose_holiday_decision', { op_id: uuid(), decision_id: genna.id, choice: 'work' })), /not allowed/, 'store keeper cannot propose');
  await as(U.site_engineer, () => rpc('propose_holiday_decision', { op_id: uuid(), decision_id: genna.id, choice: 'work', note: 'Slab pour cannot wait' }));
  ok((await one(`select status, proposed_choice from holiday_decisions where id = $1`, [genna.id])).status === 'proposed', 'site engineer proposed to work');
  ok((await inbox(U.coordinator)).length === 0 && /proposed: work/.test((await inbox(U.manager))[0].title), 'proposal moves it to the manager only');
  await expectError(as(U.coordinator, () => rpc('decide_holiday', { op_id: uuid(), decision_id: genna.id, choice: 'work' })), /Only the project manager/, 'coordinator cannot decide');

  const r1 = await as(U.manager, () => rpc('decide_holiday', { op_id: uuid(), decision_id: genna.id, choice: 'work', note: 'Pour day, 2.5× pay agreed' }));
  ok((await one(`select app.is_working_day($1, '2027-01-07') w`, [P])).w === true, 'decided "work" → Genna is a working day');
  ok(d((await task(1)).planned_finish) === '2027-01-08' && d((await task(2)).planned_start) === '2027-01-09', `schedule re-dated: blockwork ends 8 Jan, plastering starts 9 Jan (${r1.moved} moved)`);
  ok((await inbox(U.manager)).length === 0, 'decided holiday leaves the inbox');
  ok((await one(`select count(*)::int n from notifications where entity_id = $1 and user_id = $2`, [genna.id, U.site_engineer])).n === 1, 'proposer told the decision');
  const ex = await one(`select * from calendar_exceptions where project_id = $1 and on_date = '2027-01-07' and deleted_at is null`, [P]);
  ok(ex.is_working && ex.category === 'holiday_work' && ex.holiday_decision_id === genna.id, 'decision stored as a calendar exception');

  await as(U.manager, () => rpc('decide_holiday', { op_id: uuid(), decision_id: genna.id, choice: 'half_day' }));
  ok(Number((await one(`select app.day_capacity($1, '2027-01-07') c`, [P])).c) === 0.5, 'half day → capacity 0.5');
  await as(U.manager, () => rpc('decide_holiday', { op_id: uuid(), decision_id: genna.id, action: 'reopen' }));
  ok((await one(`select app.is_working_day($1, '2027-01-07') w`, [P])).w === false && (await one(`select status from holiday_decisions where id = $1`, [genna.id])).status === 'proposed',
    'reopened → back to no work, the proposal stays');
  ok(d((await task(1)).planned_finish) === '2027-01-09', 'schedule moves back');

  console.log('\nDay edits');
  await expectError(as(U.site_engineer, () => rpc('edit_calendar_days', { op_id: uuid(), project_id: P, dates: ['2027-01-12'], kind: 'non_working', category: 'rain' })),
    /not allowed/, 'site engineer cannot edit days');
  const r2 = await as(U.coordinator, () => rpc('edit_calendar_days', { op_id: uuid(), project_id: P, dates: ['2027-01-12'], kind: 'non_working', category: 'rain', note: 'Heavy rain' }));
  ok((await one(`select app.is_working_day($1, '2027-01-12') w`, [P])).w === false && d((await task(2)).planned_finish) === '2027-01-13', `rain day on 12 Jan pushes plastering to 13 Jan (${r2.moved} moved)`);
  ok((await one(`select name, category from calendar_exceptions where project_id = $1 and on_date = '2027-01-12'`, [P])).name === 'Rain day', 'default name "Rain day"');
  await as(U.office_engineer, () => rpc('edit_calendar_days', { op_id: uuid(), project_id: P, dates: ['2027-01-10'], kind: 'working', name: 'Sunday overtime' }));
  ok((await one(`select app.is_working_day($1, '2027-01-10') w`, [P])).w === true, 'office engineer adds a Sunday overtime day');
  await as(U.office_engineer, () => rpc('edit_calendar_days', { op_id: uuid(), project_id: P, dates: ['2027-01-10', '2027-01-12'], kind: 'normal' }));
  ok((await one(`select app.is_working_day($1, '2027-01-10') a, app.is_working_day($1, '2027-01-12') b`, [P])).a === false, 'normal = back to the week pattern');
  await expectError(as(U.coordinator, () => rpc('edit_calendar_days', { op_id: uuid(), project_id: P, dates: ['2027-01-07'], kind: 'working' })),
    /public holiday/, 'coordinator cannot make a public holiday a working day');
  await as(U.manager, () => rpc('edit_calendar_days', { op_id: uuid(), project_id: P, dates: ['2027-01-07'], kind: 'non_working', note: 'Rest' }));
  ok((await one(`select status, decision from holiday_decisions where id = $1`, [genna.id])).decision === 'no_work', 'manager editing a holiday day records the decision');
  await expectError(as(U.coordinator, () => db.query(`insert into calendar_exceptions (calendar_id, project_id, on_date, is_working) values (app.project_calendar($1), $1, '2027-02-01', true)`, [P])),
    /row-level security|permission/, 'no direct writes around the rules');

  console.log('\nWorking week');
  const labour = async () => one(`select count(*)::int n from holiday_decisions where project_id = $1 and on_date = '2027-05-01'`, [P]);
  ok((await labour()).n === 1, 'Labour Day 2027 (a Saturday) needs a decision on Mon–Sat');
  await expectError(as(U.office_engineer, () => rpc('save_project_calendar', { op_id: uuid(), project_id: P, working_weekdays: [1, 2, 3, 4, 5] })), /not allowed/, 'office engineer cannot change the working week');
  await as(U.coordinator, () => rpc('save_project_calendar', { op_id: uuid(), project_id: P, working_weekdays: [1, 2, 3, 4, 5] }));
  ok((await labour()).n === 0 && d((await task(1)).planned_finish) === '2027-01-11', 'Mon–Fri: Saturday holiday needs no decision; blockwork re-planned to 11 Jan');
  await as(U.coordinator, () => rpc('save_project_calendar', { op_id: uuid(), project_id: P, working_weekdays: [1, 2, 3, 4, 5, 6] }));
  ok((await labour()).n === 1, 'back to Mon–Sat');
  const P2 = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'CAL2', 'Calendar toggle test')`, [P2]);
    await db.query(`insert into project_members values ($1, $2)`, [P2, U.coordinator]);
  });
  await as(U.coordinator, () => rpc('save_project_calendar', { op_id: uuid(), project_id: P2, use_public_holidays: false }));
  ok((await one(`select app.is_working_day($1, '2027-05-01') w`, [P2])).w === true
    && (await one(`select count(*)::int n from holiday_decisions where project_id = $1`, [P2])).n === 0,
    'disabling public holidays restores the week pattern and clears decisions/exceptions');
  await as(U.coordinator, () => rpc('save_project_calendar', { op_id: uuid(), project_id: P2, use_public_holidays: true }));
  ok((await one(`select app.is_working_day($1, '2027-05-01') w`, [P2])).w === false
    && (await one(`select count(*)::int n from holiday_decisions where project_id = $1 and on_date = '2027-05-01'`, [P2])).n === 1,
    're-enabling public holidays restores no-work defaults and pending decisions');

  console.log('\nNational holiday list');
  const fitr = await one(`select id from public_holidays where name = 'Eid al-Fitr' and on_date = '2027-03-10'`);
  await expectError(as(U.coordinator, () => rpc('save_public_holiday', { op_id: uuid(), id: fitr.id, on_date: '2027-03-09' })), /not allowed/, 'coordinator cannot move national holidays');
  await expectError(as(U.manager, () => rpc('save_public_holiday', { op_id: uuid(), id: fitr.id, on_date: '2027-03-09' })), /not allowed/, 'project manager cannot move the shared national list');
  await expectError(as(U.manager, () => db.query(`insert into public_holidays (on_date, name) values ('2027-06-20', 'Unauthorized holiday')`)),
    /row-level security|permission/, 'manager cannot bypass the admin-only holiday policy');
  const decF = await one(`select id from holiday_decisions where project_id = $1 and holiday_id = $2`, [P, fitr.id]);
  await as(U.manager, () => rpc('decide_holiday', { op_id: uuid(), decision_id: decF.id, choice: 'no_work' }));
  await as(U.admin, () => rpc('save_public_holiday', { op_id: uuid(), id: fitr.id, on_date: '2027-03-09', is_tentative: false }));
  const fh = await one(`select on_date, is_tentative, confirmed_by from public_holidays where id = $1`, [fitr.id]);
  ok(d(fh.on_date) === '2027-03-09' && fh.is_tentative === false && fh.confirmed_by === U.admin, 'admin confirms Eid al-Fitr on 9 Mar 2027');
  ok(d((await one(`select on_date from holiday_decisions where id = $1`, [decF.id])).on_date) === '2027-03-09'
    && (await one(`select count(*)::int n from calendar_exceptions where holiday_decision_id = $1 and deleted_at is null and on_date = '2027-03-09'`, [decF.id])).n === 1,
    'the decision and its calendar day moved with it');
  const g = await as(U.admin, () => rpc('generate_public_holidays', { from_year: 2036, to_year: 2036 }));
  ok(g.added >= 12, `admin generates 2036 (${g.added} added)`);

  console.log('\nCalendar view');
  const v = await as(U.store_keeper, () => rpc('get_project_calendar', { project_id: P, from: '2027-01-01', to: '2027-02-28' }));
  const day = v.days.find((x) => x.date === '2027-01-07');
  ok(v.days.length === 59 && day.holiday?.name_am === 'ገና' && day.eth_m === 4 && day.eth_d === 29 && day.working === false && day.decision_id === genna.id,
    `two months for any member: 7 Jan = Tahsas ${day?.eth_d}, ${day?.holiday?.name_am}, not working`);
  ok(v.decisions.some((x) => x.id === genna.id && x.decision === 'no_work'), 'upcoming decisions listed');
  await expectError(as(U.store_keeper, () => rpc('get_project_calendar', { project_id: P, from: '2027-01-01', to: '2027-12-31' })), /at most 100 days/, 'range limited');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
