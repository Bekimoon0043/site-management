// "Schedule is the BoQ" test (migration 20261030000005_schedule_boq_from_tasks.sql). Applies ALL migrations
// in order + seed in PGlite with the Supabase stubs used by the other suites.
//
// Scenario: a small MS Project schedule whose leaf tasks are BoQ items (Text1 "Unit", Number1 "Qty",
// Number2 "Rate" ex-VAT, Cost1 "Amount" = Qty × Rate × 1.15, already ÷100 by the web parser) is imported;
// create_boq_from_schedule by an office engineer (no prices) → items, links, EV method; by a coordinator →
// rates + budgets; idempotent re-run; role checks; baseline from the current plan; progress by quantity → EV.
//
//   node supabase/tests/schedule-boq.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const MINE = '20261030000005_schedule_boq_from_tasks.sql';
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

  console.log('\nnorm_unit / custom_num helpers');
  const nu = await one(`select array[app.norm_unit('m²'), app.norm_unit('M3'), app.norm_unit('m³'), app.norm_unit('Kg'), app.norm_unit('no.'),
    app.norm_unit('L.M'), app.norm_unit('Lump sum'), app.norm_unit(' bag '), app.norm_unit('')] a`);
  ok(JSON.stringify(nu.a) === JSON.stringify(['m2', 'm3', 'm3', 'kg', 'No', 'ml', 'LS', 'bag', null]), `units normalised (${nu.a})`);
  const cn = await one(`select app.custom_num('1,234.50') a, app.custom_num('') b, app.custom_num('x') c`);
  ok(n(cn.a) === 1234.5 && cn.b === null && cn.c === null, 'custom numbers parsed');

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

  // =====================================================================
  console.log('\ncreate_boq_from_schedule by an office engineer (no price access)');
  const base = { schedule_id: SCH, unit_field: 'Unit', qty_field: 'Qty', rate_field: 'Rate', amount_field: 'Amount', vat_included: true };
  await expectError(as(U.site_engineer, () => rpc('create_boq_from_schedule', { op_id: uuid(), ...base })), /not allowed/, 'site engineer cannot create the BoQ');
  await expectError(as(U.office_engineer, () => rpc('create_boq_from_schedule', { op_id: uuid(), schedule_id: SCH })), /quantity/, 'qty field is required');
  const r1 = await as(U.office_engineer, () => rpc('create_boq_from_schedule', { op_id: uuid(), ...base }));
  ok(r1.items_created === 5 && r1.items_updated === 0 && r1.links === 5, `5 items + 5 links created (${r1.items_created}/${r1.links})`);
  ok(r1.skipped.no_qty === 1 && r1.skipped.summaries === 4, `skipped: 1 without qty (milestone), 4 summaries (${JSON.stringify(r1.skipped)})`);
  ok(r1.fields.qty === 'Number1' && r1.fields.unit === 'Text1' && r1.fields.amount === 'Cost1', 'aliases resolved to field names');
  ok(r1.total_amount_ex_vat === null && r1.rates_saved === 0 && r1.budgets_saved === 0, 'no totals / rates / budgets for a non-price role');
  ok(r1.warnings.some((w) => /cannot see prices/.test(w)), 'warning: rates not saved');
  ok(n(r1.vat_pct) === 15, 'VAT % defaults to tax_settings (15)');
  const items = await as(U.office_engineer, () => all(`select * from boq_items where project_id = $1 order by item_no`, [P]));
  const I = Object.fromEntries(items.map((b) => [b.item_no, b]));
  ok(items.length === 5 && I['1.2.1.1'] && I['1.2.3'], `item numbers from WBS (${items.map((b) => b.item_no)})`);
  ok(I['1.2.2.1.1'].description === 'Concrete C-25 in… – a) In Flat Mat slab' && I['1.2.1.1'].description.startsWith('Bulk excavation'),
    `a)/b) items get the parent name (${I['1.2.2.1.1'].description})`);
  ok(I['1.2.1.1'].unit === 'm3' && I['1.2.2.1.2'].unit === 'm3' && I['1.2.3'].unit === 'kg' && n(I['1.2.3'].quantity) === 54000, 'units normalised, quantities from Qty');
  ok((await one(`select count(*)::int c from boq_rates r join boq_items b on b.id = r.boq_item_id where b.project_id = $1`, [P])).c === 0, 'no rates written');
  const tk = async () => Object.fromEntries((await all(`select * from schedule_tasks where schedule_id = $1`, [SCH])).map((t) => [t.msp_uid, t]));
  let t = await tk();
  ok([3, 4, 7, 8, 9].every((u) => t[u].ev_method === 'units') && t[10].ev_method !== 'units' && t[1].ev_method !== 'units', 'BoQ tasks earn by quantity (units)');
  const lk = await one(`select qty_share q, source from task_boq_links where task_id = $1 and deleted_at is null`, [t[7].id]);
  ok(n(lk.q) === 420 && lk.source === 'file', 'link qty_share = task Qty (whole item)');

  console.log('\nRe-run by a coordinator (price role): rates and budgets');
  const opC = uuid();
  const r2 = await as(U.coordinator, () => rpc('create_boq_from_schedule', { op_id: opC, ...base }));
  ok(r2.items_created === 0 && r2.items_updated === 0 && r2.items_unchanged === 5, `idempotent: nothing new (${r2.items_created}/${r2.items_updated}/${r2.items_unchanged})`);
  ok(r2.rates_saved === 5 && r2.budgets_saved === 5, 'rates + budgets saved');
  const exVat = 850 * 180 + 1200 * 35 + 420 * 6500 + 160 * 6800 + 54000 * 120;
  ok(near(r2.total_amount_ex_vat, exVat) && near(r2.total_amount_incl_vat, exVat * 1.15),
    `totals ex VAT ${r2.total_amount_ex_vat} / incl VAT ${r2.total_amount_incl_vat}`);
  ok(r2.warnings.length === 0, `no warnings (${JSON.stringify(r2.warnings)})`);
  const rate = await as(U.coordinator, () => one(`select r.rate from boq_rates r join boq_items b on b.id = r.boq_item_id where b.project_id = $1 and b.item_no = '1.2.2.1.1'`, [P]));
  ok(n(rate.rate) === 6500, 'boq rate = ex-VAT Rate column');
  const bud = await as(U.coordinator, () => one(`select * from schedule_task_costs where task_id = $1`, [t[7].id]));
  ok(n(bud.budget_ex_vat) === 2730000 && n(bud.budget_incl_vat) === 3139500 && n(bud.msp_cost) === 3139500 && bud.budget_source === 'schedule_boq',
    `task budget ex VAT 2 730 000, incl VAT 3 139 500 = MSP Cost (${bud.budget_ex_vat}/${bud.budget_incl_vat}/${bud.msp_cost})`);
  ok((await as(U.office_engineer, () => all(`select * from schedule_task_costs`))).length === 0, 'budgets hidden from the office engineer');
  ok((await as(U.office_engineer, () => all(`select * from boq_rates`))).length === 0, 'rates hidden from the office engineer');
  const r2b = await as(U.coordinator, () => rpc('create_boq_from_schedule', { op_id: opC, ...base }));
  ok(JSON.stringify(r2b) === JSON.stringify(r2), 'replayed op returns the first result');
  const r3 = await as(U.coordinator, () => rpc('create_boq_from_schedule', { op_id: uuid(), ...base, vat_included: undefined, amount_scale: undefined }));
  ok(r3.vat_included === true && r3.items_unchanged === 5, 'VAT detected from the amounts when not given');
  ok((await one(`select count(*)::int c from task_boq_links where project_id = $1 and deleted_at is null`, [P])).c === 5, 'still 5 links (no duplicates)');

  console.log('\nRe-import with a changed quantity → re-run updates the item');
  const file2 = structuredClone(file);
  file2.file_sha256 = 'apt-2';
  Object.assign(file2.tasks.find((x) => x.uid === 3), B('m³', 900, 180));
  await as(U.coordinator, () => rpc('import_schedule', { op_id: uuid(), project_id: P, schedule_id: SCH, schedule: file2 }));
  const r4 = await as(U.coordinator, () => rpc('create_boq_from_schedule', { op_id: uuid(), ...base }));
  ok(r4.items_updated === 1 && r4.items_created === 0, `1 item updated (${r4.items_updated})`);
  ok(n((await one(`select quantity q from boq_items where project_id = $1 and item_no = '1.2.1.1'`, [P])).q) === 900
     && n((await one(`select qty_share q from task_boq_links where task_id = $1`, [t[3].id])).q) === 900, 'item quantity and link share 900');
  const wrongAmt = structuredClone(file2); wrongAmt.file_sha256 = 'apt-3';
  wrongAmt.tasks.find((x) => x.uid === 4).custom.Cost1 = '50000';
  await as(U.coordinator, () => rpc('import_schedule', { op_id: uuid(), project_id: P, schedule_id: SCH, schedule: wrongAmt }));
  const r5 = await as(U.coordinator, () => rpc('create_boq_from_schedule', { op_id: uuid(), ...base }));
  ok(r5.warnings.some((w) => /Task 4 .*Amount 50000/.test(w)), 'amount that does not match Qty × Rate × 1.15 is flagged');
  const r6 = await as(U.coordinator, () => rpc('create_boq_from_schedule', { op_id: uuid(), ...base, rate_field: null, description_mode: 'name' }));
  ok(n((await as(U.coordinator, () => one(`select r.rate from boq_rates r join boq_items b on b.id = r.boq_item_id where b.item_no = '1.2.1.1' and b.project_id = $1`, [P]))).rate) === 180,
    'without a rate field the ex-VAT rate is derived from the amount (÷ 1.15 ÷ qty)');
  ok(r6.items_updated === 2 && (await one(`select description from boq_items where project_id = $1 and item_no = '1.2.2.1.1'`, [P])).description === 'a) In Flat Mat slab',
    'description_mode name: leaf name only');
  await as(U.coordinator, () => rpc('create_boq_from_schedule', { op_id: uuid(), ...base }));   // back to defaults

  // =====================================================================
  console.log('\nBaseline from the current plan (file has none) and EV by quantity');
  const BL = uuid();
  const sb = await as(U.coordinator, () => rpc('set_baseline', { op_id: uuid(), id: BL, schedule_id: SCH, source: 'current_plan', cost_source: 'value' }));
  const exVat2 = exVat + 50 * 180;
  ok(sb.tasks === 6 && near(sb.bac_value, exVat2) && near(sb.contract_value, exVat2), `baseline: 6 tasks, BAC value = Σ qty × ex-VAT rate (${sb.bac_value})`);
  await as(U.manager, () => rpc('approve_baseline', { op_id: uuid(), baseline_id: BL, approve: true }));
  const ev0 = await one(`select ev from app.evm_task_raw($1, '2026-09-20') where task_id = $2`, [SCH, t[3].id]);
  ok(n(ev0.ev) === 0, 'no EV before progress');
  const rep = await as(U.site_engineer, () => rpc('report_task_progress', { op_id: uuid(), id: uuid(), task_id: t[3].id, status_date: '2026-09-05', qty_done: 450, actual_start: '2026-09-01' }));
  ok(n(rep.pct_complete) === 50, `450 of 900 m³ reported = 50 % (${rep.pct_complete})`);
  await as(U.office_engineer, () => rpc('verify_task_progress', { op_id: uuid(), progress_id: rep.id, approve: true }));
  const ev1 = await one(`select ev, bac, pct_earned from app.evm_task_raw($1, '2026-09-20') where task_id = $2`, [SCH, t[3].id]);
  ok(near(ev1.ev, 450 * 180) && near(ev1.bac, 900 * 180) && near(ev1.pct_earned, 50), `EV = 450 × 180 = 81 000 (${ev1.ev} of ${ev1.bac})`);
  const pj = await one(`select ev, bac from app.evm_project_raw($1, '2026-09-20')`, [SCH]);
  ok(near(pj.ev, 81000) && near(pj.bac, exVat2), `project EV 81 000 of BAC ${pj.bac}`);
  t = await tk();
  ok(n(t[3].pct_complete) === 50 && n((await one(`select verified_qty q from task_boq_links where task_id = $1`, [t[3].id])).q) === 450, 'task 50 %, link verified qty 450');
  const bp = await one(`select qty_to_date q, qty_contract c from app.boq_progress_raw($1, '2026-09-20') x join boq_items b on b.id = x.boq_item_id where b.item_no = '1.2.1.1'`, [SCH]);
  ok(n(bp.q) === 450 && n(bp.c) === 900, 'BoQ progress (IPC basis): 450 of 900');
  await expectError(as(U.coordinator, () => rpc('create_boq_from_schedule', { op_id: uuid(), ...base, set_ev_method: true, vat_pct: 120 })), /vat_pct/, 'VAT % validated');

  if (skipped.length) console.log(`\nNOTE: skipped parallel migrations: ${skipped.join(', ')}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
