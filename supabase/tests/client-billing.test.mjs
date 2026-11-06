// Client billing test (migration 20261103000060_client_billing.sql): contract terms, interim payment certificates
// (verified quantities → claimed → checked → submitted → certified with consultant changes → paid), the next IPC
// building on the certified one, variations into the BoQ, inbox items and price-gated access.
//
//   node supabase/tests/client-billing.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const MINE = '20261103000060_client_billing.sql';
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
  const exc = await task(3), slab = await task(7);
  const lk = async (t) => (await one(`select boq_item_id from task_boq_links where task_id = $1`, [t.id])).boq_item_id;
  const excB = await lk(exc), slabB = await lk(slab);
  const progress = async (t, b, q, d) => {
    const id = uuid();
    await as(U.site_engineer, () => rpc('report_task_progress', { op_id: uuid(), id, task_id: t.id, status_date: d, qty: [{ boq_item_id: b, qty_to_date: q }] }));
    await as(U.office_engineer, () => rpc('verify_task_progress', { op_id: uuid(), progress_id: id, approve: true }));
  };
  await progress(exc, excB, 300, '2026-10-20');
  await progress(slab, slabB, 100, '2026-10-25');

  console.log('\nContract terms');
  const sum = n((await one(`select sum(b.quantity * r.rate) s from boq_items b join boq_rates r on r.boq_item_id = b.id where b.project_id = $1`, [P])).s);
  ok(near(sum, 10493000), `BoQ ex-VAT total ${sum}`);
  await expectError(as(U.office_engineer, () => rpc('save_client_contract', { op_id: uuid(), project_id: P, contract_sum: sum })), /not allowed/, 'office engineer cannot set the contract terms');
  await as(U.coordinator, () => rpc('save_client_contract', { op_id: uuid(), project_id: P, contract_no: 'AA/HRE/2026/014', client_name: 'Habesha Real Estate PLC',
    consultant_name: 'MH Engineering', contract_sum: sum, advance_amount: 1049300, retention_pct: 5, retention_limit_pct: 5, mos_pct: 80, wht_pct: 3 }));
  const cc = await one(`select * from client_contracts where project_id = $1`, [P]);
  ok(n(cc.advance_recovery_pct) === 10 && n(cc.vat_pct) === 15, `advance recovery defaults to the advance share (${cc.advance_recovery_pct} %)`);

  console.log('\nIPC 1');
  const IPC1 = uuid();
  await expectError(as(U.office_engineer, () => rpc('save_client_ipc', { op_id: uuid(), id: IPC1, project_id: P, period_to: '2026-10-31' })),
    /access to prices/, 'office engineer without price access cannot prepare an IPC');
  await db.exec(`update app_settings set price_roles = array_append(price_roles, 'office_engineer') where id = 1`);
  const s1 = await as(U.office_engineer, () => rpc('save_client_ipc', { op_id: uuid(), id: IPC1, project_id: P, period_to: '2026-10-31', mos_value: 100000 }));
  ok(s1.ipc_no === 1 && s1.status === 'draft', 'IPC 1 drafted by the office engineer (QS)');
  const l1 = await all(`select * from client_ipc_lines where ipc_id = $1 order by item_no`, [IPC1]);
  ok(l1.length === 2 && n(l1.find((x) => x.boq_item_id === excB).cum_qty) === 300 && n(l1.find((x) => x.boq_item_id === slabB).cum_qty) === 100,
    'lines default to verified progress (300 m3 excavation, 100 m3 mat slab)');
  const c1 = s1.claimed;
  ok(near(c1.work_cum, 704000) && near(c1.mos, 80000) && near(c1.value_cum, 784000) && near(c1.retention_this, 39200) && near(c1.advance_this, 70400),
    `work 704,000 + MoS 80 % of 100,000; retention 5 % of (1−2); advance 10 % of work (${c1.value_cum}/${c1.retention_this}/${c1.advance_this})`);
  ok(near(c1.total_deduction, 39200) && near(c1.net_before_advance, 744800) && near(c1.net_after_advance, 674400)
    && near(c1.wht, 23520) && near(c1.vat, 117600) && near(c1.payable, 768480),
    `744,800 − advance 70,400 − WHT 3 % 23,520 + VAT 15 % 117,600 = ${c1.payable}`);
  const s1b = await as(U.office_engineer, () => rpc('save_client_ipc', { op_id: uuid(), id: IPC1, project_id: P, lines: [{ boq_item_id: excB, cum_qty: 320 }] }));
  ok(near(s1b.claimed.work_cum, 707600) && (await one(`select remeasured from client_ipc_lines where ipc_id = $1 and boq_item_id = $2`, [IPC1, excB])).remeasured,
    're-measured excavation 320 m3 is kept and flagged');
  await as(U.office_engineer, () => rpc('save_client_ipc', { op_id: uuid(), id: IPC1, project_id: P, refresh: true }));
  ok(n((await one(`select cum_qty from client_ipc_lines where ipc_id = $1 and boq_item_id = $2`, [IPC1, excB])).cum_qty) === 320, 'refresh keeps the re-measured quantity');
  await expectError(as(U.office_engineer, () => rpc('save_client_ipc', { op_id: uuid(), id: uuid(), project_id: P, period_to: '2026-11-01' })),
    /still being prepared/, 'only one IPC in preparation at a time');
  await as(U.office_engineer, () => rpc('save_client_ipc', { op_id: uuid(), id: IPC1, project_id: P, prepare: true }));
  const inboxC = await as(U.coordinator, () => all(`select * from v_my_approvals where entity_id = $1`, [IPC1]));
  ok(inboxC.length === 1 && /Check payment certificate/.test(inboxC[0].title), `coordinator's inbox: "${inboxC[0]?.title}"`);
  await expectError(as(U.office_engineer, () => rpc('save_client_ipc', { op_id: uuid(), id: IPC1, project_id: P, mos_value: 1 })), /prepared/, 'a prepared IPC is locked');
  await expectError(as(U.coordinator, () => rpc('decide_client_ipc', { op_id: uuid(), ipc_id: IPC1, action: 'return' })), /correcting/, 'return needs a comment');
  await as(U.coordinator, () => rpc('decide_client_ipc', { op_id: uuid(), ipc_id: IPC1, action: 'return', comment: 'Attach MoS delivery notes' }));
  ok((await one(`select status, return_comment from client_ipcs where id = $1`, [IPC1])).status === 'draft', 'returned to draft with a comment');
  await as(U.office_engineer, () => rpc('save_client_ipc', { op_id: uuid(), id: IPC1, project_id: P, prepare: true }));
  await expectError(as(U.manager, () => rpc('decide_client_ipc', { op_id: uuid(), ipc_id: IPC1, action: 'submit' })), /checked by the coordinator/, 'manager cannot submit before the check');
  await as(U.coordinator, () => rpc('decide_client_ipc', { op_id: uuid(), ipc_id: IPC1, action: 'check' }));
  ok((await as(U.manager, () => all(`select * from v_my_approvals where entity_id = $1`, [IPC1]))).length === 1, 'manager inbox shows the checked IPC');
  await expectError(as(U.coordinator, () => rpc('decide_client_ipc', { op_id: uuid(), ipc_id: IPC1, action: 'submit' })), /not allowed/, 'coordinator cannot submit to the client');
  await as(U.manager, () => rpc('decide_client_ipc', { op_id: uuid(), ipc_id: IPC1, action: 'submit' }));
  await expectError(as(U.office_engineer, () => rpc('decide_client_ipc', { op_id: uuid(), ipc_id: IPC1, action: 'certify' })), /not allowed/, 'office engineer cannot record the certification');
  const cert = await as(U.coordinator, () => rpc('decide_client_ipc', { op_id: uuid(), ipc_id: IPC1, action: 'certify', consultant_ref: 'MH/IPC/01',
    certified_lines: [{ boq_item_id: slabB, cum_qty: 95 }], certified_mos_value: 90000 }));
  const ct = cert.certified;
  ok(cert.status === 'certified' && near(ct.work_cum, 57600 + 617500) && near(ct.mos, 72000), `consultant cut the slab to 95 m3 and MoS to 90,000 (work ${ct.work_cum})`);
  await expectError(as(U.site_engineer, () => rpc('decide_client_ipc', { op_id: uuid(), ipc_id: IPC1, action: 'pay', amount: 1 })), /not allowed/, 'site engineer cannot record payments');
  const p1 = await as(U.manager, () => rpc('decide_client_ipc', { op_id: uuid(), ipc_id: IPC1, action: 'pay', amount: 500000, payment_ref: 'CBE TT 778' }));
  ok(p1.status === 'certified' && n(p1.paid_amount) === 500000, 'part payment keeps it open');
  const p2 = await as(U.manager, () => rpc('decide_client_ipc', { op_id: uuid(), ipc_id: IPC1, action: 'pay', amount: n(ct.payable) - 500000 }));
  ok(p2.status === 'paid', `paid in full (${ct.payable})`);

  console.log('\nIPC 2 builds on the certified IPC 1');
  await progress(exc, excB, 500, '2026-11-01');
  await expectError(as(U.office_engineer, () => rpc('save_client_ipc', { op_id: uuid(), id: uuid(), project_id: P, period_to: '2026-10-30' })), /after IPC 1/, 'period must end after IPC 1');
  const IPC2 = uuid();
  const s2 = await as(U.office_engineer, () => rpc('save_client_ipc', { op_id: uuid(), id: IPC2, project_id: P, period_to: '2026-11-01' }));
  const le = await one(`select * from client_ipc_lines where ipc_id = $1 and boq_item_id = $2`, [IPC2, excB]);
  const ls = await one(`select * from client_ipc_lines where ipc_id = $1 and boq_item_id = $2`, [IPC2, slabB]);
  ok(s2.ipc_no === 2 && n(le.prev_qty) === 320 && n(le.cum_qty) === 500 && n(ls.prev_qty) === 95 && n(ls.cum_qty) === 100, 'previous = IPC 1 certified, to date = verified');
  ok(near(s2.claimed.previous_value, n(ct.value_cum)) && near(s2.claimed.this_value, n(s2.claimed.value_cum) - n(ct.value_cum)),
    `line 2 = IPC 1 certified value, (1 − 2) = ${s2.claimed.this_value}`);
  ok(near(s2.claimed.retention_cum, n(ct.retention_cum) + n(s2.claimed.retention_this)) && near(s2.claimed.advance_this, n(s2.claimed.advance_recovery_cum) - n(ct.advance_recovery_cum)),
    'retention and advance are per certificate on top of IPC 1');
  const s2p = (await as(U.office_engineer, () => rpc('save_client_ipc', { op_id: uuid(), id: IPC2, project_id: P, penalty: 1000, material_delivered: 2500 }))).claimed;
  ok(near(s2p.total_deduction, n(s2p.previous_value) + n(s2p.rebate) + n(s2p.retention_this) + 3500) && near(s2p.payable, n(s2.claimed.payable) - 3500),
    `penalty 1,000 and client-supplied materials 2,500 are deducted (${s2p.total_deduction})`);

  console.log('\nTemplate figures (CCECC 2nd payment)');
  {
    // IPC 2 of the template: value to date 8,278,014.87, previous payment 1,869,158.88 → 6,857,475.91 to the contractor
    const TP = uuid(), B = uuid(), I1 = uuid(), I2 = uuid();
    await db.query(`insert into projects (id, code, name) values ($1, 'DDC', 'Diredawa corridor')`, [TP]);
    await db.query(`insert into client_contracts (project_id, contract_sum, retention_pct, retention_limit_pct, wht_pct, vat_pct) values ($1, 19836416.43, 5, 5, 3, 15)`, [TP]);
    await db.query(`insert into boq_items (id, project_id, item_no, description, unit, quantity) values ($1, $2, '1', 'Work', 'ls', 10000000)`, [B, TP]);
    await db.query(`insert into client_ipcs (id, project_id, ipc_no, period_to, status, certified, created_by)
      values ($1, $2, 1, '2026-09-30', 'paid', '{"value_cum": 1869158.88, "retention_cum": 0, "advance_recovery_cum": 0}', $3)`, [I1, TP, U.manager]);
    await db.query(`insert into client_ipcs (id, project_id, ipc_no, period_to, created_by) values ($1, $2, 2, '2026-10-17', $3)`, [I2, TP, U.manager]);
    await db.query(`insert into client_ipc_lines (ipc_id, project_id, boq_item_id, item_no, description, unit, rate, cum_qty) values ($1, $2, $3, '1', 'Work', 'ls', 1, 8278014.87)`, [I2, TP, B]);
    const t = (await one(`select app.ipc_totals($1, 'claimed') t`, [I2])).t;
    ok(near(t.retention_this, 320442.8) && near(t.total_deduction, 2189601.68) && near(t.net_before_advance, 6088413.19)
      && near(t.wht, 192265.68) && near(t.vat, 961328.4) && near(t.payable, 6857475.91), `app.ipc_totals reproduces the template: ${t.payable}`);
  }
  await expectError(as(U.office_engineer, () => rpc('save_client_ipc', { op_id: uuid(), id: IPC2, project_id: P, lines: [{ boq_item_id: excB, cum_qty: 200 }] })),
    /previous certificate/, 'going below the previous certificate needs a remark');

  console.log('\nVariations');
  const VO = uuid();
  const v1 = await as(U.office_engineer, () => rpc('save_variation', { op_id: uuid(), id: VO, project_id: P, title: 'Extra retaining wall at lift pit',
    instruction_ref: 'SI-007', instruction_date: '2026-10-28', lines: [
      { item_no: 'V1.1', description: 'C-25 concrete in lift pit retaining wall', unit: 'm3', qty: 20, rate: 6800 },
      { boq_item_id: excB, qty: 50 }], submit: true }));
  ok(v1.number === 'VO-001' && v1.status === 'pending' && near(v1.amount, 136000 + 9000), `VO-001 pending, ${v1.amount} ETB (existing item at its BoQ rate)`);
  ok((await as(U.manager, () => all(`select * from v_my_approvals where entity_id = $1`, [VO]))).length === 1, 'manager inbox shows the variation');
  await expectError(as(U.coordinator, () => rpc('decide_variation', { op_id: uuid(), variation_id: VO, action: 'approve' })), /not allowed/, 'coordinator cannot approve internally');
  await expectError(as(U.office_engineer, () => rpc('save_variation', { op_id: uuid(), id: uuid(), project_id: P, title: 'x', lines: [{ item_no: '1.2.3', description: 'dup', unit: 'kg', qty: 1, rate: 1 }] })),
    /already exists/, 'a new item cannot reuse an existing item no.');
  await as(U.manager, () => rpc('decide_variation', { op_id: uuid(), variation_id: VO, action: 'approve' }));
  await as(U.coordinator, () => rpc('decide_variation', { op_id: uuid(), variation_id: VO, action: 'client_approve', client_ref: 'HRE/VO/01' }));
  const nb = await one(`select b.quantity, r.rate from boq_items b join boq_rates r on r.boq_item_id = b.id where b.project_id = $1 and b.item_no = 'V1.1'`, [P]);
  const eb = await one(`select quantity from boq_items where id = $1`, [excB]);
  const cc2 = await one(`select contract_sum from client_contracts where project_id = $1`, [P]);
  ok(nb && n(nb.quantity) === 20 && n(nb.rate) === 6800 && n(eb.quantity) === 900 && near(cc2.contract_sum, sum + 145000),
    'approved VO adds item V1.1, raises excavation to 900 m3 and the contract sum by 145,000');
  await expectError(as(U.office_engineer, () => rpc('save_variation', { op_id: uuid(), id: VO, project_id: P, title: 'x', lines: [{ item_no: 'V9', description: 'd', unit: 'm', qty: 1, rate: 1 }] })),
    /cannot be edited/, 'an approved variation is locked');

  console.log('\nAccess');
  ok((await as(U.site_engineer, () => one(`select count(*)::int c from client_ipcs`))).c === 0, 'site engineer sees no payment certificates');
  ok((await as(U.site_engineer, () => one(`select count(*)::int c from variations`))).c === 0, 'site engineer sees no variations');
  ok((await as(U.manager, () => one(`select count(*)::int c from client_ipcs`))).c === 2, 'manager sees the certificates');
  await expectError(db.query(`select app.ipc_totals($1, 'claimed')`, [IPC1]).then(() => as(U.site_engineer, () => db.query(`select app.ipc_totals($1, 'claimed')`, [IPC1]))),
    /permission|denied/, 'totals helper is not callable by clients');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
