# Feature Research & Backlog — Site Materials Management & Progress Tracking

*Research date: 29 Oct 2026. Inputs: `docs/PLAN.md`, `shared/contract.ts`, migrations `20261029000001…04`, and ~35 web sources (listed at the end).
Scope: what to build next on top of the current build (MR → approval → GRN/inspection → MIV/ack → MRN/ADJ/CNT/TRF, stock ledger,
element progress with hold points, consumption vs take-off, dashboards, notifications, audit, offline sync).*

---

## 1. Landscape summary — what the best products do that we don't

| Product (segment) | Standout capabilities relevant to us | Gap vs. our build |
|---|---|---|
| **Procore Materials** (US GC, GA 2026) | Shipments/expected deliveries synced to schedule; mobile receiving **against PO / bill of lading** with defect capture; inventory by location; cross-project surplus transfer; **3-way match PO ↔ receipt ↔ invoice**. Site Diary has Delivery & Productivity logs (qty delivered vs put-in-place). Inspections auto-prompt an **Observation** when an item fails; deficiency record is never flipped to "pass". | No PO, no expected-delivery list, no invoice match, no observation-from-inspection. |
| **Kojo** (US materials procurement) | Field "shopping" requests; **RFQ to several vendors at once**; proof-of-delivery upload; PO/POD/invoice side-by-side; warehouse stock visible to all for restocking; prefab orders tracked to arrival. | No RFQ/quote compare, no supplier-side status. |
| **Raken** (daily reports) | Daily report auto-assembled from field entries: **auto weather at project location**, work logs (crew/trade/hours), equipment (owned/rented), visitors, materials, safety observations, notes, photos → branded PDF. | We have no site diary at all. |
| **Fieldwire / Dashpivot (Sitemate) / Novade / Trimble Field View** | Template-driven **checklists / ITPs** with hold points, punch/snag lists pinned to drawings, two-step verify of punch items, custom form builder, offline-first, PDF export, ITP data to Power BI; Novade generates diaries over a date range and routes non-conformances to closure. | Our hold points exist only as activity flags — no checklist content, no NCR/snag loop. |
| **Autodesk Build** | Daily Logs, Issues linked to sheet/model location and to assets/RFIs, Forms with contributor/reviewer/manager roles, Assets with custom status sets. | No issue/snag, no asset/equipment register. |
| **Buildertrend** | Bids → POs → Bills; daily logs with weather/labour/photos and AI client updates. | — |
| **Oracle Aconex** | Formal **document register** with every revision, transmittals vs mail, audit trail, register/transmittal reports. | We only have `drawing_ref` text. |
| **ERPNext / Odoo / SAP** | Full MR → RFQ → Supplier Quotation (comparison report) → PO → Purchase Receipt → Invoice chain; **auto material request when stock < reorder level** (per warehouse). | Our `reorder_level` is only a dashboard flag. |
| **Indian field ERPs — Powerplay, Onsite, Srijan, Procurex, Livefield** | Mobile-first, vernacular, built for low-skill users; **request → PO → GRN** on phone; PO shared to supplier **via WhatsApp**; labour attendance; dual units; central warehouse; assets & tools; position themselves as "WhatsApp replacement" yet still push links into WhatsApp. | No PO, no messenger sharing, no tools. |
| **African marketplaces — Jumba (KE), CutStruct / CinderBuild (NG), M-Jenzi** | Supplier aggregation and price transparency for fragmented, broker-heavy materials markets. | Suggests a supplier price-history/benchmark angle is valuable locally. |
| **Concrete-specific — Loop Digital Ticket, Concrete DNA, ForneyField, Nexplore** | Digital ready-mix delivery tickets signed at site, **photo-of-docket OCR**, slump/temperature/water-added per truck, cube/cylinder sets with due-dates, offline sync of wet-concrete data. | FR-RC-06 is still Phase 3. |
| **Gate-pass systems (OneStop, Happy Visitor, SAP MM)** | Returnable (RGP) / non-returnable (NRGP) gate passes, mandatory approval for NRGP, **guard scans pass at gate**, due-date alerts for unreturned items. | Nothing controls material *leaving* site except transfers. |
| **Tool tracking (GoCodes, ShareMyToolbox, itemit)** | QR on every tool, check-out to person/job, scan-based audit trail; GPS only on high-value assets. | No tools/equipment. |

**Key takeaways**

1. **The money loop is the big hole.** Every serious product closes *request → quote → PO → delivery → receipt → invoice*. We stop at "approved". Without POs we cannot show committed cost (FR-CC-04), supplier lead times, price history, or GRN-vs-ordered variances properly.
2. **The site diary is the hub of field apps** (Raken, Procore, Novade, Buildertrend). It should *auto-pull* what our app already knows (GRNs, MIVs, progress, pours) so the engineer only adds weather, labour, equipment, delays and photos.
3. **Quality = checklists + snags with a closed loop** (fail → snag → fix → re-inspect → close; never edit the failed record). We have hold points but no content behind them.
4. **Concrete and rebar are 60–80 % of structural material cost** in Ethiopian RC frame buildings; specialised pour/cube and BBS reconciliation features give outsized value and no generic product does them well offline.
5. **Emerging-market winners meet users where they are**: the messenger (Telegram in Ethiopia — the African exception to WhatsApp dominance), the local language and calendar, phone-only users, and PDFs that look like the paper forms.

### Ethiopian context that should shape the design

- **Price volatility & black market.** Cement shortages have been "normal" since 2018; retail prices have run at 2× factory-gate, with brokers reselling at a markup *while issuing receipts at the official price*. Rebar rose 35–50 % within a month after the 2017 devaluation; >90 % of contracts reportedly lack escalation clauses; ECA has a price-adjustment manual for public projects. ⇒ Record **actual paid unit price + date + supplier** on every PO/GRN, keep **price history**, alert on spikes, and support **buy-ahead decisions** (forecast + price trend). Price history is also evidence for escalation claims.
- **Procurement practice.** Private contractors commonly collect ~3 proforma invoices before buying (company policy, mirrors public "shopping" rules — not a legal requirement for private firms, make the minimum configurable). Many suppliers are informal (no TIN/receipt).
- **Tax.** VAT 15 % (Proclamation 1341/2024). Withholding 3 % on goods payments ≥ ETB 20,000 (services ≥ 10,000) to resident suppliers; reported 30 % withholding where the supplier has no TIN / informal purchase (purchase-voucher regime). Thresholds have changed over time ⇒ keep rates and thresholds in a settings table, not code.
- **Concrete.** Addis has ready-mix (mostly in-transit mixers), but many sites still batch on site; studies found 44 % of coarse and 77 % of fine aggregate samples failed standards, mainly due to poor handling ⇒ site-batched pours need **cement-bag-per-m³ reconciliation** and cube tests matter (C25/C30 typical).
- **Theft/waste.** Ethiopian studies attribute cement/rebar/block losses mainly to supervision, handling and storage weaknesses; infrastructure steel/copper theft is well reported (EEP lost 756 t of tower steel in a year). ⇒ gate pass, vehicle checks, blind counts, and variance alerts.
- **Messaging.** Telegram is the dominant messenger (Chapa payments run on Telegram bots; government uses bots). Bot API: inline buttons with 64-byte callback data, `sendDocument` can carry Approve/Reject buttons.
- **Calendar & language.** Ethiopian calendar (13 months, Pagumē, ~7–8 years behind Gregorian, fiscal year starts Hamle 1 / 8 July); Amharic (Ge'ez script). Libraries exist (`kenat`, `ethiopic-js`). Always store Gregorian `date`/`timestamptz`; convert for display/input only.

---

## 2. Prioritised feature backlog

Legend — **Pri:** P1 must add now · P2 next · P3 later. **Effort:** S ≤ 1 wk, M 1–3 wks, L > 3 wks (one dev, incl. mobile + web + SQL).
Conventions assumed throughout: client-generated `uuid` PK for offline-created docs, `project_id` on every row, `created_at/updated_at/deleted_at`,
writes only via `security definer` RPC `fn(p jsonb)` with `op_id` (`app.op_seen`/`app.op_done`), numbers `<PROJECT>-<TYPE>-<DEVICE>-<SEQ>`,
price columns in separate price-restricted tables (pattern already used by `spec_prices`, `boq_rates`).

### A. Procurement & supply

#### A1. RFQ & quotation comparison (proforma capture) — **P1, M**
- **Problem:** Procurement collects 3 proformas on paper/Telegram photos; managers can't see why a supplier was chosen; no price history.
- **Roles:** procurement (create/record), manager/coordinator (award), office_engineer (view technical compliance).
- **How it works:** From approved MR lines (status `approved`), procurement ticks lines → "Create RFQ". RFQ lists specs/qty/required date/delivery site. Send to suppliers as PDF/Telegram/SMS text (no supplier portal yet). Record each reply as a quotation: photo of proforma (attachment kind `proforma`), validity date, unit prices per line, VAT included?, delivery days, payment terms, transport included. **Comparison grid** (web + tablet): lines × suppliers, lowest highlighted, landed cost (price + transport + VAT), delivery-days column, supplier score badge, "last paid price" and Δ%. Award per line (split awards allowed) with mandatory reason if not lowest. Minimum number of quotes per project setting (default 3; override with reason above a value limit).
- **Data:** `rfqs`, `rfq_lines` (→ `mr_lines`), `rfq_suppliers`, `quotations`, `quotation_lines` (prices; price-restricted). Awards create PO drafts (A2).
- **RPCs:** `save_rfq`, `record_quotation`, `award_rfq`.
- **Offline:** web/online primary; mobile read-only. Quotation photo capture works offline via attachment outbox.

#### A2. Purchase orders with VAT/WHT and Telegram/PDF sharing — **P1, M**
- **Problem:** No commitment record ⇒ no committed cost, no "ordered vs received", MR statuses `sourced/ordered` unused.
- **Roles:** procurement (create), manager/coordinator (approve per `approval_limits`), store_keeper (sees qty only, receives against it).
- **How it works:** PO from award or manually; lines link to `mr_line_id` (optional) and `quotation_line_id`. Header: supplier, delivery store, expected delivery date(s), payment terms, advance %. Totals computed: subtotal, VAT 15 %, withholding 3 % (if goods ≥ threshold and supplier has TIN; 30 % flag if no TIN), net payable. Approval → status `issued` → PDF (company branded, bilingual) shared to supplier via Telegram/WhatsApp share sheet. Amend = new revision (`revision` int, `po_revisions` snapshot). MR line status → `ordered`. Cancel/short-close remaining qty.
- **Data:** `purchase_orders`, `po_lines` (qty, no price), `po_line_prices` (restricted), `tax_settings`; `suppliers` gains `tin`, `vat_registered`, `telegram_chat`, `bank_account`.
- **RPCs:** `save_po`, `po_action` (submit/approve/reject/issue/cancel/short_close), `amend_po`.
- **Offline:** POs + po_lines synced to store keepers of the delivery store (read-only) so GRN-against-PO works offline.

#### A3. Expected deliveries & delivery tracking — **P1 (part of A2/GRN change), S**
- **Problem:** Store keeper doesn't know what is coming today; engineers chase procurement by phone.
- **How it works:** "Expected deliveries" list on store dashboard (PO lines with balance > 0, by expected date; overdue red). Procurement updates ETA/status (`confirmed`, `dispatched`, `delayed` + note) — each update notifies requester. **GRN "receive against PO"**: pick PO → lines prefilled with outstanding qty → enter delivered/accepted; over-receipt beyond tolerance blocked. Shortages auto-flag and keep PO line open.
- **Data:** `po_delivery_updates`; `grns.po_id`, `grn_lines.po_line_id`; view `v_po_line_status` (ordered/received/accepted/rejected/outstanding).
- **RPCs:** `update_po_delivery`; `post_grn` extended with `po_id`, `lines[].po_line_id`.
- **Offline:** GRN against PO offline; server re-validates outstanding qty (rule violation → failed outbox entry, existing pattern).

#### A4. Supplier invoice & 3-way match — **P2, M**
- PO ↔ GRN (accepted) ↔ invoice; mismatch reasons (price, qty, tax); payment status for site visibility (not accounting). Tables `supplier_invoices`, `supplier_invoice_lines`; RPC `record_invoice`, `match_invoice`. Online/web only.

#### A5. Supplier performance scorecard — **P2, S** (views only once A2/A3 exist)
- On-time % (GRN date vs PO expected), fill rate (accepted/ordered), rejection rate (inspection), price competitiveness (vs median quote), average lead time (PO issued → first GRN). Auto-update `suppliers.rating` nightly. View `v_supplier_performance`; pg_cron `refresh_supplier_scores()`.

#### A6. Price history & price-spike alerts — **P1 (as views on A1/A2/GRN), S**
- **Problem:** Cement/rebar prices jump 30–50 % in weeks; management decides buy-ahead blind; escalation claims lack evidence.
- **How it works:** Every quotation and PO price writes to `price_observations` (spec, supplier, unit price ex-VAT, date, source = quotation/po/market). Procurement can log a quick "market price" from a Telegram channel/phone call. Chart per spec (last 12 months, by supplier); alert when new price > X % above 30-day median (`project_settings.price_spike_pct`). Export "price movement report" for escalation claims (base date vs current).
- **Data/RPC:** `price_observations`; `log_market_price`; view `v_price_trend`.

#### A7. Supplier portal / Telegram bot for suppliers — **P3, L**
- Supplier confirms PO, gives ETA, uploads delivery note, submits quotation via Telegram bot. Big trust/identity work; defer.

### B. Field reporting

#### B1. Site diary / daily report — **P1, M**
- **Problem:** Diary is a paper book; management gets no daily picture; claims for delay lack evidence (weather, idle labour, late delivery).
- **Roles:** site_engineer (author per block/whole site), office_engineer/coordinator (review/sign), manager (read).
- **How it works:** One diary per project per date (optionally per block). Sections: **weather** (AM/PM condition chips: sunny/cloudy/rain/heavy rain/wind; rain hours; auto-fill from Open-Meteo when online, else manual), **labour** by trade (mason, carpenter, bar bender, daily labourer…) with count & hours, own vs subcontractor, **equipment** (item, hours worked/idle, breakdown), **work done** (free text + auto-list of today's verified/reported progress), **materials** (auto: today's GRNs, MIVs, pours), **visitors/instructions** (consultant instructions, client visits), **delays/issues** (cause category: weather, material shortage, cement shortage, power cut, design info, payment, labour), **safety incidents**, **photos** (min 3 configurable). Submit → reviewer signs → locked; amendments as addenda. PDF in the familiar paper-diary layout; share to Telegram group.
- **Data:** `site_diaries`, `diary_labour`, `diary_equipment`, `diary_delays`, `diary_visitors`; photos via `attachments(entity_type='site_diary')`; master `labour_trades`.
- **RPCs:** `save_site_diary` (draft/submit), `sign_site_diary`, `add_diary_addendum`.
- **Offline:** fully offline; one diary per (project, block, date) enforced server-side with merge-by-section if two devices create the same day (second becomes addendum).

#### B2. Labour attendance (headcount only) — **P2, M**
- Daily headcount by trade/subcontractor feeding the diary; optional named attendance with photo. Payroll out of scope. `labour_attendance` table.

#### B3. Look-ahead planning (3-week) — **P2, M**
- **Problem:** Materials arrive late because requests are raised when work starts.
- **How it works:** Office engineer drags elements into weeks (or imports from schedule planned_start); system multiplies take-offs by remaining qty → **material demand per week** minus stock and open POs ⇒ "requests to raise now" (considers `lead_time_days`). One tap creates look-ahead MR drafts (`is_lookahead=true`). Pour templates (FR-MR-08) plug in here.
- **Data:** `lookahead_plans`, `lookahead_items(element_id, activity, week_start)`; view `v_lookahead_demand`. RPCs `save_lookahead`, `generate_lookahead_mrs`.

#### B4. Activity feed — **P2, S**
- Per-project chronological feed (who did what: GRN posted, MR approved, pour done, snag closed) with photo thumbnails; filter by block/role. Build from `audit_log` + document tables via view `v_activity_feed` (online) and a local SQLite union (offline).

#### B5. Global search — **P2, S**
- One search box: document numbers (`ADD-MIV-K3-0042`), element codes, specs, suppliers, plate numbers. Mobile: SQLite FTS5 over synced tables. Web: Postgres `pg_trgm` index on `number`/`code`/`name`; RPC `search(p {q, project_id})`.

### C. Quality

#### C1. Inspection checklists (ITP) linked to hold points — **P1, M**
- **Problem:** Hold point "Rebar inspection" is a checkbox; no evidence of *what* was checked; consultants sign paper.
- **Roles:** office_engineer (templates), site_engineer (requests/performs), office_engineer/coordinator (approve); external consultant signature captured on device.
- **How it works:** Template per activity (e.g., "Pre-pour slab": cover blocks, lap lengths, spacing, cleaning, formwork level, embedded conduits). Item types: pass/fail/NA, number with tolerance, text, photo-required, signature. Inspection is created from an element activity with `is_hold_point` → items filled → result `pass`/`fail`. **Pass** auto-satisfies the hold point (progress past it allowed). **Fail** item ⇒ prompt "Create snag" (C2) pre-filled; failed record is never edited, re-inspection is a new inspection linked by `reinspection_of`.
- **Data:** `checklist_templates`, `checklist_template_items`, `inspections`, `inspection_items`; `activity_templates.checklist_template_id`.
- **RPCs:** `save_checklist_template`, `submit_inspection`, `decide_inspection` (if review required).
- **Offline:** templates synced; inspections offline-first; signature as attachment kind `signature`.

#### C2. Snag / defect list (observations, NCR-lite) — **P1, S–M**
- **Problem:** Defects tracked in notebooks; no closure evidence before handover.
- **How it works:** Snag = element/location + category (concrete honeycomb, rebar cover, alignment, finishing, safety) + severity + photo(s) + assignee (user or subcontractor name) + due date. Lifecycle `open → fixed (with after-photo) → verified/closed | reopened`. Optional pin on drawing (P3 with drawings register). Snag list per block PDF for subcontractor; dashboard: open by age/assignee.
- **Data:** `snags`, `snag_events`. **RPCs:** `save_snag`, `snag_action` (fix/verify/reopen/cancel).

#### C3. Concrete pour log, ready-mix batch tickets & cube tests — **P1, M**
- **Problem:** Concrete is the largest cost item; ready-mix tickets get lost; site-batched pours waste cement; cube results arrive weeks later with no link to the element; no record of rejected trucks or water added.
- **Roles:** site_engineer (pour log, trucks, slump, samples), store_keeper (cement bags for site batching via MIV), office_engineer (cube results, acceptance).
- **How it works:**
  1. **Pour request/permit** for one or more elements (requires the pre-pour inspection C1 passed when hold points enforced) with planned volume (from take-offs) and grade.
  2. **During pour:** for *ready-mix*, add each truck: ticket no. (photo of ticket, OCR later), supplier, mix/grade, m³, batch time, arrival time, discharge start/end, slump, temperature, water added, accept/reject + reason. Accepted trucks **post a GRN automatically** (spec = concrete grade, store = virtual "pour" store) **and an MIV to the elements** in one RPC, so ledger/consumption stay correct without double entry. For *site-batched*: record batches (cement bags, sand/gravel wheelbarrows or m³, water), mixer, slump; cement consumption pulled from MIVs to the pour → **bags per m³ vs mix design** variance.
  3. **Samples:** cube set auto-suggested (e.g., 1 set per 50 m³ or per day, config), each set of N cubes with IDs `POUR-…-S1-A/B/C`, test ages 7/28 days → due-date reminders → lab results (kN or MPa) entered with lab sheet photo → characteristic check vs grade → fail ⇒ critical notification + NCR/snag.
  4. **Close pour:** actual volume vs theoretical (element dims/take-off) → over-pour %.
- **Data:** `pours`, `pour_elements`, `pour_trucks` (batch tickets), `pour_batches` (site mix), `cube_sets`, `cube_results`, `mix_designs`.
- **RPCs:** `save_pour`, `add_pour_truck`, `add_pour_batch`, `close_pour`, `record_cube_results`.
- **Offline:** everything except OCR offline; truck entries are append-only (no conflicts).

#### C4. Rebar reconciliation vs BBS — **P1, M**
- **Problem:** Rebar wastage (cutting losses, theft, over-ordering) is the classic loss line; BBS lives in Excel; we cannot compare issued kg to theoretical kg (FR-CC-05).
- **Roles:** office_engineer (imports BBS), store_keeper (issues by bar dia, records offcuts), manager (sees variance).
- **How it works:** Import BBS Excel per element (bar mark, Ø, shape code, no. of members × bars, cut length) → theoretical kg = n × L × Ø²/162 (kg/m) — editable rounding. Element/diameter view: **BBS kg vs take-off kg vs issued kg (MIV) vs returned (MRN)** ⇒ wastage % against allowance (`material_specs.wastage_pct`); flag elements over threshold. **Offcut register:** reusable offcuts (≥ 1.0 m) returned as stock under an "offcut" spec/grade; scrap sold logged via gate pass (D1) — scrap kg closes the loop (issued = installed + offcut stock + scrap + unexplained). Cutting-optimisation hint (sum of cut lengths per Ø ÷ 12 m stock bars) P3.
- **Data:** `bbs_schedules` (per element, revision), `bbs_lines`; view `v_rebar_reconciliation`.
- **RPCs:** `import_bbs` (web, bulk), `approve_bbs`.
- **Offline:** BBS lines synced read-only so bar benders can see cut lists on site.

#### C5. Material test register (non-concrete) — **P3, S**
- Lab tests for rebar tensile, blocks, aggregates linked to GRN batch; quarantine release on pass (extends existing quarantine).

### D. Loss prevention & control

#### D1. Material gate pass (outgoing control) + vehicle checks — **P1, M**
- **Problem:** Materials leave the site with no document (scrap, "returns" to supplier, loans to sister sites, formwork to rented yards); guard has nothing to verify.
- **Roles:** store_keeper/site_engineer (raise), coordinator/manager (approve — mandatory for non-returnable), **new role `security`** (verify at gate; minimal app: scan + photo).
- **How it works:** Gate pass types: `returnable` (formwork, tools, scaffold to repair/hire) with due date; `non_returnable` (scrap sale, return to supplier, disposal); `transfer` (auto-created from TRF). Lines: spec or free-text item, qty, reason, linked doc (TRF/MRN/supplier return). Approval → QR on phone/printout. **At gate:** guard scans QR → sees items, vehicle plate, driver; enters plate seen, takes photo of loaded vehicle, ticks "matches" or "mismatch" (mismatch = critical notification to manager). Ledger posting: non-returnable from stock posts an issue-like ledger entry (`txn_type 'gate_out'`); returnable posts to an "out on loan" status, returned via `gate_pass_return`. Overdue returnables alert daily. **Vehicle log:** every incoming/outgoing vehicle at gate (plate, time, purpose, linked GRN/gate pass) — unmatched outgoing loaded vehicles flagged.
- **Data:** `gate_passes`, `gate_pass_lines`, `gate_events` (scan/verify), `vehicle_movements`; `stock_ledger.txn_type` += `gate_out`, `gate_in`; `StockStatus` += `on_loan`.
- **RPCs:** `save_gate_pass`, `gate_pass_action` (approve/reject/cancel), `verify_gate_pass` (security), `return_gate_pass`, `log_vehicle`.
- **Offline:** guard verification works offline against synced approved passes (QR contains id + HMAC signature so a forged QR fails even offline).

#### D2. Variance & anomaly alerts — **P1 (S, rules on existing data)**
- **Problem:** Consumption variance is visible only if someone opens the dashboard (FR-CC-02 partial).
- **How it works:** Nightly + on-post rules produce `alerts` (and push/Telegram): element issued > take-off × (1 + threshold); stock count variance > X % or value > Y; repeated `Theft / loss` wastage on same store; emergency issues not regularised in 48 h; GRN shortage frequency per supplier; MIV not acknowledged in 24 h; cement bags/m³ above mix design; issue outside working hours (configurable window); negative-balance attempts; large backdated documents (device time vs server receive > 72 h).
- **Data:** `alert_rules` (project-configurable thresholds), `alerts` (rule, entity, severity, status open/ack/closed, assigned). RPCs `ack_alert`, `close_alert`; function `app.run_alert_rules()` via pg_cron.

#### D3. Blind & cycle counts — **P2, S**
- Count screen hides system qty (blind) by default; ABC-based cycle schedule (cement/rebar weekly, others monthly) suggested on store dashboard. Columns `stock_counts.is_blind`, table `count_schedules`.

#### D4. Segregation-of-duties guards — **P2, S**
- Server rules: GRN poster ≠ GRN confirmer; MIV issuer ≠ acknowledger; adjustment requester ≠ approver; count submitter ≠ approver (already partly). Report "SoD exceptions" for small sites where one person holds roles.

### E. Identification & evidence

#### E1. QR labels (stores, bins/specs, elements, documents) — **P1, S**
- **Problem:** Wrong item/grade issued; finding the element record on site is slow; paper MIVs can be faked.
- **How it works:** Web prints label sheets (A4, 3×8) for: store locations/bins (spec + store → opens bin card), elements (opens element: progress, consumption, inspections, snags), equipment (E3). Every generated PDF document (MIV, GRN, gate pass, PO) carries a QR with `{type,id,sig}` → scan verifies authenticity offline. Mobile: one scanner in the header; scan in MIV line picks spec/element. Batch QR for tracked batches (FR-ST-10).
- **Data:** `qr_codes(id uuid, project_id, target_type, target_id, label, printed_at)` (optional — QR can also encode target directly); HMAC key per project in `project_secrets` (server only; signature verify needs offline key ⇒ use Ed25519 public key on device, private key server-side; documents created offline are signed after sync, QR on offline PDFs shows "unsigned – pending sync").
- **RPCs:** `register_qr_labels` (bulk). Expo: `expo-camera` barcode scanning.

#### E2. Tamper-evident photo evidence (GPS/time stamps) — **P1, S**
- **Problem:** Photos are reused, taken elsewhere, or backdated in disputes (deliveries, progress, theft).
- **How it works:** In-app camera only for evidence fields (gallery import allowed but marked `source='gallery'`). Burn-in watermark: project, element/doc no., Gregorian + Ethiopian date/time, GPS + accuracy, user. Store `captured_at` (device), `received_at` (server), `sha256`, GPS accuracy, `source`, `device_id`. Geofence per project (polygon or centre+radius) ⇒ `outside_site` flag. Server compares device time vs first-sync time and flags clock skew > 10 min.
- **Data:** `attachments` += `captured_at timestamptz`, `gps_accuracy_m real`, `sha256 text`, `source text check in ('camera','gallery','scan')`, `width/height`, `outside_site bool`, `device_id uuid`; `projects` += `site_lat`, `site_lng`, `site_radius_m`. `kind` += `proforma`, `batch_ticket`, `lab_report`, `invoice`, `drawing`.
- **RPCs:** none new (attachment rows via existing insert path) — add trigger computing `outside_site`.

#### E3. Equipment & tools checkout — **P2, M**
- Worth it: tools (vibrators, drills, grinders, levels, scaffold, formwork panels) disappear constantly. Register with QR, check-out to person/subcontractor/element with expected return, check-in with condition; daily "out" list; equipment hours/breakdowns feed the diary; hire equipment with rate & days (cost). Tables `assets`, `asset_movements`, `asset_usage_logs`; RPCs `save_asset`, `asset_checkout`, `asset_checkin`. Offline append-only.

#### E4. Drawings & documents register — **P2, M**
- Register of drawings/specs with revision, status (for construction / superseded), transmittal date; elements link to drawing ids (replace `drawing_ref` text); mobile downloads current revisions for offline viewing (size budget per device); "superseded" banner when opening an old revision. Tables `documents`, `document_revisions`, `element_documents`. Markup/pins P3.

### F. Communication & approvals

#### F1. Telegram bot: notifications, approvals on the go, document sharing — **P1, M**
- **Problem:** Managers live in Telegram, not in our app; approvals wait until they open the web console; PDFs are forwarded manually.
- **How it works:** User links account: in app "Connect Telegram" → deep link `t.me/<bot>?start=<one-time code>` → bot binds `chat_id` to profile. Notifications (per preferences, FR-NT-02) go to Telegram with inline buttons: **Approve / Reject / Open**. Callback data = short token (≤ 64 bytes) referencing `telegram_action_tokens` (single-use, 72 h expiry, bound to user + entity + allowed action). Edge Function `telegram-webhook` validates token, then executes the same RPC as the user (mint short-lived user JWT so RLS, `approval_limits` and audit apply). Reject asks for a reason via ForceReply. Safety: Telegram approvals only below a project-configured value; above it the button opens the app. **Project groups:** daily summary (diary PDF, stock alerts, pours, overdue deliveries) posted to a linked project Telegram group. **Share sheet** everywhere (PDF of PO/MIV/GRN/diary/snag list) — uses OS share so WhatsApp/Telegram/SMS all work.
- **Data:** `telegram_links(user_id pk, chat_id bigint, linked_at)`, `telegram_link_codes`, `telegram_action_tokens`, `project_channels(project_id, chat_id, kinds text[])`, `notification_prefs(user_id, kind, channel)`.
- **RPCs:** `create_telegram_link_code`, `set_notification_prefs`; Edge Function `telegram-webhook`, extend `send-push` → `dispatch-notification`.
- **Offline:** n/a (server-side); in-app approvals remain the offline path.

#### F2. SMS fallback for critical alerts — **P3, S** (FR-NT-03; Ethio telecom/Safaricom SMS gateway).

#### F3. Approval inbox ("My approvals") — **P1, S (inside F1)**
- Single mobile + web list across MR, PO, adjustments, counts, gate passes, inspections, diaries; swipe approve/reject with comment; bulk approve under limit; shows value, budget impact and stock context. View `v_my_approvals` (union), RPCs reuse existing `*_action/decide_*`.

### G. Cost & analytics

#### G1. Budget / cost control: committed vs received vs issued — **P1, S (views, depends on A2)**
- **Problem:** Managers can't see money committed before invoices arrive (FR-CC-04).
- **How it works:** Per BoQ item / material category / block: **Budget** (take-off × budget rate or BoQ rate) · **Committed** (open PO value) · **Received** (GRN accepted × PO price) · **Issued** (MIV × moving-average cost) · **Installed** (progress × take-off) · **Forecast at completion** (issued + remaining take-off × latest price). Traffic lights; drill to documents. Price-restricted roles only.
- **Data:** `budget_lines(project_id, boq_item_id|material_spec_id, budget_qty, budget_rate)`; ledger valuation needs `stock_ledger.unit_cost` (set on GRN from PO price; moving average on issue) — add `stock_valuation` table if ledger must stay price-free for RLS. Views `v_cost_control`, `v_committed_cost`.

#### G2. Reorder suggestions & stock-out forecast — **P1, S**
- **Problem:** `reorder_level` is static; cement stock-outs stop pours; lead times are long and volatile.
- **How it works:** For each store × spec: average daily consumption (MIV net of MRN, last 14/30 days), days of cover = available / avg, demand from approved-not-issued MR lines and look-ahead, open PO qty with ETA, effective lead time (supplier actual from A5 else `lead_time_days`). **Suggested order qty** = (lead time + safety days) × avg + pending demand − available − on order, rounded to pack size (truck = 400 bags, 12 m bars bundles). Store dashboard: "Will run out in 3 days: Cement OPC 42.5"; one tap → MR draft (or PO request for procurement). Price trend (A6) shown next to it to support buy-ahead.
- **Data:** `material_specs` += `pack_size numeric`, `safety_days int`; view `v_reorder_suggestions`; RPC `create_mr_from_suggestions`.
- **Offline:** computed locally from synced ledger (same SQL in SQLite).

#### G3. Analytics & insights — **P2, M**
- Wastage hotspots (by element type/block/crew/store, heatmap), supplier lead time & reliability, consumption trend vs progress (S-curve of materials vs physical progress), cement bags/m³ trend, rebar kg/m³ by element type vs design norm, request-to-issue cycle time, count-variance trend per store keeper. Web console page + monthly PDF to management via Telegram. Materialised views refreshed nightly.

#### G4. Ledger valuation & month-end material report — **P2, M**
- Moving-average cost per store/spec; monthly "material reconciliation statement" (opening + received − issued ± adjustments = closing, at qty and value) — the format Ethiopian contractors submit with interim payment certificates.

### H. Localisation & usability

#### H1. Amharic UI + Ethiopian calendar — **P1, M**
- **Problem:** Store keepers and foremen are more comfortable in Amharic; paper forms and letters use Ethiopian dates; payment certificates use the Ethiopian fiscal year.
- **How it works:** i18n (i18next) with `en` + `am` (later `om`, `ti`); per-user `locale` and `calendar` (`gregorian`|`ethiopian`) preferences; all dates stored Gregorian, displayed/entered via an Ethiopian date picker (`kenat` converter); PDFs bilingual headers and both dates; numbers stay Western digits; material names keep English canonical + Amharic alias (`materials.name_am`, `material_specs.description_am`); search matches both. Noto Sans Ethiopic font bundled for PDFs. Reports can group by Ethiopian month/fiscal year (Hamle–Sene).
- **Data:** `profiles` += `locale text default 'en'`, `calendar text default 'gregorian'`; `materials.name_am`, `labour_trades.name_am`, `checklist_template_items.text_am`. SQL helper `app.to_ethiopian(date) returns record(y,m,d)` for reports.

#### H2. Voice notes & quick capture — **P3, S**
- Voice note attachments on snags/diary (Amharic dictation unreliable; store audio). `attachments.kind` += `audio`.

#### H3. Low-end device & data-saver mode — **P2, S**
- Photo compression profile (1280 px, ~200 KB), Wi-Fi-only photo upload toggle, sync-size dashboard, archive closed projects off-device.

---

## 3. Recommended "P1 now" scope (12 features)

Order reflects dependencies: A2 → A3/A6/G1; C1 → C3 gating; E2 underpins D1/B1/C2/C3.

| # | Feature | Why now | Effort |
|---|---|---|---|
| 1 | **A1 RFQ & quotation comparison** | Matches local 3-proforma practice; starts price history | M |
| 2 | **A2 Purchase orders (VAT/WHT, PDF/Telegram share)** + **A3 expected deliveries & GRN-against-PO** | Closes the money loop; unlocks committed cost, lead times, MR `ordered` status | M |
| 3 | **A6 Price history & spike alerts** | Cement/rebar volatility; buy-ahead + escalation evidence | S |
| 4 | **G1 Committed / received / issued cost control** | FR-CC-04; management's #1 question | S |
| 5 | **G2 Reorder suggestions & stock-out forecast** | Prevents pour stoppages; cheap (views) | S |
| 6 | **B1 Site diary** | Hub of field reporting; delay-claim evidence | M |
| 7 | **C1 Inspection checklists on hold points** + **C2 snags** | Gives hold points real content; closed quality loop | M |
| 8 | **C3 Concrete pour log, batch tickets & cube tests** | Largest cost item; FR-RC-06 | M |
| 9 | **C4 Rebar BBS reconciliation** | FR-CC-05; biggest wastage/theft line | M |
| 10 | **D1 Gate pass + vehicle log** + **D2 variance/anomaly alerts** | Anti-theft; materials leaving site is uncontrolled today | M |
| 11 | **E1 QR labels** + **E2 tamper-evident photos** | Cheap, makes every other control credible | S |
| 12 | **F1 Telegram bot + F3 approval inbox** | Approvals on the go where managers actually are | M |
| (+) | **H1 Amharic + Ethiopian calendar** | Adoption by store keepers; do the i18n plumbing now so all new screens are born bilingual (strings can be translated incrementally) | M |

> If 12 is a hard cap, merge #3 into #2 (price observations are written by the PO/quote RPCs) and keep H1 as #12; G2 is then folded into #5 → still 12.

New `DocType` values: `RFQ`, `QT` (quotation, server-numbered), `PO`, `GP` (gate pass), `SD` (site diary), `INS`, `SNG`, `POUR`, `CUBE` (cube set), `BBS`.
New roles/permissions (contract.ts `Action`): `rfq.manage`, `po.create`, `po.approve`, `po.viewPrices`, `diary.write`, `diary.sign`,
`inspection.perform`, `inspection.approve`, `snag.create`, `snag.verify`, `pour.log`, `cube.record`, `bbs.import`, `gatepass.create`,
`gatepass.approve`, `gatepass.verify`, `alert.manage`. New app role: `security` (gate verification only; sees gate passes and vehicle log, no stock/prices).

### 3.1 Data model sketches

Common columns on every table below unless stated: `id uuid primary key` (client-generated for offline docs, `default gen_random_uuid()` for server-only rows),
`project_id uuid not null references projects(id)`, `created_by uuid references profiles(id) default auth.uid()`, `device_id uuid`,
`created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`, `deleted_at timestamptz` (masters/child lines).
Header docs also carry `number text not null unique` (`<PROJECT>-<TYPE>-<DEVICE>-<SEQ>`) and `status text check (...)`.
All new tables go into `SYNC_TABLES` unless marked *(server/web only)*. Price tables are RLS-restricted by `app_settings.price_roles`.

#### P1-1 RFQ & quotations *(web/online; synced read-only to procurement & management devices)*

```sql
rfqs            (id, project_id, number text unique, title text, status text check (status in ('draft','sent','closed','awarded','cancelled')),
                 required_by date, delivery_store_id uuid references stores, min_quotes int not null default 3, notes text, sent_at timestamptz, closed_at timestamptz)
rfq_lines       (id, rfq_id uuid references rfqs on delete cascade, project_id, line_no int, material_spec_id uuid references material_specs,
                 qty numeric(14,3) not null check (qty > 0), mr_line_id uuid references mr_lines, required_date date, remarks text)
rfq_suppliers   (id, rfq_id uuid references rfqs on delete cascade, project_id, supplier_id uuid references suppliers,
                 sent_via text check (sent_via in ('telegram','whatsapp','email','sms','in_person','phone')), sent_at timestamptz,
                 unique (rfq_id, supplier_id))
quotations      (id, rfq_id uuid references rfqs, project_id, supplier_id uuid references suppliers, number text unique,
                 quote_ref text, quote_date date, valid_until date, prices_include_vat boolean not null default false,
                 delivery_days int, payment_terms text, transport_included boolean, status text check (status in ('received','withdrawn','awarded','not_awarded')))
quotation_lines (id, quotation_id uuid references quotations on delete cascade, project_id, rfq_line_id uuid references rfq_lines,
                 offered_spec_id uuid references material_specs, qty numeric(14,3), available boolean not null default true, remarks text)
quotation_line_prices  -- price-restricted
                (quotation_line_id uuid primary key references quotation_lines on delete cascade, project_id, unit_price numeric(18,2) not null,
                 currency text not null default 'ETB', transport_cost numeric(18,2) default 0, updated_at)
rfq_awards      (id, rfq_id, project_id, rfq_line_id uuid references rfq_lines, quotation_line_id uuid references quotation_lines,
                 qty numeric(14,3), reason text /* required when not lowest landed cost */, awarded_by uuid, awarded_at timestamptz)
```
RPCs:
- `save_rfq(p)` — `{op_id, id, project_id, number, title, required_by, delivery_store_id, min_quotes?, notes?, send: bool, lines:[{id, material_spec_id, qty, mr_line_id?, required_date?, remarks?}], suppliers:[{id, supplier_id, sent_via?}]}`; sets MR line status `sourced` on send.
- `record_quotation(p)` — `{op_id, id, rfq_id, supplier_id, quote_ref?, quote_date, valid_until?, prices_include_vat, delivery_days?, payment_terms?, transport_included?, attachment_ids?:uuid[], lines:[{id, rfq_line_id, offered_spec_id?, qty, unit_price, transport_cost?, available}]}`; writes `price_observations`.
- `award_rfq(p)` — `{op_id, rfq_id, awards:[{id, rfq_line_id, quotation_line_id, qty, reason?}], create_po: bool}`; enforces `min_quotes` (override reason above limit); optionally creates PO drafts per supplier.

#### P1-2 Purchase orders & deliveries

```sql
tax_settings    (id, effective_from date not null, vat_rate numeric(5,2) default 15, wht_goods_rate numeric(5,2) default 3,
                 wht_goods_threshold numeric(18,2) default 20000, wht_services_rate numeric(5,2) default 3,
                 wht_services_threshold numeric(18,2) default 10000, wht_no_tin_rate numeric(5,2) default 30)   -- company-wide, server/web
suppliers       += tin text, vat_registered boolean default false, telegram_chat text, bank_account text, payment_terms text
purchase_orders (id, project_id, number text unique, supplier_id uuid not null references suppliers, rfq_id uuid references rfqs,
                 delivery_store_id uuid not null references stores, status text check (status in
                 ('draft','submitted','approved','rejected','issued','partially_received','received','short_closed','cancelled')),
                 revision int not null default 0, order_date date, expected_date date, payment_terms text, advance_pct numeric(5,2),
                 delivery_terms text, remarks text, approved_by uuid, approved_at timestamptz, issued_at timestamptz,
                 eta date, delivery_status text check (delivery_status in ('pending','confirmed','dispatched','delayed','delivered')))
po_lines        (id, po_id uuid references purchase_orders on delete cascade, project_id, line_no int, material_spec_id uuid not null references material_specs,
                 qty numeric(14,3) not null check (qty > 0), uom text, mr_line_id uuid references mr_lines, quotation_line_id uuid references quotation_lines,
                 expected_date date, qty_received numeric(14,3) not null default 0, qty_accepted numeric(14,3) not null default 0,
                 closed boolean not null default false, deleted_at)
po_line_prices  (po_line_id uuid primary key references po_lines on delete cascade, project_id, unit_price numeric(18,2) not null,
                 vat_applicable boolean not null default true, currency text default 'ETB', updated_at)          -- price-restricted
po_totals       (po_id uuid primary key references purchase_orders, project_id, subtotal numeric(18,2), vat numeric(18,2),
                 withholding numeric(18,2), withholding_rate numeric(5,2), net_payable numeric(18,2), updated_at)  -- price-restricted, maintained by RPC
po_revisions    (id, po_id, project_id, revision int, snapshot jsonb, reason text, created_by, created_at)          -- server/web
po_delivery_updates (id, po_id, project_id, status text, eta date, note text, created_by, created_at)
grns            += po_id uuid references purchase_orders
grn_lines       += po_line_id uuid references po_lines
```
RPCs:
- `save_po(p)` — `{op_id, id, project_id, number, supplier_id, rfq_id?, delivery_store_id, order_date, expected_date?, payment_terms?, advance_pct?, delivery_terms?, remarks?, submit: bool, lines:[{id, material_spec_id, qty, uom?, mr_line_id?, quotation_line_id?, expected_date?, unit_price, vat_applicable?}]}` — computes `po_totals` from `tax_settings` + supplier TIN; checks MR approved qty not exceeded.
- `po_action(p)` — `{op_id, po_id, action:'submit'|'approve'|'reject'|'issue'|'cancel'|'short_close', comment?}` — approve checks `approval_limits` on net value; `issue` sets MR lines `ordered` and notifies requester + store keeper.
- `amend_po(p)` — `{op_id, po_id, reason, lines:[…same as save_po…]}` → revision+1, snapshot.
- `update_po_delivery(p)` — `{op_id, id, po_id, status, eta?, note?}`.
- `post_grn(p)` extended — header `po_id?`; lines `po_line_id?`; validates outstanding qty with `project_settings.over_receipt_pct` (new, default 2 %); updates `po_lines.qty_received/accepted` and PO status.
- View `v_po_line_status`, `v_expected_deliveries` (store dashboard).

#### P1-3 Price history

```sql
price_observations (id, project_id uuid null /* null = company-wide market */, material_spec_id uuid not null references material_specs,
                    supplier_id uuid references suppliers, unit_price numeric(18,2) not null /* ex-VAT, base uom */, currency text default 'ETB',
                    observed_on date not null, source text check (source in ('quotation','po','grn','market')), source_id uuid,
                    location text, note text)   -- price-restricted
project_settings += price_spike_pct numeric(5,2) not null default 15
```
RPC `log_market_price(p)` — `{op_id, id, material_spec_id, unit_price, observed_on, supplier_id?, location?, note?}`. View `v_price_trend` (spec, week, min/median/max, Δ vs 30-day median). Spike ⇒ `alerts` row (rule `price_spike`).

#### P1-4 Cost control *(views + one table)*

```sql
budget_lines   (id, project_id, boq_item_id uuid references boq_items, material_spec_id uuid references material_specs,
                budget_qty numeric(16,3), budget_rate numeric(18,2), deleted_at)  -- price-restricted; import from Excel
stock_valuation (ledger_id uuid primary key references stock_ledger, project_id, unit_cost numeric(18,4), value numeric(18,2), updated_at)
                -- price-restricted shadow of the ledger; written by post_grn (PO price or spec_prices) and issue functions (moving average)
```
Views: `v_committed_cost` (PO open qty × price), `v_cost_control` (budget / committed / received / issued / installed / forecast by BoQ item, category, block). No new RPCs except `import_budget(p)` — `{op_id, project_id, lines:[{boq_item_id?, material_spec_id?, budget_qty, budget_rate}]}`.

#### P1-5 Reorder suggestions

```sql
material_specs += pack_size numeric(14,3) not null default 1, safety_days int not null default 3
```
View `v_reorder_suggestions` (store_id, material_spec_id, available, avg_daily_use_14d, avg_daily_use_30d, days_cover, pending_mr_qty, on_order_qty, next_eta, effective_lead_days, suggested_qty, stockout_date).
RPC `create_mr_from_suggestions(p)` — `{op_id, id, project_id, number, store_id, block_id, required_date, lines:[{id, material_spec_id, qty}]}` → delegates to `save_mr` logic with `purpose='Reorder'` (elements optional for stock replenishment — needs `mr_line_elements` to allow zero rows when `purpose='Reorder'`).

#### P1-6 Site diary

```sql
labour_trades     (id, name text unique, name_am text, sort_order int, deleted_at)                       -- master, company-wide
site_diaries      (id, project_id, number text unique, diary_date date not null, block_id uuid references blocks,
                   weather_am text, weather_pm text, rain_hours numeric(4,1), temp_min numeric(4,1), temp_max numeric(4,1), weather_source text check (weather_source in ('manual','api')),
                   work_summary text, instructions text, safety_notes text, status text check (status in ('draft','submitted','signed')),
                   signed_by uuid, signed_at timestamptz, unique nulls not distinct (project_id, block_id, diary_date))
diary_labour      (id, diary_id uuid references site_diaries on delete cascade, project_id, trade_id uuid references labour_trades,
                   subcontractor text, headcount int not null check (headcount >= 0), hours numeric(5,1), deleted_at)
diary_equipment   (id, diary_id, project_id, equipment text, asset_id uuid /* later: assets */, qty int, hours_worked numeric(5,1),
                   hours_idle numeric(5,1), status text check (status in ('working','idle','breakdown')), note text, deleted_at)
diary_delays      (id, diary_id, project_id, cause text check (cause in ('weather','material_shortage','cement_shortage','power_cut','water',
                   'design_info','payment','labour','equipment','client','other')), hours_lost numeric(5,1), element_id uuid references elements,
                   description text, deleted_at)
diary_visitors    (id, diary_id, project_id, name text, organisation text, purpose text, time_in time, time_out time, deleted_at)
diary_addenda     (id, diary_id, project_id, text text, created_by, created_at)
```
RPCs:
- `save_site_diary(p)` — `{op_id, id, project_id, number, diary_date, block_id?, weather_am?, weather_pm?, rain_hours?, temp_min?, temp_max?, weather_source?, work_summary?, instructions?, safety_notes?, submit: bool, labour:[{id, trade_id, subcontractor?, headcount, hours?}], equipment:[{id, equipment, qty?, hours_worked?, hours_idle?, status, note?}], delays:[{id, cause, hours_lost?, element_id?, description?}], visitors:[{id, name, organisation?, purpose?, time_in?, time_out?}]}` — child arrays replace-by-id (soft delete missing) while draft; if another diary exists for the same key, the server returns `{conflict:'exists', existing_id}` and the client offers "append as addendum".
- `sign_site_diary(p)` — `{op_id, diary_id, comment?}`.
- `add_diary_addendum(p)` — `{op_id, id, diary_id, text}`.
- View `v_diary_auto` (per date: GRNs, MIVs, progress reports, pours, inspections, snags) for the auto sections and PDF.

#### P1-7 Inspections & snags

```sql
checklist_templates      (id, project_id uuid null /* null = company */, code text, name text, name_am text, element_type text,
                          version int not null default 1, is_active boolean default true, deleted_at)
checklist_template_items (id, template_id uuid references checklist_templates on delete cascade, seq int, text text, text_am text,
                          item_type text check (item_type in ('pass_fail','number','text','photo','signature')),
                          min_value numeric, max_value numeric, unit text, photo_required boolean default false, is_critical boolean default false, deleted_at)
activity_templates       += checklist_template_id uuid references checklist_templates
element_activities       += checklist_template_id uuid references checklist_templates
inspections              (id, project_id, number text unique, template_id uuid references checklist_templates, template_version int,
                          element_id uuid references elements, element_activity_id uuid references element_activities,
                          inspected_at timestamptz, inspector_id uuid, consultant_name text, result text check (result in ('pass','fail','conditional')),
                          status text check (status in ('submitted','approved','rejected')), reinspection_of uuid references inspections,
                          approved_by uuid, approved_at timestamptz, remarks text)
inspection_items         (id, inspection_id uuid references inspections on delete cascade, project_id, template_item_id uuid references checklist_template_items,
                          response text check (response in ('pass','fail','na')), value_num numeric, value_text text, snag_id uuid)
snags                    (id, project_id, number text unique, element_id uuid references elements, block_id uuid, level_id uuid, location_text text,
                          category text, severity text check (severity in ('low','medium','high','critical')), title text, description text,
                          assignee_user_id uuid references profiles, assignee_party text /* subcontractor */, due_date date,
                          source_type text check (source_type in ('inspection','walk','pour','cube','other')), source_id uuid,
                          status text check (status in ('open','fixed','closed','reopened','cancelled')), closed_by uuid, closed_at timestamptz)
snag_events              (id, snag_id uuid references snags, project_id, action text, comment text, actor uuid, created_at)
```
RPCs:
- `save_checklist_template(p)` — `{op_id, id, project_id?, code, name, name_am?, element_type?, items:[{id, seq, text, text_am?, item_type, min_value?, max_value?, unit?, photo_required?, is_critical?}]}` (bumps `version` if used).
- `submit_inspection(p)` — `{op_id, id, project_id, number, template_id, element_id, element_activity_id?, inspected_at, consultant_name?, remarks?, reinspection_of?, items:[{id, template_item_id, response, value_num?, value_text?}], snags:[{…save_snag fields…, inspection_item_id}]}` — result computed server-side (any critical fail ⇒ `fail`); pass on a hold-point activity sets a flag that `report_progress` checks instead of the current plain hold-point verify.
- `decide_inspection(p)` — `{op_id, inspection_id, approve, comment?}`.
- `save_snag(p)` — `{op_id, id, project_id, number, element_id?, location_text?, category, severity, title, description?, assignee_user_id?, assignee_party?, due_date?, source_type, source_id?}`.
- `snag_action(p)` — `{op_id, snag_id, action:'fix'|'verify'|'reopen'|'cancel', comment?}` (`fix` requires an after-photo attachment; `verify` by a different user).

#### P1-8 Concrete pours & cubes

```sql
mix_designs  (id, project_id, grade text /* C25 */, material_spec_id uuid references material_specs /* concrete spec, ready-mix */, source text check (source in ('ready_mix','site')),
              cement_kg_per_m3 numeric(7,2), sand_m3_per_m3 numeric(6,3), aggregate_m3_per_m3 numeric(6,3), water_l_per_m3 numeric(7,2),
              target_slump_mm int, slump_tolerance_mm int, deleted_at)
pours        (id, project_id, number text unique, pour_date date, mix_design_id uuid references mix_designs, source text check (source in ('ready_mix','site')),
              supplier_id uuid references suppliers, planned_m3 numeric(10,3), actual_m3 numeric(10,3), start_at timestamptz, end_at timestamptz,
              weather text, pre_pour_inspection_id uuid references inspections, curing_method text,
              status text check (status in ('planned','in_progress','completed','cancelled')), remarks text)
pour_elements (id, pour_id uuid references pours on delete cascade, project_id, element_id uuid references elements, planned_m3 numeric(10,3), unique (pour_id, element_id))
pour_trucks  (id, pour_id uuid references pours, project_id, seq int, ticket_no text, truck_plate text, batched_at timestamptz, arrived_at timestamptz,
              discharge_start timestamptz, discharge_end timestamptz, volume_m3 numeric(6,2) not null, slump_mm int, concrete_temp_c numeric(4,1),
              water_added_l numeric(6,1), accepted boolean not null, reject_reason text, grn_id uuid references grns, miv_id uuid references mivs)
pour_batches (id, pour_id, project_id, seq int, cement_bags numeric(6,2), sand_m3 numeric(6,3), aggregate_m3 numeric(6,3), water_l numeric(7,1),
              slump_mm int, mixer text, batched_at timestamptz)
cube_sets    (id, project_id, number text unique, pour_id uuid references pours, truck_id uuid references pour_trucks, element_id uuid references elements,
              sampled_at timestamptz, cubes int not null default 3, cube_size_mm int default 150, test_ages int[] default '{7,28}', lab_name text)
cube_results (id, cube_set_id uuid references cube_sets on delete cascade, project_id, cube_label text, age_days int, tested_on date,
              load_kn numeric(8,2), strength_mpa numeric(6,2), density_kg_m3 numeric(7,1), failure_mode text, lab_report_attachment_id uuid,
              passed boolean /* computed vs grade */)
```
RPCs:
- `save_pour(p)` — `{op_id, id, project_id, number, pour_date, mix_design_id, source, supplier_id?, planned_m3, pre_pour_inspection_id?, curing_method?, remarks?, elements:[{id, element_id, planned_m3}]}` — blocks if hold-point inspection not passed and `enforce_hold_points`.
- `add_pour_truck(p)` — `{op_id, id, pour_id, seq, ticket_no, truck_plate?, batched_at?, arrived_at?, discharge_start?, discharge_end?, volume_m3, slump_mm?, concrete_temp_c?, water_added_l?, accepted, reject_reason?, store_id, grn_number, miv_number}` — accepted trucks post GRN (+ `po_line_id` if a ready-mix PO exists) and MIV split pro-rata across `pour_elements` atomically (reusing `app.post_ledger`). Warns if batched→arrival > 90 min or water added > 0.
- `add_pour_batch(p)` — `{op_id, id, pour_id, seq, cement_bags, sand_m3?, aggregate_m3?, water_l?, slump_mm?, mixer?, batched_at}` (cement itself is issued by the store keeper via MIV to the pour's elements; view compares).
- `close_pour(p)` — `{op_id, pour_id, actual_m3?, end_at, remarks?}` — computes over-pour %, sets element activity "Concreting" reported 100 %.
- `save_cube_set(p)` — `{op_id, id, project_id, number, pour_id, truck_id?, element_id?, sampled_at, cubes, cube_size_mm?, test_ages?, lab_name?}` — creates reminders.
- `record_cube_results(p)` — `{op_id, cube_set_id, results:[{id, cube_label, age_days, tested_on, load_kn?, strength_mpa?, density_kg_m3?, failure_mode?, lab_report_attachment_id?}]}` — failure ⇒ critical notification + auto snag (`source_type='cube'`).
- Views `v_pour_summary` (planned vs actual m³, trucks rejected, cement bags/m³ vs mix design), `v_cubes_due`.

#### P1-9 Rebar BBS reconciliation

```sql
bbs_schedules (id, project_id, number text unique, element_id uuid references elements, revision int not null default 0, drawing_ref text,
               status text check (status in ('draft','approved','superseded')), approved_by uuid, approved_at timestamptz, deleted_at)
bbs_lines     (id, bbs_id uuid references bbs_schedules on delete cascade, project_id, bar_mark text, material_spec_id uuid references material_specs /* Ø + grade */,
               diameter_mm int not null, shape_code text, no_of_members int not null default 1, bars_per_member int not null,
               cut_length_m numeric(8,3) not null, total_length_m numeric(12,3) generated always as (no_of_members * bars_per_member * cut_length_m) stored,
               unit_weight_kg_m numeric(8,4) generated always as (diameter_mm * diameter_mm / 162.0) stored,
               theoretical_kg numeric(12,3) generated always as (no_of_members * bars_per_member * cut_length_m * diameter_mm * diameter_mm / 162.0) stored, deleted_at)
material_specs += diameter_mm int, is_offcut boolean default false
```
RPCs: `import_bbs(p)` — `{op_id, id, project_id, number, element_id, revision, drawing_ref?, lines:[{id, bar_mark, material_spec_id, diameter_mm, shape_code?, no_of_members, bars_per_member, cut_length_m}]}`; `approve_bbs(p)` — `{op_id, bbs_id}` (supersedes older revision; optionally updates `element_takeoffs.planned_qty` for rebar specs).
View `v_rebar_reconciliation` (element, Ø: bbs_kg, takeoff_kg, issued_kg (MIV − MRN, converted via `spec_conversions` when issued in bars/pieces), offcut_returned_kg, variance_kg, variance_pct, allowance_pct, flag).

#### P1-10 Gate pass, vehicle log & alerts

```sql
-- role enum: app_role += 'security'
gate_passes      (id, project_id, number text unique, pass_type text check (pass_type in ('returnable','non_returnable','transfer','supplier_return','scrap_sale')),
                  store_id uuid references stores, destination text, purpose text, vehicle_plate text, driver_name text, driver_phone text,
                  expected_return date, linked_doc_type text, linked_doc_id uuid,
                  status text check (status in ('draft','pending','approved','rejected','exited','partially_returned','returned','cancelled','overdue')),
                  approved_by uuid, approved_at timestamptz, exited_at timestamptz, qr_sig text)
gate_pass_lines  (id, gate_pass_id uuid references gate_passes on delete cascade, project_id, line_no int, material_spec_id uuid references material_specs,
                  asset_id uuid, description text, qty numeric(14,3) not null, uom text, qty_returned numeric(14,3) not null default 0, deleted_at)
gate_events      (id, project_id, gate_pass_id uuid references gate_passes, event text check (event in ('exit_verified','exit_mismatch','return_in')),
                  plate_seen text, matches boolean, note text, actor uuid, at timestamptz)
vehicle_movements (id, project_id, direction text check (direction in ('in','out')), plate text not null, driver_name text, purpose text,
                  loaded boolean, linked_doc_type text, linked_doc_id uuid, at timestamptz not null, actor uuid)
stock_ledger     txn_type += 'gate_out','gate_in';  stock_status += 'on_loan'
alert_rules      (id, project_id uuid null, rule text, threshold numeric, params jsonb, severity text, is_active boolean, updated_at)
alerts           (id, project_id, rule text, severity text check (severity in ('info','warning','critical')), entity_type text, entity_id uuid,
                  title text, details jsonb, status text check (status in ('open','acknowledged','closed')), assigned_to uuid,
                  acked_by uuid, acked_at timestamptz, closed_by uuid, closed_at timestamptz, close_note text, unique (rule, entity_type, entity_id, status))
```
RPCs:
- `save_gate_pass(p)` — `{op_id, id, project_id, number, pass_type, store_id?, destination, purpose, vehicle_plate?, driver_name?, driver_phone?, expected_return?, linked_doc_type?, linked_doc_id?, submit: bool, lines:[{id, material_spec_id?, asset_id?, description?, qty, uom?}]}`.
- `gate_pass_action(p)` — `{op_id, gate_pass_id, action:'approve'|'reject'|'cancel', comment?}` (non_returnable/scrap always needs mgmt approval; stock availability checked).
- `verify_gate_pass(p)` — `{op_id, id /*event id*/, gate_pass_id, plate_seen, matches, note?, at}` — on match posts `gate_out` (non-returnable) or moves to `on_loan` (returnable); mismatch ⇒ critical alert.
- `return_gate_pass(p)` — `{op_id, id, gate_pass_id, at, lines:[{gate_pass_line_id, qty_returned}]}`.
- `log_vehicle(p)` — `{op_id, id, project_id, direction, plate, driver_name?, purpose?, loaded?, linked_doc_type?, linked_doc_id?, at}`.
- `ack_alert(p)` — `{op_id, alert_id, comment?}`; `close_alert(p)` — `{op_id, alert_id, close_note}`.
- `app.run_alert_rules()` (pg_cron every 15 min + called at end of posting RPCs for cheap rules).

#### P1-11 QR & photo evidence

```sql
attachments += captured_at timestamptz, gps_accuracy_m real, sha256 text, source text check (source in ('camera','gallery','scan')) default 'camera',
               device_id uuid, outside_site boolean, width int, height int
               -- kind check += 'proforma','batch_ticket','lab_report','invoice','drawing','audio'
projects    += site_lat double precision, site_lng double precision, site_radius_m int default 300
qr_labels   (id, project_id, target_type text check (target_type in ('store','bin','element','asset','document')), target_id uuid,
             material_spec_id uuid, label text, printed_at timestamptz, printed_by uuid)
project_keys (project_id uuid primary key, public_key text, private_key_ref text)   -- private key in Vault, public key synced
```
RPCs: `register_qr_labels(p)` — `{op_id, project_id, labels:[{id, target_type, target_id, material_spec_id?, label}]}`; `sign_document(p)` — `{doc_type, doc_id}` returns signature (called by sync after upload; signature stored in each document's new `qr_sig text` column). QR payload: `sm1:<type>:<uuid>:<sig-base64url>` (≈ 130 chars, fits QR v6).

#### P1-12 Telegram, approval inbox & preferences

```sql
telegram_links        (user_id uuid primary key references profiles, chat_id bigint unique not null, username text, linked_at timestamptz, updated_at)  -- own row visible
telegram_link_codes   (code text primary key, user_id uuid, expires_at timestamptz)                    -- server only
telegram_action_tokens(token text primary key /* 16 random bytes b64url */, user_id uuid, entity_type text, entity_id uuid,
                       allowed_actions text[], expires_at timestamptz, used_at timestamptz)              -- server only
project_channels      (id, project_id, chat_id bigint, title text, kinds text[] /* daily_summary, alerts, pours, deliveries */, updated_at)
notification_prefs    (user_id uuid, kind text, channel text check (channel in ('in_app','push','telegram','sms')), enabled boolean,
                       quiet_from time, quiet_to time, primary key (user_id, kind, channel))
profiles              += locale text default 'en', calendar text default 'gregorian', telegram_linked boolean default false
```
RPCs: `create_telegram_link_code(p)` — `{op_id}` → `{code, deep_link}`; `unlink_telegram(p)` — `{op_id}`; `set_notification_prefs(p)` — `{op_id, prefs:[{kind, channel, enabled, quiet_from?, quiet_to?}]}`; `save_project_channel(p)` — `{op_id, id, project_id, chat_id, kinds}`.
Edge Functions: `telegram-webhook` (start/link, callback approve/reject → calls `mr_action`/`po_action`/`decide_adjustment`/`gate_pass_action` with a minted user JWT; enforces `project_settings.telegram_approval_max_value`), `dispatch-notification` (replaces `send-push`; fans out per `notification_prefs`), `daily-summary` (pg_cron 18:00 EAT).
View `v_my_approvals` — union of pending MRs, POs, adjustments, counts, gate passes, inspections, diaries for `auth.uid()` with value and age.

(+) **Amharic & Ethiopian calendar**: `profiles.locale/calendar` above; `materials.name_am`, `labour_trades.name_am`, `checklist_*.text_am`; SQL `app.to_ethiopian(d date) returns table(y int, m int, d int)` + `app.eth_fiscal_year(d date)`; mobile/web i18n bundles; `kenat` for conversion + custom picker.

### 3.2 Cross-cutting implementation notes

- **Price visibility:** keep quantities in synced doc tables and money in `*_prices`/`po_totals`/`stock_valuation` with RLS on `app_settings.price_roles` — same pattern as `spec_prices`; store keepers can then receive against POs offline without seeing prices.
- **Contract updates:** extend `DocType`, `Action`, `SYNC_TABLES`, `RpcMap`; bump outbox schema; add `AppRole 'security'` with a minimal dashboard kind `gate`.
- **Ledger stays append-only:** pours post GRN+MIV pairs; gate passes post `gate_out`/`gate_in`; reversals reuse `reverse_document` (extend `doc_type` to `gate_pass`, `pour_truck`).
- **Sync volume:** procurement and price tables sync only to roles that can see them; diaries/inspections sync last 60 days + open items; pour/cube full history per project (small).
- **Migration order:** (1) attachments/E2 + QR + i18n columns, (2) PO & tax + GRN link, (3) RFQ/quotes/prices, (4) cost views & reorder, (5) inspections/snags, (6) pours/cubes, (7) BBS, (8) gate pass/alerts/security role, (9) diary, (10) Telegram.

---

## 4. Sources

Products
- Procore Materials — https://www.procore.com/materials ; https://www.procore.com/blog/track-your-construction-materials-from-purchase-to-installation ; https://support.procore.com/products/online/materials-user-guide-with-project-financials ; https://en-gb.support.procore.com/faq/how-do-i-track-the-actual-materials-received-and-installed-on-a-job-site
- Procore inspections → observations — https://support.procore.com/tc/PC_Construction/Roles/Field/Observations_from_Deficient_Inspection_Items ; https://support.procore.com/faq/inspection-requirements-general-faq
- Kojo — https://research.contrary.com/company/kojo ; https://prnewswire.com/news-releases/kojo-expands-warehouse-product-with-prefabrication-offering-302217710.html ; https://www.forconstructionpros.com/equipment/equipment-technology/software-solutions/article/22908769/construction-procurement-software-company-rebrands-as-kojo-expands-functionality
- Raken — https://www.rakenapp.com/features/daily-reports ; https://help.rakenapp.com/en/articles/14465514-how-to-customize-daily-report-sections-in-raken
- Fieldwire — https://fieldwire.com/support/using-fieldwire ; https://www.jibble.io/construction-software-reviews/fieldwire-review
- Sitemate Dashpivot — https://help.sitemate.com/en/articles/2481868-inspection-test-plans-and-checklists ; https://sitemate.com/templates/quality/forms/inspection-and-test-plan-template/
- Novade — https://www.novade.net/en/construction-software-general-contractors/ ; https://datadrivenaec.com/tools/novade
- Autodesk Build — https://help.autodesk.com/cloudhelp/ENU/Build-GS/files/What_is_Build.html ; https://blog.hagerman.com/what-is-autodesk-build-a-practical-overview-for-construction-teams
- Buildertrend — https://buildertrend.com/builder-software/ ; https://techrepublic.com/article/buildertrend-review
- Oracle Aconex — https://help.aconex.com/mail/what-is-the-difference-between-a-document,-a-transmittal,-and-a-/ ; https://erpresearch.com/erp-add-ons/construction/oracle-aconex
- Trimble Viewpoint Field View — https://trimble.com/en/products/viewpoint-field-view ; https://help.trimble.com/doc/viewpoint-field-view/viewpoint-field-view/welcome-to-field-view
- ERPNext — https://docs.frappe.io/erpnext/user/manual/en/auto-creation-of-material-request ; https://docs.frappe.io/erpnext/procurement-cycle-overview
- Powerplay — https://www.getpowerplay.in/material-management/ ; https://yourstory.com/2022/03/saas-startup-powerplay-connects-stakeholders-construction-sector/amp
- Onsite / Srijan / Procurex / Livefield — https://apps.apple.com/us/app/-/id6443621595 ; https://www.techjockey.com/detail/srijan-construction-manager ; https://apps.apple.com/in/app/procurex/id6754873085
- Zepth — https://www.capterra.com/p/204376/Zepth/
- African marketplaces — https://techcrunch.com/2023/02/19/jumba-a-kenyan-startup-simplifying-sourcing-of-construction-supplies-raises-4-5m/ ; https://businessday.ng/technology/article/cinderbuild-automates-fragmented-construction-materials-market/ ; https://vc4a.com/ventures/cutstruct-technology-limited/
- Concrete — https://aggregate.com/concretedirect ; https://apps.apple.com/py/app/loop-digital-ticket/id6670759877 ; https://ccsbestpractice.org.uk/entries/concrete-dna-web-portal-for-tracking-concrete-performance/ ; https://apps.apple.com/hn/app/forneyfield/id1592128605 ; https://constructionbids.ai/templates/concrete-pour-log ; https://www.infralens.in/qaqc/concrete/concrete-pour-register
- Rebar/BBS — https://civil4m.com/threads/how-to-control-reinforcement-steel-wastage-at-construction-projects.1075/ ; https://civils.ai/free-construction-estimating-software/rebar-weight
- Gate pass — https://onestop.global/gate-pass-management-software/material-management ; https://happy-visitor.com/material-management-features/
- Tool tracking — https://gocodes.com/check-in-check-out-software/ ; https://www.remarcable.com/blog/qr-codes-tool-tracking-for-contractors ; https://itemit.com/blog/best-construction-tool-tracking-app-features/

Ethiopia
- Cement market — https://ethiopianbusinessreview.net/cement-conundrum/ ; https://www.thereporterethiopia.com/10696/ ; https://www.capitalethiopia.com/capital/maneuvering-the-cement-shortage-crisis ; https://allafrica.com/stories/202412190040.html
- Rebar & devaluation — https://www.thereporterethiopia.com/article/price-rebar-soars-50pc-just-month ; https://www.thereporterethiopia.com/1398/ ; https://addisfortune.news/rebar-price-reverses-sales-shrink
- Price adjustment / index — https://addisfortune.news/authority-bets-on-price-adjustment-manual-to-tackle-construction-delays ; https://addisfortune.news/agency-to-prepare-separate-price-index-for-construction-materials
- Tax — https://taxsummaries.pwc.com/ethiopia/corporate/withholding-taxes ; https://addisfortune.news/the-withholding-tax-dilemma-hidden-in-plain-sight ; https://www.thereporterethiopia.com/31131/
- Telegram — https://qz.com/africa/1214381/in-a-continent-dominated-by-whatsapp-ethiopia-says-yes-to-telegram ; https://www.lolinemag.com/article/why-telegram-became-the-go-to-platform-in-ethiopia ; https://techmoran.com/2023/07/06/ethiopian-payments-provider-chapa-partners-with-telegram-to-revolutionize-digital-payments/
- Telegram Bot API limits — https://docs.aiogram.dev/en/v3.15.0/api/methods/send_document.html (verify against core.telegram.org/bots/api)
- Waste/theft — https://etd.aau.edu.et/bitstreams/f4f42b5c-7857-4e7f-b3b5-aa37cd20cb4c/download ; https://addisstandard.com/?p=31144 ; https://www.thereporterethiopia.com/48371/
- Concrete quality — https://journals.hu.edu.et/hu-journals/index.php/ejet/article/download/489/276/11117 ; https://dissertations.mak.ac.ug/handle/20.500.12281/5187
- Ethiopian calendar libs — https://app.unpkg.com/kenat@4.0.0/files/dist/index.d.cts ; https://classic.yarnpkg.com/en/package/ethiopic-js

*Caveats: many product claims are vendor marketing; Ethiopian tax thresholds and the 3-proforma practice should be confirmed with the client's finance team (keep them configurable). Telegram limits are from third-party docs.*
