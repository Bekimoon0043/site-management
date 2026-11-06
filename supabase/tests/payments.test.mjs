// Payments test (migrations 20261103000001_finance_enums.sql + 20261103000010_payments.sql). Applies ALL migrations
// + seed in PGlite with the Supabase stubs used by the other suites.
//
// Scenario: a schedule with BoQ columns is imported; a subcontract for excavation + clearing is paid through two
// interim certificates (claimed vs verified quantities, retention, advance recovery, VAT, 3 % WHT, final release)
// along office engineer → coordinator → manager → finance; a daily-labour payroll from the attendance register
// (15 % / 30 % tax, overtime, deductions) follows the same chain; actual cost is posted; access rules.
//
//   node supabase/tests/payments.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const MINE = '20261103000010_payments.sql';
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
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper', 'finance']) {
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
  const exc = await task(3), clear = await task(4);
  const link = await one(`select boq_item_id from task_boq_links where task_id = $1`, [exc.id]);
  const clearLink = await one(`select boq_item_id from task_boq_links where task_id = $1`, [clear.id]);
  const cnt = async (sql, params = []) => (await one(sql, params)).c;

  // =====================================================================
  console.log('\nSite progress the office engineer verifies (reference for the certificate)');
  const D1 = '2026-10-30';
  const o1 = await as(U.site_engineer, () => rpc('report_daily_output', { op_id: uuid(), id: uuid(), task_id: exc.id, date: D1,
    output: [{ boq_item_id: link.boq_item_id, qty_today: 300 }], headcount: 10, labour_hours: 80, diary_number: 'APT-SD-W1-0001' }));
  await as(U.office_engineer, () => rpc('verify_task_progress', { op_id: uuid(), progress_id: o1.task_progress_id, approve: true }));
  ok(n((await one(`select verified_qty q from task_boq_links where task_id = $1`, [exc.id])).q) === 300, 'excavation verified 300 m3 on site');

  // =====================================================================
  console.log('\nSubcontractor register and subcontract');
  const oe = (name, p) => as(U.office_engineer, () => rpc(name, { op_id: uuid(), ...p }));
  await expectError(oe('save_subcontractor', { name: 'Abay Earthworks PLC', tin: '12345' }), /TIN must be 10 digits/, 'TIN is validated');
  const SUBC = uuid();
  await oe('save_subcontractor', { id: SUBC, name: 'Abay Earthworks PLC', trade: 'Earthworks', tin: '0012345678', vat_registered: true,
    bank_name: 'Commercial Bank of Ethiopia', bank_account: '1000123456789' });
  await expectError(oe('save_subcontractor', { name: 'Abay Earthworks PLC' }), /already exists/, 'duplicate subcontractor name refused');
  await expectError(as(U.site_engineer, () => rpc('save_subcontractor', { op_id: uuid(), name: 'X' })), /not allowed/, 'site engineer cannot register subcontractors');
  const SC = uuid(), IT1 = uuid(), IT2 = uuid();
  const r0 = await oe('save_subcontract', { id: SC, project_id: P, subcontractor_id: SUBC, title: 'Bulk excavation and site clearing',
    retention_pct: 5, advance_amount: 20000, advance_recovery_pct: 20,
    items: [{ id: IT1, boq_item_id: link.boq_item_id, task_id: exc.id, description: 'Bulk excavation', unit: 'm3', qty: 850, rate: 150 },
            { id: IT2, boq_item_id: clearLink.boq_item_id, task_id: clear.id, description: 'Site clearing', unit: 'm2', qty: 1200, rate: 20 }] });
  ok(r0.number === 'APT-SUB-0001', `subcontract numbered ${r0.number}`);
  const vs = await one(`select * from v_subcontracts where id = $1`, [SC]);
  ok(n(vs.contract_value) === 151500 && n(vs.vat_pct) === 15 && n(vs.wht_pct) === 3, 'contract value 151,500; VAT 15 % (VAT-registered); WHT 3 %');

  // =====================================================================
  console.log('\nInterim payment certificate 1 — quantities claimed vs verified');
  const C1 = uuid();
  const cert = (p) => oe('save_sc_certificate', { subcontract_id: SC, period_from: '2026-10-01', period_to: '2026-10-31', ...p });
  await expectError(cert({ id: C1, lines: [{ subcontract_item_id: IT1, qty_claimed_to_date: 300, qty_verified_to_date: 320 }] }),
    /more than claimed/, 'verified cannot exceed claimed');
  await expectError(cert({ id: C1, lines: [{ subcontract_item_id: IT1, qty_claimed_to_date: 900, qty_verified_to_date: 900 }] }),
    /more than the contract quantity/, 'over the contract quantity needs a remark');
  const c1 = await cert({ id: C1, lines: [{ subcontract_item_id: IT1, qty_claimed_to_date: 350, qty_verified_to_date: 300 },
                                        { subcontract_item_id: IT2, qty_claimed_to_date: 1200, qty_verified_to_date: 1000 }] });
  const h1 = await one(`select * from sc_certificates where id = $1`, [C1]);
  ok(c1.number === 'APT-SUB-0001-IPC01' && h1.status === 'draft', `certificate ${c1.number} drafted`);
  ok(n(h1.gross_this) === 65000 && n(h1.retention_this) === 3250 && n(h1.advance_recovery_this) === 13000
     && n(h1.vat_this) === 9750 && n(h1.wht_this) === 1950, 'gross 65,000 · retention 3,250 · advance 13,000 · VAT 9,750 · WHT 1,950');
  ok(n(h1.net_payable) === 56550, `net payable 56,550 (${h1.net_payable})`);
  const l1 = await one(`select * from sc_certificate_lines where certificate_id = $1 and subcontract_item_id = $2`, [C1, IT1]);
  ok(n(l1.site_qty_to_date) === 300, 'site reference: 300 m3 verified progress on the task');
  await expectError(oe('save_sc_certificate', { id: uuid(), subcontract_id: SC, period_from: '2026-10-01', period_to: '2026-10-31', lines: [] }),
    /already has a certificate in progress/, 'one certificate in progress per subcontract');

  console.log('\nApproval chain');
  const act = (who, p) => as(U[who], () => rpc('payment_action', { op_id: uuid(), doc_type: 'sc_certificate', id: C1, ...p }));
  await expectError(act('coordinator', { action: 'check' }), /only submitted/, 'cannot check a draft');
  await act('office_engineer', { action: 'submit' });
  const inboxC = await as(U.coordinator, () => all(`select * from v_my_approvals where kind = 'payment'`));
  ok(inboxC.length === 1 && inboxC[0].entity_id === C1 && inboxC[0].actions[0] === 'check', 'coordinator inbox: certificate to check');
  ok((await as(U.manager, () => all(`select * from v_my_approvals where kind = 'payment'`))).length === 0, 'not yet in the manager inbox');
  await expectError(act('office_engineer', { action: 'check' }), /not allowed/, 'office engineer cannot check');
  await expectError(act('manager', { action: 'approve' }), /checked by the coordinator first/, 'manager cannot approve before the check');
  await act('coordinator', { action: 'check' });
  await expectError(act('finance', { action: 'approve' }), /not allowed/, 'finance cannot approve');
  const opId = uuid();
  const a1 = await as(U.manager, () => rpc('payment_action', { op_id: opId, doc_type: 'sc_certificate', id: C1, action: 'approve' }));
  const a2 = await as(U.manager, () => rpc('payment_action', { op_id: opId, doc_type: 'sc_certificate', id: C1, action: 'approve' }));
  ok(a1.status === 'approved' && a2.status === 'approved', 'manager approves (retry is idempotent)');
  const ce = await all(`select * from cost_entries where source_ref = $1 order by number`, [c1.number]);
  ok(ce.length === 2 && n(ce[0].amount) === 45000 && n(ce[1].amount) === 20000 && ce[0].category === 'subcontract' && ce[0].task_id === exc.id,
    'approval posts actual cost per line (45,000 on excavation, 20,000 on clearing)');
  ok((await as(U.finance, () => all(`select * from v_my_approvals where kind = 'payment'`))).some((r) => r.entity_id === C1 && r.actions[0] === 'pay'), 'finance inbox: to pay');
  await expectError(act('finance', { action: 'pay', payment_method: 'bank_transfer', payment_date: '2026-11-02' }), /reference/, 'bank transfer needs a reference');
  await act('finance', { action: 'pay', payment_method: 'bank_transfer', payment_ref: 'CBE-TRF-889201', payment_date: '2026-11-02' });
  const p1 = await one(`select * from sc_certificates where id = $1`, [C1]);
  ok(p1.status === 'paid' && p1.paid_by === U.finance && p1.payment_ref === 'CBE-TRF-889201', 'finance records the payment');
  ok(await cnt(`select count(*)::int c from payment_events where doc_id = $1`, [C1]) === 5, 'history: prepare, submit, check, approve, pay');
  ok(await cnt(`select count(*)::int c from notifications where entity_id = $1 and user_id = $2`, [C1, U.finance]) >= 1, 'finance was notified');

  console.log('\nCertificate 2 (final): return, fix, retention release, advance fully recovered');
  const C2 = uuid();
  await expectError(oe('save_sc_certificate', { id: C2, subcontract_id: SC, period_from: '2026-10-15', period_to: '2026-11-01', lines: [] }),
    /must start after/, 'periods cannot overlap an approved certificate');
  const c2p = { id: C2, subcontract_id: SC, period_from: '2026-11-01', period_to: '2026-11-02', is_final: true,
    lines: [{ subcontract_item_id: IT1, qty_claimed_to_date: 400, qty_verified_to_date: 400 }, { subcontract_item_id: IT2, qty_claimed_to_date: 1000, qty_verified_to_date: 1000 }] };
  await oe('save_sc_certificate', c2p);
  const h2 = await one(`select * from sc_certificates where id = $1`, [C2]);
  ok(n(h2.gross_previous) === 65000 && n(h2.gross_this) === 15000, 'previous 65,000 → this period 15,000');
  ok(n(h2.advance_recovery_this) === 7000 && n(h2.retention_release) === 4000, 'final: rest of the advance (7,000) recovered, retention 4,000 released');
  ok(n(h2.net_payable) === 15000 + 2250 - 750 + 4000 - 7000 - 450, `net ${h2.net_payable}`);
  const act2 = (who, p) => as(U[who], () => rpc('payment_action', { op_id: uuid(), doc_type: 'sc_certificate', id: C2, ...p }));
  await act2('office_engineer', { action: 'submit' });
  await expectError(act2('coordinator', { action: 'return' }), /Say why/, 'return needs a reason');
  await act2('coordinator', { action: 'return', comment: 'Attach the measurement sheet' });
  ok((await as(U.office_engineer, () => all(`select * from v_my_approvals where kind = 'payment'`))).some((r) => r.entity_id === C2 && r.actions[0] === 'fix'), 'returned certificate is back in the preparer inbox');
  await oe('save_sc_certificate', { ...c2p, remarks: 'Measurement sheet MS-02 attached' });
  await act2('office_engineer', { action: 'submit' });
  await act2('coordinator', { action: 'check' });
  await act2('manager', { action: 'approve' });
  await act2('finance', { action: 'pay', payment_method: 'cheque', payment_ref: 'CHQ 004512', payment_date: '2026-11-02' });
  const v2 = await one(`select * from v_subcontracts where id = $1`, [SC]);
  ok(n(v2.certified_to_date) === 80000 && n(v2.retention_held) === 0 && n(v2.advance_recovered) === 20000, 'statement: certified 80,000 · retention released · advance recovered');
  await expectError(oe('save_subcontract', { id: SC, project_id: P, subcontractor_id: SUBC, title: 'x',
    items: [{ id: IT1, description: 'Bulk excavation', unit: 'm3', qty: 850, rate: 160 }, { id: IT2, description: 'Site clearing', unit: 'm2', qty: 1200, rate: 20 }] }),
    /rate has been certified/, 'certified rates are locked');

  console.log('\nSegregation of duties');
  const SC2 = uuid(), IT3 = uuid(), C3 = uuid();
  await as(U.coordinator, () => rpc('save_subcontract', { op_id: uuid(), id: SC2, project_id: P, subcontractor_id: SUBC, title: 'Rebar fixing',
    items: [{ id: IT3, description: 'Rebar fixing', unit: 'kg', qty: 5000, rate: 12 }] }));
  await as(U.coordinator, () => rpc('save_sc_certificate', { op_id: uuid(), id: C3, subcontract_id: SC2, period_from: '2026-10-01', period_to: '2026-10-31',
    lines: [{ subcontract_item_id: IT3, qty_claimed_to_date: 2000, qty_verified_to_date: 2000 }] }));
  const h3 = await one(`select * from sc_certificates where id = $1`, [C3]);
  ok(n(h3.vat_this) === 3600 && n(h3.wht_this) === 720, 'second certificate: 24,000 → VAT 3,600, WHT 720');
  await as(U.coordinator, () => rpc('payment_action', { op_id: uuid(), doc_type: 'sc_certificate', id: C3, action: 'submit' }));
  await expectError(as(U.coordinator, () => rpc('payment_action', { op_id: uuid(), doc_type: 'sc_certificate', id: C3, action: 'check' })),
    /another person must check/, 'the preparer cannot check their own certificate');
  await as(U.manager, () => rpc('payment_action', { op_id: uuid(), doc_type: 'sc_certificate', id: C3, action: 'reject', comment: 'Not our scope' }));
  ok((await one(`select status from sc_certificates where id = $1`, [C3])).status === 'rejected', 'manager can reject');

  // =====================================================================
  console.log('\nDaily labour payroll');
  const W = { a: uuid(), b: uuid(), c: uuid() };
  await oe('save_labour_worker', { id: W.a, project_id: P, full_name: 'Kebede Ayele', trade_name: 'Daily labourer', daily_rate: 400, tin: '0098765432' });
  await oe('save_labour_worker', { id: W.b, project_id: P, full_name: 'Almaz Tesfaye', trade_name: 'Mason helper', daily_rate: 350, tax_pct: 30 });
  await oe('save_labour_worker', { id: W.c, project_id: P, full_name: 'Tadesse Bekele', trade_name: 'Carpenter', daily_rate: 500 });
  await expectError(oe('save_labour_worker', { project_id: P, full_name: 'X' }), /daily rate/, 'daily rate required (0 allowed for piece-rate)');
  const days = (from, k) => Array.from({ length: k }, (_, i) => { const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
  const wk = days('2026-10-26', 7);
  const PR = uuid();
  const att = [
    ...wk.slice(0, 6).map((d) => ({ worker_id: W.a, work_date: d, day_value: 1, task_id: exc.id })),
    ...wk.slice(0, 5).map((d) => ({ worker_id: W.b, work_date: d, day_value: 1 })), { worker_id: W.b, work_date: wk[5], day_value: 0.5, ot_hours: 2 },
    ...wk.slice(0, 3).map((d) => ({ worker_id: W.c, work_date: d, day_value: 1 })),
  ];
  await expectError(oe('save_payroll', { id: uuid(), project_id: P, period_from: '2026-11-01', period_to: '2026-11-05', attendance: [] }), /future/, 'no future payroll periods');
  const pr = await oe('save_payroll', { id: PR, project_id: P, period_from: '2026-10-26', period_to: '2026-11-01', frequency: 'weekly', tax_pct: 15,
    attendance: att, deductions: [{ worker_id: W.c, other_deduction: 100, deduction_note: 'Advance' }] });
  ok(pr.number === 'APT-PAY-0001' && pr.workers === 3, `payroll ${pr.number} with 3 workers`);
  const pl = Object.fromEntries((await all(`select * from labour_payroll_lines where payroll_id = $1`, [PR])).map((r) => [r.worker_id, r]));
  ok(n(pl[W.a].gross) === 2400 && n(pl[W.a].tax) === 360 && n(pl[W.a].net) === 2040, 'Kebede: 6 days × 400 = 2,400, 15 % tax 360');
  ok(n(pl[W.b].days) === 5.5 && n(pl[W.b].ot_amount) === 109.38 && n(pl[W.b].gross) === 2034.38 && n(pl[W.b].tax_pct) === 30 && n(pl[W.b].tax) === 610.31,
    'Almaz: 5.5 days + 2 h OT (×1.25) = 2,034.38, 30 % tax (no TIN) 610.31');
  ok(n(pl[W.c].net) === 1500 - 225 - 100, 'Tadesse: 1,500 − 225 tax − 100 advance');
  const tot = await one(`select * from labour_payrolls where id = $1`, [PR]);
  ok(n(tot.gross) === 5934.38 && n(tot.net) === n(tot.gross) - n(tot.tax) - 100, `payroll totals gross ${tot.gross}, net ${tot.net}`);
  await expectError(oe('save_payroll', { id: uuid(), project_id: P, period_from: '2026-10-30', period_to: '2026-11-01',
    attendance: [{ worker_id: W.a, work_date: '2026-10-30', day_value: 1 }] }), /Already on another payroll/, 'a worker is paid once per day');
  await expectError(oe('save_payroll', { id: PR, project_id: P, period_from: '2026-10-26', period_to: '2026-11-01',
    attendance: [{ worker_id: W.a, work_date: '2026-11-05', day_value: 1 }] }), /outside the payroll period/, 'attendance inside the period');

  console.log('\nBerga (12 m rebar bar) and piece-rate work');
  const d12 = await one(`select s.id, c.factor from material_specs s join materials m on m.id = s.material_id
                         join spec_conversions c on c.material_spec_id = s.id and c.alt_uom = 'berga' where s.grade = 'S-400 Ø12'`);
  ok(d12 && n(d12.factor) === 10.67, `Ø12: 1 berga = ${d12?.factor} kg`);
  const rebar = await one(`select id from materials where name = 'Rebar'`);
  const S32 = uuid();
  await db.query(`insert into material_specs (id, material_id, grade, uom) values ($1, $2, 'S-500 Ø28', 'kg')`, [S32, rebar.id]);
  ok(n((await one(`select factor from spec_conversions where material_spec_id = $1 and alt_uom = 'berga'`, [S32])).factor) === 58.07, 'new rebar spec Ø28 gets 1 berga = 58.07 kg automatically');
  ok(n((await one(`select c.factor from material_specs s join spec_conversions c on c.material_spec_id = s.id and c.alt_uom = 'berga' where s.grade = 'S-500 Ø32'`)).factor) === 75.85, 'existing Ø32 spec: 1 berga = 75.85 kg');
  W.d = uuid();
  await oe('save_labour_worker', { id: W.d, project_id: P, full_name: 'Getu Alemu (rebar crew)', trade_name: 'Bar bender', daily_rate: 0, tin: '0011223344' });
  const PW1 = uuid(), PW2 = uuid();
  const piece = [{ id: PW1, worker_id: W.d, work_date: '2026-10-29', description: 'Cut & bend Ø12 for raft', unit: 'berga', qty_claimed: 40, rate: 25,
                   material_spec_id: d12.id, task_id: exc.id },
                 { id: PW2, worker_id: W.a, work_date: '2026-10-30', description: 'Blinding concrete', unit: 'm2', qty_claimed: 20, rate: 30, boq_item_id: clearLink.boq_item_id }];
  await expectError(oe('save_payroll', { id: PR, project_id: P, period_from: '2026-10-26', period_to: '2026-11-01',
    piecework: [{ worker_id: W.d, work_date: '2026-10-29', description: 'x', unit: 'berga', qty_claimed: 1, rate: 1 }] }), /bar diameter/, 'berga work needs the bar diameter');
  await oe('save_payroll', { id: PR, project_id: P, period_from: '2026-10-26', period_to: '2026-11-01', piecework: piece });
  ok(n((await one(`select gross from labour_payrolls where id = $1`, [PR])).gross) === 5934.38, 'unverified piece-work is not paid yet');
  const pa = (who, p) => as(U[who], () => rpc('payment_action', { op_id: uuid(), doc_type: 'payroll', id: PR, ...p }));
  await expectError(pa('office_engineer', { action: 'submit' }), /must be verified/, 'cannot submit before quantities are verified');
  await expectError(as(U.site_engineer, () => rpc('verify_piecework', { op_id: uuid(), payroll_id: PR, lines: [{ id: PW1, qty_verified: 45 }] })),
    /more than claimed/, 'verified berga cannot exceed claimed');
  await as(U.site_engineer, () => rpc('verify_piecework', { op_id: uuid(), payroll_id: PR, lines: [{ id: PW1, qty_verified: 38, remark: '2 bars short' }, { id: PW2, qty_verified: 20 }] }));
  const pw = await one(`select * from labour_piecework where id = $1`, [PW1]);
  ok(n(pw.amount) === 950 && n(pw.kg_equivalent) === 405.46 && pw.verified_by === U.site_engineer, 'site engineer verified 38 berga = 950 ETB (405.46 kg)');
  await oe('save_payroll', { id: PR, project_id: P, period_from: '2026-10-26', period_to: '2026-11-01', piecework: piece });
  ok((await one(`select qty_verified from labour_piecework where id = $1`, [PW1])).qty_verified != null, 'verification kept when the line is unchanged');
  const ld = await one(`select * from labour_payroll_lines where payroll_id = $1 and worker_id = $2`, [PR, W.d]);
  ok(n(ld.piece_amount) === 950 && n(ld.days) === 0 && n(ld.tax) === 142.5, 'crew leader paid by the piece: 950, 15 % tax 142.50');
  const tot2 = await one(`select * from labour_payrolls where id = $1`, [PR]);
  ok(n(tot2.gross) === 5934.38 + 950 + 600 && tot2.workers === 4, `payroll gross with piece-work ${tot2.gross}`);
  await pa('office_engineer', { action: 'submit' });
  await pa('coordinator', { action: 'check' });
  await pa('manager', { action: 'approve' });
  const lc = await all(`select * from cost_entries where source_ref = $1 order by number`, [pr.number]);
  const sumLc = lc.reduce((s, r) => s + n(r.amount), 0);
  ok(lc.some((r) => r.task_id === exc.id && n(r.amount) === 2400) && lc.some((r) => r.uom === 'berga' && n(r.amount) === 950 && r.task_id === exc.id)
     && Math.abs(sumLc - n(tot2.gross)) < 0.05 && lc.every((r) => r.category === 'labour'),
    `labour cost = gross (${sumLc.toFixed(2)}): piece-work and attendance on their tasks, the rest by daily-output manpower`);
  await expectError(oe('save_payroll', { id: PR, project_id: P, period_from: '2026-10-26', period_to: '2026-11-01', attendance: att }), /cannot be edited/, 'approved payroll is locked');
  await pa('finance', { action: 'pay', payment_method: 'cash', payment_date: '2026-11-02' });
  ok((await one(`select status from labour_payrolls where id = $1`, [PR])).status === 'paid', 'payroll paid in cash');

  console.log('\nAccess');
  ok((await as(U.site_engineer, () => one(`select count(*)::int c from sc_certificates`))).c === 0, 'site engineer cannot read certificates');
  ok((await as(U.store_keeper, () => one(`select count(*)::int c from labour_payroll_lines`))).c === 0, 'store keeper cannot read payroll');
  ok((await as(U.site_engineer, () => one(`select count(*)::int c from labour_piecework`))).c === 2 && (await as(U.site_engineer, () => one(`select count(*)::int c from labour_payroll_lines`))).c === 0,
    'site engineer reads the piece-work lines to verify, not the pay lines');
  ok((await as(U.site_engineer, () => one(`select count(*)::int c from subcontractors`))).c === 0, 'site engineer cannot read subcontractor bank details');
  ok((await as(U.finance, () => one(`select count(*)::int c from v_payment_register`))).c === 4, 'finance sees the payment register (3 certificates + 1 payroll)');
  ok((await as(U.finance, () => one(`select count(*)::int c from cost_entries`))).c > 0, 'finance sees costs (price role)');
  await expectError(as(U.site_engineer, () => rpc('payment_action', { op_id: uuid(), doc_type: 'payroll', id: PR, action: 'pay', payment_method: 'cash', payment_date: '2026-11-02' })),
    /not allowed|only approved/, 'site engineer cannot pay');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
