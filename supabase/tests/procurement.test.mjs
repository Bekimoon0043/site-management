// Procurement & cost test (P1 #1–#5): applies migrations 0001–0005 + seed in
// PGlite with the same Supabase stubs as run.mjs, then drives
// RFQ → quotations → award → PO (VAT/WHT) → approval limits → send → GRN
// against PO → price history / spike alert → cost control → reorder
// suggestions, as real roles under RLS.
//
//   node supabase/tests/procurement.test.mjs

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
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function expectError(promise, pattern, msg) {
  try { await promise; ok(false, `${msg} (no error raised)`); }
  catch (e) { ok(pattern.test(e.message), `${msg} → "${e.message}"`); }
}

async function main() {
  console.log('Applying migrations 0001–0005…');
  await db.exec(STUBS);
  const files = readdirSync(join(root, 'migrations')).sort().filter((f) => /^(2026102900000[1-7]|2026103000000[12])_/.test(f));
  for (const f of files) {
    await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
    console.log('  applied', f);
  }
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);

  // ---- users & project -----------------------------------------------------
  const U = {};
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper', 'procurement']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role }, { role }]);
  }
  const P = uuid(), B = uuid(), L2 = uuid(), S = uuid(), C12 = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'BOLE', 'Bole Mixed-Use')`, [P]);
    for (const r of ['coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper', 'procurement']) {
      await db.query(`insert into project_members (project_id, user_id) values ($1, $2)`, [P, U[r]]);
    }
    await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'A', 'Block A')`, [B, P]);
    await db.query(`insert into levels (id, project_id, block_id, code, name) values ($1, $2, $3, 'L2', 'Level 2')`, [L2, P, B]);
    await db.query(`insert into stores (id, project_id, name) values ($1, $2, 'Main store')`, [S, P]);
    await db.query(`insert into elements (id, project_id, block_id, level_id, code, element_type) values ($1, $2, $3, $4, 'C12', 'column')`,
      [C12, P, B, L2]);
  });
  const spec = async (name, grade) => (await one(
    `select s.id from material_specs s join materials m on m.id = s.material_id where m.name = $1 and s.grade = $2`, [name, grade])).id;
  const CEM = await spec('Cement', 'OPC 42.5');
  const REBAR = await spec('Rebar', 'S-400 Ø16');
  await as(U.office_engineer, async () => {
    await db.query(`insert into element_takeoffs (project_id, element_id, material_spec_id, planned_qty) values ($1, $2, $3, 500)`, [P, C12, CEM]);
    await db.query(`update material_specs set reorder_level = 100 where id = $1`, [CEM]);
  });
  const SA = uuid(), SB = uuid(), SC = uuid();
  await as(U.procurement, () => db.query(`insert into suppliers (id, name, tin) values
    ($1, 'Abyssinia Cement Trading', '0012345678'), ($2, 'Habesha Supplies', '0098765432'), ($3, 'Merkato Traders', null)`, [SA, SB, SC]));
  ok((await one(`select count(*)::int n from tax_settings`)).n === 1, 'tax_settings seeded (VAT 15, WHT 3% ≥ 20,000, 30% no TIN)');

  // ---- approved MR ---------------------------------------------------------
  console.log('\nApproved material request');
  const MR = uuid(), ML = uuid();
  await as(U.site_engineer, () => rpc('save_mr', {
    op_id: uuid(), id: MR, project_id: P, number: 'BOLE-MR-D001-0001', block_id: B, required_date: '2026-11-20',
    delivery_location: 'Main store', store_id: S, submit: true,
    lines: [{ id: ML, material_spec_id: CEM, qty: 400, elements: [{ id: uuid(), element_id: C12, qty: 400 }] }],
  }));
  await as(U.coordinator, () => rpc('mr_action', { op_id: uuid(), mr_id: MR, action: 'approve' }));
  const mrStatus = async () => (await one(`select status from material_requests where id = $1`, [MR])).status;
  ok(await mrStatus() === 'approved', 'MR approved (400 qtl cement)');

  // ---- price history (market) ---------------------------------------------
  console.log('\nMarket prices');
  for (const [d, price] of [[60, 1000], [30, 980], [10, 1020]]) {
    await as(U.procurement, () => rpc('log_market_price', {
      op_id: uuid(), id: uuid(), project_id: P, material_spec_id: CEM, unit_price: price, observed_on: daysAgo(d), location: 'Merkato' }));
  }
  ok((await one(`select count(*)::int n from price_observations where source = 'market'`)).n === 3, '3 market prices logged (90-day avg 1000)');
  await expectError(as(U.store_keeper, () => rpc('log_market_price', { project_id: P, material_spec_id: CEM, unit_price: 1 })),
    /not allowed/, 'store keeper cannot log prices');

  // ---- RFQ ------------------------------------------------------------------
  console.log('\nRFQ & quotations');
  const RFQ = uuid(), RL = uuid();
  const rfq = await as(U.procurement, () => rpc('save_rfq', {
    op_id: uuid(), id: RFQ, project_id: P, number: 'BOLE-RFQ-D001-0001', title: 'Cement for Block A', required_by: '2026-11-15',
    delivery_store_id: S, send: true,
    lines: [{ id: RL, material_spec_id: CEM, qty: 400, mr_line_id: ML }],
    suppliers: [{ id: uuid(), supplier_id: SA, sent_via: 'telegram' }, { id: uuid(), supplier_id: SB, sent_via: 'telegram' },
                { id: uuid(), supplier_id: SC, sent_via: 'phone' }],
  }));
  ok(rfq.status === 'sent', 'RFQ sent to 3 suppliers');
  ok((await one(`select min_quotes from rfqs where id = $1`, [RFQ])).min_quotes === 3, 'min quotes defaulted from project settings (3)');
  ok(await mrStatus() === 'sourced', 'MR status → sourced');

  const QA = uuid(), QB = uuid(), QC = uuid(), QLA = uuid(), QLB = uuid(), QLC = uuid();
  const quote = (id, qline, supplier, n, price, extra = {}) => as(U.procurement, () => rpc('record_quotation', {
    op_id: uuid(), id, rfq_id: RFQ, supplier_id: supplier, number: `BOLE-QT-D001-000${n}`, quote_date: daysAgo(0),
    delivery_days: 5, ...extra, lines: [{ id: qline, rfq_line_id: RL, unit_price: price }],
  }));
  await quote(QA, QLA, SA, 1, 1180);
  await quote(QB, QLB, SB, 2, 1100);
  await expectError(as(U.coordinator, () => rpc('award_rfq', { rfq_id: RFQ, awards: [{ id: uuid(), rfq_line_id: RL, quotation_line_id: QLB }] })),
    /2 of the required 3 quotations/, 'award blocked below minimum quotations');
  await quote(QC, QLC, SC, 3, 1322.5, { prices_include_vat: true });
  const cmp = await as(U.coordinator, () => all(`select supplier_name, unit_price_ex_vat, price_rank, is_lowest from v_quotation_comparison
                                                  where rfq_id = $1 order by price_rank`, [RFQ]));
  ok(cmp.length === 3 && cmp[0].supplier_name === 'Habesha Supplies' && num(cmp[1].unit_price_ex_vat) === 1150,
    `comparison grid: ${cmp.map((c) => `${c.supplier_name} ${c.unit_price_ex_vat}`).join(' < ')} (VAT-inclusive quote normalised)`);
  ok((await as(U.store_keeper, () => all(`select * from v_quotation_comparison`))).length === 0, 'store keeper sees no quotation prices');

  // ---- award ------------------------------------------------------------------
  console.log('\nAward');
  const PO = uuid();
  const award = (reason) => as(U.coordinator, () => rpc('award_rfq', {
    op_id: uuid(), rfq_id: RFQ, create_po: true, pos: [{ id: PO, number: 'BOLE-PO-D001-0001', supplier_id: SA }],
    awards: [{ id: uuid(), rfq_line_id: RL, quotation_line_id: QLA, reason }],
  }));
  await expectError(award(), /not the lowest landed cost/, 'award to a non-lowest supplier needs a reason');
  const aw = await award('Habesha cannot deliver before 15 Nov; Abyssinia confirmed 5 days');
  ok(aw.po_ids.length === 1 && aw.po_ids[0] === PO, 'awarded with reason; draft PO created for the supplier');
  ok((await one(`select status from rfqs where id = $1`, [RFQ])).status === 'awarded', 'RFQ awarded');
  ok((await one(`select string_agg(status, ',' order by number) s from quotations where rfq_id = $1`, [RFQ])).s === 'awarded,not_awarded,not_awarded',
    'quotation statuses set (awarded / not_awarded)');
  const obs = await one(`select unit_price, avg_90d, is_spike from price_observations where source = 'quotation'`);
  ok(obs && num(obs.unit_price) === 1180 && obs.is_spike === true, `price history row from awarded quote (1180 vs 90-day avg ${obs?.avg_90d}) flagged as spike`);
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and title like 'Price spike%'`, [U.manager])).n === 1,
    'management notified of price spike');
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and title like 'Price spike%'`, [U.store_keeper])).n === 0,
    'store keeper not notified of prices');

  // ---- PO totals ----------------------------------------------------------------
  console.log('\nPurchase order totals (VAT / withholding)');
  const tot = await as(U.manager, () => one(`select * from po_totals where po_id = $1`, [PO]));
  ok(num(tot.subtotal) === 472000 && num(tot.vat) === 70800 && num(tot.total) === 542800,
    `PO subtotal ${tot.subtotal}, VAT ${tot.vat}, total ${tot.total}`);
  ok(num(tot.withholding_rate) === 3 && num(tot.withholding) === 14160 && num(tot.net_payable) === 528640,
    `withholding 3% = ${tot.withholding}, net payable ${tot.net_payable}`);
  const PO2 = uuid(), PO3 = uuid();
  const r2 = await as(U.procurement, () => rpc('save_po', {
    op_id: uuid(), id: PO2, project_id: P, number: 'BOLE-PO-D001-0002', supplier_id: SC, delivery_store_id: S,
    lines: [{ id: uuid(), material_spec_id: REBAR, qty: 250, unit_price: 100 }] }));
  ok(num(r2.totals.withholding_rate) === 30 && num(r2.totals.withholding) === 7500, 'supplier without TIN: 30% withholding (7,500 on 25,000)');
  const r3 = await as(U.procurement, () => rpc('save_po', {
    op_id: uuid(), id: PO3, project_id: P, number: 'BOLE-PO-D001-0003', supplier_id: SB, delivery_store_id: S,
    lines: [{ id: uuid(), material_spec_id: REBAR, qty: 100, unit_price: 100, vat_applicable: true }] }));
  ok(num(r3.totals.withholding) === 0 && num(r3.totals.vat) === 1500, 'below ETB 20,000: no withholding, VAT 1,500');
  await as(U.manager, () => db.query(`insert into tax_settings (effective_from, vat_rate) values ('2030-01-01', 16)`));
  const tx = await one(`select (app.tax_for('2030-06-01')).vat_rate v1, (app.tax_for(current_date)).vat_rate v2`);
  ok(num(tx.v1) === 16 && num(tx.v2) === 15, 'tax rates come from effective-dated tax_settings');
  await expectError(as(U.procurement, () => rpc('save_po', {
    op_id: uuid(), id: uuid(), project_id: P, number: 'BOLE-PO-D001-0004', supplier_id: SB, delivery_store_id: S,
    lines: [{ id: uuid(), material_spec_id: CEM, qty: 50, unit_price: 1100, mr_line_id: ML }] })),
    /exceeds the approved balance/, 'cannot order more than the MR approved quantity');

  // ---- approval ------------------------------------------------------------------
  console.log('\nPO approval');
  await as(U.procurement, () => rpc('po_action', { op_id: uuid(), po_id: PO, action: 'submit' }));
  await as(U.manager, () => db.query(`insert into approval_limits (project_id, role, max_value) values ($1, 'coordinator', 100000)`, [P]));
  await expectError(as(U.procurement, () => rpc('po_action', { po_id: PO, action: 'approve' })), /not allowed/, 'procurement cannot approve POs');
  await expectError(as(U.coordinator, () => rpc('po_action', { po_id: PO, action: 'approve' })),
    /exceeds your approval limit of 100000/, 'coordinator blocked by approval limit (542,800 > 100,000)');
  const apOp = uuid();
  await as(U.manager, () => rpc('po_action', { op_id: apOp, po_id: PO, action: 'approve' }));
  const replay = await as(U.manager, () => rpc('po_action', { op_id: apOp, po_id: PO, action: 'approve' }));
  ok(replay.status === 'approved', 'manager approved; replayed op is idempotent');
  ok(await mrStatus() === 'sourced', 'MR still sourced until the PO is sent');
  await as(U.procurement, () => rpc('po_action', { op_id: uuid(), po_id: PO, action: 'send' }));
  ok((await one(`select status from purchase_orders where id = $1`, [PO])).status === 'sent', 'PO sent to supplier');
  ok(await mrStatus() === 'ordered', 'MR status → ordered');
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and entity_type = 'purchase_order'`, [U.store_keeper])).n >= 1,
    'store keeper notified of expected delivery');

  // ---- price access ------------------------------------------------------------
  console.log('\nPrice access');
  const POL = (await one(`select id from po_lines where po_id = $1`, [PO])).id;
  await as(U.store_keeper, async () => {
    ok((await all(`select * from po_lines where po_id = $1`, [PO])).length === 1, 'store keeper can read PO lines (qty only)');
    ok((await all(`select * from v_expected_deliveries where po_id = $1`, [PO])).length === 1, 'store keeper sees expected delivery');
    ok((await all(`select * from po_line_prices`)).length === 0, 'store keeper cannot read po_line_prices');
    ok((await all(`select * from po_totals`)).length === 0, 'store keeper cannot read po_totals');
    ok((await all(`select * from price_observations`)).length === 0, 'store keeper cannot read price history');
    ok((await all(`select * from quotation_line_prices`)).length === 0, 'store keeper cannot read quotation prices');
  });
  ok((await as(U.site_engineer, () => all(`select * from v_committed_cost`))).length === 0, 'site engineer sees no committed cost');

  // ---- GRN against PO ----------------------------------------------------------
  console.log('\nReceiving against PO');
  const GRN = uuid();
  const g = await as(U.store_keeper, () => rpc('post_grn', {
    op_id: uuid(), id: GRN, project_id: P, store_id: S, number: 'BOLE-GRN-D002-0001', po_id: PO, delivery_note_no: 'DN-77',
    lines: [{ id: uuid(), po_line_id: POL, material_spec_id: CEM, qty_delivered: 250, qty_rejected: 10, inspection_result: 'conditional' }],
  }));
  ok(g.po_status === 'partially_received', 'PO status → partially_received');
  const pl = await one(`select qty_received, qty_accepted, qty_rejected from po_lines where id = $1`, [POL]);
  ok(num(pl.qty_received) === 250 && num(pl.qty_accepted) === 240 && num(pl.qty_rejected) === 10, 'PO line received 250 / accepted 240 / rejected 10');
  const gl = await one(`select mr_line_id, ordered_qty, variance_flag, po_line_id from grn_lines where grn_id = $1`, [GRN]);
  ok(gl.mr_line_id === ML && gl.po_line_id === POL && gl.variance_flag === 'shortage', 'GRN line linked to PO + MR line, shortage flagged');
  ok((await one(`select supplier_id from grns where id = $1`, [GRN])).supplier_id === SA, 'GRN supplier defaulted from PO');
  ok(await mrStatus() === 'ordered', 'MR stays ordered while the PO is open');
  await expectError(as(U.store_keeper, () => rpc('post_grn', {
    op_id: uuid(), id: uuid(), project_id: P, store_id: S, number: 'BOLE-GRN-D002-0002',
    lines: [{ id: uuid(), po_line_id: POL, material_spec_id: CEM, qty_delivered: 200 }] })),
    /exceeds the outstanding PO quantity of 160/, 'over-receipt beyond tolerance blocked');
  await expectError(as(U.store_keeper, () => rpc('post_grn', {
    op_id: uuid(), id: uuid(), project_id: P, store_id: S, number: 'BOLE-GRN-D002-0003',
    lines: [{ id: uuid(), po_line_id: POL, material_spec_id: REBAR, qty_delivered: 5 }] })),
    /does not match the ordered/, 'wrong material against a PO line blocked');
  await as(U.store_keeper, () => rpc('post_grn', {
    op_id: uuid(), id: uuid(), project_id: P, store_id: S, number: 'BOLE-GRN-D002-0004', supplier_name: 'Walk-in',
    lines: [{ id: uuid(), material_spec_id: REBAR, qty_delivered: 50 }] }));
  ok((await one(`select count(*)::int n from grns where number = 'BOLE-GRN-D002-0004' and po_id is null`)).n === 1,
    'legacy GRN payload without PO still posts');
  const GRN5 = uuid();
  await as(U.store_keeper, () => rpc('post_grn', {
    op_id: uuid(), id: GRN5, project_id: P, store_id: S, number: 'BOLE-GRN-D002-0005',
    lines: [{ id: uuid(), po_line_id: POL, material_spec_id: CEM, qty_delivered: 10 }] }));
  await as(U.store_keeper, () => rpc('reverse_document', { op_id: uuid(), doc_type: 'grn', doc_id: GRN5, reason: 'Wrong delivery note' }));
  ok(num((await one(`select qty_accepted from po_lines where id = $1`, [POL])).qty_accepted) === 240, 'GRN reversal gives quantity back to the PO line');

  // ---- issue against ordered MR -----------------------------------------------
  console.log('\nIssue');
  await as(U.store_keeper, () => rpc('post_miv', {
    op_id: uuid(), id: uuid(), project_id: P, store_id: S, number: 'BOLE-MIV-D002-0001', mr_id: MR, issued_to: U.site_engineer,
    lines: [{ id: uuid(), mr_line_id: ML, material_spec_id: CEM, element_id: C12, qty: 200 }] }));
  ok(await mrStatus() === 'partially_issued', 'issue against an ordered MR → partially_issued');

  // ---- delivery tracking --------------------------------------------------------
  console.log('\nDelivery tracking');
  await as(U.procurement, () => rpc('update_po_delivery', { op_id: uuid(), id: uuid(), po_id: PO, status: 'delayed', eta: daysAgo(1), note: 'Factory shutdown' }));
  const ps = await as(U.store_keeper, () => one(`select is_delayed, delivery_status, days_late from v_po_status where id = $1`, [PO]));
  ok(ps.is_delayed === true && ps.delivery_status === 'delayed', `delayed-PO flag set (${ps.days_late} day late)`);
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and title like '%delayed%'`, [U.site_engineer])).n === 1,
    'requester notified of delay');

  // ---- cost control -------------------------------------------------------------
  console.log('\nCost control');
  await expectError(as(U.office_engineer, () => rpc('save_budget', { project_id: P, lines: [] })), /not allowed/, 'office engineer cannot set budgets');
  await as(U.manager, () => rpc('save_budget', { op_id: uuid(), project_id: P, lines: [
    { id: uuid(), material_spec_id: CEM, budget_qty: 1000, budget_rate: 1200 },
    { id: uuid(), category: 'Cement', budget_amount: 2000000 },
  ] }));
  const cc = await as(U.manager, () => all(`select * from v_cost_control where project_id = $1 order by scope desc`, [P]));
  const ccm = cc.find((r) => r.scope === 'material');
  ok(ccm && num(ccm.budget_amount) === 1200000 && num(ccm.committed) === 188800 && num(ccm.received) === 283200
     && num(ccm.issued) === 236000 && num(ccm.remaining) === 728000,
    `v_cost_control (cement): budget ${ccm?.budget_amount}, committed ${ccm?.committed}, received ${ccm?.received}, issued ${ccm?.issued}, remaining ${ccm?.remaining}`);
  const ccc = cc.find((r) => r.scope === 'category');
  ok(ccc && num(ccc.committed) === 188800 && num(ccc.remaining) === 1528000, `category budget line rolls up (remaining ${ccc?.remaining})`);
  ok((await as(U.store_keeper, () => all(`select * from v_cost_control`))).length === 0, 'store keeper cannot see cost control');

  // ---- reorder suggestions ------------------------------------------------------
  console.log('\nReorder suggestions');
  const rs = await as(U.store_keeper, () => one(`select * from v_reorder_suggestions where store_id = $1 and material_spec_id = $2`, [S, CEM]));
  ok(rs && num(rs.available) === 40 && num(rs.open_po_qty) === 160 && num(rs.pending_mr_qty) === 200 && num(rs.suggested_qty) === 100,
    `cement: available ${rs?.available}, avg/day ${rs?.avg_daily_issue_30d}, cover ${rs?.days_cover} d, open PO ${rs?.open_po_qty}, pending MR ${rs?.pending_mr_qty} → suggest ${rs?.suggested_qty}`);
  const RMR = uuid();
  const rmr = await as(U.store_keeper, () => rpc('create_mr_from_suggestions', {
    op_id: uuid(), id: RMR, project_id: P, number: 'BOLE-MR-D002-0001', store_id: S, required_date: '2026-11-10',
    lines: [{ id: uuid(), material_spec_id: CEM, qty: num(rs.suggested_qty) }] }));
  const rm = await one(`select status, purpose, store_id from material_requests where id = $1`, [RMR]);
  ok(rmr.status === 'submitted' && rm.purpose === 'Reorder' && rm.store_id === S, 'reorder MR created and submitted from suggestion');

  // ---- amendment & close --------------------------------------------------------
  console.log('\nAmendment & close');
  await expectError(as(U.procurement, () => rpc('amend_po', { po_id: PO, reason: 'More', lines: [{ id: POL, material_spec_id: CEM, qty: 420, unit_price: 1180, mr_line_id: ML }] })),
    /exceeds the approved balance/, 'amendment cannot exceed MR approved quantity');
  await expectError(as(U.procurement, () => rpc('amend_po', { po_id: PO, reason: 'Less', lines: [{ id: POL, material_spec_id: CEM, qty: 200, unit_price: 1180, mr_line_id: ML }] })),
    /below the 240(\.0+)? already received/, 'amendment cannot go below received quantity');
  const am = await as(U.procurement, () => rpc('amend_po', { op_id: uuid(), po_id: PO, reason: 'Supplier price revision',
    lines: [{ id: POL, material_spec_id: CEM, qty: 400, unit_price: 1200, mr_line_id: ML, quotation_line_id: QLA }] }));
  ok(am.revision === 1 && am.status === 'submitted', 'price increase → revision 1, back to submitted for re-approval');
  ok((await as(U.manager, () => one(`select count(*)::int n from po_revisions where po_id = $1 and revision = 0`, [PO]))).n === 1, 'revision snapshot stored');
  ok((await as(U.store_keeper, () => all(`select * from po_revisions`))).length === 0, 'store keeper cannot read revision snapshots (prices)');
  await as(U.manager, () => rpc('po_action', { op_id: uuid(), po_id: PO, action: 'approve' }));
  ok((await one(`select status from purchase_orders where id = $1`, [PO])).status === 'partially_received', 're-approval restores receipt status');
  await expectError(as(U.procurement, () => rpc('po_action', { po_id: PO, action: 'cancel', comment: 'x' })), /close it instead/, 'cannot cancel a PO with receipts');
  await as(U.procurement, () => rpc('po_action', { op_id: uuid(), po_id: PO, action: 'close', comment: 'Balance not needed' }));
  ok((await as(U.manager, () => all(`select * from v_committed_cost where po_id = $1`, [PO]))).length === 0, 'short-closed PO no longer committed');
  await expectError(db.query(`delete from purchase_orders where id = $1`, [PO]), /immutable/, 'POs cannot be deleted');
  ok((await as(U.manager, () => one(`select count(*)::int n from audit_log where table_name = 'purchase_orders'`))).n > 0, 'PO changes audited');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e.message, e.position ? `at position ${e.position}` : '', e.where ?? ''); process.exit(1); });
