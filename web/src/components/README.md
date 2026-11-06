# Site Console UI kit

Everything a page needs is exported from `components/ui.tsx` (`import { Page, DataTable, … } from '../components/ui'`).
Design tokens live in `src/styles/tokens.css` (spec: `docs/research/web-design.md` §2, palette "Blueprint & Beacon").
CSS is split into `@layer tokens, base, components, pages, utilities` (`src/styles/*.css`). Use token names
(`var(--primary)`, `var(--danger-soft)`, `var(--sp-4)`…), never hex values.

## Adding a page

1. Create `src/pages/MyPage.tsx` exporting a named component.
2. Add a loader in `src/nav.tsx` → `loaders.MyPage = () => import('./pages/MyPage')`.
3. Add a `NAV` entry (group, lucide icon, `anyOf` actions / `roles` for visibility, optional `count`, `tabs` for the palette, `key` for `G <key>`).
4. Add a `<Route>` in `App.tsx` with `const MyPage = lazyNamed(loaders.MyPage, 'MyPage')`; wrap with `needProject()` / `gate()` as needed.

The sidebar, command palette (Go to + tabs) and hover-prefetch pick it up automatically.

## Data

| Helper | Use |
|---|---|
| `useAsync(fn, deps, { key, staleTime?, enabled?, refetchInterval? })` (`lib/hooks`) | TanStack-Query-backed loader. Returns `{ data, error, loading, reload }`. **Always pass `key`** (e.g. `'gate-passes'`). Previous data stays visible while deps change. |
| `useLookups(projectId)` | Blocks, levels, stores, elements, specs, profiles, suppliers + `L.block(id)`, `L.person(id)`… (10 min cache). |
| `rpc(name, payload)` (`lib/supabase`) | Transactional RPC with op_id; **invalidates all non-lookup queries** on success. |
| `invalidateAfterWrite({ lookups? })` (`lib/query`) | Call after direct table writes. `invalidateLookups()` after master-data edits. |
| `countRows(() => supabase.from(t).select('*', { count: 'exact', head: true })…)` | Counts without downloading rows. Never fetch a table to count it. |
| `fetchAll(build, max?)` | Bounded master data / explicit "export all" only. |
| `useUrlFilters(defaults, prefix?)` (`lib/url`) | Filters in the query string → `[values, set(k, v), { active, clear, setMany }]`. Keeps the `#tab` hash. Use a prefix per tab when a page has several tables. |
| `useUrlParam('peek' \| 'open')` | Drawer state in the URL; `set(id, true)` pushes history so Back closes it. |
| `useHashTab(keys, fallback)` | Tab state in `#hash` (deep-linkable). |

Formatting (`lib/format`): `num`, `qty(v, uom)` (UoM-driven decimals), `money`, `date`, `shortDate`, `dateTime`, `ago`, `dueIn`, `hoursSince`, `humanize`, `exportExcel`.

## Components

| Component | Key props | Notes |
|---|---|---|
| `Page` | `title, titleExtra?, subtitle?, actions?, breadcrumbs?: {label,to?}[], width?: 'fluid'\|'form'\|'dash'` | ≤1 primary action. Breadcrumbs only on detail pages. |
| `Card` | `title?, sub?, actions?, flush?` | `flush` for tables edge-to-edge. |
| `DataTable<T>` | `rows, columns, rowKey?, onRowClick?, loading?, error?, onRetry?, empty?: node \| {title, body?, action?}, filtered?, onClearFilters?, exportName?, onExportAll?, toolbar?, selectable?, bulkActions?(sel, clear), stickyFirst?, urlKey?, viewKey?, defaultSort?, server?: {page,pageSize,total,onPage}, virtual?, maxHeight?, activeKey?, footer?` | Sortable keyboard headers (`aria-sort`), sticky header in its scroll box, roving rows (↑↓/J K, Enter, Space/X), skeleton/empty/no-results/error, auto-virtualizes > 200 rows, Export ▾ (Excel/print), density + column chooser (`viewKey`). |
| `Column<T>` | `key, label, render?, value?, align?, id?, hidden?, sortable?, noExport?, width?` | `value` = plain value for sort/export; `id` styles the identifier column. Blank values render `—`. |
| `FilterBar` | `active, onClear, right?` | Shows "Clear filters" when `active > 0`. |
| `SearchInput` | `value, onChange, placeholder` | Debounced; `/` focuses it. |
| `FilterSelect` / `FilterDate` / `FilterText` / `FilterToggle` | `label, value, onChange, options?` | Chip-style filters. |
| `Badge` | `value? (status), label?, tone?, icon?, outline?` | Status → tone/icon map shared with mobile. `PriorityBadge` hides "normal". Tones: success, warning, danger, info, neutral, primary, violet. |
| `Kpi` | `label, value, unit?, delta?: {value, window, goodDirection}, spark?, status?, to?, loading?, error?, hint?` | Zero is neutral; links to the exact filtered list. `Sparkline` is pure SVG. |
| `Modal` | `title, onClose, footer?, size?: 'sm'\|'md'\|'lg'` | Native `<dialog>`: Esc, inert background, focus in/out. Mount = open. `data-autofocus` picks the first focus. |
| `Drawer` | `title, subtitle?, onClose, footer?, size?: 'md'\|'lg'` | Right sheet for peeks and edit forms. |
| `ReasonModal` | `title, label?, required?, confirm, danger?, onSubmit(text)` | Reject/return/reverse comments. |
| `confirm({ title, body?, confirm?, danger? })` | → `Promise<boolean>` | Destructive confirms; say the count ("Reject 3 requests?"). |
| `toast.success / error / info(msg, { action? })` | | Async completions only (not validation). |
| `Tabs` | `tabs: {key,label,count?,hot?}[], value, onChange, variant?: 'underline'\|'segmented'\|'vertical'` | ARIA tabs with arrow keys. `TabGroups` for > 7 sections. |
| `Field` | `label, required?, hint?, error?, wide?, check?` | Label above control. `QtyInput` = number + unit suffix. |
| `Popover` + `Menu` | `trigger(props), children(close)`; `items: (MenuItem\|null)[]` | Menus, overflow `⋯`. |
| `Stepper`, `MrLifecycle` | `steps, current, onStep?` | Wizards / request lifecycle. |
| `Banner`, `ErrorBanner`, `Empty`, `Loading`, `Skeleton`, `Bar`, `Qty`, `Dash` | | States and small display bits. |
| `PrintHeader`, `Signatures` | `title, filters?` | Print-only report/document header and sign-off blocks (`.print-doc` = A4 portrait). |
| `CrudTable` | `table, title, fields: FieldDef[], filter?, defaults?, canEdit, filterRows?, filtered?, onRowClick?` | Config-driven master-data list + add/edit (Modal ≤ 6 fields, Drawer otherwise). |
| `ImportWizard<T>` | `title, templateFile, headers, required?, aliases?, validate(rows), commit(records), example?, note?` | Upload → Map columns → Review (errors only, error report) → Done. |
| `Attachments` | `entityType, entityId` | Photo/signature thumbnails. |
| `charts/SCurve` | lazy-load only | recharts stays out of the initial bundle; reuse `chartTheme` + `ChartTooltip` from it for new charts. |
| `approval/Previews` | `MrPreview`, `AdjustmentPreview`, `CountPreview`, `ProgressPreview`, `EmergencyPreview` | Approval panels used by `/approvals`; new approvable types add a loader in `lib/approvals.ts` + a preview here. |

## Page templates

### List page (register)

```tsx
export function GatePasses() {
  const projectId = useProjectId();
  const nav = useNavigate();
  const lk = useLookups(projectId);
  const q = useAsync(() => fetchAll<Row>((a, b) => supabase.from('gate_passes')
    .select('id, number, status, created_at, vehicle_plate').eq('project_id', projectId).order('created_at', { ascending: false }).range(a, b)),
    [projectId], { key: 'gate-passes' });
  const [f, setF, { active, clear }] = useUrlFilters({ status: '', q: '' });
  const rows = (q.data ?? []).filter((r) => (!f.status || r.status === f.status) && (!f.q || r.number.toLowerCase().includes(f.q.toLowerCase())));
  return (
    <Page title="Gate passes" actions={<button className="primary" onClick={() => setNew(true)}><Plus size={14} />New gate pass</button>}>
      <FilterBar active={active} onClear={clear}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Pass no." />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={[{ value: 'open', label: 'Open' }]} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data} error={q.error} onRetry={q.reload} urlKey="" stickyFirst exportName="gate-passes"
        filtered={active > 0} onClearFilters={clear} onRowClick={(r) => nav(`/gate-passes/${r.id}`)}
        empty={{ title: 'No gate passes yet', body: 'Passes created at the gate appear here.' }}
        columns={[
          { key: 'number', label: 'Pass', id: true },
          { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
          { key: 'created_at', label: 'Created', render: (r) => dateTime(r.created_at) },
        ]} />
    </Page>
  );
}
```

### Detail page

```tsx
<Page width="form" title={doc.number} titleExtra={<Badge value={doc.status} />}
  breadcrumbs={[{ label: 'Gate passes', to: '/gate-passes' }, { label: doc.number }]}
  subtitle={`Created ${dateTime(doc.created_at)} by ${L.person(doc.created_by)}`}
  actions={<><button onClick={() => setDialog('reject')}>Reject…</button><button className="primary" onClick={approve}>Approve</button></>}>
  <div className="print-doc">
    <PrintHeader title={`Gate pass ${doc.number}`} />
    <div className="detail-layout">
      <div className="stack"><Card title="Lines" flush><DataTable rows={lines} columns={…} maxHeight="none" /></Card></div>
      <div className="side-panel"><Card title="Details"><dl className="kv">…</dl></Card><Card title="Activity"><ul className="timeline">…</ul></Card></div>
    </div>
    <Signatures />
  </div>
</Page>
```

After a mutation: `await rpc(...)` (auto-invalidates) → `toast.success('GP-0012 approved')`.

### Form drawer

```tsx
{editing && (
  <Drawer title="New gate pass" onClose={() => setEditing(null)} footer={<>
    <button onClick={() => setEditing(null)}>Cancel</button>
    <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Save</button>
  </>}>
    <ErrorBanner error={error} />
    <div className="form-grid">
      <Field label="Vehicle plate" required><input value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value })} /></Field>
      <Field label="Quantity"><QtyInput value={form.qty} onChange={(v) => setForm({ ...form, qty: v })} unit="m³" /></Field>
    </div>
  </Drawer>
)}
// const { busy, error, run } = useBusy();  save = () => run(async () => { await rpc(…); setEditing(null); toast.success('Saved'); });
```

## Rules of thumb

- One primary button per view; status always icon + label (`Badge`); numbers right-aligned with `<span className="unit">`.
- Filters/tab/page/peek in the URL. Distinguish loading / empty / no-results / error (DataTable does it if you pass `loading`, `filtered`, `error`).
- Keyboard: don't bind single letters while focus is in an input (`Shell` handles G-shortcuts, `/`, `?`, Ctrl/⌘ K).
- Never import recharts or xlsx at module top level of a page that's not a chart/import page (xlsx is lazy via `lib/format`).
