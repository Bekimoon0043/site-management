# Material Procurement Workflows (Purchase / Site Use) & Monthly Look-ahead — Research + Spec

Status: implementation-ready spec, 30 Oct 2026. Builds on migrations `0001`–`0007`
(`material_requests`, `mr_lines`, `mr_events`, `mr_action`, `post_grn`, `post_miv`, `acknowledge_miv`,
RFQ / quotation / award / PO in `0005`, Ethiopian calendar helpers + `security` role in `0007`).
Assumes the parallel schedule spec: `schedule_tasks`, `task_boq_links`, task↔element links, task predecessor links.

Contents
1. Research findings (what practice says, and what we take from it)
2. Decision: one table with `request_type`, not a new `purchase_requests` table
3. Flow A — Purchase Request (PR) state machine
4. Flow B — Site Use Request (SUR) state machine
5. Cross-flow rules: no stock → PR, approval limits, escalation, notifications
6. Data model changes (DDL) for the two flows
7. RPC changes (`save_mr`, `mr_action`, new procurement/store RPCs, status refresh)
8. Monthly look-ahead: method
9. Look-ahead data model, views, RPCs
10. Calendars & Ethiopian holidays 2026–2027
11. Migration plan, tests, open questions
12. Sources

---

## 1. Research findings

| Topic | Finding | What we do |
|---|---|---|
| PR vs material requisition vs PO | A **purchase requisition** is an internal request to *buy*, approved inside the company and turned into the external, binding **PO**. A **material requisition / issue request** draws goods that are *already in store*; the storekeeper issues only against an authorised requisition, and the receiver signs the issue voucher. A store request that can't be met triggers replenishment. [1][2][3][4][16] | Two document types: `purchase` (→ RFQ/PO → GRN) and `site_use` (→ MIV → acknowledgement). A short site-use request can spawn a linked PR. |
| ERPNext | One **Material Request** doctype with a `material_request_type` (Purchase, Material Issue, Material Transfer, Manufacture…). Purchase type → RFQ → Supplier Quotation → PO; Issue type → Stock Entry. Statuses include Pending / Ordered / Issued / Received. [5][6] | Same pattern: one table + type discriminator. Shared lines, events, versions, offline outbox. |
| SAP release strategy | Approval is driven by *characteristics*, typically total value + purchasing group. Up to 8 release codes (levels). Release happens at header or item level. Tiered value bands are common. [7] | `approval_limits` gets `doc_type`. Header-level release with per-line partial qty. A value above the approver's limit needs a second, higher sign-off. |
| Odoo / Kojo / Procore | Odoo add-ons: employee → department manager → requisition officer → PO with one click. Kojo: configurable approval *levels per job*. Requester sees which level the request is at. Purchasing can override levels. **Converting to purchase is irreversible and locks the requisition.** Procore: sequential "ball-in-court" approvers. Only approved POs with an ETA and lines flow into receiving. [8][9][10][11] | Explicit "ball in court" (`current_owner_role`) on each MR. Procurement acceptance locks the PR's lines. Only approved/sent POs appear in the store's expected-delivery list. |
| Delegation of authority | A DoA matrix assigns approval by role × value band (× category). Never approve your own request. Keep delegation records for audit. [12] | Self-approval is blocked. `approval_delegations` gives temporary cover (e.g. manager on leave). |
| Three quotations | Ethiopian public procurement (Proc. 649/2009, replaced by Proc. 1430/2016 E.C. (2024) and a 2025 directive with RFQ thresholds) requires RFQ from **at least 3** suppliers for readily available goods below a threshold. Private contractors copy this as "3 proformas". [13][14] | Already in `project_settings.min_quotes` + `rfqs.min_quotes_override_reason`. Add `direct_purchase_limit` below which procurement may buy directly (cash/single proforma) with a reason. |
| Ethiopian contractor practice | Ethiopian studies (Jimma, AAU, Mekelle) put time and cost overrun down to weak material planning and late procurement. Ethiopian LPS studies find positive readiness. Material and labour barriers rank high. [15][17][18] | The look-ahead must drive purchase requests early enough to cover the lead time. Material constraints are first-class. |
| Last Planner System | Levels: master → phase → **look-ahead (make-ready, 2–6 weeks)** → **weekly work plan** → learning. Look-ahead tasks are screened for constraints. Each constraint gets an owner and a date in a constraint log. Only *ready* tasks go into the WWP. **PPC** = completed commitments / planned commitments per week. Reasons for non-completion are recorded with standard categories. [19][20][21][22][23] | `lookahead_items` + `lookahead_constraints` (+ event log) + `weekly_commitments` + `rnc_reasons`; views `v_ppc`, `v_constraint_removal`. |
| Seven preconditions (Koskela) | Information (drawings/RFIs), materials, crew, equipment, space, previous (predecessor) work, external conditions (weather, permits). If **any one** is missing, the task can't be done. [24] | Constraint types = these 7 + `approval` and `inspection` (hold points). Auto-detected where we have data. |
| Material constraint closure | A material constraint counts as cleared when the material is **bought and promised for delivery on time** (not only when it is on site). The look-ahead horizon is set by procurement lead times (2/3/6 weeks). [20][25] | Material constraint status is computed from stock, open PO ETA vs need-by date, and PR status. |
| Percent constraint removal | PPC measures shielding. The make-ready process needs its own metric: PCR = constraints removed on time / due. More task anticipation correlates with higher PPC. [21] | `v_constraint_removal` (PCR) next to `v_ppc`. |
| MS Project data | MSPDI XML: `Calendars/Calendar/WeekDays` + `Exceptions`, `Tasks/Task` with `OutlineLevel`, `Summary`, `Milestone`, Start/Finish, `PercentComplete`. [26] | Calendar import fills `project_calendars` / `calendar_exceptions` (`source='msp_import'`). Task fields as in the schedule spec. |
| Ethiopian work week & holidays | 48 h/week cap, usually 8 h × 6 days (Mon–Sat). Holiday work is paid at 250%. Public holidays per Proclamation 29/1996 (+ amendments), Islamic dates are tentative (moon sighting). [27][28][29][30] | Default work week Mon–Sat. National holiday table, editable, with `is_tentative`. |

## 2. Decision — `request_type` on `material_requests`

**Recommended: add `request_type text not null default 'site_use' check (request_type in ('site_use','purchase'))`
to `material_requests`, with a workflow per type in one `mr_action`.**

Why (and why not a separate `purchase_requests` table):
- Lines, element split, BoQ balance checks (`app.mr_submit`), versions (`mr_versions`), events, offline numbering,
  outbox replay, `v_my_approvals`, notifications, and the existing `rfq_lines.mr_line_id` / `po_lines.mr_line_id` /
  `grn_lines.mr_line_id` FKs all key on `mr_lines`. A second table would mean copying all of that or adding polymorphic FKs.
- ERPNext does the same (one doctype, `material_request_type`). The mobile app reuses one form with a type toggle.
- Type is **immutable after first submit**. A PR is "converted from" a SUR through `source_mr_id`, never by flipping the type.
- Numbering: separate prefixes so paper copies differ: `PR-<proj>-<dev>-0001` and `SR-<proj>-<dev>-0001` (the device prefix scheme stays the same).
- Existing rows → `site_use`. Rows created by `create_mr_from_suggestions` (reorders) → `purchase`.
  Legacy statuses `sourced`/`ordered` stay valid for `purchase`.

## 3. Flow A — Purchase Request (newly purchased items)

Actors: **Office Engineer** raises (also coordinator, store keeper/procurement for reorders, look-ahead auto-drafts) →
**Coordinator** reviews → **Manager** (management team) approves → **Procurement** accepts and buys (RFQ/quotes/PO or
direct purchase) → **Store Keeper** is told about the coming delivery, acknowledges it, and confirms receipt with a GRN → **requester**
(and the original site engineer if converted from a SUR) is informed.

### 3.1 States

| Status (`mr_status`) | Meaning | Ball in court |
|---|---|---|
| `draft` | Being prepared (also look-ahead auto-drafts) | requester |
| `submitted` | Sent to coordinator | coordinator |
| `returned` | Sent back for clarification (comment required) | requester |
| `reviewed_by_coordinator` *(new)* | Coordinator checked need/qty/spec/budget, may have trimmed qty | manager |
| `approved_by_management` *(new)* | Manager approved (full or partial). Lines are frozen | procurement |
| `with_procurement` *(new)* | Procurement accepted and owns it (SLA clock for RFQ/PO starts) | procurement |
| `sourced` *(existing)* | RFQ sent / quotes being compared / PO in draft or approval | procurement |
| `ordered` *(existing; UI label "Purchased")* | PO approved and sent to supplier, or direct purchase made | procurement |
| `delivery_expected` *(new)* | Procurement issued a delivery notice to the store (ETA, vehicle) | store keeper |
| `partially_received` *(new)* | GRN accepted part of the approved qty | procurement / store |
| `received` *(new)* | Accepted qty ≥ approved qty on every line (or remaining lines short-closed) | requester (informational) |
| `closed` | Done (auto when `received`, or manual short-close with reason) | — |
| `rejected` | Rejected with reason by coordinator or manager | — |
| `cancelled` | Cancelled (requester before approval; coordinator/manager until a PO is sent) | — |

> Not adding a separate `purchased` value: `ordered` is already maintained by `app.refresh_mr_procurement` and
> referenced by views. The UI shows it as **"Purchased"**. A direct (cash) purchase also lands in `ordered`, because it is
> recorded as a PO with `purchase_method='direct'`, so the GRN still matches against a PO line.

### 3.2 Transition table (`mr_action` with `request_type='purchase'`)

| # | From | Action | Role(s) | To | Guards / side effects |
|---|---|---|---|---|---|
| A1 | draft, returned | `submit` (via `save_mr {submit:true}`) | office_engineer, coordinator, store_keeper, procurement, manager, admin | submitted | `app.mr_submit` checks (lines, BoQ reason). Element split is **optional** for PR (stock/reorder buys aren't element-specific). It is required if `source_mr_id` is null and the project has `pr_requires_elements`. Notify coordinators. |
| A2 | submitted | `review` | coordinator (admin) | reviewed_by_coordinator | Optional `lines[].reviewed_qty ≤ qty`. Optional `comment`. Records `coordinator_reviewed_by/at`. Notify managers. If est. value ≤ `project_settings.pr_coordinator_final_limit` (default null = off), coordinator may `approve` directly (A3 shortcut). |
| A3 | reviewed_by_coordinator | `approve` | manager (admin) | approved_by_management | Partial approval: `lines[].approved_qty ≤ coalesce(reviewed_qty, qty)`. 0 removes the line. **Value check:** est. value (§5.2) vs approver's `approval_limits(doc_type='purchase_request')`. If over the limit → action becomes `endorse`, status stays and the request is routed to a higher approver. Self-approval blocked. Notify procurement (critical if priority ≠ normal) + requester. |
| A4 | submitted, reviewed_by_coordinator | `return` | coordinator, manager | returned | Comment required. Notify requester. Resubmission restarts at A1, version+1. |
| A5 | submitted, reviewed_by_coordinator, approved_by_management | `reject` | coordinator (from submitted), manager (any of these) | rejected | Reason required. Not allowed once any RFQ is sent or PO exists. Notify requester (+ SUR requester if converted). |
| A6 | approved_by_management | `accept` | procurement | with_procurement | Records `procurement_owner` (= actor, or `p.assign_to` by procurement lead). Locks lines (Kojo pattern). Notify requester "with procurement". |
| A7 | approved_by_management, with_procurement | `return` | procurement | returned | Spec unclear / item unavailable / suggest equivalent. Comment required. Approvals are cleared, so resubmission goes back through coordinator and manager. |
| A8 | with_procurement (or approved_by_management) | *(auto)* RFQ sent / PO draft for any line | procurement | sourced | `app.refresh_mr_procurement` (extended). |
| A9 | sourced, with_procurement | *(auto)* PO `approved`→`send`, or `record_direct_purchase` | procurement (+ PO approver per BR-08) | ordered | Notify requester "Purchased — PO no., supplier, ETA". PO auto-approval rule §5.3. |
| A10 | ordered, partially_received | `notify_store_delivery` RPC | procurement | delivery_expected | Creates `delivery_notices` row (ETA, vehicle plate, driver phone, items/qty). Notifies **store keepers of the PO delivery store + security** (gate expects the vehicle). Status also auto-moves when ETA ≤ today + `delivery_notice_days` and delivery_status ∈ (confirmed, dispatched). |
| A11 | delivery_expected | `acknowledge_delivery_notice` RPC | store_keeper | (unchanged) | Store keeper "accepts" the notice (space/labour ready, or proposes another date → notify procurement). Recorded on the notice and in `mr_events`. |
| A12 | ordered, delivery_expected, partially_received | *(auto)* `post_grn` against PO lines linked to the PR | store_keeper | partially_received / received | The GRN **is** the store keeper's confirmation. Rejected qty → quarantine. Shortfall stays open on the PO. Notify requester + coordinator + procurement "Received n of m". If converted from a SUR, notify that SUR's requester and store keeper "now issuable" (§5.1). |
| A13 | received | *(auto)* | — | closed | When every PR line is fully accepted. |
| A14 | ordered…partially_received | `close` (short-close) | procurement, coordinator, manager | closed | Reason required. Closes the PO lines' remaining qty only if the PO is closed separately. Here we only stop tracking. |
| A15 | draft, submitted, returned, reviewed_by_coordinator | `cancel` | requester | cancelled | |
| A16 | approved_by_management, with_procurement, sourced | `cancel` | coordinator, manager | cancelled | Reason required. Blocked if a PO line is `sent`+. Cancel the PO first. Draft RFQ/PO lines are detached. |

Escalation (pg_cron, extended `escalate_pending_requests`): per-status SLA hours from
`project_settings.wf_sla_hours` (defaults: submitted 24 → notify manager; reviewed_by_coordinator 24 → notify all managers + admin;
approved_by_management 8 → procurement lead; with_procurement 72 without RFQ/PO → coordinator + manager;
delivery_expected: ETA passed + 1 day without GRN → procurement + coordinator). Urgent/critical halve the SLA.
Every escalation writes `mr_events(action='escalated', payload {status, hours})` and is de-duplicated per window (existing pattern).

## 4. Flow B — Site Use Request (from store)

Actors: **Site Engineer** requests → **Office Engineer** reviews qty vs BoQ/take-off and forwards → **Coordinator** approves
and "orders the store" → **Store Keeper** issues (MIV) → **Site Engineer** acknowledges receipt.

### 4.1 States

| Status | Meaning | Ball in court |
|---|---|---|
| `draft` | Being prepared on the phone (offline OK) | site engineer |
| `submitted` | Waiting for office engineer review | office engineer |
| `returned` | Back to requester for clarification | site engineer |
| `reviewed` *(existing; UI "Forwarded to coordinator")* | OE checked qty vs BoQ/take-off, element split, drawing ref, and set `reviewed_qty` | coordinator |
| `approved` *(existing; UI "Store order issued")* | Coordinator approved (full/partial) and the store order went to the store keeper | store keeper |
| `partially_issued` *(existing)* | Some approved qty issued (or stock short — see §5.1) | store keeper |
| `issued` *(existing)* | All approved qty issued, awaiting acknowledgement | site engineer |
| `received` *(new, shared)* | Every non-reversed MIV for the request is acknowledged by the requester | — |
| `closed` | Auto 24 h after `received`, or manual (short-close remaining with reason) | — |
| `rejected`, `cancelled` | as today | — |

### 4.2 Transition table (`request_type='site_use'`)

| # | From | Action | Role(s) | To | Guards / side effects |
|---|---|---|---|---|---|
| B1 | draft, returned | `submit` | site_engineer (also office_engineer, coordinator on behalf) | submitted | Existing `app.mr_submit`: element split required, over-BoQ reason, lead-time warning. Notify OEs only (no longer coordinators/managers, which cuts noise). Urgent → also coordinator. |
| B2 | submitted | `review` | office_engineer | reviewed | `lines[].reviewed_qty`. Server returns **stock check** per line: available-to-issue in `store_id` (§5.1). The OE sees "short by X" and can choose B2a. Notify coordinators. If `require_review=false`, B2 is skipped and coordinator acts on `submitted`. |
| B2a | submitted, reviewed | `convert_shortfall` | office_engineer, coordinator | (unchanged) + new PR | Creates a linked PR (§5.1). The SUR continues with available qty. |
| B3 | reviewed (or submitted if no review) | `approve` | coordinator (manager, admin) | approved | `lines[].approved_qty ≤ coalesce(reviewed_qty, qty)`. Optional `issue_by` date, `store_id`. Value limit `doc_type='site_use'` (usually unlimited). Notify **store keepers of `store_id`** "Store order SR-…: issue to <requester> by <date>" + requester. |
| B4 | submitted, reviewed | `return` | office_engineer, coordinator | returned | Comment required. |
| B5 | submitted, reviewed, approved (nothing issued) | `reject` | coordinator, manager | rejected | Reason required. |
| B6 | approved, partially_issued | *(auto)* `post_miv` with `mr_line_id`s | store_keeper | partially_issued / issued | Existing guards (no over-issue, grade). MIV `pending_ack`. Notify requester "Collect / acknowledge". |
| B7 | issued, partially_issued | *(auto)* `acknowledge_miv` (all MIVs acknowledged and status `issued`) | requester (site_engineer) | received | Existing signature/photo. Disputed qty → `regularise_miv`. |
| B8 | received | *(auto, 24 h)* or `close` | store_keeper, coordinator | closed | |
| B9 | approved, partially_issued | `close` (short-close) | coordinator, store_keeper | closed | Reason required. Unissued approved qty is released from reservation. |
| B10 | draft…approved (nothing issued) | `cancel` | requester (before approval), coordinator/manager (after) | cancelled | As today. |

Escalation SLAs: submitted 8 h → coordinator; reviewed 8 h → manager; approved but nothing issued by `issue_by`/required_date →
store keeper + coordinator (critical); issued but not acknowledged 24 h → requester + coordinator (existing `v_overdue_emergency_issues` pattern).

## 5. Cross-flow rules

### 5.1 Site-use request finds no (or not enough) stock

1. **Available-to-issue** (ATI) per store × spec =
   `available ledger qty − Σ(approved_qty − issued) of other approved/partially_issued site_use lines for that store`
   (reservation by approval, FIFO by `approved_at`). New view `v_stock_available_to_issue`.
2. On `review`/`approve` the RPC returns `{lines:[{id, requested, ati, other_stores:[{store_id, qty}], open_po:[{po, eta, qty}]}]}`.
   Mobile/web show three options for a shortfall:
   - **Transfer** from another project store (existing `send_transfer`) if another store has ATI.
   - **Wait for open PO** if an open PO line has ETA ≤ line required date (no new PR).
   - **Convert shortfall to purchase request** (`mr_action {action:'convert_shortfall', lines:[{id, qty}]}`).
     It creates a `purchase` MR with `source_mr_id = SUR.id`, number `PR-…`, `requested_by = actor` (OE),
     `requester_role`, same block/store/required_date/priority, `is_lookahead` copied. Lines carry `source_mr_line_id`
     and the element split. Status `submitted`, so it enters Flow A at the coordinator. Event `convert_shortfall` on both
     requests. The SUR line keeps its approved qty (it waits). The UI shows "awaiting PR-… (status)".
3. When the PR's GRN posts, `post_grn` notifies the SUR requester and the store keeper "SR-… line n now issuable (x available)".
   The store keeper issues against the **SUR** line (not the PR line). So the PR tracks buying and the SUR tracks consumption,
   and per-element consumption stays on the SUR/MIV.
4. Auto-suggest: if ATI = 0 for a line at `submit`, the app shows a banner straight away ("No stock in Main Store — convert to purchase?").
   Only OE/coordinator may convert, because the site engineer doesn't raise PRs under the client flow.

### 5.2 Value-based approval limits (BR-08 extended)

- `approval_limits` += `doc_type text not null default 'any' check (doc_type in ('any','purchase_request','site_use','po'))`,
  `user_id uuid null` (per-person override beats per-role). The unique key becomes `(project_id, role, doc_type, user_id)` nulls not distinct.
- Estimated PR value = Σ approved_qty × best known price: latest `price_observations` (≤ 90 days) → else `spec_prices` → else
  null ("unpriced"). Unpriced lines don't block but show "value unknown". The estimate is stored in the price-restricted
  `mr_estimates(mr_id, est_value, priced_lines, unpriced_lines, computed_at)` (site roles can't see prices).
- If value > approver limit: the action records `endorse` (an `mr_approvals` row) and notifies users whose limit covers the value.
  Final `approve` must come from a covering approver. Every sign-off is kept in `mr_approvals` (doc audit, DoA evidence).
- Suggested defaults (client to confirm, Open Q 1): coordinator final ≤ ETB 50,000 (only if `pr_coordinator_final_limit` set),
  manager ≤ ETB 1,000,000, above → manager with `user_id` override (GM/owner) or `admin`.
- `approval_delegations(id, project_id null, from_user, to_user, doc_type, valid_from, valid_to, reason)`: a delegate
  inherits the delegator's limit inside the window. Self-approval is always blocked (`requested_by <> auth.uid()`).

### 5.3 PR → RFQ / PO

- `save_rfq` / `save_po` may reference `mr_line_id` only if the MR is `request_type='purchase'` and status in
  (`approved_by_management`,`with_procurement`,`sourced`,`ordered`,`partially_received`), plus legacy `approved` purchase rows.
  `app.check_mr_line` qty guard uses `approved_qty`. Several PR lines may consolidate into one RFQ line (keep `rfq_line_sources`
  if consolidation is needed; v1: one RFQ line per PR line, same spec). One PR may split across several POs/suppliers (per-line award).
- New RPC `create_rfq_from_prs(p {op_id, id, number, mr_line_ids[], supplier_ids[], required_by, delivery_store_id})`,
  pre-filled from PRs. `min_quotes` from settings. Below `direct_purchase_limit`, procurement may skip RFQ:
  `record_direct_purchase(p {op_id, po_id, number, supplier_id, lines:[{mr_line_id, qty, unit_price}], receipt_ref, reason})`
  creates a PO with `purchase_method='direct'`, status `sent`, `approved_by = mgmt approver of the PR`.
- **PO approval when the PR is already management-approved:** a PO is auto-approved at `submit` if
  (a) every line traces to an `approved_by_management`+ PR line, (b) PO total ≤ Σ PR estimate × (1 + `po_tolerance_pct`, default 10%),
  and (c) the supplier was the lowest landed cost (`rfq_awards.is_lowest`). Otherwise the existing `po_action approve` with
  `doc_type='po'` limits applies. This avoids approving the same purchase twice.
- `purchase_orders.purchase_method text default 'rfq' check (in ('rfq','direct','framework'))`.

### 5.4 Store keeper notification of expected deliveries

New table `delivery_notices` (one per PO per expected trip):

```sql
create table public.delivery_notices (
  id              uuid primary key,
  project_id      uuid not null references public.projects (id),
  po_id           uuid not null references public.purchase_orders (id),
  store_id        uuid not null references public.stores (id),
  expected_date   date not null,
  expected_window text,                      -- e.g. '08:00-12:00'
  vehicle_plate   text, driver_name text, driver_phone text,
  lines           jsonb not null,            -- [{po_line_id, qty}] expected on this trip (no prices)
  status          text not null default 'notified'
                  check (status in ('notified','acknowledged','reschedule_requested','arrived','received','cancelled')),
  ack_by          uuid references public.profiles (id), ack_at timestamptz, ack_note text,
  grn_id          uuid references public.grns (id),
  created_by      uuid not null references public.profiles (id) default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
```

- `notify_store_delivery(p)` (procurement/coordinator): inserts, moves linked PRs to `delivery_expected`, notifies store
  keepers of `store_id` and `security` ("Expect vehicle AA-3-12345 on 3 Nov").
- `acknowledge_delivery_notice(p {op_id, id, decision:'accept'|'reschedule', note, proposed_date})` (store_keeper).
- Gate: `vehicle_movements` (direction in) may link `linked_doc_type='delivery_notice'` → status `arrived`. Extend the check list.
- `post_grn` accepts optional `delivery_notice_id` → status `received`, `grn_id` set.
- Store-keeper home: "Expected this week" = `v_expected_deliveries` + notices, grouped by date. These rows are offline-synced (no prices).

### 5.5 Notifications per step (in-app + push; Telegram per `notification_prefs`)

| Event | Recipients | Critical? |
|---|---|---|
| PR submitted | coordinators | if urgent |
| PR reviewed by coordinator | managers (+ covering approvers if over limit) | if urgent |
| PR approved / partially approved | procurement, requester | if urgent |
| PR returned / rejected | requester (+ SUR requester if converted) | no |
| PR accepted by procurement | requester | no |
| RFQ sent / PO sent ("Purchased") | requester, coordinator | no |
| Delivery notice | store keepers of store, security, requester | if ETA ≤ 1 day |
| Store keeper reschedule request | procurement | yes |
| GRN posted against PR | requester, coordinator, procurement (+ SUR requester & store keeper if converted) | no |
| Delivery overdue (ETA + 1 day) | procurement, coordinator | yes |
| SUR submitted | office engineers (+ coordinator if urgent) | if urgent |
| SUR reviewed / forwarded | coordinators | if urgent |
| SUR approved = store order | store keepers of store, requester | if urgent |
| SUR shortfall converted | coordinators (PR), requester (SUR) | no |
| MIV posted | requester ("acknowledge receipt") | if urgent |
| MIV not acknowledged 24 h | requester, coordinator | yes |
| Any escalation | next role up per §3/§4 | yes |

## 6. Data model changes for the two flows

Migration **`20261030000001_mr_enum.sql`** (alone, because new enum values can't be used in the same transaction; see note in 0007):

```sql
alter type public.mr_status add value if not exists 'reviewed_by_coordinator' after 'reviewed';
alter type public.mr_status add value if not exists 'approved_by_management' after 'approved';
alter type public.mr_status add value if not exists 'with_procurement' after 'approved_by_management';
alter type public.mr_status add value if not exists 'delivery_expected' after 'ordered';
alter type public.mr_status add value if not exists 'partially_received' after 'delivery_expected';
alter type public.mr_status add value if not exists 'received' after 'issued';
```

Migration **`20261030000002_procurement_workflows.sql`**:

```sql
alter table public.material_requests
  add column if not exists request_type text not null default 'site_use'
      check (request_type in ('site_use','purchase')),
  add column if not exists source_mr_id uuid references public.material_requests (id),   -- PR converted from SUR
  add column if not exists lookahead_plan_id uuid,                                        -- FK added in look-ahead migration
  add column if not exists current_owner_role text,                                       -- ball in court (denormalised, for inbox/ageing)
  add column if not exists coordinator_reviewed_by uuid references public.profiles (id),
  add column if not exists coordinator_reviewed_at timestamptz,
  add column if not exists procurement_owner uuid references public.profiles (id),
  add column if not exists procurement_accepted_at timestamptz,
  add column if not exists issue_by date,                                                 -- SUR: coordinator's store order date
  add column if not exists received_at timestamptz,
  add column if not exists closed_at timestamptz,
  add column if not exists status_reason text;
create index if not exists material_requests_type_status_idx on public.material_requests (project_id, request_type, status);
create index if not exists material_requests_source_idx on public.material_requests (source_mr_id) where source_mr_id is not null;
-- type is immutable once submitted
create trigger mr_type_immutable before update of request_type on public.material_requests
  for each row when (old.status <> 'draft' and new.request_type <> old.request_type) execute function app.block_mutation();
update public.material_requests r set request_type = 'purchase' where purpose = 'Reorder';   -- created by create_mr_from_suggestions

alter table public.mr_lines
  add column if not exists reviewed_qty numeric(16,3) check (reviewed_qty >= 0),          -- OE (SUR) or coordinator (PR) recommendation
  add column if not exists source_mr_line_id uuid references public.mr_lines (id),
  add column if not exists lookahead_item_id uuid,                                         -- FK in look-ahead migration
  add column if not exists qty_received numeric(16,3) not null default 0,                  -- PR: accepted via GRN (maintained)
  add column if not exists line_status text not null default 'open'
      check (line_status in ('open','short_closed','cancelled'));

-- Every sign-off (review, endorse, approve, accept) — DoA evidence; also lets one MR collect several approvals.
create table public.mr_approvals (
  id          uuid primary key default gen_random_uuid(),
  mr_id       uuid not null references public.material_requests (id) on delete cascade,
  project_id  uuid not null references public.projects (id),
  step        text not null check (step in ('oe_review','coordinator_review','endorse','approve','procurement_accept')),
  actor       uuid not null references public.profiles (id),
  actor_role  public.app_role not null,
  est_value   numeric(18,2),       -- null for site roles' view; table is price-restricted for reads
  limit_used  numeric(18,2),
  delegated_from uuid references public.profiles (id),
  comment     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.mr_estimates (                       -- price-restricted (app.can_see_prices())
  mr_id uuid primary key references public.material_requests (id) on delete cascade,
  project_id uuid not null references public.projects (id),
  est_value numeric(18,2), priced_lines int, unpriced_lines int, computed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.approval_limits
  add column if not exists doc_type text not null default 'any'
      check (doc_type in ('any','purchase_request','site_use','po')),
  add column if not exists user_id uuid references public.profiles (id);
alter table public.approval_limits drop constraint if exists approval_limits_project_id_role_key;
create unique index approval_limits_key on public.approval_limits (project_id, role, doc_type, user_id) nulls not distinct;

create table public.approval_delegations (
  id uuid primary key, project_id uuid references public.projects (id),
  from_user uuid not null references public.profiles (id), to_user uuid not null references public.profiles (id),
  doc_type text not null default 'any', valid_from date not null, valid_to date not null, reason text not null,
  created_by uuid not null references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (valid_to >= valid_from), check (from_user <> to_user)
);

alter table public.project_settings
  add column if not exists wf_sla_hours jsonb not null default
    '{"pr":{"submitted":24,"reviewed_by_coordinator":24,"approved_by_management":8,"with_procurement":72},
      "sur":{"submitted":8,"reviewed":8,"issued_unacked":24}}'::jsonb,
  add column if not exists pr_coordinator_final_limit numeric(18,2),   -- null = management always approves (client flow)
  add column if not exists direct_purchase_limit numeric(18,2) not null default 0,
  add column if not exists po_tolerance_pct numeric(5,2) not null default 10,
  add column if not exists delivery_notice_days int not null default 2,
  add column if not exists pr_requires_elements boolean not null default false,
  add column if not exists sur_auto_close_hours int not null default 24;

alter table public.purchase_orders
  add column if not exists purchase_method text not null default 'rfq' check (purchase_method in ('rfq','direct','framework'));
-- + delivery_notices (§5.4); app.extend_check_values('public.vehicle_movements','linked_doc_type', array[...,'delivery_notice'])
```

RLS: new tables follow the project-member read policy. `mr_approvals.est_value`/`limit_used` → move to `mr_estimates`-style
restricted read, or null them in a `v_mr_approvals` security-invoker view for non-price roles. Writes go through RPCs only (existing pattern).

Views:
- `v_stock_available_to_issue(project_id, store_id, material_spec_id, available, reserved, ati)`.
- `v_mr_workflow` — one row per MR: type, status, `current_owner_role`, age in current status (from last `mr_events`),
  SLA due, overdue flag, `source_mr_id`, linked PR/PO/GRN numbers. Replaces `v_request_ageing` for both flows.
- `v_pr_tracker` — per PR line: approved, on RFQ, on PO (sent), ETA, delivery notice, accepted, outstanding.
- Update `app.approvals_for` kinds: `sur_review` (OE, status submitted, site_use), `sur_approve` (coordinator),
  `pr_review` (coordinator, purchase, submitted), `pr_approve` (manager, reviewed_by_coordinator, covering limit),
  `pr_accept` (procurement, approved_by_management), `delivery_ack` (store keeper, notices `notified`),
  `miv_ack` (requester).

## 7. RPC changes

All keep the conventions: `fn(p jsonb) returns jsonb`, `security definer set search_path = public`, `app.op_seen/op_done`
with `op_id`, readable exceptions, `mr_events` row per transition, notifications via `app.notify_user/notify_roles(_txt)`.

| RPC | Change |
|---|---|
| `save_mr` | Accept `request_type` (insert only; immutable after draft). Role gate per type: `site_use` → site_engineer, office_engineer, coordinator, admin. `purchase` → office_engineer, coordinator, manager, procurement, store_keeper, admin. Numbering prefix check (`SR-`/`PR-`). Editing a `submitted` request returns it to `draft` (existing). |
| `app.mr_submit` | Branch: SUR → current checks. PR → element split optional (unless `pr_requires_elements`). Recipients per §5.5. Set `current_owner_role`. Compute `mr_estimates` for PR. |
| `mr_action` | Dispatch `case r.request_type`. Actions: `review`, `approve` (→ `endorse` when over limit), `return`, `reject`, `accept` (PR, procurement), `convert_shortfall` (SUR), `cancel`, `close`. Enforce the §3.2/§4.2 tables exactly; one helper `app.mr_transition(r, v_to, v_action, v_comment, payload)` writes status, `current_owner_role`, `mr_events`, notifications. Returns `{ok,id,status,stock?:[…],pr_id?}`. |
| `app.refresh_mr_procurement` | Purchase rows: from `approved_by_management`/`with_procurement`/`sourced`/`ordered`/`delivery_expected`/`partially_received`. Compute `received` (all open lines `qty_received ≥ approved_qty`) → `partially_received` (any) → `delivery_expected` (open notice) → `ordered` (PO sent) → `sourced` (RFQ sent / PO draft) → keep. Maintain `mr_lines.qty_received` from GRN lines with `po_line.mr_line_id`. `received` → auto `closed`. |
| `app.refresh_mr_status` | Site-use only: `approved`→`partially_issued`→`issued`→`received` (all non-reversed MIVs `acknowledged`). Purchase rows skip the issue logic (a PR is never issued). |
| `acknowledge_miv` | After ack, call `app.refresh_mr_status` for affected MRs (to reach `received`). |
| `post_grn` | Optional `delivery_notice_id`. After posting, refresh PRs. For PR lines with `source_mr_line_id`, notify the SUR requester + store keepers "now issuable". |
| `create_mr_from_suggestions` | Set `request_type='purchase'`, enter at `submitted` → coordinators. |
| **new** `create_rfq_from_prs`, `record_direct_purchase`, `notify_store_delivery`, `acknowledge_delivery_notice`, `save_approval_delegation` | §5.3/§5.4. |
| `escalate_pending_requests` | Per-type, per-status SLA from `wf_sla_hours`. Target role per §3/§4. |

Sketch — dispatch core of `mr_action` (purchase branch):

```sql
when r.request_type = 'purchase' and v_action = 'approve' then
  perform app.require_role('manager','admin');            -- coordinator only via pr_coordinator_final_limit
  if r.status <> 'reviewed_by_coordinator' then raise exception 'Only coordinator-reviewed purchase requests can be approved (status: %)', r.status; end if;
  if r.requested_by = auth.uid() then raise exception 'You cannot approve your own request'; end if;
  perform app.apply_line_qty(r.id, p -> 'lines', 'approved_qty', 'coalesce(reviewed_qty, qty)');  -- partial approval
  v_value := app.mr_estimate(r.id);                          -- upserts mr_estimates
  v_limit := app.approval_limit_for(auth.uid(), r.project_id, 'purchase_request');   -- user > role, delegations
  insert into public.mr_approvals (mr_id, project_id, step, actor, actor_role, est_value, limit_used, comment)
  values (r.id, r.project_id, case when v_limit is not null and v_value > v_limit then 'endorse' else 'approve' end,
          auth.uid(), app.my_role(), v_value, v_limit, v_comment);
  if v_limit is not null and v_value > v_limit then
    perform app.notify_covering_approvers(r, v_value);       -- higher limit users
    return app.op_done(p, 'mr_action', jsonb_build_object('ok', true, 'id', r.id, 'status', r.status, 'endorsed', true));
  end if;
  v_to := 'approved_by_management';
```

## 8. Monthly look-ahead — method

**Goal:** a "Monthly Tasks Window" auto-generated on the 25th of each month (pg_cron) or on demand from the imported MS Project
schedule. It covers the **coming month + the 2 weeks after it** (rolling make-ready horizon), broken into weeks. Each task
is screened against the seven preconditions. Material needs come from BoQ/take-offs. Purchase requests are suggested
wherever lead time falls inside the window, and PPC is tracked every week.

### 8.1 Window

- Gregorian mode: `period_start = first day of month`, `period_end = last day`. Ethiopian mode: `period_start =
  app.from_ethiopian(y, m, 1)`, `period_end = period_start + 29` (Pagume: 5/6 days, merged into Meskerem's plan).
- `horizon_end = period_end + 14 days`.
- Weeks: **Mon–Sat** planning weeks (Sunday off; matches the 6-day week). Week 1 = the week containing `period_start`
  (clipped to `period_start`). The last week ends at `horizon_end`. Typically 6–7 weeks: 4–5 "month" weeks + 2 "make-ready buffer" weeks.
  Each week stores `working_days` from the project calendar (§10).

### 8.2 Task selection (from `schedule_tasks`)

Use the *forecast* dates if present, else planned. `s = coalesce(forecast_start, planned_start)`, `f = coalesce(forecast_finish, planned_finish)`.
Include a task when `not summary` and `pct_complete < 100` and `s <= horizon_end and f >= period_start`
(milestones included as zero-duration checkpoints). Also include **overdue** tasks (`f < period_start` and `pct_complete < 100`)
flagged `late`. Classification `window_role`:

| role | rule |
|---|---|
| `starting` | `s` within period |
| `finishing` | `f` within period and `s < period_start` |
| `ongoing` | `s < period_start and f > period_end` |
| `starting_next` | `s` in (period_end, horizon_end] (the make-ready buffer: constraints must clear now) |
| `late` | `f < period_start`, not complete |

Summary rows are shown as group headers only (WBS path), never committed.

### 8.3 Constraint screening (auto + manual)

For each item, `generate_lookahead` creates/refreshes **auto** constraints (`auto=true`, identified by `(item_id, type, source_ref)`),
and keeps manual ones:

| Type (Koskela) | Auto rule | Cleared when | Default owner |
|---|---|---|---|
| `predecessor` | each predecessor link whose task is not 100% (or its forecast finish + lag > item start) | predecessor complete | site engineer of predecessor |
| `material` | each material need (§8.4) with shortfall > 0 | need covered by ATI + PO lines with ETA ≤ need-by (material "bought and promised on time") | office engineer (SUR) / procurement (PR) |
| `approval` | an MR linked to the item is not yet approved (`submitted`…`reviewed_by_coordinator`) | MR approved | coordinator / manager |
| `inspection` | element has an open hold point (`element_activities` hold / `inspections` not passed) for the preceding activity | inspection passed | QA/office engineer |
| `information` | task has a drawing ref not marked `IFC`, or open RFI/instruction (from `diary_instructions`) linked to the element | manual clear | office engineer |
| `labour`, `equipment`, `space`, `external` (weather/permit) | manual only. Generation adds a *weather* advisory constraint for earthworks/concrete/roofing in Kiremt (mid-Jun–mid-Sep) | manual | site engineer |

Readiness = `ready` (no open constraints), `at_risk` (open constraints due within the period with owners and due dates),
`not_ready` (open constraint with due date passed, or `blocked`). Each constraint's `due_date` = item start − buffer
(material: −`safety_days`; others: −2 working days).

### 8.4 Material needs per activity

For each item → links (`task_boq_links` with qty or share, and task↔element links) → `element_takeoffs(element, spec, planned_qty)`:

```
total_need(spec)   = Σ planned_qty × (1 + wastage_pct/100)   [element take-off, or BoQ qty × link share via spec mapping]
remaining(spec)    = greatest(total_need × (1 − pct_complete/100) − issued_to_element(spec), 0)
in_window_share    = working_days(max(s, today, period_start) .. min(f, horizon_end)) / working_days(max(s, today) .. f)
window_need(spec)  = remaining × in_window_share
need_by_date       = add_working_days(greatest(s, period_start), −safety_days)   -- material on site before the task starts
weekly_need[w]     = remaining × working_days_in(w ∩ task) / remaining working days of task
```

Supply for the same spec (per project, delivery store): `ATI` (§5.1) + open PO outstanding with ETA ≤ need_by +
approved-not-ordered PR qty (counted as "in procurement", but still a risk) − demand already reserved by earlier items (allocate
by need_by order). `shortfall = window_need − covered`.

`order_by_date = add_working_days(need_by_date, −lead_time_days)` (spec lead time, or the supplier's actual lead time from PO history if known).
Flags: `raise_pr_now` if `order_by_date <= today + 7`, `late_order` if `order_by_date < today` (show expedite and alternative equivalent specs).
Also suggest a **site-use request** for needs covered by stock with need_by in the next 2 weeks (draft SUR for the site engineer).

### 8.5 Auto-suggested purchase requests

`create_prs_from_lookahead(p {op_id, plan_id, lines:[{spec_id, qty, need_by, item_ids[]}], submit:false})` → one `purchase`
MR per store (and per priority bucket), `is_lookahead = true`, `lookahead_plan_id`, `mr_lines.lookahead_item_id`, required_date = need_by.
Qty rounded up to `pack_size`. Created as **draft for the office engineer** (the client says the OE raises PRs). The OE edits
and submits, and Flow A runs. The item's `material` constraint links to the MR (`source_ref`) and clears automatically when covered.

### 8.6 Weekly cycle and PPC (Last Planner)

1. **Monthly (25th):** coordinator generates → office engineer reviews material needs, raises PRs → coordinator **publishes** the
   plan (notifies site engineers). Status `draft → published`.
2. **Weekly (Saturday / Monday meeting):** for next week, each site engineer (the "last planner") **commits** only items that
   are `ready` (override with reason → `at_risk` commitment), with a target (% progress or quantity) → `weekly_commitments`.
   Commitments lock when the week starts.
3. **During the week:** progress updates (`report_progress`) feed actual % → suggest completion.
4. **Week close (Saturday):** site engineer/coordinator marks each commitment `completed` / `not_completed` + **reason code**
   (LCI's 12 RNCs, with materials, prerequisite work, inspection, labour, design, weather…). `close_week` computes
   **PPC = completed / committed** and rolls not-completed work into the next week as new candidates. It also computes
   **PCR** = constraints cleared by due date / constraints due that week, and **TA** (tasks anticipated = WWP tasks that were in the look-ahead ≥ 2 weeks earlier).
5. **Learning:** dashboards show PPC trend (target ≥ 80%), RNC Pareto, PCR, constraint ageing by owner.

Roles: generate/publish = coordinator (office_engineer may generate drafts). Constraints = any project engineer and procurement
(owners update). Commit / close own commitments = site_engineer. Close week / override = coordinator. View = all incl. manager.
Store keeper sees the weekly material need list for their store.

## 9. Look-ahead data model, views, RPCs

Migration **`20261030000003_lookahead.sql`**:

```sql
create table public.lookahead_plans (
  id            uuid primary key,
  project_id    uuid not null references public.projects (id),
  calendar_mode text not null default 'gregorian' check (calendar_mode in ('gregorian','ethiopian')),
  period_label  text not null,                       -- '2026-11' or 'Hidar 2019'
  period_start  date not null, period_end date not null, horizon_end date not null,
  status        text not null default 'draft' check (status in ('draft','published','closed')),
  schedule_import_id uuid,                           -- schedule version used (from schedule spec)
  generated_at  timestamptz, generated_by uuid references public.profiles (id),
  published_at  timestamptz, published_by uuid references public.profiles (id),
  notes         text,
  created_at    timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (project_id, calendar_mode, period_start),
  check (period_end >= period_start and horizon_end >= period_end)
);

create table public.lookahead_weeks (
  id            uuid primary key default gen_random_uuid(),
  plan_id       uuid not null references public.lookahead_plans (id) on delete cascade,
  project_id    uuid not null references public.projects (id),
  week_no       int not null, week_start date not null, week_end date not null,
  working_days  numeric(4,1) not null,
  in_buffer     boolean not null default false,      -- the +2 weeks after the period
  status        text not null default 'open' check (status in ('open','committed','closed')),
  committed_count int, completed_count int, ppc numeric(5,2), pcr numeric(5,2),
  closed_by uuid references public.profiles (id), closed_at timestamptz,
  updated_at    timestamptz not null default now(),
  unique (plan_id, week_start)
);

create table public.lookahead_items (
  id              uuid primary key,
  plan_id         uuid not null references public.lookahead_plans (id) on delete cascade,
  project_id      uuid not null references public.projects (id),
  schedule_task_id uuid references public.schedule_tasks (id),   -- null = manually added task
  element_id      uuid references public.elements (id),          -- primary element (optional)
  wbs text, name text not null,
  window_role     text not null check (window_role in ('starting','ongoing','finishing','starting_next','late','manual')),
  planned_start date, planned_finish date,                       -- snapshot at generation (forecast or planned)
  pct_at_generation numeric(5,2) not null default 0,
  target_pct_end_of_period numeric(5,2),                         -- from schedule: expected % at period_end
  responsible_id  uuid references public.profiles (id),          -- last planner
  readiness       text not null default 'not_ready' check (readiness in ('ready','at_risk','not_ready')),
  status          text not null default 'active' check (status in ('active','dropped','done')),   -- dropped = removed from schedule on regen
  sort_key        text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (plan_id, schedule_task_id)
);

create table public.lookahead_constraints (
  id              uuid primary key,
  item_id         uuid not null references public.lookahead_items (id) on delete cascade,
  project_id      uuid not null references public.projects (id),
  ctype           text not null check (ctype in ('predecessor','material','approval','inspection','information',
                                                 'labour','equipment','space','external')),
  description     text not null,
  auto            boolean not null default false,
  source_type     text,  source_id uuid,          -- schedule_task / material_spec / material_request / inspection / ...
  material_spec_id uuid references public.material_specs (id),
  qty_short       numeric(16,3),
  owner_id        uuid references public.profiles (id),
  owner_role      public.app_role,
  due_date        date,
  status          text not null default 'open' check (status in ('open','in_progress','cleared','blocked','waived')),
  cleared_at timestamptz, cleared_by uuid references public.profiles (id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index lookahead_constraints_auto_key on public.lookahead_constraints (item_id, ctype, source_type, source_id) where auto;

create table public.constraint_events (           -- the constraint log
  id uuid primary key default gen_random_uuid(),
  constraint_id uuid not null references public.lookahead_constraints (id) on delete cascade,
  project_id uuid not null references public.projects (id),
  action text not null, from_status text, to_status text, comment text, payload jsonb,
  actor uuid references public.profiles (id), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.rnc_reasons (                  -- seeded with LCI 12 + local
  code text primary key, label text not null, label_am text, category text not null, sort int not null default 0
);
-- seed: materials, prerequisite_work, design_info, failed_inspection, labour, equipment, weather, space_access,
--       approvals, client_change, bad_planning (over-commitment), subcontractor, power_water_outage, other

create table public.weekly_commitments (
  id              uuid primary key,
  item_id         uuid not null references public.lookahead_items (id) on delete cascade,
  week_id         uuid not null references public.lookahead_weeks (id) on delete cascade,
  project_id      uuid not null references public.projects (id),
  description     text not null,                   -- the "assignment": e.g. "Cast columns C1–C8 level 3"
  target_pct      numeric(5,2), target_qty numeric(16,3), target_uom text,
  committed_by    uuid not null references public.profiles (id),
  committed_at    timestamptz not null default now(),
  readiness_at_commit text not null,               -- ready / at_risk (override)
  override_reason text,
  outcome         text not null default 'pending' check (outcome in ('pending','completed','not_completed')),
  actual_pct      numeric(5,2), actual_qty numeric(16,3),
  rnc_code        text references public.rnc_reasons (code),
  rnc_note        text,
  rolled_to_id    uuid references public.weekly_commitments (id),
  closed_by uuid references public.profiles (id), closed_at timestamptz,
  device_id uuid,
  updated_at      timestamptz not null default now(),
  check (outcome <> 'not_completed' or rnc_code is not null),
  check (readiness_at_commit = 'ready' or override_reason is not null)
);

alter table public.material_requests add constraint material_requests_lookahead_fk
  foreign key (lookahead_plan_id) references public.lookahead_plans (id);
alter table public.mr_lines add constraint mr_lines_lookahead_item_fk
  foreign key (lookahead_item_id) references public.lookahead_items (id);
```

All are project-scoped, with RLS read for members and writes via RPC. Every table carries `updated_at` for the mobile incremental pull.
Mobile syncs the current + next plan only.

### 9.1 Views (security_invoker)

- **`v_monthly_lookahead`** — live (not persisted) candidate list for *any* month, so the web can preview before generating.
  It is a set-returning function wrapped as a view param in practice: `app.lookahead_candidates(p_project, p_start, p_end, p_horizon)`
  returns task rows with `window_role`, s/f, pct, `expected_pct_at(period_end)` (linear on working days), working days in each week
  (`jsonb {week_start: days}`), predecessor status. Expose it as RPC `get_lookahead_preview(p)`, and keep `v_monthly_lookahead` as the view over
  *persisted* items + readiness + open constraint counts + commitment per week (what the "Monthly Tasks Window" screen reads).
- **`v_lookahead_material_needs`** — per plan × item × spec: total_need, remaining, window_need, need_by_date, lead_time_days,
  order_by_date, weekly_need jsonb. Plus per plan × spec × store aggregate: window_need, ati, open_po_by_need_date,
  in_procurement (PR approved, not ordered), shortfall, `raise_pr_now`, `late_order`, linked MR numbers. No prices.
- **`v_ppc`** — per plan week (and per responsible, per WBS level-2): committed, completed, ppc, pcr. Plus a project-level rolling
  4-week PPC. Companion **`v_rnc_pareto`** (count by `rnc_code` over last N weeks) and **`v_constraint_removal`** (due vs cleared on time, by owner, ageing).
- **`v_lookahead_readiness`** — per item: counts by constraint type/status, earliest due, readiness (the rule in §8.3).

### 9.2 RPCs

| RPC | Role | Behaviour |
|---|---|---|
| `generate_lookahead(p {op_id, project_id, calendar_mode, year, month, horizon_weeks:2, plan_id?})` | coordinator, office_engineer, admin | Upsert plan (unique per project/mode/period). Build weeks from the calendar. Candidates → upsert items by `schedule_task_id` (keep `responsible_id`, manual fields). Missing tasks → `status='dropped'` (never deleted if commitments exist). Refresh auto constraints (insert new, auto-clear ones no longer true with a `constraint_events` 'auto_cleared' row, keep manual). Recompute readiness. Returns `{plan_id, items, new, dropped, constraints_open, material_shortfalls, raise_pr_now}`. Idempotent; regenerating a `published` plan is allowed (re-baseline note in `notes`) but not a `closed` one. |
| `publish_lookahead(p {op_id, plan_id})` | coordinator | `draft→published`. Notify site engineers (their items), OEs (material shortfalls), procurement (raise_pr_now list). |
| `refresh_lookahead(p {plan_id})` / `app.refresh_lookahead_constraints(plan)` | any engineer; pg_cron nightly | Re-evaluates auto constraints only (stock, POs, MR statuses, inspections, predecessors). |
| `update_constraint(p {op_id, id?, item_id, ctype, description, owner_id, due_date, status, comment})` | site_engineer, office_engineer, coordinator, procurement, manager | Create a manual constraint or change status/owner/due. Auto constraints can't be deleted, only `waived` (reason required). Clearing a `material` auto constraint manually requires a comment. Every change → `constraint_events`. Notify the new owner. Recompute item readiness. |
| `assign_lookahead_item(p {item_id, responsible_id})` | coordinator, office_engineer | Sets last planner. |
| `commit_lookahead_item(p {op_id, id, item_id, week_start, description, target_pct|target_qty, override_reason?})` | site_engineer (own/responsible items), coordinator | Week must be `open` and `week_start > today` (or ≤ day 1 of week with coordinator role). Item readiness `ready`, or `override_reason` given. Multiple commitments per item/week allowed (split assignments). Offline-safe via `op_id`. |
| `close_week(p {op_id, week_id, results:[{commitment_id, outcome, actual_pct?, rnc_code?, rnc_note?, roll_forward:boolean}]})` | coordinator (site_engineer may pre-fill own via `report_commitment`) | All pending commitments in the week must get an outcome. Not-completed needs an RNC. Compute `ppc`, `pcr`, set week `closed`. Roll-forward creates candidate commitments (status pending) in the next open week, linked by `rolled_to_id`. When all weeks are closed → plan `closed`. Notify manager with the PPC summary. |
| `report_commitment(p {commitment_id, outcome, actual_pct, rnc_code, rnc_note})` | site_engineer | Pre-fill from the phone during the week (before close). |
| `create_prs_from_lookahead(p)` | office_engineer, coordinator | §8.5. |
| `create_sur_from_lookahead(p {plan_id, item_id, lines})` | site_engineer | Draft site-use request pre-filled with the week's need (element split from links). |
| `get_lookahead_preview(p {project_id, calendar_mode, year, month})` | members | Read-only candidate list (§9.1). |

pg_cron: `generate-lookahead` on the 25th 06:00 EAT (next month, draft); `refresh-lookahead` nightly 02:00;
`lookahead-reminders` Friday 15:00 (uncommitted next week, open constraints due ≤ 3 days, raise_pr_now).

## 10. Calendars & Ethiopian holidays

```sql
create table public.public_holidays (                      -- company-wide, seeded, admin-editable
  id uuid primary key default gen_random_uuid(),
  country text not null default 'ET', holiday_date date not null,
  name text not null, name_am text, kind text not null default 'national' check (kind in ('national','religious_orthodox','religious_muslim')),
  is_tentative boolean not null default false,             -- lunar dates until officially announced
  updated_at timestamptz not null default now(),
  unique (country, holiday_date, name)
);

create table public.project_calendars (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null default 'Standard 6-day',
  work_weekdays int[] not null default '{1,2,3,4,5,6}',     -- ISO dow: 1=Mon … 7=Sun
  hours_per_day numeric(4,2) not null default 8,
  saturday_factor numeric(3,2) not null default 1,          -- 0.5 if Saturday is a half day
  use_public_holidays boolean not null default true,
  is_default boolean not null default true,
  source text not null default 'manual' check (source in ('manual','msp_import')),
  updated_at timestamptz not null default now()
);
create unique index project_calendars_default on public.project_calendars (project_id) where is_default;

create table public.calendar_exceptions (
  id uuid primary key,
  calendar_id uuid not null references public.project_calendars (id) on delete cascade,
  project_id uuid not null references public.projects (id),
  exc_date date not null,
  kind text not null check (kind in ('non_working','working','reduced')),   -- 'working' overrides a holiday (e.g. critical pour)
  factor numeric(3,2) not null default 0,                   -- 'reduced' e.g. 0.5 (day before Genna/Fasika)
  name text, source text not null default 'project' check (source in ('project','msp_import')),
  updated_at timestamptz not null default now(),
  unique (calendar_id, exc_date)
);
```

Helpers (immutable/stable SQL):
- `app.day_capacity(p_calendar uuid, p_date date) returns numeric` (0..1): exception first → holiday (if `use_public_holidays`) → weekday in
  `work_weekdays` (Saturday × `saturday_factor`).
- `app.working_days(p_calendar, p_from, p_to) returns numeric`, `app.add_working_days(p_calendar, p_date, p_n int) returns date` (negative n allowed).
- `app.project_calendar(p_project) returns uuid` (default calendar; created by `app.new_project_defaults`).
- Ethiopian month view: existing `app.ethiopian_parts`, `app.from_ethiopian`, `app.ethiopian_month_name`. The UI grid for the
  Ethiopian mode is 30 days (5 rows × 6 working-days + Sundays). Week rows stay Mon–Sat so PPC weeks match in both modes.
- MS Project import: MSPDI `Calendars/Calendar/WeekDays` (DayType 1–7 = Sun–Sat, DayWorking) → `work_weekdays`; `Exceptions` →
  `calendar_exceptions(source='msp_import')`. National holidays still apply unless the MSP calendar already marks them.
- Schedule dates themselves are never recomputed here. MS Project stays the master. The calendar is only used for window maths,
  material distribution, need-by/order-by, and PPC week capacity.

Seed — Ethiopian public holidays (Proclamation 29/1996 + amendments; Islamic dates `is_tentative=true` until the Supreme
Council for Islamic Affairs announces; confirm each year):

| Date | Day | Holiday | Amharic | Tentative |
|---|---|---|---|---|
| 2026-01-07 | Wed | Genna (Ethiopian Christmas) | ገና | |
| 2026-01-19 | Mon | Timket (Epiphany) | ጥምቀት | |
| 2026-03-02 | Mon | Adwa Victory Day | የዓድዋ ድል በዓል | |
| 2026-03-20 | Fri | Eid al-Fitr | ኢድ አልፈጥር | yes |
| 2026-04-10 | Fri | Siklet (Good Friday) | ስቅለት | |
| 2026-04-12 | Sun | Fasika (Easter) | ፋሲካ | |
| 2026-05-01 | Fri | International Labour Day | የሠራተኞች ቀን | |
| 2026-05-05 | Tue | Patriots' Victory Day | የአርበኞች ቀን | |
| 2026-05-27 | Wed | Eid al-Adha (Arafa) | ኢድ አልአድሐ (አረፋ) | yes |
| 2026-05-28 | Thu | Downfall of the Derg | ግንቦት 20 | |
| 2026-08-26 | Wed | Mawlid | መውሊድ | yes |
| 2026-09-11 | Fri | Enkutatash (New Year 2019 E.C.) | እንቁጣጣሽ | |
| 2026-09-27 | Sun | Meskel | መስቀል | |
| 2027-01-07 | Thu | Genna | ገና | |
| 2027-01-19 | Tue | Timket | ጥምቀት | |
| 2027-03-02 | Tue | Adwa Victory Day | የዓድዋ ድል በዓል | |
| 2027-03-10 | Wed | Eid al-Fitr | ኢድ አልፈጥር | yes (±1 day) |
| 2027-04-30 | Fri | Siklet (Good Friday) | ስቅለት | |
| 2027-05-01 | Sat | International Labour Day | የሠራተኞች ቀን | |
| 2027-05-02 | Sun | Fasika (Easter) | ፋሲካ | |
| 2027-05-05 | Wed | Patriots' Victory Day | የአርበኞች ቀን | |
| 2027-05-17 | Mon | Eid al-Adha (Arafa) | ኢድ አልአድሐ (አረፋ) | yes (±1 day) |
| 2027-05-28 | Fri | Downfall of the Derg | ግንቦት 20 | |
| 2027-08-15 | Sun | Mawlid | መውሊድ | yes (±1 day) |
| 2027-09-12 | Sun | Enkutatash (New Year 2020 E.C.; 2019 is a leap year, Pagume 6) | እንቁጣጣሽ | |
| 2027-09-28 | Tue | Meskel | መስቀል | |

Notes: Orthodox dates were checked against the Ethiopian calendar functions (Tir 11 → 19 Jan; Yekatit 23 → 2 Mar; Ginbot 20 → 28 May).
Ethiopia does not move a Sunday holiday to Monday. Suggested `reduced` project exceptions: Genna/Fasika eve (0.5), the day after Meskel
in rural sites, and the Kiremt rains (mid-Jun–mid-Sep) as a *weather advisory constraint* rather than a calendar change. The lent seasons
(Abiy Tsom ≈ 55 days before Fasika, Ramadan) don't change working days.

Example: Hidar 2019 E.C. = 10 Nov – 9 Dec 2026. Gregorian Nov 2026 = 1–30 Nov, horizon to 14 Dec. No public holiday falls
in either window, so working days = Mon–Sat count (Nov 2026: 25).

## 11. Migration plan, tests, open questions

Order: `20261030000001_mr_enum.sql` (enum only) → `…0002_procurement_workflows.sql` (columns, tables, RPC rewrites,
`approvals_for` update, escalation) → `…0003_calendars.sql` (holidays seed, calendars, helpers; default calendar for each existing
project) → `…0004_lookahead.sql` (after the schedule migration from the parallel spec).

Key tests (pgTAP / SQL scripts):
1. PR happy path: OE submit → coordinator review (trim qty) → manager approve partial → procurement accept → RFQ 3 quotes → award →
   PO auto-approved (within tolerance) → send → status `ordered` → delivery notice → store ack → GRN partial → `partially_received`
   → GRN rest → `received` → `closed`. Requester gets a notification at each step.
2. Role/route guards: site engineer cannot create PR. OE cannot approve PR. Coordinator cannot approve PR when
   `pr_coordinator_final_limit` is null. Procurement cannot create RFQ from an unapproved PR. No self-approval.
3. Over-limit: manager limit 500k, PR 800k → `endorse`, status unchanged, covering approver approves.
4. Return loops: coordinator return → edit → resubmit (version+1, approvals cleared). Procurement return clears management approval.
5. SUR: SE submit → OE review returns stock check → coordinator approve → store order notification → partial MIV →
   full MIV → `issued` → acknowledge all → `received` → auto close.
6. Shortfall: ATI 40, requested 100 → `convert_shortfall` 60 → PR `submitted` with `source_mr_id`. GRN of the PR notifies the SUR
   requester. MIV against the SUR line succeeds.
7. Replay: every RPC twice with the same `op_id` returns the identical result.
8. Look-ahead: generate for Nov 2026 with tasks starting/ongoing/finishing/starting_next/late → classification. Material shortfall
   → `raise_pr_now`. Regenerate after a schedule update keeps commitments and drops removed tasks. Commit a non-ready item
   without a reason fails. `close_week` needs RNC for not-completed, PPC = 3/4 = 75%. Holidays reduce working days.
9. Calendar: `add_working_days('2027-04-29', 1)` skips Siklet + Labour Day (Sat) + Fasika (Sun) → 2027-05-03.

Open questions for the client:
1. Approval value bands (ETB) for coordinator/manager/GM, and whether small PRs can skip management (`pr_coordinator_final_limit`).
2. Direct purchase (cash/one proforma) limit, and whether 3 proformas are required above it (`min_quotes`).
3. Does a PO from a management-approved PR need a second approval if within tolerance (proposed: no)?
4. Who closes the week and owns PPC: coordinator (proposed) or office engineer?
5. Is Saturday a full or half working day (`saturday_factor`)? Do any sites work Sundays?
6. Planning month: Gregorian or Ethiopian by default (per project or per user)?

## 12. Sources

1. Livecosts — Purchase requisition vs purchase order: https://livecosts.com/blog/purchase-requisition-vs-purchase-order/
2. Stampli — Purchase requisitions in construction: https://www.stampli.com/blog/accounts-payable/requisition-in-construction/
3. eSUB — What is a purchase requisition in construction: https://esub.com/blog/purchase-requisition-construction
4. Jodoo — Material request vs purchase request: https://www.jodoo.com/blog/material-request-vs-purchase-request
5. ERPNext — Material Request: https://docs.frappe.io/erpnext/user/manual/en/material-request
6. ERPNext — Procurement cycle overview: https://docs.frappe.io/erpnext/v13/user/manual/en/buying/articles/procurement-cycle-overview
7. SAP Help — Release procedure for purchase requisitions: https://help.sap.com/saphelp_46C/helpdata/EN/dc/54c8ecaa83d311ae690060b03c9bbe/content.htm
8. Odoo Apps — Purchase request approval / material purchase requisitions: https://apps.odoo.com/apps/modules/19.0/purchase_request_approval/ ; https://apps.odoo.com/apps/modules/18.0/zehntech_material_purchase_requisitions
9. Kojo — Requisition approvals user guide: https://intercom.help/use-kojo/en/articles/6888718-requisition-approvals-user-guide
10. Kojo — Processing a requisition: https://intercom.help/use-kojo/en/articles/4106309-processing-a-requisition
11. Procore — Approve a materials request / custom workflows: https://v2.support.procore.com/product-manuals/materials-project/tutorials/approve-a-materials-request ; https://en-ca.support.procore.com/products/online/custom-solutions/workflows/get-started-with-custom-workflows
12. Hyperbots — Procurement approval matrix (DoA): https://www.hyperbots.com/glossary/procurement-approval-matrix ; Oregon State authority thresholds: https://eprocurement.oregonstate.edu/resources/authority-thresholds
13. Ethiopian public procurement (Proc. 430/2005 → 649/2009) RFQ ≥ 3 suppliers: https://www.scribd.com/presentation/719598355/Public-Procurement-Laws ; 2merkato tender regulations: https://2merkato.com/articles/starting-a-business/65-tender-or-bid-in-ethiopia-regulations-and-procedures
14. Addis Fortune — 2025 directive thresholds incl. RFQ under the 2024 proclamation: https://addisfortune.news/new-directive-mandates-central-oversight-digital-integration-for-soes
15. Jimma University — material supply chain practices of building contractors: https://repository.ju.edu.et/handle/123456789/6900
16. Infralens — Stores issue voucher / material issue request formats: https://infralens.in/formats/stores/issue-voucher ; https://infralens.in/formats/stores/indent-mir-material-issue-request
17. ASTU thesis — Framework for LPS at Ethiopian Construction Works Corporation: https://etd.astu.edu.et/items/2bd74fb1-1011-48da-b03a-cbc29479b2f0
18. Limenih et al. 2022 — LPS in Addis Ababa road projects (Adv. Civil Eng., doi:10.1155/2022/7846593): https://structurae.net/en/literature/journal-article/usefulness-of-adopting-the-last-planner-system-in-the-construction-process-of-addis-ababa-road-projects
19. Mastt — Last Planner System, levels and PPC: https://www.mastt.com/blogs/last-planner-system
20. Touchplan — Make-ready planning: https://touchplan.io/blog/how-make-ready-planning-can-make-or-break-your-project
21. IGLC — Percent constraint removal / look-ahead metrics: https://www.iglc.net/Papers/ExportBibtex/497 ; WSC 2011 LPS simulation: https://www.informs-sim.org/wsc11papers/305.pdf
22. LCI — 12 LPS Reasons for Variance: https://leanconstruction.org/wp-content/uploads/2022/08/12_LPS_Reasons_For_Variance.pdf
23. CCA — Last Planner System Essentials: https://www.cca-acc.com/wp-content/uploads/2021/08/Last-Planner-System-Essentials-LPC.pdf
24. Koskela's seven preconditions (AAU / IGLC): https://vbn.aau.dk/files/449758364/Reviewed_article_prepublsihed.pdf ; https://www.iglc.net/Papers/Details/1606
25. Converting master schedule into 2–6 week look-aheads: https://us.fitgap.com/stack-guides/converting-the-master-schedule-into-reliable-2-6-week-lookaheads ; Constructable look-ahead guide: https://constructable.ai/blog/look-ahead-schedule-how-to-build
26. Microsoft — MS Project XML data interchange (Calendars, Tasks): https://learn.microsoft.com/en-us/office-project/xml-data-interchange/alphabetical-list-of-elements-and-types
27. Ethiopian Labour Proclamation 1156/2019 text: https://www.metaappz.com/References/ethiopian_laws/federal/pr_1156_2019/en/txt ; WageIndicator working time: https://wageindicator.org/en-et/work-in-ethiopia/labour-law/compensation-and-working-time
28. timeanddate — Ethiopia holidays 2026 / 2027: https://timeanddate.com/holidays/ethiopia/2026 ; https://www.timeanddate.com/holidays/ethiopia/2027
29. Office Holidays — Ethiopia 2027: https://www.officeholidays.com/countries/ethiopia/2027 ; publicholidays.africa: https://publicholidays.africa/?p=144
30. HolidayDB / TrueCalendar — Ethiopia 2026–2027: https://holidaydb.com/guides/public-holidays/ethiopia/2026 ; https://truecalendar.com/public-holidays/ethiopia/2027
