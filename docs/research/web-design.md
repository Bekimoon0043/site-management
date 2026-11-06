# Site Console — Web Design & Performance Spec

Status: research output, implementation-ready · Date: 2026-10-29
Scope: `web/` (React 19 + Vite 8 + TypeScript, plain CSS variables, react-router 7, recharts 3, SheetJS)
Audience: whoever implements the next UI pass. Brand hex values are **placeholders**: the mobile design study owns the final palette; everything here references token *names* so the swap is one block of CSS.

---

## 0. What exists today (baseline)

Read from `web/src` before writing this:

| Area | Current state | Gap |
|---|---|---|
| Shell (`App.tsx`) | 210px flat sidebar of 11 links, top bar with `<select>` project switcher, user name, Sign out. Pages lazy-loaded. Mobile: hamburger toggles sidebar. | No grouping, no icons, no collapse, no search/command palette, no notifications, no breadcrumbs. Project switcher is a native select (not searchable, no recent). |
| Tokens (`index.css`) | ~20 vars: `--bg --surface --surface-2 --border --text --muted --accent --ok/-bg --info/-bg --warn/-bg --bad/-bg --radius --shadow`. Dark via `prefers-color-scheme` only. Orange `--accent` is used for primary buttons, links, active nav, focus ring and charts. | One colour doing five jobs. No spacing/type/density scale. No manual theme toggle. Focus ring = accent (orange on white ≈ 3.9:1 — OK for non-text, but conflated with "brand"). |
| Table (`DataTable` in `ui.tsx`) | Client-side sort (click header), 50-row pages, Excel export, print-all on `beforeprint`, `th` sticky, row click. | No `aria-sort`, header not a button (not keyboard-sortable), no selection/bulk actions, no column visibility, no density toggle, sticky header only sticks inside page scroll (not inside `.table-scroll`), no skeleton, no filter-vs-empty distinction, no virtualization. |
| Data (`useAsync`, `useLookups`) | Hand-rolled hook, no cache except lookups. `Materials` refetches on every tab switch (`deps: [tab]`). Dashboard fires 11 queries + `fetchAll` of the whole `v_element_consumption` view to compute counts client-side. Store tabs each `fetchAll` full history. | No stale-while-revalidate, no dedupe, refetch on every mount; large payloads for counts. |
| Modal | Custom div with Esc handler, `role=dialog aria-modal`. | No focus trap / focus return, background not inert. Replace with native `<dialog>`. |
| Import (`ImportWizard`) | Template download → file → validated preview (errors per row) → commit valid rows. | No column mapping, no "errors only" filter, no downloadable error report, three importers stacked on one page. |
| Charts | One recharts `LineChart` (S-curve) using `var(--accent)` / `var(--muted)`. | No shared chart theme / tooltip component. |
| Print | `@media print` hides chrome; DataTable prints all rows. | No `@page`, no repeating `thead`, no report header/footer block, no company logo. |

The foundation is sound (lazy routes, xlsx lazy-imported, URL-hash tabs, tabular-nums). The plan below **evolves** it — no framework swap.

---

## 1. Layout & navigation

### 1.1 App shell

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ▣ ACME Construction  │ [BOLE-01 · Bole Apartments ▾] │ [⌕ Search or jump…  Ctrl K] │ 🔔3  (MA) ▾ │  48px top bar
├──────────────┬─────────────────────────────────────────────────────────────────────┤
│ ◧ (collapse) │  Requests / MR-BOLE-0142                                ← breadcrumb │
│              │  ┌───────────────────────────────────────────────────────────────┐  │
│ OVERVIEW     │  │ Page title                         [secondary] [Primary ▸]    │  │ page header
│  ⌂ Dashboard │  └───────────────────────────────────────────────────────────────┘  │
│  ✓ Approvals 7│                                                                    │
│ OPERATIONS   │   page content (max-width 1440, fluid for registers)                │
│  ⇄ Requests  │                                                                     │
│  ▦ Store     │                                                                     │
│  ▲ Progress  │                                                                     │
│ DATA         │                                                                     │
│  ⧉ Elements & BoQ                                                                  │
│  ◫ Materials │                                                                     │
│  ▤ Reports   │                                                                     │
│ ADMIN        │                                                                     │
│  ⚙ Project setup                                                                   │
│  ☺ Users     │                                                                     │
│  ⚑ Settings  │                                                                     │
│  ☰ Audit log │                                                                     │
│──────────────│                                                                     │
│ ☾ Theme  ?   │                                                                     │
└──────────────┴─────────────────────────────────────────────────────────────────────┘
  232px expanded / 56px collapsed (icons + tooltip); <860px = off-canvas drawer
```

Decisions:

- **Top bar (48px, sticky):** company mark · **project switcher** (button opening a searchable popover — code + name, "Recent" group, "All projects" link to Setup; shortcut **`G P`** or the command palette "Switch project" — not `Ctrl+P`, which is browser print) · **search/command trigger** (looks like an input, shows `Ctrl K`) · **notifications bell** with unread count · **avatar menu** (name, role label, theme: System/Light/Dark, Sign out). Remove the separate always-visible "Sign out" button.
- **Sidebar groups** (labels 11px uppercase, `--text-muted`): Overview / Operations / Data / Admin. Items carry an icon (16px) and an optional right-aligned **count pill** (pending approvals, items to verify). Items the role cannot use are **hidden**, not disabled (current behaviour — keep). A group with zero visible items disappears.
- **Collapse:** toggle at top of sidebar; state in `localStorage` (`sc.sidebar=collapsed`), wrap in try/catch. Collapsed = 56px icon rail with `title`/tooltip. Sidebar is visually quieter than content (Linear's 2026 refresh dims the sidebar so content stands out): background `--surface-2`, inactive text `--text-muted`, active item `--surface` bg + `--text` + 2px left bar in `--accent`.
- **Breadcrumbs** only on detail/second-level routes (`Requests / MR-…`, `Store / GRN-…`, `Reports / Approval ageing`). Single line, never wraps, truncates the middle. Flat top-level pages show just the title (NN/g: breadcrumbs augment, never replace, primary nav; don't use on flat levels).
- **Page header:** title (20px/600), optional subtitle (13px muted, one line), right-aligned actions: at most **one primary** button; others secondary; overflow (`⋯`) for rare actions (Print, Export, Clone). Sticky under the top bar on register pages so actions/filters stay reachable.
- **Content width:** registers/tables are fluid (min 0, no max). Forms, detail pages and settings cap at 1200px. Dashboards cap at 1600px.
- **Mobile (<860px):** sidebar becomes a `<dialog>`-based drawer; top bar keeps project switcher + search icon + bell + avatar. Tables scroll horizontally with first column sticky.

### 1.2 Sidebar per role

`P` = visible. Counts are badges driven by one `nav_counts` RPC (see §5).

| Item (group) | Coord. | Manager | Procurement | Office eng. | Admin | Site eng./Store keeper (web, if used) |
|---|---|---|---|---|---|---|
| Dashboard (Overview) | P | P | P | P | P | P |
| **Approvals** inbox (Overview) — new | P (MR, adj, counts, progress) | P | – | P (review MR, verify progress) | P | – |
| Requests (Ops) | P | P | P (all, read + sourcing later) | P | P | P (own) |
| Store (Ops) | P | P | P (read) | P (read, acknowledge) | P | P |
| Progress (Ops) | P | P | – | P | P | P |
| Elements & BoQ (Data) | P | P | – | P | P | – |
| Materials & suppliers (Data) | P | P | P (prices, suppliers) | P | P | – |
| Reports (Data) | P | P | P | P | P | – |
| Project setup (Admin) | P | P | – | – | P | – |
| Users / Settings (Admin) | – | – | – | – | P (gate `users.manage`) | – |
| Audit log (Admin) | gate `audit.view` | gate | – | – | P | – |

Default landing page per role: coordinator/manager → Dashboard; office engineer → Approvals; procurement → Requests filtered `status=approved`; admin → Dashboard.

### 1.3 Command palette (Ctrl/⌘ K) & global search

One modal (`<dialog>`), 640px wide, input at top, grouped results, ↑/↓ moves, Enter runs, Esc closes. Groups in this order, context-ranked (Linear prioritises groups by current view):

1. **Go to** — every nav item (+ every tab: "Store › Bin card", "Progress › S-curve") built from the same `NAV` config.
2. **Actions** — "New material request", "Switch project…", "Import elements", "Export current table", "Toggle dark mode". Filter by `auth.can()`.
3. **Records** — debounced (200 ms) server search when the query looks like a doc number (`/^(MR|GRN|MIV|MRN|ADJ|TR)[-\s]?/i`) or ≥3 chars: MR/GRN/MIV numbers, element codes, materials, suppliers. One RPC `search_everything(project_id, q, limit 5 per type)` — don't fan out 6 PostgREST calls.
4. **Recent** (empty query) — last 8 visited records from `localStorage`.

Implementation: **`cmdk`** (unstyled, ~accessible combobox semantics) *or* hand-rolled (~150 lines: input + listbox with `aria-activedescendant`). Recommend `cmdk` only if we want fuzzy ranking for free; otherwise hand-roll — the item set is < 100 static entries.

Global keyboard shortcuts (shown in palette and `?` overlay): `Ctrl K` palette · `G D` dashboard · `G A` approvals · `G R` requests · `G S` store · `/` focus table search · `J/K` next/prev row in lists · `Enter` open · `A` approve / `R` return / `X` select (inbox only) · `Esc` close panel. Never bind single letters while focus is in an input.

### 1.4 Notifications

Bell → 360px popover (not a page). Tabs: **For me** (action required: approve, verify, acknowledge) / **All**. Each item: icon by type, one-line sentence ("Abebe submitted MR-BOLE-0142 · 3 lines · urgent"), relative time, unread dot. Click = navigate + mark read. "Mark all read". Source: existing in-app notifications table (FR-NT-01); poll every 60 s while the tab is visible (`document.visibilityState`) or Supabase Realtime on the user's notification rows. Action-required items also roll into the Approvals count — the bell is the stream, Approvals is the to-do list.

### 1.5 Wireframes

**Dashboard** (role-aware; manager shown)

```
Dashboard                                           Period: [Last 7 days ▾]  [⟳ 2 min ago]
BOLE-01 · Bole Apartments
┌─ NEEDS ATTENTION (sorted by severity) ───────────────────────────────────────────────┐
│ ● 3 emergency issues > 24 h not regularised (BR-01)                    Review →     │
│ ● 7 requests waiting for approval · oldest 52 h · 2 critical            Open inbox →│
│ ▲ 12 items at/below reorder level                                       View →      │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────┐┌──────────────┐┌──────────────┐┌──────────────┐┌──────────────┐
│Overall prog. ││Delayed elems ││Pending appr. ││Low stock     ││Variance alrts│  5 primary KPIs
│ 46.2 %       ││ 14           ││ 7            ││ 12           ││ 5            │  value 28px
│ ▲ 3.1 pts wk ││ ▲ 2 vs last wk││ oldest 52 h  ││ ▼ 3 vs last wk││ ▲ 1          │  delta + window
│ ╱╲_╱‾‾ spark ││ ‾╲_╱‾ spark  ││              ││ spark        ││              │
└──────────────┘└──────────────┘└──────────────┘└──────────────┘└──────────────┘
 Secondary counters (compact row, 13px): Adjustments 2 · Counts 1 · To verify 9 · Awaiting receipt 4 · Wastage write-offs 6 · Issued cost ETB 4.2 M (61 % of take-off)
┌─ Progress: planned vs actual (S-curve) ────────┐┌─ Progress by block ───────────────────┐
│  100%│              ..--‾‾                    ││ Block  Elems  Done  Delayed  Progress │
│      │        ..--‾‾  __/                     ││ A       120    48      3    ████░ 52% │
│      │  ..--‾‾  ___/                          ││ B        96    30      6    ███░░ 38% │
│    0 └──────────────────────── time           ││ ...                                    │
│  — planned (dashed)  — actual verified         ││                                Details→│
└────────────────────────────────────────────────┘└────────────────────────────────────────┘
┌─ Approvals ageing (by bucket) ─────────────────┐┌─ Consumption variance (top 10) ───────┐
│ <24h ████████ 4   24–48h ██ 1   >48h ███ 2     ││ Element  Material  Earned Issued Var% │
└────────────────────────────────────────────────┘└────────────────────────────────────────┘
```

**List / register page** (Requests; same template for GRN/MIV/MRN/Elements/Audit)

```
Material requests                                    [Export ▾] [+ New request]
[ All 214 | Needs my action 7 | Urgent 5 | Approved, not issued 18 | My drafts 2 | + Save view ]  ← saved-view tabs
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [⌕ Search MR no., purpose…  /]  [Status: Submitted, Reviewed ×] [Block ▾] [+ Filter] │ ← filter chips
│  Clear filters                                   214 results · [≡ Density] [▥ Columns]│
├──┬───────────┬────────┬──────────┬───────┬──────────────┬────────────┬────────┬──────┤
│☐ │MR ▲       │Status  │Priority  │Block  │Requested by  │Required    │Lines   │  ⋯   │ ← sticky header
├──┼───────────┼────────┼──────────┼───────┼──────────────┼────────────┼────────┼──────┤
│☐ │MR-BOLE-142│●Submit.│▲Critical │A      │Abebe K.      │02 Nov  (3d)│     3  │  ⋯   │ 36px rows
│☑ │MR-BOLE-141│●Review.│ Normal   │B      │Sara T.       │04 Nov      │     1  │  ⋯   │
├──┴───────────┴────────┴──────────┴───────┴──────────────┴────────────┴────────┴──────┤
│ ┌ 2 selected · [Approve] [Return] [Export selected]  Clear ┐  ← floating bulk bar      │
│                                           Rows 1–50 of 214   ‹ 1 2 3 4 5 ›           │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Detail page** (Material request; same template for GRN/MIV/Element)

```
Requests / MR-BOLE-0142
MR-BOLE-0142  [● Submitted] [▲ Critical]                 [Return] [Reject] [Approve… ▸] [⋯]
Raised 29 Oct 09:14 by Abebe K. · Block A / L3 · required 02 Nov (in 3 days)
┌─ Main (2/3) ────────────────────────────────────────────┐┌─ Side panel (1/3) ──────────┐
│ ⚠ Line 2 exceeds BoQ by 8 % — reason: "slab redesign"   ││ Details                     │
│ Lines                                                   ││ Purpose  Slab L3 pour       │
│ # Material      Elements  Req.  Stock  BoQ bal.  Appr.  ││ Store    Main store         │
│ 1 C-25 concrete  S-A3-01   24 m³  —     30 m³     [24]  ││ Look-ahead  yes             │
│ 2 S-400 Ø16      S-A3-01   1.2 t  0.8 t ⚠ -0.1 t  [1.1] ││ Attachments (2) 📎          │
│ ...                                                     │├─ Activity ──────────────────┤
│ Issues against this request                             ││ ● Submitted  Abebe · 2 h    │
│ MIV-BOLE-0310  29 Oct  ● Pending ack  12 m³             ││ ○ Created    Abebe · 3 h    │
└─────────────────────────────────────────────────────────┘│ [Add comment…]              │
                                                           └─────────────────────────────┘
```

**Approval inbox** (new route `/approvals`; split view)

```
Approvals                           [Requests 7] [Adjustments 2] [Counts 1] [Progress 9] [All 19]
┌─ Queue (380px) ──────────────────┐┌─ Preview ────────────────────────────────────────────┐
│ ☐ Select all   Sort: Oldest ▾    ││ MR-BOLE-0142 · Critical · waiting 52 h               │
│──────────────────────────────────││ Abebe K. · Block A / L3 · required 02 Nov            │
│▌☐ MR-BOLE-0142        52 h ▲Crit ││──────────────────────────────────────────────────────│
│   C-25 24 m³ +2 lines · Blk A    ││ Lines with stock / BoQ balance (editable approved qty)│
│ ☐ ADJ-BOLE-0031       30 h       ││ ⚠ Line 2 over BoQ                                     │
│   Wastage · 3 lines · Main store ││                                                      │
│ ☐ PRG S-A3-01 Slab rebar  20 h   ││ Comment (required to return/reject) [............]  │
│   Reported 60 % → verify         ││                                                      │
│ ...                              ││ [R Return]  [Reject]          [A Approve ▸] (sticky) │
│ ┌ 3 selected [Approve 3] ┐        ││ After action → next item auto-loads, toast "Undo"    │
└──────────────────────────────────┘└──────────────────────────────────────────────────────┘
```

**Import wizard** (Elements & BoQ › Import; Materials › Import)

```
Import structural elements                                         Step 2 of 4
 (1 Upload) ─── (2 Map columns) ─── (3 Review & fix) ─── (4 Done)
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ File: elements-blockA.xlsx · Sheet [Sheet1 ▾] · Header row [1 ▾] · 342 data rows     │
│ Your column          →  Field                 Sample values             Status        │
│ "Element ID"         →  [Element ID *    ▾]   C-A1-01, C-A1-02          ✓ auto       │
│ "Type"               →  [Type *          ▾]   column, column            ✓ auto       │
│ "Blk"                →  [Block           ▾]   A, A                      ✓ alias      │
│ "Remarks"            →  [— Ignore —      ▾]   …                                       │
│ (missing)               Planned finish         —                         optional      │
│ [ ] Remember this mapping for next time                    [Back] [Validate 342 rows ▸]│
└──────────────────────────────────────────────────────────────────────────────────────┘
Step 3:  ✓ 330 ready   ✕ 12 errors   ⚠ 4 warnings (duplicates will update)   [Errors only ☑]
         Row  Element ID  Type    Block  Issue
         17   C-A1-17     colum   A      ✕ Type "colum" not recognised — did you mean "column"?
         [Download error report (.xlsx)]          [Back]  [Import 330 rows, skip 12 ▸]
```

**Report page**

```
Reports
┌─ Report list (240px) ──────┐┌───────────────────────────────────────────────────────────┐
│ REQUESTS                   ││ Approval ageing                       [Excel] [Print/PDF] │
│  MR register               ││ Requests waiting for review/approval, oldest first        │
│ ▌Approval ageing           ││ [Block ▾] [From – To] [User ▾]   Clear                     │
│ STORE                      ││ ┌ summary strip: 19 waiting · median 20 h · max 52 h ┐    │
│  GRN register · Ledger ... ││ table (all rows, virtualized on screen; full on print)    │
│ PROGRESS / COST            ││                                                           │
│  Consumption · Cost ...    ││                                                           │
└────────────────────────────┘└───────────────────────────────────────────────────────────┘
Print layout (A4 landscape):
┌──────────────────────────────────────────────────────────────────────────────┐
│ [logo] ACME Construction            APPROVAL AGEING             Page 1 of 3 │ repeated header
│ Project BOLE-01 · Filters: Block A · 01–29 Oct 2026 · Printed 29 Oct 14:02   │
│ ─ table, thead repeats each page, rows never split ─                          │
│ Prepared by ______  Checked by ______  Approved by ______                    │ last page only
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Visual system

### 2.1 Tokens (names are the contract; values are the swappable default)

Rename map from today: `--muted → --text-muted`, `--ok → --success`, `--warn → --warning`, `--bad → --danger`, `--accent (as action colour) → --primary`. Keep old names as aliases for one release (`--muted: var(--text-muted);`) so pages keep working while they're migrated.

```css
:root {
  /* ── Surfaces & lines ── */
  --bg:             #f5f6f8;   /* app background */
  --surface:        #ffffff;   /* cards, tables, panels */
  --surface-2:      #eef1f5;   /* sidebar, table header, subtle fills */
  --surface-3:      #e3e7ee;   /* hover / selected row */
  --border:         #dfe3e9;   /* dividers, card borders (decorative) */
  --border-strong:  #8a93a3;   /* input/checkbox borders — 3.1:1 on white (WCAG 1.4.11) */
  /* ── Text ── */
  --text:           #141a24;   /* 17.5:1 on surface */
  --text-muted:     #5b6576;   /* 5.9:1 on surface, 5.2:1 on surface-2 */
  --text-subtle:    #8a93a3;   /* placeholders/disabled only (3.1:1) — never for content */
  /* ── Brand ── */
  --primary:        #2f3fb0;   /* deep indigo: primary buttons, links, selection, focus */
  --primary-hover:  #26339a;
  --primary-fg:     #ffffff;   /* 8.5:1 on primary */
  --primary-soft:   #e9ecfb;   /* selected row, active filter chip */
  --accent:         #f59e0b;   /* safety amber: brand marks, active-nav bar, "needs attention" highlights */
  --accent-fg:      #1a1203;   /* text ON amber — 8.6:1 (never white on amber) */
  --accent-soft:    #fff4dc;
  /* ── Status (text colour / soft background pairs, all ≥4.5:1) ── */
  --success: #137a3a;  --success-soft: #e7f6ec;
  --warning: #a35207;  --warning-soft: #fef3c7;
  --danger:  #c62828;  --danger-soft:  #fdecec;
  --info:    #0e7490;  --info-soft:    #e0f4f8;   /* teal, deliberately ≠ primary indigo */
  --neutral: #5b6576;  --neutral-soft: #eceff3;
  /* ── Focus ── */
  --focus-ring: 0 0 0 2px var(--surface), 0 0 0 4px var(--primary);
  /* ── Charts (see 2.6) ── */
  --chart-1: #2a78d6; --chart-2: #eb6834; --chart-3: #1baf7a; --chart-4: #eda100;
  --chart-5: #e87ba4; --chart-6: #008300; --chart-7: #6250d6; --chart-8: #e34948;
  --chart-grid: #e6e9ee; --chart-axis: var(--text-muted); --chart-planned: #8a93a3;
  /* ── Type ── */
  --font-sans: 'Inter Variable', Inter, system-ui, 'Segoe UI', Roboto, 'Noto Sans Ethiopic', sans-serif;
  --font-mono: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  --fs-xs: 11px; --fs-sm: 12px; --fs-base: 13px; --fs-md: 14px; --fs-lg: 16px; --fs-xl: 20px; --fs-2xl: 28px;
  --lh-tight: 1.25; --lh: 1.45;
  --fw-regular: 400; --fw-medium: 500; --fw-semibold: 600;
  /* ── Space (4px base) ── */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px; --sp-8: 32px; --sp-10: 40px;
  /* ── Radii ── */
  --radius-sm: 4px;  /* badges, checkboxes, chips */
  --radius:    6px;  /* inputs, buttons */
  --radius-lg: 10px; /* cards, panels, dialogs */
  --radius-full: 999px;
  /* ── Elevation ── */
  --shadow-1: 0 1px 2px rgb(16 24 40 / .06);                         /* cards (optional; border does most work) */
  --shadow-2: 0 4px 12px rgb(16 24 40 / .08), 0 1px 3px rgb(16 24 40 / .06); /* popovers, menus, bulk bar */
  --shadow-3: 0 16px 48px rgb(16 24 40 / .18);                       /* dialogs, drawers */
  /* ── Density (overridden by [data-density]) ── */
  --row-h: 36px; --cell-px: 12px; --control-h: 34px;
  /* ── Layout ── */
  --topbar-h: 48px; --sidebar-w: 232px; --sidebar-w-collapsed: 56px;
  --z-sticky: 10; --z-drawer: 40; --z-popover: 50; --z-toast: 60;
  color-scheme: light;
}
```

Dark values (declared twice: under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and under `:root[data-theme="dark"] {…}` so a manual toggle wins both ways):

```css
  --bg: #0e1117; --surface: #151a22; --surface-2: #1b212b; --surface-3: #232b37;
  --border: #2a323e; --border-strong: #5f6b7e;              /* 3.2:1 on surface */
  --text: #e6e9ef; --text-muted: #9aa4b5; --text-subtle: #6b7587;
  --primary: #8b9cff; --primary-hover: #a3b1ff; --primary-fg: #0b0f2a; --primary-soft: #1e2550;
  --accent: #fbbf24; --accent-fg: #1a1203; --accent-soft: #2e2410;
  --success: #4ade80; --success-soft: #12291c;
  --warning: #fbbf24; --warning-soft: #2e2410;
  --danger:  #f87171; --danger-soft:  #341618;
  --info:    #67d3e8; --info-soft:    #0f2a31;
  --neutral: #9aa4b5; --neutral-soft: #232b37;
  --chart-1: #3987e5; --chart-2: #d95926; --chart-3: #199e70; --chart-4: #c98500;
  --chart-5: #d55181; --chart-6: #008300; --chart-7: #9085e9; --chart-8: #e66767;
  --chart-grid: #232b37; --chart-planned: #6b7587;
  --shadow-1: none; --shadow-2: 0 4px 16px rgb(0 0 0 / .5); --shadow-3: 0 16px 48px rgb(0 0 0 / .6);
  color-scheme: dark;
```

All text/soft-bg pairs above were computed: light ≥4.49–17.5:1, dark ≥5.9:1 (success-on-soft adjusted to `#137a3a` to clear 4.5). Re-run contrast when the mobile study's brand hexes arrive; only the token block changes.

**Amber vs warning.** Amber `--accent` and `--warning` share a hue family on purpose (amber = caution on site), so: `--accent` is never used *inside* tables/badges/charts; status always ships with an icon + text label; "needs attention" strip uses `--accent-soft` bg with `--text` copy.

### 2.2 Typography — Inter

- Self-host `@fontsource-variable/inter` (one woff2, all weights, `font-display: swap`); fallback stack keeps `Noto Sans Ethiopic` for Amharic names.
- Globally: `font-feature-settings: 'cv11', 'ss01'` optional (taste); **mandatory** on numeric UI: `font-variant-numeric: tabular-nums` on `table, .kpi-value, .num` (Inter does not enable tnum by default). Add `'zero'` (slashed zero) on document numbers / codes (`.code`).
- Scale: page title 20/600 · section/card title 14/600 · body & table 13/400 · labels/headers 12/500 · micro/group labels 11/600 uppercase +0.04em · KPI value 28/600 tight. Base UI size **13px** (today 14px) — Linear/Stripe-class density; keep 14px for form inputs to avoid cramped entry.
- Numbers right-aligned, units in a muted suffix (`24.000 <span class=unit>m³</span>`); quantities 3 dp only where the material needs it (concrete m³ 2 dp, rebar t 3 dp, bags 0 dp) — drive decimals from UoM, not from the column.

### 2.3 Density

`<html data-density="compact|default|comfortable">`, user toggle in table toolbar and avatar menu, persisted in `localStorage`.

| | compact | default | comfortable |
|---|---|---|---|
| `--row-h` | 30px | 36px | 44px |
| `--cell-px` | 8px | 12px | 16px |
| `--control-h` | 28px | 34px | 40px |

Compact is for registers on desktop (coordinators, procurement). Touch targets never drop below 24×24 (WCAG 2.5.8) — row-action icon buttons stay 28px even in compact.

### 2.4 Tables (visual)

- Container: `--surface`, 1px `--border`, `--radius-lg`, no shadow. Header row `--surface-2`, 12px/500 `--text-muted`, sticky **inside the scroll container** (`.table-scroll { max-height: calc(100dvh - var(--table-offset)); overflow: auto }` + `thead th { position: sticky; top: 0; z-index: 1 }`). First column (identifier) sticky-left on wide tables with a right shadow when scrolled.
- Rows: height `--row-h`, horizontal dividers only (no vertical rules, no zebra — zebra fights selection/hover states). Hover `--surface-3`; selected `--primary-soft` + 2px inset left `--primary`.
- Error/warn row tinting only in import previews; elsewhere use a leading status icon instead of tinting the whole row.
- Identifier column: `--primary` link text, `.code` (slashed zero), medium weight. Dates: `29 Oct` this year, `29 Oct 2025` otherwise; relative ("3 d") in muted for deadlines.
- Empty values: `—` in `--text-subtle`, never blank or `0`.

### 2.5 Focus, motion, misc.

- `:focus-visible { outline: none; box-shadow: var(--focus-ring); }` for buttons, links, inputs, rows (`tr[tabindex]`), tabs. Never remove focus without replacement. Sticky header/bulk bar must not cover the focused row (WCAG 2.4.11): use `scroll-padding-top: calc(var(--topbar-h) + 48px)` on the scroll container.
- Motion: 120 ms ease-out for hovers/popovers, 200 ms for drawers; `@media (prefers-reduced-motion: reduce)` → 0.
- Icons: one set, 16px, 1.5px stroke (`lucide-react`, tree-shaken per icon), `aria-hidden` when next to text.

### 2.6 Charts (recharts)

- One `chartTheme.ts` exporting props: `grid = { stroke: 'var(--chart-grid)', vertical: false }` (horizontal gridlines only, solid, no dash), `axis = { stroke: 'none', tick: { fill: 'var(--chart-axis)', fontSize: 11 }, tickLine: false }`, y-axis ticks ≤5, percentages capped 0–100.
- Series colours by **fixed slot order** `--chart-1…8` (validated CVD-safe ordering; slot follows the entity — Block A is always chart-1 across all charts on a page). Single-series charts use `--chart-1`. Planned/target/baseline = `--chart-planned` dashed 4 4, 1.5px. Actual = 2px solid. Never use status colours for series; status colours only for threshold lines/annotations ("variance threshold 5 %" in `--danger`, dashed, labelled).
- Lines 2px, no dots except on hover (active dot 4px with 2px `--surface` ring). Bars: max 24px thick, 2px gap, 4px top radius, start at zero.
- **Custom tooltip component** (`<ChartTooltip>`): `--surface` bg, `--shadow-2`, `--radius`, 12px; header = x value; rows = colour swatch + series name (text colour `--text`, never series colour) + right-aligned tabular value + unit. Cursor = 1px vertical `--border-strong` line.
- Legend for ≥2 series, top-left, inline; direct-label the last point of S-curve lines. One y-axis only — never dual-axis (show cost and quantity as two charts).
- Every chart has a "Table" toggle (same data in `DataTable`) — doubles as accessibility fallback and Excel export.
- Wrap in `ResponsiveContainer` with fixed height (`--chart-h: 280px`), and give the parent an explicit height to avoid CLS.

---

## 3. Component specs

Each lives in `web/src/components/` and replaces/extends what's in `ui.tsx`. Keep component CSS in `index.css` split into `@layer tokens, base, components, pages, utilities` (or one file per component imported from `main.tsx`).

### 3.1 KPI card (`<Kpi>` replaces `<Tile>`)

Props: `label, value, unit?, delta?: {value, window: 'vs last week', goodDirection: 'up'|'down'|'none'}, spark?: number[], status?: 'ok'|'warning'|'danger', to?, loading?, error?, onRetry?, hint?`.

- Anatomy: label (12px muted, sentence case — drop the uppercase) → value (28px/600 tnum) + unit → delta row (arrow ▲/▼ shows *direction*; colour shows *sentiment* via `goodDirection`; always followed by the window text) → optional 32px sparkline (no axes, same window as delta, last point dotted).
- Status edge: 3px left border in `--danger`/`--warning` only when the count requires action (> 0). A zero count is neutral, not green — green-everything dilutes signal.
- Whole card is a link when `to` (hover: border `--border-strong`, show "→"). Destination is the *exact* filtered list (`/requests?view=needs-action`), never a generic page.
- States: skeleton (same box, shimmer bars) · error ("Couldn't load · Retry") · empty ("No data yet" ≠ 0).
- Dashboard shows ≤5 primary KPIs; the rest go to a compact "counters" row.

### 3.2 Data table (`<DataTable>` v2)

API evolution (backward compatible):

```ts
interface Column<T> { key; label; render?; value?; align?; noExport?;
  width?: number | 'auto'; minWidth?: number; sticky?: 'left'; hidden?: boolean; // default visibility
  sortable?: boolean /* default true */; filter?: 'text'|'select'|'date-range'|'number-range'; }
props: rows | (server mode) {query, total}; columns; rowKey (required now);
  selectable?: boolean; bulkActions?: (selected: T[]) => ReactNode;
  rowActions?: (row: T) => {label, onClick, danger?}[];   // first 1 inline, rest in ⋯ menu
  viewKey?: string;    // persists columns/density/sort per table in localStorage
  mode?: 'paged' | 'virtual'; pageSize?; loading?; error?; onRetry?;
  empty?: {title, body?, action?}; noResults?: {onClear}
```

Behaviour rules:

- **Sort:** header content is a `<button>`; `<th aria-sort="ascending|descending|none">`; icon ▲/▼ visible only on sorted column + faint ↕ on hover. Shift-click = secondary sort (optional).
- **Filtering:** primary filters as **chips** above the table (Stripe pattern: chip shows `Status: Submitted, Reviewed`, click to edit in popover, × to remove; "Clear filters" link appears only when ≥1 active). Free-text search box left, `/` focuses it. Filters + sort + page live in the **URL query string** (`useSearchParams`) so dashboard drill-downs and shared links reproduce the view (today Requests filters are local state; Reports already uses `?r=`).
- **Saved views:** horizontal tabs above the toolbar = preset views (code-defined, e.g. "Needs my action") + user-saved views (name + query string, stored in a `saved_views` table keyed by user+table, or `localStorage` for v1). Saving never mutates a shared preset (Airtable lesson).
- **Selection & bulk:** checkbox column (28px), header tri-state checkbox selects *visible/filtered* rows; when all on page selected, banner "All 50 on this page selected · Select all 214 matching". Floating bulk bar (bottom-centre, `--shadow-2`) shows count + actions; destructive bulk actions confirm with the count ("Reject 3 requests?").
- **Row actions:** last column, right-aligned, one inline icon/text action + `⋯` menu. Row click opens detail; clicks on checkbox/actions `stopPropagation`.
- **Keyboard:** rows are a roving-tabindex list (`tabindex=0` on active row only): ↑/↓ or J/K move, Enter opens, Space/X toggles selection, Shift+↑/↓ extends. Not a full ARIA grid (cells aren't editable) — keep `<table>` semantics.
- **States:** loading = 8 skeleton rows at real row height under the real header; error = inline banner in the table body with Retry; **empty** (no data at all) = title + why + primary action ("No elements yet — Import from Excel"); **no results** (filters) = "No requests match these filters · Clear filters". Never the same message for both.
- **Pagination vs virtualization:** server data with ≥ 1,000 possible rows (ledger, audit, MR register, GRN/MIV history) → **server-side paging** (PostgREST `range` + `count: 'estimated'`), 50/100/200 per page, "Rows 1–50 of 2,314". Client data ≤ ~5,000 rows that users scan/compare (stock balance, BoQ, take-offs, elements, import preview) → **virtualize** with `@tanstack/react-virtual` (fixed `estimateSize = --row-h`, overscan 10) and drop pagination. Below ~200 rows, plain render.
- **Column chooser + density** (toolbar right): popover with checkboxes, drag handle optional; persisted by `viewKey`.
- **Export:** "Export ▾ → Excel (current view) / Excel (all columns) / Print/PDF". Server-mode export fetches all matching rows in the background with a progress toast.
- **Print:** unchanged trick (render all on `beforeprint`) but switch virtual tables to full render too.

### 3.3 Status badges

- Shape: `--radius-sm` (4px, not pill — pills read as tags/chips), 20px tall, 12px/500, `--{tone}-soft` bg, `--{tone}` text, **leading 6px dot or 12px icon** so meaning isn't colour-only.
- Tones: `success, warning, danger, info, neutral, primary`. Keep the existing `TONES` map in `ui.tsx` but rename keys → tones, and add icons for priority (`▲ critical`, `↑ urgent`, none for normal — don't badge "normal").
- One status badge per row; secondary flags (Over BoQ, Emergency) as outline badges (`border: 1px solid currentColor; background: transparent`).
- Status lifecycle rendering on detail pages: horizontal mini-stepper `Draft › Submitted › Reviewed › Approved › Issued › Closed` with current step highlighted; terminal states (Rejected/Cancelled) replace the tail.

### 3.4 Drawers vs modals vs pages

| Use | Pattern |
|---|---|
| Confirm, reason for reject/return/reverse, short create forms (≤6 fields) | **Modal** (`<dialog>.showModal()`, 480–640px) |
| Peek a record from a list without losing scroll/filters (audit entry, element detail, stock card, GRN preview) | **Right drawer** (`<dialog>` styled as side sheet, 560px / 720px wide, `?peek=<id>` in URL so Back closes it) |
| Anything with its own sub-tables, actions, history, or shareable URL (MR, GRN, MIV) | **Full page** with breadcrumb |
| Menus, filter popovers, project switcher, notifications | **Popover** (`popover` attribute / anchored div; non-modal) |

Modal/drawer rules: native `<dialog>` gives top-layer, inert background, Esc and focus-move for free — replace the custom `Modal` internals but keep its props. Return focus to the invoking element on close. Footer: secondary left-of primary, primary right; destructive confirm uses `danger` + verb ("Reject request"), never "OK". Never stack more than one modal; a drawer may open one confirm modal.

### 3.5 Toasts

- Bottom-right stack, max 3, `--shadow-2`, 4 s (errors persist until dismissed). `role=status` (polite) for success, `role=alert` for errors.
- Use for: async completions ("MR-0142 approved · Undo" — 6 s with Undo for reversible ops), background export ready, offline/sync notices. Not for validation errors (inline) or blocking failures (banner/dialog).
- Implementation: tiny in-house `toast()` store (~60 lines, `useSyncExternalStore`) or `sonner` if we want swipe/stack polish. Default: in-house.

### 3.6 Form controls

- Height `--control-h`; border `--border-strong` (3:1); radius `--radius`; focus = `--focus-ring`; invalid = `--danger` border + message below with icon; `aria-invalid` + `aria-describedby`.
- Labels above fields, 12px/500 `--text`; required = "*" + `aria-required`; hint 12px muted below. Never placeholder-as-label.
- Numeric: `inputmode="decimal"`, right-aligned, unit suffix inside the field (`[ 24.000 | m³ ]`).
- Large option sets (elements, specs ~hundreds): replace `<select>` with a **combobox** (type-to-filter, shows code + description, keyboard). One shared `<Combobox>` (hand-rolled on `aria-activedescendant`, or reuse the command-palette list primitive).
- Dates: native `<input type="date">` (fine, localised); show Ethiopian-calendar hint later if needed.
- Form layout: single column for ≤8 fields; 2-col grid for setup records; sticky footer with Save/Cancel on long forms; unsaved-changes guard (`useBlocker`).
- Buttons: `primary` (filled `--primary`), `secondary` (surface + border), `ghost` (text only), `danger` (filled `--danger`), sizes sm 28 / md 34 / lg 40; busy state keeps width and shows spinner + verb-ing.

### 3.7 Tabs

- Underline tabs (current) for in-page sections; active = `--text` + 2px `--primary` underline (not orange text). Count suffix in muted (`Low stock 12`).
- Proper ARIA: `role=tablist/tab/tabpanel`, `aria-controls`, ← → moves focus, Home/End. Keep URL-hash state (`useHashTab`) — it's good.
- More than ~7 tabs (Store has 10) → group: **Store** becomes sub-nav: *Stock* (Balance, Low stock, Bin card) · *Movements* (GRN, MIV, MRN, Transfers) · *Control* (Adjustments, Counts, Emergency). Render as a segmented secondary row or a left sub-nav inside the page.

### 3.8 Stepper wizard

- Horizontal numbered steps (circle 24px + label), completed = check in `--primary`, current = filled, future = outline. Clickable back to completed steps only.
- Footer: Back (secondary) left, Next/Commit (primary) right with explicit count ("Import 330 rows"). Commit step summarises what will happen (create N, update M, skip K).
- State held in one reducer; leaving mid-wizard prompts.

### 3.9 Command palette

See §1.3. Visual: 640px, `--radius-lg`, `--shadow-3`, input 48px/16px font, group headers 11px uppercase muted, rows 36px with icon + label + right-side hint (shortcut or record type), active row `--surface-3`. Footer hint bar: `↑↓ navigate · ↵ open · esc close`.

### 3.10 Charts component set

`<ChartCard title actions table>` (card + chart/table toggle + export), `<LineTrend>`, `<BarCompare>`, `<SCurve>`, `<ChartTooltip>`, `<Sparkline>` (pure SVG `<polyline>`, ~25 lines — don't pull recharts into the dashboard KPI row just for sparklines).

---

## 4. Page-by-page guidance

**Dashboard**
- Add "Needs attention" strip at top: only non-zero items, ordered by severity (BR-01 emergency issues > critical approvals > over-variance > low stock > others). This replaces the 12 equal tiles as the alert mechanism.
- 5 primary KPIs with deltas over a period selector (Today / 7 d / 30 d): Overall progress (pts), Delayed elements, Pending approvals (oldest age as sub), Low stock, Variance alerts. Cost KPI only for price roles (keep `canSeePrices`).
- Remaining 7 tiles → compact counters row (link each).
- Charts: S-curve (move from Progress — it's the headline management view), approvals-ageing buckets (<24 h / 24–48 / >48 h horizontal bar), progress by block (table with bars — keep), variance top-10.
- Role variants: office engineer sees "To verify" and "To review" first; procurement sees approved-not-issued and low stock; coordinator default.
- Data: replace 11 queries + full consumption fetch with one RPC `dashboard_summary(project_id, period)` returning counts, deltas and spark arrays (see §5). Show "Updated 2 min ago · ⟳".

**Material requests register**
- Saved-view tabs: All · Needs my action (role-aware) · Urgent/critical · Approved not fully issued · Overdue (required date passed, not issued) · My drafts.
- Filters to chips + URL; server-side filtering/paging (today it `fetchAll`s every MR then filters).
- Columns: MR (sticky) · Status · Priority · Block/Level · Requested by · Required (with "in 3 d"/"2 d late" in danger) · Lines · Waiting (h) · Issued % (mini bar). Hide by default: purpose, store, created.
- Bulk: approve-in-full (only when every selected MR is approvable and has no over-BoQ line; otherwise disable with reason tooltip), export.
- "+ New request" primary for roles with `mr.create`.

**Request detail & approvals**
- Header with number, status + priority badges, lifecycle mini-stepper, meta line; actions right (primary = next logical action for the user's role; Reject/Cancel/Close in secondary/overflow).
- Two columns: lines table (stock available, BoQ balance, approved qty editable inline when approving — no separate modal for partial approval) | side panel (details, attachments, activity timeline with comments/versions).
- Over-BoQ and lead-time warnings as a banner above lines + per-line icon.
- After approve/return → toast with Undo (if backend allows reversal before issue) and "Next in queue →" if arrived from inbox.

**Approval inbox (new, `/approvals`)**
- Unified queue across MR review/approve, adjustments, stock counts, progress verification, emergency-issue regularisation. Type tabs with counts; default sort oldest-first with critical pinned on top.
- Split view: list (380px) + preview panel with the same approval controls as detail pages (reuse components). J/K navigation, A approve, R return (opens comment), auto-advance to next item.
- Bulk approve only for homogeneous, rule-clean items. Empty state: "You're all caught up" + last-approved summary.

**Store**
- Regroup 10 tabs into 3 sub-sections (see 3.7). Default tab = Stock balance.
- Stock balance: virtualized; group-by store or category toggle; status badge (Available/Quarantine); "below reorder" rows show amber leading icon and a bar `qty / reorder level`; row click opens **bin card drawer** (ledger for that store+spec) rather than switching tabs.
- GRN/MIV/MRN registers: server-paged list → detail page/drawer with lines. Flags column (shortage, damaged, wrong grade) as outline danger badges.
- Adjustments & counts: show "Awaiting approval" view first for approvers; approve in drawer with variance table (system vs counted, value if price role).
- Transfers: in-transit as default view; age column.
- Emergency issues: red "Needs attention" banner when any > 24 h, count in sidebar badge.

**Progress**
- Roll-up: block → level hierarchy as expandable rows (tree table) instead of a flat block/level list; progress bar + delayed count.
- S-curve: shared chart theme; planned dashed, verified solid, reported (unverified) as light dotted third line; period range selector; "today" vertical reference line.
- Verification queue: link to Approvals inbox (Progress tab) — same component, no duplicate UI. Hold-point items flagged.
- Delay report: sort by days late; badge reason; export.

**Elements & BoQ**
- Elements table: virtualized; filter chips Block/Level/Type/Status; element detail in drawer (activities, take-offs, consumption) — keep wide modal content but as drawer.
- BoQ: show hierarchy by item number (section rows bold), amount column for price roles, totals footer row (sticky bottom).
- Import tab → **one** wizard with a "What are you importing? BoQ · Elements · Take-offs" first step and a recommended order note, instead of three stacked importers.

**Import wizard (shared component)**
- Steps: Upload (drag-and-drop zone + template download + sheet picker) → Map columns (auto-match by normalised header + alias list, manual override, "Ignore", required fields flagged, remember mapping in `localStorage` per importer) → Review (summary counts; virtualized preview; "Errors only" toggle; per-cell error highlight with message and suggestion; duplicates shown as "will update" warnings; download error report .xlsx with an Error column so users fix in Excel and re-upload) → Commit (progress, then result summary with links: "View 330 imported elements").
- Validation runs in the browser in chunks (or a Web Worker for >5k rows) so the UI stays responsive.

**Materials, suppliers & prices**
- Keep tabs; specs table grouped by category with collapsible group headers. Prices tab (price roles): last price, previous, change %, updated date, supplier; inline edit with history drawer. Suppliers: rating stars as number + icon, categories as neutral chips.
- Fix: `useAsync(..., [tab])` refetches materials/specs on every tab change — key on data version instead (see §5).

**Project setup**
- Left sub-nav (Projects & settings · Members · Structure · Stores · Opening balances) instead of tabs; it's a settings area.
- Structure: blocks → levels → zones as a nested editable list with inline add, not three tables.
- First-run checklist card when a project is incomplete: "1 Create blocks/levels ✓ 2 Add stores ✓ 3 Import BoQ ○ 4 Import elements ○ 5 Opening balances ○ 6 Invite members ○".
- Workflow settings: group into cards (Approval routing, Value limits per role, Variance thresholds per category) with sticky Save bar showing "Unsaved changes".

**Users**
- Table: name+email, role badge, projects (chips, +N), status (Active/Deactivated), last sign-in. Invite in modal; edit in drawer. Bulk deactivate with confirm. Filter by role/project.

**Settings**
- Company profile (name, logo upload used in print header), price-visibility roles, notification defaults. Card sections, single column, sticky save bar.

**Reports**
- Left report list grouped (Requests / Store / Progress / Cost) replacing the "Report" `<select>`; search box over report names.
- Filter row as chips; summary strip (totals, counts) above the table; table in server or virtual mode; Export Excel (all filtered rows) and Print/PDF (print layout below).
- Report state fully in URL (`?r=ageing&block=…&from=…`) — extend existing `?r=`.

**Audit log**
- Server-paged (not "latest 5,000"), filters: user, table, action, date range, record search. Row → drawer showing a field-level diff (old → new, changed fields highlighted, unchanged collapsed). Device column shows device name if registered.

**Print / PDF layout (all reports & documents)**

```css
@page { size: A4 landscape; margin: 12mm 10mm 14mm; }
@media print {
  :root { --bg:#fff; --surface:#fff; --text:#000; --text-muted:#444; --border:#999; }
  body { font-size: 10pt; }
  thead { display: table-header-group; }   /* repeat header per page */
  tfoot { display: table-footer-group; }
  tr, .kpi, .card { break-inside: avoid; }
  h1, h2 { break-after: avoid; }
  .table-scroll { max-height: none; overflow: visible; }
  th { position: static; background: #eee !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  a[href]::after { content: none; }
  .badge { border: 1px solid currentColor; background: none !important; }  /* survives B/W printers */
}
```

- `<PrintHeader>` (print-only): company logo + name, report/document title, project, applied filters in words, printed-at + by, page "x of y" is browser-controlled (note in UI: enable "Headers and footers" or rely on the in-content header).
- Documents (MR, GRN, MIV) get an A4 portrait variant with signature blocks (Prepared/Checked/Approved) — FR-RP-03.
- Charts print as SVG (recharts does) at fixed width 960px; hide tooltips/legends interaction.

---

## 5. Performance checklist (concrete rules for this codebase)

**Data fetching**
1. **Adopt TanStack Query** (`@tanstack/react-query`, ~13 kB gz) and implement `useAsync` on top of it so pages migrate one by one: `useQuery({ queryKey: [table, projectId, filters], queryFn, staleTime: 60_000 })`. Gains: cache across tab switches/navigation (Materials, Store tabs refetch on every switch today), dedupe (several components ask for the same lookups), stale-while-revalidate on window focus, `invalidateQueries(['mivs', projectId])` after mutations instead of the `version++` listener scheme. Keep `useLookups` as a query with `staleTime: 10 min`.
2. **No full-table fetches for counts or KPIs.** Replace dashboard `fetchAll(v_element_consumption)` + 4 `count` calls with one `rpc('dashboard_summary', {p_project, p_period})` returning `{ kpis, deltas, sparks, attention[] }`. Same for sidebar badges: `rpc('nav_counts')`, polled every 60 s while visible.
3. **Server-side paging/filtering** for unbounded registers (MR, GRN, MIV, MRN, ledger, audit, transfers): `.range(from, to)` + `{ count: 'estimated' }`, filters as query params. `fetchAll` only for bounded master data (specs, elements, BoQ) and for explicit "Export all".
4. **Select only needed columns** for lists (`select('id, number, status, priority, …')`, not `*` with nested lines); fetch `*_lines` on the detail page/drawer.
5. **Avoid waterfalls:** start queries in route loaders or at the top of the page with `Promise.all`/parallel `useQuery`s; never gate a query on another unless it truly depends on its result. Prefetch on hover/focus of table rows and nav links (`queryClient.prefetchQuery`) for detail pages.
6. **Debounce** search inputs 200–300 ms; filters update URL with `replace: true`.

**Rendering**
7. Virtualize any client-side list > 200 rows (`@tanstack/react-virtual`, fixed row height, `overscan: 10`); keep `<table>` markup with spacer rows (top/bottom padding `<tr>`) so sticky header and semantics survive.
8. Enable **React Compiler** (stable 1.0; on Vite 8/`@vitejs/plugin-react` v6 use the documented oxc/babel plugin path) and then *stop* adding `useMemo/useCallback` by hand; remove the `exhaustive-deps` suppressions as code is touched. Until enabled: memoize `columns` arrays (they are recreated each render and are a `DataTable` sort dependency).
9. Lift lookup closures (`L.person`, `L.spec`) out of render-hot paths: pre-join display strings once per dataset (`useMemo(() => rows.map(r => ({...r, _person: L.person(r.created_by)})), [rows, L])`) so sort/filter/export don't call Map lookups per cell per render.
10. Keep table cells cheap: no inline component definitions inside `render`, no per-row `new Intl.NumberFormat` (create formatters once in `format.ts` — verify).
11. Use `startTransition` for filter/sort changes on big client tables; `useDeferredValue` for search text.

**Bundles**
12. Keep route-level `lazy()` (done). Additionally split **Store** (32 kB source, 10 sub-views) and **Reports** (25 kB) by tab/report: `const GrnRegister = lazy(() => import('./store/GrnRegister'))`.
13. recharts only in chart routes/components (it's ~100 kB gz): dashboard KPI sparklines must be plain SVG; load the dashboard's chart cards lazily below the fold.
14. `xlsx` stays dynamically imported (done in `format.ts`); also lazy-load the ImportWizard route.
15. Icons: per-icon imports (`import { Truck } from 'lucide-react'`), never the barrel object.
16. Self-host Inter variable woff2, `font-display: swap`, preload one file with `crossorigin`.
17. Add `vite build --mode analyze` with `rollup-plugin-visualizer` occasionally; budget: initial JS ≤ 180 kB gz (React + router + supabase + shell), each route chunk ≤ 60 kB gz excluding recharts/xlsx.
18. Prefetch likely-next route chunks on nav-link hover (`onMouseEnter={() => import('./pages/Store')}`).

**Perceived performance & resilience**
19. Skeletons in final layout dimensions (no spinners, no layout shift); keep previous data visible while refetching (`placeholderData: keepPreviousData`) with a subtle top progress bar.
20. Optimistic UI only for low-risk toggles (mark notification read); approvals/stock postings wait for the RPC (business rules are server-side) but show inline busy state on the specific button.
21. Measure: React Profiler on Store/Elements with realistic data (5k elements, 20k ledger rows); target interaction < 100 ms for sort/filter, < 1.5 s LCP on a mid laptop over 4G (Ethiopian site connectivity).

---

## 6. Libraries (minimal additions)

| Need | Recommendation | Size (approx gz) | Why / tradeoff |
|---|---|---|---|
| Server-state cache | **@tanstack/react-query** — add | ~13 kB | Biggest UX+perf win (cache, dedupe, SWR, invalidation). Hand-rolled `useAsync` already reinvents a slice of it badly. |
| Virtualization | **@tanstack/react-virtual** — add | ~5 kB | Headless, works with existing `<table>`. Skip `@tanstack/react-table`: current `DataTable` is fine; extend it instead of rewriting. |
| Icons | **lucide-react** — add | ~1 kB per icon used | Consistent stroke set; tree-shakes. |
| Font | **@fontsource-variable/inter** — add | 1 woff2 (~100 kB, cached) | Self-host, no Google Fonts dependency/latency. |
| Command palette | `cmdk` — optional | ~5 kB | Only if fuzzy ranking needed; otherwise hand-roll (<100 items + one search RPC). |
| Toasts | in-house (60 lines) — default; `sonner` optional | 0 / ~10 kB | In-house is enough; sonner if we want stacking/swipe polish. |
| Dialog/popover/menu | **native `<dialog>` + `popover`** — no lib | 0 | Top layer, inert, Esc, focus handling built in. Radix UI only if menus/comboboxes become a time sink. |
| Styling | **stay on plain CSS + variables**; split into `@layer`s and per-component files | 0 | Fastest to apply to the existing className-based code; tokens already exist; no rewrite of ~170 kB of TSX. Tailwind v4 would mean touching every className; CSS Modules adds scoping but forces renaming every class — not worth it at this size. |
| Compiler | **React Compiler** (babel-plugin-react-compiler / Vite 8 plugin path) | build-time | Removes manual memo work. |
| Charts | keep **recharts** | — | Already in; add a theme module. Don't add a second chart lib. |
| Dates | keep native `Intl` | 0 | No date-fns/dayjs needed. |

Total runtime added for the core set (Query + Virtual + icons): ≈ 20–25 kB gz.

---

## 7. Top design rules (the short list)

1. One primary action per view; everything else secondary or in `⋯`.
2. `--primary` (indigo) = action/selection/focus; `--accent` (amber) = brand & attention, never inside data; status colours only for status, always with icon + label.
3. Every number is right-aligned, tabular, with a muted unit and UoM-driven decimals.
4. Every KPI has a comparison window and a "good direction"; zero is neutral, not green.
5. Every KPI and alert links to the exact filtered list behind it.
6. Filters, sort, tab, page and peeked record live in the URL.
7. Distinguish loading (skeleton), empty (explain + action), no-results (clear filters) and error (retry).
8. Tables: sticky header inside the scroll box, sticky identifier column, no zebra, no vertical rules, 36px default rows with a density toggle.
9. Server-page unbounded registers; virtualize bounded client lists > 200 rows; never fetch a table to count it.
10. Detail = page when it has a URL-worthy life; drawer for peeks; modal only for confirm/short input.
11. Approvals happen in one inbox with keyboard flow and auto-advance; destructive bulk actions confirm with a count.
12. Imports always: template → map → validated preview (errors only toggle, downloadable error report) → explicit "Import N, skip M".
13. Focus is always visible (2px ring + offset) and never hidden behind sticky UI; targets ≥ 24px; contrast ≥ 4.5:1 text, ≥ 3:1 control borders.
14. Charts: horizontal gridlines only, one y-axis, fixed series-colour order, custom tooltip with text-coloured labels, a table view for every chart.
15. Dark mode is designed (own token values, validated), toggleable (System/Light/Dark), and print always forces the light, ink-friendly palette.

---

## Sources

Product/design references
- Linear — How we redesigned the Linear UI (LCH theme from base/accent/contrast; Inter Display headings; sidebar/header noise reduction): https://linear.app/now/how-we-redesigned-the-linear-ui
- Linear — Behind the latest design refresh (dimmer sidebar so content stands out): https://linear.app/blog/behind-the-latest-design-refresh
- Linear — Command menu changelog (context-prioritised groups): https://linear.app/changelog/2019-12-18-new-command-menu
- Stripe Apps — Full-page apps (list→detail, DetailPage breadcrumbs, two-column layout): https://docs.stripe.com/stripe-apps/patterns/full-page-apps
- Stripe Apps — Filter controls (FilterChip + conditional "Clear filters"): https://docs.stripe.com/stripe-apps/patterns/filter-controls
- Vercel Geist design system overview: https://vercel.com/geist/introduction
- Procore — NGX Documents list view (new data table + unified info panel): https://www.procore.com/whats-new/modernized-documents-tool-ngx-list-view-update
- Procore — navigation bar / Company vs Project tools: https://support.procore.com/product-releases/new-releases/procores-new-navigation-bar
- Fieldwire — tasks filters/views and plan side panel: https://help.fieldwire.com/hc/en-us/articles/202909250
- Autodesk Construction Cloud — product picker / project navigation: https://help.autodesk.com/cloudhelp/ENU/Docs-About-ACC/files/about-acc/Autodesk_Construction_Cloud_Navigation.html
- Notion — Views, filters, sorts & groups: https://notion.com/help/views-filters-and-sorts
- Airtable community — personal vs shared views: https://community.airtable.com/legacy-product-ideas-75/private-or-user-views-and-reverting-to-sticky-public-views-44047

Tables, dashboards, patterns
- SaaS data table UX patterns: https://saasui.design/blog/saas-data-table-ux-patterns
- SaaS metric/KPI card UX patterns: https://www.saasui.design/blog/saas-metric-kpi-card-ux-patterns
- Perforce Force — data table density (compact 32px): https://the-force-design-spec-site.public.dev.shared.perforce.com/patterns/components/data-table/
- PatternFly table guidelines (select-all on paginated tables): https://v5-archive.patternfly.org/components/table/design-guidelines
- Elastic EUI table layout (actions column last): https://eui.elastic.co/pr_9541/docs/components/tables/layout-guidelines
- W3C APG data grid examples (roving tabindex, aria-sort): https://www.w3.org/WAI/ARIA/apg/example-index/grid/dataGrids.html
- NN/g — Breadcrumbs: https://www.nngroup.com/articles/breadcrumbs/
- Visa design system — vertical navigation (collapse, drawer on small screens): https://design.visa.com/components/vertical-navigation/usage/
- Approval inbox patterns (Certify inbox UI): https://help.certify.com/hc/en-us/articles/15455539654285-Overview-of-the-Approval-Inbox-UI ; Ramp community on keyboard approve: https://community.ramp.com/t/reimbursement-approval-on-desktop-with-fewer-clicks/690
- CSV import best practices (mapping, preview, row errors): https://dromo.io/blog/5-best-practices-to-streamline-your-csv-import-process ; https://blog.csvbox.io/column-mapping-saas/
- Print CSS (repeating thead, break-inside): https://www.w3docs.com/snippets/html/how-to-handle-page-breaks-when-printing-a-large-html-table

Accessibility, theming, type
- W3C — What's new in WCAG 2.2 (2.4.11 focus not obscured, 2.5.8 target size): https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- Dark mode token systems: https://muz.li/blog/dark-mode-design-systems-a-complete-guide-to-patterns-tokens-and-hierarchy/ ; DNB Eufemia dark mode tokens: https://eufemia.dnb.no/uilib/usage/customisation/theming/design-tokens/dark-mode
- Inter OpenType features (tnum, zero): https://lexingtonthemes-com.pages.dev/blog/inter-stylistic-sets-css-tailwind ; https://d.rsms.me/inter-website/v3
- Font loading (self-host, swap, preload crossorigin): https://specification.website/spec/performance/font-loading/
- Native dialog vs popover: https://frontendmasters.com/blog/whats-the-difference-between-htmls-dialog-element-and-popovers/

React performance & libraries
- TanStack Table virtualization guide (sticky header in virtual table): https://tanstack.com/table/latest/docs/framework/react/guide/virtualization
- TanStack Query vs useEffect: https://leapcell.io/blog/the-pitfalls-of-manual-data-fetching-with-useeffect-and-why-tanstack-query-is-your-best-bet
- React Compiler v1.0: https://react.dev/blog/2025/10/07/react-compiler-1 ; Vite 8 setup note: https://recca0120.github.io/en/2026/04/14/react-compiler-vite-v6/
- cmdk overview: https://dev.to/blockpathdev/building-command-menus-with-cmdk-in-react-45o3
- React toast libraries compared (sonner): https://blog.logrocket.com/react-toast-libraries-compared-2026/
- Tailwind v4 vs CSS Modules for existing codebases: https://www.kunalganglani.com/blog/tailwind-vs-css-modules-2026.md
- Recharts Tooltip API: https://recharts.github.io/en-US/api/Tooltip
- Chart palette/marks method: internal dataviz reference (validated 8-slot categorical order, CVD-checked).
