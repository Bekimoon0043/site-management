# Gap analysis — November 2026

What a contractor's site-management + progress + procurement + cost system needs that this app still lacks, after the
work in progress on 3 Nov 2026 (subcontractor & daily-labour payments with a finance role, material cost on use,
MS-Project-style schedule editing and resources, elements from the schedule, purchase→store visibility, client billing).

Sources: Ethiopian PPA standard conditions and sample IPCs (retention 2.5–5 %, advance repayment 20–30 %, price adjustment
by formula), Income Tax (Amendment) Proclamation 1395/2025 (withholding 3 %, 30 % without TIN; VAT 15 %), and the feature
sets of Procore / Buildertrend / Fieldwire / Aconex (RFIs, submittals, change orders, daily logs, punch lists, document control).

## Must-have

| # | Gap | Why | Status |
|---|-----|-----|--------|
| 1 | **Client payment certificates (IPC)** from verified BoQ quantities: previous / this / to date, materials on site, price adjustment, retention, advance repayment, VAT, withholding; prepared → checked → submitted → certified (consultant figures) → paid | Cash in. Every other module measures progress; nothing turned it into the monthly invoice the client pays | **Built** (`20261103000060_client_billing.sql`, `/billing`) |
| 2 | **Variations / change orders** with instruction ref., new and changed BoQ items, internal + client approval, flowing into the BoQ, contract sum and the next IPC | Most Ethiopian building contracts end 10–30 % above the original sum through variations; unrecorded instructions are lost money | **Built** (same) |
| 3 | **Client-side payment tracking and receivables ageing** (certified vs. received, days outstanding, interest on late payment per GCC) | Shows the cash position and supports claims for late payment | Partly built (received per IPC, outstanding KPI); ageing report still missing |
| 4 | **Final account and retention release** (practical completion → half retention, end of defects liability → rest) | Retention is 5 % of the contract — a large sum that is often forgotten | Partly (final IPC releases retention); DLP dates and half-release still missing |
| 5 | **Price adjustment calculator** (PPA formula: fixed + weighted indices for cement, steel, fuel, labour, CSA indices by month) | Price escalation is a major claim in Ethiopia; today the amount must be computed outside and typed in | Not built (manual cumulative amount on the IPC) |
| 6 | **RFIs / site instructions register** (question → consultant answer, due date, cost/time impact flag, link to variation) | Instructions without a register cause disputes; variations need their source document | Not built (instruction ref. is free text on the variation) |

## Should-have

| # | Gap | Why |
|---|-----|-----|
| 7 | **Extension of time (EoT) claims** linked to schedule delays, diary delays (rain, power, payment) and variations | Delay causes are already captured daily; turning them into an EoT claim protects against liquidated damages |
| 8 | **Submittals / material approvals** (shop drawings, material samples, approval status before ordering) | Purchases of unapproved materials are rejected on site |
| 9 | **Document control** (drawing register with revisions, transmittals, "current revision" on site) | Building from superseded drawings is a common rework cause |
| 10 | **HSE register** (incidents, near misses, toolbox talks, PPE issue, inspections) | Legal duty; also needed by most clients' monthly reports |
| 11 | **Equipment management** (own/hired plant register, hours, fuel, maintenance, hire invoices) | Equipment is the 2nd largest cost after materials; diary already records hours |
| 12 | **Cash-flow forecast** (planned IPCs from the baseline S-curve vs. planned payments to suppliers / subcontractors / payroll) | Contractors fail on cash, not on profit |
| 13 | **Monthly progress report to the client** (auto PDF: progress %, S-curve, photos, IPC, issues, look-ahead) | Required monthly by almost every contract; today assembled by hand |
| 14 | **Bank guarantees / bonds and insurances register** (performance, advance, retention bonds; CAR insurance; expiry alerts) | Expired guarantees block payments |

## Nice-to-have

| # | Gap | Why |
|---|-----|-----|
| 15 | Punch-list / snag sign-off with the client at handover (snags exist for QA — extend with client walk-through) | Smooth practical completion |
| 16 | Photo progress timeline per element / location with before-after | Evidence for IPCs and claims |
| 17 | Client / consultant portal (read-only IPC, RFIs, reports) | Fewer emails, faster certification |
| 18 | Telegram / SMS approval reminders for IPC and variations (Telegram channel already exists) | Faster approvals in the field |
| 19 | Multi-currency for imported materials (USD LC, exchange rate on GRN) | Steel and finishing materials are often imported |
| 20 | Benchmarking across projects (cost / m², productivity rates by trade) | Better tenders |

## Built in this round — client billing

* **Contract terms** per project: contract sum (ex VAT), VAT 15 %, advance and its recovery % (defaults to advance ÷ sum),
  retention % and limit, share of materials on site paid, withholding % (3 %).
* **IPC** (`client_ipcs`, `client_ipc_lines`): quantities to date default to the verified progress of the project's schedules
  at the valuation date (`app.boq_progress_raw`), previous = the previous certificate's certified quantities; any line can be
  re-measured (flagged). Totals in the usual Ethiopian layout (`app.ipc_totals`). Workflow with segregation of duties
  (preparer ≠ checker), consultant certification with its own quantities / MoS / price adjustment, part and full payments.
  Printable A4 with four signature blocks.
* **Variations** (`variations`, `variation_lines`): new items or quantity changes (negative = omission) at BoQ or new rates;
  manager approval → client approval adds the items to the BoQ (with rates) and raises the contract sum.
* Inbox items via `app.approval_sources` (coordinator: IPC to check; manager: IPC to approve, variations; finance: payment due).
* All amounts are price data (RLS: members with price access). The office engineer (QS) needs price access to prepare IPCs —
  add the role on Settings › "Who can see prices".
