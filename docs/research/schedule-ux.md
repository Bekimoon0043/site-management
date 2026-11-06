# Schedule, Earned Value, Look-ahead & Procurement Flows: UX Spec

Status: research output, implementation-ready · Date: 2026-10-30
Scope: new modules in `web/` (React 19 + Vite, plain CSS tokens, recharts lazy, `@tanstack/react-virtual`) and `mobile/` (Expo, offline-first SQLite + outbox).
Builds on: `web/src/components/README.md`, `mobile/src/components/README.md`, `docs/research/web-design.md`, `docs/research/mobile-design.md`, `docs/research/features.md` (B3 look-ahead, A1–A3 procurement).
Palette: "Blueprint & Beacon". Navy `--primary` (#163A5F) for selection, links, actual/forecast series and progress. Amber `--accent` (#F59E0B) only for the one hero action, the active-nav bar and the **today line**. Status always uses icon + words.

---

## 0. Design principles for these modules

1. **The schedule belongs to MS Project; we read it.** This is the same rule as Procore's uploaded read-only schedules and its lookaheads, which "do not change an integrated master schedule". There is no drag-editing of bars in v1. Planners keep using MS Project and re-import it. We own **progress, mapping, constraints and material readiness**. This removes 70 % of Gantt complexity (no auto-scheduling, no undo stack, no CPM conflicts) and keeps one source of truth.
2. **The phone shows lists, not Gantt.** On a 360 dp screen a Gantt chart is a scroll puzzle. Mobile users get an agenda ("This week › Tuesday › tasks") with a mini planned-vs-actual bar per row. Primavera Cloud's mobile Work Plan, Outbuild and Fieldwire all centre the phone on "my tasks + update progress + photo".
3. **One number, one sentence.** Every EVM metric gets a plain-language sentence ("For every 1 birr spent we earned 0.92 birr of work") and a traffic light with icon and word. The acronym is secondary text.
4. **Progress is append-only and verified.** This reuses the existing `progress_updates (reported → verified | adjusted | rejected)` model. Site reports. The office verifies. Only verified progress feeds EV. Unverified progress shows as a dotted "reported" line, the same as the existing S-curve spec.
5. **Every screen answers "who must act next?"** Procurement flows render as a timeline with the current step's role and named people, an age chip, and a single primary action for the viewer when it is their turn.
6. **Fast on low-end hardware.** Web: virtualize everything over 200 rows, keep ≤ 400 SVG nodes in the DOM, and parse imports in a Web Worker. Mobile: FlashList, SQL aggregates, no charts on the hot path (the `ProgressRing`/`ProgressBar` statics are already there).

---

## 1. Research summary: what we adopt

| Product / source | What it does well | What we take |
|---|---|---|
| **Procore Schedule** (List / Calendar / Gantt / Lookahead) | Uploaded schedule is read-only. 1–6-week lookaheads edit separately from the master. Gantt toggles for critical path, % complete and dependencies. Bar saturation shows % complete. Critical bars are red. Baseline is a grey hatch. A hazard icon flags lookahead dates that differ from the master. "Compare to latest master". | Read-only master. Look-ahead as a separate layer. Toggles row (Critical · Dependencies · Baseline). Hatch for baseline. Warning icon on dates that moved since last import. |
| **Fieldwire** | Gantt planning from imported tasks. A manpower intensity graph under the Gantt. Field users see assigned tasks and update them on mobile. | Task importer + "my tasks" mobile. An optional histogram strip under the look-ahead (we use **material demand** instead of manpower). |
| **Smartsheet** | Baseline adds Baseline Start/Finish/Variance columns. Baseline is a thin grey line under the bar. "Show critical path" in red, filterable to critical-only. | Thin baseline bar under the planned bar. Variance column ("+6 d"). A "Critical" filter chip. |
| **Asana Gantt / Timeline** | Timeline is simple (finish-to-start only). The Gantt adds baselines and critical path. Weekend awareness. | Keep dependencies optional and drawn only on demand. Shade weekends and holidays. |
| **monday.com Gantt** | Approachable colour-coded bars, grouping. | Group rows by WBS level-1 with collapsible headers. |
| **Microsoft Planner Premium / Project for the web** | Grid ↔ Board ↔ Timeline views of the same plan. Dependencies and milestones. | One dataset, view switcher: **Table · Gantt · Month**. |
| **Oracle Primavera Cloud** (Tasks / Work Plan) | Work Plan tile shows previous week, current week and look-ahead. Field updates on mobile, offline. Missed-commitments overview. Printable planning board for meetings. | Mobile agenda grouped by week. PPC + missed commitments. Printable monthly look-ahead (A3 landscape). |
| **Primavera / Oracle Analytics EV dashboards** | CPI/SPI monthly and cumulative lines. Cumulative indices computed from cumulative values. SPI/CPI < 1.000 red, > 1.000 green. Project scatter by SPI × CPI. | Index trend chart, cumulative maths, ±thresholds. SPI × CPI quadrant at the WBS level-1 drill-down. |
| **Deltek Cobra / wInsight** | KPI overview + forecasting with multiple EAC scenarios. | Show **two** EAC methods (BAC/CPI and AC + remaining at budget) with a "which one?" explainer. |
| **PMI / EVM formula references** | Standard formulas: EAC, VAC, TCPI. | §6 formula table. TCPI is shown only in the "More metrics" drawer. |
| **Touchplan / Last Planner System (LCI, IGLC)** | Make-ready planning on a ~6-week look-ahead. A constraint log with an owner and promise date. PPC = % of weekly commitments completed. Constraint-category discussion improves reliability. | Readiness chips (Materials · Approvals · Drawings · Inspection) with owner + due date. Weekly commitments. PPC per week with a reasons-for-miss Pareto. |
| **Nialli / Outbuild** | LPS weekly plans. Mobile progress % + roadblocks + photos tied to the schedule task, offline sync. | Mobile update sheet: % / quantity + photo + "Issue on site?" chips (reuses the progress spec §5.4). |
| **MS Project MSPDI XML schema** | `Task` with `UID`, `GUID`, `OutlineLevel`, `WBS`, `Start/Finish`, `Duration`, `PercentComplete`, `Critical`, `TotalSlack`, `PredecessorLink`, `Baseline` collection, `ExtendedAttribute` (custom fields). | Import keys and fields (§3.2). Re-import diff keyed on `GUID` → `UID`. |
| **Touchplan / JD Edwards Excel-export guides** | Excel export via the Export Wizard with headers: Unique ID, WBS, Outline Level, Name, Start, Finish, Predecessors. | Excel template + aliases for the existing `ImportWizard` mapping step. |
| **Ethiopian EVM / delay studies** (Adv. Civ. Eng. 2021, Cogent Eng. 2023, AAU theses) | Building projects average +143 % delay. Late material delivery is a top cause. Project-management systems are not widely practised, but EVM is a better indicator than S-curves alone. | Pair schedule with **material readiness**. Teach EVM in plain words rather than assuming PMP literacy. |

### Gantt library evaluation (target: 1,000–3,000 tasks, read-only, React 19, small/MIT)

| Option | Licence | Fit | Verdict |
|---|---|---|---|
| **Custom SVG + `@tanstack/react-virtual`** | ours | We already ship react-virtual. Read-only bars need ~600–900 lines. Full control of tokens, baseline/actual/forecast triple bars, holidays, Ethiopian calendar header, print. | **Recommended.** |
| frappe-gantt 1.x | MIT | Small, SVG, view modes Quarter-day → Month, progress drag. Imperative DOM API (needs a wrapper). Reviewers say it was "not designed for thousands of tasks". No virtualization, no baseline, single bar per row. | Prototype only. |
| gantt-task-react 0.3.9 | MIT | Last published July 2022. Peer dep `react ^18` (no React 19). No virtualization. Feature-minimal. | Reject (unmaintained, peer-dep conflict). |
| DHTMLX Gantt | GPL v2 (Standard) / MIT Community Edition (v10+) / commercial from ~US$799 | Fast and mature. **Critical path, auto-scheduling and overlays (S-curve) are PRO-only.** GPL would force our console's licence. | Reject: licence + bundle (~200 kB+) + PRO paywall for the feature we need. |
| SVAR React Gantt | MIT core (one mirror says GPLv3; verify) | Virtualized, 10k-task demo. **Baselines and critical path are PRO.** | Fallback if custom slips; check licence file and React 19 peer. |
| vis-timeline | Apache-2.0 OR MIT | Timeline, not Gantt (no tree table, no dependencies). Its own docs say rendering stays smooth "up to a few hundreds of items at once". | Reject for Gantt. Not needed for the month view either. |
| Bryntum / Syncfusion | commercial | Heavy. A vendor benchmark shows Bryntum at 8 s initial render for 5k tasks. | Out of scope. |

---

## 2. Data model sketch (enough to drive the UX)

```
schedules            (id, project_id, name, source: 'mspdi'|'excel', status_date, active_version_id)
schedule_versions    (id, schedule_id, imported_at, imported_by, file_name, file_hash, task_count, summary jsonb)  -- one per import
schedule_tasks       (id, schedule_id, version_id, guid, uid, wbs, outline_level, parent_id, sort, name,
                      is_summary, is_milestone, start, finish, duration_days,
                      baseline_start, baseline_finish, critical bool, total_float_days,
                      ms_pct_complete, custom jsonb, removed_at)            -- current row per guid/uid
schedule_links       (schedule_id, pred_task_id, succ_task_id, type 'FS'|'SS'|'FF'|'SF', lag_days)
task_mappings        (task_id, element_id?, boq_item_id?, qty?, weight, source 'auto_code'|'auto_name'|'manual')
task_progress        -> reuse progress_updates with task_id (nullable) alongside element_id; status reported/verified/adjusted/rejected
task_constraints     (id, task_id, kind 'materials'|'approval'|'drawing'|'inspection'|'labour'|'equipment'|'other',
                      status 'open'|'cleared', owner_id, due_date, note, link_type?, link_id?)  -- LPS constraint log
weekly_commitments   (id, project_id, week_start, task_id, committed_by, done bool, miss_reason?)  -- PPC
evm_snapshots        (project_id, status_date, wbs_task_id null=project, bac, pv, ev, ac, closed bool)  -- period close freezes
project_calendar     (project_id, date, kind 'holiday'|'non_working'|'working', name_en, name_am, tentative bool)
purchase_requests    (id, number, project_id, status, created_by, source 'lookahead'|'reorder'|'manual', lines…)  -- flow A
flow_events          (entity_type, entity_id, step, action 'submit'|'approve'|'return'|'reject'|'confirm', actor, at, comment)
```

- **Budget per task** = Σ mapped BoQ amount (`boq_items × boq_rates`, price roles only) or Σ element take-off cost. This becomes BAC per task, rolled up the WBS.
- **% complete per task** (EV basis), in priority order: (1) quantity-mapped → verified qty / mapped qty; (2) element-mapped → weighted verified element % (the existing activity-template roll-up); (3) direct task % from a verified `progress_updates.task_id` row. MS Project's own `PercentComplete` is shown for reference only and never feeds EV.
- **AC (actual cost)** = posted material issues (MIV) to mapped elements × GRN/PO unit price, plus an optional "Other costs" import (labour, plant, subcontract) per WBS per month. The dashboard header always states the **cost basis**. If AC is materials-only, BAC must be the materials portion of the BoQ. Otherwise CPI is meaningless. This is a project setting: `evm_cost_basis = 'materials' | 'full'`.

---

## 3. Module 1: Schedule import (web, office engineer / coordinator)

Route `/schedule/import` (lazy). Reuses `Stepper`, `Card`, `DataTable`, `Banner`, `Badge`, `Drawer`. This is a 4-step wizard that extends the `ImportWizard` pattern. It is not `ImportWizard` itself, because the review step is a tree and the mapping step is BoQ-specific.

### 3.1 Step 1: Upload

```
Schedule › Import                                                        [Cancel]
 ① Upload ─── ② Preview ─── ③ Link to BoQ ─── ④ Confirm
┌─ Upload your MS Project schedule ───────────────────────────────────────────────┐
│  ┌ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - ┐ │
│  ¦   ⇪  Drop the file here or [Choose file]                                  ¦ │
│  ¦      Best: MS Project XML (.xml)   ·   Also works: Excel (.xlsx) export   ¦ │
│  └ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - ┘ │
│  How to get the XML from MS Project:  File › Save As › "XML Format (*.xml)"   ⓘ │
│  Excel: File › Export › Excel › Tasks with headers. [Download Excel template]   │
│                                                                                 │
│  Status date for progress  [ 30 Oct 2026 ▾ ]   (defaults to the file's status date)│
│  This is a re-import of "Main schedule rev C" (imported 2 Oct by Hana) ✓        │
└─────────────────────────────────────────────────────────────────────────────────┘
                                                                     [Next: Preview ▸]
```

- Detect the format from the file content (XML root `<Project xmlns="http://schemas.microsoft.com/project">`), not the extension.
- Parse in a **Web Worker** (`DOMParser` is unavailable in workers, so use a streaming SAX parser such as `saxes` (~12 kB) or a ~150-line hand-rolled tag scanner). Post progress ("Reading tasks… 1,840 / 2,960"). A 3,000-task MSPDI file (5–15 MB with assignments and timephased data) parses in < 2 s on a mid laptop. **Skip `<TimephasedData>` and `<Assignments>`** unless a later version needs resource loading.
- `.mpp` is not supported. Show "Save as XML in MS Project first" with a screenshot GIF. Parsing `.mpp` needs MPXJ (Java/.NET) server-side, which is not worth it for v1.
- Re-import detection: same `<GUID>` of the project, or same file name, or the user picks "Update existing schedule ▾".

### 3.2 Field mapping (MSPDI → `schedule_tasks`)

| MSPDI element | Our field | Notes |
|---|---|---|
| `Project/StatusDate`, `CurrentDate` | `status_date` default | |
| `Task/GUID` (2007+), fallback `UID` | identity key for diff | `ID` is the row number. **Never** key on it (it shifts on insert). |
| `OutlineLevel`, `OutlineNumber`, `WBS` | tree + `wbs` | Build the parent stack from OutlineLevel order. Use `WBS` for display, `OutlineNumber` as fallback. |
| `Name`, `Summary`, `Milestone` | name, is_summary, is_milestone | Drop `UID 0` (project summary task). Keep it as the root label. |
| `Start`, `Finish`, `Duration` (`PT280H0M0S`) | start, finish, duration_days | Convert hours ÷ `MinutesPerDay/60` from the project header (default 8 h). |
| `Baseline[Number=0]/Start,Finish` | baseline_* | If no baseline: banner "No baseline in this file. We'll use these dates as the baseline." Freeze on first import. |
| `Critical`, `TotalSlack` | critical, total_float_days | Trust MS Project's CPM. Don't recompute. |
| `PercentComplete` | ms_pct_complete | Reference only. |
| `PredecessorLink/PredecessorUID, Type, LinkLag` | schedule_links | Type 0 FF, 1 FS, 2 SF, 3 SS. Lag is in tenths of minutes. |
| `ExtendedAttribute/FieldID, Value` (+ `Project/ExtendedAttributes` for alias) | custom jsonb | Offer "Text1 (BoQ code)" etc. as the auto-match key in step 3. |
| `Calendars/.../Exceptions` | project_calendar suggestions | Offer to import the file's non-working days into the project calendar. |

Excel aliases (for the `ImportWizard` mapping): `Unique ID|UID|Unique_ID`, `WBS|WBS Code`, `Outline Level|Level`, `Name|Task Name|Activity`, `Start|Start Date`, `Finish|Finish Date|End`, `Duration`, `Predecessors|Unique ID Predecessors` (parse `12FS+2d,15SS`), `Baseline Start`, `Baseline Finish`, `% Complete`, `Critical`, `Text1…Text30`.

### 3.3 Step 2: Preview (tree)

```
 ① Upload ✓ ─── ② Preview ─── ③ Link to BoQ ─── ④ Confirm
┌ main-schedule-revD.xml · 2,960 tasks · 214 summary · 38 milestones · 3,410 links ┐
│ Project dates 05 Jan 2026 → 30 Jun 2027 · Status date 30 Oct 2026 · Baseline ✓  │
└──────────────────────────────────────────────────────────────────────────────────┘
⚠ 3 things to check ▾   • 12 tasks have no dates (shown as "—")  • 4 links point to missing tasks
                         • Calendar has 0 holidays: [Use Ethiopian holidays]
[Search tasks /]  (All ●) (Milestones) (Critical 412) (Problems 16)   [Expand all][Collapse to level 2]
┌───────┬──────────────────────────────────────┬────────────┬────────────┬──────┬──────────┐
│ WBS   │ Task                                  │ Start      │ Finish     │ Days │ Pred.    │
├───────┼──────────────────────────────────────┼────────────┼────────────┼──────┼──────────┤
│ 1     │ ▾ Block A                             │ 05 Jan 26  │ 30 Mar 27  │ 300  │          │
│ 1.2   │   ▾ Superstructure                    │ 02 Mar 26  │ 15 Jan 27  │ 230  │ 1.1      │
│ 1.2.3 │     ▾ Level 2                         │ 01 Sep 26  │ 20 Nov 26  │  60  │          │
│1.2.3.1│        Columns C1–C24 rebar & form  ◆C│ 01 Sep 26  │ 18 Sep 26  │  14  │ 1.2.2.4  │
│1.2.3.2│        Slab formwork                  │ 15 Sep 26  │ 06 Oct 26  │  16  │ +1 FS+2d │
└───────┴──────────────────────────────────────┴────────────┴────────────┴──────┴──────────┘
                                                        [◂ Back]   [Next: Link to BoQ ▸]
```

- This is a tree table. It is `DataTable` with an `indent` render on the name column and `virtual` (auto at > 200 rows). Summary rows are bold. `◆` marks a milestone and `C` is a critical chip (`Badge tone=danger icon=Flame label="Critical"`; colour never stands alone).
- Problems filter = rows with validation warnings, each with a sentence ("Finish is before start").

### 3.4 Step 3: Link tasks to BoQ items / elements

The goal is that each **work** task (leaf, non-milestone) gets ≥ 1 mapping, so we know its budget and how to measure its progress. Unmapped tasks still show on the schedule but contribute 0 to EV. A "Coverage" bar makes that visible.

```
 ① ✓ ─── ② ✓ ─── ③ Link to BoQ ─── ④ Confirm
┌ Coverage ─────────────────────────────────────────────────────────────────────────┐
│ ████████████████████░░░░░ 82 % of budget linked · 2,104 / 2,708 work tasks         │
│ Auto-matched: by BoQ code 1,620 · by element code 312 · by name 172 (review these) │
└───────────────────────────────────────────────────────────────────────────────────┘
Match using  [Custom field: Text1 "BoQ code" ▾]  then  [Element code in name ▾]  then [Name similarity ≥ 0.8 ▾]  [Re-run]
(All) (Unlinked 604) (Name matches to review 172) (Linked 1,932)          [Search /]
┌──┬─────────┬───────────────────────────────┬───────────────────────────────────┬──────────┬────────┐
│☐ │ WBS     │ Task                           │ Linked to                         │ How      │        │
├──┼─────────┼───────────────────────────────┼───────────────────────────────────┼──────────┼────────┤
│☐ │1.2.3.1  │ Columns C1–C24 rebar & form    │ 12 elements C1…C24 (L2)  ·  ETB 1.4M│ ✓ code  │ [Edit] │
│☐ │1.2.3.2  │ Slab formwork L2               │ BoQ 03.02.01 Formwork slab 410 m² │ ≈ name 0.86│[✓][✕] │
│☐ │1.2.3.5  │ Blockwork L2                   │ — not linked —                    │          │ [Link…]│
└──┴─────────┴───────────────────────────────┴───────────────────────────────────┴──────────┴────────┘
 Selected 3 ▸ [Accept matches] [Link all to…] [Mark "no budget" (e.g. mobilisation)]
                                                       [◂ Back]  [Next: Confirm ▸]
```

- **Auto-match cascade** runs in the worker:
  1. A custom field equals the BoQ item no. or element code (normalised: trim, lower-case, strip spaces and dots).
  2. A code regex in the task name (`/\b[A-Z]{1,3}-?\d{1,4}\b/` for elements; `\d{2}\.\d{2}(\.\d{2})?` for BoQ).
  3. Name similarity (token Jaccard + trigram) ≥ threshold, **constrained to the same block/level** when the WBS path contains a block/level name from `useLookups`.
  Results: `auto_code` (accepted), `auto_name` (needs review, shown with `≈`).
- `Link…` opens a **Drawer** with BoQ / Elements tabs, `SearchInput`, level/block `FilterSelect`, multi-select, and an optional qty split ("this task covers 410 of 820 m²"). Weight defaults to the budget share.
- "Mark no budget" covers mobilisation, approvals and milestones. These are excluded from the coverage denominator.
- Mappings persist **by task GUID**, so re-imports keep them.

### 3.5 Step 4: Confirm (first import) / Re-import diff

```
 ① ✓ ─── ② ✓ ─── ③ ✓ ─── ④ Confirm changes
┌ What will change (rev C → rev D) ──────────────────────────────────────────────────┐
│ [+ 46 new]  [~ 318 changed]  [− 9 removed]  [= 2,587 unchanged]   Progress kept ✓   │
└────────────────────────────────────────────────────────────────────────────────────┘
(New 46) (Changed 318 ●) (Removed 9) (Only critical) (Only dates moved > 5 d)
┌─────────┬────────────────────────────┬───────────────────────┬───────────────────────┬────────────┐
│ WBS     │ Task                        │ Was                   │ Now                   │ Progress   │
├─────────┼────────────────────────────┼───────────────────────┼───────────────────────┼────────────┤
│~1.2.3.2 │ Slab formwork L2            │ 15 Sep → 06 Oct       │ 22 Sep → 13 Oct  ▲+7 d│ 60 % kept  │
│~1.2.4   │ Level 3 (renamed)           │ "Level 3 frame"       │ "Level 3"             │ —          │
│+1.2.3.9 │ Additional shear wall W5    │                       │ 02 Nov → 12 Nov       │ needs link │
│−1.3.1.4 │ Temporary ramp              │ 01 Oct → 05 Oct       │ removed               │ 100 % ⚠    │
└─────────┴────────────────────────────┴───────────────────────┴───────────────────────┴────────────┘
⚠ 1 removed task has verified progress (ETB 42,000 earned). It will be kept as "Removed from schedule"
  so EV history doesn't drop.  [Show]
Baseline: (●) Keep current baseline   ( ) Take this file's baseline (Baseline changed in 214 tasks)
                                                   [◂ Back]  [Import revision D ▸] (primary)
```

- **Diff key**: task GUID → UID → (WBS + normalised name) as a last resort. Changed fields are dates, duration, name, parent (moved), critical flag, predecessors and baseline. Show the per-field old → new with `▲+7 d` in `--danger` text when finish slips, and `▼` in `--success` when it gains.
- **Progress preserved**: progress, mappings, constraints and commitments are keyed by our `schedule_tasks.id`, which is stable per GUID. A removed task is soft-deleted (`removed_at`) and stays in EV history and in the "Removed" filter.
- The import itself is **one RPC** `import_schedule_version(schedule_id, tasks jsonb, links jsonb, mappings jsonb, baseline_mode)`, posted in chunks of 500 to a staging table, then committed in a transaction. Toast: "Revision D imported · 46 new tasks need a BoQ link [Link now]".
- Version history lives in the Schedule page's `⋯ › Versions` drawer: list of imports, who and when, counts, and a download of the original file (Storage).

---

## 4. Module 2: Schedule views (web)

Route `/schedule` with a view switcher `Tabs variant="segmented"`: **Table · Gantt · Month** (Month = §8). State in `useHashTab`, filters in `useUrlFilters`.

### 4.1 Gantt view (split pane)

```
Schedule                                   Status date 30 Oct 2026 ▾   [⋯]  [Update progress] (primary → verification queue for office eng.)
BOLE-01 · Main schedule rev D · imported 28 Oct by Hana
(Table)(●Gantt)(Month)   [Search /] (My tasks) (This month ●) (Critical) (Late 37) (Not linked)  Block [All ▾]  Clear filters
Show: [✓ Baseline] [✓ Actual/forecast] [ Dependencies] [✓ Critical]   Zoom: (Day)(●Week)(Month)(Quarter)   [Today]
┌──────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────┐
│ WBS    Task                    %   Float │ Oct 2026                    │ Nov 2026                    ¦ (Ethiopian: ጥቅምት 2019 …)
│                                          │ 05   12   19   26   │ 02   09   16   23   30         │
├──────────────────────────────────────────┼─────────────────────┊──────────────────────────────────┤
│ 1.2    ▾ Superstructure        48%  0 d  │ ═══════════════════════╪═══════════════════════════════ │ summary bracket
│ 1.2.3  ▾ Level 2               62%  0 d  │ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀╪▀▀▀▀▀▀                           │
│ 1.2.3.2  Slab formwork  ⚑Crit  60%  0 d  │      ███████▓▓▓▓▓▓▓▓░░░░╪░░░        planned bar (60 % filled)
│                                          │   ───────────            ┊           baseline (thin grey, below)
│                                          │      ═══════════════════╪═════▶     actual→forecast (navy line)
│ 1.2.3.5  Blockwork L2   ⏱ 4 d late 0% 3 d│                   ░░░░░░╪░░░░░░░░░░                  │
│ 1.2.3.9  ◆ L2 slab pour            —   0 │                         ┊   ◆                        │ milestone
└──────────────────────────────────────────┴─────────────────────────┊──────────────────────────────┘
  2,960 tasks · 412 critical · 37 late                       amber today line ┊ · holidays/weekends shaded
```

**Bar encoding** (one row = 32 px desktop, 40 px "comfortable" density):

| Layer | Geometry | Colour token | Meaning |
|---|---|---|---|
| Planned (current schedule) | y+8, h 12, radius 3 | fill `--primary-soft`, stroke `--primary` 1 px; done portion fill `--primary` | Current plan. Filled width = verified % complete. |
| Critical | same bar | stroke `--danger` 1.5 px + `Flame` icon in the name cell | Shown when the Critical toggle is on. Never colour-only. |
| Baseline | y+23, h 4 | `--chart-planned` (grey), hatched via one `<pattern>` | Where it was supposed to be. |
| Actual → forecast | y+16 centre line 2 px, solid to status date, dashed after, arrowhead at forecast finish | `--text` solid / `--text-muted` dashed | Actual start → forecast finish = status date + remaining duration ÷ (performance factor, default 1). |
| Late flag | `Clock` icon + "4 d late" chip in the left pane | `--warning` / `--danger` > 7 d | Forecast finish > planned finish, or not started by planned start. |
| Summary | bracket (h 6 + end ticks) | `--text` | Roll-up. |
| Milestone | diamond 10 px | `--text`; done = `--success` | |
| Today / status date | 1.5 px vertical line + top label | `--accent` (amber) + "Today" label chip `--accent-fg` on `--accent` | The one amber element on the screen. Status date (if ≠ today) is a dashed `--primary` line labelled "Status date". |
| Weekends / holidays | column rects | `--surface-2` / `--accent-soft` + holiday name in the header tooltip | Day and week zoom only. |
| Dependencies | orthogonal 1 px path + 4 px arrow | `--border-strong`; critical links `--danger` | Off by default. With the toggle on, draw only links whose endpoints are both rendered. Off-screen endpoints get a short stub + `↗` hint. On hover or selection, highlight that task's chain. |

**Interactions** (read-only schedule):
- Row click or Enter opens the **task drawer** (`useUrlParam('peek')`). J/K and ↑/↓ move between rows (reuse DataTable's roving logic). ←/→ on a summary collapses or expands.
- Hovering a bar shows **one shared tooltip** element (not per bar): name, planned / baseline / forecast dates, % (verified · reported), float, variance "+6 d vs baseline".
- Horizontal: wheel + Shift, drag on the header, or the `Today` button. Zoom with Ctrl+wheel or buttons. Zoom keeps the date under the cursor fixed.
- `Collapse to level` menu (1–4). Remember expanded state per user in `localStorage` (try/catch).
- Print (A3 landscape) from `⋯ › Print`: render the current filter's visible rows unvirtualized up to 400 rows with a warning beyond that. Otherwise "Export Excel". This reuses `PrintHeader`.

**Filters** (chips, URL): *My tasks* (tasks mapped to elements in my blocks/levels, or tasks I committed to) · *This month* (overlaps the selected month) · *Critical* · *Late* (forecast finish > planned finish or start missed) · *Not started / In progress / Done* · *Not linked* · Block/Level (`FilterSelect` from `useLookups`) · *Changed in last import*. When a filter hides a child row, the ancestors stay as context rows in muted text so the tree never breaks.

### 4.2 Table view
`DataTable` (virtual, `viewKey="schedule"`) with columns WBS (id, sticky) · Task (indent) · Status (`Badge`: not_started / in_progress / completed / late) · Start · Finish · Baseline finish · Variance (d, right-aligned, danger if > 0) · % verified (`Bar`) · % reported (muted) · Float · Budget (price roles) · EV (price roles) · Linked to · Constraints (chips count). Exports to Excel. This is the "accessible fallback" of the Gantt.

### 4.3 Task detail drawer (`Drawer size="lg"`)

```
┌ 1.2.3.2 Slab formwork L2                                    ⚑ Critical   ✕ ┐
│ Block A › Superstructure › Level 2                                         │
│ ◯ 60 %  verified · 72 % reported (to verify)   Planned by today 85 %  ⏱ Behind│
│ ┌──────────┬──────────┬──────────┬──────────┐                               │
│ │ Planned  │ Baseline │ Forecast │ Float    │                               │
│ │ 22 Sep → │ 15 Sep → │ 22 Sep → │ 0 d      │                               │
│ │ 13 Oct   │ 06 Oct   │ 03 Nov ▲ │ critical │                               │
│ └──────────┴──────────┴──────────┴──────────┘                               │
│ Tabs: (Progress) (Materials) (Readiness 2) (Links) (History)                 │
│ Progress  — 30 Oct  Abebe  72 % · "Props for bay 3 missing" [photo×2] To verify [Verify][Adjust…]
│           — 23 Oct  Abebe  60 % · verified by Hana                           │
│ Materials — Plywood 18 mm  need 120 sh · in stock 40 · on PO-0031 (due 4 Nov) ⚠ short 80 [Request]
│ Readiness — ⛔ Materials: plywood short (owner Selam, due 3 Nov)  ✓ Drawings rev C issued
│ Links     — Pred: 1.2.3.1 Columns (FS)  · Succ: 1.2.3.9 L2 slab pour (FS+2d)
│ Money (price roles) — Budget ETB 1.40 M · EV 0.84 M · AC 0.95 M · CPI 0.88 ●   │
├─────────────────────────────────────────────────────────────────────────────┤
│ [Open in month view]                         [Request materials] [Verify 72 %]│
└─────────────────────────────────────────────────────────────────────────────┘
```

Reuses: `ProgressRing`-like SVG (web `Bar`), `Tabs`, `Attachments`, `Badge`, `approval/Previews.ProgressPreview` for the verify panel, `MrLifecycle` for linked MRs.

### 4.4 Mobile: schedule list (site engineer, office engineer)
The Progress tab gains a top `Segmented`: **Elements · Schedule**. Schedule = an agenda list, see §7.1. There is no Gantt on phones. A "View on computer" hint links the web route via share sheet.

---

## 5. Gantt implementation recommendation (custom SVG, virtualized)

**Component**: `web/src/components/gantt/Gantt.tsx` (lazy-loaded with the Schedule route). Pure TS, no new dependency beyond the existing `@tanstack/react-virtual`. Estimated 700–900 lines. Bundle ≈ 10–14 kB gz.

```
<Gantt
  rows={flatVisibleRows}           // pre-flattened, memoised: {id, depth, kind, start, finish, bStart, bFinish, aStart, fFinish, pct, critical, late}
  links?={links}                   // only when the toggle is on
  zoom="week" | "day" | "month" | "quarter"
  range={{ from, to }}             // project bounds ± 2 weeks
  statusDate today calendar={holidaySet} calendarSystem="gregorian"|"ethiopian"
  rowHeight={32} leftColumns={cols}  // left pane reuses Column<T> definitions
  activeId onOpen(id) onToggle(id)
/>
```

### 5.1 Structure

```
div.gantt (CSS grid: [left 420px resizable] [right 1fr]; one vertical scroll container)
 ├─ div.gantt-left   (position: sticky; left: 0)  → virtualized <div role="treegrid"> rows
 └─ div.gantt-right  (overflow-x: auto)
     ├─ svg.gantt-header (sticky top; 2 tiers: month / week-or-day; Ethiopian tier optional)
     └─ div.spacer (height = rows × rowH, width = days × pxPerDay)
         └─ svg.gantt-body (position: absolute; top = firstVisible × rowH; height = viewport + overscan)
              <defs> hatch pattern, arrow marker </defs>
              <g class="bg">   weekend/holiday rects for visible date columns only </g>
              <g class="bars"> one <g> per visible row (≤ ~40) </g>
              <g class="links"> visible links only </g>
              <line class="today"/>
```

- **One vertical virtualizer** (`useVirtualizer`, `estimateSize: () => rowH`, `overscan: 8`) drives both panes, so they cannot drift.
- **Horizontal windowing**: compute `visibleDays = [scrollLeft/pxPerDay − 30, (scrollLeft+width)/pxPerDay + 30]`. Background rects and header ticks render only for that window. Bars outside it get clipped or skipped.
- **Pre-compute geometry once** per (rows, zoom) in a `useMemo`: `x0/x1` for planned, baseline and actual as numbers in a typed array (`Float64Array`, 6 per row). Scrolling never touches dates. Date → x = `(dayIndex(date) − dayIndex(rangeFrom)) × pxPerDay`, where `dayIndex` = integer days since epoch (UTC, no `Date` allocation per frame).
- **Row component is memoised** with primitive props (`idx`, `y`, the geometry slice, flags). No inline lambdas: one delegated `onClick`/`onPointerMove` on the SVG reads `data-i`.
- **Tooltip**: a single absolutely-positioned div updated with `requestAnimationFrame`.
- **Tree flattening**: keep `children[]` index maps. Expanding or collapsing rebuilds `flatVisibleRows` in O(n) inside `startTransition`. Filtering keeps ancestors (see §4.1).
- **Dependencies**: index links by task. Render a link only if both rows are in the rendered window (or draw a stub). Path = `M x1 y1 h 6 V y2 H x2-4` (orthogonal, 3 commands). With 3,400 links, at most ~60 are drawn.
- **Critical path**: from the MS Project `Critical` flag (plus `TotalSlack ≤ 0` fallback). An optional in-house forward/backward pass (worker, Kahn's topological sort, O(n+e)) only when the file lacks flags.
- **Zoom px/day**: day 28, week 6, month 1.6, quarter 0.6. Header tiers: day → (month | day numbers), week → (month | ISO week start), month → (year | month), quarter → (year | quarter).
- **Ethiopian header**: an optional 3rd tier with Ethiopian month names (30-day months + Pagume), using the existing calendar helper (`formatEthiopian`) shared with mobile. Data stays Gregorian.
- **Accessibility**: the left pane is a `role="treegrid"` with `aria-level/aria-expanded` and the row text includes dates and status. The SVG is `aria-hidden` with the Table view as the accessible equivalent (same pattern as charts' "Table" toggle).
- **Theme**: all fills via CSS classes (`.bar-planned { fill: var(--primary-soft) }`), so dark mode and print need no JS.

### 5.2 Performance budget (mid laptop, Chrome; low-end = Celeron/4 GB)

| Metric | Target | How |
|---|---|---|
| Initial Gantt render, 3,000 tasks | < 300 ms (low-end < 800 ms) | Geometry memo O(n). Render ≈ 40 rows × ~6 nodes = ~250 nodes + ≤ 150 bg/header nodes. |
| DOM nodes in SVG at any time | ≤ 400 | Vertical and horizontal windowing. |
| Scroll frame | < 8 ms script | No React state per scroll pixel: virtualizer offset + rAF. Header translates with CSS transform. |
| Expand/collapse all | < 100 ms | O(n) flatten in a transition. |
| Import parse 3,000 tasks | < 2 s in worker | SAX scan, skip timephased/assignments. |
| Network | 1 query | `select` of the current-version tasks (≈ 3,000 × ~300 B ≈ 0.9 MB, ~180 kB gz). Cache `staleTime` 5 min. Links fetched only when toggled on. Progress/EV columns come from one view `v_task_status(project, status_date)`. |
| Memory | < 40 MB extra | Typed arrays for geometry, no per-bar closures. |

Don'ts: no `<foreignObject>`, no SVG filters/drop-shadows, no CSS transitions on bars, no per-bar `<title>`, no recharts inside the Gantt.

---

## 6. Module 3: Earned value dashboard (web; summary on mobile Home for managers)

Route `/schedule/evm` (tab "Earned value" in the Schedule section, gated to price roles). Recharts is lazy (reuse `charts/SCurve`, `chartTheme`, `ChartTooltip`).

### 6.1 Wireframe

```
Earned value                     Status date [30 Oct 2026 ▾]  Compare to [previous period ▾]   [Export][Print]
BOLE-01 · Cost basis: materials + other costs imported to 30 Sep · Period Oct 2026 · ✓ closed / ◐ open
┌─ In one sentence ──────────────────────────────────────────────────────────────────────────────┐
│ ● We are BEHIND schedule and OVER budget. We have done 0.88 birr of planned work for every       │
│   1 birr we planned by today, and earned 0.92 birr of work for every 1 birr spent.              │
│   If this continues the project will cost ETB 152.2 M (12.2 M more than budget).   [Why? ▸]      │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
┌────────────┐┌────────────┐┌────────────┐┌────────────┐┌────────────┐┌────────────┐
│ % complete ││ % planned  ││ Schedule   ││ Cost       ││ Forecast   ││ Over/under │
│  41.8 %    ││  47.5 %    ││ SPI 0.88   ││ CPI 0.92   ││ EAC 152.2 M││ VAC −12.2 M│
│ +3.1 pts   ││            ││ ⚠ Behind   ││ ⚠ Over     ││ budget 140 M│ ⛔ Over    │
│ this month ││            ││ −8.0 M SV  ││ −5.1 M CV  ││             ││ −8.7 %     │
└────────────┘└────────────┘└────────────┘└────────────┘└────────────┘└────────────┘
 Money: BAC 140.0 M · PV 66.5 M · EV 58.5 M · AC 63.6 M                       [More metrics: TCPI, EAC methods ▸]
┌─ S-curve (cumulative ETB) ───────────────────────────────────┐┌─ SPI & CPI by month ───────────────┐
│ M                                    ╱ PV (dashed grey)      ││ 1.10┤                               │
│ 140┤                              ╱ ·  ·  · forecast EAC     ││ 1.00┤━━━━━━━━━━━━━━━━━ (target)       │
│    │                         ╱ ·                              ││ 0.95┤┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ warning line   │
│    │                   ╱·──── AC (navy dotted)                ││ 0.90┤   ╲__CPI ╱‾‾╲                │
│    │             ╱ ───── EV (navy solid)                      ││ 0.85┤      ╲__SPI                   │
│  0 ┼──────┬──────┬────┊─┬──────┬──────┬──────                 ││     Jun Jul Aug Sep Oct             │
│     Jan   Mar   May  today Sep  Nov   2027                    ││ cumulative (solid) · monthly (thin) │
│ [Table]                                                       │└─────────────────────────────────────┘
└───────────────────────────────────────────────────────────────┘
┌─ By WBS  Level [1 ▾]  ──────────────────────────────────────────────────────────────────────────────────┐
│ WBS / name          Budget   % plan  % done   SPI          CPI           EAC       VAC        │
│ ▸ 1 Block A          62.0 M   52 %    46 %   ● 0.89 Behind ● 0.94 Over    66.0 M   −4.0 M     │
│ ▸ 2 Block B          48.0 M   41 %    40 %   ● 0.97 On track● 1.02 Under   47.1 M   +0.9 M     │
│ ▸ 3 External works   30.0 M   46 %    37 %   ● 0.80 Late   ● 0.85 Over    35.3 M   −5.3 M     │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
   Row click = drill down (breadcrumb "Project › Block A › Superstructure"); KPIs and charts re-scope.
```

### 6.2 Calculations (shown in "Why? ▸" drawer with the actual numbers)

| Metric | Formula | Source |
|---|---|---|
| BAC | Σ task budget (mapped BoQ/take-off cost) | `task_mappings` × rates |
| PV (BCWS) | Σ task budget × planned % at status date (linear over **baseline** working days, holidays excluded) | baseline dates + `project_calendar` |
| EV (BCWP) | Σ task budget × **verified** % complete | `progress_updates` verified/adjusted |
| AC (ACWP) | posted MIV cost to mapped elements + imported other costs ≤ status date | `stock_ledger`/MIV × price + `other_costs` |
| SV / CV | EV − PV / EV − AC | |
| SPI / CPI | EV ÷ PV / EV ÷ AC (cumulative from cumulative values, not an average of monthly indices) | |
| EAC (default) | BAC ÷ CPI | "typical": the current cost efficiency continues |
| EAC (alt.) | AC + (BAC − EV) | "atypical": the overrun so far was one-off |
| VAC | BAC − EAC | |
| TCPI | (BAC − EV) ÷ (BAC − AC) | efficiency needed on remaining work to finish on budget |
| % planned / % complete | PV ÷ BAC / EV ÷ BAC | |
| Forecast finish (schedule) | latest forecast finish of critical tasks (from Gantt forecast) | shown as "Forecast handover 14 Aug 2027 (+45 d)" |

Guard rails: when PV = 0 (before start) show "—" with "Work has not started yet". When AC = 0, CPI shows "—" with "No costs recorded yet". Coverage < 80 % shows a warning banner "Only 72 % of the budget is linked to schedule tasks. Numbers are partial. [Link tasks]". Computed in SQL: `evm_rollup(project, status_date, wbs_root)` returns the KPI row + per-child rows + monthly series. **Period close** freezes an `evm_snapshots` row per WBS level-2 node. Closed periods never change. Late verifications land in the next open period with a "late-verified" note.

### 6.3 Traffic-light thresholds (project setting, defaults)

| Index | ● Good (success) | ● Watch (warning) | ● Act (danger) |
|---|---|---|---|
| SPI, CPI | ≥ 0.98 → "On track" / "Under budget" if ≥ 1.02 | 0.90–0.98 → "Behind" / "Over" | < 0.90 → "Late" / "Well over" |
| VAC % of BAC | ≥ 0 | 0 to −5 % | < −5 % |
| Float (Gantt, critical) | > 5 d | 1–5 d | ≤ 0 d |

Each light is `Badge` = icon (`CheckCircle` / `AlertTriangle` / `OctagonAlert`) + word, never a bare dot. In the KPI card, only warning and danger colour the number (the existing `Kpi` rule). Thresholds are editable in Project setup › Workflow settings.

### 6.4 Plain-language copy (English + Amharic labels)

Amharic is a first draft for review by a native-speaking engineer before release. Keep the keys in `lib/i18n.ts` (web + mobile shared JSON). Use `{n}` placeholders and don't concatenate fragments.

| Key | English label | Amharic label | Plain sentence (EN) | Plain sentence (AM) |
|---|---|---|---|---|
| `evm.bac` | Total budget (BAC) | ጠቅላላ በጀት | The money planned for all the work. | ለሥራው በሙሉ የተመደበ ገንዘብ። |
| `evm.pv` | Planned work value (PV) | የታቀደ ሥራ ዋጋ | Work worth {pv} birr should be done by {date}. | እስከ {date} ድረስ {pv} ብር የሚያወጣ ሥራ መሠራት ነበረበት። |
| `evm.ev` | Earned work value (EV) | የተሠራ ሥራ ዋጋ | Work worth {ev} birr is actually done and verified. | {ev} ብር የሚያወጣ ሥራ ተሠርቶ ተረጋግጧል። |
| `evm.ac` | Actual cost (AC) | የወጣ ወጪ | We have spent {ac} birr so far. | እስካሁን {ac} ብር ወጪ አድርገናል። |
| `evm.spi` | Schedule index (SPI) | የጊዜ አፈጻጸም | For every 1 birr of work planned by today, we did {spi} birr. | ዛሬ ድረስ ለታቀደው እያንዳንዱ 1 ብር ሥራ {spi} ብር ሠርተናል። |
| `evm.cpi` | Cost index (CPI) | የወጪ አፈጻጸም | For every 1 birr spent, we earned {cpi} birr of work. | ለወጣው እያንዳንዱ 1 ብር {cpi} ብር የሚያወጣ ሥራ ሠርተናል። |
| `evm.sv` | Schedule gap (SV) | የጊዜ ልዩነት (በብር) | We are {sv} birr of work behind / ahead of plan. | ከዕቅዱ {sv} ብር የሚያወጣ ሥራ ወደኋላ / ወደፊት ነን። |
| `evm.cv` | Cost gap (CV) | የወጪ ልዩነት | The work done cost {cv} birr more / less than budgeted. | የተሠራው ሥራ ከበጀቱ {cv} ብር በላይ / በታች ወጪ አስወጥቷል። |
| `evm.eac` | Forecast final cost (EAC) | የመጨረሻ ወጪ ግምት | If we keep spending like this, the project will cost {eac} birr. | በዚህ ከቀጠልን ፕሮጀክቱ {eac} ብር ያስወጣል። |
| `evm.vac` | Forecast over/under (VAC) | የመጨረሻ ልዩነት ግምት | We expect to finish {vac} birr over / under budget. | ከበጀቱ {vac} ብር በላይ / በታች እንጨርሳለን ተብሎ ይጠበቃል። |
| `evm.tcpi` | Needed efficiency (TCPI) | የሚያስፈልግ አፈጻጸም | To finish on budget, each remaining birr must earn {tcpi} birr of work. | በበጀቱ ለመጨረስ የቀረው እያንዳንዱ ብር {tcpi} ብር ሥራ ማስገኘት አለበት። |
| `evm.pctPlanned` | % planned | የታቀደ % | By today {p} % of the work should be done. | እስከ ዛሬ {p}% ሥራ መጠናቀቅ ነበረበት። |
| `evm.pctComplete` | % complete | የተጠናቀቀ % | {p} % of the work is done and verified. | {p}% ሥራ ተጠናቅቆ ተረጋግጧል። |
| `evm.statusDate` | Status date | የሪፖርት ቀን | Numbers are measured up to this day. | ቁጥሮቹ እስከዚህ ቀን ድረስ ናቸው። |
| `evm.onTrack` / `behind` / `late` | On track / Behind / Late | በዕቅዱ መሠረት / ወደኋላ የቀረ / በጣም የዘገየ | | |
| `evm.under` / `over` / `wellOver` | Under budget / Over budget / Well over budget | ከበጀት በታች / ከበጀት በላይ / ከበጀት እጅግ በላይ | | |
| `sched.critical` | Critical | ወሳኝ | A delay here delays handover. | እዚህ መዘግየት ርክክቡን ያዘገያል። |
| `sched.float` | Float | ተጨማሪ ጊዜ (ፍሎት) | Days this task can slip without delaying handover. | ርክክቡን ሳያዘገይ ይህ ሥራ ሊዘገይ የሚችልበት ቀን። |
| `sched.baseline` | Baseline | መነሻ ዕቅድ | The original approved plan. | መጀመሪያ የጸደቀው ዕቅድ። |
| `sched.forecast` | Forecast finish | የሚጠበቅ ማጠናቀቂያ | | |
| `la.ready` / `blocked` | Ready / Blocked | ዝግጁ / ታግዷል | | |
| `la.materials` / `approval` / `drawing` / `inspection` | Materials / Approval / Drawings / Inspection | ዕቃዎች / ፈቃድ / ስዕሎች / ፍተሻ | | |
| `la.ppc` | Plan reliability (PPC) | የዕቅድ አፈጻጸም (PPC) | We finished {done} of {total} tasks we promised this week. | በዚህ ሳምንት ቃል ከገባናቸው {total} ሥራዎች {done} ጨርሰናል። |
| `pr.purchaseRequest` | Purchase request | የግዢ ጥያቄ | | |
| `pr.siteUse` | Site-use request | የሳይት አጠቃቀም ጥያቄ | | |
| `flow.waitingFor` | Waiting for {role} · {name} | {role} · {name} እየተጠበቀ ነው | | |
| `flow.yourTurn` | Your turn | የእርስዎ ተራ ነው | | |

Number formatting: `money()` with `M` / `K` compaction on cards ("ETB 152.2 M" / "152.2 ሚሊዮን ብር"), full value in the tooltip. Indices are always 2 decimals.

### 6.5 Mobile (manager / coordinator Home)
One `Card` "Project health" under "Needs you": two `KpiTile`s (Schedule: "Behind · 0.88" / Cost: "Over · 0.92") + the one-sentence summary + "Forecast ETB 152.2 M". Data is a synced `evm_snapshots` row. No chart on the phone.

---

## 7. Module 4: Progress update by role

### 7.1 Site engineer (mobile, offline)

The Progress tab › `Segmented` **Elements · Schedule**. Schedule shows a FlashList agenda of tasks that overlap this week and are mapped to my blocks/levels (or that I committed to), grouped by section headers.

```
┌ Progress ─────────────────────── [⇅2] [🔍]┐
│ (Elements) (●Schedule)                     │
│ (This week ●) (Today) (Late 3) (Next week) │ ChipGroup
│ Overdue · 3                                │ section header (danger)
│ ▌Blockwork L2              ⏱ 4 d late    › │ ListRow: stripe danger
│ ▌ ▓░░░░░░░░ 0 % · plan 30 %  Not updated 6 d│ ProgressBar with planned marker
│ This week · 28 Oct – 3 Nov                 │
│ ▌Slab formwork L2   ⚑ Critical ⛔ Material › │ chips: critical + constraint
│ ▌ ▓▓▓▓▓▓▓░░ 72 % · plan 85 % · To verify ⇡ │ SyncDot for queued
│ ▌Columns C1–C24 L3                        › │
│ ▌ ▓▓░░░░░░░ 20 % · plan 20 % ✓ On track    │
│ Next week                                  │
│ ▌L2 slab pour  ◆ 6 Nov                    › │
└────────────────────────────────────────────┘
```

Tap a row to open the **update sheet** (full-screen stack screen, extends `progress/[id].tsx`, spec §5.4):

```
┌ Slab formwork L2 ──────────────────── ✕ ┐
│ ◯ 72 %  plan 85 % · ⚠ Behind 13 %        │ ProgressRing + planned
│ How do you measure it?  (●Percent)(Quantity)│ Segmented (Quantity only if a qty mapping exists)
│ Percent  (25)(50)(75)(100)  [ − 75 + ]    │ QuantityStepper quick[] step 5
│   — or —  Quantity [ − 300 + ] m² of 410  │ QuantityStepper unit from BoQ, Fill chip = "All 410"
│ PHOTOS (1 required) [▣][＋]               │ PhotoStrip required={1}
│ Issue on site? (None●)(Materials)(Labour)  │ ChipGroup (adds a task_constraint when ≠ None)
│                (Weather)(Drawing)(Other…) │
│ Note (optional) ________________________  │ Field
│ Done this week as promised?  (Yes)(No)    │ only if task is in weekly commitments → PPC
├──────────────────────────────────────────┤
│ 72 % → 75 %                [Report ▸]     │ ActionBar primary variant="hero"
└──────────────────────────────────────────┘
```

- **Offline**: `enqueue('report_task_progress', { id, task_id, pct | qty, reason, note, commitment_done }, …)` → toast "Progress saved on phone". The row shows `SyncDot` + "To verify". Schedule tasks and mappings for the user's blocks sync down as a slim table (`schedule_tasks_mobile`: id, wbs, name, start, finish, b_finish, critical, pct_verified, pct_reported, block_id, level_id, has_qty, uom, qty_total). That is ≈ 3,000 rows × 120 B ≈ 360 kB. Filter to the user's blocks plus a ±6-week window to stay < 1,000 rows.
- **Element-mapped tasks**: if the task maps to elements, the sheet lists them (`ListRow` with `ProgressBar`) and routes to the existing element progress screen. The task % then rolls up. This avoids double reporting.
- **Speed target**: < 30 s per update. The list opens from SQLite in < 1 s.
- **Photo-first** shortcut: a camera icon on a row works the same way as in spec §5.4.

### 7.2 Office engineer (web): verification queue + period close

Inside `/approvals` (existing unified inbox), a tab **Progress (n)** shows schedule tasks and elements together. The list/preview split view reuses `ProgressPreview`.

```
Approvals  (Requests 7) (●Progress 23) (Purchase 4) (Adjustments 1) (Counts)
[Search /]  Block [A ▾] (Critical only) (Has photo) (Big jumps > 25 pts)        Status date 30 Oct
┌──┬──────────────────────────────┬──────────┬────────┬──────────┬───────┐ ┌ Preview ─────────────────────────┐
│☐ │ Task / element                │ By       │ Report │ Was→Now  │ Age   │ │ Slab formwork L2  ⚑ Critical     │
├──┼──────────────────────────────┼──────────┼────────┼──────────┼───────┤ │ Abebe · 30 Oct 09:12 · 📷 2       │
│☑ │ Slab formwork L2 ⚑            │ Abebe    │ 75 %   │ 60→75 %  │ 3 h   │ │ [photo][photo]                    │
│☑ │ Columns C1–C24 L3             │ Abebe    │ 20 %   │  0→20 %  │ 5 h   │ │ "Props for bay 3 missing"         │
│☐ │ Blockwork L2  ⚠ +60 pts jump  │ Dawit    │ 60 %   │  0→60 %  │ 1 d   │ │ Planned 85 % · Qty 300/410 m²     │
└──┴──────────────────────────────┴──────────┴────────┴──────────┴───────┘ │ Materials issued: plywood 96 sh   │
 2 selected ▸ [Verify 2]  [Return…]                                           │ ( ) Verify 75 %                   │
                                                                              │ ( ) Adjust to [ 70 ] % — comment* │
                                                                              │ [Return…]          [Verify ▸]     │
                                                                              └───────────────────────────────────┘
```

- **Bulk verify**: only rule-clean items are eligible (photo present when required, jump ≤ 25 pts, not a hold point). Otherwise the checkbox is disabled with a reason tooltip. The confirm dialog states the count ("Verify 2 progress reports?").
- **Adjust** requires a comment (`ReasonModal`-style inline field). It notifies the reporter: "Hana adjusted Slab formwork L2 to 70 % · 'bay 3 not formed'".
- **Sanity hints** in the preview: "Materials issued suggest ~65 %" (consumption vs take-off) and "Reported 75 % but no photo since 23 Oct".
- Keyboard: J/K, A = verify, R = return, X = select (existing inbox conventions).

**Period close** (coordinator / office engineer, `/schedule/evm` › `⋯ › Close period`):

```
┌ Close October 2026 ─────────────────────────────────────────── ✕ ┐
│ Status date 31 Oct 2026                                           │
│ ✓ 0 progress reports waiting to verify   (23 → [Open queue])  ⚠   │
│ ✓ Schedule imported after 25 Oct (rev D, 28 Oct)                  │
│ ⚠ Other costs imported up to 30 Sep only  [Import Oct costs]      │
│ ✓ Material issues posted (last MIV 31 Oct 16:40)                  │
│ Snapshot: BAC 140.0 M · PV 66.5 M · EV 58.5 M · AC 63.6 M         │
│ Once closed, October numbers are frozen. Late changes go to Nov.  │
│                                     [Cancel] [Close October ▸]    │
└───────────────────────────────────────────────────────────────────┘
```
Close is blocked (not just warned) while reports from before the status date are still unverified, unless the coordinator ticks "Close anyway (unverified reports move to November)".

---

## 8. Module 5: Monthly tasks window / look-ahead

Route `/schedule#month` (web). The mobile **Look-ahead** screen is reachable from Home "Needs you" and the Progress tab. This implements features.md B3 plus LPS make-ready.

### 8.1 Web: month calendar with task bars

```
Schedule › Month               [◂ Oct]  November 2026 / ጥቅምት–ኅዳር 2019  [Nov ▸]  (Gregorian●)(Ethiopian)   [Print A3]
(Table)(Gantt)(●Month)   (My tasks)(Critical)(Blocked 6)(Needs materials 9)   Block [A ▾]  Group by [Level ▾]
┌ Week ┬ Mon 2      Tue 3      Wed 4      Thu 5      Fri 6      Sat 7     Sun 8  ┬ PPC ────┐
│ W45  │ ▕Slab formwork L2 ⛔Mat ━━━━━━━━━━━━━━━━━▏                                │ wk 44:  │
│      │ ▕Columns C1–C24 L3 ✓Ready ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━→│ 7/10 70%│
│      │            ▕Blockwork L2 ⚠Insp ━━━━━━━━━━━━━━━━━━━━━━━━━━━━▏               │ ● Watch │
│      │                                  ◆ L2 slab pour                           │         │
├──────┼ Mon 9 ... Sat 14 (holiday-free) ...                                       ┼─────────┤
│ W46  │ ...                                                                       │ planned │
│      │ +4 more ▾                                                                 │ 12 tasks│
└──────┴───────────────────────────────────────────────────────────────────────────┴─────────┘
 Sun cols and holidays shaded (--surface-2 / --accent-soft + name "Meskel" in the day header)
┌ Material needs this month (from linked take-offs) ───────────────────────────────────────────────────────┐
│ Material            Need (Nov)  In stock  On order (PO, due)    Short   Needed by   Status         Action   │
│ Plywood 18 mm       220 sh      40        100 (PO-0031, 4 Nov)  80      3 Nov       ⛔ Short        [Raise purchase request] │
│ Cement OPC 42.5     1,240 bag   900       400 (PO-0035, 6 Nov)   0      2 Nov       ⚠ Arrives late  [Chase PO]               │
│ Rebar ø12           6.2 t       8.0 t     —                      0      5 Nov       ✓ Covered       [Request for site]       │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Layout**: weeks as rows (Mon–Sun, Ethiopian working week. Sunday is shaded but drawable, because sites often work Sundays). Each task is an absolutely positioned bar spanning its days within the week row (clipped with `→` / `←` continuation arrows), stacked in lanes (greedy interval packing, max 6 lanes, then "+N more ▾" expands the week). Bars are HTML `div`s (≤ 200 for a month) rather than SVG, so text wraps and truncates naturally.
- **Ethiopian calendar mode**: the grid follows the Ethiopian month (always 30 days; Pagume 5/6). The title shows both calendars. Day cells show the Gregorian date small under the Ethiopian day. This uses the shared conversion helper.
- **Holidays**: `project_calendar`, seeded from a national list. Lunar holidays (Eid al-Fitr, Eid al-Adha, Mawlid) are flagged `tentative` and get an outline "Tentative" chip. The coordinator confirms them. Seed for 2026/2027: Genna 7 Jan · Timket 19 Jan · Adwa 2 Mar · Eid al-Fitr 20 Mar 2026 / ~10 Mar 2027 · Siklet 10 Apr 2026 / 30 Apr 2027 · Fasika 12 Apr 2026 / 2 May 2027 · Labour Day 1 May · Patriots' 5 May · Eid al-Adha ~27 May 2026 / ~17 May 2027 · Derg Downfall 28 May · Mawlid ~26 Aug 2026 / ~15 Aug 2027 · Enkutatash 11 Sep 2026 / 12 Sep 2027 · Meskel 27 Sep 2026 / 28 Sep 2027 (verify yearly). Also show the "Kiremt" rainy season (Jun–Sep) as an optional background band for concrete/earthworks planning.
- **Readiness chips** on bars (LPS constraints). Each is icon + short word, worst-first:
  - `⛔ Mat` (materials short or PO late), from the material-needs calc automatically.
  - `⚠ Appr` (approval pending: MR/PR not approved), automatic from flows.
  - `⚠ Dwg` (drawing missing/outdated), manual constraint.
  - `⚠ Insp` (predecessor hold-point inspection not passed), automatic from C1 inspections.
  - `✓ Ready` when there are no open constraints.
  Hovering shows owner + due date. Click opens the task drawer's Readiness tab, where users add a constraint (kind, owner `PersonPicker`, due date, note) and clear it.
- **Material needs table** = (Σ mapped take-off qty of tasks active in the window × remaining %) − stock − open PO qty due before the need date − already-requested MR qty. Need date = task start − `lead_time_days` (per spec). Actions:
  - **Raise purchase request** (office engineer) opens the PR flow (§9) pre-filled with the short lines.
  - **Request for site** (site engineer) opens a look-ahead MR draft (`is_lookahead=true`) with lines and element split.
  - **Chase PO** opens the PO detail with the "Delivery update" action.
  One primary button only ("Raise purchase request" for the shortest line). Others are secondary.
- **PPC per week** (right rail): `done ÷ committed` for past weeks. For the current week, "7 of 10 so far". Click opens the **Weekly plan drawer**: list of tasks with checkbox "We commit to finish this week" (by the site engineer on Friday or Monday), result at week end, and reasons for misses (chips: Materials, Labour, Equipment, Weather, Drawing/design, Predecessor late, Approval, Other). There is a Pareto bar of miss reasons over 8 weeks (plain SVG bars, no recharts needed).
- **Print A3 landscape**, for the weekly site coordination meeting (Primavera Cloud prints its planning board for the same reason).

### 8.2 Mobile: look-ahead agenda

```
┌ Look-ahead ───────────────────── [⇅] [🔍]┐
│ (This week●)(Next week)(Month)  Block A ▾ │ ChipGroup
│ Plan reliability last week 7/10 · 70 % ⚠  │ caption + chip
│ ── Mon 2 Nov ──────────────────────────── │ sticky day header
│ ▌Slab formwork L2   ⛔ Materials       ›   │ ListRow + Chip
│ ▌ until Wed 4 · Plywood short 80 sh        │ subtitle = worst constraint, in words
│ ▌Columns C1–C24 L3  ✓ Ready            ›   │
│ ── Tue 3 Nov · Holiday? no ─────────────── │
│ ▌Blockwork L2  ⚠ Inspection           ›   │
│ ── Fri 6 Nov ──────────────────────────── │
│ ▌◆ L2 slab pour                        ›   │
│ Materials needed this week · 3 short      │ Section with action
│ [ Request materials for this week ]       │ Button hero (one per screen)
└───────────────────────────────────────────┘
```

- FlashList with mixed item types (`day-header` | `task` | `summary`), using `getItemType`. Memoised rows with primitive props.
- Multi-day tasks appear **on their start day** with "until Wed 4" (and under "Continuing" on later days, collapsed). This avoids repeating the row.
- The hero action "Request materials for this week" opens the existing New MR flow pre-filled from the week's shortages (site-use flow). The office engineer sees "Raise purchase request" instead.
- Holidays render as a day header with an `Icon` + name ("Meskel · public holiday").
- Tap a task to open the task detail screen: readiness list (each constraint as `InfoRow` with owner/due, "Clear" for the owner), materials (need / stock / on order), the "Commit for this week" `Segmented`, and "Update progress".

---

## 9. Module 6: Procurement flows visualised

### 9.1 The two flows

```
A. Purchase request (buy from supplier)           B. Site-use request (issue from store)
  1 Office engineer   Prepare & submit PR            1 Site engineer     Request materials (MR)
  2 Coordinator       Check need & budget            2 Office engineer   Review qty vs BoQ/look-ahead
  3 Management        Approve spend                  3 Coordinator       Approve
  4 Procurement       Source: RFQ → PO → delivery    4 Store keeper      Issue (MIV)
  5 Store keeper      Confirm receipt (GRN)          5 Site engineer     Confirm received (acknowledge MIV)
```

Status mapping (B reuses `mr_status` + MIV `pending_ack → acknowledged`). A is a new `purchase_requests.status`: `draft → submitted → checked → approved → sourcing (rfq) → ordered (po) → part_received → received → closed` plus `returned`, `rejected`, `cancelled`. Every transition writes `flow_events` (actor, role, at, comment), which drives the timeline. Approval value limits (BR-08 `approval_limits`) can skip Management for small PRs. In that case the step shows "Skipped · under ETB 50,000 limit".

### 9.2 `FlowTimeline` component (web) / `FlowSteps` (mobile)

This generalises the existing `Stepper` / `MrLifecycle`.

```ts
type FlowStep = {
  key: string; role: Role; label: string;            // "Coordinator · Check need & budget"
  state: 'done' | 'current' | 'waiting' | 'returned' | 'rejected' | 'skipped';
  actor?: string; at?: string; comment?: string;     // done/returned
  assignees?: string[];                              // current: who can act (names)
  since?: string; slaHours?: number;                 // current: age chip warning > sla, danger > 2×sla
  docs?: { label: string; to: string; status?: string }[]; // e.g. RFQ-0012, PO-0031, GRN-0044 (procurement step)
};
<FlowTimeline steps={steps} orientation="horizontal" | "vertical" compact? youRole />
```

Web, horizontal (detail page header; compact version in table rows):

```
 ✓ Office eng.  ──── ✓ Coordinator ──── ● Management ──── ○ Procurement ──── ○ Store
   Hana · 28 Oct      Selam · 29 Oct     Waiting 2 d ⚠       RFQ / PO           Confirm receipt
                                         Ato Bekele, W/ro Tigist
                                         [Approve ▸] (only if you are one of them)
```

Vertical (side panel on the detail page, and the mobile `FlowSteps`):

```
 ✓  Office engineer · Prepared        Hana T. · 28 Oct 10:12
 │   "For Nov slab L2–L3 (look-ahead)"
 ↺  Coordinator · Returned            Selam · 28 Oct 15:40  "Split cement by block"
 ✓  Office engineer · Resubmitted     Hana T. · 29 Oct 08:05
 ✓  Coordinator · Checked             Selam · 29 Oct 09:30
 ●  Management · Approve spend        WAITING FOR: Ato Bekele, W/ro Tigist · 2 d ⚠ (SLA 24 h)
 ○  Procurement · Buy                 RFQ-0012 (3 quotes) → PO-0031 → delivery 4 Nov
 ○  Store keeper · Confirm receipt
```

- States: `done` = `CheckCircle` success. `current` = filled navy dot with a pulsing ring (static in reduced-motion), bold label, "Waiting for…" line with names. `returned` = `Undo2` warning plus comment. `rejected` = danger. `skipped` = muted dashed connector with the reason. `waiting` = hollow circle muted.
- **"Your turn"** banner at the top of the detail when `youRole` matches the current step and you're in `assignees`: `Banner tone=accent-soft` "Your turn: approve this purchase request · waiting 2 d" with the single primary action on the right.
- Web table rows get a **compact** variant: 5 small dots + current role label, e.g. `●●◉○○ Management · 2 d`, with `aria-label` "Step 3 of 5, waiting for Management for 2 days".
- Mobile `FlowSteps`: vertical, 56 dp rows, `Text variant="bodySm"`, `StatusChip` per state, `ActionBar` with the step action when it is your turn.

### 9.3 Registers and "my action" inboxes

**Web** `/procurement/requests` (PR register) and the existing `/requests` (MR register) get a **Stage** column using the compact `FlowTimeline`, plus saved-view tabs:

```
Purchase requests                                                         [+ New purchase request]
(●Needs my action 4) (Waiting on others 11) (In purchase 6) (Received) (All)     [Search /] Stage [Any ▾]
┌──────────┬──────────────────────────────┬─────────────────────────┬─────────────┬──────────┬────────┐
│ PR       │ For                          │ Stage                   │ Waiting     │ Value    │ Need by│
├──────────┼──────────────────────────────┼─────────────────────────┼─────────────┼──────────┼────────┤
│ PR-0041  │ Plywood, cement · Nov slabs   │ ●●◉○○ Management       │ 2 d ⚠       │ 1.18 M   │ 3 Nov ⚠│
│ PR-0039  │ Rebar ø16 · L4 columns       │ ●●●◉○ Procurement · PO  │ 5 d         │ 2.40 M   │ 12 Nov │
└──────────┴──────────────────────────────┴─────────────────────────┴─────────────┴──────────┴────────┘
```

"Needs my action" per role, which also feeds the sidebar count via `nav_counts`:

| Role | Purchase-request flow (A) | Site-use flow (B) | Schedule items |
|---|---|---|---|
| Site engineer | — (sees PRs linked to their tasks, read-only) | Returned MRs to fix; MIVs to acknowledge | Tasks to update (not updated > 5 d); weekly commitments |
| Office engineer | Draft / returned PRs; shortages without a PR ("Raise PR" suggestions) | MRs to review | Progress to verify; tasks not linked; constraints they own |
| Coordinator | PRs to check | MRs to approve | Period close; constraints overdue |
| Management | PRs to approve (over limit) | MRs over limit (BR-08) | EVM red flags (SPI/CPI < 0.90) |
| Procurement | Approved PRs to source; POs with late delivery | — | — |
| Store keeper | Deliveries to receive against PO (confirm receipt) | Approved MRs to issue | — |

These are tabs inside `/approvals` (web) and the role's mobile Approvals / Review / Issue-queue tab. The list is sorted oldest-first, with "Need by" danger chips and the critical-task flag pinned to the top (the item feeds a critical-path task).

**Traceability chain** (task drawer › Materials, and PR/MR details): `Task ⚑ → shortage → PR-0041 → RFQ-0012 → PO-0031 → GRN-0044 → MR-0142 → MIV-0087 → acknowledged`. This renders as a horizontal chip chain (each chip is `Badge` with status, linked). It answers "is the plywood for the L2 slab coming?" in one glance.

**Mobile** (store keeper example: Issue-queue tab unchanged, new "Receive against PO" card in "Needs you"; site engineer: Requests tab cards show `FlowSteps compact` and "Waiting for Coordinator · 6 h").

```
┌ MR-0142 ───────────────────────── ⋯ ┐
│ [Approved] [Urgent]   ⇡ synced       │
│ ✓ You · Requested       Mon 09:10    │
│ ✓ Office eng · Reviewed  Mon 11:30   │
│ ✓ Coordinator · Approved Mon 14:05   │
│ ● Store · Issue          waiting 3 h │
│   Kebede (Store A)                   │
│ ○ You · Confirm received             │
│ LINES  Cement OPC 42.5 · 60 bag  …   │
├──────────────────────────────────────┤
│                 [Call store] [Remind]│ ActionBar (Remind = push to assignees, rate-limited)
└──────────────────────────────────────┘
```

---

## 10. Navigation placement

- **Web sidebar**: new group item **Schedule** (Operations), with tabs Gantt / Table / Month / Earned value / Import (palette entries "Schedule › Month", "Schedule › Earned value"). `G T` = schedule. The Progress page's S-curve moves to Earned value (keep a link). Procurement gets a **Purchase requests** tab.
- **Mobile**: no new bottom tab. Use the Progress tab's `Segmented` (Elements · Schedule), Home "Needs you" rows, a Look-ahead `ActionTile` for site/office engineers, and the Approvals/Review tab for PR steps.
- Role landing: the office engineer's Home hero becomes "Look-ahead" (already specified as the office hero, "Look-ahead request").

---

## 11. Implementation order

| # | Slice | Depends on | Size | Why this order |
|---|---|---|---|---|
| 1 | Data model + `project_calendar` seed (holidays) + `schedule_*` tables, RLS, `import_schedule_version` RPC | — | M | Everything reads these. |
| 2 | **Import wizard** (MSPDI worker parser, Excel via ImportWizard aliases, preview tree, confirm) without BoQ linking | 1 | M | Gets real schedules in early. Test with 2–3 real customer files (3k tasks). |
| 3 | **Table view + task drawer** (virtual DataTable tree) | 2 | S | Fastest useful view. Accessible baseline for the Gantt. |
| 4 | **Custom SVG Gantt** v1: planned + baseline + today + critical + zoom + filters (no links) | 3 | M | Main visual. Perf-test at 3,000 tasks on a low-end laptop. |
| 5 | **BoQ/element linking** step (auto-match cascade + manual drawer + coverage) | 2 | M | Unlocks budget, EV and material needs. |
| 6 | **Progress by task**: mobile Schedule agenda + update sheet (offline), web verification tab in `/approvals` + bulk verify | 5 | M | Feeds EV with verified data. Reuses existing progress plumbing. |
| 7 | **Re-import diff** (GUID-keyed, progress preserved, baseline choice) | 2, 6 | S–M | Needed by the 2nd month of real use. |
| 8 | **EVM dashboard** (`evm_rollup` SQL, KPI cards + sentence + S-curve + WBS drill-down) + thresholds setting + mobile health card | 5, 6 | M | Value is visible to management. |
| 9 | **Period close** + `evm_snapshots` + "other costs" import | 8 | S | Makes monthly reporting trustworthy. |
| 10 | **Month look-ahead** (web calendar + material needs + readiness chips + Ethiopian mode) and **mobile look-ahead agenda** | 5, 1 | M | Ties schedule to materials (the core product). |
| 11 | **Purchase request flow** (table, statuses, RPCs, `flow_events`) + `FlowTimeline`/`FlowSteps` + "Raise PR" from look-ahead + PR inbox tabs | 10, existing RFQ/PO | M | Closes the shortage → buy loop. |
| 12 | Retrofit `FlowTimeline` onto MR/MIV (site-use flow) + traceability chip chain + "Remind" | 11 | S | Mostly reuse. |
| 13 | Weekly commitments + PPC + miss-reason Pareto | 10, 6 | S | LPS reliability once teams use the look-ahead. |
| 14 | Gantt v2: dependency toggle, Ethiopian header tier, A3 print, forecast bars from performance factor | 4 | S | Polish. |

Acceptance checks per slice: 3,000-task import < 5 s end-to-end. Gantt scroll at 60 fps on an i3 / 4 GB laptop. Mobile agenda opens < 1 s on a 2 GB phone. EVM numbers reconcile with a hand-computed spreadsheet for one block. All strings in en + am. Every status is icon + text.

---

## 12. Open questions

1. **Cost basis for AC**: will customers import labour/plant/subcontract costs monthly (full EVM), or is materials-only EVM acceptable at first? (This decides the default `evm_cost_basis`.)
2. Do planners use MS Project custom fields (Text1…) for BoQ codes today? If yes, auto-match will reach > 80 % coverage. If no, provide a one-page "add a BoQ code column" guide.
3. Is P6 (XER) import needed? MSPDI covers MS Project and P6's MSP-XML export. XER would be a separate parser later.
4. Who signs period close: the coordinator alone, or manager approval as well? (This would add an approvable type to `/approvals`.)
5. Management PR approval limits per role/value: reuse `approval_limits` (BR-08) or a separate PR table?

---

## Sources

- Procore: [Scheduling: Create a Lookahead Schedule](https://v2.support.procore.com/product-manuals/scheduling-project/tutorials/scheduling-create-a-lookahead-schedule) · [View a Project Schedule](https://v2.support.procore.com/product-manuals/schedule-project/tutorials/view-a-project-schedule)
- Fieldwire: [How to schedule in Fieldwire like a pro](https://www.fieldwire.com/blog/how-to-schedule-in-fieldwire-like-a-pro/)
- Smartsheet: [Use baselines and critical path](https://help.smartsheet.com/learning-track/project-setup-and-configuration/use-baselines-and-critical-path) · [Set baselines on a sheet](https://help.smartsheet.com/articles/2482093) · [Community: baseline visual in Gantt](https://community.smartsheet.com/discussion/121791/baseline-visual-in-gantt-or-timeline-view)
- Asana / monday.com: [Everything you need to know about Asana's new Gantt view](https://cirface.com/blog/asana-gantt-view) · [ClickUp: monday.com Gantt review](https://clickup.com/learn/topic/project-management/tools/monday/gantt-charts/) · [ClickUp: Asana Gantt review](https://clickup.com/learn/topic/project-management/tools/features/gantt-charts/asana/)
- Microsoft: [What can you do with Project for the web?](https://support.microsoft.com/en-us/project/what-can-you-do-with-project-for-the-web) · [What is Planner Premium](https://sharepointmaven.com/what-is-planner-premium/) · [MSPDI: Task elements and XML structure](https://msdn2.microsoft.com/en-us/bb968475(v=office.12)) · [MSPDI: Project elements and XML structure](https://learn.microsoft.com/en-us/office-project/xml-data-interchange/project-elements-and-xml-structure) · [ExtendedAttribute elements](https://msdn.microsoft.com/en-us/library/bb968579.aspx)
- MS Project Excel export: [Touchplan: Export tickets from MS Project in xlsx](https://intercom.help/touchplanio/en/articles/10059476-export-tickets-from-ms-project-in-an-xlsx-format) · [Oracle P6 ↔ MS Project XML data map](https://docs.oracle.com/cd/F51301_01/English/Mapping_and_Schema/ms_project_import_export_data_map_xml/97946.htm)
- Oracle Primavera: [Managing your field schedule in Primavera Cloud](https://www.oracle.com/ce-help/primavera-cloud/tasks-getting-started/manage-field-schedule/) · [Task management product tour](https://www.oracle.com/construction-engineering/primavera-cloud-project-management/task-management-product-tour) · [Analytics: CPI/SPI section](https://docs.oracle.com/cd/F90226_01/English/user/analytics_ref/81949.htm) · [Earned Value section](https://docs.oracle.com/cd/F90226_01/English/user/analytics_ref/81942.htm) · [Portfolio analysis trending](https://docs.oracle.com/cd/G19667_01/English/user/analytics_ref/81921.htm) · [Cost & schedule performance index section](https://docs.oracle.com/cd/G49295_01/English/user/analytics_ref/81945.htm)
- Deltek: [Cobra](https://www.deltek.com/products/delivery-assurance/ppm/cobra/) · [What is EVM](https://www.deltek.com/resources/articles/evm-solutions-guide/) · [wInsight Analytics](https://www.deltek.com/products/delivery-assurance/ppm/winsight-analytics/)
- EVM formulas: [ProjectEngineer: guide to earned value formulas](https://www.projectengineer.net/guide-to-earned-value-formulas/) · [MPUG: Introduction to earned value formulas](https://www.mpug.com/introduction-to-earned-value-formulas) · [ProjectManagement.com: EVM formulas illustrated](https://www.projectmanagement.com/articles/340822/Earned-Value-Management-Formulas---Illustrated) · [Smartsheet EVM cheat sheet](https://smartsheet.com/sites/default/files/IC-Earned-Value-Management-Downloadable-Cheat-Sheet-Smartsheet.pdf)
- Last Planner / look-ahead: [Touchplan: make-ready planning](https://touchplan.io/blog/how-make-ready-planning-can-make-or-break-your-project) · [Touchplan: technology and constraint logs](https://touchplan.io/blog/technology-and-constraint-logs) · [Touchplan: Last Planner System and Touchplan](https://touchplan.io/blog/2015-10-last-planner-system-and-touchplan) · [LCI Lean Construction Planner standard work](https://leanconstruction.org/wp-content/uploads/2023/10/2023_LCI_LeanConstructionPlannerStandard-Work.pdf) · [Nialli: Last Planner System guide](https://www.nialli.com/blog/last-planner-system-guide) · [IGLC 2021 constraint categories paper](https://iglc.net/PAPERS/Details/1916) · [Ballard, PPI 2015](https://projectproduction.org/presentations/2015/2015-PPI-Ballard.pdf). vPlanner and LeanSight: no public documentation was retrievable, so the patterns are drawn from Touchplan/Nialli/Primavera Cloud, which cover the same LPS workflow.
- Field/mobile: [Outbuild field tracking](https://outbuild.com/field-tracking) · [Assignar mobile scheduling update](https://assignar.com/?p=14090)
- Gantt libraries: [DHTMLX licensing options](https://dhtmlx.com/blog/?p=15737) · [DHTMLX PRO features](https://dhtmlx.com/docs/products/dhtmlxGantt/pro-features.shtml) · [DHTMLX licences](https://dhtmlx.com/docs/products/licenses.shtml) · [SVAR React Gantt](https://svar.dev/react/gantt/) · [SVAR pricing/licences](https://svar.dev/react/gantt/pricing) · [Open-source MIT Gantt charts (DEV)](https://dev.to/victoria_k_31e331d766411d/open-source-mit-gantt-charts-for-javascript-react-angular-and-vue-1hd4) · [Webix: best free JS Gantt libraries](https://blog.webix.com/best-free-javascript-gantt-chart-libraries/) · [gantt-task-react on npm](https://www.npmjs.com/package/gantt-task-react) (registry metadata: v0.3.9, MIT, peer react ^18, published 2022-07) · [frappe-gantt 1.0.4 (cdnjs)](https://cdnjs.com/libraries/frappe-gantt/1.0.4) · [vis-timeline (yarn)](https://classic.yarnpkg.com/en/package/vis-timeline) · [vis timeline performance example](https://git.jrtechs.net/jrtechs/jrtechs-vis/src/branch/gemini/examples/timeline/other/performance.html) · [Syncfusion React Gantt performance benchmark](https://www.syncfusion.com/blogs/post/react-gantt-chart-performance-benchmark.md) · [Why your Angular Gantt lags at 10,000 tasks](https://dev.to/lenormor/why-your-angular-gantt-lags-at-10000-tasks-and-how-to-fix-it-548)
- Ethiopia: [timeanddate: Ethiopia holidays 2026](https://timeanddate.com/holidays/ethiopia/2026) · [timeanddate: 2027](https://www.timeanddate.com/holidays/ethiopia/2027) · [Calendarific Ethiopia 2026](https://calendarific.com/holidays/2026/et) · [Cost overrun & delay in Ethiopian building and road projects (Adv. Civ. Eng. 2021)](https://doaj.org/article/68700f77278746b380bad62df9086f23) · [Predicting EV indexes for Ethiopian public buildings (Cogent Eng. 2023)](https://doaj.org/article/7f609886e2fc45b6a3bcfd58a2ac5057) · [Delay causes, Debre Markos University projects](https://structurae.de/de/fachliteratur/fachartikel/causes-and-impacts-of-delays-in-ethiopian-public-construction-projects-case-on-debre-markos-university-construction-projects)
