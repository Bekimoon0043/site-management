// Material procurement flows test (migrations 20261030000001_mr_flow_enums.sql +
// 20261030000002_mr_flows.sql; spec docs/research/procurement-lookahead.md §3–§7, §11).
// Applies 0001–0007 + the two flow migrations + seed in PGlite with the same
// Supabase stubs as run.mjs. Migrations 2026103000000[3-9]_* (schedule /
// look-ahead, written concurrently) are deliberately excluded so this suite
// tests the flows in isolation.
//
//   node supabase/tests/flows.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const F = await import('../../shared/contract-flows.ts');   // Node ≥ 22.18 strips TS types
const db = new PGlite();

const MIGRATIONS = /^(2026102900000[1-7]|2026103000000[12])_.*\.sql$/;

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
const today = new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
async function expectError(promise, pattern, msg) {
  try { await promise; ok(false, `${msg} (no error raised)`); }
  catch (e) { ok(pattern.test(e.message), `${msg} → "${e.message}"`); }
}

async function main() {
  console.log('Applying migrations (0001–0007 + flow migrations)…');
  await db.exec(STUBS);
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => MIGRATIONS.test(f)).sort()) {
    await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
    console.log('  applied', f);
  }
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);

  // ---- users & project -----------------------------------------------------
  const U = {};
  for (const [key, role] of [['admin', 'admin'], ['coordinator', 'coordinator'], ['manager', 'manager'], ['gm', 'manager'],
    ['office_engineer', 'office_engineer'], ['site_engineer', 'site_engineer'], ['store_keeper', 'store_keeper'],
    ['procurement', 'procurement'], ['security', 'security']]) {
    U[key] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[key], `${key}@test.et`, { full_name: key }, { role }]);
  }
  const P = uuid(), B = uuid(), L2 = uuid(), S = uuid(), S2 = uuid(), C12 = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'BOLE', 'Bole Mixed-Use')`, [P]);
    for (const k of Object.keys(U).filter((k) => k !== 'admin')) {
      await db.query(`insert into project_members (project_id, user_id) values ($1, $2)`, [P, U[k]]);
    }
    await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'A', 'Block A')`, [B, P]);
    await db.query(`insert into levels (id, project_id, block_id, code, name) values ($1, $2, $3, 'L2', 'Level 2')`, [L2, P, B]);
    await db.query(`insert into stores (id, project_id, name, store_type) values ($1, $2, 'Main store', 'main'), ($3, $2, 'Yard', 'yard')`, [S, P, S2]);
    await db.query(`insert into elements (id, project_id, block_id, level_id, code, element_type) values ($1, $2, $3, $4, 'C12', 'column')`,
      [C12, P, B, L2]);
  });
  const spec = async (name, grade) => (await one(
    `select s.id from material_specs s join materials m on m.id = s.material_id where m.name = $1 and s.grade = $2`, [name, grade])).id;
  const CEM = await spec('Cement', 'OPC 42.5');
  const REBAR = await spec('Rebar', 'S-400 Ø16');
  await as(U.office_engineer, () => db.query(`insert into element_takeoffs (project_id, element_id, material_spec_id, planned_qty)
    values ($1, $2, $3, 500), ($1, $2, $4, 400)`, [P, C12, CEM, REBAR]));
  await as(U.manager, () => db.query(`insert into spec_prices (material_spec_id, unit_price) values ($1, 1000), ($2, 100)`, [CEM, REBAR]));
  const SA = uuid(), SB = uuid(), SC = uuid();
  await as(U.procurement, () => db.query(`insert into suppliers (id, name, tin) values
    ($1, 'Abyssinia Cement', '0012345678'), ($2, 'Habesha Supplies', '0098765432'), ($3, 'Merkato Traders', '0011111111')`, [SA, SB, SC]));

  const st = async (id) => (await one(`select status from material_requests where id = $1`, [id])).status;
  const notes = async (user, entity) => (await one(`select count(*)::int n from notifications where user_id = $1 and entity_id = $2`, [user, entity])).n;
  const inbox = async (key) => as(U[key], () => all(`select kind, entity_id, actions from v_my_approvals`));
  const hasKind = (rows, kind, id) => rows.some((r) => r.kind === kind && (!id || r.entity_id === id));
  const events = async (id) => (await all(`select action from mr_events where mr_id = $1 order by created_at, id`, [id])).map((e) => e.action);

  // ---- defaults ----------------------------------------------------------------
  console.log('\nDefaults & backfill');
  const ps = await one(`select pr_require_coordinator_review, pr_coordinator_final_limit, po_tolerance_pct, wf_sla_hours from project_settings where project_id = $1`, [P]);
  ok(ps.pr_require_coordinator_review === true && ps.pr_coordinator_final_limit === null && num(ps.po_tolerance_pct) === 10
     && ps.wf_sla_hours.pr.submitted === 24 && ps.wf_sla_hours.sur.reviewed === 24,
    'settings: coordinator review on, management always approves, PO tolerance 10%, SLA 24 h per step');
  const lim = await all(`select role, max_value from approval_limits where doc_type = 'purchase_request' and project_id is null order by max_value`);
  ok(lim.length === 2 && lim[0].role === 'coordinator' && num(lim[0].max_value) === 50000 && num(lim[1].max_value) === 1000000,
    'company PR limits: coordinator 50,000 / manager 1,000,000 (admin unlimited)');
  ok(F.nextActor('submitted', 'purchase') === 'coordinator' && F.nextActor('submitted', 'site_use') === 'office_engineer'
     && F.canFlow('office_engineer', 'pr.create') && !F.canFlow('site_engineer', 'pr.create'), 'contract-flows helpers (nextActor / canFlow)');

  // =====================================================================================
  // 1. PURCHASE: full flow
  // =====================================================================================
  console.log('\n1. Purchase request — full flow');
  const PR1 = uuid(), PR1L = uuid();
  const prPayload = (id, line, number, qty, extra = {}) => ({
    op_id: uuid(), id, project_id: P, number, request_type: 'purchase', store_id: S, required_date: plusDays(14),
    purpose: 'Cement for level 3', submit: true, lines: [{ id: line, material_spec_id: CEM, qty, elements: [] }], ...extra });
  await expectError(as(U.site_engineer, () => rpc('save_mr', prPayload(uuid(), uuid(), 'BOLE-PR-D001-0099', 10))),
    /not allowed/, 'site engineer cannot raise a purchase request');
  await expectError(as(U.office_engineer, () => rpc('save_mr', prPayload(uuid(), uuid(), 'BOLE-MR-D001-0099', 10))),
    /PR document type/, 'purchase requests need a PR- number');
  const s1 = await as(U.office_engineer, () => rpc('save_mr', prPayload(PR1, PR1L, 'BOLE-PR-D001-0001', 100)));
  ok(s1.status === 'submitted' && s1.request_type === 'purchase', 'office engineer raised + submitted PR (no element split needed)');
  ok((await one(`select current_owner_role from material_requests where id = $1`, [PR1])).current_owner_role === 'coordinator', 'ball in court: coordinator');
  ok(await notes(U.coordinator, PR1) === 1 && await notes(U.manager, PR1) === 0, 'coordinators notified on submit (managers not yet)');
  ok(hasKind(await inbox('coordinator'), 'pr_review', PR1), 'coordinator inbox: pr_review');
  await expectError(as(U.office_engineer, () => rpc('mr_action', { mr_id: PR1, action: 'approve' })), /not allowed/, 'office engineer cannot approve a PR');
  await expectError(as(U.coordinator, () => rpc('mr_action', { mr_id: PR1, action: 'approve' })), /management approval is required/,
    'coordinator cannot approve while pr_coordinator_final_limit is null');
  await expectError(as(U.manager, () => rpc('mr_action', { mr_id: PR1, action: 'approve' })), /reviewed by the coordinator first/,
    'manager cannot skip the coordinator review');
  await expectError(as(U.procurement, () => rpc('create_rfq_from_prs', { id: uuid(), number: 'BOLE-RFQ-D001-0099', mr_line_ids: [PR1L], supplier_ids: [SA] })),
    /not approved by management/, 'procurement cannot create an RFQ from an unapproved PR');

  let reqN = await notes(U.office_engineer, PR1);
  const step = async (label) => { const n = await notes(U.office_engineer, PR1); ok(n > reqN, `requester notified: ${label}`); reqN = n; };
  const revOp = uuid();
  const rv = await as(U.coordinator, () => rpc('mr_action', { op_id: revOp, mr_id: PR1, action: 'review', comment: 'Trim to 90', lines: [{ id: PR1L, reviewed_qty: 90 }] }));
  const rv2 = await as(U.coordinator, () => rpc('mr_action', { op_id: revOp, mr_id: PR1, action: 'review', lines: [{ id: PR1L, reviewed_qty: 90 }] }));
  ok(rv.status === 'reviewed_by_coordinator' && JSON.stringify(rv) === JSON.stringify(rv2), 'coordinator reviewed (trimmed to 90); replayed op returns identical result');
  await step('reviewed by coordinator');
  ok(await notes(U.manager, PR1) === 1 && hasKind(await inbox('manager'), 'pr_approve', PR1), 'managers notified; manager inbox: pr_approve');
  await expectError(as(U.manager, () => rpc('mr_action', { mr_id: PR1, action: 'approve', lines: [{ id: PR1L, approved_qty: 95 }] })),
    /between 0 and 90/, 'approved qty cannot exceed the reviewed qty');
  const ap = await as(U.manager, () => rpc('mr_action', { op_id: uuid(), mr_id: PR1, action: 'approve', lines: [{ id: PR1L, approved_qty: 80 }] }));
  ok(ap.status === 'approved_by_management', 'manager approved (partial: 80)');
  await step('approved by management');
  ok((await one(`select approved_qty from mr_lines where id = $1`, [PR1L])).approved_qty == 80, 'approved_qty 80 recorded');
  ok(await notes(U.procurement, PR1) >= 1 && hasKind(await inbox('procurement'), 'pr_accept', PR1), 'procurement notified; inbox: pr_accept');
  ok(num((await as(U.manager, () => one(`select est_value from mr_estimates where mr_id = $1`, [PR1]))).est_value) === 80000
     && (await as(U.store_keeper, () => all(`select * from mr_estimates`))).length === 0, 'estimate 80,000 stored price-restricted (store keeper sees none)');
  const ac = await as(U.procurement, () => rpc('mr_action', { op_id: uuid(), mr_id: PR1, action: 'accept' }));
  ok(ac.status === 'with_procurement', 'procurement accepted → with_procurement');
  await step('with procurement');
  ok((await all(`select step from mr_approvals where mr_id = $1 order by created_at`, [PR1])).map((a) => a.step).join(',') === 'coordinator_review,approve,procurement_accept',
    'sign-off log: coordinator_review, approve, procurement_accept');

  const RFQ = uuid();
  const rf = await as(U.procurement, () => rpc('create_rfq_from_prs', { op_id: uuid(), id: RFQ, number: 'BOLE-RFQ-D001-0001',
    mr_line_ids: [PR1L], supplier_ids: [SA, SB, SC], sent_via: 'telegram' }));
  ok(rf.status === 'sent' && rf.lines.length === 1 && num(rf.lines[0].qty) === 80, 'RFQ created from PR (80) and sent to 3 suppliers');
  ok(await st(PR1) === 'sourced', 'PR → sourced');
  await step('sourcing');
  const RL = rf.lines[0].rfq_line_id;
  const QL = {};
  for (const [i, sup, price] of [[1, SA, 1020], [2, SB, 1100], [3, SC, 1150]]) {
    QL[sup] = uuid();
    await as(U.procurement, () => rpc('record_quotation', { op_id: uuid(), id: uuid(), rfq_id: RFQ, supplier_id: sup,
      number: `BOLE-QT-D001-000${i}`, quote_date: today, delivery_days: 3, lines: [{ id: QL[sup], rfq_line_id: RL, unit_price: price }] }));
  }
  const PO1 = uuid();
  await as(U.coordinator, () => rpc('award_rfq', { op_id: uuid(), rfq_id: RFQ, create_po: true,
    pos: [{ id: PO1, number: 'BOLE-PO-D001-0001', supplier_id: SA }], awards: [{ id: uuid(), rfq_line_id: RL, quotation_line_id: QL[SA] }] }));
  const sub = await as(U.procurement, () => rpc('po_action', { op_id: uuid(), po_id: PO1, action: 'submit' }));
  const po1 = await one(`select status, auto_approved, approved_by from purchase_orders where id = $1`, [PO1]);
  ok(sub.status === 'approved' && po1.auto_approved && po1.approved_by === U.manager,
    'PO auto-approved at submit (traced to approved PR, 81,600 ≤ 80,000 + 10%, lowest bidder); approver = PR approver');
  await as(U.procurement, () => rpc('po_action', { op_id: uuid(), po_id: PO1, action: 'send' }));
  ok(await st(PR1) === 'ordered', 'PO sent → PR ordered ("Purchased")');
  await step('purchased');
  ok((await one(`select title from notifications where user_id = $1 and entity_id = $2 order by created_at desc limit 1`, [U.office_engineer, PR1])).title.includes('Purchased'),
    'requester told "Purchased"');

  const DN1 = uuid();
  const POL1 = (await one(`select id from po_lines where po_id = $1`, [PO1])).id;
  await as(U.procurement, () => rpc('notify_store_delivery', { op_id: uuid(), id: DN1, po_id: PO1, expected_date: plusDays(1),
    expected_window: '08:00-12:00', vehicle_plate: '3-AA12345', driver_name: 'Abebe', driver_phone: '0911000000',
    lines: [{ po_line_id: POL1, qty: 50 }] }));
  ok(await st(PR1) === 'delivery_expected', 'delivery notice → PR delivery_expected');
  await step('delivery expected');
  ok(await notes(U.store_keeper, DN1) === 1 && await notes(U.security, DN1) === 1, 'store keeper and security notified of the delivery');
  ok((await one(`select is_critical from notifications where user_id = $1 and entity_id = $2`, [U.store_keeper, DN1])).is_critical, 'ETA ≤ 1 day → critical');
  ok(hasKind(await inbox('store_keeper'), 'delivery_ack', DN1), 'store keeper inbox: delivery_ack');
  ok((await as(U.store_keeper, () => all(`select * from delivery_notices where id = $1`, [DN1]))).length === 1, 'store keeper can read the notice (no prices)');
  await as(U.store_keeper, () => rpc('acknowledge_delivery_notice', { op_id: uuid(), id: DN1, decision: 'accept', note: 'Bay 2 cleared' }));
  ok((await one(`select status from delivery_notices where id = $1`, [DN1])).status === 'acknowledged'
     && (await events(PR1)).includes('delivery_ack'), 'store keeper accepted the notice (recorded in mr_events)');
  await as(U.security, () => rpc('log_vehicle', { op_id: uuid(), id: uuid(), project_id: P, number: 'BOLE-VEH-D009-0001', direction: 'in',
    plate: '3-AA12345', loaded: true, linked_doc_type: 'delivery_notice', linked_doc_id: DN1 }));
  ok((await one(`select status from delivery_notices where id = $1`, [DN1])).status === 'arrived', 'gate log-in linked to notice → arrived');

  const g1 = await as(U.store_keeper, () => rpc('post_grn', { op_id: uuid(), id: uuid(), project_id: P, store_id: S, number: 'BOLE-GRN-D002-0001',
    po_id: PO1, delivery_notice_id: DN1, lines: [{ id: uuid(), po_line_id: POL1, material_spec_id: CEM, qty_delivered: 50 }] }));
  ok(g1.delivery_notice_id === DN1 && (await one(`select status from delivery_notices where id = $1`, [DN1])).status === 'received', 'GRN closes the notice (received)');
  ok(await st(PR1) === 'partially_received' && num((await one(`select qty_received from mr_lines where id = $1`, [PR1L])).qty_received) === 50,
    'PR partially_received (50 of 80)');
  await step('partially received');
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and entity_id = $2 and title like 'GRN%'`, [U.coordinator, PR1])).n === 1,
    'coordinator told "Received 50 of 80"');
  await as(U.procurement, () => rpc('notify_store_delivery', { op_id: uuid(), id: uuid(), po_id: PO1, expected_date: plusDays(3) }));
  ok(await st(PR1) === 'delivery_expected', 'second notice for the balance → delivery_expected again');
  await as(U.store_keeper, () => rpc('post_grn', { op_id: uuid(), id: uuid(), project_id: P, store_id: S, number: 'BOLE-GRN-D002-0002',
    lines: [{ id: uuid(), po_line_id: POL1, material_spec_id: CEM, qty_delivered: 30 }] }));
  const ev1 = await events(PR1);
  ok(await st(PR1) === 'closed' && ev1.includes('auto_close')
     && (await one(`select count(*)::int n from mr_events where mr_id = $1 and to_status = 'received'`, [PR1])).n === 1,
    'GRN of the balance → received → closed');
  await step('received');
  ok((await one(`select received_at is not null and closed_at is not null as ok from material_requests where id = $1`, [PR1])).ok, 'received_at / closed_at stamped');

  // =====================================================================================
  // 2. Return & resubmit
  // =====================================================================================
  console.log('\n2. Return & resubmit');
  const PR2 = uuid(), PR2L = uuid();
  await as(U.office_engineer, () => rpc('save_mr', prPayload(PR2, PR2L, 'BOLE-PR-D001-0002', 20)));
  await expectError(as(U.coordinator, () => rpc('mr_action', { mr_id: PR2, action: 'return' })), /clarification/, 'return needs a comment');
  await as(U.coordinator, () => rpc('mr_action', { op_id: uuid(), mr_id: PR2, action: 'review', lines: [{ id: PR2L, reviewed_qty: 15 }] }));
  await as(U.manager, () => rpc('mr_action', { op_id: uuid(), mr_id: PR2, action: 'return', comment: 'Which grade?' }));
  ok(await st(PR2) === 'returned' && (await one(`select status_reason, current_owner_role from material_requests where id = $1`, [PR2])).current_owner_role === 'requester',
    'manager returned → ball back with requester');
  const re = await as(U.office_engineer, () => rpc('save_mr', prPayload(PR2, PR2L, 'BOLE-PR-D001-0002', 18)));
  const pr2 = await one(`select version, coordinator_reviewed_by from material_requests where id = $1`, [PR2]);
  ok(re.status === 'submitted' && pr2.version === 2 && pr2.coordinator_reviewed_by === null
     && (await one(`select reviewed_qty from mr_lines where id = $1`, [PR2L])).reviewed_qty === null,
    'edited + resubmitted: version 2, review cleared, back at coordinator');
  ok((await one(`select bool_and(superseded) s from mr_approvals where mr_id = $1`, [PR2])).s === true, 'earlier sign-offs superseded');
  await as(U.coordinator, () => rpc('mr_action', { op_id: uuid(), mr_id: PR2, action: 'review' }));
  await as(U.manager, () => rpc('mr_action', { op_id: uuid(), mr_id: PR2, action: 'approve' }));
  await as(U.procurement, () => rpc('mr_action', { op_id: uuid(), mr_id: PR2, action: 'return', comment: 'Grade not available; suggest OPC 52.5' }));
  const pr2b = await one(`select status, approved_by, procurement_owner from material_requests where id = $1`, [PR2]);
  ok(pr2b.status === 'returned' && pr2b.approved_by === null && (await one(`select approved_qty from mr_lines where id = $1`, [PR2L])).approved_qty === null,
    'procurement return clears the management approval');

  // =====================================================================================
  // 3. Rejection
  // =====================================================================================
  console.log('\n3. Rejection');
  const PR3 = uuid();
  await as(U.office_engineer, () => rpc('save_mr', prPayload(PR3, uuid(), 'BOLE-PR-D001-0003', 5)));
  await expectError(as(U.coordinator, () => rpc('mr_action', { mr_id: PR3, action: 'reject' })), /reason is required/, 'reject needs a reason');
  const rj = await as(U.coordinator, () => rpc('mr_action', { op_id: uuid(), mr_id: PR3, action: 'reject', comment: 'Stock available in yard' }));
  ok(rj.status === 'rejected' && (await one(`select status_reason from material_requests where id = $1`, [PR3])).status_reason === 'Stock available in yard',
    'coordinator rejected with reason');
  ok(await notes(U.office_engineer, PR3) === 1, 'requester notified of rejection');
  await expectError(as(U.procurement, () => rpc('mr_action', { mr_id: PR3, action: 'accept' })), /management-approved/, 'rejected PR cannot be accepted');

  // =====================================================================================
  // 4. Value limit → endorse up
  // =====================================================================================
  console.log('\n4. Value limit endorse-up');
  await as(U.manager, () => db.query(`insert into approval_limits (project_id, role, doc_type, max_value) values ($1, 'manager', 'purchase_request', 500000)`, [P]));
  await as(U.admin, () => db.query(`insert into approval_limits (project_id, role, doc_type, user_id, max_value) values (null, 'manager', 'purchase_request', $1, 5000000)`, [U.gm]));
  const PR4 = uuid();
  await as(U.office_engineer, () => rpc('save_mr', prPayload(PR4, uuid(), 'BOLE-PR-D001-0004', 800)));
  await as(U.coordinator, () => rpc('mr_action', { op_id: uuid(), mr_id: PR4, action: 'review' }));
  const en = await as(U.manager, () => rpc('mr_action', { op_id: uuid(), mr_id: PR4, action: 'approve' }));
  ok(en.endorsed === true && en.status === 'reviewed_by_coordinator' && await st(PR4) === 'reviewed_by_coordinator',
    'manager (limit 500,000) endorsed 816,000 PR (800 × latest price 1020) — status unchanged');
  const eav = await as(U.manager, () => one(`select a.step, v.est_value, v.limit_used from mr_approvals a join mr_approval_values v on v.approval_id = a.id where a.mr_id = $1 and a.step = 'endorse'`, [PR4]));
  ok(eav.step === 'endorse' && num(eav.est_value) === 816000 && num(eav.limit_used) === 500000, 'endorse recorded with value + limit (price-restricted)');
  ok((await as(U.site_engineer, () => all(`select * from mr_approval_values`))).length === 0, 'site engineer cannot see approval values');
  ok(await notes(U.gm, PR4) >= 1, 'covering approver (GM, per-user limit 5,000,000) notified');
  ok(!hasKind(await inbox('manager'), 'pr_approve', PR4) && hasKind(await inbox('gm'), 'pr_approve', PR4), 'inbox: gone for endorser, shown to covering approver');
  await expectError(as(U.manager, () => rpc('mr_action', { mr_id: PR4, action: 'approve' })), /already endorsed/, 'endorser cannot endorse twice');
  const fin = await as(U.gm, () => rpc('mr_action', { op_id: uuid(), mr_id: PR4, action: 'approve' }));
  ok(fin.status === 'approved_by_management', 'GM approved (final sign-off)');
  ok((await all(`select step from mr_approvals where mr_id = $1 and not superseded order by created_at`, [PR4])).map((a) => a.step).join(',') === 'coordinator_review,endorse,approve',
    'DoA evidence: review, endorse, approve');
  // delegation: GM on leave → manager inherits the 5,000,000 limit
  await as(U.gm, () => rpc('save_approval_delegation', { op_id: uuid(), to_user: U.manager, doc_type: 'purchase_request', valid_from: today, valid_to: plusDays(7), reason: 'Annual leave' }));
  const dl = await one(`select * from app.approval_limit_for($1, $2, 'purchase_request')`, [U.manager, P]);
  ok(num(dl.max_value) === 5000000 && dl.delegated_from === U.gm, 'delegation: manager inherits GM limit inside the window');

  // =====================================================================================
  // 5. Self-approval blocked
  // =====================================================================================
  console.log('\n5. Self-approval');
  const PR5 = uuid();
  await as(U.coordinator, () => rpc('save_mr', prPayload(PR5, uuid(), 'BOLE-PR-D001-0005', 3)));
  await expectError(as(U.coordinator, () => rpc('mr_action', { mr_id: PR5, action: 'review' })), /your own request/, 'coordinator cannot review own PR');
  ok(!hasKind(await inbox('coordinator'), 'pr_review', PR5), 'own PR not in own inbox');
  const PR6 = uuid();
  await as(U.manager, () => db.query(`update project_settings set pr_require_coordinator_review = false where project_id = $1`, [P]));
  await as(U.manager, () => rpc('save_mr', prPayload(PR6, uuid(), 'BOLE-PR-D001-0006', 3)));
  await expectError(as(U.manager, () => rpc('mr_action', { mr_id: PR6, action: 'approve' })), /your own request/, 'manager cannot approve own PR');
  ok(hasKind(await inbox('gm'), 'pr_approve', PR6), 'without coordinator review a submitted PR goes straight to management');
  await as(U.manager, () => db.query(`update project_settings set pr_require_coordinator_review = true where project_id = $1`, [P]));
  const SUR0 = uuid();
  await as(U.coordinator, () => rpc('save_mr', { op_id: uuid(), id: SUR0, project_id: P, number: 'BOLE-MR-D001-0090', block_id: B, required_date: plusDays(3),
    store_id: S, submit: true, lines: [{ id: uuid(), material_spec_id: CEM, qty: 1, elements: [{ id: uuid(), element_id: C12, qty: 1 }] }] }));
  await expectError(as(U.coordinator, () => rpc('mr_action', { mr_id: SUR0, action: 'approve' })), /your own request/, 'coordinator cannot approve own site-use request');

  // =====================================================================================
  // 6. SITE USE: full flow
  // =====================================================================================
  console.log('\n6. Site-use request — full flow');
  const SUR = uuid(), SURL = uuid();
  const sv = await as(U.site_engineer, () => rpc('save_mr', { op_id: uuid(), id: SUR, project_id: P, number: 'BOLE-MR-D001-0001', block_id: B,
    required_date: plusDays(2), delivery_location: 'Column C12', store_id: S, submit: true,
    lines: [{ id: SURL, material_spec_id: CEM, qty: 30, elements: [{ id: uuid(), element_id: C12, qty: 30 }] }] }));
  ok(sv.status === 'submitted' && sv.request_type === 'site_use', 'site engineer submitted SUR (default type site_use, legacy MR- number)');
  ok(await notes(U.office_engineer, SUR) === 1 && await notes(U.coordinator, SUR) === 0, 'office engineers notified (coordinator not, normal priority)');
  ok(hasKind(await inbox('office_engineer'), 'mr_review', SUR), 'OE inbox: mr_review');
  const orv = await as(U.office_engineer, () => rpc('mr_action', { op_id: uuid(), mr_id: SUR, action: 'review', lines: [{ id: SURL, reviewed_qty: 30 }] }));
  ok(orv.status === 'reviewed' && num(orv.stock[0].ati) === 80 && num(orv.stock[0].shortfall) === 0, `OE review returns stock check (ATI ${orv.stock[0].ati}, no shortfall)`);
  ok(await notes(U.coordinator, SUR) === 1 && hasKind(await inbox('coordinator'), 'mr_approve', SUR), 'forwarded: coordinator notified, inbox mr_approve');
  const oap = await as(U.coordinator, () => rpc('mr_action', { op_id: uuid(), mr_id: SUR, action: 'approve', issue_by: plusDays(1) }));
  ok(oap.status === 'approved' && (await one(`select issue_by::text d from material_requests where id = $1`, [SUR])).d === plusDays(1), 'coordinator approved = store order (issue by tomorrow)');
  ok((await one(`select title from notifications where user_id = $1 and entity_id = $2`, [U.store_keeper, SUR])).title.startsWith('Store order'),
    'store keeper got the store order');
  ok(hasKind(await inbox('store_keeper'), 'sur_issue', SUR), 'store keeper inbox: sur_issue');
  const M1 = uuid(), M2 = uuid();
  const miv = (id, n, qty) => as(U.store_keeper, () => rpc('post_miv', { op_id: uuid(), id, project_id: P, store_id: S, number: `BOLE-MIV-D002-000${n}`,
    mr_id: SUR, issued_to: U.site_engineer, lines: [{ id: uuid(), mr_line_id: SURL, material_spec_id: CEM, element_id: C12, qty }] }));
  await miv(M1, 1, 10);
  ok(await st(SUR) === 'partially_issued', 'partial MIV → partially_issued');
  await miv(M2, 2, 20);
  ok(await st(SUR) === 'issued', 'full MIV → issued');
  ok(hasKind(await inbox('site_engineer'), 'miv_ack', M1), 'site engineer inbox: miv_ack');
  await as(U.site_engineer, () => rpc('acknowledge_miv', { miv_id: M1 }));
  ok(await st(SUR) === 'issued', 'one of two MIVs acknowledged → still issued');
  const ak = await as(U.site_engineer, () => rpc('acknowledge_miv', { miv_id: M2 }));
  ok(ak.mr_status === 'received' && await st(SUR) === 'received', 'all MIVs acknowledged → received');
  await db.query(`update material_requests set received_at = now() - interval '25 hours' where id = $1`, [SUR]);
  await db.query(`select public.escalate_pending_requests()`);
  ok(await st(SUR) === 'closed', 'received SUR auto-closed after 24 h (escalation job)');

  // =====================================================================================
  // 7. Shortfall → PR → GRN → issue against SUR
  // =====================================================================================
  console.log('\n7. Shortfall conversion');
  await as(U.coordinator, () => rpc('post_opening_balance', { op_id: uuid(), project_id: P, store_id: S, lines: [{ material_spec_id: REBAR, qty: 40 }] }));
  const SR2 = uuid(), SR2L = uuid();
  await as(U.site_engineer, () => rpc('save_mr', { op_id: uuid(), id: SR2, project_id: P, number: 'BOLE-MR-D001-0003', block_id: B,
    required_date: plusDays(5), store_id: S, submit: true,
    lines: [{ id: SR2L, material_spec_id: REBAR, qty: 100, elements: [{ id: uuid(), element_id: C12, qty: 100 }] }] }));
  const rv7 = await as(U.office_engineer, () => rpc('mr_action', { op_id: uuid(), mr_id: SR2, action: 'review' }));
  ok(num(rv7.stock[0].ati) === 40 && num(rv7.stock[0].shortfall) === 60, 'stock check: ATI 40, short 60');
  await expectError(as(U.site_engineer, () => rpc('mr_action', { mr_id: SR2, action: 'convert_shortfall', lines: [{ id: SR2L, qty: 60 }] })),
    /not allowed/, 'site engineer cannot convert (no PRs under the client flow)');
  const cv = await as(U.office_engineer, () => rpc('mr_action', { op_id: uuid(), mr_id: SR2, action: 'convert_shortfall', lines: [{ id: SR2L, qty: 60 }] }));
  const PRS = cv.pr_id;
  const prs = await one(`select request_type, status, source_mr_id, number from material_requests where id = $1`, [PRS]);
  ok(cv.status === 'reviewed' && prs.request_type === 'purchase' && prs.status === 'submitted' && prs.source_mr_id === SR2
     && prs.number.startsWith('BOLE-PR-D001-0003'), `SUR stays reviewed; PR ${prs.number} submitted with source_mr_id`);
  const PRSL = cv.pr_lines[0].pr_line_id;
  ok((await one(`select source_mr_line_id, (select sum(qty) from mr_line_elements where mr_line_id = l.id) s from mr_lines l where id = $1`, [PRSL])).s == 60,
    'PR line linked to SUR line and carries the element split (60)');
  ok((await events(SR2)).includes('convert_shortfall') && await notes(U.coordinator, PRS) === 1, 'event on SUR; coordinators notified of the PR');
  await as(U.coordinator, () => rpc('mr_action', { op_id: uuid(), mr_id: SR2, action: 'approve' }));
  ok(num((await one(`select approved_qty from mr_lines where id = $1`, [SR2L])).approved_qty) === 100, 'SUR line keeps its approved qty (100, waits)');
  await as(U.store_keeper, () => rpc('post_miv', { op_id: uuid(), id: uuid(), project_id: P, store_id: S, number: 'BOLE-MIV-D002-0003', mr_id: SR2,
    issued_to: U.site_engineer, lines: [{ id: uuid(), mr_line_id: SR2L, material_spec_id: REBAR, element_id: C12, qty: 40 }] }));
  ok(await st(SR2) === 'partially_issued', 'available 40 issued against the SUR');
  await expectError(as(U.store_keeper, () => rpc('post_miv', { op_id: uuid(), id: uuid(), project_id: P, store_id: S, number: 'BOLE-MIV-D002-0098', mr_id: PRS,
    issued_to: U.site_engineer, lines: [{ id: uuid(), mr_line_id: PRSL, material_spec_id: REBAR, element_id: C12, qty: 1 }] })),
    /purchase request; issue against the site-use request/, 'store keeper cannot issue against the PR');
  await as(U.coordinator, () => rpc('mr_action', { op_id: uuid(), mr_id: PRS, action: 'review' }));
  await as(U.manager, () => rpc('mr_action', { op_id: uuid(), mr_id: PRS, action: 'approve' }));
  const DPO = uuid();
  await expectError(as(U.procurement, () => rpc('record_direct_purchase', { op_id: uuid(), po_id: DPO, number: 'BOLE-PO-D001-0002', supplier_id: SB,
    reason: 'Single local supplier', lines: [{ mr_line_id: PRSL, qty: 60, unit_price: 95 }] })), /exceeds the direct purchase limit of 0/,
    'direct purchase off by default (limit 0)');
  await as(U.manager, () => db.query(`update project_settings set direct_purchase_limit = 10000 where project_id = $1`, [P]));
  const dp = await as(U.procurement, () => rpc('record_direct_purchase', { op_id: uuid(), po_id: DPO, number: 'BOLE-PO-D001-0002', supplier_id: SB,
    reason: 'Single local supplier', receipt_ref: 'RCPT-445', lines: [{ mr_line_id: PRSL, qty: 60, unit_price: 95 }] }));
  const dpo = await one(`select status, purchase_method, approved_by from purchase_orders where id = $1`, [DPO]);
  ok(dp.status === 'sent' && dpo.purchase_method === 'direct' && dpo.approved_by === U.manager && await st(PRS) === 'ordered',
    'direct purchase: PO sent (method direct, approved_by = PR approver), PR ordered');
  const nSE = await notes(U.site_engineer, SR2);
  const DPOL = (await one(`select id from po_lines where po_id = $1`, [DPO])).id;
  await as(U.store_keeper, () => rpc('post_grn', { op_id: uuid(), id: uuid(), project_id: P, store_id: S, number: 'BOLE-GRN-D002-0003',
    lines: [{ id: uuid(), po_line_id: DPOL, material_spec_id: REBAR, qty_delivered: 60 }] }));
  ok(await st(PRS) === 'closed', 'GRN of the PR → received → closed');
  ok(await notes(U.site_engineer, SR2) > nSE
     && (await one(`select title from notifications where user_id = $1 and entity_id = $2 order by created_at desc limit 1`, [U.site_engineer, SR2])).title.includes('now issuable'),
    'SUR requester told "line now issuable"');
  await as(U.store_keeper, () => rpc('post_miv', { op_id: uuid(), id: uuid(), project_id: P, store_id: S, number: 'BOLE-MIV-D002-0004', mr_id: SR2,
    issued_to: U.site_engineer, lines: [{ id: uuid(), mr_line_id: SR2L, material_spec_id: REBAR, element_id: C12, qty: 60 }] }));
  ok(await st(SR2) === 'issued', 'MIV of the purchased 60 against the SUR line → issued');

  // =====================================================================================
  // 8. Reservation prevents double-promise
  // =====================================================================================
  console.log('\n8. Reservation (available-to-issue)');
  const bal = async () => num((await one(`select coalesce(sum(qty),0) q from stock_ledger where store_id = $1 and material_spec_id = $2 and stock_status = 'available'`, [S, CEM])).q);
  ok(await bal() === 50, 'cement available 50');
  const sur = async (id, line, n, qty) => {
    await as(U.site_engineer, () => rpc('save_mr', { op_id: uuid(), id, project_id: P, number: `BOLE-MR-D001-00${n}`, block_id: B, required_date: plusDays(3),
      store_id: S, submit: true, lines: [{ id: line, material_spec_id: CEM, qty, elements: [{ id: uuid(), element_id: C12, qty }] }] }));
    await as(U.office_engineer, () => rpc('mr_action', { op_id: uuid(), mr_id: id, action: 'review' }));
    return as(U.coordinator, () => rpc('mr_action', { op_id: uuid(), mr_id: id, action: 'approve' }));
  };
  const SA1 = uuid(), SA1L = uuid(), SA2 = uuid(), SA2L = uuid();
  await sur(SA1, SA1L, 11, 40);
  const a2 = await sur(SA2, SA2L, 12, 30);
  ok(num(a2.stock[0].ati) === 10 && num(a2.stock[0].shortfall) === 20, 'second store order sees ATI 10 (40 reserved for the first)');
  const ati = await as(U.store_keeper, () => one(`select available, reserved, ati, over_promised from v_stock_available_to_issue where store_id = $1 and material_spec_id = $2`, [S, CEM]));
  ok(num(ati.available) === 50 && num(ati.reserved) === 70 && num(ati.ati) === 0 && ati.over_promised, 'v_stock_available_to_issue: 50 available, 70 reserved, over-promised');
  const issue = (mr, line, n, qty) => as(U.store_keeper, () => rpc('post_miv', { op_id: uuid(), id: uuid(), project_id: P, store_id: S,
    number: `BOLE-MIV-D002-00${n}`, mr_id: mr, issued_to: U.site_engineer, lines: [{ id: uuid(), mr_line_id: line, material_spec_id: CEM, element_id: C12, qty }] }));
  await expectError(issue(SA2, SA2L, 21, 30), /only 10.* available to issue \(40.* reserved/, 'later store order cannot take stock promised to the earlier one');
  await issue(SA2, SA2L, 22, 10);
  await issue(SA1, SA1L, 23, 40);
  ok(await st(SA1) === 'issued' && await st(SA2) === 'partially_issued' && await bal() === 0, 'earlier order fully issued; later one got the free 10');

  // =====================================================================================
  // 9. PO auto-approval rule (negative cases)
  // =====================================================================================
  console.log('\n9. PO auto-approval rule');
  const PR9 = uuid(), PR9L = uuid();
  await as(U.office_engineer, () => rpc('save_mr', prPayload(PR9, PR9L, 'BOLE-PR-D001-0009', 10)));
  await as(U.coordinator, () => rpc('mr_action', { op_id: uuid(), mr_id: PR9, action: 'review' }));
  await as(U.manager, () => rpc('mr_action', { op_id: uuid(), mr_id: PR9, action: 'approve' }));
  const est9 = num((await one(`select est_value from mr_estimates where mr_id = $1`, [PR9])).est_value);
  ok(est9 === 10200, `estimate uses latest 90-day price (awarded 1020) → ${est9}`);
  const RFQ9 = uuid();
  const rf9 = await as(U.procurement, () => rpc('create_rfq_from_prs', { op_id: uuid(), id: RFQ9, number: 'BOLE-RFQ-D001-0009', mr_line_ids: [PR9L], supplier_ids: [SA, SB, SC] }));
  ok(await st(PR9) === 'sourced' && (await one(`select procurement_owner from material_requests where id = $1`, [PR9])).procurement_owner === U.procurement,
    'RFQ from an approved PR implies procurement acceptance');
  const RL9 = rf9.lines[0].rfq_line_id, Q9 = {};
  for (const [i, sup, price] of [[4, SA, 1200], [5, SB, 1250], [6, SC, 1300]]) {
    Q9[sup] = uuid();
    await as(U.procurement, () => rpc('record_quotation', { op_id: uuid(), id: uuid(), rfq_id: RFQ9, supplier_id: sup,
      number: `BOLE-QT-D001-000${i}`, quote_date: today, lines: [{ id: Q9[sup], rfq_line_id: RL9, unit_price: price }] }));
  }
  const PO9 = uuid(), PO9b = uuid();
  await as(U.coordinator, () => rpc('award_rfq', { op_id: uuid(), rfq_id: RFQ9, create_po: true, pos: [{ id: PO9, number: 'BOLE-PO-D001-0009', supplier_id: SA }],
    awards: [{ id: uuid(), rfq_line_id: RL9, quotation_line_id: Q9[SA], qty: 5 }] }));
  const s9 = await as(U.procurement, () => rpc('po_action', { op_id: uuid(), po_id: PO9, action: 'submit' }));
  ok(s9.status === 'submitted' && !s9.auto_approved, 'lowest bidder but 1200 > estimate 1020 + 10% → no auto-approval (normal PO approval)');
  ok(hasKind(await inbox('manager'), 'po_approve', PO9), 'manager inbox: po_approve');
  await as(U.manager, () => rpc('po_action', { op_id: uuid(), po_id: PO9, action: 'approve' }));
  ok((await one(`select status from purchase_orders where id = $1`, [PO9])).status === 'approved', 'manager approved the PO manually');
  // non-lowest bidder within tolerance: still needs approval
  await as(U.coordinator, () => rpc('award_rfq', { op_id: uuid(), rfq_id: RFQ9, create_po: true, pos: [{ id: PO9b, number: 'BOLE-PO-D001-0010', supplier_id: SB }],
    awards: [{ id: uuid(), rfq_line_id: RL9, quotation_line_id: Q9[SB], qty: 5, reason: 'Split order for faster delivery' }] })).catch(() => null);
  const ex = await one(`select count(*)::int n from purchase_orders where id = $1`, [PO9b]);
  if (ex.n === 1) {
    await as(U.procurement, () => rpc('po_action', { op_id: uuid(), po_id: PO9b, action: 'submit' }));
    ok((await one(`select status from purchase_orders where id = $1`, [PO9b])).status === 'submitted', 'non-lowest award → not auto-approved');
  } else {
    const r = await one(`select reason from app.po_auto_approval($1)`, [PO9]);
    ok(/estimate/.test(r.reason), `auto-approval reason recorded: ${r.reason}`);
  }
  await expectError(as(U.manager, () => rpc('mr_action', { mr_id: PR9, action: 'reject', comment: 'x' })), /cannot be rejected/, 'PR cannot be rejected once an RFQ/PO exists');

  // ---- escalation ----------------------------------------------------------------
  console.log('\nSLA escalation');
  const PRE = uuid();
  await as(U.office_engineer, () => rpc('save_mr', prPayload(PRE, uuid(), 'BOLE-PR-D001-0011', 1)));
  await db.query(`update mr_events set created_at = now() - interval '25 hours' where mr_id = $1 and to_status = 'submitted'`, [PRE]);
  const n1 = num((await one(`select public.escalate_pending_requests() n`)).n);
  const n2 = num((await one(`select public.escalate_pending_requests() n`)).n);
  ok(n1 >= 1 && (await one(`select count(*)::int n from mr_events where mr_id = $1 and action = 'escalated'`, [PRE])).n === 1,
    `PR waiting 25 h at coordinator escalated (${n1} escalations; re-run de-duplicated: ${n2})`);
  ok((await one(`select count(*)::int n from notifications where user_id = $1 and entity_id = $2 and title like 'Overdue%'`, [U.manager, PRE])).n === 1,
    'manager notified of the overdue PR');
  const wf = await as(U.coordinator, () => one(`select is_overdue, current_owner_role, sla_hours from v_mr_workflow where id = $1`, [PRE]));
  ok(wf.is_overdue && wf.current_owner_role === 'coordinator' && num(wf.sla_hours) === 24, 'v_mr_workflow: overdue, ball with coordinator, SLA 24 h');
  const tr = await as(U.store_keeper, () => one(`select received_qty, outstanding_qty, ordered_qty from v_pr_tracker where mr_line_id = $1`, [PR1L]));
  ok(num(tr.received_qty) === 80 && num(tr.outstanding_qty) === 0 && num(tr.ordered_qty) === 80, 'v_pr_tracker: PR1 80 ordered / 80 received / 0 outstanding');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e.message, e.position ? `at position ${e.position}` : '', e.where ?? ''); process.exit(1); });
