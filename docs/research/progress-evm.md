# Project Progress Management & Earned Value (MSP schedule import → EVM)

*Research + implementation spec, 30 Oct 2026. Client requirement: accept the project's Microsoft Project
(MSP) schedule, extract every detail (WBS, BoQ items, planned start/finish, duration, predecessors/successors with
type + lag, baseline, costs, resources), and run Earned Value Management on it, with progress entered by the
right roles (site engineer reports field quantities; office engineer verifies, maintains schedule/BoQ,
updates actuals).*

This document builds on what already exists. It does not replace it:

| Existing | Reused for |
|---|---|
| `elements`, `element_activities` (+ `activity_templates` weights, hold points), `progress_updates`, `report_progress` / `verify_progress`, `app.refresh_element_progress` | Field progress. Schedule tasks can **derive** their % from verified element activities, so site engineers keep one way of reporting |
| `boq_items` (qty) + `boq_rates` (price-restricted) | BoQ ↔ task mapping, quantity-based EV, contract-value weights, monthly valuation |
| `element_takeoffs.boq_item_id` | Auto-suggests how much of a BoQ item each task covers (sum over linked elements) |
| `stock_ledger` (MIV/MRN with `element_id`, `mr_line_id → boq_item_id`) + valuation logic in `v_cost_control` | **Material actual cost (AC)**, with no double entry |
| `budget_lines` (price-restricted) | Cost-basis BAC when the contractor keeps an internal cost budget |
| `diary_labour`, `diary_equipment` | Optional automatic labour and equipment AC estimates (hours × price-restricted rates) |
| `alert_rules` / `alerts`, `notify_roles`, `processed_ops`, `app.audit`, `app.block_mutation`, `app.local_date` | Threshold alerts, idempotent RPCs, audit, immutability, site-local dates |
| Web `xlsx` (SheetJS 0.20.3 already in `web/package.json`) | Excel schedule import |

Conventions are the same as migrations 0001–0007. Ids are client uuids. Every row has `project_id` and
`updated_at` (incremental sync). RLS: members read; money lives in separate `*_costs` tables readable only when
`app.can_see_prices()`. Writes go only through `security definer` RPCs that take one `jsonb p` with `op_id`.

---

## 1. Import formats & browser parsing

### 1.1 Recommendation

| Format | Accept? | How |
|---|---|---|
| **MSPDI XML** (MSP *File → Save As → XML Format (\*.xml)*; every MSP from 2002 through Project Online desktop) | **Primary, v1** | Parsed **in the browser** with `DOMParser`, then sent to `import_schedule` as normalised JSON |
| **Excel (.xlsx/.csv)** in *our* template (also reachable from MSP's Export Wizard with a saved map) | **Secondary, v1** | SheetJS in the browser, same JSON |
| **.mpp** (binary, OLE compound file) | **Not in the browser.** On upload, show "In MS Project: File → Save As → XML" with a screenshot | Later option: a converter service running MPXJ (Java; .NET/Python wrappers exist). It **cannot** run in Supabase Edge Functions (Deno, no JVM). It could run in a small container or on the office PC next to `local-server` |
| Primavera XER/PMXML, Asta | Later (MPXJ reads them) | Same converter |

Why MSPDI: it is a documented, lossless XML image of the project. It contains everything listed below:
calendars, custom fields, 11 baselines, links with lag, resources, assignments and timephased data. Parsing it
in the browser keeps the server free of untrusted-file parsing. The user also sees a preview/diff before
anything is written.

### 1.2 MSPDI structure: the exact paths we read

Root: `<Project xmlns="http://schemas.microsoft.com/project">`. Elements that hold no data are **left out**
(MSP drops blank fields to keep the file small), so every field is optional in the parser.

**Project header** (`/Project/…`)

| Path | Use |
|---|---|
| `SaveVersion`, `Name`, `Title`, `LastSaved` | Provenance |
| `StartDate`, `FinishDate`, `ScheduleFromStart` | Project window (reject finish-scheduled projects, or warn) |
| `StatusDate`, `CurrentDate` | File status date (shown; used for opening progress) |
| `CalendarUID` | Project base calendar |
| `MinutesPerDay` (default 480), `MinutesPerWeek` (2400; **2880 for a 6-day Ethiopian week**), `DaysPerMonth` (20) | Duration conversion |
| `CurrencyCode` (ISO 4217, e.g. `ETB`), `CurrencySymbol`, `CurrencyDigits` | Reject or warn if not the project currency |
| `BaselineForEarnedValue` | Which baseline number (0–10) the planner uses for EV. This is our default |
| `EarnedValueMethod` / `DefaultTaskEVMethod` (0 = % Complete, 1 = Physical % Complete) | Informational |
| `ExtendedAttributes/ExtendedAttribute` → `FieldID`, `FieldName` (e.g. `Text1`), `Alias` (e.g. "BoQ Item") | Custom-field dictionary. Lets the user pick "which column holds BoQ item no." by alias |

**Calendars** (`/Project/Calendars/Calendar`)

| Path | Notes |
|---|---|
| `UID`, `Name`, `IsBaseCalendar`, `BaseCalendarUID` | Resource and task calendars inherit from a base calendar |
| `WeekDays/WeekDay` → `DayType` (1 = Sun … 7 = Sat; `0` = an old-style exception with `TimePeriod/FromDate,ToDate`), `DayWorking` (0/1), `WorkingTimes/WorkingTime/FromTime,ToTime` | Minutes per weekday = Σ(ToTime − FromTime) |
| `Exceptions/Exception` → `TimePeriod/FromDate,ToDate`, `DayWorking`, `Name`, `WorkingTimes` (2007+) | Holidays. Ethiopian holidays (Genna, Timket, Adwa, Fasika, Eid al-Fitr, Eid al-Adha, Meskel, Enkutatash…) usually live here |
| `WorkWeeks/WorkWeek` → `TimePeriod`, `WeekDays` | Alternative work weeks (e.g. a rainy-season pattern). Project 2007 SP1 wrote these wrongly, so treat them as best effort |

**Tasks** (`/Project/Tasks/Task`). Read **direct children only.** `UID`, `Type`, `Start`, `Finish` and
`Value` also occur inside nested `Baseline`, `TimephasedData` and `PredecessorLink`. Calling
`getElementsByTagName('UID')` on a task returns the wrong values.

| Path | Use / conversion |
|---|---|
| `UID` | **Stable identity** across saves and re-imports (deleting a task never renumbers the others) |
| `GUID` | Second key (Project 2007+). Survives some copy/paste operations where UID does not |
| `ID` | Row number. **Changes** when rows are inserted. Display only |
| `Name`, `WBS`, `OutlineNumber`, `OutlineLevel` | Hierarchy. `OutlineLevel 0` / `UID 0` is the project summary task, which we skip. Parent = the nearest preceding task (in `ID` order) with `OutlineLevel − 1` |
| `Summary`, `Milestone`, `IsNull`, `Active` (0 = inactive, skip), `Manual` (1 = manually scheduled, warn), `ExternalTask` / `IsSubproject` (skip and warn) | Task kind |
| `Start`, `Finish` | Current plan. `YYYY-MM-DDThh:mm:ss`, **local project time with no zone offset** (see gotchas) |
| `Duration` + `DurationFormat` | ISO 8601 `PT…H…M…S` (e.g. `PT16H0M0S` = 2 d at 480 min/day). MSP always writes hours, whatever unit is displayed |
| `RemainingDuration`, `ActualDuration` | Same format |
| `Work`, `ActualWork`, `RemainingWork` | Same format (resource hours) |
| `Cost`, `FixedCost`, `FixedCostAccrual` (1 = start, 2 = end, 3 = prorated), `ActualCost`, `RemainingCost` | Currency. **MPXJ reads MSPDI currency as hundredths (÷100)**, so confirm it on the client's first file (preview total vs MSP's *Project Statistics*) |
| `PercentComplete`, `PercentWorkComplete`, `PhysicalPercentComplete`, `EarnedValueMethod` | Opening progress (first import only) |
| `ActualStart`, `ActualFinish`, `Resume`, `Stop` | Opening actuals |
| `Critical`, `TotalSlack`, `FreeSlack` | Integers in **tenths of a minute** → days = v / 10 / MinutesPerDay |
| `EarlyStart/EarlyFinish/LateStart/LateFinish` | Kept for cross-checking our CPM |
| `ConstraintType` (0 ASAP, 1 ALAP, 2 MSO, 3 MFO, 4 SNET, 5 SNLT, 6 FNET, 7 FNLT, *verify on sample*), `ConstraintDate`, `Deadline` | Forecasting |
| `CalendarUID` (−1 = project calendar) | Task calendar (v1 warns if it differs) |
| `BCWS`, `BCWP`, `ACWP`, `CV` | MSP's own EV, for reconciliation only |
| `Notes` | Plain text |
| `PredecessorLink/` `PredecessorUID`, `Type` (**0 = FF, 1 = FS, 2 = SF, 3 = SS**), `LinkLag` (**tenths of a minute**, negative = lead), `LagFormat` (DurationFormat codes; elapsed formats use 1440 min/day), `CrossProject` (skip and warn) | Logic. Successors are the reverse of these links |
| `Baseline/` `Number` (0 = "Baseline", 1–10 = Baseline1…10), `Interim`, `Start`, `Finish`, `Duration`, `DurationFormat`, `Work`, `Cost`, `FixedCost`, `BCWS`, `BCWP` | Baselines. Several can coexist; `Interim`=1 entries hold only start/finish |
| `ExtendedAttribute/` `FieldID`, `Value` | Custom fields. Resolve `FieldID` through the header dictionary (Text1 = `188743731`). **FieldID is not unique across projects**, so match on FieldName/Alias |
| `TimephasedData` (`Type`, `Start`, `Finish`, `Unit`, `Value`) | Ignored in v1. We time-phase ourselves (see 3.2). The baseline-cost type is the one to read later for resource-curve PV |

`DurationFormat` codes: 3 m, 4 em, 5 h, 6 eh, 7 d, 8 ed, 9 w, 10 ew, 11 mo, 12 emo, 19 %, 20 e%, 21/53 null;
35–52 are the same units marked "estimated (?)". **Elapsed** = 4, 6, 8, 10, 12, 20 and their estimated
twins 36, 38, 40, 42, 44, 52.

**Resources** (`/Project/Resources/Resource`): `UID`, `Name`, `Type` (0 material, 1 work, 2 cost; *verify*),
`MaterialLabel`, `StandardRate`, `Cost`, `Baseline/Cost`. **Assignments** (`/Project/Assignments/Assignment`):
`UID`, `TaskUID`, `ResourceUID`, `Units` (MPXJ scales ×100), `Work`, `Cost`, `ActualCost`, `BudgetCost`,
`Baseline/Number,Cost,Work,Start,Finish`. Ethiopian building schedules are rarely resource-loaded. Treat both
as optional and use them only for (a) a cost-basis BAC when present and (b) display.

### 1.3 Conversions (implement in `shared/schedule-mspdi.ts`, unit-tested)

```ts
const kids = (el: Element, n: string) => Array.from(el.children).filter(c => c.localName === n);
const kid  = (el: Element, n: string) => kids(el, n)[0] ?? null;
const txt  = (el: Element, n: string) => kid(el, n)?.textContent?.trim() || null;
const num  = (el: Element, n: string) => { const t = txt(el, n); return t == null ? null : Number(t); };
const bool = (el: Element, n: string) => txt(el, n) === '1';

// ISO-8601 duration → minutes. MSP writes PTnHnMnS. Also accept PnDTnH… (D = 24 h, as MPXJ does).
export function isoDurMinutes(s: string | null): number | null {
  if (!s) return null;
  const m = /^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s);
  if (!m) return null;
  const [, neg, y, mo, d, h, mi, se] = m.map(v => (v === undefined ? 0 : v)) as any[];
  const min = (+y) * 525600 + (+mo) * 43200 + (+d) * 1440 + (+h) * 60 + (+mi) + (+se) / 60;
  return neg ? -min : min;
}
const ELAPSED = new Set([4, 6, 8, 10, 12, 20, 36, 38, 40, 42, 44, 52]);
// working days (or calendar days if elapsed)
export const toDays = (minutes: number, fmt: number | null, minPerDay: number) =>
  ELAPSED.has(fmt ?? 7) ? minutes / 1440 : minutes / minPerDay;
// LinkLag / TotalSlack / FreeSlack are integers in tenths of a minute
export const tenthsToDays = (v: number, fmt: number | null, minPerDay: number) => toDays(v / 10, fmt, minPerDay);
// Dates: keep as naive local strings. Never `new Date(s)`, which applies the browser time zone.
export const datePart = (s: string | null) => (s ? s.slice(0, 10) : null);   // 'YYYY-MM-DD'
export const timePart = (s: string | null) => (s ? s.slice(11, 16) : null);  // 'hh:mm'
```

Rules:
- `start_date = datePart(Start)`. For `finish_date = datePart(Finish)`: if the Finish time is at or before the
  calendar's first working minute (e.g. `08:00`) and the task is not a milestone, use the previous working day.
  Keep the raw datetimes in `raw` for audit.
- `duration_days = round(toDays(isoDurMinutes(Duration), DurationFormat, MinutesPerDay), 2)`. Set
  `is_elapsed = ELAPSED.has(DurationFormat)` (e.g. "7 ed" for curing).
- `lag_days = tenthsToDays(LinkLag, LagFormat, MinutesPerDay)`. **Percent lag** (LagFormat 19/20) is rare in
  building schedules and its encoding is not documented clearly. Convert it as a % of the predecessor's
  duration **with a warning**, and verify on a sample.
- `cost = Number(Cost) / 100`, behind a "currency scale" check shown in the preview (see risk R6).
- **Summary tasks:** stored for hierarchy and roll-up only. They are never progressed and carry no BAC of their
  own; their numbers are the sum of their leaves. Links that touch summary tasks are **expanded to the summary's
  leaf descendants** during import (MSP semantics) and flagged in the quality report.
- **Milestones:** `duration_days = 0`. They carry BAC = 0 unless the user marks them as *payment milestones*
  (method `milestone`, weight entered).
- `DOMParser` is main-thread only (not available in Web Workers). Files of 5–20 MB / 5,000 tasks parse in about
  1 s, which is acceptable; show a spinner. Check `doc.querySelector('parsererror')`. Check the namespace and
  `SaveVersion`.

### 1.4 Excel template (non-MSP schedules and the MSP Export-Wizard route)

Sheet `Tasks`, one row per task:

`UID*` · `WBS` · `Outline Level*` · `Name*` · `Summary (Y/N)` · `Milestone (Y/N)` · `Duration (d)` ·
`Start*` · `Finish*` · `Baseline Start` · `Baseline Finish` · `Baseline Cost` · `Predecessors` · `BoQ Items` ·
`Element Codes` · `EV Method` · `Notes`

- `Predecessors` uses MSP's **"Unique ID Predecessors"** field syntax, not the row-ID "Predecessors" field:
  `12FS+2d;15SS;18FF-1d;20SF+3ed`. Grammar:
  `uid (FS|SS|FF|SF)? ((+|-) n (d|w|ed|h|%))?`, items separated by `,` or `;`, default `FS+0`.
- `BoQ Items`: `02.03` or `02.03=45.5;02.04` (optional quantity share after `=`).
- MSP users export with the Export Wizard (Task mapping → the columns above, using "Unique ID" and "Unique ID
  Predecessors"). Save the map in MSP and ship it as `SMM-schedule.mpt`/map instructions.
- SheetJS: `XLSX.read(await file.arrayBuffer(), { cellDates: false })`, then
  `utils.sheet_to_json(ws, { defval: null, raw: true })`. Convert date serials with `XLSX.SSF.parse_date_code`,
  **not** `cellDates: true`, which creates local-zone `Date` objects that can shift a day. Text dates exported
  from MSP depend on locale ("Mon 2/5/24"), so accept only ISO or serials and reject anything else.

### 1.5 Parsed payload (browser → `import_schedule`)

```ts
type ParsedSchedule = {
  source: 'mspdi' | 'excel'; file_name: string; file_sha256: string;
  header: { name?: string; start_date: string; finish_date?: string; status_date?: string;
            minutes_per_day: number; minutes_per_week: number; days_per_month: number;
            currency_code?: string; baseline_for_ev: number; save_version?: string };
  calendars: { uid: number; name: string; is_base: boolean; base_uid?: number;
               week: { dow: 0|1|2|3|4|5|6; working: boolean; minutes: number }[];      // 0 = Sunday
               exceptions: { from: string; to: string; working: boolean; minutes?: number; name?: string }[] }[];
  project_calendar_uid: number;
  tasks: { uid: number; guid?: string; id: number; name: string; wbs?: string; outline_number?: string;
           outline_level: number; parent_uid?: number; is_summary: boolean; is_milestone: boolean;
           is_manual: boolean; start: string; finish: string; duration_days: number; is_elapsed: boolean;
           remaining_days?: number; constraint_type?: number; constraint_date?: string; deadline?: string;
           calendar_uid?: number; critical?: boolean; total_float_days?: number; free_float_days?: number;
           pct_complete?: number; physical_pct?: number; actual_start?: string; actual_finish?: string;
           cost?: number; fixed_cost?: number; fixed_cost_accrual?: 1|2|3; work_hours?: number;
           baselines: { number: number; start?: string; finish?: string; duration_days?: number;
                        cost?: number; work_hours?: number }[];
           custom: Record<string, string>;            // keyed by FieldName, e.g. { Text1: '02.03;02.04' }
           notes?: string; raw_start: string; raw_finish: string }[];
  links: { pred_uid: number; succ_uid: number; type: 'FS'|'SS'|'FF'|'SF'; lag_days: number; lag_elapsed: boolean }[];
  resources?: { uid: number; name: string; type: 'work'|'material'|'cost'; std_rate?: number; cost?: number }[];
  assignments?: { uid: number; task_uid: number; resource_uid: number; units?: number; work_hours?: number;
                  cost?: number; baseline_cost?: number }[];
  custom_fields: { field_id: number; field_name: string; alias?: string }[];
  warnings: string[];                                   // parser warnings shown in preview
};
```

The preview runs the quality checks in §6 on the client and shows a **diff** against the current version
(added / changed dates / removed / logic changes) before the user commits.

---

## 2. BoQ ↔ schedule mapping

### 2.1 What happens in practice
- **Many-to-many.** Tender BoQs are organised by trade/bill (substructure, concrete work, masonry, finishing…),
  while programmes are organised by location then trade (Block A → GF → columns). One BoQ item ("C-25 concrete
  in columns", m³) spans many tasks (each floor's column pour). One task ("GF slab") consumes several BoQ items
  (concrete, formwork, rebar). Planners usually **group BoQ pay items under activities**, not the other way
  round. Very small items are pooled into one activity.
- **Detailed vs tender BoQ.** The working BoQ differs from the tender BoQ. Mapping has to tolerate partial
  coverage, so we report an *unmapped BAC %* instead of blocking.
- **Cost-loading.** P6/MSP practice is to cost-load activities with BoQ amounts (as a "BOQ" cost resource or
  fixed cost) to get the S-curve and payment forecast. Monthly interim payments (IPCs) are measured on BoQ
  quantities × rates.
- **Ethiopian practice.** Public building contracts (MoWUD/MoUDC and PPA conditions, FIDIC-derived) pay
  **monthly** for permanent work measured against the BoQ, plus materials on site (typically 80% of invoice in
  public practice). They withhold retention (10%, amended to **5%**; half released at completion) and recover
  the advance (up to 20%). The engineer has 7 days to certify and the employer 14 days to pay (21 in total, by
  amendment); the minimum IPC is about 5% of the contract price. Monthly reports show **planned vs actual
  physical %** (BoQ-value weighted) and **financial %** (certified/contract). So the BoQ amount is the natural
  weight and the IPC month is the natural EVM period.

### 2.2 How we store it
- `task_boq_links(task_id, boq_item_id, planned_qty)`: the share of the BoQ item's quantity that this task
  delivers. Contract value of the link = `planned_qty × boq_rates.rate` (price-restricted, computed in views).
- `task_element_links(task_id, element_id, weight)`: ties a task to existing elements, so verified
  element-activity progress rolls up into the task.
- Mapping sources, in order of preference:
  1. **MSP custom field.** The planner puts BoQ item numbers in `Text1` (alias "BoQ Item"), e.g.
     `02.03;02.04=120`. Element codes go in `Text2` (alias "Elements"), e.g. `C1-C24@GF` or a block/level filter.
     In the import dialog the user picks which alias holds each.
  2. **Excel template columns** (`BoQ Items`, `Element Codes`).
  3. **Mapping UI after import** (web): multi-select tasks ↔ BoQ items; "split quantity across selected tasks"
     by (a) linked elements' take-offs (`Σ element_takeoffs.planned_qty where boq_item_id = …`), (b) duration,
     or (c) equally.
- **Validation view `v_boq_mapping_check`:** for each BoQ item, `Σ planned_qty over tasks` vs
  `boq_items.quantity` (under-mapped/over-mapped). For each task, whether it has a BoQ link, an element link, or
  neither (unmapped → EV only via %/steps).
- Mapping is preserved across re-imports because it is keyed by task id, which is matched by UID. A mapping
  value in a custom field of the **new** file replaces the old mapping only if the user ticks "file mapping
  wins".

### 2.3 The schedule IS the BoQ (client format)
Some clients price the MS Project file itself: leaf tasks are BoQ items (names like BoQ descriptions, sub-items
"a) In Flat Mat slab" under "Concrete C-25 in…"), with custom fields `Text1` "Unit", `Number1` "Qty",
`Number2` "Rate" (ex-VAT) and `Cost1` "Amount" = Qty × Rate × 1.15 (VAT included; Cost fields stored ×100 in
MSPDI like task Cost). Summary tasks carry meaningless rolled-up Qty / Rate and are ignored.
- **Parser** (`web/src/lib/msp`): custom `Cost1..Cost10` are divided by `currencyScale` like task Cost; duplicate
  ExtendedAttribute definitions are merged; `detectEmbeddedBoq(parsed)` finds the columns by alias (English
  variants + Amharic), measures the VAT factor (median Amount ÷ (Qty × Rate) over leaves) and a confidence;
  `normalizeUnit` (m³ → m3, Kg → kg, Nos → No …) and `embeddedBoqRows` preview the items.
- **RPC `create_boq_from_schedule`** (migration `20261030000005`), called by the wizard right after
  `import_schedule`: for each non-summary task with Qty > 0 → `boq_items` (item_no = WBS, description = parent +
  " – " + name for a)/b) items, unit normalised; idempotent by item_no), `boq_rates` (ex-VAT rate, price roles),
  `task_boq_links` (qty_share = Qty), `ev_method = 'units'`, and `schedule_task_costs.budget_ex_vat` /
  `budget_incl_vat`. Custom values arrive already scaled → `amount_scale` 1. **Value basis is ex-VAT** (VAT is a
  pass-through tax): `set_baseline` (source `current_plan`, cost_source `value`) gives BAC = Σ Qty × Rate.
- **Calendar:** imported calendars keep `use_public_holidays = true`, so a 6-day calendar without exceptions
  still gets the Ethiopian public holidays (`app.is_working_day`).

---

## 3. EVM done right for a building contractor

### 3.1 Two bases. Never mix them.

| Basis | BAC | Meaning | Who sees it |
|---|---|---|---|
| **Value (contract) basis** | Σ links `planned_qty × BoQ rate` (+ unmapped tasks from MSP baseline cost or manual) | Revenue earned / "value of work done". Matches IPCs and the client's "physical progress %" | Price roles |
| **Cost basis** (PMB proper) | `budget_lines` allocated to tasks, MSP baseline cost (resource/fixed cost), or value × (1 − margin %) as a fallback | Internal budgeted cost. **Only this basis gives a meaningful CPI against AC** | Price roles |

`AC` is always cost. Value-basis CPI (EV_value / AC) is a **margin ratio**, not a cost-performance index. The
UI labels it as such or hides it. **Planned % / earned %** (PV/BAC, EV/BAC) are dimensionless and are safe to
show to site roles.

Default: if `budget_lines` or MSP costs exist, use the cost basis for CPI/EAC and the value basis for physical
% and valuation. Otherwise run value basis only and show CPI as "n/a – no cost budget". The project setting
`evm_settings.cost_basis_source ∈ {'budget_lines','msp_baseline_cost','value_less_margin','none'}` controls this.

### 3.2 Planned Value (time-phasing)

**Status date** `s` = the last day covered by the update (inclusive, end of day). This matches MSP's Status
Date. A P6 "data date" would be `s + 1`.

Per **leaf** task `t` in the approved baseline `B`:
- `wd(a, b)` = working days in `[a, b]` on the project calendar. Precompute `calendar_days(idx)` so this is
  `idx(b) − idx(a − 1)`.
- **Linear spread over working days** (default; it equals MSP's prorated accrual and matches a fixed-cost or
  BoQ-loaded schedule):
  `f_t(s) = clamp( wd(BS_t, s) / wd(BS_t, BF_t), 0, 1 )`, with elapsed tasks using calendar days.
- Accrual overrides (MSP `FixedCostAccrual`): `start` → `f = s ≥ BS ? 1 : 0`; `end` → `f = s ≥ BF ? 1 : 0`.
  Milestones always use `end`.
- `PV_t(s) = BAC_t × f_t(s)`. `PV(s) = Σ_leaf PV_t(s)`. Summary and WBS rows are sums, never their own BAC.
- **Resource-curve PV** (front/back-loaded contours, from MSP timephased baseline cost) is a v2 option. The
  linear spread is what MSP itself uses for prorated fixed costs. Daily linear spread summed into weekly/monthly
  buckets is accurate enough for building work.
- Granularity: computed **per day** on demand, bucketed per **week** (Mon–Sat site week) and per **period**
  (the IPC month, which may end on a Gregorian or an Ethiopian month end; periods carry explicit dates).

### 3.3 Earned Value: methods per task type

`EV_t(s) = BAC_t × pct_t(s) / 100`, where `pct_t(s)` uses **verified** progress dated ≤ s. Reported but
unverified progress is shown separately as "pending".

| `ev_method` | Formula for `pct_t(s)` | Use for (default rule at import) |
|---|---|---|
| `units` (quantity / units complete) | `Σ_i min(q_i(s), Q_i)·r_i / Σ_i Q_i·r_i`. q = verified cumulative qty on link i, Q = planned_qty, r = BoQ rate (or 1 if no rates, i.e. equal weights) | Task has BoQ links with measurable units (m³, m², kg, ml, pcs). **Default** when BoQ-linked |
| `elements` (derived) | `Σ_e w_e·p_e(s) / Σ_e w_e`. p_e = element % from verified `element_activities` (already weighted by `activity_templates.weight`, i.e. **rules of credit** such as formwork/rebar/pour/strip) as of s. w_e = element's linked take-off value, else 1 | Task linked to elements (structural frames, masonry by element). **Default** when element-linked. Site engineers keep reporting on elements; no double reporting |
| `steps` (weighted milestones / rules of credit) | `Σ step_weight × step_done% / Σ step_weight` | Long tasks with distinct stages and no element model (e.g. "Install lift": delivered 15 / set 20 / aligned 15 / internals 25 / tested 15 / accepted 10) |
| `0_100` | 100 if verified actual_finish ≤ s, else 0 | Tasks ≤ 1 reporting period (≤ 6 working days), inspections, tests |
| `50_50` (start/finish, configurable `start_pct`) | 0 → `start_pct` at actual start → 100 at finish. 50 for short, low-value tasks; 20–30 for long or high-value tasks | Tasks spanning 2 periods with no measurable units |
| `pct` (physical % estimate, "supervisor opinion") | Latest verified physical % | Minor or subjective items only: landscaping, temporary works, dewatering |
| `milestone` (payment milestone) | 100 when achieved | Contract milestones that carry money |
| `loe` (level of effort) | `= f_t(s)·100` (EV = PV) | Preliminaries / site overheads (Bill 1 general items, supervision). Excluded from SPI alerts |

The method is set per task (`schedule_tasks.ev_method`). It can be bulk-assigned by rule at import and changed
only by office engineer+. A change after the first closed period needs a comment and is audited, because it
rewrites how EV is measured.

### 3.4 Actual Cost

`AC_t(s)` = Σ cost recognised for work done up to s (accrual by **work date**, not payment date):

| Source | How | Already exists? |
|---|---|---|
| **Materials issued** | `stock_ledger` rows `doc_type in ('miv','mrn')` (MRN returns are negative) × unit cost, valued exactly as `v_cost_control` does (project average received cost from GRN × PO price, `spec_prices` fallback) | ✅ data; new allocation view |
| Direct-purchase materials / consumables not through store | `cost_entries.category = 'material_direct'` | new |
| **Labour** | `cost_entries 'labour'` (payroll per period, by task/WBS or project). Optional estimate: `diary_labour.headcount × hours × labour_rates.rate`, flagged `estimated` and replaced by the payroll entry when posted | partially (diary) |
| **Equipment** | `cost_entries 'equipment'` (rental invoices, fuel). Optional estimate from `diary_equipment.hours_worked × equipment_rates.rate` | partially |
| **Subcontract** | `cost_entries 'subcontract'`, with qty measured on subcontractor certificates (qty × agreed rate) linked to BoQ/task | new |
| Site overheads | `cost_entries 'overhead'` → LOE tasks or unallocated | new |

**Allocation of a material issue to tasks.** The ledger row has `element_id` E and spec S. The BoQ item B comes
from `mr_lines.boq_item_id` or `element_takeoffs(E,S).boq_item_id`. Candidate tasks are chosen in this order:
(1) tasks linked to **both** E and B; (2) tasks linked to E; (3) tasks linked to B. Split pro rata by link
`planned_qty` (or BAC). If none match, the cost goes to **unallocated** at project level. Project AC/CPI stays
correct; only the task-level drill-down loses detail. The dashboard shows an "AC allocation coverage %" KPI.

Price visibility: `office_engineer` is **not** a price role by default (`app_settings.price_roles` = coordinator,
manager, procurement, admin). So the office engineer enters **quantities/hours** (labour hours, equipment
hours, subcontract measured quantities). Money (payroll totals, invoices, rates) is entered by a price role.
Alternatively, the client adds office_engineer to `price_roles`; it is a setting.

### 3.5 Indicators (all at status date s; project, WBS node or task)

```
SV  = EV − PV                    CV  = EV − AC
SPI = EV / PV                    CPI = EV / AC            (cost basis only)
BAC = Σ leaf BAC (approved baseline)
ETC = EAC − AC                   VAC = BAC − EAC
TCPI_BAC = (BAC − EV) / (BAC − AC)          TCPI_EAC = (BAC − EV) / (EAC − AC)
pct_planned = PV / BAC           pct_earned = EV / BAC    (dimensionless: OK for non-price roles)
```

**EAC.** Show all of these; one is the default (`evm_settings.eac_method`):

| Key | Formula | When |
|---|---|---|
| `cpi` (**default**) | `AC + (BAC − EV) / CPI` (= BAC / CPI) | Typical; when EV/BAC < 10% the system falls back to `budget_rate` (CPI is too unstable early) and says so |
| `budget_rate` | `AC + (BAC − EV)` | Overrun judged a one-off |
| `cpi_spi` (composite) | `AC + (BAC − EV) / (CPI × SPI)` | Behind schedule *and* over cost (pessimistic; schedule pressure on remaining work) |
| `bottom_up` | `AC + Σ ETC entered per task/WBS by office engineer/manager` (+ materials ETC = remaining take-off × latest price from `price_observations`) | Monthly management estimate; strongest when it exists |

**Schedule forecasting: Earned Schedule (Lipke).** SPI → 1.0 at the end even for late projects. ES does not.
Using the daily cumulative baseline PV curve `PV(d)` from baseline start `BS0` (working-day index):
```
C    = max working-day index n such that PV(n) ≤ EV
ES   = C + (EV − PV(C)) / (PV(C+1) − PV(C))      (ES = PD if EV ≥ BAC)
AT   = wd(BS0, s)                                 PD = wd(BS0, BF0)
SV(t)  = ES − AT        (working days; < 0 = behind)
SPI(t) = ES / AT
IEAC(t) = PD / SPI(t)  → forecast finish = date at index idx(BS0) − 1 + IEAC(t)
```
ES and SPI(t) are aggregate indicators. **CPM (§4.4) remains the authority for milestone and finish dates.**
The dashboard shows both: "CPM forecast finish" and "ES forecast finish".

### 3.6 Periods, cut-off, thresholds
- **Weekly** (site): status date = Saturday (6-day week). Progress verified, CPM forecast refreshed, 3-week
  look-ahead issued. No money snapshot required.
- **Monthly** (management/IPC): status date = the IPC measurement cut-off (configurable: 20th/25th/month end,
  or Ethiopian month end). `close_period` snapshots EVM and BoQ quantities **immutably**.
- **Cut-off rules:** progress and cost entries dated ≤ a closed status date are rejected
  ("Period closed – date it in the current period or ask the manager to reopen"). Late cost entries (invoices
  arriving after close) are dated in the open period with `relates_to_period` for analysis. Reopening needs a
  manager, a reason and an audit record.
- **Thresholds** (`evm_settings.thresholds`, defaults):
  - SPI or CPI ≥ 0.95: green. 0.90–0.95: **warning**. < 0.90: **critical**.
  - SPI(t) uses the same bands.
  - TCPI_BAC > 1.10: warning (recovery implausible).
  - SPI/CPI > 1.15: info ("check for front-loaded EV claims or missing AC").
  - Negative total float on any incomplete task: critical. Critical task late start > 5 wd: warning.
  - Reported progress unverified > 2 days: warning.

  Breaches at close require a **variance explanation** (cause, impact, corrective action) on the WBS node before
  the manager can approve the close (EIA-748 variance-analysis practice).
- **S-curves:** cumulative PV (whole baseline span, including future), EV and AC (closed snapshots + live
  point), on both bases. Also the original contract baseline PV as a dashed line once re-baselined, plus a
  forecast EV line (from CPM forecast dates using the same linear spread).

---

## 4. Progress update workflow per role

### 4.1 Who does what

| Role | Schedule / EVM duties | Sees money? |
|---|---|---|
| `site_engineer` (mobile, offline) | Daily/weekly: report **quantities** on BoQ-linked tasks, steps, 0/100 and 50/50 starts/finishes, actual start/finish, remaining duration, photos, delay cause. Keeps reporting **element activities** as today (feeds `elements`-method tasks) | No (sees planned % vs earned %, dates, float) |
| `office_engineer` (web + mobile) | Imports/re-imports MSP. Maintains BoQ mapping, EV methods, steps. **Verifies** task progress (same as `verify_progress`). Enters labour/equipment hours and subcontract qty. Runs forecast. Prepares period close (draft snapshot, variance notes). Exports progress back to MSP for the planner. Proposes re-baseline | No by default |
| `coordinator` | Verifies (backup). Reviews variance notes. Enters cost entries | Yes |
| `manager` | **Approves baselines and re-baselines**, approves period close, reopens periods, sees EVM dashboard and EAC | Yes |
| `procurement` | Cost entries for direct purchases and subcontract invoices; POs feed committed cost (existing) | Yes |
| `store_keeper` | Nothing new. MIVs automatically become material AC | No |
| `security` | Nothing | No |
| `admin` | Everything | Yes |

### 4.2 Cycle

```
 MSP planner ──Save As XML──► Web: Import preview (quality report + diff) ──► import_schedule (version n)
                                                         │ first time: set_baseline (proposed) → manager approve_baseline
 Site engineer (daily, offline) ── report_task_progress / report_progress (elements) ──► outbox ──► server
 Office engineer (≤ 48 h) ── verify_task_progress / verify_progress
 Weekly (Sat):   office engineer ── run_forecast(status_date) ──► CPM dates, float, critical path; 3-week look-ahead
 Monthly cut-off: cost entries complete → prepare_period_close (draft snapshot + variance notes)
                  → manager close_period (immutable snapshot, BoQ qty snapshot for IPC)
                  → export "MSP progress update" (.xlsx: Unique ID, Actual Start, Actual Finish, % Complete,
                    Physical % Complete, Remaining Duration) → planner merges in MSP (Import Wizard,
                    merge key = Unique ID), revises logic → Save As XML → re-import (progress preserved)
 Re-baseline (approved change orders / recovery programme): set_baseline(reason) → manager approve_baseline
```

### 4.3 Re-import that preserves progress
1. Match each incoming task by `(schedule_id, msp_uid)`. If not found, match by `msp_guid`. If still not found,
   the client proposes matches for *orphan old tasks that have progress* by WBS + name similarity, and the user
   confirms them as `uid_remap: [{old_uid, new_uid}]`.
2. Matched tasks: update name/WBS/outline/plan dates/duration/constraints/flags/current MSP cost. **Never touch**
   progress, verified fields, mapping (unless "file mapping wins"), EV method, or baselines.
3. New tasks are inserted. Default EV method by rule; they carry no baseline until the next approved baseline,
   so their BAC sits under "unbaselined scope" (shown, excluded from PV/EV until baselined).
4. Missing tasks: without progress → `deleted_at`. With progress or AC → kept, `source_state = 'removed_in_source'`,
   flagged. The user must re-map them or explicitly confirm removal with `confirm_remove_uids`.
5. Links: replaced wholesale for the version (logic belongs to the file).
6. File actuals (`ActualStart`, `PercentComplete`…) are **ignored** after the first import; the app is the
   system of record for progress. Differences appear in the diff ("MSP says 60%, verified 45%"). On the first
   import mid-project, `options.opening_progress = true` creates `task_progress` rows
   (`source = 'import'`, status `verified`, dated file `StatusDate`).
7. Each import is a `schedule_versions` row with `file_sha256` (re-importing the same file is a no-op) and a
   stored `diff`.

### 4.4 Forecast dates, critical path & float: in Postgres
- **Where:** `app.run_cpm(schedule_id, status_date)` in plpgsql. One authoritative implementation used by
  `run_forecast` and `close_period`, runnable on PGlite in `local-server`. The browser only does cycle
  detection in the preview.
- **Time axis:** working-day indices from `calendar_days` (project calendar). Elapsed tasks and elapsed lags
  convert via calendar days ↔ index. v1 ignores task calendars (warns).
- **Durations of incomplete work:**
  - Completed: fixed actual dates.
  - In progress: remaining = reported `remaining_days`, else `ceil(duration × (1 − pct/100))`, min 1; it starts
    at the next working day after s.
  - Not started: original duration, `ES ≥ s + 1`.
- **Forward pass** (Kahn topological order). For each link pred → succ with lag L:
  FS: `ES_s ≥ EF_p + 1 + L`; SS: `ES_s ≥ ES_p + L`; FF: `EF_s ≥ EF_p + L`; SF: `EF_s ≥ ES_p + L − 1`
  (index arithmetic, finish inclusive). Constraints: SNET/MSO → `ES ≥ date`; FNET/MFO → `EF ≥ date`
  (MSO/MFO flagged as hard); ALAP is ignored and flagged.
- **Out-of-sequence progress:** setting `evm_settings.progressed_logic = 'retained' | 'override'`. Default
  `retained` (remaining work still waits for unfinished predecessors; conservative, owner-preferred). Override
  lets started work continue.
- **Backward pass** from `LF_project = max(EF)`, or from the contract completion date if the setting
  `float_to = 'contract_finish'` (then float can go negative).
  `TF = LS − ES`, `FF = min(ES_succ) − EF − 1` (FS links).
  Critical = `TF ≤ evm_settings.critical_float_days` (default 0). The longest path is traced back from the
  finish via driving links.
- **Writes** to `schedule_tasks.fc_start, fc_finish, total_float_days, free_float_days, is_critical_calc`, and
  `schedules.fc_finish`. MSP's `Critical`/`TotalSlack` are kept for comparison; a large disagreement points to
  calendar or constraint differences.
- Cycles → error listing the UIDs. Performance: about 5k tasks / 10k links in < 1 s in plpgsql (arrays + loops).
- **Use downstream:** forecast start dates for the next 3 weeks × linked element take-offs → **look-ahead
  material requests** (FR-MR-07, `is_lookahead`).

---

## 5. Data model (migration `20261030000008_schedule_evm.sql`)

All tables get `updated_at` + the `touch_updated_at` trigger + the updated_at index (sync), plus RLS:
`member_read` (non-price) or `price_read` (price), and audit on headers. Mobile syncs **only** the non-price
tables marked 📱.

```sql
-- Settings (one row per project; non-price)
create table public.evm_settings (
  project_id            uuid primary key references public.projects (id) on delete cascade,
  value_basis_enabled   boolean not null default true,
  cost_basis_source     text not null default 'budget_lines'
                          check (cost_basis_source in ('budget_lines','msp_baseline_cost','value_less_margin','none')),
  margin_pct            numeric(5,2) not null default 0,          -- for value_less_margin
  eac_method            text not null default 'cpi' check (eac_method in ('cpi','budget_rate','cpi_spi','bottom_up')),
  progressed_logic      text not null default 'retained' check (progressed_logic in ('retained','override')),
  float_to              text not null default 'project_finish' check (float_to in ('project_finish','contract_finish')),
  contract_finish       date,
  critical_float_days   numeric(6,2) not null default 0,
  short_task_days       int not null default 6,                    -- ≤ → default 0_100
  default_start_pct     numeric(5,2) not null default 50,           -- 50_50 method
  thresholds            jsonb not null default
    '{"idx_warn":0.95,"idx_crit":0.90,"tcpi_warn":1.10,"idx_high":1.15,"late_start_wd":5,"unverified_days":2}',
  updated_at            timestamptz not null default now()
);

-- Logical schedule (normally one 'master' per project)
create table public.schedules (                                         -- 📱
  id uuid primary key, project_id uuid not null references public.projects (id),
  code text not null default 'MASTER', name text not null,
  calendar_id uuid,                                  -- → project_calendars
  minutes_per_day int not null default 480, minutes_per_week int not null default 2400, days_per_month int not null default 20,
  currency_code text not null default 'ETB',
  current_version_id uuid, approved_baseline_id uuid,
  status_date date,                                  -- last run_forecast / close status date
  fc_finish date, es_finish date,                    -- CPM and earned-schedule forecasts
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (project_id, code)
);

create table public.schedule_versions (                                 -- 📱 (header only)
  id uuid primary key, project_id uuid not null, schedule_id uuid not null references public.schedules (id),
  version_no int not null, source text not null check (source in ('mspdi','excel','manual')),
  file_name text, file_sha256 text, file_attachment_id uuid,       -- original file kept in Storage
  header jsonb not null,                                           -- ParsedSchedule.header + custom_fields
  diff jsonb, warnings jsonb, quality jsonb,                       -- import diff + §6 report
  imported_by uuid not null references public.profiles (id), imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (schedule_id, version_no), unique (schedule_id, file_sha256)
);

create table public.project_calendars (                                 -- 📱
  id uuid primary key, project_id uuid not null, schedule_id uuid references public.schedules (id),
  msp_uid int, name text not null, base_calendar_id uuid references public.project_calendars (id),
  week jsonb not null,            -- [{dow:0..6, working:bool, minutes:int}]
  updated_at timestamptz not null default now()
);
create table public.calendar_exceptions (                               -- 📱
  id uuid primary key, project_id uuid not null, calendar_id uuid not null references public.project_calendars (id) on delete cascade,
  from_date date not null, to_date date not null, working boolean not null default false, minutes int, name text,
  updated_at timestamptz not null default now()
);
-- Materialised working-day index (rebuilt by import/set_calendar for project span ± 2 years)
create table app.calendar_days (
  calendar_id uuid not null, d date not null, is_work boolean not null, minutes int not null,
  idx int not null,                 -- cumulative count of working days up to and including d
  primary key (calendar_id, d)
);
create index calendar_days_idx on app.calendar_days (calendar_id, idx) where is_work;

create table public.schedule_tasks (                                    -- 📱 (no money columns)
  id uuid primary key, project_id uuid not null, schedule_id uuid not null references public.schedules (id),
  msp_uid int not null, msp_guid uuid, msp_id int, wbs text, outline_number text, outline_level int not null,
  parent_id uuid references public.schedule_tasks (id), sort_key int not null,   -- msp_id order
  name text not null, notes text,
  is_summary boolean not null default false, is_milestone boolean not null default false,
  is_manual boolean not null default false, is_elapsed boolean not null default false,
  block_id uuid references public.blocks (id), level_id uuid references public.levels (id),  -- optional location tag for mobile filtering
  -- current plan (from file)
  start_date date, finish_date date, duration_days numeric(8,2),
  constraint_type smallint, constraint_date date, deadline date,
  msp_critical boolean, msp_total_float_days numeric(8,2), custom jsonb not null default '{}',
  -- progress method & current state (maintained by RPCs)
  ev_method text not null default 'pct'
    check (ev_method in ('units','elements','steps','0_100','50_50','pct','milestone','loe')),
  start_pct numeric(5,2),                                   -- 50_50 override
  reported_pct numeric(5,2) not null default 0, verified_pct numeric(5,2) not null default 0,
  actual_start date, actual_finish date, remaining_days numeric(8,2), progress_as_of date,
  -- forecast (run_cpm)
  fc_start date, fc_finish date, total_float_days numeric(8,2), free_float_days numeric(8,2),
  is_critical_calc boolean, fc_status_date date,
  source_state text not null default 'active' check (source_state in ('active','removed_in_source')),
  last_version_id uuid references public.schedule_versions (id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
  unique (schedule_id, msp_uid)
);
create index schedule_tasks_parent_idx on public.schedule_tasks (parent_id);

create table public.schedule_task_costs (                               -- price-restricted (current file costs)
  task_id uuid primary key references public.schedule_tasks (id) on delete cascade, project_id uuid not null,
  msp_cost numeric(18,2), msp_fixed_cost numeric(18,2), fixed_cost_accrual smallint, msp_actual_cost numeric(18,2),
  updated_at timestamptz not null default now()
);

create table public.schedule_links (                                    -- 📱
  id uuid primary key default gen_random_uuid(), project_id uuid not null, schedule_id uuid not null,
  pred_task_id uuid not null references public.schedule_tasks (id), succ_task_id uuid not null references public.schedule_tasks (id),
  link_type text not null check (link_type in ('FS','SS','FF','SF')),
  lag_days numeric(8,2) not null default 0, lag_elapsed boolean not null default false,
  expanded_from_summary boolean not null default false, version_id uuid not null references public.schedule_versions (id),
  updated_at timestamptz not null default now(),
  unique (pred_task_id, succ_task_id, link_type), check (pred_task_id <> succ_task_id)
);

-- Baselines (our PMB). MSP baseline 0..10 are imported as *sources*, not auto-approved.
create table public.schedule_baselines (                                -- 📱 (header)
  id uuid primary key, project_id uuid not null, schedule_id uuid not null references public.schedules (id),
  baseline_no int not null,                 -- 1 = contract baseline, 2.. re-baselines
  name text not null, source text not null check (source in ('msp_baseline','current_plan')),
  msp_baseline_number int, from_version_id uuid references public.schedule_versions (id),
  effective_from date not null,             -- PV before this date comes from earlier snapshots
  reason text, status text not null default 'proposed' check (status in ('proposed','approved','superseded','rejected')),
  proposed_by uuid not null references public.profiles (id), approved_by uuid references public.profiles (id),
  approved_at timestamptz, updated_at timestamptz not null default now(),
  unique (schedule_id, baseline_no)
);
create table public.schedule_baseline_tasks (                           -- 📱 (dates only)
  baseline_id uuid not null references public.schedule_baselines (id) on delete cascade,
  task_id uuid not null references public.schedule_tasks (id), project_id uuid not null,
  bl_start date not null, bl_finish date not null, bl_duration_days numeric(8,2) not null,
  accrual text not null default 'prorated' check (accrual in ('prorated','start','end')),
  updated_at timestamptz not null default now(), primary key (baseline_id, task_id)
);
create table public.schedule_baseline_task_costs (                      -- price-restricted
  baseline_id uuid not null, task_id uuid not null, project_id uuid not null,
  bac_value numeric(18,2) not null default 0,   -- contract/BoQ basis
  bac_cost  numeric(18,2),                      -- cost basis (null if none)
  updated_at timestamptz not null default now(), primary key (baseline_id, task_id),
  foreign key (baseline_id, task_id) references public.schedule_baseline_tasks (baseline_id, task_id) on delete cascade
);

-- Mapping
create table public.task_boq_links (                                    -- 📱 (qty only)
  id uuid primary key, project_id uuid not null, task_id uuid not null references public.schedule_tasks (id),
  boq_item_id uuid not null references public.boq_items (id), planned_qty numeric(16,3) not null check (planned_qty >= 0),
  verified_qty numeric(16,3) not null default 0, reported_qty numeric(16,3) not null default 0,   -- cumulative, maintained by RPC
  source text not null default 'ui' check (source in ('file','excel','ui','suggested')),
  updated_at timestamptz not null default now(), deleted_at timestamptz, unique (task_id, boq_item_id)
);
create table public.task_element_links (                                -- 📱
  id uuid primary key, project_id uuid not null, task_id uuid not null references public.schedule_tasks (id),
  element_id uuid not null references public.elements (id), weight numeric(12,4),   -- null = auto (take-off value or 1)
  activity_seq_from int, activity_seq_to int,     -- optional: only some activities of the element belong to this task
  updated_at timestamptz not null default now(), deleted_at timestamptz, unique (task_id, element_id)
);
create table public.task_steps (                                        -- 📱
  id uuid primary key, project_id uuid not null, task_id uuid not null references public.schedule_tasks (id),
  seq int not null, name text not null, weight numeric(6,2) not null check (weight > 0),
  verified_pct numeric(5,2) not null default 0,
  updated_at timestamptz not null default now(), unique (task_id, seq)
);

-- Progress reports (append-only like progress_updates; verify sets status)
create table public.task_progress (                                     -- 📱
  id uuid primary key, project_id uuid not null, task_id uuid not null references public.schedule_tasks (id),
  report_date date not null,                     -- progress as of end of this day
  method text not null,                           -- task.ev_method at report time
  pct numeric(5,2) check (pct between 0 and 100), -- pct / 0_100 / 50_50 / milestone
  qty jsonb,                                      -- units: [{boq_item_id, qty_to_date}]   (cumulative)
  steps jsonb,                                    -- steps: [{step_id, done_pct}]
  actual_start date, actual_finish date, remaining_days numeric(8,2),
  delay_cause text, remarks text,
  source text not null default 'field' check (source in ('field','office','import')),
  status text not null default 'reported' check (status in ('reported','verified','adjusted','rejected')),
  verified_pct numeric(5,2), verified_qty jsonb, verified_steps jsonb, verified_actual_start date, verified_actual_finish date,
  reported_by uuid not null references public.profiles (id), verified_by uuid references public.profiles (id),
  verified_at timestamptz, verify_comment text, device_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index task_progress_task_idx on public.task_progress (task_id, report_date);

-- Actual costs (append-only; reversals as negative rows)
create table public.cost_entries (                                      -- price-restricted
  id uuid primary key, project_id uuid not null, number text not null unique,     -- <PRJ>-CE-<DEV>-<SEQ>
  entry_date date not null,                      -- work/accrual date
  relates_to_period_id uuid,                     -- late entries
  category text not null check (category in ('labour','equipment','subcontract','material_direct','overhead','other')),
  task_id uuid references public.schedule_tasks (id), boq_item_id uuid references public.boq_items (id),
  element_id uuid references public.elements (id), wbs_task_id uuid references public.schedule_tasks (id),  -- summary-level allocation
  description text not null, supplier_id uuid references public.suppliers (id), subcontractor text,
  qty numeric(16,3), uom text, rate numeric(18,4), amount numeric(18,2) not null,      -- ex-VAT
  source text not null default 'manual' check (source in ('manual','diary_estimate','import','payroll','invoice')),
  source_ref text, is_estimate boolean not null default false,
  reversal_of uuid references public.cost_entries (id), created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- Non-price quantity actuals the office engineer may enter (hours, measured qty)
create table public.resource_usage (                                    -- member_read
  id uuid primary key, project_id uuid not null, usage_date date not null,
  kind text not null check (kind in ('labour','equipment','subcontract')),
  task_id uuid references public.schedule_tasks (id), trade_id uuid references public.labour_trades (id),
  equipment text, subcontractor text, boq_item_id uuid references public.boq_items (id),
  qty numeric(16,3) not null, uom text not null,           -- man-hours, machine-hours, m³…
  diary_id uuid references public.site_diaries (id), created_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now()
);
create table public.cost_rates (                                        -- price-restricted
  id uuid primary key, project_id uuid, kind text not null check (kind in ('labour','equipment','subcontract')),
  trade_id uuid references public.labour_trades (id), equipment text, subcontractor text, boq_item_id uuid,
  uom text not null, rate numeric(18,4) not null, valid_from date not null, updated_at timestamptz not null default now()
);

-- Periods and immutable snapshots
create table public.evm_periods (                                       -- 📱
  id uuid primary key, project_id uuid not null, schedule_id uuid not null references public.schedules (id),
  period_no int not null, kind text not null default 'monthly' check (kind in ('weekly','monthly')),
  period_start date not null, status_date date not null,
  status text not null default 'open' check (status in ('open','prepared','closed')),
  baseline_id uuid references public.schedule_baselines (id),
  prepared_by uuid, prepared_at timestamptz, closed_by uuid, closed_at timestamptz,
  reopened_reason text, updated_at timestamptz not null default now(),
  unique (schedule_id, kind, period_no), check (status_date >= period_start)
);
-- Non-price snapshot per task/WBS/project: safe for all members
create table public.evm_task_status (                                   -- 📱
  period_id uuid not null references public.evm_periods (id), task_id uuid, project_id uuid not null,  -- task_id null = project
  level text not null check (level in ('task','wbs','project')),
  pct_planned numeric(7,3), pct_earned numeric(7,3), spi numeric(8,4), spi_t numeric(8,4), sv_t_days numeric(8,2),
  fc_start date, fc_finish date, total_float_days numeric(8,2), is_critical boolean,
  actual_start date, actual_finish date, updated_at timestamptz not null default now(),
  unique nulls not distinct (period_id, task_id)
);
-- Money snapshot: price-restricted
create table public.evm_snapshots (
  period_id uuid not null references public.evm_periods (id), task_id uuid, project_id uuid not null,
  level text not null check (level in ('task','wbs','project')),
  basis text not null check (basis in ('value','cost')),
  bac numeric(18,2), pv numeric(18,2), ev numeric(18,2), ac numeric(18,2),
  cpi numeric(8,4), eac_cpi numeric(18,2), eac_budget numeric(18,2), eac_composite numeric(18,2), eac_bottom_up numeric(18,2),
  etc numeric(18,2), vac numeric(18,2), tcpi_bac numeric(8,4), tcpi_eac numeric(8,4), ac_unallocated numeric(18,2),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (period_id, task_id, basis)
);
-- BoQ quantities at cut-off: the basis for the monthly valuation / IPC (non-price)
create table public.period_boq_progress (                               -- 📱
  period_id uuid not null references public.evm_periods (id), boq_item_id uuid not null references public.boq_items (id),
  project_id uuid not null, qty_to_date numeric(16,3) not null, qty_previous numeric(16,3) not null,
  updated_at timestamptz not null default now(), primary key (period_id, boq_item_id)
);
create table public.evm_variance_notes (                                -- member_read
  id uuid primary key, project_id uuid not null, period_id uuid not null references public.evm_periods (id),
  task_id uuid references public.schedule_tasks (id),   -- WBS node or null = project
  indicator text not null, cause text not null, impact text, corrective_action text, owner_id uuid, due_date date,
  created_by uuid not null default auth.uid(), updated_at timestamptz not null default now()
);
-- Optional (resource-loaded schedules)
create table public.schedule_resources   (id uuid primary key, project_id uuid not null, schedule_id uuid not null, msp_uid int not null,
  name text not null, rtype text, updated_at timestamptz not null default now(), unique (schedule_id, msp_uid));
create table public.schedule_assignments (id uuid primary key, project_id uuid not null, task_id uuid not null references public.schedule_tasks (id),
  resource_id uuid not null references public.schedule_resources (id), msp_uid int not null, units numeric(10,2), work_hours numeric(12,2),
  updated_at timestamptz not null default now(), unique (task_id, resource_id));
create table public.schedule_assignment_costs (assignment_id uuid primary key references public.schedule_assignments (id) on delete cascade,
  project_id uuid not null, cost numeric(18,2), baseline_cost numeric(18,2), updated_at timestamptz not null default now());
```

Notes:
- Immutability: `task_progress` (except the verify transition, enforced in the RPC), `cost_entries`,
  `evm_snapshots`, `evm_task_status`, `period_boq_progress` → `app.block_mutation` after close (trigger checks
  `evm_periods.status = 'closed'`).
- Money never sits in a 📱 table: baseline totals (value/cost BAC) are sums over `schedule_baseline_task_costs`.
- `alert_rules.rule` check constraint: add `'evm_spi','evm_cpi','evm_tcpi','negative_float','critical_late_start','task_progress_unverified'`.

### 5.1 Key SQL (helpers & views)

```sql
-- working days in [a,b] on a calendar (0 if b < a)
create function app.wd(p_cal uuid, a date, b date) returns int language sql stable as $$
  select greatest(0, coalesce((select idx from app.calendar_days where calendar_id = p_cal and d = b), 0)
                   - coalesce((select idx from app.calendar_days where calendar_id = p_cal and d = a - 1), 0)) $$;

-- PV fraction of a baseline task at status date s
create function app.pv_fraction(p_cal uuid, bt public.schedule_baseline_tasks, s date, p_elapsed boolean) returns numeric
language sql stable as $$
  select case
    when bt.accrual = 'start' then (s >= bt.bl_start)::int
    when bt.accrual = 'end' or bt.bl_duration_days = 0 then (s >= bt.bl_finish)::int
    when p_elapsed then least(1, greatest(0, (s - bt.bl_start + 1)::numeric / nullif(bt.bl_finish - bt.bl_start + 1, 0)))
    else least(1, greatest(0, app.wd(p_cal, bt.bl_start, s)::numeric / nullif(app.wd(p_cal, bt.bl_start, bt.bl_finish), 0)))
  end $$;

-- Earned % of a leaf task as of s (verified data only). security definer so 'units' can weight by BoQ rate
-- without exposing rates (returns a percentage only).
create function app.task_earned_pct(p_task uuid, s date) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare t public.schedule_tasks; v numeric;
begin
  select * into t from schedule_tasks where id = p_task;
  case t.ev_method
  when 'units' then
    -- latest verified cumulative qty per link as of s
    with q as (
      select distinct on (x.boq_item_id) x.boq_item_id, x.qty_to_date
      from task_progress tp, jsonb_to_recordset(tp.verified_qty) as x(boq_item_id uuid, qty_to_date numeric)
      where tp.task_id = p_task and tp.status in ('verified','adjusted') and tp.report_date <= s
      order by x.boq_item_id, tp.report_date desc, tp.verified_at desc)
    select 100 * sum(least(coalesce(q.qty_to_date,0), l.planned_qty) * coalesce(r.rate,1))
               / nullif(sum(l.planned_qty * coalesce(r.rate,1)), 0)
      into v from task_boq_links l left join q using (boq_item_id) left join boq_rates r on r.boq_item_id = l.boq_item_id
      where l.task_id = p_task and l.deleted_at is null;
  when 'elements' then
    select sum(w * pe) / nullif(sum(w), 0) into v from (
      select coalesce(el.weight, 1) as w,
             (select coalesce(sum(a.weight * coalesce(lu.vpct, 0)) / nullif(sum(a.weight), 0), 0)
                from element_activities a
                left join lateral (select pu.verified_pct as vpct from progress_updates pu
                   where pu.element_activity_id = a.id and pu.status in ('verified','adjusted') and pu.report_date <= s
                   order by pu.report_date desc, pu.verified_at desc limit 1) lu on true
               where a.element_id = el.element_id
                 and a.seq between coalesce(el.activity_seq_from, a.seq) and coalesce(el.activity_seq_to, a.seq)) as pe
      from task_element_links el where el.task_id = p_task and el.deleted_at is null) z;
  when 'loe' then
    v := null;   -- handled by caller: EV = PV
  else
    -- pct / 0_100 / 50_50 / milestone / steps: latest verified report ≤ s carries verified_pct
    -- (the verify RPC computes verified_pct for steps and enforces the 0/100 and 50/50 value sets)
    select tp.verified_pct into v from task_progress tp
     where tp.task_id = p_task and tp.status in ('verified','adjusted') and tp.report_date <= s
     order by tp.report_date desc, tp.verified_at desc limit 1;
  end case;
  return round(coalesce(v, 0), 3);
end $$;
```

**`app.compute_evm(p_schedule uuid, s date)`** returns one row per leaf task with
`(task_id, f_pv, pct_earned, bac_value, bac_cost, pv_*, ev_*, ac)`:
- `B` = approved baseline (`schedules.approved_baseline_id`); leaf = `not is_summary`, in `B`.
- `pv_x = bac_x × app.pv_fraction(...)`. `ev_x = bac_x × (ev_method = 'loe' ? f_pv : pct_earned / 100)`.
- `ac` = Σ `cost_entries.amount` (entry_date ≤ s, task_id = t) + Σ allocated material from
  `v_ac_material_alloc` (txn local date ≤ s).

Views (`security_invoker`):
- `v_ac_material_alloc(project_id, ledger_id, txn_date, task_id null = unallocated, amount)`. Valuation CTE
  copied from `v_cost_control` (`recv`/`avg_cost`), allocation per §3.4 with `share = link_qty / Σ link_qty`.
- `v_evm_task`: `compute_evm` at `schedules.status_date`, joined to task names/WBS, plus ratios:
  `spi = ev/nullif(pv,0)`, `cpi = ev_cost/nullif(ac,0)`,
  `eac_cpi = case when ev_cost/bac_cost < 0.10 then ac + (bac_cost - ev_cost) else ac + (bac_cost - ev_cost)/nullif(cpi,0) end`,
  `eac_budget = ac + bac_cost - ev_cost`, `eac_composite = ac + (bac_cost - ev_cost)/nullif(cpi*spi,0)`,
  `vac = bac_cost - eac_<default>`, `tcpi_bac = (bac_cost - ev_cost)/nullif(bac_cost - ac,0)`. Price roles only
  (joins `*_costs`; empty for others, as `v_element_cost` behaves).
- `v_evm_wbs`: rolls leaves up to every ancestor via a recursive CTE on `parent_id` (sum PV/EV/AC/BAC, then
  ratios).
- `v_evm_project`: project sums + unallocated AC + ES metrics from `app.earned_schedule(schedule, s)`
  (interpolates on the daily cumulative PV curve, §3.5).
- `v_progress_overview` (**non-price**, security definer function wrapped in a view): `pct_planned`,
  `pct_earned`, SPI, SPI(t), SV(t), forecast finish, counts of late/critical tasks per WBS. This is what site
  engineers and the mobile dashboard read.
- `v_evm_timeseries`: (a) planned curve: for every period end (closed, open and future) of the baseline span,
  `Σ pv_fraction × bac` (cumulative); (b) closed snapshots EV/AC; (c) live point at `status_date`; (d) original
  baseline curve if re-baselined; (e) forecast EV curve from `fc_start/fc_finish`. Columns
  `(project_id, schedule_id, period_end, series, basis, value)`.
- `v_boq_mapping_check`, `v_task_lookahead` (tasks with `fc_start` within s+21 days, linked elements and
  take-off demand).

### 5.2 RPCs (all `security definer`, `p jsonb` with `op_id`, `app.op_seen` / `app.op_done`)

| RPC | Roles | Payload (`p`) | Behaviour |
|---|---|---|---|
| `import_schedule` | office_engineer, coordinator, manager, admin | `{op_id, project_id, schedule_id, version_id, schedule:ParsedSchedule, mapping:{boq_field?, element_field?, file_mapping_wins?:bool}, options:{opening_progress?:bool, uid_remap?:[{old_uid,new_uid}], confirm_remove_uids?:int[], block_by?:{field, ...}}}` | Same `file_sha256` → returns the earlier result. Validates (unique UIDs, links to known UIDs, no cycles, currency = project currency or explicit `options.accept_currency`). Upserts calendars → rebuilds `app.calendar_days`. Upserts tasks by UID → GUID → remap (§4.3); builds `parent_id` from outline order; expands summary links; replaces links. Writes MSP costs to `schedule_task_costs` **only if `app.can_see_prices()`**, else drops them with a warning. Parses mapping fields → `task_boq_links` (BoQ `item_no` lookup; unknown numbers → warnings). Assigns default `ev_method` by rule (BoQ link → `units`; element link → `elements`; milestone → `milestone` / `0_100`; duration ≤ `short_task_days` → `0_100`; name matches /prelim/ → `loe`; else `pct`). Stores MSP baselines 0–10 in `header.msp_baselines` (dates, and costs in a price table) as **candidates**. Writes `diff`, `quality`. Notifies the manager. Returns `{ok, version_id, version_no, added, updated, removed, kept_with_progress, links, warnings, quality}` |
| `set_baseline` | office_engineer+ | `{op_id, schedule_id, baseline_id, name, source:'msp_baseline'\|'current_plan', msp_baseline_number?, effective_from, reason, budget:{value:'boq_links'\|'msp_cost', cost:'budget_lines'\|'msp_baseline_cost'\|'value_less_margin'\|'none'}, unmapped_value?:'msp_cost'\|'zero'}` | Creates a **proposed** baseline: copies dates per leaf task (source MSP baseline n or current plan), computes `bac_value` = Σ link qty × BoQ rate (unmapped tasks per `unmapped_value`) and `bac_cost` (`budget_lines` allocated to tasks pro rata by `bac_value` within each BoQ item / category). Reason required for baseline_no > 1. Returns totals for review (value BAC vs contract sum, cost BAC vs budget) |
| `approve_baseline` | manager, admin | `{op_id, baseline_id, approve:bool, comment}` | Approve → previous approved becomes `superseded`; `schedules.approved_baseline_id` set. Closed snapshots are untouched (history is never restated). PV before `effective_from` comes from earlier snapshots. Reject → comment required |
| `save_task_setup` | office_engineer+ | `{op_id, task_id, ev_method?, start_pct?, boq_links?:[{id, boq_item_id, planned_qty, deleted?}], element_links?:[{id, element_id, weight?, activity_seq_from?, activity_seq_to?, deleted?}], steps?:[{id, seq, name, weight}], block_id?, level_id?, comment?}` (also a bulk form `tasks:[…]`) | Validates step weights > 0; a method change after the first closed period requires `comment` (audited). Recomputes current `verified_pct` |
| `report_task_progress` | site_engineer, office_engineer, coordinator, manager, admin | `{op_id, id, task_id, report_date, pct?, qty?:[{boq_item_id, qty_to_date}], steps?:[{step_id, done_pct}], actual_start?, actual_finish?, remaining_days?, delay_cause?, remarks?}` | Rejects summary tasks; `elements` → "report on the element activities"; `loe` → not reportable. Method value checks (`0_100` ∈ {0,100}; `50_50` ∈ {0,start_pct,100}; `units` needs qty, qty_to_date ≥ last verified unless remarks; > planned_qty needs remarks "over-measure"). `report_date` ≤ local today and > last closed `status_date` (else "period closed"). Hold point: if linked elements have unsigned hold points, the same rule as `report_progress`. Updates `reported_*` on the task/links; sets `actual_start` on first > 0. Notifies office engineers. Returns `{ok, id}` |
| `verify_task_progress` | office_engineer, coordinator, manager, admin | `{op_id, progress_id, approve, verified_pct?, verified_qty?, verified_steps?, actual_start?, actual_finish?, comment?}` (bulk `items:[…]`) | Same semantics as `verify_progress` (adjusted/rejected need a comment; only `reported` can be verified). Computes `verified_pct` for units/steps. Updates task `verified_pct`, `actual_*`, `remaining_days`, `progress_as_of`, link `verified_qty`, step `verified_pct`. Notifies the reporter |
| (trigger) `app.refresh_task_from_elements` | — | — | Called from `app.refresh_element_progress`: recomputes `verified_pct`/actual dates of `elements`-method tasks linked to the element |
| `run_forecast` | office_engineer+ | `{op_id, schedule_id, status_date}` | `app.run_cpm`; writes forecast columns and `schedules.status_date/fc_finish/es_finish`; raises alerts (negative float, critical late start). Returns `{fc_finish, es_finish, critical_count, negative_float_count, cycle?:uids}` |
| `open_period` | office_engineer+ | `{op_id, id, schedule_id, kind, period_no, period_start, status_date}` | Contiguous, non-overlapping with the previous period of the same kind |
| `prepare_period_close` | office_engineer+ | `{op_id, period_id}` | Checks: no `reported` progress ≤ status_date (or listed in `carry_ids`); weekly diaries signed (warning); cost entries present for each category this period (warning). Runs `run_forecast` and `compute_evm`; writes **draft** snapshot rows (status `prepared`); lists threshold breaches that need `evm_variance_notes` |
| `close_period` | manager, admin | `{op_id, period_id, comment?}` | Requires `prepared` with no blocking issues and variance notes for every critical breach. Recomputes (in case of late verifies) and writes final `evm_task_status`, `evm_snapshots` (both bases, task/WBS/project), `period_boq_progress` (Σ verified link qty per BoQ item + previous). Sets `closed`. Creates/updates alerts. Notifies management (+ Telegram) |
| `reopen_period` | manager, admin | `{op_id, period_id, reason}` | Only the latest closed period; deletes its snapshots (audited copy in `audit_log`); back to `open` |
| `record_actual_cost` | price roles (coordinator, manager, procurement, admin + office_engineer if in `price_roles`) | `{op_id, id, number, entry_date, category, task_id?, wbs_task_id?, boq_item_id?, element_id?, description, supplier_id?, subcontractor?, qty?, uom?, rate?, amount, source?, source_ref?, is_estimate?}` | `entry_date` > last closed status date (else `relates_to_period_id`, dated today). `amount = qty × rate` when both are given. Append-only |
| `reverse_cost_entry` | same | `{op_id, id, number, reversal_of, reason}` | Negative mirror row |
| `record_resource_usage` | office_engineer+, site_engineer (own diary) | `{op_id, id, usage_date, kind, task_id?, trade_id?, equipment?, subcontractor?, boq_item_id?, qty, uom, diary_id?}` | Non-price. A nightly `app.estimate_costs_from_usage()` creates `is_estimate` cost entries from `cost_rates` (replaced when payroll/invoice entries for the same period/category arrive) |

All RPCs: `app.require_member`, `app.require_role`, readable error messages, `notify_*`, idempotent through
`processed_ops`. Mobile outbox ops: `report_task_progress`, `verify_task_progress`, `record_resource_usage`.

---

## 6. Import quality report (shown in preview, stored in `schedule_versions.quality`)

DCMA-14-style indicators, adapted for building programmes. They warn; none block except cycles and duplicate UIDs.
- Missing logic: incomplete leaf tasks with no predecessor or no successor (target ≤ 5%).
- Leads (negative lag): target 0. Lags: ≤ 5% of links. Link types: ≥ 90% FS; SF ≈ 0.
- Hard constraints (MSO/MFO/SNLT/FNLT) ≤ 5%. High float > 44 wd ≤ 5% (usually a missing successor). Negative
  float = 0.
- Durations > 44 wd on non-LOE tasks (split them for measurable progress).
- Manual tasks; summary tasks carrying links (expanded); tasks with links to/from milestones only.
- Inactive and external tasks skipped.
- **No baseline in file** (offer "baseline from current plan").
- **No costs** (value BAC will come from BoQ mapping).
- Mapping coverage: % of leaf tasks with BoQ/element links, % of contract value mapped, BoQ items over- or
  under-mapped.
- Calendar: working days per week found (5 vs 6) and holiday count, with a prompt to load the Ethiopian holiday
  list if 0.
- Currency mismatch; currency-scale sanity (Σ Cost of top summaries vs project summary task cost, shown for the
  user to confirm against MSP).

---

## 7. UI outline (web + mobile)

- **Web → Progress → Schedule:** import wizard (file → field mapping (aliases) → quality report → diff →
  commit); Gantt (current vs baseline bars, actual progress, critical path in red, float labels, status-date
  line); task drawer (links, BoQ/element mapping, steps, method, progress history).
- **Web → Progress → EVM** (price roles): KPI tiles (SPI, CPI, SPI(t), EAC, VAC, TCPI, forecast finishes),
  S-curves (value/cost toggle), WBS tree with variance heat, variance notes, period close workflow, export
  (Excel + PDF, and "MSP progress update" xlsx).
- **Web → Progress → Valuation:** `period_boq_progress` × BoQ rates → gross value to date / previous / this
  period, retention %, advance recovery %, materials on site. This is the IPC draft (separate follow-up feature;
  the data is ready).
- **Mobile → Progress:** "My tasks" (forecast or baseline window overlapping −7…+14 days, filtered by assigned
  blocks/levels), quantity entry showing *previous verified cumulative* + *today's increment* → sends
  cumulative, steps checklist, start/finish buttons, remaining days, delay cause chips, photos. A
  non-price project dashboard: planned % vs earned %, SPI(t), forecast finish, critical tasks.

---

## 8. Phasing

1. **P1:** MSPDI + Excel parser (shared TS, tests with real client files); tables; `import_schedule`,
   `set_baseline`/`approve_baseline`, mapping UI, `report/verify_task_progress`, element-derived tasks, value-basis
   EVM views, S-curve, `run_cpm`, weekly forecast, periods + close with snapshots, material AC allocation.
2. **P2:** cost entries + resource usage + rate-based estimates, cost-basis EVM/EAC/TCPI, alerts, variance
   notes workflow, MSP progress export, look-ahead MR from forecast, valuation/IPC draft.
3. **P3:** .mpp/XER converter service (MPXJ), resource-curve PV from timephased baseline, task calendars,
   multiple schedules per project, schedule risk (what-if delays).

---

## 9. Top risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Client MSP files are weak: no baseline, little logic, manual tasks, hard constraints, no costs | Quality report (§6); baseline from current plan; BAC from BoQ mapping; CPM shows the consequences of missing logic |
| R2 | BoQ ↔ schedule granularity mismatch; mapping effort | MSP custom-field convention, Excel columns, bulk mapping UI with take-off-based splitting; "unmapped value %" KPI instead of blocking |
| R3 | Mixing value (BoQ) and cost bases → meaningless CPI | Two explicit bases; CPI only on cost basis; labels; settings |
| R4 | AC incomplete or late (labour, subcontract invoices) → CPI looks too good | AC coverage panel per category per period; diary-based estimates flagged `is_estimate`; close-checklist warnings; info alert when CPI > 1.15 |
| R5 | UID instability (planner rebuilds file, copy-pastes into a new .mpp) → progress orphaned | UID → GUID → user-confirmed name/WBS remap; never delete tasks with progress; diff preview |
| R6 | Unit traps: tenths of minutes (lag/slack), PT hours, elapsed formats, currency scale (÷100), naive local datetimes, % lag | Single tested converter module; client-file fixtures; preview totals and sample tasks for the user to cross-check against MSP before commit |
| R7 | Re-baselining used to hide variance | Approval by manager, reason, all baselines kept, original contract baseline line on S-curve, closed snapshots immutable (EIA-748: no retroactive changes) |
| R8 | Offline reports arriving after period close; duplicate cumulative quantities from two engineers | Cumulative (not incremental) quantities; reject or carry by status date; verification picks one report; `op_id` idempotency |
| R9 | Subjective % inflates EV | Default to quantity / element / steps methods; `pct` only for minor tasks; verification mandatory; EV uses verified data only |
| R10 | CPM in plpgsql diverges from MSP (calendars, constraints, summary logic, retained logic) | Store MSP dates/float for comparison; show the discrepancy count; document the differences; v1 single calendar |
| R11 | Performance of live views on large schedules | Precomputed `calendar_days`; snapshots for history; live views compute only at the current status date; indexes on `(task_id, report_date)` |
| R12 | Ethiopian calendar/holidays and 6-day week missing from MSP calendar → wrong PV | Detect it in the quality report; offer an Ethiopian holiday template; minutes/week check (2880 vs 2400) |

---

## Sources

MSP / MSPDI / parsing
1. Microsoft Learn: Project XML Data Interchange, Task element. https://learn.microsoft.com/en-us/office-project/xml-data-interchange/task-element?view=project-client-2016
2. Microsoft Learn: Project element (MinutesPerDay, CurrencyCode, StatusDate, BaselineForEarnedValue…). https://learn.microsoft.com/en-us/office-project/xml-data-interchange/project-element?view=project-client-2016
3. Microsoft Learn: PredecessorLink element. https://learn.microsoft.com/en-us/office-project/xml-data-interchange/predecessorlink-element?view=project-client-2016
4. Microsoft Learn: LinkLag element (tenths of a minute). https://learn.microsoft.com/en-gb/office-project/xml-data-interchange/linklag-element?view=project-client-odc
5. Microsoft Learn: LagFormat element. https://learn.microsoft.com/en-us/office-project/xml-data-interchange/lagformat-element?view=project-client-2016
6. Microsoft Learn (Office 2003/2007 refs): PredecessorLink Type values 0=FF 1=FS 2=SF 3=SS. https://learn.microsoft.com/en-us/previous-versions/office/developer/office-2007/bb968712(v=office.12)
7. Microsoft Learn: DurationFormat element (codes, elapsed). https://learn.microsoft.com/en-us/office-project/xml-data-interchange/durationformat-element?view=project-client-2016
8. Microsoft Learn: Baseline element (Number, Interim, Cost, BCWS…). https://learn.microsoft.com/en-us/office-project/xml-data-interchange/baseline-element?view=project-client-2016
9. Microsoft Learn: Calendar element / WeekDay element. https://learn.microsoft.com/en-us/office-project/xml-data-interchange/calendar-element?view=project-client-2016 · https://learn.microsoft.com/en-us/office-project/xml-data-interchange/weekday-element?view=project-client-2016
10. Microsoft Learn: TimephasedData element. https://learn.microsoft.com/en-us/office-project/xml-data-interchange/timephaseddata-element?view=project-client-2016
11. Microsoft Learn: Assignment element. https://learn.microsoft.com/en-us/office-project/xml-data-interchange/assignment-element?view=project-client-2016
12. Microsoft Learn: Cost element; EarnedValueMethod element. https://learn.microsoft.com/en-us/office-project/xml-data-interchange/cost-element?view=project-client-2016 · https://learn.microsoft.com/en-us/office-project/xml-data-interchange/earnedvaluemethod-element?view=project-client-2016
13. Microsoft (Office 2007): TotalSlack in tenths of a minute; ExtendedAttribute FieldID 188743731 = Text1, FieldID not unique across projects. https://learn.microsoft.com/en-us/previous-versions/office/developer/office-2007/bb968632(v=office.12) · https://msdn.microsoft.com/en-us/library/bb968669.aspx
14. Microsoft Support: BCWP fields; Earned Value Method task field; Unique ID Predecessors field. https://support.microsoft.com/en-US/project/bcwp-fields · https://support.microsoft.com/en-us/project/earned-value-method-task-field · https://support.microsoft.com/en-gb/office/predecessors-task-field-5a5ea9c2-14e6-4be7-9a3d-d8b6cba10cab
15. Microsoft Support: Import/Export wizard maps; XML export of whole project. https://support.office.com/en-us/article/6e6e581f-a580-4f04-aa87-9b6552143d9c
16. MPXJ: formats supported, MSPDI reader notes; DatatypeConverter (currency ÷100, duration codes). https://www.mpxj.org/howto-read-mspdi/ · https://github.com/joniles/mpxj · https://raw.githubusercontent.com/joniles/mpxj/master/src/main/java/org/mpxj/mspdi/DatatypeConverter.java
17. MPXJ bug #243 (TotalSlack units). https://sourceforge.net/p/mpxj/bugs/243

EVM / scheduling practice
18. NDIA IPMD EVMS Intent Guide (EIA-748, 32 guidelines, PMB, change control). https://www.humphreys-assoc.com/evms/evms-documents/ndia/ndia_ipmd_intent_guide_ver_d_aug282018.pdf · https://ndia.org/divisions/ipmd/division-guides-and-resources
19. AcqNotes: ANSI/EIA-748. https://acqnotes.com/acqnote/tasks/ansi-eia-748-earned-value-management
20. Deltek Cobra: performance measurement techniques (0/100, 50/50, milestones, units, LOE…). https://help.deltek.com/product/cobra/8.0/GA/How%20is%20Earned%20Value%20Calculated.html
21. KFUPM CEM-510 (Al-Khalil): progress measurement methods & rules of credit (units, incremental milestones, start/finish 50% or 20–30%, supervisor opinion, cost ratio, weighted units). https://faculty.kfupm.edu.sa/CEM/alkhalil/PDF%20Files_CEM_510/Project%20Control%202%20-%20Progress%20Measurment.pdf
22. 4castplus: rules of credit & weighted steps. https://4castplus.com/measuring-project-progress-rules-of-credit-and-weighted-steps-progressing/
23. Lipke, Earned Schedule papers/slides (ES, SV(t), SPI(t), IEAC(t)). https://www.earnedschedule.com/Docs/Earned%20Schedule%20-%20A%20Quantum%20Advance.pdf · https://earnedschedule.com/Docs/Lipke%20UT%20Dallas%202014%20-%20ES%20Introduction%20v1.pdf
24. AACE PSP study guide: ES theory & formulas. https://open-exam-prep.com/study-guides/aace-psp/earned-value-schedule/earned-schedule-theory-and-metrics
25. EAC/TCPI formula references (PMBOK-derived). https://www.4pmti.com/learn/forecasting-projects-in-progress-with-eac-2/ · https://www.deepfriedbrainproject.com/2010/01/solving-estimate-at-completion-puzzle.html
26. GAO Schedule Assessment Guide (GAO-16-89G): status date, valid critical path, reasonable float, updating with actual progress & logic. https://www.gao.gov/assets/d1689G.pdf · https://gaoinnovations.gov/schedule-guide/best-practice-7-ensuring-reasonable-total-float.html
27. DCMA 14-point assessment metrics. https://help.deltek.com/Product/Acumen/8.3/GA/DCMA%2014%20Point%20Assessment%20Metric%20Descriptions.html
28. Retained logic vs progress override (Planning Planet / AACE paper; Ten Six). https://planningplanet.com/guild/library/retain-or-override-%E2%80%93-question-logical · https://tensix.com/options-for-scheduling-progressed-activities-in-p6/
29. BoQ ↔ activity cost loading practice (Planning Planet threads). https://planningplanet.com/comment/85363 · https://planningplanet.com/comment/28011

Ethiopia / East Africa
30. Kasiem Seid, *Study of the problems of construction conditions of contract for public works in Ethiopia*, AAU MSc 2008: monthly interim payments, 5% minimum IPC, 7+14-day certification/payment, 80% materials on site, retention 10%→5%, advance up to 20%. https://etd.aau.edu.et/bitstreams/8eb6eecb-5a82-4d20-accd-787e2045c345/download
31. EVM practice in Ethiopia: AAU theses (Rama Construction; road projects S-curve vs EVM), Amhara water works study. https://etd.aau.edu.et/bitstreams/d405dbeb-b8e5-45c7-b1c4-8f21e08beda4/download · https://etd.aau.edu.et/bitstreams/b149aa65-7922-4785-8cbc-24dda5c45d20/download
32. Ethiopian Labour Proclamation 1156/2019 summaries (8 h/day, 48 h/week; 13 public holidays). https://wageindicator.org/en-et/work-in-ethiopia/labour-law/compensation-and-working-time

*Items marked "verify" (ConstraintType and Resource Type codes, currency scale, % lag encoding) come from
secondary sources or MPXJ behaviour. Confirm them with one real client MSPDI file before coding the
converters.*
