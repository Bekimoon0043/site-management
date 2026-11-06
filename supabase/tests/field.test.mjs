// Field & quality database test (P1 #6–#9): site diary, inspections/hold
// points, snags, concrete pours (ready-mix tickets + site batching), cubes,
// BBS rebar reconciliation. Applies ONLY migrations 0001–0004 + 0006 + seed in
// PGlite with the same Supabase stubs as run.mjs, then drives the RPCs as real
// roles under RLS.
//
//   node supabase/tests/field.test.mjs

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

const GRANTS = `
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant execute on all functions in schema auth to authenticated;
`;

const MIGRATIONS = /^(2026102900000[1-7]|2026103000000[12])_.*\.sql$/;

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
const num = (v) => Number(v);
const near = (a, b, eps = 0.001) => Math.abs(num(a) - num(b)) < eps;

async function expectError(promise, pattern, msg) {
  try { await promise; ok(false, `${msg} (no error raised)`); }
  catch (e) { ok(pattern.test(e.message), `${msg} → "${e.message}"`); }
}

async function main() {
  console.log('Applying migrations…');
  await db.exec(STUBS);
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => MIGRATIONS.test(f)).sort()) {
    await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
    console.log('  applied', f);
  }
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);

  // ---- users & project ---------------------------------------------------
  const U = {};
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role.replace('_', ' ') }, { role }]);
  }
  const outsider = uuid();
  await db.query(`insert into auth.users (id, email, raw_app_meta_data) values ($1, 'out@test.et', '{"role":"site_engineer"}')`, [outsider]);

  const P = uuid(), B = uuid(), L1 = uuid(), MAIN = uuid(), BATCH = uuid();
  const E = { C1: uuid(), C2: uuid(), C4: uuid(), F1: uuid(), S1: uuid(), W1: uuid() };
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'BOLE', 'Bole Mixed-Use')`, [P]);
    for (const r of ['coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper']) {
      await db.query(`insert into project_members (project_id, user_id) values ($1, $2)`, [P, U[r]]);
    }
    await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'A', 'Block A')`, [B, P]);
    await db.query(`insert into levels (id, project_id, block_id, code, name) values ($1, $2, $3, 'L1', 'Level 1')`, [L1, P, B]);
    await db.query(`insert into stores (id, project_id, name, store_type) values ($1, $3, 'Main store', 'main'), ($2, $3, 'Batching yard', 'batching')`, [MAIN, BATCH, P]);
    for (const [code, type] of [['C1', 'column'], ['C2', 'column'], ['C4', 'column'], ['F1', 'footing'], ['S1', 'slab'], ['W1', 'wall']]) {
      await db.query(`insert into elements (id, project_id, block_id, level_id, code, element_type) values ($1, $2, $3, $4, $5, $6)`,
        [E[code], P, B, L1, code, type]);
    }
  });
  const spec = async (name, grade) => (await one(
    `select s.id from material_specs s join materials m on m.id = s.material_id where m.name = $1 and s.grade = $2`, [name, grade])).id;
  const CONC = await spec('Concrete', 'C-25/30');
  const OPC = await spec('Cement', 'OPC 42.5');
  const R16 = await spec('Rebar', 'S-400 Ø16');
  const R8 = await spec('Rebar', 'S-400 Ø8');
  const today = (await one(`select app.local_date(now())::text d`)).d;
  const acts = async (el) => all(`select id, seq, name, is_hold_point, verified_pct from element_activities where element_id = $1 order by seq`, [el]);
  const tpl = async (code) => one(`select id from checklist_templates where code = $1 and project_id is null`, [code]);
  const tplItems = async (code) => all(`select i.id, i.seq, i.item_type, i.is_critical, i.min_value from checklist_template_items i
    join checklist_templates t on t.id = i.template_id where t.code = $1 and i.deleted_at is null order by i.seq`, [code]);

  ok((await one(`select count(*)::int n from checklist_templates`)).n === 4, 'seeded 4 checklist templates (rebar, formwork, pre-pour slab, blockwork)');
  ok((await one(`select count(*)::int n from labour_trades`)).n >= 10, 'labour trades seeded');

  // =========================================================================
  console.log('\nSite diary');
  const SD = uuid(), lab1 = uuid(), lab2 = uuid();
  const diary = (over = {}) => ({
    op_id: uuid(), id: SD, project_id: P, number: 'BOLE-SD-D001-0001', diary_date: today, block_id: B,
    weather_am: 'sunny', weather_pm: 'rain', rain_hours: 1.5, temp_min: 12, temp_max: 24,
    work_summary: 'Column rebar C1–C4, formwork F1',
    labour: [
      { id: lab1, trade_id: null, trade_name: 'Mason', headcount: 6, hours: 8 },
      { id: lab2, trade_name: 'Bar bender', subcontractor: 'Abebe & Sons', headcount: 4, hours: 8 },
    ],
    equipment: [{ id: uuid(), equipment: 'Concrete mixer 350L', hours_worked: 5, hours_idle: 3, idle_reason: 'Power cut', status: 'idle' }],
    delays: [
      { id: uuid(), cause: 'cement_shortage', hours_lost: 2, element_id: E.F1, description: 'OPC not delivered' },
      { id: uuid(), cause: 'power_cut', hours_lost: 3 },
    ],
    visitors: [{ id: uuid(), name: 'Ato Kebede', organisation: 'Consultant', purpose: 'Rebar check', time_in: '10:00', time_out: '11:30' }],
    instructions: [{ id: uuid(), given_by: 'Ato Kebede', organisation: 'Consultant', instruction: 'Increase cover to 40 mm on C2', element_id: E.C2 }],
    elements: [{ id: uuid(), element_id: E.C1 }, { id: uuid(), element_id: E.F1, note: 'Formwork' }],
    ...over,
  });
  const d1 = await as(U.site_engineer, () => rpc('save_site_diary', diary()));
  ok(d1.ok && d1.status === 'draft', 'diary saved as draft');
  ok((await one(`select count(*)::int n from diary_labour where diary_id = $1 and deleted_at is null`, [SD])).n === 2 &&
     (await one(`select count(*)::int n from diary_delays where diary_id = $1`, [SD])).n === 2 &&
     (await one(`select count(*)::int n from diary_elements where diary_id = $1`, [SD])).n === 2,
     'labour, delays (cement shortage, power cut), linked elements stored');
  const d1b = await as(U.site_engineer, () => rpc('save_site_diary', diary({ labour: [{ id: lab1, trade_name: 'Mason', headcount: 7, hours: 8 }] })));
  const labRows = await all(`select id, headcount, deleted_at from diary_labour where diary_id = $1 order by headcount`, [SD]);
  ok(d1b.ok && labRows.find((r) => r.id === lab2).deleted_at !== null && labRows.find((r) => r.id === lab1).headcount === 7,
    'resave replaces children by id (missing row soft-deleted, edited row updated)');
  const dup = await as(U.office_engineer, () => rpc('save_site_diary', { ...diary(), id: uuid(), number: 'BOLE-SD-D002-0001' }));
  ok(dup.conflict === 'exists' && dup.existing_id === SD, 'second diary for same block/day returns conflict + existing id');
  await expectError(as(U.site_engineer, () => rpc('save_site_diary', diary({ diary_date: '2099-01-01' }))), /future/, 'future-dated diary rejected');
  const d2 = await as(U.site_engineer, () => rpc('save_site_diary', diary({ submit: true, labour: [{ id: lab1, trade_name: 'Mason', headcount: 7, hours: 8 }] })));
  ok(d2.status === 'submitted', 'diary submitted');
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and entity_type = 'site_diary'`, [U.office_engineer])).n === 1, 'office engineer notified to sign');
  await expectError(as(U.site_engineer, () => rpc('sign_site_diary', { diary_id: SD })), /not allowed/, 'site engineer cannot sign');
  await expectError(as(U.office_engineer, () => rpc('sign_site_diary', { diary_id: SD, approve: false })), /correcting/, 'returning a diary needs a comment');
  const signed = await as(U.office_engineer, () => rpc('sign_site_diary', { op_id: uuid(), diary_id: SD, comment: 'OK' }));
  ok(signed.status === 'signed', 'office engineer signed the diary');
  await expectError(as(U.site_engineer, () => rpc('save_site_diary', diary())), /signed/, 'signed diary cannot be re-saved');
  await expectError(db.query(`update site_diaries set work_summary = 'tampered' where id = $1`, [SD]), /signed/, 'signed diary row is immutable (even for direct SQL)');
  await expectError(db.query(`update diary_labour set headcount = 99 where id = $1`, [lab1]), /signed/, 'signed diary children are immutable');
  await expectError(db.query(`delete from site_diaries where id = $1`, [SD]), /immutable/, 'diary cannot be deleted');
  const AD = uuid();
  await as(U.site_engineer, () => rpc('add_diary_addendum', { op_id: uuid(), id: AD, diary_id: SD, text: 'Rain stopped work 15:00–16:30, not 1.5 h' }));
  ok((await one(`select count(*)::int n from diary_addenda where diary_id = $1`, [SD])).n === 1, 'addendum added to signed diary');
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and title like 'Addendum%'`, [U.office_engineer])).n === 1, 'signer notified of addendum');
  await expectError(db.query(`update diary_addenda set text = 'x' where id = $1`, [AD]), /immutable/, 'addenda are append-only');

  // =========================================================================
  console.log('\nInspections & hold points');
  const reportVerify = async (actId) => {
    const pid = uuid();
    await as(U.site_engineer, () => rpc('report_progress', { op_id: uuid(), id: pid, element_activity_id: actId, pct_complete: 100, report_date: today }));
    await as(U.office_engineer, () => rpc('verify_progress', { op_id: uuid(), progress_id: pid, approve: true }));
  };
  const allPass = async (code, overrides = {}) => (await tplItems(code)).map((i) => ({
    id: uuid(), template_item_id: i.id,
    ...(i.item_type === 'value' ? { value_num: i.min_value != null ? num(i.min_value) + 5 : 150 } : { response: 'pass' }),
    ...(overrides[i.seq] ?? {}),
  }));
  const REBAR = (await tpl('REBAR')).id, FORM = (await tpl('FORMWORK')).id;
  let insSeq = 0;
  const inspect = async (el, actId, code, tplId, overrides = {}, id = uuid()) => as(U.office_engineer, async () => rpc('submit_inspection', {
    op_id: uuid(), id, project_id: P, number: `BOLE-INS-D002-${String(++insSeq).padStart(4, '0')}`, template_id: tplId,
    element_id: el, element_activity_id: actId, items: await allPass(code, overrides),
  }));
  const passHold = async (el) => {
    const hold = (await acts(el)).find((a) => a.is_hold_point);
    await inspect(el, hold.id, 'REBAR', REBAR);
    return inspect(el, hold.id, 'FORMWORK', FORM);
  };

  const c1 = await acts(E.C1);
  for (const a of c1.slice(0, 3)) await reportVerify(a.id);
  const hold = c1[3], casting = c1[4];
  ok(hold.is_hold_point && /inspection/i.test(hold.name) && /Casting/.test(casting.name), `C1 hold point "${hold.name}" precedes "${casting.name}"`);
  await expectError(as(U.site_engineer, () => rpc('report_progress', { id: uuid(), element_activity_id: casting.id, pct_complete: 50 })),
    /Hold point/, 'casting blocked before inspection');
  const INS1 = uuid();
  await as(U.site_engineer, () => rpc('request_inspection', { op_id: uuid(), id: INS1, project_id: P, number: 'BOLE-INS-D001-0001',
    template_id: REBAR, element_id: E.C1, element_activity_id: hold.id }));
  ok((await one(`select status from inspections where id = $1`, [INS1])).status === 'requested', 'site engineer requested the rebar inspection');
  await expectError(as(U.site_engineer, async () => rpc('submit_inspection', { id: INS1, items: await allPass('REBAR') })),
    /not allowed/, 'site engineer cannot perform/approve the inspection');
  await expectError(as(U.office_engineer, async () => rpc('submit_inspection', { id: INS1, items: (await allPass('REBAR')).slice(1) })),
    /response is required/, 'every checklist item needs a response');
  const r1 = await as(U.office_engineer, async () => rpc('submit_inspection', { op_id: uuid(), id: INS1, items: await allPass('REBAR') }));
  ok(r1.result === 'pass' && r1.hold_point_cleared === false && r1.pending_checklists.includes('Formwork inspection'),
    `rebar passed; hold point still waits for: ${JSON.stringify(r1.pending_checklists)}`);
  await expectError(as(U.site_engineer, () => rpc('report_progress', { id: uuid(), element_activity_id: casting.id, pct_complete: 50 })),
    /Hold point/, 'casting still blocked until formwork is also inspected');
  const r2 = await inspect(E.C1, hold.id, 'FORMWORK', FORM);
  ok(r2.result === 'pass' && r2.hold_point_cleared === true, 'formwork passed → hold point cleared');
  const holdNow = await one(`select verified_pct from element_activities where id = $1`, [hold.id]);
  const c1el = await one(`select progress_pct from elements where id = $1`, [E.C1]);
  ok(num(holdNow.verified_pct) === 100 && num(c1el.progress_pct) === 55, `hold point verified 100%, element progress refreshed to ${c1el.progress_pct}%`);
  ok((await one(`select count(*)::int n from progress_updates where element_activity_id = $1 and status = 'verified'`, [hold.id])).n === 1, 'verified progress record written for the hold point');
  const castPid = uuid();
  await as(U.site_engineer, () => rpc('report_progress', { op_id: uuid(), id: castPid, element_activity_id: casting.id, pct_complete: 100, report_date: today }));
  ok((await one(`select reported_pct from element_activities where id = $1`, [casting.id])).reported_pct == 100, 'casting can now be reported');
  await expectError(db.query(`update inspections set result = 'fail' where id = $1`, [INS1]), /cannot be changed/, 'completed inspection is immutable');
  await expectError(db.query(`update inspection_items set response = 'fail' where inspection_id = $1`, [INS1]), /immutable/, 'inspection items are immutable');

  // failed critical item → snag
  const c2hold = (await acts(E.C2)).find((a) => a.is_hold_point);
  const INSF = uuid();
  const rf = await inspect(E.C2, c2hold.id, 'REBAR', REBAR, { 5: { value_num: 10 }, 7: { response: 'fail' } }, INSF);
  ok(rf.result === 'fail' && rf.hold_point_cleared === false, 'cover 10 mm (critical, min 20) → inspection fails, hold point stays');
  ok(rf.snag_ids.length === 1, 'failed critical item auto-created exactly one snag (non-critical fail did not)');
  const snag = await one(`select * from snags where id = $1`, [rf.snag_ids[0]]);
  ok(snag.source_type === 'inspection' && snag.source_id === INSF && snag.element_id === E.C2 && snag.severity === 'high',
    `snag ${snag.number} linked to inspection and element C2 (severity ${snag.severity})`);
  ok((await one(`select snag_id from inspection_items where inspection_id = $1 and seq = 5`, [INSF])).snag_id === snag.id, 'inspection item links its snag');
  const rc = await inspect(E.C2, c2hold.id, 'FORMWORK', FORM, { 4: { response: 'fail' } });
  ok(rc.result === 'conditional' && rc.snag_ids.length === 0, 'non-critical failure only → conditional, no auto snag');
  await expectError(as(U.office_engineer, async () => rpc('submit_inspection', { id: uuid(), project_id: P, number: 'BOLE-INS-X-1',
    template_id: REBAR, element_id: E.C2, element_activity_id: (await acts(E.C1))[3].id, items: await allPass('REBAR') })),
    /does not belong to this element/, 'activity must belong to the inspected element');

  // =========================================================================
  console.log('\nSnag lifecycle');
  const SN = snag.id;
  await as(U.site_engineer, () => rpc('save_snag', { op_id: uuid(), id: SN, project_id: P, title: snag.title, severity: 'high',
    element_id: E.C2, trade: 'Bar bender', assignee_user_id: U.site_engineer, due_date: '2026-11-02', description: 'Add 40 mm spacers' }));
  ok((await one(`select assignee_user_id, trade from snags where id = $1`, [SN])).trade === 'Bar bender', 'snag edited: trade, assignee, due date');
  await expectError(as(U.site_engineer, () => rpc('snag_action', { snag_id: SN, action: 'close' })), /not allowed/, 'site engineer cannot close a snag');
  await as(U.site_engineer, () => rpc('snag_action', { op_id: uuid(), snag_id: SN, action: 'start' }));
  await as(U.site_engineer, () => rpc('snag_action', { op_id: uuid(), snag_id: SN, action: 'ready', comment: 'Spacers added' }));
  ok((await one(`select status from snags where id = $1`, [SN])).status === 'ready_for_review', 'open → in_progress → ready_for_review');
  await as(U.office_engineer, () => rpc('snag_action', { op_id: uuid(), snag_id: SN, action: 'close' }));
  const closed = await one(`select status, closed_by from snags where id = $1`, [SN]);
  ok(closed.status === 'closed' && closed.closed_by === U.office_engineer, 'office engineer closed the snag');
  await expectError(as(U.site_engineer, () => rpc('save_snag', { id: SN, project_id: P, title: 'x' })), /closed/, 'closed snag cannot be edited');
  await expectError(db.query(`update snags set title = 'x' where id = $1`, [SN]), /closed/, 'closed snag row is immutable');
  await expectError(as(U.office_engineer, () => rpc('snag_action', { snag_id: SN, action: 'reopen' })), /comment/, 'reopen needs a comment');
  await as(U.office_engineer, () => rpc('snag_action', { op_id: uuid(), snag_id: SN, action: 'reopen', comment: 'Cover still 25 mm at top' }));
  const reo = await one(`select status, closed_by from snags where id = $1`, [SN]);
  ok(reo.status === 'reopened' && reo.closed_by === null, 'closed → reopened');
  await expectError(as(U.site_engineer, () => rpc('snag_action', { snag_id: SN, action: 'close' })), /not allowed/, 'reopened snag cannot be closed by site engineer');
  await expectError(as(U.office_engineer, () => rpc('snag_action', { snag_id: SN, action: 'close' })), /cannot be moved/, 'cannot close straight from reopened');
  const ev = await all(`select action from snag_events where snag_id = $1 order by created_at, action`, [SN]);
  ok(ev.length === 6, `snag history: ${ev.map((e) => e.action).join(' → ')}`);
  await expectError(db.query(`update snag_events set comment = 'x' where snag_id = $1`, [SN]), /immutable/, 'snag events are append-only');
  const WSN = uuid();
  await as(U.site_engineer, () => rpc('save_snag', { op_id: uuid(), id: WSN, project_id: P, number: 'BOLE-SNG-D001-0001', title: 'Honeycomb at C1 base',
    severity: 'medium', element_id: E.C1, category: 'concrete', assignee_party: 'Concrete gang' }));
  ok((await one(`select source_type, block_id from snags where id = $1`, [WSN])).block_id === B, 'walk snag saved; block taken from element');
  ok((await as(outsider, () => all(`select * from snags`))).length === 0, 'non-member cannot see snags');

  // =========================================================================
  console.log('\nReady-mix pour');
  const MD = uuid();
  await expectError(as(U.site_engineer, () => rpc('save_mix_design', { id: MD, project_id: P, grade: 'C-25/30', material_spec_id: CONC })),
    /not allowed/, 'site engineer cannot define mix designs');
  await as(U.office_engineer, () => rpc('save_mix_design', { op_id: uuid(), id: MD, project_id: P, code: 'C25-RM', grade: 'C-25/30',
    source: 'ready_mix', material_spec_id: CONC, target_slump_mm: 100, slump_tolerance_mm: 25 }));
  ok(num((await one(`select target_strength_mpa from mix_designs where id = $1`, [MD])).target_strength_mpa) === 30, 'target cube strength derived from grade C-25/30 → 30 MPa');
  await passHold(E.C4);
  const POUR = uuid();
  const pourPayload = (els) => ({ op_id: uuid(), id: POUR, project_id: P, number: 'BOLE-POUR-D001-0001', pour_date: today, mix_design_id: MD,
    method: 'ready_mix', supplier_name: 'Derba Ready-Mix', store_id: BATCH, planned_m3: 6, elements: els });
  await as(U.site_engineer, () => rpc('save_pour', pourPayload([{ id: uuid(), element_id: E.C1, planned_m3: 4 }, { id: uuid(), element_id: E.C2, planned_m3: 2 }])));
  const T1 = uuid(), T2 = uuid();
  const truck = (id, over) => ({ op_id: uuid(), id, pour_id: POUR, ticket_no: 'DRB-5512', truck_plate: '3-B44521', volume_m3: 6,
    batched_at: `${today}T08:00:00+03:00`, arrived_at: `${today}T08:40:00+03:00`, discharge_start: `${today}T08:50:00+03:00`,
    slump_mm: 110, concrete_temp_c: 24, accepted: true, ...over });
  await expectError(as(U.site_engineer, () => rpc('add_pour_truck', truck(T1))), /Hold point .* on element C2/, 'truck blocked while C2 hold point not passed');
  await as(U.site_engineer, () => rpc('save_pour', pourPayload([{ id: uuid(), element_id: E.C1, planned_m3: 4 }, { id: uuid(), element_id: E.C4, planned_m3: 2 }])));
  ok((await one(`select count(*)::int n from pour_elements where pour_id = $1 and deleted_at is null`, [POUR])).n === 2, 'pour re-planned on C1 + C4');
  const t1 = await as(U.site_engineer, () => rpc('add_pour_truck', truck(T1)));
  ok(t1.status === 'awaiting_receipt', 'site engineer recorded accepted truck → awaiting store keeper receipt');
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and entity_type = 'pour_truck'`, [U.store_keeper])).n === 1, 'store keeper notified');
  const t2 = await as(U.site_engineer, () => rpc('add_pour_truck', truck(T2, { ticket_no: 'DRB-5513', accepted: false, slump_mm: 200,
    water_added_l: 40, arrived_at: `${today}T10:00:00+03:00`, reject_reason: 'Slump 200 mm, water added by driver' })));
  ok(t2.status === 'rejected' && t2.warnings.includes('late_arrival') && t2.warnings.includes('water_added') && t2.warnings.includes('slump_out_of_range'),
    `rejected truck recorded with warnings ${JSON.stringify(t2.warnings)}`);
  await expectError(as(U.site_engineer, () => rpc('add_pour_truck', truck(uuid(), { ticket_no: 'X1', accepted: false }))), /reason/, 'rejecting a truck needs a reason');
  await expectError(as(U.site_engineer, () => rpc('receive_pour_truck', { truck_id: T1, grn_number: 'x', miv_number: 'y' })), /not allowed/, 'site engineer cannot post the receipt');
  const GRN1 = uuid(), MIV1 = uuid(), recvOp = uuid();
  const recv = { op_id: recvOp, truck_id: T1, grn_id: GRN1, grn_number: 'BOLE-GRN-D003-0001', miv_id: MIV1, miv_number: 'BOLE-MIV-D003-0001' };
  const rv1 = await as(U.store_keeper, () => rpc('receive_pour_truck', recv));
  const rv2 = await as(U.store_keeper, () => rpc('receive_pour_truck', recv));
  ok(rv1.grn_id === GRN1 && rv1.miv_id === MIV1 && JSON.stringify(rv1) === JSON.stringify(rv2), 'store keeper posted truck; replay is idempotent');
  const led = await all(`select doc_type, store_id, element_id, qty::float q from stock_ledger where doc_id in ($1, $2) order by doc_type, q`, [GRN1, MIV1]);
  ok(led.length === 3, `ledger rows for truck: ${led.map((r) => `${r.doc_type} ${r.q}`).join(', ')}`);
  ok(led.find((r) => r.doc_type === 'grn').q === 6 && led.find((r) => r.doc_type === 'grn').store_id === BATCH, 'GRN +6 m³ into batching store');
  ok(led.find((r) => r.element_id === E.C1).q === -4 && led.find((r) => r.element_id === E.C4).q === -2, 'MIV split pro-rata: C1 −4, C4 −2');
  ok(num((await one(`select coalesce(sum(qty),0) q from stock_ledger where store_id = $1 and material_spec_id = $2`, [BATCH, CONC])).q) === 0, 'batching store concrete balance back to 0 (no double entry)');
  ok((await one(`select count(*)::int n from stock_ledger where doc_number like '%5513%' or doc_id in (select grn_id from pour_trucks where id = $1 and grn_id is not null)`, [T2])).n === 0, 'rejected truck posted nothing');
  const g = await one(`select delivery_note_no, vehicle_plate, status from grns where id = $1`, [GRN1]);
  const m = await one(`select status, issued_to, is_emergency, mr_id from mivs where id = $1`, [MIV1]);
  ok(g.delivery_note_no === 'DRB-5512' && g.vehicle_plate === '3-B44521', 'GRN carries batch ticket no. and truck plate');
  ok(m.status === 'acknowledged' && m.issued_to === U.site_engineer && !m.is_emergency && m.mr_id === null, 'MIV acknowledged to the pour engineer, not an emergency issue');
  const consC1 = await as(U.coordinator, () => one(`select issued_qty from v_element_consumption where element_id = $1 and material_spec_id = $2`, [E.C1, CONC]));
  ok(num(consC1.issued_qty) === 4, 'element consumption view shows 4 m³ concrete in C1');
  await expectError(db.query(`update pour_trucks set volume_m3 = 9 where id = $1`, [T1]), /immutable/, 'posted truck ticket is immutable');
  const T3 = uuid();
  const t3 = await as(U.store_keeper, () => rpc('add_pour_truck', truck(T3, { ticket_no: 'DRB-5514', volume_m3: 1.5,
    grn_id: uuid(), grn_number: 'BOLE-GRN-D003-0002', miv_id: uuid(), miv_number: 'BOLE-MIV-D003-0002' })));
  ok(t3.status === 'posted' && t3.grn_id && t3.miv_id, 'store keeper recording a truck posts GRN+MIV immediately');
  const cl = await as(U.site_engineer, () => rpc('close_pour', { op_id: uuid(), pour_id: POUR }));
  ok(cl.status === 'completed' && num(cl.actual_m3) === 7.5 && near(cl.over_pour_pct, 25), `pour closed: actual ${cl.actual_m3} m³, over-pour ${cl.over_pour_pct}%`);
  const c4cast = (await acts(E.C4)).find((a) => /Casting/.test(a.name));
  ok((await one(`select reported_pct from element_activities where id = $1`, [c4cast.id])).reported_pct == 100, 'closing the pour reported casting 100% on C4');
  await expectError(as(U.site_engineer, () => rpc('add_pour_truck', truck(uuid(), { ticket_no: 'LATE' }))), /completed/, 'no trucks after pour is completed');
  const ps = await as(U.manager, () => one(`select * from v_pour_summary where pour_id = $1`, [POUR]));
  ok(ps.trucks == 3 && ps.trucks_rejected == 1 && num(ps.accepted_m3) === 7.5 && num(ps.rejected_m3) === 6, 'v_pour_summary: 3 trucks, 1 rejected, 7.5 m³ accepted');

  // =========================================================================
  console.log('\nSite-batched pour');
  await as(U.coordinator, () => rpc('post_opening_balance', { op_id: uuid(), project_id: P, store_id: MAIN, lines: [{ material_spec_id: OPC, qty: 50 }] }));
  const MDS = uuid();
  await as(U.office_engineer, () => rpc('save_mix_design', { op_id: uuid(), id: MDS, project_id: P, code: 'C20-SITE', grade: 'C-20/25',
    source: 'site', cement_spec_id: OPC, cement_kg_per_m3: 350, water_cement_ratio: 0.55, sand_m3_per_m3: 0.5, aggregate_m3_per_m3: 0.8 }));
  const POUR2 = uuid();
  await as(U.site_engineer, () => rpc('save_pour', { op_id: uuid(), id: POUR2, project_id: P, number: 'BOLE-POUR-D001-0002', pour_date: today,
    mix_design_id: MDS, store_id: MAIN, planned_m3: 2, elements: [{ id: uuid(), element_id: E.F1, planned_m3: 2 }] }));
  ok((await one(`select method from pours where id = $1`, [POUR2])).method === 'site_batched', 'method defaults from site mix design');
  await expectError(as(U.site_engineer, () => rpc('add_pour_batch', { id: uuid(), pour_id: POUR2, cement_bags: 7, volume_m3: 1 })),
    /Hold point .* on element F1/, 'site batching also respects hold points');
  await passHold(E.F1);
  for (const n of [1, 2]) {
    await as(U.site_engineer, () => rpc('add_pour_batch', { op_id: uuid(), id: uuid(), pour_id: POUR2, volume_m3: 1, cement_bags: 7,
      sand_m3: 0.5, aggregate_m3: 0.8, water_l: 190, slump_mm: 75, mixer: 'Mixer 1', batched_at: `${today}T0${n + 7}:00:00+03:00` }));
  }
  await expectError(as(U.site_engineer, () => rpc('add_pour_truck', truck(uuid(), { pour_id: POUR2 }))), /site-batched/, 'cannot add trucks to a site-batched pour');
  await expectError(as(U.site_engineer, () => rpc('issue_pour_materials', { pour_id: POUR2, miv_id: uuid(), number: 'x', lines: [{ material_spec_id: OPC, qty: 7 }] })),
    /not allowed/, 'only the store keeper issues cement');
  const MIVC = uuid();
  await as(U.store_keeper, () => rpc('issue_pour_materials', { op_id: uuid(), pour_id: POUR2, miv_id: MIVC, number: 'BOLE-MIV-D003-0003',
    lines: [{ material_spec_id: OPC, qty: 7 }] }));
  const cem = await one(`select element_id, qty::float q, store_id from stock_ledger where doc_id = $1`, [MIVC]);
  ok(cem.element_id === E.F1 && cem.q === -7 && cem.store_id === MAIN, 'cement 7 qtl issued from main store to F1 via MIV');
  ok(num((await one(`select coalesce(sum(qty),0) q from stock_ledger where store_id = $1 and material_spec_id = $2`, [MAIN, OPC])).q) === 43, 'cement stock 50 → 43 qtl');
  await expectError(as(U.store_keeper, () => rpc('issue_pour_materials', { pour_id: POUR2, miv_id: uuid(), number: 'BOLE-MIV-D003-0099',
    lines: [{ material_spec_id: OPC, qty: 100 }] })), /Insufficient/, 'cannot issue more cement than in stock');
  await as(U.site_engineer, () => rpc('close_pour', { op_id: uuid(), pour_id: POUR2 }));
  const ps2 = await as(U.manager, () => one(`select * from v_pour_summary where pour_id = $1`, [POUR2]));
  ok(num(ps2.actual_m3) === 2 && num(ps2.cement_bags) === 14 && num(ps2.batched_cement_kg_per_m3) === 350 && num(ps2.issued_cement_kg_per_m3) === 350 && num(ps2.cement_variance_pct) === 0,
    `site-batch vs mix design: batched ${ps2.batched_cement_kg_per_m3} kg/m³, issued ${ps2.issued_cement_kg_per_m3} kg/m³, design 350 → variance ${ps2.cement_variance_pct}%`);

  // =========================================================================
  console.log('\nCube tests');
  const CS = uuid(), CS2 = uuid();
  await as(U.site_engineer, () => rpc('save_cube_set', { op_id: uuid(), id: CS, project_id: P, number: 'BOLE-CUBE-D001-0001', pour_id: POUR,
    truck_id: T1, element_id: E.C1, sampled_at: `${today}T09:00:00+03:00`, cubes_count: 6, test_ages: [7, 28], lab_name: 'AAU lab' }));
  await as(U.site_engineer, () => rpc('save_cube_set', { op_id: uuid(), id: CS2, project_id: P, number: 'BOLE-CUBE-D001-0002', pour_id: POUR,
    truck_id: T3, element_id: E.C4, sampled_at: `${today}T11:00:00+03:00` }));
  ok((await as(U.office_engineer, () => all(`select * from v_cubes_due where cube_set_id = $1`, [CS]))).length === 2, 'cube set due list shows 7- and 28-day tests');
  await expectError(as(U.site_engineer, () => rpc('record_cube_results', { cube_set_id: CS, results: [{ id: uuid(), cube_label: 'A', age_days: 7, strength_mpa: 20 }] })),
    /not allowed/, 'site engineer cannot enter lab results');
  const e7 = await as(U.office_engineer, () => rpc('record_cube_results', { op_id: uuid(), cube_set_id: CS, results:
    ['A', 'B', 'C'].map((l) => ({ id: uuid(), cube_label: l, age_days: 7, load_kn: 450 })) }));
  ok(e7.result_early === 'ok' && e7.result_28d === null, '7-day 20 MPa (≥ 0.65 × 30) → early result ok');
  ok(num((await one(`select strength_mpa from cube_results where cube_set_id = $1 limit 1`, [CS])).strength_mpa) === 20, 'strength computed from load: 450 kN / 150² mm = 20 MPa');
  const critBefore = (await one(`select count(*)::int n from notifications where user_id = $1 and is_critical`, [U.manager])).n;
  const f28 = await as(U.office_engineer, () => rpc('record_cube_results', { op_id: uuid(), cube_set_id: CS, results:
    [['D', 26], ['E', 27], ['F', 25]].map(([l, s]) => ({ id: uuid(), cube_label: l, age_days: 28, strength_mpa: s })) }));
  ok(f28.result_28d === 'fail' && num(f28.mean_28d_mpa) === 26, `28-day mean ${f28.mean_28d_mpa} MPa < 30 → FAIL`);
  const cubeSnag = await one(`select * from snags where id = $1`, [f28.snag_id]);
  ok(cubeSnag && cubeSnag.source_type === 'cube' && cubeSnag.source_id === CS && cubeSnag.severity === 'critical' && cubeSnag.element_id === E.C1,
    `critical snag ${cubeSnag?.number} raised on C1 for the cube failure`);
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and is_critical`, [U.manager])).n === critBefore + 1 &&
     (await one(`select count(*)::int n from notifications where user_id = $1 and is_critical and entity_type = 'cube_set'`, [U.coordinator])).n === 1,
     'manager and coordinator got a critical notification');
  ok((await one(`select result_28d, snag_id from cube_sets where id = $1`, [CS])).snag_id === f28.snag_id, 'cube set records result and snag');
  ok((await as(U.office_engineer, () => all(`select * from v_cubes_due where cube_set_id = $1`, [CS]))).length === 0, 'tested ages leave the due list');
  const p28 = await as(U.office_engineer, () => rpc('record_cube_results', { op_id: uuid(), cube_set_id: CS2, results:
    ['A', 'B', 'C'].map((l, i) => ({ id: uuid(), cube_label: l, age_days: 28, load_kn: 720 + i * 10 })) }));
  ok(p28.result_28d === 'pass' && p28.snag_id === null, `second set 28-day mean ${p28.mean_28d_mpa} MPa → pass, no snag`);
  await expectError(db.query(`update cube_results set strength_mpa = 35 where cube_set_id = $1`, [CS]), /immutable/, 'cube results are immutable');
  const ps3 = await as(U.manager, () => one(`select cube_sets, cube_sets_failed from v_pour_summary where pour_id = $1`, [POUR]));
  ok(ps3.cube_sets == 2 && ps3.cube_sets_failed == 1, 'pour summary counts failed cube sets');

  // =========================================================================
  console.log('\nRebar BBS reconciliation');
  const BBS = uuid();
  await expectError(as(U.site_engineer, () => rpc('save_bbs', { id: BBS, project_id: P, number: 'x', element_id: E.C1, lines: [] })), /not allowed/, 'site engineer cannot import a BBS');
  const sb = await as(U.office_engineer, () => rpc('save_bbs', { op_id: uuid(), id: BBS, project_id: P, number: 'BOLE-BBS-D002-0001',
    element_id: E.C1, drawing_ref: 'S-201', lines: [
      { id: uuid(), bar_mark: 'C1-01', material_spec_id: R16, shape_code: '00', no_of_members: 1, bars_per_member: 4, cut_length_m: 3.2 },
      { id: uuid(), bar_mark: 'C1-02', material_spec_id: R8, diameter_mm: 8, shape_code: '51', bars_per_member: 20, cut_length_m: 1.1 },
    ] }));
  const bl = await all(`select bar_mark, diameter_mm, total_length_m::float tl, unit_weight_kg_m::float uw, weight_kg::float w from bbs_lines where bbs_id = $1 order by line_no`, [BBS]);
  ok(bl[0].diameter_mm === 16 && near(bl[0].w, 20.227) && near(bl[0].uw, 1.5802) && near(bl[0].tl, 12.8), `Ø16 4×3.2 m: Ø²/162 = ${bl[0].uw} kg/m → ${bl[0].w} kg (diameter from spec)`);
  ok(near(bl[1].w, 8.691), `Ø8 20×1.1 m → ${bl[1].w} kg`);
  ok(near(sb.total_kg, 28.918), `BBS total ${sb.total_kg} kg`);
  // take-off, request, receipt, issue and return of Ø16 to C1
  await as(U.office_engineer, () => db.query(`insert into element_takeoffs (project_id, element_id, material_spec_id, planned_qty) values ($1, $2, $3, 30)`, [P, E.C1, R16]));
  const MR = uuid(), MRL = uuid();
  await as(U.site_engineer, () => rpc('save_mr', { op_id: uuid(), id: MR, project_id: P, number: 'BOLE-MR-D001-0001', block_id: B,
    required_date: today, delivery_location: 'Main store', submit: true,
    lines: [{ id: MRL, material_spec_id: R16, qty: 25, elements: [{ id: uuid(), element_id: E.C1, qty: 25 }] }] }));
  await as(U.office_engineer, () => rpc('mr_action', { op_id: uuid(), mr_id: MR, action: 'review' }));
  await as(U.coordinator, () => rpc('mr_action', { op_id: uuid(), mr_id: MR, action: 'approve' }));
  await as(U.store_keeper, () => rpc('post_grn', { op_id: uuid(), id: uuid(), project_id: P, store_id: MAIN, number: 'BOLE-GRN-D003-0010',
    lines: [{ id: uuid(), material_spec_id: R16, mr_line_id: MRL, qty_delivered: 50 }] }));
  const RMIV = uuid();
  await as(U.store_keeper, () => rpc('post_miv', { op_id: uuid(), id: RMIV, project_id: P, store_id: MAIN, number: 'BOLE-MIV-D003-0010', mr_id: MR,
    issued_to: U.site_engineer, lines: [{ id: uuid(), mr_line_id: MRL, material_spec_id: R16, element_id: E.C1, qty: 24 }] }));
  await as(U.store_keeper, () => rpc('post_mrn', { op_id: uuid(), id: uuid(), project_id: P, store_id: MAIN, number: 'BOLE-MRN-D003-0010', miv_id: RMIV,
    lines: [{ id: uuid(), material_spec_id: R16, element_id: E.C1, qty: 2, condition: 'good' }] }));
  const rec = await as(U.manager, () => all(`select * from v_rebar_reconciliation where element_id = $1 order by diameter_mm`, [E.C1]));
  const r8 = rec.find((r) => r.diameter_mm === 8), r16 = rec.find((r) => r.diameter_mm === 16);
  ok(rec.length === 2, 'reconciliation has one row per diameter (Ø8, Ø16)');
  ok(near(r16.bbs_kg, 20.227) && near(r16.takeoff_kg, 30) && near(r16.issued_kg, 24) && near(r16.returned_kg, 2) && near(r16.net_issued_kg, 22),
    `Ø16: BBS ${r16.bbs_kg} · take-off ${r16.takeoff_kg} · issued ${r16.issued_kg} · returned ${r16.returned_kg} · net ${r16.net_issued_kg} kg`);
  ok(near(r16.variance_kg, 1.773) && near(r16.variance_pct, 8.77, 0.01) && r16.flag === 'over' && near(r16.allowance_pct, 3),
    `Ø16 variance ${r16.variance_kg} kg (${r16.variance_pct}%) > ${r16.allowance_pct}% allowance → ${r16.flag}`);
  ok(near(r8.bbs_kg, 8.691) && num(r8.issued_kg) === 0 && r8.flag === 'ok', 'Ø8 not yet issued (element not complete) → ok');
  ok((await as(U.site_engineer, () => all(`select * from v_rebar_reconciliation where element_id = $1`, [E.C1]))).length === 2, 'members (site) can read the reconciliation');
  const ap = await as(U.office_engineer, () => rpc('approve_bbs', { op_id: uuid(), bbs_id: BBS, update_takeoff: true }));
  ok(ap.status === 'approved' && ap.takeoffs_updated === 2, 'BBS approved and take-offs updated from BBS weights');
  ok(near((await one(`select planned_qty from element_takeoffs where element_id = $1 and material_spec_id = $2`, [E.C1, R16])).planned_qty, 20.227), 'Ø16 take-off now 20.227 kg');
  await expectError(db.query(`update bbs_lines set cut_length_m = 9 where bbs_id = $1`, [BBS]), /approved/, 'approved BBS lines are frozen');
  await expectError(as(U.office_engineer, () => rpc('save_bbs', { id: BBS, project_id: P, number: 'BOLE-BBS-D002-0001', element_id: E.C1,
    lines: [{ id: uuid(), bar_mark: 'X', diameter_mm: 12, bars_per_member: 1, cut_length_m: 1 }] })), /new revision/, 'approved BBS cannot be edited');
  const BBS2 = uuid();
  await as(U.office_engineer, () => rpc('save_bbs', { op_id: uuid(), id: BBS2, project_id: P, number: 'BOLE-BBS-D002-0002', element_id: E.C1,
    lines: [{ id: uuid(), bar_mark: 'C1-01', material_spec_id: R16, bars_per_member: 6, cut_length_m: 3.2 }] }));
  ok((await one(`select revision from bbs_schedules where id = $1`, [BBS2])).revision === 1, 'next BBS revision numbered 1');
  ok(near((await as(U.manager, () => one(`select bbs_kg from v_rebar_reconciliation where element_id = $1 and diameter_mm = 16`, [E.C1]))).bbs_kg, 20.227),
    'draft revision does not replace the approved one in the reconciliation');
  await as(U.coordinator, () => rpc('approve_bbs', { op_id: uuid(), bbs_id: BBS2 }));
  ok((await one(`select status from bbs_schedules where id = $1`, [BBS])).status === 'superseded', 'approving rev 1 supersedes rev 0');
  ok(near((await as(U.manager, () => one(`select bbs_kg from v_rebar_reconciliation where element_id = $1 and diameter_mm = 16`, [E.C1]))).bbs_kg, 30.341),
    'reconciliation uses the newly approved revision (30.341 kg)');

  // =========================================================================
  console.log('\nDiary auto summary');
  const sum = await as(U.office_engineer, () => rpc('get_diary_summary', { project_id: P, diary_date: today, block_id: B }));
  ok(sum.grn?.length >= 3 && sum.miv?.length >= 3 && sum.pour?.length === 2 && sum.inspection?.length >= 5 && sum.snag?.length >= 2 && sum.progress?.length >= 3,
    `summary for ${today}: ${Object.entries(sum).map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
  ok(sum.pour.some((x) => /C-25\/30 7\.5/.test(x.summary)), `pour line: "${sum.pour.find((x) => /C-25/.test(x.summary))?.summary}"`);
  ok(Object.keys(await as(outsider, () => rpc('get_diary_summary', { project_id: P, diary_date: today }))).length === 0, 'summary respects RLS (outsider sees nothing)');

  const audit = await one(`select count(*)::int n from audit_log where table_name in ('site_diaries','inspections','snags','pours','pour_trucks','cube_sets','bbs_schedules')`);
  ok(audit.n > 20, `audit trail on field/quality headers (${audit.n} entries)`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e.message, e.position ? `at position ${e.position}` : '', e.where ?? ''); process.exit(1); });
