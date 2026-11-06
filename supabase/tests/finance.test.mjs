// Finance & admin test (migration 20261105000060_finance.sql): supplier invoices with a 3-way match and the
// prepare → check → approve → pay chain, petty cash float / expenses / replenishment, cash-flow forecast,
// finance overview, monthly tax report and the admin's view of another user's pending items.
//
//   node supabase/tests/finance.test.mjs

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
const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

async function main() {
  console.log('Applying migrations…');
  await db.exec(STUBS);
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    try { await db.exec(readFileSync(join(root, 'migrations', f), 'utf8')); }
    catch (e) {
      // other modules being written in parallel (same day, not this one) must not block this test
      if (f.startsWith('20261105') && !f.startsWith('2026110500006')) { console.log('  SKIPPED (parallel work)', f, '—', e.message); continue; }
      throw new Error(`${f}: ${e.message}`);
    }
  }
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);
  // re-running the finance migration is harmless
  await db.exec(readFileSync(join(root, 'migrations', '20261105000060_finance.sql'), 'utf8'));
  ok(true, 'finance migration re-runs cleanly');

  const U = {};
  for (const role of ['admin', 'manager', 'coordinator', 'finance', 'procurement', 'office_engineer', 'store_keeper', 'site_engineer']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role }, { role }]);
  }
  const P = uuid(), S1 = uuid(), SUP = uuid(), SUP2 = uuid();
  await db.query(`insert into projects (id, code, name) values ($1, 'FIN', 'Finance test')`, [P]);
  for (const r of Object.keys(U).filter((r) => r !== 'admin')) await db.query(`insert into project_members (project_id, user_id) values ($1, $2)`, [P, U[r]]);
  await db.query(`insert into stores (id, project_id, name, store_type) values ($1, $2, 'Main store', 'main')`, [S1, P]);
  await db.query(`insert into suppliers (id, name, tin) values ($1, 'Abyssinia Cement', '0001112223'), ($2, 'No-TIN Trading', null)`, [SUP, SUP2]);
  const CEM = (await one(`select s.id from material_specs s join materials m on m.id = s.material_id where m.name = 'Cement' and s.grade = 'OPC 42.5'`)).id;

  // PO: 120 bags @ 1,000 and 50 @ 1,150; GRNs accepted 100 and 50
  const PO = uuid(), PL1 = uuid(), PL2 = uuid();
  await db.query(`insert into purchase_orders (id, project_id, number, supplier_id, delivery_store_id, status, expected_date, created_by) values ($1, $2, 'FIN-PO-1', $3, $4, 'partially_received', current_date + 5, $5)`, [PO, P, SUP, S1, U.procurement]);
  await db.query(`insert into po_lines (id, po_id, project_id, line_no, material_spec_id, qty, qty_received, qty_accepted) values ($1, $3, $4, 1, $5, 120, 100, 100), ($2, $3, $4, 2, $5, 50, 50, 50)`, [PL1, PL2, PO, P, CEM]);
  await db.query(`insert into po_line_prices (po_line_id, project_id, unit_price) values ($1, $3, 1000), ($2, $3, 1150)`, [PL1, PL2, P]);
  await db.query(`insert into po_totals (po_id, project_id, subtotal, vat_rate, vat, total, withholding_rate, withholding, net_payable)
                  values ($1, $2, 177500, 15, 26625, 204125, 3, 5325, 198800)
                  on conflict (po_id) do update set subtotal = 177500, vat_rate = 15, vat = 26625, total = 204125, withholding_rate = 3, withholding = 5325, net_payable = 198800`, [PO, P]);
  const PO2 = uuid(), PL3 = uuid();
  await db.query(`insert into purchase_orders (id, project_id, number, supplier_id, delivery_store_id, status, created_by) values ($1, $2, 'FIN-PO-2', $3, $4, 'received', $5)`, [PO2, P, SUP2, S1, U.procurement]);
  await db.query(`insert into po_lines (id, po_id, project_id, line_no, material_spec_id, qty, qty_received, qty_accepted) values ($1, $2, $3, 1, $4, 40, 40, 40)`, [PL3, PO2, P, CEM]);
  await db.query(`insert into po_line_prices (po_line_id, project_id, unit_price) values ($1, $2, 1000)`, [PL3, P]);
  await db.query(`insert into po_totals (po_id, project_id, subtotal, vat_rate, vat, total, withholding_rate, withholding, net_payable)
                  values ($1, $2, 40000, 0, 0, 40000, 30, 12000, 28000)`, [PO2, P]);

  // =====================================================================
  console.log('\nSupplier invoices — 3-way match');
  const I1 = uuid();
  await expectError(as(U.site_engineer, () => rpc('save_supplier_invoice', { op_id: uuid(), id: I1, po_id: PO, invoice_no: 'AC-778', invoice_date: today(), lines: [{ po_line_id: PL1, qty: 1 }] })),
    /not allowed/, 'site engineer cannot record supplier invoices');
  const s1 = await as(U.procurement, () => rpc('save_supplier_invoice', { op_id: uuid(), id: I1, po_id: PO, invoice_no: 'AC-778', invoice_date: today(),
    lines: [{ po_line_id: PL1, qty: 100 }, { po_line_id: PL2, qty: 50 }] }));
  ok(s1.match_status === 'matched' && /SINV-0001$/.test(s1.number), `invoice ${s1.number} matches PO and GRNs`);
  const i1 = await one(`select * from supplier_invoices where id = $1`, [I1]);
  ok(near(i1.subtotal, 157500) && near(i1.vat, 23625) && near(i1.withholding, 4725) && near(i1.net_payable, 176400),
    `157,500 + VAT 23,625 − WHT 3 % 4,725 = ${i1.net_payable}`);
  await expectError(as(U.finance, () => rpc('save_supplier_invoice', { op_id: uuid(), id: uuid(), po_id: PO, invoice_no: 'ac-778', invoice_date: today(), lines: [{ po_line_id: PL1, qty: 1 }] })),
    /already recorded/, 'the same supplier invoice number cannot be recorded twice');
  await expectError(as(U.procurement, () => rpc('save_supplier_invoice', { op_id: uuid(), id: uuid(), po_id: PO, invoice_no: 'X', invoice_date: today(), lines: [{ po_line_id: PL3, qty: 1 }] })),
    /not a line of PO/, 'lines must belong to the PO');

  const I2 = uuid();
  const s2 = await as(U.procurement, () => rpc('save_supplier_invoice', { op_id: uuid(), id: I2, po_id: PO, invoice_no: 'AC-801', invoice_date: today(),
    lines: [{ po_line_id: PL1, qty: 30, unit_price: 1050 }] }));
  ok(s2.match_status === 'variance' && s2.match_notes.length === 1 && /price above the PO and quantity/.test(s2.match_notes[0]),
    `over-invoiced at a higher price is flagged: "${s2.match_notes[0]}"`);
  const inv = await as(U.finance, () => all(`select * from v_po_invoiceable where po_id = $1 order by line_no`, [PO]));
  ok(inv.length === 2 && n(inv[0].qty_invoiced) === 130 && n(inv[0].qty_accepted) === 100, 'invoiceable view shows accepted vs invoiced');

  const I3 = uuid();
  const s3 = await as(U.procurement, () => rpc('save_supplier_invoice', { op_id: uuid(), id: I3, po_id: PO2, invoice_no: 'NT-1', invoice_date: today(), lines: [{ po_line_id: PL3, qty: 40 }] }));
  const i3 = await one(`select * from supplier_invoices where id = $1`, [I3]);
  ok(near(i3.withholding_rate, 30) && near(i3.withholding, 12000) && s3.match_status === 'matched', 'supplier without TIN: 30 % withholding on 40,000');
  ok(near(i3.vat, 0) && near(i3.net_payable, 28000), 'a zero VAT rate on the PO is respected (not replaced by the standard rate)');

  console.log('\nApproval chain');
  await as(U.procurement, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I1, action: 'submit' }));
  const inboxC = await as(U.coordinator, () => all(`select * from v_my_approvals where entity_id = $1`, [I1]));
  ok(inboxC.length === 1 && inboxC[0].actions[0] === 'check', `coordinator inbox: "${inboxC[0]?.title}"`);
  await db.query(`update app_settings set price_roles = array_remove(price_roles, 'coordinator') where id = 1`);
  ok((await as(U.coordinator, () => all(`select * from v_my_approvals where entity_id = $1`, [I1]))).length === 0,
    'revoking price access removes supplier money from the approval inbox');
  await expectError(as(U.coordinator, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I1, action: 'check' })),
    /prices/, 'the server also blocks supplier approval actions without price access');
  await db.query(`update app_settings set price_roles = array_append(price_roles, 'coordinator') where id = 1`);
  await expectError(as(U.procurement, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I1, action: 'check' })), /not allowed/, 'procurement cannot check');
  await expectError(as(U.manager, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I1, action: 'approve' })), /checked by the coordinator/, 'manager cannot approve before the check');
  await as(U.coordinator, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I1, action: 'check' }));
  await as(U.manager, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I1, action: 'approve' }));
  ok((await as(U.finance, () => all(`select * from v_my_approvals where entity_id = $1`, [I1])))[0]?.actions[0] === 'pay', 'finance inbox shows it to pay');
  ok((await one(`select count(*)::int c from cost_entries where source_ref = $1`, [i1.number])).c === 0, 'no cost posted: materials are costed when used');
  await expectError(as(U.finance, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I1, action: 'pay', payment_method: 'cash', payment_date: today() })),
    /Cash is limited to 50,000\.00 ETB/, 'cash above the configured banking threshold is refused');
  await expectError(as(U.finance, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I1, action: 'pay', payment_method: 'bank_transfer', payment_date: today() })),
    /reference/, 'a bank transfer needs its reference');
  await as(U.finance, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I1, action: 'pay', payment_method: 'bank_transfer', payment_ref: 'CBE-9911', payment_date: today() }));
  ok((await one(`select status from supplier_invoices where id = $1`, [I1])).status === 'paid', 'paid by finance');

  await as(U.procurement, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I2, action: 'submit' }));
  await as(U.coordinator, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I2, action: 'check' }));
  await expectError(as(U.manager, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I2, action: 'approve' })),
    /does not match/, 'a variance cannot be approved without a written override');
  await as(U.manager, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'supplier_invoice', id: I2, action: 'approve', comment: 'Agreed price rise; balance delivered today' }));
  ok((await one(`select override_comment from supplier_invoices where id = $1`, [I2])).override_comment.startsWith('Agreed'), 'override reason kept on the invoice');
  ok((await as(U.site_engineer, () => one(`select count(*)::int c from supplier_invoices`))).c === 0, 'site engineer sees no supplier invoices');

  // =====================================================================
  console.log('\nPetty cash');
  const F = uuid();
  await expectError(as(U.coordinator, () => rpc('save_petty_float', { op_id: uuid(), id: F, project_id: P, custodian_id: U.store_keeper, float_amount: 10000 })), /not allowed/, 'coordinator cannot open a float');
  await as(U.manager, () => rpc('save_petty_float', { op_id: uuid(), id: F, project_id: P, name: 'Site petty cash', custodian_id: U.store_keeper, float_amount: 10000 }));
  const e1 = await as(U.store_keeper, () => rpc('record_petty_expense', { op_id: uuid(), id: uuid(), float_id: F, entry_date: today(), category: 'transport', description: 'Bajaj for sample to lab', amount: 3000, receipt_no: 'R-1' }));
  const E2 = uuid();
  const e2 = await as(U.store_keeper, () => rpc('record_petty_expense', { op_id: uuid(), id: E2, float_id: F, entry_date: today(), category: 'materials', description: 'Binding wire', amount: 6000 }));
  ok(near(e1.balance, 7000) && near(e2.balance, 1000), `balance after expenses ${e2.balance}`);
  await expectError(as(U.store_keeper, () => rpc('record_petty_expense', { op_id: uuid(), id: uuid(), float_id: F, entry_date: today(), category: 'food', description: 'Tea', amount: 2000 })),
    /Not enough cash/, 'cannot spend more than the cash in hand');
  await expectError(as(U.site_engineer, () => rpc('record_petty_expense', { op_id: uuid(), id: uuid(), float_id: F, entry_date: today(), category: 'food', description: 'Tea', amount: 10 })),
    /custodian/, 'only the custodian records expenses');
  ok((await as(U.store_keeper, () => one(`select balance from v_petty_cash_floats where id = $1`, [F]))).balance == 1000, 'custodian sees the float');
  ok((await as(U.site_engineer, () => one(`select count(*)::int c from petty_cash_floats`))).c === 0, 'other site staff do not');
  const C = uuid();
  const cl = await as(U.store_keeper, () => rpc('submit_petty_claim', { op_id: uuid(), id: C, float_id: F }));
  ok(near(cl.total, 9000) && cl.entries === 2, `replenishment claim ${cl.number}: 9,000 for 2 receipts`);
  await expectError(as(U.store_keeper, () => rpc('record_petty_expense', { op_id: uuid(), id: E2, void: true })), /in a replenishment claim/, 'claimed expenses cannot be voided');
  await as(U.coordinator, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'petty_cash', id: C, action: 'check' }));
  await as(U.manager, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'petty_cash', id: C, action: 'approve' }));
  const ce = await all(`select category, amount from cost_entries where source_ref = $1 order by amount`, [cl.number]);
  ok(ce.length === 2 && ce[0].category === 'overhead' && ce[1].category === 'material_direct' && near(ce[1].amount, 6000), 'approval posts the actual cost by category');
  await as(U.finance, () => rpc('finance_doc_action', { op_id: uuid(), doc_type: 'petty_cash', id: C, action: 'pay', payment_method: 'cash', payment_date: today() }));
  ok(n((await as(U.manager, () => one(`select balance from v_petty_cash_floats where id = $1`, [F]))).balance) === 10000, 'replenished: back to 10,000 in hand');

  // =====================================================================
  console.log('\nCash flow and overview');
  await db.query(`insert into client_contracts (project_id, contract_sum, payment_days) values ($1, 5000000, 30)`, [P]);
  await db.query(`insert into client_ipcs (id, project_id, ipc_no, period_to, status, certified, certified_on, created_by)
                  values ($1, $2, 1, current_date - 40, 'certified', '{"payable": 800000, "retention_cum": 40000, "this_value": 700000, "vat": 105000, "vat_pct": 15, "wht": 21000, "wht_pct": 3}', current_date - 40, $3)`, [uuid(), P, U.manager]);
  const PO_FAR = uuid(), PL_FAR = uuid();
  await db.query(`insert into purchase_orders (id, project_id, number, supplier_id, delivery_store_id, status, expected_date, created_by)
                  values ($1, $2, 'FIN-PO-FAR', $3, $4, 'approved', current_date + 400, $5)`, [PO_FAR, P, SUP, S1, U.procurement]);
  await db.query(`insert into po_lines (id, po_id, project_id, line_no, material_spec_id, qty) values ($1, $2, $3, 1, $4, 100)`, [PL_FAR, PO_FAR, P, CEM]);
  await db.query(`insert into po_line_prices (po_line_id, project_id, unit_price) values ($1, $2, 10000)`, [PL_FAR, P]);
  await db.query(`insert into po_totals (po_id, project_id, subtotal, vat_rate, vat, total, withholding_rate, withholding, net_payable)
                  values ($1, $2, 1000000, 15, 150000, 1150000, 3, 30000, 1120000)`, [PO_FAR, P]);
  await expectError(as(U.store_keeper, () => all(`select * from cash_flow_forecast($1, 13)`, [P])), /not allowed/, 'store keeper cannot see the cash flow');
  const cf = await as(U.finance, () => all(`select * from cash_flow_forecast($1, 13)`, [P]));
  ok(cf.length === 13, '13 weekly rows');
  ok(near(cf[0].client_in, 800000), `overdue client certificate falls in this week (${cf[0].client_in})`);
  const supOut = cf.reduce((s, r) => s + n(r.suppliers_out), 0), comOut = cf.reduce((s, r) => s + n(r.committed_out), 0);
  ok(near(supOut, n((await one(`select net_payable from supplier_invoices where id = $1`, [I2])).net_payable) + n(i3.net_payable)), `unpaid supplier invoices ${supOut}`);
  ok(near(comOut, 198800 - 176400 - n((await one(`select net_payable from supplier_invoices where id = $1`, [I2])).net_payable) > 0
    ? 198800 - 176400 - n((await one(`select net_payable from supplier_invoices where id = $1`, [I2])).net_payable) : 0), `PO value not yet invoiced is committed (${comOut}); later POs are outside the 13-week horizon`);
  ok((await as(U.finance, () => all(`select * from cash_flow_items($1) where ref = 'FIN-PO-FAR'`, [P]))).length === 1,
    'movements beyond the horizon remain available in drill-down');
  ok(near(cf[12].cumulative, cf.reduce((s, r) => s + n(r.net), 0)), 'cumulative = running sum of net');
  await db.query(`insert into retention_releases (id, project_id, stage, amount, requested_on, certified_on, received_on, received_amount, status, created_by)
                  values ($1, $2, 'practical_completion', 10000, current_date - 10, current_date - 8, current_date - 5, 10000, 'received', $3)`, [uuid(), P, U.manager]);
  const ov = await as(U.manager, () => one(`select finance_overview($1) o`, [P])).then((r) => r.o);
  ok(near(ov.receivable, 800000) && near(ov.receivable_ageing.d31_60, 800000) && near(ov.retention_receivable, 30000),
    'receivable ageing and retention receivable subtract the 10,000 already released');
  ok(near(ov.payable_approved, n((await one(`select net_payable from supplier_invoices where id = $1`, [I2])).net_payable)) && near(ov.petty_cash_in_hand, 10000), 'approved payables and petty cash in hand');

  console.log('\nTax report');
  const tr = await as(U.finance, () => all(`select * from tax_report($1, current_date)`, [P]));
  const sec = (s) => tr.filter((r) => r.section === s);
  ok(sec('wht_payable').length === 1 && near(sec('wht_payable')[0].amount, 4725) && sec('wht_payable')[0].tin === '0001112223', 'withholding to remit: 4,725 with the supplier TIN');
  ok(near(sec('vat_input').reduce((s, r) => s + n(r.amount), 0), 23625 + n((await one(`select vat from supplier_invoices where id = $1`, [I2])).vat)), 'VAT input from approved / paid invoices');
  const tAll = await as(U.finance, () => all(`select * from tax_report(null, current_date - 40)`));
  ok(tAll.some((r) => r.section === 'vat_output' && near(r.amount, 105000)) && tAll.some((r) => r.section === 'wht_credit' && near(r.amount, 21000)),
    'all projects: VAT output and withholding suffered on the client certificate');
  await expectError(as(U.procurement, () => all(`select * from tax_report($1, current_date)`, [P])), /not allowed/, 'procurement cannot run the tax report');

  console.log('\nAdmin handover');
  const I4 = uuid();
  await as(U.finance, () => rpc('save_supplier_invoice', { op_id: uuid(), id: I4, po_id: PO2, invoice_no: 'NT-2', invoice_date: today(), lines: [{ po_line_id: PL3, qty: 1 }], submit: true }));
  const rematched = await as(U.procurement, () => rpc('save_supplier_invoice', { op_id: uuid(), id: I3, po_id: PO2, invoice_no: 'NT-1', invoice_date: today(), lines: [{ po_line_id: PL3, qty: 40 }] }));
  ok(rematched.match_status === 'variance' && /1\.000 on other invoices/.test(rematched.match_notes[0]),
    `editing an older invoice also counts quantities on later invoices (${rematched.match_status}: ${rematched.match_notes})`);
  const pend = await as(U.admin, () => all(`select * from user_pending_items($1)`, [U.coordinator]));
  ok(pend.some((r) => r.entity_id === I4), `admin sees what waits on the coordinator (${pend.length} item(s))`);
  ok((await as(U.admin, () => one(`select auth.uid() u`))).u === U.admin, 'admin identity restored afterwards');
  await expectError(as(U.manager, () => all(`select * from user_pending_items($1)`, [U.coordinator])), /not allowed/, 'only the admin can look into another user\'s inbox');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
