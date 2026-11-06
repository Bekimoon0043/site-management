// Contract administration test (migrations 20261105000040_contract_admin.sql, 041_receivables_retention.sql,
// 042_office_inbox.sql): RFIs and site instructions, drawing register, submittals with review codes, meetings and
// action items, risks, EOT claims with diary evidence, client receivables ageing, retention release, office inbox items
// and the portfolio view.
//
//   node supabase/tests/contract-admin.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const MINE = ['20261105000040_contract_admin.sql', '20261105000041_receivables_retention.sql', '20261105000042_office_inbox.sql'];

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
const rpc = async (name, p) => (await db.query(`select public.${name}($1::jsonb) as r`, [JSON.stringify({ op_id: uuid(), ...p })])).rows[0].r;
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
async function expectError(promise, pattern, msg) {
  try { await promise; ok(false, `${msg} (no error raised)`); }
  catch (e) { ok(pattern.test(e.message), `${msg} → "${e.message}"`); }
}
const n = (v) => (v == null ? null : Number(v));
const iso = (d) => d.toISOString().slice(0, 10);
const today = () => iso(new Date(Date.now() + 3 * 3600_000));
const daysAgo = (k) => iso(new Date(Date.now() + 3 * 3600_000 - k * 86400_000));
const inbox = (u, P) => as(u, () => all(`select * from v_my_approvals where kind = 'office' and project_id = $1`, [P]));

async function main() {
  console.log('Applying migrations…');
  await db.exec(STUBS);
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
    } catch (e) {
      // other modules being built in parallel (same date, not ours) may not apply yet — skip them, never ours
      if (MINE.includes(f) || f < '20261105') throw new Error(`${f}: ${e.message}`);
      console.log('  SKIPPED (parallel work, failed to apply)', f, '—', e.message);
    }
  }
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);

  const U = {};
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper', 'procurement', 'finance']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role }, { role }]);
  }
  const P = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name, start_date, end_date) values ($1, 'G4', 'G+4 Office', '2026-03-01', '2027-06-30')`, [P]);
    for (const r of Object.keys(U).filter((r) => r !== 'admin')) await db.query(`insert into project_members values ($1, $2)`, [P, U[r]]);
  });
  const notes = async (u, re) => (await all(`select title from notifications where user_id = $1`, [u])).filter((x) => re.test(x.title));

  // =====================================================================
  console.log('\nSettings');
  await expectError(as(U.office_engineer, () => rpc('save_contract_admin_settings', { project_id: P, rfi_response_days: 5 })), /not allowed/, 'office engineer cannot change the response days');
  await as(U.coordinator, () => rpc('save_contract_admin_settings', { project_id: P, rfi_response_days: 5 }));
  ok(n((await one(`select rfi_response_days r, claim_notice_days c from contract_admin_settings where project_id = $1`, [P])).r) === 5, 'RFI response 5 days, claim notice stays 28');

  console.log('\nRFIs');
  await expectError(as(U.store_keeper, () => rpc('save_rfi', { id: uuid(), project_id: P, subject: 'x', description: 'y' })), /not allowed/, 'store keeper cannot raise an RFI');
  await expectError(as(U.site_engineer, () => rpc('save_rfi', { id: uuid(), project_id: P, subject: 'Lintel', description: '' })), /question/, 'an RFI needs a question');
  const R1 = uuid();
  const r1 = await as(U.site_engineer, () => rpc('save_rfi', { id: R1, project_id: P, subject: 'Lintel depth at grid C', description: 'Drawing S-04 shows 200, A-12 shows 300. Which applies?',
    discipline: 'structural', drawing_refs: 'S-04, A-12', addressed_to: 'MH Engineering' }));
  ok(r1.number === 'RFI-001' && r1.due_date === iso(new Date(Date.parse(today()) + 5 * 86400_000)), `RFI-001 raised by the site engineer, answer due in 5 days (${r1.due_date})`);
  ok((await notes(U.office_engineer, /RFI-001 raised/)).length === 1, 'office engineer notified');
  const R2 = uuid();
  const r2 = await as(U.site_engineer, () => rpc('save_rfi', { id: R2, project_id: P, subject: 'Waterproofing to lift pit', description: 'Membrane type?', raised_on: daysAgo(10), priority: 'urgent' }));
  ok(r2.number === 'RFI-002', 'numbering continues RFI-002');
  let ib = await inbox(U.office_engineer, P);
  ok(ib.some((x) => x.entity_id === R2 && /Chase the answer to RFI-002/.test(x.title) && x.is_urgent) && !ib.some((x) => x.entity_id === R1),
    'office engineer inbox: chase the overdue RFI-002 (urgent), not RFI-001');
  ok((await inbox(U.site_engineer, P)).every((x) => x.entity_type !== 'rfi' || x.title.startsWith('Act on')), 'site engineer is not asked to chase RFIs');
  await expectError(as(U.site_engineer, () => rpc('decide_rfi', { rfi_id: R2, action: 'answer', answer: 'x' })), /not allowed/, 'site engineer cannot record the answer');
  await expectError(as(U.office_engineer, () => rpc('decide_rfi', { rfi_id: R2, action: 'close' })), /answer before closing/, 'an RFI cannot be closed unanswered');
  await as(U.office_engineer, () => rpc('decide_rfi', { rfi_id: R2, action: 'answer', answer: 'Use 2 layers of SBS membrane, see SI-xx', answered_by: 'Eng. Abebe',
    cost_impact: 'yes', cost_amount: 85000, time_impact: 'tbd' }));
  const a2 = await one(`select status, ball_in_court, answered_on from rfis where id = $1`, [R2]);
  ok(a2.status === 'answered' && a2.ball_in_court === 'contractor', 'answered, ball back with the contractor');
  ok((await notes(U.site_engineer, /RFI-002 answered/)).length === 1, 'author told about the answer');
  ok((await inbox(U.coordinator, P)).some((x) => x.entity_id === R2 && /Raise a variation \/ EOT for RFI-002 \(cost impact, time impact\)/.test(x.title)), 'coordinator asked to raise a variation / EOT');
  const VO = uuid();
  await db.query(`insert into variations (id, project_id, number, title, created_by) values ($1, $2, 'VO-001', 'Lift pit membrane', $3)`, [VO, P, U.coordinator]);
  await as(U.coordinator, () => rpc('decide_rfi', { rfi_id: R2, action: 'link', variation_id: VO }));
  ok((await inbox(U.coordinator, P)).some((x) => x.entity_id === R2), 'still listed: time impact has no EOT yet');

  console.log('\nSite instructions');
  const D = uuid(), DI = uuid();
  await db.query(`insert into site_diaries (id, project_id, number, diary_date, status, created_by) values ($1, $2, 'G4-DY-1', $3, 'submitted', $4)`, [D, P, daysAgo(3), U.site_engineer]);
  await db.query(`insert into diary_instructions (id, diary_id, project_id, given_by, organisation, instruction) values ($1, $2, $3, 'Eng. Abebe', 'MH Engineering', 'Add 2 no. 12 mm bars at slab opening')`, [DI, D, P]);
  const S1 = uuid();
  const s1 = await as(U.site_engineer, () => rpc('save_rfi', { id: S1, project_id: P, kind: 'si', subject: 'Trimmer bars at slab opening', description: 'Add 2 no. 12 mm bars at slab opening', diary_instruction_id: DI }));
  const sr = await one(`select issued_by, ball_in_court, due_date from rfis where id = $1`, [S1]);
  ok(s1.number === 'SI-001' && sr.issued_by === 'Eng. Abebe' && sr.ball_in_court === 'contractor', 'SI-001 registered from the diary instruction (given by Eng. Abebe)');
  await expectError(as(U.site_engineer, () => rpc('save_rfi', { id: uuid(), project_id: P, kind: 'si', subject: 'dup', description: 'dup', diary_instruction_id: DI })), /duplicate|unique/i, 'the same diary instruction cannot be registered twice');
  ok((await inbox(U.coordinator, P)).some((x) => x.entity_id === S1 && /Act on site instruction SI-001/.test(x.title)), 'coordinator inbox: act on SI-001');
  await as(U.office_engineer, () => rpc('decide_rfi', { rfi_id: S1, action: 'answer', answer: 'Bars added, checked by the consultant on site' }));
  await as(U.office_engineer, () => rpc('decide_rfi', { rfi_id: S1, action: 'close' }));
  ok((await one(`select status from rfis where id = $1`, [S1])).status === 'closed' && !(await inbox(U.coordinator, P)).some((x) => x.entity_id === S1), 'SI complied and closed, gone from the inbox');

  console.log('\nDrawing register');
  const DOC = uuid();
  await as(U.office_engineer, () => rpc('save_document', { id: DOC, project_id: P, doc_no: 'S-04', title: 'First floor slab reinforcement', discipline: 'structural',
    revision: { rev: 'a', received_on: daysAgo(30), transmittal_ref: 'TR-011' } }));
  await as(U.office_engineer, () => rpc('save_document', { id: DOC, project_id: P, doc_no: 'S-04', title: 'First floor slab reinforcement', discipline: 'structural',
    revision: { rev: 'B', transmittal_ref: 'TR-019', notes: 'Lintel depth per RFI-001' } }));
  const revs = await all(`select rev, superseded_at from document_revisions where document_id = $1 order by rev`, [DOC]);
  const doc = await one(`select current_rev from project_documents where id = $1`, [DOC]);
  ok(doc.current_rev === 'B' && revs[0].superseded_at && !revs[1].superseded_at, 'rev B is current, rev A superseded');
  await expectError(as(U.office_engineer, () => rpc('save_document', { id: DOC, project_id: P, doc_no: 'S-04', title: 'x', revision: { rev: 'B' } })), /already registered/, 'a revision cannot be registered twice');
  await expectError(as(U.office_engineer, () => rpc('save_document', { id: uuid(), project_id: P, doc_no: 'S-04', title: 'x' })), /already in the register/, 'document numbers are unique');
  ok((await notes(U.site_engineer, /S-04 rev B issued for construction/)).length === 1, 'site engineer told to use rev B');

  console.log('\nSubmittals');
  const MAT = uuid(), SPEC = uuid();
  await db.query(`insert into materials (id, category, name) values ($1, 'Waterproofing', 'SBS membrane')`, [MAT]);
  await db.query(`insert into material_specs (id, material_id, grade, uom) values ($1, $2, '4 mm', 'm2')`, [SPEC, MAT]);
  const SB = uuid();
  const sb = await as(U.office_engineer, () => rpc('save_submittal', { id: SB, project_id: P, title: 'SBS membrane 4 mm — product data', kind: 'material',
    material_spec_id: SPEC, supplier: 'Abyssinia Chemicals', required_by: iso(new Date(Date.now() + 10 * 86400_000)) }));
  ok(sb.number === 'SUB-001' && sb.status === 'draft', 'SUB-001 drafted');
  ok((await inbox(U.office_engineer, P)).some((x) => x.entity_id === SB && /still a draft/.test(x.title)), 'approval needed within 14 days → reminder while still a draft');
  const sub0 = await as(U.office_engineer, () => rpc('decide_submittal', { submittal_id: SB, action: 'submit', transmittal_ref: 'TR-020' }));
  const rv0 = await one(`select rev, response_due - submitted_on d from submittal_revisions where submittal_id = $1`, [SB]);
  ok(sub0.rev === 0 && rv0.d === 14, 'submitted as rev 0, response due in 14 days');
  await expectError(as(U.office_engineer, () => rpc('decide_submittal', { submittal_id: SB, action: 'respond', code: 'C' })), /comments/, 'code C needs the reviewer\'s comments');
  await as(U.office_engineer, () => rpc('decide_submittal', { submittal_id: SB, action: 'respond', code: 'C', reviewer: 'MH', comments: 'Provide the test certificate (EN 13707)' }));
  ok((await one(`select status from submittals where id = $1`, [SB])).status === 'revise_resubmit', 'code C → revise & resubmit');
  ok((await inbox(U.office_engineer, P)).some((x) => x.entity_id === SB && /Revise and resubmit SUB-001/.test(x.title)), 'author asked to resubmit');
  const sub1 = await as(U.office_engineer, () => rpc('decide_submittal', { submittal_id: SB, action: 'submit' }));
  ok(sub1.rev === 1, 'resubmitted as rev 1');
  await as(U.office_engineer, () => rpc('decide_submittal', { submittal_id: SB, action: 'respond', code: 'A', reviewer: 'MH' }));
  ok((await one(`select status from submittals where id = $1`, [SB])).status === 'approved' && (await notes(U.procurement, /Material approved: SBS membrane/)).length === 1,
    'code A → approved; procurement told it can be ordered');
  const SB2 = uuid();
  await as(U.procurement, () => rpc('save_submittal', { id: SB2, project_id: P, title: 'Rebar mill certificates', kind: 'test_report' }));
  await as(U.office_engineer, () => rpc('decide_submittal', { submittal_id: SB2, action: 'submit', submitted_on: daysAgo(20) }));
  ok((await inbox(U.office_engineer, P)).some((x) => x.entity_id === SB2 && /Chase the review of SUB-002 rev 0.*\(6 d overdue\)/.test(x.title)), 'review 6 days overdue → chase');
  const reg = await one(`select days_overdue from v_submittal_register where id = $1`, [SB2]);
  ok(reg.days_overdue === 6, 'register shows 6 days overdue');

  console.log('\nMeetings & actions');
  const M = uuid();
  await expectError(as(U.coordinator, () => rpc('save_meeting', { id: M, project_id: P, title: 'Progress meeting 7', held_on: today(),
    actions: [{ description: 'x', owner_id: uuid() }] })), /not on this project/, 'action owners must be on the project');
  const m1 = await as(U.coordinator, () => rpc('save_meeting', { id: M, project_id: P, title: 'Progress meeting 7', held_on: today(), chaired_by: 'Resident engineer',
    attendees: 'Client, MH, contractor', minutes: '1. Slab pour programme agreed…', actions: [
      { description: 'Submit revised 3-week look-ahead', owner_id: U.site_engineer, due_date: daysAgo(1) },
      { description: 'Issue revised lift-pit drawing', owner_name: 'MH Engineering', due_date: today() }] }));
  ok(m1.number === 'MOM-001' && m1.actions === 2 && m1.status === 'draft', 'MOM-001 with 2 actions, draft');
  ok(!(await inbox(U.site_engineer, P)).some((x) => x.entity_type === 'meeting_action'), 'draft minutes put nothing in the owner\'s inbox');
  await as(U.coordinator, () => rpc('save_meeting', { id: M, project_id: P, title: 'Progress meeting 7', held_on: today(), issue: true }));
  const act = await one(`select id from meeting_actions where meeting_id = $1 and owner_id = $2`, [M, U.site_engineer]);
  ok((await notes(U.site_engineer, /Action from MOM-001/)).length === 1, 'owner notified when the minutes are issued');
  ib = await inbox(U.site_engineer, P);
  ok(ib.some((x) => x.entity_id === act.id && x.is_urgent && /Submit revised 3-week look-ahead/.test(x.title)), 'overdue action in the site engineer\'s inbox');
  await expectError(as(U.store_keeper, () => rpc('save_action_item', { id: act.id, project_id: P, action: 'done' })), /owner or the office/, 'someone else cannot close my action');
  await as(U.site_engineer, () => rpc('save_action_item', { id: act.id, project_id: P, action: 'done', note: 'Sent by email' }));
  ok((await one(`select status from meeting_actions where id = $1`, [act.id])).status === 'done' && !(await inbox(U.site_engineer, P)).some((x) => x.entity_id === act.id),
    'done by the owner, gone from the inbox');
  const SA = uuid();
  await as(U.office_engineer, () => rpc('save_action_item', { id: SA, project_id: P, description: 'Collect cube results from the lab', owner_id: U.store_keeper, due_date: today() }));
  ok((await inbox(U.store_keeper, P)).some((x) => x.entity_id === SA), 'standalone action reaches the store keeper\'s inbox');

  console.log('\nRisks');
  await expectError(as(U.store_keeper, () => rpc('save_risk', { id: uuid(), project_id: P, title: 'x' })), /not allowed/, 'store keeper cannot add risks');
  const RK = uuid();
  const rk = await as(U.site_engineer, () => rpc('save_risk', { id: RK, project_id: P, title: 'Cement shortage in rainy season', category: 'procurement',
    likelihood: 4, impact: 4, owner_id: U.coordinator, review_by: daysAgo(1), response_type: 'reduce', response: 'Stock 2 weeks ahead' }));
  ok(rk.number === 'R-001' && rk.score === 16, 'R-001 score 16');
  ok((await notes(U.manager, /High risk R-001/)).length === 1, 'manager told about a high risk');
  ok((await inbox(U.coordinator, P)).some((x) => x.entity_id === RK && /Review risk R-001/.test(x.title) && x.is_urgent), 'owner asked to review (review date passed)');
  await expectError(as(U.site_engineer, () => rpc('save_risk', { id: RK, project_id: P, title: 'x', status: 'closed' })), /owner or the office/, 'the raiser (not owner) cannot close it');
  await as(U.coordinator, () => rpc('save_risk', { id: RK, project_id: P, title: 'Cement shortage in rainy season', likelihood: 2, impact: 4, review_by: iso(new Date(Date.now() + 14 * 86400_000)), owner_id: U.coordinator }));
  ok(!(await inbox(U.coordinator, P)).some((x) => x.entity_id === RK), 'reviewed: next review in 2 weeks');

  console.log('\nEOT claims');
  const E = uuid();
  await expectError(as(U.site_engineer, () => rpc('save_eot_claim', { id: E, project_id: P, title: 'x', event_from: today() })), /not allowed/, 'site engineer cannot open a claim');
  const e1 = await as(U.office_engineer, () => rpc('save_eot_claim', { id: E, project_id: P, title: 'Late lift-pit drawings', cause: 'late_information',
    event_from: daysAgo(25), event_to: daysAgo(5) }));
  ok(e1.number === 'EOT-001' && e1.notice_due === iso(new Date(Date.parse(daysAgo(25)) + 28 * 86400_000)), `EOT-001, notice due ${e1.notice_due}`);
  ok((await inbox(U.coordinator, P)).some((x) => x.entity_id === E && /Send the delay notice for EOT-001/.test(x.title)), 'coordinator reminded: notice deadline in 3 days');
  const D2 = uuid(), D3 = uuid();
  await db.query(`insert into site_diaries (id, project_id, number, diary_date, status, created_by) values ($1, $2, 'G4-DY-2', $3, 'draft', $4), ($5, $2, 'G4-DY-3', $6, 'draft', $4)`,
    [D2, P, daysAgo(20), U.site_engineer, D3, daysAgo(12)]);
  await db.query(`insert into diary_delays (id, diary_id, project_id, cause, hours_lost) values ($1, $2, $3, 'design_info', 8), ($4, $5, $3, 'design_info', 4), ($6, $5, $3, 'rain', 16)`,
    [uuid(), D2, P, uuid(), D3, uuid()]);
  await db.query(`update site_diaries set status = 'submitted' where id in ($1, $2)`, [D2, D3]);
  const ev = await as(U.office_engineer, () => all(`select * from eot_delay_evidence($1, $2, $3)`, [P, daysAgo(25), daysAgo(5)]));
  const di = ev.find((x) => x.cause === 'design_info'), rain = ev.find((x) => x.cause === 'rain');
  ok(near(di?.days_lost, 1.5) && n(di?.diaries) === 2 && near(rain?.days_lost, 2), 'diary evidence: design info 1.5 days in 2 diaries, rain 2 days');
  await expectError(as(U.office_engineer, () => rpc('decide_eot_claim', { claim_id: E, action: 'send_notice' })), /not allowed/, 'office engineer cannot send the notice');
  await expectError(as(U.coordinator, () => rpc('decide_eot_claim', { claim_id: E, action: 'submit' })), /notice before/, 'detailed claim needs the notice first');
  const sn = await as(U.coordinator, () => rpc('decide_eot_claim', { claim_id: E, action: 'send_notice', notice_ref: 'LTR/G4/031' }));
  ok(sn.status === 'notice_sent' && sn.notice_late === false, 'notice sent in time');
  await expectError(as(U.coordinator, () => rpc('decide_eot_claim', { claim_id: E, action: 'submit' })), /days and\/or cost/, 'the detailed claim needs days or cost');
  await as(U.coordinator, () => rpc('decide_eot_claim', { claim_id: E, action: 'submit', days_claimed: 10, cost_claimed: 120000 }));
  await as(U.coordinator, () => rpc('decide_rfi', { rfi_id: R2, action: 'link', eot_claim_id: E }));
  ok(!(await inbox(U.coordinator, P)).some((x) => x.entity_id === R2), 'RFI-002 has its variation and EOT — off the list');
  const dec = await as(U.manager, () => rpc('decide_eot_claim', { claim_id: E, action: 'decide', days_granted: 6, cost_granted: 0, consultant_ref: 'MH/EOT/1' }));
  ok(dec.status === 'partly_granted', 'consultant granted 6 of 10 days → partly granted');
  const cd = await one(`select original_completion::text o, revised_completion::text r, days_granted from v_completion_dates where project_id = $1`, [P]);
  ok(cd.o === '2027-06-30' && cd.r === '2027-07-06' && n(cd.days_granted) === 6, `completion 30 Jun 2027 → ${cd.r}`);
  const E2 = uuid();
  await as(U.office_engineer, () => rpc('save_eot_claim', { id: E2, project_id: P, title: 'Late IPC 2 payment', cause: 'client_payment', event_from: daysAgo(40) }));
  const late = await as(U.manager, () => rpc('decide_eot_claim', { claim_id: E2, action: 'send_notice' }));
  ok(late.notice_late === true && (await inbox(U.manager, P)).some((x) => x.entity_id === E2 && /Submit the detailed claim EOT-002/.test(x.title)) === false,
    'notice after 28 days flagged late; particulars not due for 42 days');

  console.log('\nClient receivables & retention');
  await db.exec(`update app_settings set price_roles = array_append(price_roles, 'finance') where id = 1`);
  await db.query(`insert into client_contracts (project_id, contract_sum, retention_pct) values ($1, 25000000, 5)`, [P]);
  const I1 = uuid(), I2 = uuid();
  await db.query(`insert into client_ipcs (id, project_id, ipc_no, period_to, status, certified_on, certified, paid_amount, created_by)
    values ($1, $2, 1, $3, 'certified', $4, '{"payable": 1000000, "retention_cum": 50000}', 400000, $5)`, [I1, P, daysAgo(45), daysAgo(40), U.office_engineer]);
  await db.query(`insert into client_ipcs (id, project_id, ipc_no, period_to, status, submitted_at, claimed, created_by)
    values ($1, $2, 2, $3, 'submitted', now() - interval '3 days', '{"payable": 700000}', $4)`, [I2, P, daysAgo(5), U.office_engineer]);
  const rec = await as(U.finance, () => all(`select * from v_client_receivables where project_id = $1 order by ipc_no`, [P]));
  ok(rec.length === 2 && near(rec[0].outstanding, 600000) && rec[0].days_overdue === 12 && rec[0].bucket === '1_30' && rec[1].bucket === 'not_certified',
    `IPC 1: 600,000 outstanding, 12 days late (1–30); IPC 2 with the consultant (${rec.map((r) => r.bucket)})`);
  ok((await as(U.site_engineer, () => all(`select * from v_client_receivables where project_id = $1`, [P]))).length === 0, 'site engineer sees no receivables');
  ok((await inbox(U.finance, P)).some((x) => x.entity_type === 'client_ipc_due' && /Client payment overdue: IPC 1 — 600,000 ETB, 12 d late/.test(x.title)), 'finance inbox: IPC 1 overdue');
  ok(!(await inbox(U.site_engineer, P)).some((x) => x.entity_type === 'client_ipc_due'), 'not for the site engineer');
  await expectError(as(U.coordinator, () => rpc('save_retention_release', { project_id: P, stage: 'practical_completion' })), /practical completion date first/, 'release needs the completion date');
  await expectError(as(U.office_engineer, () => rpc('save_contract_completion', { project_id: P, practical_completion_on: daysAgo(10) })), /not allowed|prices/, 'office engineer cannot set completion');
  await as(U.coordinator, () => rpc('save_contract_completion', { project_id: P, practical_completion_on: daysAgo(10), dlp_months: 12 }));
  const rs = await as(U.coordinator, () => one(`select * from v_retention_status where project_id = $1`, [P]));
  ok(near(rs.held, 50000) && near(rs.pc_release_amount, 25000) && rs.pc_release_due === true && rs.final_release_due === false, 'held 50,000; half (25,000) due at practical completion');
  ok((await inbox(U.coordinator, P)).some((x) => x.entity_type === 'retention_release' && /practical completion \(25,000 ETB\)/.test(x.title)), 'coordinator asked to request the release');
  await expectError(as(U.finance, () => rpc('save_retention_release', { project_id: P, stage: 'practical_completion' })), /request retention/, 'finance does not request releases');
  await as(U.coordinator, () => rpc('save_retention_release', { id: uuid(), project_id: P, stage: 'practical_completion', ref: 'LTR/G4/040' }));
  await expectError(as(U.coordinator, () => rpc('save_retention_release', { project_id: P, stage: 'final' })), /defects liability period ends/, 'final release waits for the end of the DLP');
  await expectError(as(U.coordinator, () => rpc('save_retention_release', { project_id: P, stage: 'practical_completion', received_amount: 25000 })), /Finance or the manager/, 'coordinator cannot record money received');
  const rr = await as(U.finance, () => rpc('save_retention_release', { project_id: P, stage: 'practical_completion', certified_on: daysAgo(2), received_on: today(), received_amount: 25000 }));
  ok(rr.status === 'received' && near(rr.amount, 25000), 'finance records 25,000 received');
  const rs2 = await as(U.coordinator, () => one(`select still_held, pc_release_due from v_retention_status where project_id = $1`, [P]));
  ok(near(rs2.still_held, 25000) && rs2.pc_release_due === false, '25,000 still held until the end of the DLP');

  console.log('\nPortfolio & access');
  const pf = await as(U.manager, () => one(`select * from v_office_portfolio where project_id = $1`, [P]));
  ok(n(pf.rfis_open) === 1 && n(pf.sis_open) === 0 && n(pf.submittals_pending) === 1 && n(pf.claims_open) === 1 && pf.revised_completion,
    `portfolio: 1 RFI open, 1 submittal pending, 1 claim open (${pf.rfis_open}/${pf.submittals_pending}/${pf.claims_open})`);
  const P2 = uuid();
  await as(U.admin, () => db.query(`insert into projects (id, code, name) values ($1, 'OTHER', 'Other project')`, [P2]));
  ok((await as(U.manager, () => all(`select * from v_office_portfolio where project_id = $1`, [P2]))).length === 0, 'only my projects in the portfolio');
  ok((await as(U.store_keeper, () => one(`select count(*)::int c from rfis where project_id = $1`, [P]))).c === 3, 'every member can read the RFI register');
  await expectError(as(U.coordinator, () => db.query(`insert into rfis (id, project_id, number, subject, description, raised_on, created_by) values ($1, $2, 'X', 'x', 'x', now(), $3)`, [uuid(), P, U.coordinator])),
    /row-level security|permission/, 'no direct writes — only through the functions');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
