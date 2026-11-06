-- =============================================================================
-- Project progress management: MS Project schedule + Earned Value (EVM)
-- (docs/research/progress-evm.md; calendar part of procurement-lookahead.md §10)
--
--   Calendars      public_holidays (Ethiopia 2026–2027 seeded, lunar dates tentative),
--                  project_calendars (default Mon–Sat), calendar_exceptions,
--                  app.is_working_day / working_days / add_working_days / day_capacity
--   Schedule       schedules, schedule_versions (one per import, diff + quality),
--                  schedule_tasks (no money), schedule_task_costs (price), schedule_links
--   Baselines      schedule_baselines (proposed → approved by coordinator/manager; all kept),
--                  schedule_baseline_tasks (dates), schedule_baseline_task_costs (price: BAC)
--   Mapping        task_boq_links (qty_share = BoQ quantity the task delivers),
--                  task_element_links, task_steps
--   Progress       task_progress (site reports → office verifies; only verified counts for EV);
--                  element-linked tasks derive % from verified element_activities progress
--   Actual cost    issued materials (stock_ledger valued as v_cost_control) + cost_entries
--                  (labour / equipment / subcontract / overhead …); project_settings.evm_cost_basis
--                  'materials' = issued + direct materials only. resource_usage (qty, no money), cost_rates.
--   Forecast       app.run_cpm: forward/backward pass on a working-day index, FS/SS/FF/SF + lag,
--                  retained logic or progress override, total/free float, critical path
--   Periods        evm_periods open → prepared → closed (immutable snapshots: evm_task_status (no money),
--                  evm_snapshots (price), period_boq_progress (BoQ qty at cut-off for the IPC));
--                  reports / costs dated on or before a closed cut-off roll into the next period
--   Views          v_evm_task, v_evm_wbs, v_evm_project, v_evm_timeseries, v_ac_material_alloc (price);
--                  v_progress_overview, v_boq_progress, v_boq_mapping_check (no money; mobile-safe)
--
-- Conventions as in 0001–0007: client uuids, project_id + updated_at everywhere, RLS member read,
-- money only in price-restricted tables (app.can_see_prices()), writes via security-definer RPCs
-- taking one jsonb `p` with op_id (app.op_seen / app.op_done).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Settings (on project_settings: synced already, editable by management)
-- -----------------------------------------------------------------------------

alter table public.project_settings
  add column if not exists evm_cost_basis text not null default 'full' check (evm_cost_basis in ('full','materials')),
  add column if not exists evm_eac_method text not null default 'cpi' check (evm_eac_method in ('cpi','budget_rate','cpi_spi')),
  add column if not exists evm_eac_min_pct numeric(5,2) not null default 10,     -- EV/BAC below this → EAC = AC + (BAC − EV)
  add column if not exists evm_progressed_logic text not null default 'retained' check (evm_progressed_logic in ('retained','override')),
  add column if not exists evm_float_to text not null default 'project_finish' check (evm_float_to in ('project_finish','contract_finish')),
  add column if not exists evm_contract_finish date,
  add column if not exists evm_critical_float_days numeric(6,2) not null default 0,
  add column if not exists evm_short_task_days int not null default 6,          -- ≤ → default EV method 0/100
  add column if not exists evm_default_start_pct numeric(5,2) not null default 50,
  add column if not exists evm_margin_pct numeric(5,2) not null default 0,       -- cost BAC = value × (1 − margin)
  add column if not exists evm_thresholds jsonb not null default
    '{"idx_warn":0.95,"idx_crit":0.90,"tcpi_warn":1.10,"idx_high":1.15,"late_start_wd":5,"unverified_days":2}'::jsonb;

-- -----------------------------------------------------------------------------
-- Calendars & Ethiopian public holidays
-- -----------------------------------------------------------------------------

create table public.public_holidays (
  id            uuid primary key default gen_random_uuid(),
  country       text not null default 'ET',
  on_date       date not null,
  name          text not null,
  name_am       text,
  kind          text not null default 'national' check (kind in ('national','religious_orthodox','religious_muslim','other')),
  is_tentative  boolean not null default false,       -- lunar dates until officially announced
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (country, on_date, name)
);

-- Proclamation 29/1996 + amendments. Islamic dates are tentative (moon sighting) — confirm each year.
insert into public.public_holidays (on_date, name, name_am, kind, is_tentative) values
  ('2026-01-07', 'Genna (Ethiopian Christmas)', 'ገና', 'religious_orthodox', false),
  ('2026-01-19', 'Timket (Epiphany)', 'ጥምቀት', 'religious_orthodox', false),
  ('2026-03-02', 'Adwa Victory Day', 'የዓድዋ ድል በዓል', 'national', false),
  ('2026-03-20', 'Eid al-Fitr', 'ኢድ አልፈጥር', 'religious_muslim', true),
  ('2026-04-10', 'Siklet (Good Friday)', 'ስቅለት', 'religious_orthodox', false),
  ('2026-04-12', 'Fasika (Easter)', 'ፋሲካ', 'religious_orthodox', false),
  ('2026-05-01', 'International Labour Day', 'የሠራተኞች ቀን', 'national', false),
  ('2026-05-05', 'Patriots'' Victory Day', 'የአርበኞች ቀን', 'national', false),
  ('2026-05-27', 'Eid al-Adha (Arafa)', 'ኢድ አልአድሐ (አረፋ)', 'religious_muslim', true),
  ('2026-05-28', 'Downfall of the Derg', 'ግንቦት 20', 'national', false),
  ('2026-08-26', 'Mawlid', 'መውሊድ', 'religious_muslim', true),
  ('2026-09-11', 'Enkutatash (New Year 2019 E.C.)', 'እንቁጣጣሽ', 'national', false),
  ('2026-09-27', 'Meskel', 'መስቀል', 'religious_orthodox', false),
  ('2027-01-07', 'Genna (Ethiopian Christmas)', 'ገና', 'religious_orthodox', false),
  ('2027-01-19', 'Timket (Epiphany)', 'ጥምቀት', 'religious_orthodox', false),
  ('2027-03-02', 'Adwa Victory Day', 'የዓድዋ ድል በዓል', 'national', false),
  ('2027-03-10', 'Eid al-Fitr', 'ኢድ አልፈጥር', 'religious_muslim', true),
  ('2027-04-30', 'Siklet (Good Friday)', 'ስቅለት', 'religious_orthodox', false),
  ('2027-05-01', 'International Labour Day', 'የሠራተኞች ቀን', 'national', false),
  ('2027-05-02', 'Fasika (Easter)', 'ፋሲካ', 'religious_orthodox', false),
  ('2027-05-05', 'Patriots'' Victory Day', 'የአርበኞች ቀን', 'national', false),
  ('2027-05-17', 'Eid al-Adha (Arafa)', 'ኢድ አልአድሐ (አረፋ)', 'religious_muslim', true),
  ('2027-05-28', 'Downfall of the Derg', 'ግንቦት 20', 'national', false),
  ('2027-08-15', 'Mawlid', 'መውሊድ', 'religious_muslim', true),
  ('2027-09-12', 'Enkutatash (New Year 2020 E.C.)', 'እንቁጣጣሽ', 'national', false),
  ('2027-09-28', 'Meskel', 'መስቀል', 'religious_orthodox', false)
on conflict (country, on_date, name) do nothing;

create table public.project_calendars (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects (id) on delete cascade,
  schedule_id          uuid,                                 -- FK added below
  msp_uid              int,
  name                 text not null default 'Standard 6-day (Mon–Sat)',
  working_weekdays     int[] not null default '{1,2,3,4,5,6}' check (working_weekdays <@ '{1,2,3,4,5,6,7}'::int[]),  -- ISO 1=Mon … 7=Sun
  hours_per_day        numeric(4,2) not null default 8 check (hours_per_day > 0),
  saturday_factor      numeric(3,2) not null default 1 check (saturday_factor between 0 and 1),
  use_public_holidays  boolean not null default true,
  holiday_country      text not null default 'ET',
  is_default           boolean not null default true,
  source               text not null default 'manual' check (source in ('manual','msp_import')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
create unique index project_calendars_default on public.project_calendars (project_id) where is_default and deleted_at is null;

create table public.calendar_exceptions (
  id           uuid primary key default gen_random_uuid(),
  calendar_id  uuid not null references public.project_calendars (id) on delete cascade,
  project_id   uuid not null references public.projects (id) on delete cascade,
  on_date      date not null,
  is_working   boolean not null default false,    -- true overrides a weekend/holiday (e.g. critical pour on Sunday)
  factor       numeric(3,2) check (factor between 0 and 1),   -- capacity of a working exception day (0.5 = half day)
  name         text,
  source       text not null default 'project' check (source in ('project','msp_import')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (calendar_id, on_date)
);

-- -----------------------------------------------------------------------------
-- Schedule, versions, tasks, links
-- -----------------------------------------------------------------------------

create table public.schedules (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects (id) on delete cascade,
  code                  text not null default 'MASTER',
  name                  text not null,
  status                text not null default 'active' check (status in ('draft','active','archived')),
  calendar_id           uuid references public.project_calendars (id),
  minutes_per_day       int not null default 480,
  minutes_per_week      int not null default 2880,
  days_per_month        int not null default 26,
  currency_code         text not null default 'ETB',
  current_version_id    uuid,
  approved_baseline_id  uuid,
  planned_start         date,
  planned_finish        date,
  status_date           date,                 -- last run_forecast / period status date
  fc_finish             date,                 -- CPM forecast finish
  es_finish             date,                 -- earned-schedule forecast finish
  forecast_run_at       timestamptz,
  created_by            uuid references public.profiles (id) default auth.uid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (project_id, code)
);
alter table public.project_calendars add constraint project_calendars_schedule_fk
  foreign key (schedule_id) references public.schedules (id) on delete set null;

create table public.schedule_versions (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  schedule_id   uuid not null references public.schedules (id) on delete cascade,
  version_no    int not null,
  source        text not null default 'mspdi' check (source in ('mspdi','excel','manual')),
  file_name     text,
  file_sha256   text,
  file_attachment_id uuid,
  header        jsonb not null default '{}'::jsonb,
  diff          jsonb,
  warnings      jsonb,
  quality       jsonb,
  result        jsonb,                         -- import_schedule result (returned again for the same file)
  imported_by   uuid references public.profiles (id) default auth.uid(),
  imported_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (schedule_id, version_no),
  unique (schedule_id, file_sha256)
);
alter table public.schedules add constraint schedules_version_fk
  foreign key (current_version_id) references public.schedule_versions (id) on delete set null;

create table public.schedule_tasks (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects (id) on delete cascade,
  schedule_id           uuid not null references public.schedules (id) on delete cascade,
  msp_uid               int not null,
  msp_guid              text,
  msp_id                int,
  wbs                   text,
  outline_number        text,
  outline_level         int not null default 1,
  parent_id             uuid references public.schedule_tasks (id),
  sort_order            int not null default 0,
  name                  text not null,
  notes                 text,
  is_summary            boolean not null default false,
  is_milestone          boolean not null default false,
  is_manual             boolean not null default false,
  is_elapsed            boolean not null default false,
  block_id              uuid references public.blocks (id),
  level_id              uuid references public.levels (id),
  -- current plan (from the file)
  planned_start         date,
  planned_finish        date,
  duration_days         numeric(8,2),
  constraint_type       smallint,
  constraint_date       date,
  deadline              date,
  cost_accrual          text not null default 'prorated' check (cost_accrual in ('prorated','start','end')),
  custom                jsonb not null default '{}'::jsonb,
  msp_critical          boolean,
  msp_total_float_days  numeric(8,2),
  msp_pct_complete      numeric(5,2),
  msp_baseline_start    date,                 -- file baseline (header.baseline_for_ev), dates only
  msp_baseline_finish   date,
  msp_baselines         jsonb not null default '[]'::jsonb,   -- [{number,start,finish,duration_days}]
  -- baseline in force: approved baseline dates (file baseline until one is approved)
  baseline_start        date,
  baseline_finish       date,
  -- progress (verified; maintained by the RPCs)
  ev_method             text not null default 'pct'
                          check (ev_method in ('units','elements','steps','0_100','50_50','pct','milestone','loe')),
  start_pct             numeric(5,2),
  setup_comment         text,
  pct_complete          numeric(5,2) not null default 0 check (pct_complete between 0 and 100),
  reported_pct          numeric(5,2) not null default 0,
  actual_start          date,
  actual_finish         date,
  remaining_days        numeric(8,2),
  progress_as_of        date,
  -- forecast (run_cpm)
  forecast_start        date,
  forecast_finish       date,
  total_float_days      numeric(8,2),
  free_float_days       numeric(8,2),
  is_critical           boolean not null default false,
  fc_status_date        date,
  source_state          text not null default 'active' check (source_state in ('active','removed_in_source')),
  last_version_id       uuid references public.schedule_versions (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  unique (schedule_id, msp_uid)
);
create index schedule_tasks_parent_idx on public.schedule_tasks (parent_id);
create index schedule_tasks_schedule_idx on public.schedule_tasks (schedule_id, sort_order);
create index schedule_tasks_guid_idx on public.schedule_tasks (schedule_id, msp_guid) where msp_guid is not null;

-- Price-restricted: current MSP costs of a task (dropped at import for non-price roles).
create table public.schedule_task_costs (
  task_id             uuid primary key references public.schedule_tasks (id) on delete cascade,
  project_id          uuid not null references public.projects (id) on delete cascade,
  msp_cost            numeric(18,2),
  msp_fixed_cost      numeric(18,2),
  msp_actual_cost     numeric(18,2),
  msp_baseline_cost   numeric(18,2),
  baselines           jsonb not null default '[]'::jsonb,   -- [{number, cost}]
  updated_at          timestamptz not null default now()
);

create table public.schedule_links (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references public.projects (id) on delete cascade,
  schedule_id            uuid not null references public.schedules (id) on delete cascade,
  pred_task_id           uuid not null references public.schedule_tasks (id),
  succ_task_id           uuid not null references public.schedule_tasks (id),
  link_type              text not null default 'FS' check (link_type in ('FS','SS','FF','SF')),
  lag_days               numeric(8,2) not null default 0,     -- working days (negative = lead)
  lag_elapsed            boolean not null default false,
  expanded_from_summary  boolean not null default false,
  version_id             uuid references public.schedule_versions (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  unique (pred_task_id, succ_task_id, link_type),
  check (pred_task_id <> succ_task_id)
);
create index schedule_links_schedule_idx on public.schedule_links (schedule_id) where deleted_at is null;
create index schedule_links_succ_idx on public.schedule_links (succ_task_id);

-- -----------------------------------------------------------------------------
-- Baselines (PMB). All kept; MSP baselines 0–10 are sources, never auto-approved.
-- -----------------------------------------------------------------------------

create table public.schedule_baselines (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects (id) on delete cascade,
  schedule_id          uuid not null references public.schedules (id) on delete cascade,
  baseline_no          int not null,
  name                 text not null,
  source               text not null check (source in ('msp_baseline','current_plan')),
  msp_baseline_number  int,
  from_version_id      uuid references public.schedule_versions (id),
  effective_from       date not null,
  reason               text,
  cost_source          text not null default 'value'
                         check (cost_source in ('value','msp_baseline_cost','budget_lines','value_less_margin')),
  unmapped_value       text not null default 'msp_cost' check (unmapped_value in ('msp_cost','zero')),
  status               text not null default 'proposed' check (status in ('proposed','approved','superseded','rejected')),
  task_count           int not null default 0,
  proposed_by          uuid references public.profiles (id) default auth.uid(),
  proposed_at          timestamptz not null default now(),
  approved_by          uuid references public.profiles (id),
  approved_at          timestamptz,
  decision_comment     text,
  updated_at           timestamptz not null default now(),
  unique (schedule_id, baseline_no)
);
alter table public.schedules add constraint schedules_baseline_fk
  foreign key (approved_baseline_id) references public.schedule_baselines (id) on delete set null;

create table public.schedule_baseline_tasks (
  baseline_id       uuid not null references public.schedule_baselines (id) on delete cascade,
  task_id           uuid not null references public.schedule_tasks (id),
  project_id        uuid not null references public.projects (id) on delete cascade,
  bl_start          date not null,
  bl_finish         date not null,
  bl_duration_days  numeric(8,2) not null default 0,
  accrual           text not null default 'prorated' check (accrual in ('prorated','start','end')),
  is_point          boolean not null default false,       -- milestone / zero duration: earns at finish
  updated_at        timestamptz not null default now(),
  primary key (baseline_id, task_id)
);

-- Price-restricted BAC per task: value (contract / BoQ) basis and cost basis.
create table public.schedule_baseline_task_costs (
  baseline_id  uuid not null,
  task_id      uuid not null,
  project_id   uuid not null references public.projects (id) on delete cascade,
  bac_value    numeric(18,2) not null default 0,
  bac_cost     numeric(18,2) not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (baseline_id, task_id),
  foreign key (baseline_id, task_id) references public.schedule_baseline_tasks (baseline_id, task_id) on delete cascade
);

-- -----------------------------------------------------------------------------
-- Mapping: BoQ, elements, steps
-- -----------------------------------------------------------------------------

create table public.task_boq_links (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  task_id       uuid not null references public.schedule_tasks (id),
  boq_item_id   uuid not null references public.boq_items (id),
  qty_share     numeric(16,3) not null default 0 check (qty_share >= 0),   -- BoQ quantity (item unit) delivered by this task
  reported_qty  numeric(16,3) not null default 0,     -- latest reported cumulative
  verified_qty  numeric(16,3) not null default 0,     -- latest verified cumulative
  source        text not null default 'ui' check (source in ('file','auto','ui','suggested')),  -- auto = share split by the system
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (task_id, boq_item_id)
);
create index task_boq_links_boq_idx on public.task_boq_links (boq_item_id);

create table public.task_element_links (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects (id) on delete cascade,
  task_id            uuid not null references public.schedule_tasks (id),
  element_id         uuid not null references public.elements (id),
  weight             numeric(12,4),          -- null = 1
  activity_seq_from  int,                    -- optional: only some activities of the element belong to this task
  activity_seq_to    int,
  source             text not null default 'ui' check (source in ('file','ui','suggested')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  unique (task_id, element_id)
);
create index task_element_links_element_idx on public.task_element_links (element_id);

create table public.task_steps (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  task_id       uuid not null references public.schedule_tasks (id),
  seq           int not null,
  name          text not null,
  weight        numeric(6,2) not null check (weight > 0),
  reported_pct  numeric(5,2) not null default 0,
  verified_pct  numeric(5,2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index task_steps_seq_idx on public.task_steps (task_id, seq) where deleted_at is null;

-- -----------------------------------------------------------------------------
-- Progress (append-only reports; the verify transition is the only update)
-- -----------------------------------------------------------------------------

create table public.task_progress (
  id                      uuid primary key,
  project_id              uuid not null references public.projects (id),
  task_id                 uuid not null references public.schedule_tasks (id),
  status_date             date not null,          -- progress as of the end of this day
  original_status_date    date,                   -- set when a late report was rolled past a closed cut-off
  rolled_from_period_id   uuid,                   -- that closed period
  method                  text not null,
  pct_complete            numeric(5,2) check (pct_complete between 0 and 100),
  qty_done                numeric(16,3),          -- cumulative qty (single-BoQ-link tasks; sum otherwise)
  qty                     jsonb,                  -- [{boq_item_id, qty_to_date}] cumulative
  steps                   jsonb,                  -- [{step_id, done_pct}]
  remaining_days          numeric(8,2),
  actual_start            date,
  actual_finish           date,
  delay_cause             text,
  remarks                 text,
  source                  text not null default 'field' check (source in ('field','office','import')),
  status                  text not null default 'reported' check (status in ('reported','verified','adjusted','rejected')),
  verified_pct            numeric(5,2),
  verified_qty            jsonb,
  verified_steps          jsonb,
  verified_actual_start   date,
  verified_actual_finish  date,
  verified_remaining_days numeric(8,2),
  reported_by             uuid not null references public.profiles (id),
  verified_by             uuid references public.profiles (id),
  verified_at             timestamptz,
  verify_comment          text,
  device_id               uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index task_progress_task_idx on public.task_progress (task_id, status_date);
create index task_progress_pending_idx on public.task_progress (project_id) where status = 'reported';

-- -----------------------------------------------------------------------------
-- Periods & immutable snapshots
-- -----------------------------------------------------------------------------

create table public.evm_periods (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id) on delete cascade,
  schedule_id       uuid not null references public.schedules (id) on delete cascade,
  period_no         int not null,
  kind              text not null default 'monthly' check (kind in ('weekly','monthly')),
  period_start      date not null,
  status_date       date not null,
  status            text not null default 'open' check (status in ('open','prepared','closed')),
  baseline_id       uuid references public.schedule_baselines (id),
  prepared_summary  jsonb,                    -- ratios, bands, blocking issues (no money)
  prepared_by       uuid references public.profiles (id),
  prepared_at       timestamptz,
  closed_by         uuid references public.profiles (id),
  closed_at         timestamptz,
  close_comment     text,
  reopened_reason   text,
  reopen_count      int not null default 0,
  created_by        uuid references public.profiles (id) default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (schedule_id, kind, period_no),
  check (status_date >= period_start)
);

-- Non-price snapshot: safe for every member (mobile).
create table public.evm_task_status (
  id                uuid primary key default gen_random_uuid(),
  period_id         uuid not null references public.evm_periods (id),
  project_id        uuid not null references public.projects (id) on delete cascade,
  task_id           uuid references public.schedule_tasks (id),   -- null = project
  level             text not null check (level in ('task','wbs','project')),
  pct_planned       numeric(7,3),
  pct_earned        numeric(7,3),
  spi               numeric(8,4),
  spi_t             numeric(8,4),
  sv_t_days         numeric(8,2),
  forecast_start    date,
  forecast_finish   date,
  total_float_days  numeric(8,2),
  is_critical       boolean,
  actual_start      date,
  actual_finish     date,
  updated_at        timestamptz not null default now(),
  unique nulls not distinct (period_id, task_id)
);

-- Money snapshot: price-restricted.
create table public.evm_snapshots (
  id              uuid primary key default gen_random_uuid(),
  period_id       uuid not null references public.evm_periods (id),
  project_id      uuid not null references public.projects (id) on delete cascade,
  task_id         uuid references public.schedule_tasks (id),     -- null = project
  level           text not null check (level in ('task','wbs','project')),
  bac             numeric(18,2), pv numeric(18,2), ev numeric(18,2), ac numeric(18,2),
  bac_value       numeric(18,2), pv_value numeric(18,2), ev_value numeric(18,2),
  sv              numeric(18,2), cv numeric(18,2), spi numeric(8,4), cpi numeric(8,4),
  eac             numeric(18,2), etc numeric(18,2), vac numeric(18,2), tcpi numeric(8,4),
  ac_unallocated  numeric(18,2), es_days numeric(10,2), spi_t numeric(8,4),
  updated_at      timestamptz not null default now(),
  unique nulls not distinct (period_id, task_id)
);

-- BoQ quantities at the cut-off: basis of the monthly valuation / IPC (no money).
create table public.period_boq_progress (
  period_id        uuid not null references public.evm_periods (id),
  boq_item_id      uuid not null references public.boq_items (id),
  project_id       uuid not null references public.projects (id) on delete cascade,
  qty_contract     numeric(16,3) not null default 0,
  qty_to_date      numeric(16,3) not null,
  qty_previous     numeric(16,3) not null default 0,
  qty_this_period  numeric(16,3) not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (period_id, boq_item_id)
);

create table public.evm_variance_notes (
  id                 uuid primary key,
  project_id         uuid not null references public.projects (id) on delete cascade,
  period_id          uuid not null references public.evm_periods (id),
  task_id            uuid references public.schedule_tasks (id),   -- WBS node or null = project
  indicator          text not null,                                 -- spi | cpi | spi_t | tcpi | other
  cause              text not null,
  impact             text,
  corrective_action  text,
  owner_id           uuid references public.profiles (id),
  due_date           date,
  created_by         uuid references public.profiles (id) default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Actual cost: cost entries (price), resource usage (qty only), rates (price)
-- -----------------------------------------------------------------------------

create table public.cost_entries (
  id                    uuid primary key,
  project_id            uuid not null references public.projects (id),
  number                text not null unique,           -- <PRJ>-CE-<DEV>-<SEQ>
  entry_date            date not null,                  -- work / accrual date
  original_entry_date   date,                           -- when rolled past a closed cut-off
  relates_to_period_id  uuid references public.evm_periods (id),
  category              text not null check (category in ('labour','equipment','subcontract','material_direct','overhead','other')),
  task_id               uuid references public.schedule_tasks (id),   -- leaf or summary (WBS-level allocation)
  boq_item_id           uuid references public.boq_items (id),
  element_id            uuid references public.elements (id),
  description           text not null,
  supplier_id           uuid references public.suppliers (id),
  subcontractor         text,
  qty                   numeric(16,3),
  uom                   text,
  rate                  numeric(18,4),
  amount                numeric(18,2) not null,          -- ex-VAT; negative = reversal
  source                text not null default 'manual' check (source in ('manual','diary_estimate','import','payroll','invoice')),
  source_ref            text,
  is_estimate           boolean not null default false,
  reversal_of           uuid references public.cost_entries (id),
  created_by            uuid references public.profiles (id) default auth.uid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index cost_entries_project_idx on public.cost_entries (project_id, entry_date);
create unique index cost_entries_one_reversal on public.cost_entries (reversal_of) where reversal_of is not null;

create table public.resource_usage (
  id             uuid primary key,
  project_id     uuid not null references public.projects (id),
  usage_date     date not null,
  kind           text not null check (kind in ('labour','equipment','subcontract')),
  task_id        uuid references public.schedule_tasks (id),
  trade_id       uuid references public.labour_trades (id),
  equipment      text,
  subcontractor  text,
  boq_item_id    uuid references public.boq_items (id),
  qty            numeric(16,3) not null check (qty > 0),     -- man-hours, machine-hours, m³ …
  uom            text not null,
  diary_id       uuid references public.site_diaries (id),
  remarks        text,
  created_by     uuid references public.profiles (id) default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.cost_rates (
  id             uuid primary key,
  project_id     uuid references public.projects (id) on delete cascade,   -- null = company-wide
  kind           text not null check (kind in ('labour','equipment','subcontract')),
  trade_id       uuid references public.labour_trades (id),
  equipment      text,
  subcontractor  text,
  boq_item_id    uuid references public.boq_items (id),
  uom            text not null,
  rate           numeric(18,4) not null check (rate >= 0),
  valid_from     date not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Triggers, indexes, RLS
-- -----------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'public_holidays','project_calendars','calendar_exceptions','schedules','schedule_versions','schedule_tasks',
    'schedule_task_costs','schedule_links','schedule_baselines','schedule_baseline_tasks','schedule_baseline_task_costs',
    'task_boq_links','task_element_links','task_steps','task_progress','evm_periods','evm_task_status','evm_snapshots',
    'period_boq_progress','evm_variance_notes','cost_entries','resource_usage','cost_rates'
  ] loop
    execute format('create index %I on public.%I (updated_at)', t || '_updated_at_idx', t);
    execute format('create trigger touch_updated_at before update on public.%I
                    for each row execute function app.touch_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;

  foreach t in array array['public_holidays','project_calendars','calendar_exceptions','schedules','schedule_baselines',
    'evm_periods','task_boq_links','task_element_links','task_steps','cost_entries','cost_rates','evm_variance_notes'] loop
    execute format('create trigger audit after insert or update or delete on public.%I
                    for each row execute function app.audit()', t);
  end loop;

  foreach t in array array['schedule_versions','schedule_baselines','evm_periods','task_progress'] loop
    execute format('create trigger no_delete before delete on public.%I
                    for each row execute function app.block_mutation()', t);
  end loop;

  -- members read quantity / date tables (mobile-safe)
  foreach t in array array['project_calendars','calendar_exceptions','schedules','schedule_versions','schedule_tasks',
    'schedule_links','schedule_baselines','schedule_baseline_tasks','task_boq_links','task_element_links','task_steps',
    'task_progress','evm_periods','evm_task_status','period_boq_progress','evm_variance_notes','resource_usage'] loop
    execute format('create policy member_read on public.%I for select to authenticated using (app.is_member(project_id))', t);
  end loop;

  -- money (FR-ACC-03, NFR-05)
  foreach t in array array['schedule_task_costs','schedule_baseline_task_costs','evm_snapshots','cost_entries'] loop
    execute format('create policy price_read on public.%I for select to authenticated
                    using (app.can_see_prices() and app.is_member(project_id))', t);
  end loop;
end $$;

-- EV method changes are audited (they change how EV is measured).
create trigger audit after update of ev_method, start_pct on public.schedule_tasks
  for each row execute function app.audit();

create policy price_read on public.cost_rates for select to authenticated
  using (app.can_see_prices() and (project_id is null or app.is_member(project_id)));

create policy read_all on public.public_holidays for select to authenticated using (app.is_active_user());
create policy mgmt_write on public.public_holidays for all to authenticated
  using (app.has_role('manager','admin')) with check (app.has_role('manager','admin'));

-- Calendars are project master data: engineers / management maintain them directly.
create policy master_write on public.project_calendars for all to authenticated
  using (app.is_member(project_id) and app.has_role('office_engineer','coordinator','manager','admin'))
  with check (app.is_member(project_id) and app.has_role('office_engineer','coordinator','manager','admin'));
create policy master_write on public.calendar_exceptions for all to authenticated
  using (app.is_member(project_id) and app.has_role('office_engineer','coordinator','manager','admin'))
  with check (app.is_member(project_id) and app.has_role('office_engineer','coordinator','manager','admin'));

-- Cost entries are append-only (reversal = negative mirror row).
create trigger immutable before update or delete on public.cost_entries
  for each row execute function app.block_mutation();

-- Progress reports: only the verify transition (reported → verified/adjusted/rejected) may update a row.
create or replace function app.guard_task_progress() returns trigger
language plpgsql as $$
begin
  if old.status <> 'reported' then
    raise exception 'Progress report already % — it cannot be changed', old.status using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_verified before update on public.task_progress
  for each row execute function app.guard_task_progress();

-- Snapshots of a closed period are immutable (reopen_period first moves the period back to open).
create or replace function app.guard_period_snapshot() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.evm_periods where id = coalesce(old.period_id, new.period_id) and status = 'closed') then
    raise exception 'Period is closed — its snapshot cannot be changed (reopen the period first)' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
do $$
declare t text;
begin
  foreach t in array array['evm_task_status','evm_snapshots','period_boq_progress','evm_variance_notes'] loop
    execute format('create trigger guard_closed before insert or update or delete on public.%I
                    for each row execute function app.guard_period_snapshot()', t);
  end loop;
end $$;

-- New projects get a default Mon–Sat calendar with Ethiopian public holidays.
create or replace function app.schedule_project_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.project_calendars (project_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger schedule_defaults after insert on public.projects
  for each row execute function app.schedule_project_defaults();

insert into public.project_calendars (project_id)
select p.id from public.projects p
where not exists (select 1 from public.project_calendars c where c.project_id = p.id and c.is_default and c.deleted_at is null);

-- -----------------------------------------------------------------------------
-- Calendar functions (FIXED INTERFACE: is_working_day / working_days / add_working_days)
-- -----------------------------------------------------------------------------

create or replace function app.project_calendar(p_project uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.project_calendars
  where project_id = p_project and is_default and deleted_at is null limit 1
$$;

-- Exception first → public holiday (if the calendar uses them) → weekday in working_weekdays.
create or replace function app.is_working_day(p_project uuid, p_date date) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_cal uuid; v_wd int[]; v_hol boolean; v_country text; v_exc boolean;
begin
  if p_date is null then return null; end if;
  select id, working_weekdays, use_public_holidays, holiday_country into v_cal, v_wd, v_hol, v_country
    from public.project_calendars where project_id = p_project and is_default and deleted_at is null limit 1;
  if v_cal is null then v_wd := '{1,2,3,4,5,6}'; v_hol := true; v_country := 'ET'; end if;
  if v_cal is not null then
    select is_working into v_exc from public.calendar_exceptions
      where calendar_id = v_cal and on_date = p_date and deleted_at is null;
    if v_exc is not null then return v_exc; end if;
  end if;
  if v_hol and exists (select 1 from public.public_holidays
                       where country = v_country and on_date = p_date and deleted_at is null) then
    return false;
  end if;
  return extract(isodow from p_date)::int = any (v_wd);
end $$;

-- Working days in [p_from, p_to] inclusive (0 when p_to < p_from). O(holidays + exceptions), not O(days).
create or replace function app.working_days(p_project uuid, p_from date, p_to date) returns int
language plpgsql stable security definer set search_path = public as $$
declare
  v_cal uuid; v_wd int[]; v_hol boolean; v_country text;
  v_n int := 0; w int; v_first date; v_dow int;
begin
  if p_from is null or p_to is null or p_to < p_from then return 0; end if;
  select id, working_weekdays, use_public_holidays, holiday_country into v_cal, v_wd, v_hol, v_country
    from public.project_calendars where project_id = p_project and is_default and deleted_at is null limit 1;
  if v_cal is null then v_wd := '{1,2,3,4,5,6}'; v_hol := true; v_country := 'ET'; end if;
  v_dow := extract(isodow from p_from)::int;
  for w in select distinct x from unnest(v_wd) x loop
    v_first := p_from + ((w - v_dow + 7) % 7);
    if v_first <= p_to then v_n := v_n + (p_to - v_first) / 7 + 1; end if;
  end loop;
  if v_hol then
    v_n := v_n - (select count(distinct h.on_date)::int from public.public_holidays h
                  where h.country = v_country and h.deleted_at is null and h.on_date between p_from and p_to
                    and extract(isodow from h.on_date)::int = any (v_wd)
                    and not exists (select 1 from public.calendar_exceptions e
                                    where e.calendar_id = v_cal and e.on_date = h.on_date and e.deleted_at is null));
  end if;
  if v_cal is not null then
    v_n := v_n + coalesce((
      select sum((case when e.is_working then 1 else 0 end)
               - (case when extract(isodow from e.on_date)::int = any (v_wd)
                        and not (v_hol and exists (select 1 from public.public_holidays h
                                 where h.country = v_country and h.on_date = e.on_date and h.deleted_at is null))
                       then 1 else 0 end))::int
      from public.calendar_exceptions e
      where e.calendar_id = v_cal and e.deleted_at is null and e.on_date between p_from and p_to), 0);
  end if;
  return v_n;
end $$;

-- p_n working days after p_date (negative = before; 0 = p_date itself).
create or replace function app.add_working_days(p_project uuid, p_date date, p_n int) returns date
language plpgsql stable security definer set search_path = public as $$
declare d date := p_date; k int := 0; v_step int; v_guard int := 0;
begin
  if p_date is null or p_n is null then return null; end if;
  if p_n = 0 then return p_date; end if;
  v_step := sign(p_n)::int;
  while k < abs(p_n) loop
    d := d + v_step;
    if app.is_working_day(p_project, d) then k := k + 1; end if;
    v_guard := v_guard + 1;
    if v_guard > 40000 then raise exception 'The project calendar has no working days'; end if;
  end loop;
  return d;
end $$;

-- Capacity of a day 0..1 (saturday_factor, reduced exception days). For look-ahead / PPC maths.
create or replace function app.day_capacity(p_project uuid, p_date date) returns numeric
language sql stable security definer set search_path = public as $$
  select case when not app.is_working_day(p_project, p_date) then 0::numeric
    else coalesce((select e.factor from public.calendar_exceptions e
                   join public.project_calendars c on c.id = e.calendar_id
                   where c.project_id = p_project and c.is_default and c.deleted_at is null
                     and e.on_date = p_date and e.deleted_at is null and e.is_working),
                  case when extract(isodow from p_date) = 6
                       then (select c.saturday_factor from public.project_calendars c
                             where c.project_id = p_project and c.is_default and c.deleted_at is null) end,
                  1::numeric) end
$$;

-- Sorted working dates in a range (one query; used for working-day indices).
create or replace function app.working_dates(p_project uuid, p_from date, p_to date) returns date[]
language sql stable security definer set search_path = public as $$
  with c as (
    select pc.id, coalesce(pc.working_weekdays, '{1,2,3,4,5,6}'::int[]) as wd, coalesce(pc.use_public_holidays, true) as hol,
           coalesce(pc.holiday_country, 'ET') as country
    from (select 1) one
    left join public.project_calendars pc on pc.project_id = p_project and pc.is_default and pc.deleted_at is null
  ), g as (select p_from + i as d from generate_series(0, greatest(p_to - p_from, -1)) i)
  select coalesce(array_agg(g.d order by g.d), '{}'::date[])
  from g cross join c
  left join public.calendar_exceptions e on e.calendar_id = c.id and e.on_date = g.d and e.deleted_at is null
  where coalesce(e.is_working,
          case when c.hol and exists (select 1 from public.public_holidays h
                                      where h.country = c.country and h.on_date = g.d and h.deleted_at is null) then false
               else extract(isodow from g.d)::int = any (c.wd) end)
$$;

-- Number of entries of a sorted date array that are <= p_d (= working-day index of p_d).
create or replace function app.date_idx(p_days date[], p_d date) returns int
language plpgsql immutable as $$
declare lo int := 1; hi int; mid int;
begin
  hi := coalesce(array_length(p_days, 1), 0);
  if hi = 0 or p_d is null or p_d < p_days[1] then return 0; end if;
  if p_d >= p_days[hi] then return hi; end if;
  while lo < hi loop
    mid := (lo + hi + 1) / 2;
    if p_days[mid] <= p_d then lo := mid; else hi := mid - 1; end if;
  end loop;
  return lo;
end $$;

create or replace function app.idx_date(p_project uuid, p_days date[], p_i int) returns date
language plpgsql stable as $$
declare n int := coalesce(array_length(p_days, 1), 0);
begin
  if p_i is null or n = 0 then return null; end if;
  if p_i between 1 and n then return p_days[p_i]; end if;
  if p_i > n then return app.add_working_days(p_project, p_days[n], p_i - n); end if;
  return app.add_working_days(p_project, p_days[1], p_i - 1);
end $$;

-- -----------------------------------------------------------------------------
-- Small EVM helpers
-- -----------------------------------------------------------------------------

create or replace function app.evm_cfg(p_project uuid) returns public.project_settings
language sql stable security definer set search_path = public as $$
  select * from public.project_settings where project_id = p_project
$$;

-- Last closed cut-off (status date) of a project; progress / costs on or before it roll forward.
create or replace function app.closed_cutoff(p_project uuid) returns date
language sql stable security definer set search_path = public as $$
  select max(status_date) from public.evm_periods where project_id = p_project and status = 'closed'
$$;
create or replace function app.closed_period_for(p_project uuid, p_date date) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.evm_periods where project_id = p_project and status = 'closed' and status_date >= p_date
  order by status_date, period_start limit 1
$$;

-- Traffic-light band of an index (SPI, CPI, SPI(t)) from project thresholds.
create or replace function app.idx_band(p_project uuid, p_v numeric) returns text
language sql stable security definer set search_path = public as $$
  select case when p_v is null then null
    when p_v < coalesce((t ->> 'idx_crit')::numeric, 0.90) then 'critical'
    when p_v < coalesce((t ->> 'idx_warn')::numeric, 0.95) then 'warning'
    when p_v > coalesce((t ->> 'idx_high')::numeric, 1.15) then 'info'
    else 'ok' end
  from (select coalesce((select evm_thresholds from public.project_settings where project_id = p_project), '{}'::jsonb) as t) x
$$;

create type app.evm_ratio as (
  sv numeric, cv numeric, spi numeric, cpi numeric, eac numeric, etc numeric, vac numeric,
  tcpi numeric, tcpi_eac numeric, pct_planned numeric, pct_earned numeric, eac_fallback boolean
);

-- Standard indicators (PMBOK / ANSI-748). EAC default = AC + (BAC − EV)/CPI (= BAC/CPI); falls back to
-- AC + (BAC − EV) while EV/BAC < evm_eac_min_pct or CPI is undefined.
create or replace function app.evm_calc(p_bac numeric, p_pv numeric, p_ev numeric, p_ac numeric,
  p_method text default 'cpi', p_min_pct numeric default 10) returns app.evm_ratio
language plpgsql immutable as $$
declare r app.evm_ratio; v_fb boolean;
begin
  p_bac := coalesce(p_bac, 0); p_pv := coalesce(p_pv, 0); p_ev := coalesce(p_ev, 0); p_ac := coalesce(p_ac, 0);
  r.sv := round(p_ev - p_pv, 2);
  r.cv := round(p_ev - p_ac, 2);
  r.spi := case when p_pv <> 0 then round(p_ev / p_pv, 4) end;
  r.cpi := case when p_ac <> 0 then round(p_ev / p_ac, 4) end;
  v_fb := p_bac = 0 or p_ac = 0 or p_ev <= 0 or (100 * p_ev / p_bac) < coalesce(p_min_pct, 10)
          or (coalesce(p_method, 'cpi') = 'cpi_spi' and coalesce(p_pv, 0) = 0);
  r.eac_fallback := v_fb and coalesce(p_method, 'cpi') <> 'budget_rate';
  r.eac := round(case
    when coalesce(p_method, 'cpi') = 'budget_rate' or v_fb then p_ac + (p_bac - p_ev)
    when p_method = 'cpi_spi' then p_ac + (p_bac - p_ev) / ((p_ev / p_ac) * (p_ev / p_pv))
    else p_ac + (p_bac - p_ev) / (p_ev / p_ac) end, 2);
  r.etc := round(r.eac - p_ac, 2);
  r.vac := round(p_bac - r.eac, 2);
  r.tcpi := case when p_bac - p_ac <> 0 then round((p_bac - p_ev) / (p_bac - p_ac), 4) end;
  r.tcpi_eac := case when r.eac - p_ac <> 0 then round((p_bac - p_ev) / (r.eac - p_ac), 4) end;
  r.pct_planned := case when p_bac <> 0 then round(100 * p_pv / p_bac, 3) end;
  r.pct_earned := case when p_bac <> 0 then round(100 * p_ev / p_bac, 3) end;
  return r;
end $$;

-- PV fraction of a baseline task at status date s: linear over working days of [bs, bf]
-- (calendar days for elapsed tasks); 'start' / 'end' accrual and milestones are step functions.
create or replace function app.pv_fraction(p_project uuid, p_bs date, p_bf date, p_accrual text,
  p_point boolean, p_elapsed boolean, p_s date) returns numeric
language plpgsql stable as $$
declare v_tot int;
begin
  if p_bs is null or p_bf is null or p_s is null then return 0; end if;
  if p_accrual = 'start' then return case when p_s >= p_bs then 1 else 0 end; end if;
  if p_accrual = 'end' or coalesce(p_point, false) then return case when p_s >= p_bf then 1 else 0 end; end if;
  if p_s < p_bs then return 0; end if;
  if p_s >= p_bf then return 1; end if;
  if coalesce(p_elapsed, false) then
    return (p_s - p_bs + 1)::numeric / nullif(p_bf - p_bs + 1, 0);
  end if;
  v_tot := app.working_days(p_project, p_bs, p_bf);
  if v_tot = 0 then return 0; end if;
  return least(1, app.working_days(p_project, p_bs, p_s)::numeric / v_tot);
end $$;

-- Percent from cumulative quantities, weighted by BoQ rate (equal weights where no rate).
-- Links missing from p_qty use their current verified quantity. Returns a percentage only.
create or replace function app.units_pct(p_task uuid, p_qty jsonb) returns numeric
language sql stable security definer set search_path = public as $$
  with q as (
    select x.boq_item_id, max(x.qty_to_date) as qty
    from jsonb_to_recordset(coalesce(p_qty, '[]'::jsonb)) as x(boq_item_id uuid, qty_to_date numeric)
    group by x.boq_item_id)
  select round(coalesce(100 * sum(least(greatest(coalesce(q.qty, l.verified_qty), 0), l.qty_share) * coalesce(r.rate, 1))
                          / nullif(sum(l.qty_share * coalesce(r.rate, 1)), 0), 0), 3)
  from public.task_boq_links l
  left join q on q.boq_item_id = l.boq_item_id
  left join public.boq_rates r on r.boq_item_id = l.boq_item_id
  where l.task_id = p_task and l.deleted_at is null
$$;

create or replace function app.steps_pct(p_task uuid, p_steps jsonb) returns numeric
language sql stable security definer set search_path = public as $$
  with x as (
    select y.step_id, max(y.done_pct) as done
    from jsonb_to_recordset(coalesce(p_steps, '[]'::jsonb)) as y(step_id uuid, done_pct numeric) group by y.step_id)
  select round(coalesce(sum(s.weight * least(greatest(coalesce(x.done, s.verified_pct), 0), 100)) / nullif(sum(s.weight), 0), 0), 3)
  from public.task_steps s left join x on x.step_id = s.id
  where s.task_id = p_task and s.deleted_at is null
$$;

-- Earned % of a leaf task as of s, VERIFIED data only. 'loe' is handled by the caller (EV = PV).
create or replace function app.task_earned_pct(p_task uuid, p_s date) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare t public.schedule_tasks; v numeric;
begin
  select * into t from public.schedule_tasks where id = p_task;
  if not found then return 0; end if;
  if t.ev_method = 'units' and exists (select 1 from public.task_boq_links where task_id = p_task and deleted_at is null) then
    with q as (
      select distinct on (x.boq_item_id) x.boq_item_id, x.qty_to_date
      from public.task_progress tp, jsonb_to_recordset(coalesce(tp.verified_qty, '[]'::jsonb)) as x(boq_item_id uuid, qty_to_date numeric)
      where tp.task_id = p_task and tp.status in ('verified','adjusted') and tp.status_date <= p_s
      order by x.boq_item_id, tp.status_date desc, tp.verified_at desc)
    select 100 * sum(least(greatest(coalesce(q.qty_to_date, 0), 0), l.qty_share) * coalesce(r.rate, 1))
             / nullif(sum(l.qty_share * coalesce(r.rate, 1)), 0)
      into v
      from public.task_boq_links l
      left join q on q.boq_item_id = l.boq_item_id
      left join public.boq_rates r on r.boq_item_id = l.boq_item_id
      where l.task_id = p_task and l.deleted_at is null;
  elsif t.ev_method = 'elements' and exists (select 1 from public.task_element_links where task_id = p_task and deleted_at is null) then
    select sum(z.w * z.pe) / nullif(sum(z.w), 0) into v from (
      select coalesce(el.weight, 1) as w,
             (select coalesce(sum(a.weight * coalesce(lu.vpct, 0)) / nullif(sum(a.weight), 0), 0)
                from public.element_activities a
                left join lateral (select pu.verified_pct as vpct from public.progress_updates pu
                   where pu.element_activity_id = a.id and pu.status in ('verified','adjusted') and pu.report_date <= p_s
                   order by pu.report_date desc, pu.verified_at desc limit 1) lu on true
               where a.element_id = el.element_id
                 and a.seq between coalesce(el.activity_seq_from, a.seq) and coalesce(el.activity_seq_to, a.seq)) as pe
      from public.task_element_links el where el.task_id = p_task and el.deleted_at is null) z;
  elsif t.ev_method = 'loe' then
    return null;
  else
    -- pct / 0_100 / 50_50 / milestone / steps: the verify RPC stores the earned % in verified_pct
    select tp.verified_pct into v from public.task_progress tp
     where tp.task_id = p_task and tp.status in ('verified','adjusted') and tp.status_date <= p_s
     order by tp.status_date desc, tp.verified_at desc limit 1;
  end if;
  return round(least(100, greatest(0, coalesce(v, 0))), 3);
end $$;

-- Summary rows: forecast/actual/baseline windows, float and duration-weighted % from their children.
create or replace function app.rollup_summaries(p_schedule uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_lvl int;
begin
  for v_lvl in select distinct outline_level from public.schedule_tasks
               where schedule_id = p_schedule and is_summary and deleted_at is null order by 1 desc loop
    update public.schedule_tasks s set
      forecast_start = x.fs, forecast_finish = x.ff, total_float_days = x.tf, is_critical = coalesce(x.cr, false),
      actual_start = x.ast, actual_finish = case when x.all_done then x.afn end,
      pct_complete = least(100, greatest(0, coalesce(x.pct, 0))),
      baseline_start = x.bs, baseline_finish = x.bf
    from (
      select c.parent_id, min(c.forecast_start) fs, max(c.forecast_finish) ff, min(c.total_float_days) tf,
             bool_or(c.is_critical) cr, min(c.actual_start) ast, max(c.actual_finish) afn,
             bool_and(c.actual_finish is not null) all_done,
             coalesce(round(sum(greatest(coalesce(c.duration_days, 0), 0) * c.pct_complete)
                            / nullif(sum(greatest(coalesce(c.duration_days, 0), 0)), 0), 2),
                      round(avg(c.pct_complete), 2)) pct,
             min(c.baseline_start) bs, max(c.baseline_finish) bf
      from public.schedule_tasks c
      where c.schedule_id = p_schedule and c.deleted_at is null and c.parent_id is not null
      group by c.parent_id) x
    where s.id = x.parent_id and s.outline_level = v_lvl and s.is_summary and s.deleted_at is null;
  end loop;
end $$;

-- Current task state (task row) from verified data: % complete, actual dates, remaining duration.
create or replace function app.refresh_task_progress(p_task uuid, p_rollup boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare
  t public.schedule_tasks; lr public.task_progress;
  v_pct numeric := 0; v_as date; v_af date; v_rem numeric; v_asof date; v_rep numeric;
begin
  select * into t from public.schedule_tasks where id = p_task;
  if not found or t.is_summary then return; end if;

  if t.ev_method = 'elements' then
    v_pct := app.task_earned_pct(p_task, 'infinity'::date);
    select min(pu.report_date) filter (where pu.verified_pct > 0), max(pu.report_date) into v_as, v_asof
    from public.task_element_links el
    join public.element_activities a on a.element_id = el.element_id
      and a.seq between coalesce(el.activity_seq_from, a.seq) and coalesce(el.activity_seq_to, a.seq)
    join public.progress_updates pu on pu.element_activity_id = a.id and pu.status in ('verified','adjusted')
    where el.task_id = p_task and el.deleted_at is null;
    v_af := case when v_pct >= 100 then v_asof end;
    v_rep := v_pct;
  elsif t.ev_method = 'loe' then
    v_pct := round(100 * app.pv_fraction(t.project_id, coalesce(t.baseline_start, t.planned_start),
      coalesce(t.baseline_finish, t.planned_finish), 'prorated', false, t.is_elapsed, app.eat_date(now())), 2);
    v_as := case when v_pct > 0 then coalesce(t.baseline_start, t.planned_start) end;
    v_af := case when v_pct >= 100 then coalesce(t.baseline_finish, t.planned_finish) end;
    v_rep := v_pct;
  else
    select * into lr from public.task_progress
      where task_id = p_task and status in ('verified','adjusted') order by status_date desc, verified_at desc limit 1;
    if found then
      v_pct := case when t.ev_method = 'units' then app.task_earned_pct(p_task, 'infinity'::date) else coalesce(lr.verified_pct, 0) end;
      v_asof := lr.status_date;
      select min(coalesce(tp.verified_actual_start, tp.status_date)) into v_as from public.task_progress tp
        where tp.task_id = p_task and tp.status in ('verified','adjusted')
          and (coalesce(tp.verified_pct, 0) > 0 or tp.verified_actual_start is not null);
      v_af := case when v_pct >= 100 then coalesce(lr.verified_actual_finish, lr.status_date) end;
      v_rem := case when v_pct < 100 then lr.verified_remaining_days end;
    end if;
    select tp.pct_complete into v_rep from public.task_progress tp
      where tp.task_id = p_task and tp.status <> 'rejected' order by tp.status_date desc, tp.created_at desc limit 1;
  end if;

  update public.schedule_tasks set
    pct_complete = least(100, greatest(0, round(coalesce(v_pct, 0), 2))),
    reported_pct = least(100, greatest(0, round(coalesce(v_rep, v_pct, 0), 2))),
    actual_start = v_as, actual_finish = v_af, remaining_days = v_rem, progress_as_of = v_asof
  where id = p_task;

  -- current cumulative quantities on the BoQ links
  update public.task_boq_links l set verified_qty = coalesce(q.qty, 0)
  from (select l2.id, (select x.qty_to_date
                       from public.task_progress tp, jsonb_to_recordset(coalesce(tp.verified_qty, '[]'::jsonb)) as x(boq_item_id uuid, qty_to_date numeric)
                       where tp.task_id = p_task and tp.status in ('verified','adjusted') and x.boq_item_id = l2.boq_item_id
                       order by tp.status_date desc, tp.verified_at desc limit 1) as qty
        from public.task_boq_links l2 where l2.task_id = p_task) q
  where l.id = q.id and l.verified_qty is distinct from coalesce(q.qty, 0) and t.ev_method = 'units';

  if p_rollup then perform app.rollup_summaries(t.schedule_id); end if;
end $$;

-- Verified element progress drives element-linked tasks (no double reporting for site engineers).
create or replace function app.element_activity_progress_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.verified_pct is distinct from old.verified_pct then
    for r in select distinct l.task_id from public.task_element_links l
             join public.schedule_tasks t on t.id = l.task_id
             where l.element_id = new.element_id and l.deleted_at is null and t.deleted_at is null and t.ev_method = 'elements' loop
      perform app.refresh_task_progress(r.task_id);
    end loop;
  end if;
  return new;
end $$;
create trigger schedule_task_progress after update of verified_pct on public.element_activities
  for each row execute function app.element_activity_progress_changed();

-- Leaf descendants of a task (itself if it is a leaf).
create or replace function app.leaf_tasks_under(p_task uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
  with recursive d as (
    select id, is_summary from public.schedule_tasks where id = p_task
    union all
    select c.id, c.is_summary from public.schedule_tasks c join d on c.parent_id = d.id where c.deleted_at is null)
  select id from d where not is_summary
$$;

create or replace function app.default_ev_method(p_task uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when t.is_summary then 'pct'
    when exists (select 1 from public.task_element_links where task_id = t.id and deleted_at is null) then 'elements'
    when exists (select 1 from public.task_boq_links where task_id = t.id and deleted_at is null) then 'units'
    when t.is_milestone then '0_100'
    when t.name ~* '(prelim|general items|site overhead|supervision|site establishment)' then 'loe'
    when coalesce(t.duration_days, 0) <= coalesce(ps.evm_short_task_days, 6) then '0_100'
    else 'pct' end
  from public.schedule_tasks t left join public.project_settings ps on ps.project_id = t.project_id
  where t.id = p_task
$$;

-- BoQ / element mapping from text: BoQ '02.03;02.04=120' (optional qty after '='),
-- elements 'C1;C2@GF' (code, optionally @level code). Existing links are kept unless p_wins.
create or replace function app.apply_task_mapping(p_task uuid, p_boq text, p_elem text, p_wins boolean, p_source text default 'file')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t public.schedule_tasks; tok text; v_code text; v_qty numeric; v_item uuid; v_lvl text;
  v_warn jsonb := '[]'::jsonb; v_nb int := 0; v_ne int := 0; v_items uuid[] := '{}'; v_elems uuid[] := '{}'; v_e uuid;
begin
  select * into t from public.schedule_tasks where id = p_task;
  if not found or t.is_summary then return jsonb_build_object('boq', 0, 'elements', 0, 'warnings', v_warn); end if;

  if coalesce(trim(p_boq), '') <> '' and (p_wins or not exists (
       select 1 from public.task_boq_links where task_id = p_task and deleted_at is null)) then
    foreach tok in array regexp_split_to_array(p_boq, '\s*[;,]\s*') loop
      continue when coalesce(trim(tok), '') = '';
      v_code := trim(split_part(tok, '=', 1));
      v_qty := nullif(trim(split_part(tok, '=', 2)), '')::numeric;
      select id into v_item from public.boq_items
        where project_id = t.project_id and deleted_at is null and lower(item_no) = lower(v_code);
      if v_item is null then
        v_warn := v_warn || to_jsonb(format('Task %s "%s": BoQ item %s not found', t.msp_uid, t.name, v_code));
        continue;
      end if;
      insert into public.task_boq_links (project_id, task_id, boq_item_id, qty_share, source)
      values (t.project_id, p_task, v_item, coalesce(v_qty, 0), case when v_qty is null then 'auto' else p_source end)
      on conflict (task_id, boq_item_id) do update
        set qty_share = excluded.qty_share, source = excluded.source, deleted_at = null;
      v_items := v_items || v_item; v_nb := v_nb + 1;
    end loop;
    if p_wins then
      update public.task_boq_links set deleted_at = now()
        where task_id = p_task and deleted_at is null and boq_item_id <> all (v_items);
    end if;
  end if;

  if coalesce(trim(p_elem), '') <> '' and (p_wins or not exists (
       select 1 from public.task_element_links where task_id = p_task and deleted_at is null)) then
    foreach tok in array regexp_split_to_array(p_elem, '\s*[;,]\s*') loop
      continue when coalesce(trim(tok), '') = '';
      v_code := trim(split_part(tok, '@', 1));
      v_lvl := nullif(trim(split_part(tok, '@', 2)), '');
      v_e := null;
      for v_e in select e.id from public.elements e left join public.levels lv on lv.id = e.level_id
                 where e.project_id = t.project_id and e.deleted_at is null and lower(e.code) = lower(v_code)
                   and (v_lvl is null or lower(lv.code) = lower(v_lvl)) loop
        insert into public.task_element_links (project_id, task_id, element_id, source)
        values (t.project_id, p_task, v_e, case when p_source = 'auto' then 'file' else p_source end)
        on conflict (task_id, element_id) do update set deleted_at = null;
        v_elems := v_elems || v_e; v_ne := v_ne + 1;
      end loop;
      if v_e is null then
        v_warn := v_warn || to_jsonb(format('Task %s "%s": element %s not found', t.msp_uid, t.name, tok));
      end if;
    end loop;
    if p_wins then
      update public.task_element_links set deleted_at = now()
        where task_id = p_task and deleted_at is null and element_id <> all (v_elems);
    end if;
  end if;
  return jsonb_build_object('boq', v_nb, 'elements', v_ne, 'warnings', v_warn, 'boq_items', to_jsonb(v_items));
end $$;

-- Links without an explicit quantity ('auto') share what is left of the BoQ quantity, by task duration.
create or replace function app.redistribute_auto_qty(p_items uuid[]) returns void
language sql security definer set search_path = public as $$
  with it as (
    select b.id, b.quantity,
           coalesce((select sum(l.qty_share) from public.task_boq_links l
                     where l.boq_item_id = b.id and l.deleted_at is null and l.source <> 'auto'), 0) as fixed
    from public.boq_items b where b.id = any (p_items)),
  au as (
    select l.id, l.boq_item_id, greatest(coalesce(t.duration_days, 0), 0) as dur,
           count(*) over (partition by l.boq_item_id) as n,
           sum(greatest(coalesce(t.duration_days, 0), 0)) over (partition by l.boq_item_id) as tot
    from public.task_boq_links l join public.schedule_tasks t on t.id = l.task_id and t.deleted_at is null
    where l.boq_item_id = any (p_items) and l.deleted_at is null and l.source = 'auto')
  update public.task_boq_links l
     set qty_share = round(greatest(it.quantity - it.fixed, 0) * case when au.tot > 0 then au.dur / au.tot else 1.0 / au.n end, 3)
  from au join it on it.id = au.boq_item_id
  where l.id = au.id
$$;

-- -----------------------------------------------------------------------------
-- Actual cost: material issues allocated to tasks + cost entries
-- -----------------------------------------------------------------------------

-- Issued materials valued exactly like v_cost_control (project average received cost from GRN × PO
-- price, spec_prices fallback). Allocation: tasks linked to the issue's element AND BoQ item → element
-- → BoQ item, pro rata by link weight / qty; no match → unallocated (task_id null). INTERNAL (money).
create or replace function app.material_alloc(p_project uuid)
returns table (project_id uuid, ledger_id uuid, txn_date date, element_id uuid, material_spec_id uuid,
               boq_item_id uuid, task_id uuid, share numeric, qty numeric, amount numeric)
language sql stable security definer set search_path = public as $$
  with recv as (
    select gl.material_spec_id, gl.qty_accepted, coalesce(pr.unit_price, spp.unit_price) as unit_cost
    from public.grn_lines gl
    join public.grns g on g.id = gl.grn_id and g.status = 'posted'
    left join public.po_line_prices pr on pr.po_line_id = gl.po_line_id
    left join public.spec_prices spp on spp.material_spec_id = gl.material_spec_id
    where gl.project_id = p_project),
  avg_cost as (
    select material_spec_id, sum(qty_accepted * unit_cost) / nullif(sum(qty_accepted), 0) as unit_cost
    from recv where unit_cost is not null group by material_spec_id),
  led as (
    select l.id, l.project_id, app.eat_date(l.txn_at) as txn_date, l.element_id, l.material_spec_id,
           coalesce(ml.boq_item_id, et.boq_item_id) as boq_item_id, -l.qty as qty,
           -l.qty * coalesce(ac.unit_cost, spp.unit_price) as amount
    from public.stock_ledger l
    left join public.mr_lines ml on ml.id = l.mr_line_id
    left join public.element_takeoffs et on et.element_id = l.element_id and et.material_spec_id = l.material_spec_id
      and et.deleted_at is null
    left join avg_cost ac on ac.material_spec_id = l.material_spec_id
    left join public.spec_prices spp on spp.material_spec_id = l.material_spec_id
    where l.project_id = p_project and l.doc_type in ('miv','mrn')),
  tk as (
    select t.id from public.schedule_tasks t join public.schedules s on s.id = t.schedule_id and s.status = 'active'
    where t.project_id = p_project and t.deleted_at is null and not t.is_summary),
  el as (select x.task_id, x.element_id, coalesce(x.weight, 1) as w from public.task_element_links x
         join tk on tk.id = x.task_id where x.deleted_at is null),
  bl as (select x.task_id, x.boq_item_id, coalesce(nullif(x.qty_share, 0), 1) as w from public.task_boq_links x
         join tk on tk.id = x.task_id where x.deleted_at is null),
  cand as (
    select led.id as ledger_id, 1 as lvl, el.task_id, bl.w from led
      join el on el.element_id = led.element_id
      join bl on bl.task_id = el.task_id and bl.boq_item_id = led.boq_item_id
    union all
    select led.id, 2, el.task_id, el.w from led join el on el.element_id = led.element_id
    union all
    select led.id, 3, bl.task_id, bl.w from led join bl on bl.boq_item_id = led.boq_item_id),
  best as (select ledger_id, min(lvl) as lvl from cand group by ledger_id),
  pick as (
    select c.ledger_id, c.task_id, c.w / sum(c.w) over (partition by c.ledger_id) as share
    from cand c join best b on b.ledger_id = c.ledger_id and b.lvl = c.lvl)
  select led.project_id, led.id, led.txn_date, led.element_id, led.material_spec_id, led.boq_item_id,
         pick.task_id, coalesce(pick.share, 1), round(led.qty * coalesce(pick.share, 1), 3),
         round(led.amount * coalesce(pick.share, 1), 2)
  from led left join pick on pick.ledger_id = led.id
$$;

-- All actual-cost rows of a project up to a date (task_id null = unallocated). INTERNAL (money).
-- evm_cost_basis 'materials': issued materials + direct material purchases only.
-- Estimates (from resource usage × rates) drop out once a real entry exists for that category & month.
create or replace function app.ac_rows(p_project uuid, p_to date)
returns table (task_id uuid, source text, category text, entry_date date, amount numeric)
language sql stable security definer set search_path = public as $$
  select m.task_id, 'material_issue'::text, 'material'::text, m.txn_date, m.amount
  from app.material_alloc(p_project) m where m.txn_date <= p_to and m.amount is not null
  union all
  select ce.task_id, 'cost_entry', ce.category, ce.entry_date, ce.amount
  from public.cost_entries ce
  left join public.project_settings ps on ps.project_id = ce.project_id
  where ce.project_id = p_project and ce.entry_date <= p_to
    and (coalesce(ps.evm_cost_basis, 'full') = 'full' or ce.category = 'material_direct')
    and not (ce.is_estimate and exists (
      select 1 from public.cost_entries x where x.project_id = ce.project_id and x.category = ce.category
        and not x.is_estimate and date_trunc('month', x.entry_date) = date_trunc('month', ce.entry_date)))
$$;

-- -----------------------------------------------------------------------------
-- EVM core (INTERNAL; money). Leaf tasks of the approved baseline.
-- -----------------------------------------------------------------------------

create or replace function app.pvev_rows(p_schedule uuid, p_s date)
returns table (task_id uuid, bac_value numeric, bac numeric, f_pv numeric, pct_earned numeric,
               pv_value numeric, ev_value numeric, pv numeric, ev numeric)
language sql stable security definer set search_path = public as $$
  with bt as (
    select t.id, t.project_id, t.ev_method, t.is_elapsed, b.bl_start, b.bl_finish, b.accrual, b.is_point,
           coalesce(c.bac_value, 0) as bv, coalesce(c.bac_cost, 0) as bc
    from public.schedules s
    join public.schedule_baseline_tasks b on b.baseline_id = s.approved_baseline_id
    join public.schedule_tasks t on t.id = b.task_id and not t.is_summary
    left join public.schedule_baseline_task_costs c on c.baseline_id = b.baseline_id and c.task_id = b.task_id
    where s.id = p_schedule),
  f as (select bt.*, app.pv_fraction(bt.project_id, bt.bl_start, bt.bl_finish, bt.accrual, bt.is_point, bt.is_elapsed, p_s) as fr from bt),
  e as (select f.*, case when f.ev_method = 'loe' then 100 * f.fr else app.task_earned_pct(f.id, p_s) end as pe from f)
  select e.id, e.bv, e.bc, round(e.fr, 6), round(e.pe, 3),
         round(e.bv * e.fr, 2), round(e.bv * e.pe / 100, 2), round(e.bc * e.fr, 2), round(e.bc * e.pe / 100, 2)
  from e
$$;

create or replace function app.evm_rows(p_schedule uuid, p_s date)
returns table (task_id uuid, bac_value numeric, bac numeric, f_pv numeric, pct_earned numeric,
               pv_value numeric, ev_value numeric, pv numeric, ev numeric, ac numeric)
language sql stable security definer set search_path = public as $$
  with r as (select * from app.pvev_rows(p_schedule, p_s)),
  a as (
    select x.task_id, sum(x.amount) as ac
    from public.schedules s
    cross join lateral app.ac_rows(s.project_id, p_s) x
    join public.schedule_tasks t on t.id = x.task_id and t.schedule_id = s.id
    where s.id = p_schedule group by x.task_id)
  select coalesce(r.task_id, a.task_id), coalesce(r.bac_value, 0), coalesce(r.bac, 0), coalesce(r.f_pv, 0),
         coalesce(r.pct_earned, 0), coalesce(r.pv_value, 0), coalesce(r.ev_value, 0), coalesce(r.pv, 0),
         coalesce(r.ev, 0), round(coalesce(a.ac, 0), 2)
  from r full join a on a.task_id = r.task_id
$$;

-- Cumulative PV at working-day index n (helper of earned_schedule).
create or replace function app.pv_at_index(p_n int, p_si int[], p_fi int[], p_ei int[], p_bac numeric[], p_acc text[], p_pt boolean[])
returns numeric
language plpgsql immutable as $$
declare v numeric := 0; i int; f numeric;
begin
  for i in 1 .. coalesce(array_length(p_si, 1), 0) loop
    if p_acc[i] = 'start' then f := case when p_n >= p_si[i] then 1 else 0 end;
    elsif p_acc[i] = 'end' or p_pt[i] or p_fi[i] < p_si[i] then f := case when p_n >= p_ei[i] then 1 else 0 end;
    elsif p_n < p_si[i] then f := 0;
    elsif p_n >= p_fi[i] then f := 1;
    else f := (p_n - p_si[i] + 1)::numeric / (p_fi[i] - p_si[i] + 1);
    end if;
    v := v + p_bac[i] * f;
  end loop;
  return v;
end $$;

-- Earned Schedule (Lipke) on the daily cumulative baseline PV curve (working-day index from BS0).
create or replace function app.earned_schedule(p_schedule uuid, p_s date, p_ev numeric)
returns table (es_days numeric, at_days int, pd_days int, spi_t numeric, sv_t_days numeric, ieac_t_days numeric,
               es_finish date, bs0 date, bf0 date)
language plpgsql stable security definer set search_path = public as $$
declare
  v_proj uuid; v_bs0 date; v_bf0 date; D date[];
  v_si int[]; v_fi int[]; v_ei int[]; v_bac numeric[]; v_acc text[]; v_pt boolean[];
  v_pd int; v_at int; lo int; hi int; mid int; v_c int; v_es numeric; v_pc numeric; v_pn numeric; v_spit numeric; v_ieac numeric;
begin
  select s.project_id into v_proj from public.schedules s where s.id = p_schedule;
  select min(b.bl_start), max(b.bl_finish) into v_bs0, v_bf0
  from public.schedules s join public.schedule_baseline_tasks b on b.baseline_id = s.approved_baseline_id
  join public.schedule_tasks t on t.id = b.task_id and not t.is_summary where s.id = p_schedule;
  if v_bs0 is null or p_s is null then return; end if;
  D := app.working_dates(v_proj, v_bs0, greatest(v_bf0, p_s));
  select array_agg(app.date_idx(D, b.bl_start - 1) + 1 order by t.id), array_agg(app.date_idx(D, b.bl_finish) order by t.id),
         array_agg(app.date_idx(D, b.bl_finish - 1) + 1 order by t.id), array_agg(coalesce(c.bac_cost, 0) order by t.id),
         array_agg(b.accrual order by t.id), array_agg(b.is_point order by t.id)
    into v_si, v_fi, v_ei, v_bac, v_acc, v_pt
  from public.schedules s join public.schedule_baseline_tasks b on b.baseline_id = s.approved_baseline_id
  join public.schedule_tasks t on t.id = b.task_id and not t.is_summary
  left join public.schedule_baseline_task_costs c on c.baseline_id = b.baseline_id and c.task_id = b.task_id
  where s.id = p_schedule;
  v_pd := app.date_idx(D, v_bf0);
  v_at := app.date_idx(D, p_s);
  -- C = max n in [0, PD] with PV(n) <= EV (PV is non-decreasing)
  lo := 0; hi := v_pd;
  while lo < hi loop
    mid := (lo + hi + 1) / 2;
    if app.pv_at_index(mid, v_si, v_fi, v_ei, v_bac, v_acc, v_pt) <= coalesce(p_ev, 0) then lo := mid; else hi := mid - 1; end if;
  end loop;
  v_c := lo;
  if v_c >= v_pd then v_es := v_pd;
  else
    v_pc := app.pv_at_index(v_c, v_si, v_fi, v_ei, v_bac, v_acc, v_pt);
    v_pn := app.pv_at_index(v_c + 1, v_si, v_fi, v_ei, v_bac, v_acc, v_pt);
    v_es := v_c + case when v_pn > v_pc then (coalesce(p_ev, 0) - v_pc) / (v_pn - v_pc) else 0 end;
  end if;
  v_spit := case when v_at > 0 then v_es / v_at end;
  v_ieac := case when v_spit > 0 then v_pd / v_spit end;
  return query select round(v_es, 2), v_at, v_pd, round(v_spit, 4), round(v_es - v_at, 2), round(v_ieac, 2),
    case when v_ieac is not null then app.idx_date(v_proj, D, ceil(v_ieac)::int) end, v_bs0, v_bf0;
end $$;

-- Task / WBS / project metrics at status date s. INTERNAL raw versions (money) + checked wrappers.
create or replace function app.evm_task_raw(p_schedule uuid, p_s date)
returns table (task_id uuid, msp_uid int, wbs text, name text, outline_level int, parent_id uuid, ev_method text,
               status_date date, bac numeric, pv numeric, ev numeric, ac numeric, bac_value numeric, pv_value numeric,
               ev_value numeric, pct_planned numeric, pct_earned numeric, sv numeric, cv numeric, spi numeric, cpi numeric,
               eac numeric, etc numeric, vac numeric, tcpi numeric, eac_fallback boolean, spi_status text, cpi_status text)
language sql stable security definer set search_path = public as $$
  select r.task_id, t.msp_uid, t.wbs, t.name, t.outline_level, t.parent_id, t.ev_method, p_s,
         r.bac, r.pv, r.ev, r.ac, r.bac_value, r.pv_value, r.ev_value, round(100 * r.f_pv, 3), r.pct_earned,
         c.sv, c.cv, c.spi, c.cpi, c.eac, c.etc, c.vac, c.tcpi, c.eac_fallback,
         app.idx_band(t.project_id, c.spi), app.idx_band(t.project_id, c.cpi)
  from app.evm_rows(p_schedule, p_s) r
  join public.schedule_tasks t on t.id = r.task_id
  left join public.project_settings ps on ps.project_id = t.project_id
  cross join lateral app.evm_calc(r.bac, r.pv, r.ev, r.ac, ps.evm_eac_method, ps.evm_eac_min_pct) c
$$;

create or replace function app.evm_wbs_raw(p_schedule uuid, p_s date)
returns table (task_id uuid, msp_uid int, wbs text, name text, outline_level int, parent_id uuid, status_date date,
               bac numeric, pv numeric, ev numeric, ac numeric, bac_value numeric, pv_value numeric, ev_value numeric,
               pct_planned numeric, pct_earned numeric, sv numeric, cv numeric, spi numeric, cpi numeric, eac numeric,
               etc numeric, vac numeric, tcpi numeric, eac_fallback boolean, spi_status text, cpi_status text, leaf_tasks int)
language sql stable security definer set search_path = public as $$
  with recursive tk as (select id, parent_id, is_summary from public.schedule_tasks where schedule_id = p_schedule),
  anc as (select id as anc_id, id as desc_id from tk where is_summary
          union all select a.anc_id, t.id from anc a join tk t on t.parent_id = a.desc_id),
  r as (select * from app.evm_rows(p_schedule, p_s)),
  agg as (select a.anc_id, sum(r.bac) bac, sum(r.pv) pv, sum(r.ev) ev, sum(r.ac) ac, sum(r.bac_value) bv,
                 sum(r.pv_value) pvv, sum(r.ev_value) evv, count(*) filter (where r.bac > 0 or r.bac_value > 0)::int n
          from anc a join r on r.task_id = a.desc_id group by a.anc_id)
  select t.id, t.msp_uid, t.wbs, t.name, t.outline_level, t.parent_id, p_s,
         coalesce(g.bac, 0), coalesce(g.pv, 0), coalesce(g.ev, 0), coalesce(g.ac, 0), coalesce(g.bv, 0),
         coalesce(g.pvv, 0), coalesce(g.evv, 0), c.pct_planned, c.pct_earned,
         c.sv, c.cv, c.spi, c.cpi, c.eac, c.etc, c.vac, c.tcpi, c.eac_fallback,
         app.idx_band(t.project_id, c.spi), app.idx_band(t.project_id, c.cpi), coalesce(g.n, 0)
  from public.schedule_tasks t
  left join agg g on g.anc_id = t.id
  left join public.project_settings ps on ps.project_id = t.project_id
  cross join lateral app.evm_calc(g.bac, g.pv, g.ev, g.ac, ps.evm_eac_method, ps.evm_eac_min_pct) c
  where t.schedule_id = p_schedule and t.is_summary and t.deleted_at is null
$$;

create or replace function app.evm_project_raw(p_schedule uuid, p_s date)
returns table (status_date date, bac numeric, pv numeric, ev numeric, ac numeric, ac_unallocated numeric,
               bac_value numeric, pv_value numeric, ev_value numeric, pct_planned numeric, pct_earned numeric,
               sv numeric, cv numeric, spi numeric, cpi numeric, eac numeric, etc numeric, vac numeric, tcpi numeric,
               tcpi_eac numeric, eac_fallback boolean, eac_method text, cost_basis text,
               es_days numeric, at_days int, pd_days int, spi_t numeric, sv_t_days numeric, ieac_t_days numeric,
               es_finish date, fc_finish date, baseline_start date, baseline_finish date,
               spi_status text, cpi_status text, spi_t_status text, tcpi_status text,
               baseline_id uuid, unbaselined_tasks int, ac_coverage_pct numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  sc public.schedules; cfg public.project_settings;
  v_bac numeric; v_pv numeric; v_ev numeric; v_ac_alloc numeric; v_bv numeric; v_pvv numeric; v_evv numeric;
  v_ac numeric; c app.evm_ratio; es record; v_unb int; v_tcpi_warn numeric;
begin
  select * into sc from public.schedules where id = p_schedule;
  if not found then return; end if;
  cfg := app.evm_cfg(sc.project_id);
  select coalesce(sum(r.bac), 0), coalesce(sum(r.pv), 0), coalesce(sum(r.ev), 0), coalesce(sum(r.ac), 0),
         coalesce(sum(r.bac_value), 0), coalesce(sum(r.pv_value), 0), coalesce(sum(r.ev_value), 0)
    into v_bac, v_pv, v_ev, v_ac_alloc, v_bv, v_pvv, v_evv
  from app.evm_rows(p_schedule, p_s) r;
  select round(coalesce(sum(x.amount), 0), 2) into v_ac from app.ac_rows(sc.project_id, p_s) x;
  c := app.evm_calc(v_bac, v_pv, v_ev, v_ac, cfg.evm_eac_method, cfg.evm_eac_min_pct);
  select * into es from app.earned_schedule(p_schedule, p_s, v_ev);
  select count(*)::int into v_unb from public.schedule_tasks t
    where t.schedule_id = p_schedule and t.deleted_at is null and not t.is_summary
      and not exists (select 1 from public.schedule_baseline_tasks b where b.baseline_id = sc.approved_baseline_id and b.task_id = t.id);
  v_tcpi_warn := coalesce((cfg.evm_thresholds ->> 'tcpi_warn')::numeric, 1.10);
  return query select p_s, v_bac, v_pv, v_ev, v_ac, round(v_ac - v_ac_alloc, 2), v_bv, v_pvv, v_evv,
    c.pct_planned, c.pct_earned, c.sv, c.cv, c.spi, c.cpi, c.eac, c.etc, c.vac, c.tcpi, c.tcpi_eac, c.eac_fallback,
    coalesce(cfg.evm_eac_method, 'cpi'), coalesce(cfg.evm_cost_basis, 'full'),
    es.es_days, es.at_days, es.pd_days, es.spi_t, es.sv_t_days, es.ieac_t_days, es.es_finish, sc.fc_finish, es.bs0, es.bf0,
    app.idx_band(sc.project_id, c.spi), app.idx_band(sc.project_id, c.cpi), app.idx_band(sc.project_id, es.spi_t),
    case when c.tcpi is null then null when c.tcpi > v_tcpi_warn then 'warning' else 'ok' end,
    sc.approved_baseline_id, v_unb,
    case when v_ac <> 0 then round(100 * v_ac_alloc / v_ac, 1) end;
end $$;

-- BoQ quantity done at s (verified): measured qty on 'units' tasks, qty_share × earned % otherwise. No money.
create or replace function app.boq_progress_raw(p_schedule uuid, p_s date)
returns table (boq_item_id uuid, qty_contract numeric, qty_mapped numeric, qty_to_date numeric)
language sql stable security definer set search_path = public as $$
  with l as (
    select l.boq_item_id, l.task_id, l.qty_share, t.ev_method, t.project_id, t.baseline_start, t.baseline_finish,
           t.planned_start, t.planned_finish, t.is_elapsed
    from public.task_boq_links l join public.schedule_tasks t on t.id = l.task_id
    where t.schedule_id = p_schedule and l.deleted_at is null and t.deleted_at is null and not t.is_summary),
  q as (
    select l.boq_item_id, l.qty_share,
           case when l.ev_method = 'units' then
                  coalesce((select x.qty_to_date from public.task_progress tp,
                              jsonb_to_recordset(coalesce(tp.verified_qty, '[]'::jsonb)) as x(boq_item_id uuid, qty_to_date numeric)
                            where tp.task_id = l.task_id and tp.status in ('verified','adjusted') and tp.status_date <= p_s
                              and x.boq_item_id = l.boq_item_id
                            order by tp.status_date desc, tp.verified_at desc limit 1), 0)
                when l.ev_method = 'loe' then l.qty_share * app.pv_fraction(l.project_id, coalesce(l.baseline_start, l.planned_start),
                  coalesce(l.baseline_finish, l.planned_finish), 'prorated', false, l.is_elapsed, p_s)
                else l.qty_share * app.task_earned_pct(l.task_id, p_s) / 100 end as done
    from l)
  select q.boq_item_id, b.quantity, round(sum(q.qty_share), 3), round(sum(q.done), 3)
  from q join public.boq_items b on b.id = q.boq_item_id
  group by q.boq_item_id, b.quantity
$$;

-- PV / EV / AC curve per bucket (cumulative). PV over the whole baseline span; EV/AC up to the status date.
create or replace function app.evm_timeseries_raw(p_schedule uuid, p_grain text, p_s date default null)
returns table (grain text, period_end date, as_of date, is_actual boolean, pv numeric, ev numeric, ac numeric,
               pv_value numeric, ev_value numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  sc public.schedules; v_s date; v_bs0 date; v_bf0 date; v_to date; d date; v_asof date;
  v_pv numeric; v_pvv numeric; v_ev numeric; v_evv numeric; v_ac numeric; v_ends date[] := '{}';
  v_acd date[]; v_aca numeric[]; i int;
begin
  select * into sc from public.schedules where id = p_schedule;
  if not found then return; end if;
  v_s := coalesce(p_s, sc.status_date, app.eat_date(now()));
  select min(b.bl_start), max(b.bl_finish) into v_bs0, v_bf0
    from public.schedule_baseline_tasks b where b.baseline_id = sc.approved_baseline_id;
  if v_bs0 is null then return; end if;
  v_to := greatest(v_bf0, v_s);
  if p_grain = 'day' then
    v_ends := array(select v_bs0 + k from generate_series(0, v_to - v_bs0) k);
  elsif p_grain = 'month' then
    v_ends := array(select (date_trunc('month', v_bs0) + make_interval(months => k + 1) - interval '1 day')::date
                    from generate_series(0, (extract(year from age(date_trunc('month', v_to), date_trunc('month', v_bs0))) * 12
                                            + extract(month from age(date_trunc('month', v_to), date_trunc('month', v_bs0))))::int) k);
  else   -- week: Mon–Sat site week, bucket ends on Saturday
    d := v_bs0 + ((6 - extract(isodow from v_bs0)::int + 7) % 7);
    v_ends := array(select d + 7 * k from generate_series(0, greatest((v_to - d + 6) / 7, 0)) k);
  end if;
  select array_agg(x.entry_date order by x.entry_date), array_agg(x.amount order by x.entry_date) into v_acd, v_aca
    from app.ac_rows(sc.project_id, v_s) x;
  foreach d in array v_ends loop
    select coalesce(sum(r.pv), 0), coalesce(sum(r.pv_value), 0) into v_pv, v_pvv from app.pvev_rows(p_schedule, d) r;
    v_asof := least(d, v_s);
    if d <= v_s or (d > v_s and d - v_s < case p_grain when 'day' then 1 when 'week' then 7 else 31 end
                    and not exists (select 1 from unnest(v_ends) e where e >= v_s and e < d)) then
      select coalesce(sum(r.ev), 0), coalesce(sum(r.ev_value), 0) into v_ev, v_evv from app.pvev_rows(p_schedule, v_asof) r;
      v_ac := 0;
      for i in 1 .. coalesce(array_length(v_acd, 1), 0) loop
        if v_acd[i] <= v_asof then v_ac := v_ac + coalesce(v_aca[i], 0); end if;
      end loop;
      return query select p_grain, d, v_asof, true, v_pv, v_ev, round(v_ac, 2), v_pvv, v_evv;
    else
      return query select p_grain, d, null::date, false, v_pv, null::numeric, null::numeric, v_pvv, null::numeric;
    end if;
  end loop;
end $$;

-- Mobile-safe progress overview (no money): % planned / earned, SPI, SPI(t), forecast, counts per WBS node.
create or replace function app.progress_overview(p_schedule uuid, p_s date default null)
returns table (level text, task_id uuid, wbs text, name text, outline_level int, status_date date,
               pct_planned numeric, pct_earned numeric, spi numeric, spi_status text, spi_t numeric, sv_t_days numeric,
               spi_t_status text, forecast_finish date, es_finish date, baseline_finish date,
               leaf_tasks int, completed_tasks int, in_progress_tasks int, late_tasks int, critical_tasks int,
               negative_float_tasks int, pending_verification int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare sc public.schedules; v_s date; v_ev numeric; es record;
begin
  select * into sc from public.schedules where id = p_schedule;
  if not found or not app.is_member(sc.project_id) then return; end if;
  v_s := coalesce(p_s, sc.status_date, app.eat_date(now()));
  select coalesce(sum(r.ev), 0) into v_ev from app.pvev_rows(p_schedule, v_s) r;
  select * into es from app.earned_schedule(p_schedule, v_s, v_ev);
  return query
  with recursive tk as (select * from public.schedule_tasks where schedule_id = p_schedule),
  anc as (select id as anc_id, id as desc_id from tk where is_summary and deleted_at is null
          union all select a.anc_id, t.id from anc a join tk t on t.parent_id = a.desc_id),
  r as (select * from app.pvev_rows(p_schedule, v_s)),
  lf as (
    select t.id, r.bac, r.pv, r.ev, t.pct_complete, t.actual_start, t.actual_finish, t.is_critical, t.total_float_days,
           (t.pct_complete < 100 and t.forecast_finish > coalesce(t.baseline_finish, t.planned_finish)) as late,
           (select count(*) from public.task_progress tp where tp.task_id = t.id and tp.status = 'reported')::int as pend
    from tk t left join r on r.task_id = t.id where not t.is_summary and t.deleted_at is null),
  node as (
    select a.anc_id, sum(lf.bac) bac, sum(lf.pv) pv, sum(lf.ev) ev, count(*)::int n,
           count(*) filter (where lf.pct_complete >= 100)::int done,
           count(*) filter (where lf.pct_complete > 0 and lf.pct_complete < 100)::int prog,
           count(*) filter (where lf.late)::int late, count(*) filter (where lf.is_critical and lf.pct_complete < 100)::int crit,
           count(*) filter (where lf.total_float_days < 0 and lf.pct_complete < 100)::int neg, sum(lf.pend)::int pend
    from anc a join lf on lf.id = a.desc_id group by a.anc_id),
  proj as (
    select sum(bac) bac, sum(pv) pv, sum(ev) ev, count(*)::int n, count(*) filter (where pct_complete >= 100)::int done,
           count(*) filter (where pct_complete > 0 and pct_complete < 100)::int prog, count(*) filter (where late)::int late,
           count(*) filter (where is_critical and pct_complete < 100)::int crit,
           count(*) filter (where total_float_days < 0 and pct_complete < 100)::int neg, coalesce(sum(pend), 0)::int pend
    from lf)
  select 'project'::text, null::uuid, null::text, sc.name, 0, v_s,
         round(100 * p.pv / nullif(p.bac, 0), 2), round(100 * p.ev / nullif(p.bac, 0), 2), round(p.ev / nullif(p.pv, 0), 4),
         app.idx_band(sc.project_id, round(p.ev / nullif(p.pv, 0), 4)), es.spi_t, es.sv_t_days,
         app.idx_band(sc.project_id, es.spi_t), sc.fc_finish, es.es_finish, es.bf0,
         p.n, p.done, p.prog, p.late, p.crit, p.neg, p.pend
  from proj p
  union all
  select 'wbs', t.id, t.wbs, t.name, t.outline_level, v_s,
         round(100 * n.pv / nullif(n.bac, 0), 2), round(100 * n.ev / nullif(n.bac, 0), 2), round(n.ev / nullif(n.pv, 0), 4),
         app.idx_band(sc.project_id, round(n.ev / nullif(n.pv, 0), 4)), null::numeric, null::numeric, null::text,
         t.forecast_finish, null::date, t.baseline_finish, n.n, n.done, n.prog, n.late, n.crit, n.neg, n.pend
  from tk t join node n on n.anc_id = t.id
  where t.is_summary and t.deleted_at is null;
end $$;

-- Checked wrappers: price roles + membership (money), membership (quantities).

do $$
declare f text;
begin
  foreach f in array array['material_alloc(uuid)','ac_rows(uuid, date)','pvev_rows(uuid, date)','evm_rows(uuid, date)',
    'evm_task_raw(uuid, date)','evm_wbs_raw(uuid, date)','evm_project_raw(uuid, date)','evm_timeseries_raw(uuid, text, date)',
    'earned_schedule(uuid, date, numeric)','units_pct(uuid, jsonb)','task_earned_pct(uuid, date)','boq_progress_raw(uuid, date)'] loop
    execute format('revoke execute on function app.%s from public', f);
  end loop;
end $$;

create or replace function app.can_see_schedule_money(p_schedule uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.can_see_prices() and exists (select 1 from public.schedules s where s.id = p_schedule and app.is_member(s.project_id))
$$;


-- -----------------------------------------------------------------------------
-- CPM forecast: forward / backward pass on working-day indices
-- -----------------------------------------------------------------------------

-- Index arithmetic, finish inclusive: EF = ES + dur − 1 (milestone dur 0 → EF = ES − 1, shown at EF).
--   FS: ES_s ≥ EF_p + 1 + L   SS: ES_s ≥ ES_p + L   FF: EF_s ≥ EF_p + L   SF: EF_s ≥ ES_p + L − 1
-- Done tasks keep their actual dates. Started tasks: remaining = remaining_days, else ceil(dur × (1 − %)),
-- min 1, from the day after the status date; 'retained' logic also waits for unfinished predecessors.
-- Not started: ES ≥ status date + 1; tasks without predecessors keep their planned start (open start);
-- SNET/MSO and FNET/MFO constraints respected. Backward pass from the latest EF (or contract finish).
create or replace function app.run_cpm(p_schedule uuid, p_status date, p_write boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sc public.schedules; cfg public.project_settings;
  v_ids uuid[]; v_uid int[]; v_dur int[]; v_ms boolean[]; v_state int[]; v_as date[]; v_af date[];
  v_rem numeric[]; v_pct numeric[]; v_ps date[]; v_ct int[]; v_cd date[]; v_el boolean[]; v_dd numeric[];
  l_p int[]; l_s int[]; l_t text[]; l_l int[];
  v_off int[]; v_cnt int[]; v_indeg int[]; v_haspred boolean[];
  v_esmin int[]; v_efmin int[]; v_es int[]; v_ef int[]; v_rs int[]; v_lf int[];
  v_tf numeric[]; v_ff numeric[]; v_fs date[]; v_ffin date[]; v_crit boolean[];
  q int[] := '{}'; qh int := 1; qn int := 0;
  D date[]; v_lo date; v_hi date; S int; n int; m int;
  i int; j int; k int; L int; v_d int; v_r int; v_x int; v_end int; v_min numeric;
  NEG constant int := -1000000000;
  v_retained boolean; v_wdw numeric; v_cyc text; v_crit_days numeric;
  v_ncrit int := 0; v_nneg int := 0; v_fin date;
begin
  select * into sc from public.schedules where id = p_schedule;
  if not found then raise exception 'Schedule not found'; end if;
  cfg := app.evm_cfg(sc.project_id);
  v_retained := coalesce(cfg.evm_progressed_logic, 'retained') = 'retained';
  v_crit_days := coalesce(cfg.evm_critical_float_days, 0);
  select coalesce(array_length(working_weekdays, 1), 6) into v_wdw from public.project_calendars
    where project_id = sc.project_id and is_default and deleted_at is null;
  v_wdw := coalesce(v_wdw, 6);

  with t as (
    select t.*, row_number() over (order by t.id) as rn from public.schedule_tasks t
    where t.schedule_id = p_schedule and t.deleted_at is null and not t.is_summary)
  select array_agg(id order by rn), array_agg(msp_uid order by rn),
         array_agg(case when is_milestone or coalesce(duration_days, 0) <= 0 then 0 else greatest(1, ceil(duration_days))::int end order by rn),
         array_agg(is_milestone or coalesce(duration_days, 0) <= 0 order by rn),
         array_agg(case when actual_finish is not null or pct_complete >= 100 then 2
                        when actual_start is not null or pct_complete > 0 then 1 else 0 end order by rn),
         array_agg(actual_start order by rn),
         array_agg(case when actual_finish is not null or pct_complete >= 100
                        then coalesce(actual_finish, progress_as_of, p_status) end order by rn),
         array_agg(remaining_days order by rn), array_agg(pct_complete order by rn), array_agg(planned_start order by rn),
         array_agg(constraint_type::int order by rn), array_agg(constraint_date order by rn),
         array_agg(is_elapsed order by rn), array_agg(duration_days order by rn),
         min(least(planned_start, actual_start)), max(greatest(planned_finish, actual_finish))
    into v_ids, v_uid, v_dur, v_ms, v_state, v_as, v_af, v_rem, v_pct, v_ps, v_ct, v_cd, v_el, v_dd, v_lo, v_hi
  from t;
  n := coalesce(array_length(v_ids, 1), 0);
  if n = 0 then return jsonb_build_object('tasks', 0, 'links', 0); end if;

  v_lo := least(coalesce(v_lo, p_status), p_status) - 14;
  v_hi := greatest(coalesce(v_hi, p_status), p_status);
  v_hi := v_hi + least(3650, greatest(730, 3 * (v_hi - v_lo)));
  D := app.working_dates(sc.project_id, v_lo, v_hi);
  S := app.date_idx(D, p_status);

  -- elapsed durations: working days covered by the calendar span
  for i in 1 .. n loop
    if v_el[i] and v_dur[i] > 0 and v_ps[i] is not null then
      v_dur[i] := greatest(1, app.date_idx(D, v_ps[i] + ceil(v_dd[i])::int - 1) - app.date_idx(D, v_ps[i] - 1));
    end if;
  end loop;

  with t as (
    select id, row_number() over (order by id) as rn from public.schedule_tasks
    where schedule_id = p_schedule and deleted_at is null and not is_summary),
  lk as (
    select tp.rn as pi, ts.rn as si, l.link_type,
           round(case when l.lag_elapsed then l.lag_days * v_wdw / 7.0 else l.lag_days end)::int as lag
    from public.schedule_links l join t tp on tp.id = l.pred_task_id join t ts on ts.id = l.succ_task_id
    where l.schedule_id = p_schedule and l.deleted_at is null)
  select array_agg(pi order by pi, si, link_type), array_agg(si order by pi, si, link_type),
         array_agg(link_type order by pi, si, link_type), array_agg(lag order by pi, si, link_type)
    into l_p, l_s, l_t, l_l from lk;
  m := coalesce(array_length(l_p, 1), 0);

  v_off := array_fill(0, array[n]); v_cnt := array_fill(0, array[n]); v_indeg := array_fill(0, array[n]);
  v_esmin := array_fill(NEG, array[n]); v_efmin := array_fill(NEG, array[n]);
  v_es := array_fill(0, array[n]); v_ef := array_fill(0, array[n]); v_rs := array_fill(0, array[n]);
  for k in 1 .. m loop
    i := l_p[k];
    if v_cnt[i] = 0 then v_off[i] := k; end if;
    v_cnt[i] := v_cnt[i] + 1;
    v_indeg[l_s[k]] := v_indeg[l_s[k]] + 1;
  end loop;
  v_haspred := array(select v_indeg[x] > 0 from generate_series(1, n) x);
  for i in 1 .. n loop
    if v_indeg[i] = 0 then qn := qn + 1; q[qn] := i; end if;
  end loop;

  -- forward pass (Kahn order)
  while qh <= qn loop
    i := q[qh]; qh := qh + 1;
    v_d := v_dur[i];
    if v_state[i] = 2 then
      v_ef[i] := app.date_idx(D, v_af[i]);
      if v_d = 0 then v_es[i] := v_ef[i] + 1;
      elsif v_as[i] is not null then v_es[i] := app.date_idx(D, v_as[i] - 1) + 1;
      else v_es[i] := v_ef[i] - v_d + 1; end if;
      v_rs[i] := v_es[i];
    elsif v_state[i] = 1 then
      v_es[i] := app.date_idx(D, coalesce(v_as[i], p_status) - 1) + 1;
      v_r := case when v_d = 0 then 0
                  else greatest(1, ceil(coalesce(v_rem[i], v_d * (1 - coalesce(v_pct[i], 0) / 100.0))))::int end;
      v_rs[i] := S + 1;
      if v_retained then v_rs[i] := greatest(v_rs[i], v_esmin[i]); end if;
      v_ef[i] := v_rs[i] + v_r - 1;
      if v_retained then v_ef[i] := greatest(v_ef[i], v_efmin[i]); end if;
    else
      v_x := greatest(S + 1, v_esmin[i], v_efmin[i] - v_d + 1);
      if not v_haspred[i] and v_ps[i] is not null then
        v_x := greatest(v_x, case when v_d = 0 then app.date_idx(D, v_ps[i]) + 1 else app.date_idx(D, v_ps[i] - 1) + 1 end);
      end if;
      if v_ct[i] in (2, 4) and v_cd[i] is not null then          -- MSO / SNET
        v_x := greatest(v_x, case when v_d = 0 then app.date_idx(D, v_cd[i]) + 1 else app.date_idx(D, v_cd[i] - 1) + 1 end);
      elsif v_ct[i] in (3, 6) and v_cd[i] is not null then       -- MFO / FNET
        v_x := greatest(v_x, app.date_idx(D, v_cd[i]) - v_d + 1);
      end if;
      v_es[i] := v_x; v_rs[i] := v_x; v_ef[i] := v_x + v_d - 1;
    end if;
    if v_cnt[i] > 0 then
      for k in v_off[i] .. v_off[i] + v_cnt[i] - 1 loop
        j := l_s[k]; L := l_l[k];
        if l_t[k] = 'FS' then v_esmin[j] := greatest(v_esmin[j], v_ef[i] + 1 + L);
        elsif l_t[k] = 'SS' then v_esmin[j] := greatest(v_esmin[j], v_es[i] + L);
        elsif l_t[k] = 'FF' then v_efmin[j] := greatest(v_efmin[j], v_ef[i] + L);
        else v_efmin[j] := greatest(v_efmin[j], v_es[i] + L - 1);
        end if;
        v_indeg[j] := v_indeg[j] - 1;
        if v_indeg[j] = 0 then qn := qn + 1; q[qn] := j; end if;
      end loop;
    end if;
  end loop;

  if qn < n then
    select string_agg(v_uid[x]::text, ', ' order by v_uid[x]) into v_cyc from generate_series(1, n) x where v_indeg[x] > 0;
    raise exception 'The schedule logic has a loop (circular links) through task UIDs: %', v_cyc;
  end if;
  if not p_write then return jsonb_build_object('tasks', n, 'links', m, 'cycle', false); end if;

  -- backward pass (reverse topological order)
  select max(x) into v_end from unnest(v_ef) x;
  if coalesce(cfg.evm_float_to, 'project_finish') = 'contract_finish' and cfg.evm_contract_finish is not null then
    v_end := app.date_idx(D, cfg.evm_contract_finish);
  end if;
  v_lf := array_fill(v_end, array[n]);
  v_tf := array_fill(null::numeric, array[n]); v_ff := array_fill(null::numeric, array[n]);
  for k in reverse qn .. 1 loop
    i := q[k];
    v_min := null;
    if v_cnt[i] > 0 then
      for j in v_off[i] .. v_off[i] + v_cnt[i] - 1 loop
        continue when v_state[l_s[j]] = 2;
        L := l_l[j];
        v_x := v_lf[l_s[j]] - (v_ef[l_s[j]] - v_rs[l_s[j]] + 1) + 1;     -- late start of the successor's (remaining) work
        if l_t[j] = 'FS' then
          v_lf[i] := least(v_lf[i], v_x - 1 - L);
          v_min := least(coalesce(v_min, 1e9), v_rs[l_s[j]] - (v_ef[i] + 1 + L));
        elsif l_t[j] = 'SS' then
          if v_state[i] = 0 then
            v_lf[i] := least(v_lf[i], v_x - L + v_dur[i] - 1);
            v_min := least(coalesce(v_min, 1e9), v_rs[l_s[j]] - (v_es[i] + L));
          end if;
        elsif l_t[j] = 'FF' then
          v_lf[i] := least(v_lf[i], v_lf[l_s[j]] - L);
          v_min := least(coalesce(v_min, 1e9), v_ef[l_s[j]] - (v_ef[i] + L));
        else
          if v_state[i] = 0 then
            v_lf[i] := least(v_lf[i], v_lf[l_s[j]] - L + v_dur[i]);
            v_min := least(coalesce(v_min, 1e9), v_ef[l_s[j]] - (v_es[i] + L - 1));
          end if;
        end if;
      end loop;
    end if;
    if v_state[i] <> 2 then
      v_tf[i] := v_lf[i] - v_ef[i];
      v_ff[i] := least(coalesce(v_min, v_end - v_ef[i]), v_tf[i]);
    end if;
  end loop;

  v_fs := array_fill(null::date, array[n]); v_ffin := array_fill(null::date, array[n]); v_crit := array_fill(false, array[n]);
  for i in 1 .. n loop
    if v_state[i] = 2 then
      v_ffin[i] := v_af[i]; v_fs[i] := coalesce(v_as[i], app.idx_date(sc.project_id, D, v_es[i]));
      if v_dur[i] = 0 then v_fs[i] := v_ffin[i]; end if;
    else
      v_ffin[i] := app.idx_date(sc.project_id, D, v_ef[i]);
      v_fs[i] := case when v_dur[i] = 0 then v_ffin[i]
                      when v_state[i] = 1 then coalesce(v_as[i], app.idx_date(sc.project_id, D, v_es[i]))
                      else app.idx_date(sc.project_id, D, v_es[i]) end;
      v_crit[i] := v_tf[i] <= v_crit_days;
      if v_crit[i] then v_ncrit := v_ncrit + 1; end if;
      if v_tf[i] < 0 then v_nneg := v_nneg + 1; end if;
    end if;
  end loop;

  update public.schedule_tasks t set forecast_start = x.fs, forecast_finish = x.ff, total_float_days = x.tf,
         free_float_days = x.ffl, is_critical = x.cr, fc_status_date = p_status
  from unnest(v_ids, v_fs, v_ffin, v_tf, v_ff, v_crit) as x(id, fs, ff, tf, ffl, cr)
  where t.id = x.id;
  perform app.rollup_summaries(p_schedule);
  select max(x) into v_fin from unnest(v_ffin) x;
  update public.schedules set status_date = p_status, fc_finish = v_fin, forecast_run_at = now() where id = p_schedule;

  if v_nneg > 0 then
    perform app.raise_alert(sc.project_id, 'negative_float', 'critical', 'schedule', p_schedule, 'negfloat:' || p_schedule,
      v_nneg || ' task(s) with negative float in ' || sc.name,
      jsonb_build_object('summary', v_nneg || ' task(s) cannot finish by the required date', 'count', v_nneg));
  end if;
  return jsonb_build_object('tasks', n, 'links', m, 'fc_finish', v_fin, 'critical_count', v_ncrit,
                            'negative_float_count', v_nneg, 'cycle', false);
end $$;

-- -----------------------------------------------------------------------------
-- RPC: import_schedule (MSPDI / Excel parsed in the browser → normalised JSON)
-- -----------------------------------------------------------------------------

create or replace function public.import_schedule(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_project uuid := (p ->> 'project_id')::uuid;
  v_s jsonb := coalesce(p -> 'schedule', p);
  v_h jsonb := coalesce(coalesce(p -> 'schedule', p) -> 'header', '{}'::jsonb);
  v_map_cfg jsonb := coalesce(p -> 'mapping', '{}'::jsonb);
  v_opt jsonb := coalesce(p -> 'options', '{}'::jsonb);
  pr public.projects; sc public.schedules; ot public.schedule_tasks;
  v_sched uuid; v_ver uuid; v_ver_no int; v_sha text; v_prev public.schedule_versions;
  v_bl_num int; v_prices boolean := app.can_see_prices();
  r record; t jsonb; l jsonb; v_uid int; v_guid text; v_lvl int; v_id uuid; v_parent uuid; v_stack uuid[] := '{}';
  v_map jsonb := '{}'::jsonb; v_matched uuid[] := '{}'; v_new uuid[] := '{}';
  v_added jsonb := '[]'::jsonb; v_changed jsonb := '[]'::jsonb; v_removed jsonb := '[]'::jsonb; v_kept jsonb := '[]'::jsonb;
  v_warn jsonb := '[]'::jsonb; v_chg jsonb; v_res jsonb; v_q jsonb; v_mres jsonb;
  v_name text; v_start date; v_finish date; v_dur numeric; v_summary boolean; v_ms boolean;
  v_bls jsonb; v_bl jsonb; v_bl_start date; v_bl_finish date; v_bl_dates jsonb; v_bl_costs jsonb;
  v_cost_seen boolean := false; v_has_progress boolean;
  v_confirm int[]; v_remap jsonb; v_old_uid int;
  v_pred uuid; v_succ uuid; v_type text; v_lag numeric; v_links int := 0; a uuid; b uuid; v_exp boolean;
  v_cal public.project_calendars; c jsonb; e jsonb; v_wd int[]; v_maxmin numeric; v_satmin numeric; d date; v_dates date[] := '{}';
  v_boq_field text := nullif(v_map_cfg ->> 'boq_field', ''); v_el_field text := nullif(v_map_cfg ->> 'element_field', '');
  v_wins boolean := coalesce((v_map_cfg ->> 'file_mapping_wins')::boolean, false);
  v_boq_txt text; v_el_txt text; v_items uuid[] := '{}'; v_status date; v_pct numeric; v_first boolean;
begin
  if v_seen is not null then return v_seen; end if;
  select * into pr from public.projects where id = v_project;
  if not found then raise exception 'Project not found'; end if;
  perform app.require_member(v_project);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if jsonb_typeof(v_s -> 'tasks') is distinct from 'array' or jsonb_array_length(v_s -> 'tasks') = 0 then
    raise exception 'The schedule file has no tasks';
  end if;
  if coalesce(v_h ->> 'currency_code', pr.currency) <> pr.currency and not coalesce((v_opt ->> 'accept_currency')::boolean, false) then
    raise exception 'Schedule currency % differs from the project currency % (tick "accept currency" to import anyway)',
      v_h ->> 'currency_code', pr.currency;
  end if;
  select string_agg(u, ', ') into v_res
    from (select x ->> 'uid' as u from jsonb_array_elements(v_s -> 'tasks') x
          where coalesce((x ->> 'outline_level')::int, (x ->> 'outline')::int, 1) > 0 and coalesce((x ->> 'uid')::int, 0) <> 0
          group by 1 having count(*) > 1) d0;
  if v_res is not null then raise exception 'Duplicate task UIDs in the file: %', v_res #>> '{}'; end if;
  v_res := null;

  -- schedule (one MASTER per project unless an id / code is given)
  v_sched := (p ->> 'schedule_id')::uuid;
  if v_sched is null then
    select id into v_sched from public.schedules where project_id = v_project and code = coalesce(p ->> 'code', 'MASTER');
  end if;
  select * into sc from public.schedules where id = v_sched;
  if not found then
    insert into public.schedules (id, project_id, code, name, calendar_id)
    values (coalesce(v_sched, gen_random_uuid()), v_project, coalesce(p ->> 'code', 'MASTER'),
            coalesce(nullif(v_h ->> 'name', ''), pr.name), app.project_calendar(v_project))
    returning * into sc;
    v_sched := sc.id;
  elsif sc.project_id <> v_project then
    raise exception 'Schedule belongs to another project';
  end if;

  -- same file again → earlier result (no-op)
  v_sha := nullif(coalesce(v_s ->> 'file_sha256', p ->> 'file_sha256'), '');
  if v_sha is not null then
    select * into v_prev from public.schedule_versions where schedule_id = v_sched and file_sha256 = v_sha;
    if found then
      return app.op_done(p, 'import_schedule', coalesce(v_prev.result, '{}'::jsonb) || jsonb_build_object('duplicate', true));
    end if;
  end if;
  v_first := not exists (select 1 from public.schedule_versions where schedule_id = v_sched);
  select coalesce(max(version_no), 0) + 1 into v_ver_no from public.schedule_versions where schedule_id = v_sched;
  insert into public.schedule_versions (id, project_id, schedule_id, version_no, source, file_name, file_sha256, header)
  values (coalesce((p ->> 'version_id')::uuid, gen_random_uuid()), v_project, v_sched, v_ver_no,
          coalesce(v_s ->> 'source', p ->> 'source', 'mspdi'), coalesce(v_s ->> 'file_name', p ->> 'file_name'), v_sha,
          v_h || jsonb_build_object('custom_fields', coalesce(v_s -> 'custom_fields', '[]'::jsonb),
                                    'resources', jsonb_array_length(coalesce(v_s -> 'resources', '[]'::jsonb)),
                                    'assignments', jsonb_array_length(coalesce(v_s -> 'assignments', '[]'::jsonb))))
  returning id into v_ver;
  v_warn := v_warn || coalesce(v_s -> 'warnings', '[]'::jsonb);
  v_bl_num := coalesce((v_opt ->> 'baseline_number')::int, (v_h ->> 'baseline_for_ev')::int, 0);
  v_confirm := array(select (jsonb_array_elements_text(coalesce(v_opt -> 'confirm_remove_uids', '[]'::jsonb)))::int);
  v_remap := coalesce(v_opt -> 'uid_remap', '[]'::jsonb);

  -- calendar (project default) from the file's project calendar
  if coalesce((v_opt ->> 'apply_calendar')::boolean, true) and jsonb_array_length(coalesce(v_s -> 'calendars', '[]'::jsonb)) > 0 then
    select x into c from jsonb_array_elements(v_s -> 'calendars') x
      where (x ->> 'uid')::int = coalesce((v_s ->> 'project_calendar_uid')::int, (x ->> 'uid')::int)
      order by ((x ->> 'uid')::int = (v_s ->> 'project_calendar_uid')::int) desc nulls last limit 1;
    select * into v_cal from public.project_calendars where project_id = v_project and is_default and deleted_at is null;
    if c is not null and v_cal.id is not null then
      if jsonb_array_length(coalesce(c -> 'week', '[]'::jsonb)) > 0 then
        v_wd := array(select case when (w ->> 'dow')::int = 0 then 7 else (w ->> 'dow')::int end
                      from jsonb_array_elements(c -> 'week') w where coalesce((w ->> 'working')::boolean, false) order by 1);
        select max((w ->> 'minutes')::numeric) filter (where (w ->> 'working')::boolean),
               max((w ->> 'minutes')::numeric) filter (where (w ->> 'working')::boolean and (w ->> 'dow')::int = 6)
          into v_maxmin, v_satmin from jsonb_array_elements(c -> 'week') w;
        if coalesce(array_length(v_wd, 1), 0) > 0 then
          update public.project_calendars set working_weekdays = v_wd, msp_uid = (c ->> 'uid')::int, source = 'msp_import',
            schedule_id = v_sched, name = coalesce(nullif(c ->> 'name', ''), name),
            hours_per_day = coalesce(round(nullif(v_maxmin, 0) / 60, 2), hours_per_day),
            saturday_factor = case when v_satmin is not null and v_maxmin > 0 then least(1, round(v_satmin / v_maxmin, 2)) else saturday_factor end
          where id = v_cal.id;
        end if;
      end if;
      for e in select x from jsonb_array_elements(coalesce(c -> 'exceptions', '[]'::jsonb)) x loop
        for d in select left(e ->> 'from', 10)::date + k from generate_series(0, least(366,
                   coalesce(left(e ->> 'to', 10)::date, left(e ->> 'from', 10)::date) - left(e ->> 'from', 10)::date)) k loop
          insert into public.calendar_exceptions (calendar_id, project_id, on_date, is_working, name, source)
          values (v_cal.id, v_project, d, coalesce((e ->> 'working')::boolean, false), e ->> 'name', 'msp_import')
          on conflict (calendar_id, on_date) do update
            set is_working = excluded.is_working, name = excluded.name, deleted_at = null
            where public.calendar_exceptions.source = 'msp_import' or public.calendar_exceptions.deleted_at is not null;
          v_dates := v_dates || d;
        end loop;
      end loop;
      update public.calendar_exceptions set deleted_at = now()
        where calendar_id = v_cal.id and source = 'msp_import' and deleted_at is null and on_date <> all (v_dates);
    end if;
  end if;

  -- tasks: match by UID → GUID → user remap; never touch progress, mapping or EV method
  for r in select x as t, ord from jsonb_array_elements(v_s -> 'tasks') with ordinality as y(x, ord) order by ord loop
    t := r.t;
    v_uid := (t ->> 'uid')::int;
    v_lvl := coalesce((t ->> 'outline_level')::int, (t ->> 'outline')::int, 1);
    continue when v_lvl <= 0 or v_uid = 0 or coalesce((t ->> 'active')::boolean, true) = false;
    v_guid := nullif(t ->> 'guid', '');
    v_name := coalesce(nullif(trim(t ->> 'name'), ''), 'Task ' || v_uid);
    v_summary := coalesce((t ->> 'is_summary')::boolean, (t ->> 'summary')::boolean, false);
    v_ms := coalesce((t ->> 'is_milestone')::boolean, (t ->> 'milestone')::boolean, false);
    v_start := left(coalesce(t ->> 'start', t ->> 'start_date', t ->> 'planned_start'), 10)::date;
    v_finish := left(coalesce(t ->> 'finish', t ->> 'finish_date', t ->> 'planned_finish'), 10)::date;
    v_dur := round(coalesce((t ->> 'duration_days')::numeric, case when v_ms then 0 end,
                            case when v_start is not null and v_finish is not null then app.working_days(v_project, v_start, v_finish) end), 2);
    if v_ms then v_dur := 0; end if;
    -- baselines: [{number,start,finish,duration_days,cost}] or {baseline:{…}} / baseline_start … shorthand
    v_bls := coalesce(t -> 'baselines', case when t ? 'baseline' then jsonb_build_array((t -> 'baseline') || jsonb_build_object('number', v_bl_num)) end,
                      case when t ? 'baseline_start' then jsonb_build_array(jsonb_build_object('number', v_bl_num,
                        'start', t ->> 'baseline_start', 'finish', t ->> 'baseline_finish', 'cost', t -> 'baseline_cost')) end, '[]'::jsonb);
    select x into v_bl from jsonb_array_elements(v_bls) x where coalesce((x ->> 'number')::int, 0) = v_bl_num limit 1;
    v_bl_start := left(v_bl ->> 'start', 10)::date; v_bl_finish := left(v_bl ->> 'finish', 10)::date;
    v_bl_dates := coalesce((select jsonb_agg(jsonb_build_object('number', coalesce((x ->> 'number')::int, 0),
                    'start', left(x ->> 'start', 10), 'finish', left(x ->> 'finish', 10), 'duration_days', (x ->> 'duration_days')::numeric))
                  from jsonb_array_elements(v_bls) x), '[]'::jsonb);
    v_bl_costs := coalesce((select jsonb_agg(jsonb_build_object('number', coalesce((x ->> 'number')::int, 0), 'cost', (x ->> 'cost')::numeric))
                  from jsonb_array_elements(v_bls) x where x ? 'cost' and x ->> 'cost' is not null), '[]'::jsonb);

    -- match
    ot := null;
    select * into ot from public.schedule_tasks where schedule_id = v_sched and msp_uid = v_uid and not (id = any (v_matched));
    if ot.id is null and v_guid is not null then
      select * into ot from public.schedule_tasks where schedule_id = v_sched and msp_guid = v_guid and not (id = any (v_matched));
    end if;
    if ot.id is null then
      select (x ->> 'old_uid')::int into v_old_uid from jsonb_array_elements(v_remap) x where (x ->> 'new_uid')::int = v_uid limit 1;
      if v_old_uid is not null then
        select * into ot from public.schedule_tasks where schedule_id = v_sched and msp_uid = v_old_uid and not (id = any (v_matched));
      end if;
      v_old_uid := null;
    end if;
    v_parent := case when nullif(t ->> 'parent_uid', '') is not null then (v_map ->> (t ->> 'parent_uid'))::uuid
                     when v_lvl > 1 then v_stack[v_lvl - 1] end;

    if ot.id is null then
      insert into public.schedule_tasks (project_id, schedule_id, msp_uid, msp_guid, msp_id, wbs, outline_number, outline_level,
        parent_id, sort_order, name, notes, is_summary, is_milestone, is_manual, is_elapsed, planned_start, planned_finish,
        duration_days, constraint_type, constraint_date, deadline, cost_accrual, custom, msp_critical, msp_total_float_days,
        msp_pct_complete, msp_baseline_start, msp_baseline_finish, msp_baselines, baseline_start, baseline_finish,
        forecast_start, forecast_finish, is_critical, total_float_days, last_version_id)
      values (v_project, v_sched, v_uid, v_guid, (t ->> 'id')::int, t ->> 'wbs', t ->> 'outline_number', v_lvl,
        v_parent, r.ord, v_name, t ->> 'notes', v_summary, v_ms, coalesce((t ->> 'is_manual')::boolean, false),
        coalesce((t ->> 'is_elapsed')::boolean, false), v_start, v_finish, v_dur, (t ->> 'constraint_type')::smallint,
        left(t ->> 'constraint_date', 10)::date, left(t ->> 'deadline', 10)::date,
        case (t ->> 'fixed_cost_accrual')::int when 1 then 'start' when 2 then 'end' else 'prorated' end,
        coalesce(t -> 'custom', '{}'::jsonb), coalesce((t ->> 'critical')::boolean, (t ->> 'is_critical')::boolean),
        coalesce((t ->> 'total_float_days')::numeric, (t ->> 'total_float')::numeric),
        coalesce((t ->> 'pct_complete')::numeric, (t ->> 'pct')::numeric), v_bl_start, v_bl_finish, v_bl_dates,
        case when sc.approved_baseline_id is null then v_bl_start end, case when sc.approved_baseline_id is null then v_bl_finish end,
        v_start, v_finish, coalesce((t ->> 'critical')::boolean, (t ->> 'is_critical')::boolean, false),
        coalesce((t ->> 'total_float_days')::numeric, (t ->> 'total_float')::numeric), v_ver)
      returning id into v_id;
      v_new := v_new || v_id;
      v_added := v_added || jsonb_build_object('uid', v_uid, 'name', v_name, 'id', v_id);
    else
      v_id := ot.id;
      v_chg := '{}'::jsonb;
      if ot.name is distinct from v_name then v_chg := v_chg || jsonb_build_object('name', jsonb_build_array(ot.name, v_name)); end if;
      if ot.wbs is distinct from (t ->> 'wbs') then v_chg := v_chg || jsonb_build_object('wbs', jsonb_build_array(ot.wbs, t ->> 'wbs')); end if;
      if ot.planned_start is distinct from v_start then v_chg := v_chg || jsonb_build_object('planned_start', jsonb_build_array(ot.planned_start, v_start)); end if;
      if ot.planned_finish is distinct from v_finish then v_chg := v_chg || jsonb_build_object('planned_finish', jsonb_build_array(ot.planned_finish, v_finish)); end if;
      if ot.duration_days is distinct from v_dur then v_chg := v_chg || jsonb_build_object('duration_days', jsonb_build_array(ot.duration_days, v_dur)); end if;
      if ot.msp_uid is distinct from v_uid then v_chg := v_chg || jsonb_build_object('msp_uid', jsonb_build_array(ot.msp_uid, v_uid)); end if;
      if ot.outline_level is distinct from v_lvl or ot.is_summary is distinct from v_summary or ot.is_milestone is distinct from v_ms then
        v_chg := v_chg || jsonb_build_object('structure', true);
      end if;
      if ot.deleted_at is not null or ot.source_state <> 'active' then v_chg := v_chg || jsonb_build_object('restored', true); end if;
      if coalesce((t ->> 'pct_complete')::numeric, (t ->> 'pct')::numeric) is distinct from null
         and coalesce((t ->> 'pct_complete')::numeric, (t ->> 'pct')::numeric) <> ot.pct_complete then
        v_chg := v_chg || jsonb_build_object('msp_pct_vs_verified', jsonb_build_array(coalesce((t ->> 'pct_complete')::numeric, (t ->> 'pct')::numeric), ot.pct_complete));
      end if;
      update public.schedule_tasks set msp_uid = v_uid, msp_guid = coalesce(v_guid, msp_guid), msp_id = (t ->> 'id')::int,
        wbs = t ->> 'wbs', outline_number = t ->> 'outline_number', outline_level = v_lvl, parent_id = v_parent, sort_order = r.ord,
        name = v_name, notes = t ->> 'notes', is_summary = v_summary, is_milestone = v_ms,
        is_manual = coalesce((t ->> 'is_manual')::boolean, false), is_elapsed = coalesce((t ->> 'is_elapsed')::boolean, false),
        planned_start = v_start, planned_finish = v_finish, duration_days = v_dur,
        constraint_type = (t ->> 'constraint_type')::smallint, constraint_date = left(t ->> 'constraint_date', 10)::date,
        deadline = left(t ->> 'deadline', 10)::date,
        cost_accrual = case (t ->> 'fixed_cost_accrual')::int when 1 then 'start' when 2 then 'end' else 'prorated' end,
        custom = coalesce(t -> 'custom', '{}'::jsonb),
        msp_critical = coalesce((t ->> 'critical')::boolean, (t ->> 'is_critical')::boolean),
        msp_total_float_days = coalesce((t ->> 'total_float_days')::numeric, (t ->> 'total_float')::numeric),
        msp_pct_complete = coalesce((t ->> 'pct_complete')::numeric, (t ->> 'pct')::numeric),
        msp_baseline_start = v_bl_start, msp_baseline_finish = v_bl_finish, msp_baselines = v_bl_dates,
        baseline_start = case when sc.approved_baseline_id is null then v_bl_start else baseline_start end,
        baseline_finish = case when sc.approved_baseline_id is null then v_bl_finish else baseline_finish end,
        forecast_start = case when fc_status_date is null then v_start else forecast_start end,
        forecast_finish = case when fc_status_date is null then v_finish else forecast_finish end,
        source_state = 'active', deleted_at = null, last_version_id = v_ver
      where id = v_id;
      if v_chg <> '{}'::jsonb then
        v_changed := v_changed || jsonb_build_object('uid', v_uid, 'name', v_name, 'id', v_id, 'fields', v_chg);
      end if;
    end if;
    v_matched := v_matched || v_id;
    v_map := v_map || jsonb_build_object(v_uid::text, v_id);
    v_stack[v_lvl] := v_id;

    -- MSP costs (price roles only)
    if t ? 'cost' or t ? 'fixed_cost' or t ? 'actual_cost' or jsonb_array_length(v_bl_costs) > 0 then
      if v_prices then
        insert into public.schedule_task_costs (task_id, project_id, msp_cost, msp_fixed_cost, msp_actual_cost, msp_baseline_cost, baselines)
        values (v_id, v_project, (t ->> 'cost')::numeric, (t ->> 'fixed_cost')::numeric, (t ->> 'actual_cost')::numeric,
                (v_bl ->> 'cost')::numeric, v_bl_costs)
        on conflict (task_id) do update set msp_cost = excluded.msp_cost, msp_fixed_cost = excluded.msp_fixed_cost,
          msp_actual_cost = excluded.msp_actual_cost, msp_baseline_cost = excluded.msp_baseline_cost, baselines = excluded.baselines;
      else
        v_cost_seen := true;
      end if;
    end if;
  end loop;
  if v_cost_seen then
    v_warn := v_warn || to_jsonb('Costs in the file were not saved: your role cannot see prices (ask a coordinator or manager to import, or BAC will come from the BoQ mapping)'::text);
  end if;

  -- tasks missing from the file: kept (flagged) when they carry progress or cost, else soft-deleted
  for ot in select * from public.schedule_tasks where schedule_id = v_sched and deleted_at is null and not (id = any (v_matched)) loop
    v_has_progress := exists (select 1 from public.task_progress where task_id = ot.id and status <> 'rejected')
                   or exists (select 1 from public.cost_entries where task_id = ot.id)
                   or ot.pct_complete > 0;
    if v_has_progress and not (ot.msp_uid = any (v_confirm)) then
      update public.schedule_tasks set source_state = 'removed_in_source' where id = ot.id;
      v_kept := v_kept || jsonb_build_object('uid', ot.msp_uid, 'name', ot.name, 'id', ot.id, 'pct_complete', ot.pct_complete);
    else
      update public.schedule_tasks set deleted_at = now() where id = ot.id;
      v_removed := v_removed || jsonb_build_object('uid', ot.msp_uid, 'name', ot.name, 'id', ot.id);
    end if;
  end loop;

  -- links: replaced for this version (links to/from summary tasks are expanded to their leaves)
  for l in select x from jsonb_array_elements(coalesce(v_s -> 'links', '[]'::jsonb)) x loop
    v_pred := (v_map ->> (l ->> 'pred_uid'))::uuid;
    v_succ := (v_map ->> (l ->> 'succ_uid'))::uuid;
    if v_pred is null or v_succ is null then
      raise exception 'Link % → % refers to a task UID that is not in the file', l ->> 'pred_uid', l ->> 'succ_uid';
    end if;
    v_type := upper(coalesce(nullif(l ->> 'type', ''), nullif(l ->> 'link_type', ''), 'FS'));
    if v_type not in ('FS','SS','FF','SF') then raise exception 'Link % → %: unknown type %', l ->> 'pred_uid', l ->> 'succ_uid', v_type; end if;
    v_lag := coalesce((l ->> 'lag_days')::numeric, 0);
    v_exp := exists (select 1 from public.schedule_tasks where id in (v_pred, v_succ) and is_summary);
    for a in select app.leaf_tasks_under(v_pred) loop
      for b in select app.leaf_tasks_under(v_succ) loop
        continue when a = b;
        insert into public.schedule_links (project_id, schedule_id, pred_task_id, succ_task_id, link_type, lag_days, lag_elapsed,
          expanded_from_summary, version_id)
        values (v_project, v_sched, a, b, v_type, v_lag, coalesce((l ->> 'lag_elapsed')::boolean, false), v_exp, v_ver)
        on conflict (pred_task_id, succ_task_id, link_type) do update
          set lag_days = excluded.lag_days, lag_elapsed = excluded.lag_elapsed,
              expanded_from_summary = excluded.expanded_from_summary, version_id = excluded.version_id, deleted_at = null;
        v_links := v_links + 1;
      end loop;
    end loop;
  end loop;
  update public.schedule_links set deleted_at = now()
    where schedule_id = v_sched and deleted_at is null and version_id is distinct from v_ver;
  perform app.run_cpm(v_sched, coalesce(sc.status_date, app.eat_date(now())), false);   -- loop check (raises)

  -- mapping from file (BoQ / element codes); existing mapping kept unless file_mapping_wins
  for r in select x as t from jsonb_array_elements(v_s -> 'tasks') x loop
    t := r.t;
    v_id := (v_map ->> (t ->> 'uid'))::uuid;
    continue when v_id is null;
    v_boq_txt := coalesce(case jsonb_typeof(t -> 'boq_codes') when 'array' then (select string_agg(x, ';') from jsonb_array_elements_text(t -> 'boq_codes') x)
                               when 'string' then t ->> 'boq_codes' end,
                          case when v_boq_field is not null then t -> 'custom' ->> v_boq_field end);
    v_el_txt := coalesce(case jsonb_typeof(t -> 'element_codes') when 'array' then (select string_agg(x, ';') from jsonb_array_elements_text(t -> 'element_codes') x)
                              when 'string' then t ->> 'element_codes' end,
                         case when v_el_field is not null then t -> 'custom' ->> v_el_field end);
    continue when v_boq_txt is null and v_el_txt is null;
    v_mres := app.apply_task_mapping(v_id, v_boq_txt, v_el_txt, v_wins, 'file');
    v_warn := v_warn || coalesce(v_mres -> 'warnings', '[]'::jsonb);
    v_items := v_items || array(select (jsonb_array_elements_text(coalesce(v_mres -> 'boq_items', '[]'::jsonb)))::uuid);
  end loop;
  if array_length(v_items, 1) > 0 then perform app.redistribute_auto_qty(v_items); end if;
  update public.schedule_tasks set ev_method = app.default_ev_method(id) where id = any (v_new);

  -- opening progress (first import only): file % becomes verified progress dated the file status date
  if v_first and coalesce((v_opt ->> 'opening_progress')::boolean, false) then
    v_status := coalesce(left(v_h ->> 'status_date', 10)::date, app.eat_date(now()));
    for r in select x as t from jsonb_array_elements(v_s -> 'tasks') x loop
      v_id := (v_map ->> (r.t ->> 'uid'))::uuid;
      v_pct := coalesce((r.t ->> 'pct_complete')::numeric, (r.t ->> 'pct')::numeric, 0);
      continue when v_id is null or v_pct <= 0;
      select * into ot from public.schedule_tasks where id = v_id;
      continue when ot.is_summary or ot.ev_method in ('elements','loe');
      insert into public.task_progress (id, project_id, task_id, status_date, method, pct_complete, actual_start, actual_finish,
        source, status, verified_pct, verified_qty, verified_actual_start, verified_actual_finish, reported_by, verified_by,
        verified_at, verify_comment)
      values (gen_random_uuid(), v_project, v_id, v_status, ot.ev_method, v_pct, left(r.t ->> 'actual_start', 10)::date,
        left(r.t ->> 'actual_finish', 10)::date, 'import', 'verified', v_pct,
        case when ot.ev_method = 'units' then (select jsonb_agg(jsonb_build_object('boq_item_id', bl.boq_item_id,
                 'qty_to_date', round(bl.qty_share * v_pct / 100, 3))) from public.task_boq_links bl where bl.task_id = v_id and bl.deleted_at is null) end,
        left(r.t ->> 'actual_start', 10)::date, left(r.t ->> 'actual_finish', 10)::date, auth.uid(), auth.uid(), now(),
        'Opening progress from the MS Project file');
      perform app.refresh_task_progress(v_id, false);
    end loop;
  end if;

  -- schedule header, forecast, roll-ups
  update public.schedules set current_version_id = v_ver,
    minutes_per_day = coalesce((v_h ->> 'minutes_per_day')::int, minutes_per_day),
    minutes_per_week = coalesce((v_h ->> 'minutes_per_week')::int, minutes_per_week),
    days_per_month = coalesce((v_h ->> 'days_per_month')::int, days_per_month),
    currency_code = coalesce(v_h ->> 'currency_code', currency_code),
    planned_start = coalesce(left(v_h ->> 'start_date', 10)::date,
      (select min(planned_start) from public.schedule_tasks where schedule_id = v_sched and deleted_at is null)),
    planned_finish = coalesce(left(v_h ->> 'finish_date', 10)::date,
      (select max(planned_finish) from public.schedule_tasks where schedule_id = v_sched and deleted_at is null))
  where id = v_sched;
  select * into sc from public.schedules where id = v_sched;
  if sc.status_date is not null then
    perform app.run_cpm(v_sched, sc.status_date, true);
  else
    perform app.rollup_summaries(v_sched);
  end if;

  -- quality report (DCMA-style, adapted)
  select jsonb_build_object(
    'leaf_tasks', count(*) filter (where not t.is_summary),
    'summary_tasks', count(*) filter (where t.is_summary),
    'milestones', count(*) filter (where t.is_milestone),
    'missing_predecessor', count(*) filter (where not t.is_summary and not exists (
       select 1 from public.schedule_links x where x.succ_task_id = t.id and x.deleted_at is null)),
    'missing_successor', count(*) filter (where not t.is_summary and not exists (
       select 1 from public.schedule_links x where x.pred_task_id = t.id and x.deleted_at is null)),
    'hard_constraints', count(*) filter (where t.constraint_type in (2, 3, 5, 7)),
    'long_tasks', count(*) filter (where not t.is_summary and t.duration_days > 44 and t.ev_method <> 'loe'),
    'manual_tasks', count(*) filter (where t.is_manual),
    'no_baseline', count(*) filter (where not t.is_summary and t.msp_baseline_start is null),
    'mapped_tasks', count(*) filter (where not t.is_summary and (
       exists (select 1 from public.task_boq_links x where x.task_id = t.id and x.deleted_at is null)
       or exists (select 1 from public.task_element_links x where x.task_id = t.id and x.deleted_at is null))),
    'removed_with_progress', jsonb_array_length(v_kept))
    into v_q
  from public.schedule_tasks t where t.schedule_id = v_sched and t.deleted_at is null;
  select v_q || jsonb_build_object(
    'links', count(*), 'negative_lags', count(*) filter (where lag_days < 0), 'links_with_lag', count(*) filter (where lag_days > 0),
    'link_types', jsonb_build_object('FS', count(*) filter (where link_type = 'FS'), 'SS', count(*) filter (where link_type = 'SS'),
                                     'FF', count(*) filter (where link_type = 'FF'), 'SF', count(*) filter (where link_type = 'SF')),
    'summary_links_expanded', count(*) filter (where expanded_from_summary))
    into v_q from public.schedule_links where schedule_id = v_sched and deleted_at is null;
  select v_q || jsonb_build_object('calendar_working_days_per_week', coalesce(array_length(c2.working_weekdays, 1), 6),
    'calendar_holidays', (select count(*) from public.public_holidays h where h.country = coalesce(c2.holiday_country, 'ET')
                            and h.deleted_at is null and h.on_date between sc.planned_start and sc.planned_finish)
                         + (select count(*) from public.calendar_exceptions x where x.calendar_id = c2.id and x.deleted_at is null and not x.is_working),
    'no_costs', not v_prices or not exists (select 1 from public.schedule_task_costs k join public.schedule_tasks t on t.id = k.task_id
                                            where t.schedule_id = v_sched))
    into v_q from (select 1) one left join public.project_calendars c2 on c2.project_id = v_project and c2.is_default and c2.deleted_at is null;

  v_res := jsonb_build_object('ok', true, 'schedule_id', v_sched, 'version_id', v_ver, 'version_no', v_ver_no,
    'added', jsonb_array_length(v_added), 'changed', jsonb_array_length(v_changed), 'removed', jsonb_array_length(v_removed),
    'kept_progress', jsonb_array_length(v_kept), 'links', (v_q ->> 'links')::int, 'warnings', v_warn, 'quality', v_q,
    'diff', jsonb_build_object('added', v_added, 'changed', v_changed, 'removed', v_removed, 'kept_progress', v_kept));
  update public.schedule_versions set diff = v_res -> 'diff', warnings = v_warn, quality = v_q, result = v_res where id = v_ver;
  perform app.notify_roles(v_project, '{coordinator,manager,office_engineer}', 'Schedule imported: ' || sc.name || ' v' || v_ver_no,
    format('%s added, %s changed, %s removed, %s kept (progress)', jsonb_array_length(v_added), jsonb_array_length(v_changed),
           jsonb_array_length(v_removed), jsonb_array_length(v_kept)), 'schedule', v_sched);
  return app.op_done(p, 'import_schedule', v_res);
end $$;

-- -----------------------------------------------------------------------------
-- RPC: task setup & mapping
-- -----------------------------------------------------------------------------

create or replace function public.save_task_setup(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  it jsonb; x jsonb; t public.schedule_tasks; v_n int := 0; v_method text; v_items uuid[];
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_role('office_engineer','coordinator','manager','admin');
  for it in select y from jsonb_array_elements(case when p ? 'tasks' then p -> 'tasks' else jsonb_build_array(p) end) y loop
    select * into t from public.schedule_tasks where id = (it ->> 'task_id')::uuid for update;
    if not found then raise exception 'Task not found'; end if;
    perform app.require_member(t.project_id);
    if t.is_summary and (it ? 'ev_method' or it ? 'boq_links' or it ? 'element_links' or it ? 'steps') then
      raise exception 'Summary task "%" takes its numbers from its sub-tasks', t.name;
    end if;
    v_items := '{}';

    for x in select y from jsonb_array_elements(coalesce(it -> 'boq_links', '[]'::jsonb)) y loop
      if not exists (select 1 from public.boq_items where id = (x ->> 'boq_item_id')::uuid and project_id = t.project_id) then
        raise exception 'BoQ item not found in this project';
      end if;
      if coalesce((x ->> 'deleted')::boolean, false) then
        update public.task_boq_links set deleted_at = now() where task_id = t.id and boq_item_id = (x ->> 'boq_item_id')::uuid;
      else
        if (x ->> 'qty_share') is not null and (x ->> 'qty_share')::numeric < 0 then raise exception 'Quantity share cannot be negative'; end if;
        insert into public.task_boq_links (id, project_id, task_id, boq_item_id, qty_share, source)
        values (coalesce((x ->> 'id')::uuid, gen_random_uuid()), t.project_id, t.id, (x ->> 'boq_item_id')::uuid,
                coalesce((x ->> 'qty_share')::numeric, 0), case when x ->> 'qty_share' is null then 'auto' else 'ui' end)
        on conflict (task_id, boq_item_id) do update set qty_share = excluded.qty_share, source = excluded.source, deleted_at = null;
      end if;
      v_items := v_items || (x ->> 'boq_item_id')::uuid;
    end loop;
    if array_length(v_items, 1) > 0 then perform app.redistribute_auto_qty(v_items); end if;

    for x in select y from jsonb_array_elements(coalesce(it -> 'element_links', '[]'::jsonb)) y loop
      if not exists (select 1 from public.elements where id = (x ->> 'element_id')::uuid and project_id = t.project_id) then
        raise exception 'Element not found in this project';
      end if;
      if coalesce((x ->> 'deleted')::boolean, false) then
        update public.task_element_links set deleted_at = now() where task_id = t.id and element_id = (x ->> 'element_id')::uuid;
      else
        insert into public.task_element_links (id, project_id, task_id, element_id, weight, activity_seq_from, activity_seq_to, source)
        values (coalesce((x ->> 'id')::uuid, gen_random_uuid()), t.project_id, t.id, (x ->> 'element_id')::uuid,
                (x ->> 'weight')::numeric, (x ->> 'activity_seq_from')::int, (x ->> 'activity_seq_to')::int, 'ui')
        on conflict (task_id, element_id) do update set weight = excluded.weight, activity_seq_from = excluded.activity_seq_from,
          activity_seq_to = excluded.activity_seq_to, deleted_at = null;
      end if;
    end loop;

    for x in select y from jsonb_array_elements(coalesce(it -> 'steps', '[]'::jsonb)) y loop
      if coalesce((x ->> 'deleted')::boolean, false) then
        update public.task_steps set deleted_at = now() where id = (x ->> 'id')::uuid and task_id = t.id;
      else
        if coalesce((x ->> 'weight')::numeric, 0) <= 0 then raise exception 'Step weights must be greater than zero'; end if;
        insert into public.task_steps (id, project_id, task_id, seq, name, weight)
        values ((x ->> 'id')::uuid, t.project_id, t.id, (x ->> 'seq')::int, x ->> 'name', (x ->> 'weight')::numeric)
        on conflict (id) do update set seq = excluded.seq, name = excluded.name, weight = excluded.weight, deleted_at = null;
      end if;
    end loop;

    if it ? 'ev_method' then
      v_method := it ->> 'ev_method';
      if v_method not in ('units','elements','steps','0_100','50_50','pct','milestone','loe') then
        raise exception 'Unknown EV method %', v_method;
      end if;
      if v_method <> t.ev_method and exists (select 1 from public.evm_periods where project_id = t.project_id and status = 'closed')
         and coalesce(trim(it ->> 'comment'), '') = '' then
        raise exception 'Changing how "%" earns value after a closed period needs a comment', t.name;
      end if;
      if v_method = 'elements' and not exists (select 1 from public.task_element_links where task_id = t.id and deleted_at is null) then
        raise exception 'Link elements to "%" before using the elements method', t.name;
      end if;
      if v_method = 'units' and not exists (select 1 from public.task_boq_links where task_id = t.id and deleted_at is null) then
        raise exception 'Link BoQ items to "%" before using the quantity (units) method', t.name;
      end if;
      if v_method = 'steps' and not exists (select 1 from public.task_steps where task_id = t.id and deleted_at is null) then
        raise exception 'Add steps to "%" before using the steps method', t.name;
      end if;
    end if;
    update public.schedule_tasks set
      ev_method = coalesce(it ->> 'ev_method', ev_method),
      start_pct = case when it ? 'start_pct' then (it ->> 'start_pct')::numeric else start_pct end,
      block_id = case when it ? 'block_id' then (it ->> 'block_id')::uuid else block_id end,
      level_id = case when it ? 'level_id' then (it ->> 'level_id')::uuid else level_id end,
      setup_comment = coalesce(nullif(it ->> 'comment', ''), setup_comment)
    where id = t.id;
    perform app.refresh_task_progress(t.id);
    v_n := v_n + 1;
  end loop;
  return app.op_done(p, 'save_task_setup', jsonb_build_object('ok', true, 'tasks', v_n));
end $$;

-- Re-run the BoQ / element mapping from custom fields for every task of a schedule.
create or replace function public.auto_link_tasks(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  sc public.schedules; t public.schedule_tasks; v_res jsonb; v_warn jsonb := '[]'::jsonb; v_items uuid[] := '{}';
  v_nb int := 0; v_ne int := 0; v_bf text := nullif(p ->> 'boq_field', ''); v_ef text := nullif(p ->> 'element_field', '');
  v_set boolean := coalesce((p ->> 'set_methods')::boolean, true); v_m text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into sc from public.schedules where id = (p ->> 'schedule_id')::uuid;
  if not found then raise exception 'Schedule not found'; end if;
  perform app.require_member(sc.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if v_bf is null and v_ef is null then raise exception 'Choose the custom field that holds BoQ item numbers or element codes'; end if;
  for t in select * from public.schedule_tasks where schedule_id = sc.id and deleted_at is null and not is_summary order by sort_order loop
    continue when (v_bf is null or t.custom ->> v_bf is null) and (v_ef is null or t.custom ->> v_ef is null);
    v_res := app.apply_task_mapping(t.id, case when v_bf is not null then t.custom ->> v_bf end,
                                    case when v_ef is not null then t.custom ->> v_ef end,
                                    coalesce((p ->> 'overwrite')::boolean, false), 'file');
    v_nb := v_nb + (v_res ->> 'boq')::int; v_ne := v_ne + (v_res ->> 'elements')::int;
    v_warn := v_warn || (v_res -> 'warnings');
    v_items := v_items || array(select (jsonb_array_elements_text(coalesce(v_res -> 'boq_items', '[]'::jsonb)))::uuid);
    if v_set and t.ev_method in ('pct','0_100') and not exists (select 1 from public.task_progress where task_id = t.id) then
      v_m := app.default_ev_method(t.id);
      if v_m in ('units','elements') then update public.schedule_tasks set ev_method = v_m where id = t.id; end if;
    end if;
    perform app.refresh_task_progress(t.id, false);
  end loop;
  if array_length(v_items, 1) > 0 then perform app.redistribute_auto_qty(v_items); end if;
  perform app.rollup_summaries(sc.id);
  return app.op_done(p, 'auto_link_tasks', jsonb_build_object('ok', true, 'boq_links', v_nb, 'element_links', v_ne, 'warnings', v_warn));
end $$;

-- -----------------------------------------------------------------------------
-- RPC: progress (site engineer reports, office engineer verifies)
-- -----------------------------------------------------------------------------

create or replace function public.report_task_progress(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  t public.schedule_tasks; cfg public.project_settings;
  v_date date; v_orig date; v_cut date; v_period uuid; v_today date := app.eat_date(now());
  v_pct numeric := (p ->> 'pct_complete')::numeric; v_qty jsonb := p -> 'qty'; v_steps jsonb := p -> 'steps';
  v_start_pct numeric; v_qdone numeric; x record; v_last numeric; v_hold text; v_remarks text := nullif(trim(p ->> 'remarks'), '');
  v_link uuid;
begin
  if v_seen is not null then return v_seen; end if;
  if v_id is null then raise exception 'Progress report id is required'; end if;
  select * into t from public.schedule_tasks where id = (p ->> 'task_id')::uuid;
  if not found then raise exception 'Task not found'; end if;
  perform app.require_member(t.project_id);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  if t.deleted_at is not null then raise exception 'Task "%" was removed from the schedule', t.name; end if;
  if t.is_summary then raise exception 'Report progress on the detailed tasks, not on the summary "%"', t.name; end if;
  if t.ev_method = 'elements' then
    raise exception 'Task "%" takes its progress from its elements — report the element activities instead', t.name;
  end if;
  if t.ev_method = 'loe' then raise exception 'Level-of-effort task "%" earns with time and is not reported', t.name; end if;
  cfg := app.evm_cfg(t.project_id);

  v_date := coalesce((p ->> 'status_date')::date, v_today);
  if v_date > v_today then raise exception 'Progress cannot be dated in the future (%)', v_date; end if;
  v_cut := app.closed_cutoff(t.project_id);
  if v_cut is not null and v_date <= v_cut then          -- offline report arriving after the period closed
    v_orig := v_date; v_period := app.closed_period_for(t.project_id, v_date); v_date := v_cut + 1;
  end if;

  if t.ev_method = 'units' then
    if not exists (select 1 from public.task_boq_links where task_id = t.id and deleted_at is null) then
      raise exception 'Task "%" has no BoQ items linked — ask the office engineer to map it', t.name;
    end if;
    if v_qty is null and p ? 'qty_done' then
      select boq_item_id into v_link from public.task_boq_links where task_id = t.id and deleted_at is null;
      if (select count(*) from public.task_boq_links where task_id = t.id and deleted_at is null) > 1 then
        raise exception 'Task "%" has several BoQ items — report the quantity of each', t.name;
      end if;
      v_qty := jsonb_build_array(jsonb_build_object('boq_item_id', v_link, 'qty_to_date', (p ->> 'qty_done')::numeric));
    end if;
    if v_qty is null or jsonb_array_length(v_qty) = 0 then raise exception 'Enter the quantity done to date'; end if;
    for x in select * from jsonb_to_recordset(v_qty) as y(boq_item_id uuid, qty_to_date numeric) loop
      select verified_qty into v_last from public.task_boq_links where task_id = t.id and boq_item_id = x.boq_item_id and deleted_at is null;
      if not found then raise exception 'BoQ item is not linked to task "%"', t.name; end if;
      if x.qty_to_date is null or x.qty_to_date < 0 then raise exception 'Quantity to date must be zero or more'; end if;
      if x.qty_to_date < v_last and v_remarks is null then
        raise exception 'Quantity to date % is less than the verified % — add a remark (re-measurement)', x.qty_to_date, v_last;
      end if;
      if x.qty_to_date > (select qty_share from public.task_boq_links where task_id = t.id and boq_item_id = x.boq_item_id) and v_remarks is null then
        raise exception 'Quantity % is more than planned for this task — add a remark (over-measure)', x.qty_to_date;
      end if;
    end loop;
    v_pct := app.units_pct(t.id, v_qty);
    select sum(y.qty_to_date) into v_qdone from jsonb_to_recordset(v_qty) as y(boq_item_id uuid, qty_to_date numeric);
  elsif t.ev_method = 'steps' then
    if v_steps is null then raise exception 'Tick the steps done'; end if;
    v_pct := app.steps_pct(t.id, v_steps);
  else
    if v_pct is null then raise exception 'Enter the percent complete'; end if;
    if v_pct < 0 or v_pct > 100 then raise exception 'Percent complete must be between 0 and 100'; end if;
    if t.ev_method in ('0_100','milestone') and v_pct not in (0, 100) then
      raise exception 'Task "%" is measured 0/100: report 0 or 100 (finished)', t.name;
    end if;
    v_start_pct := coalesce(t.start_pct, cfg.evm_default_start_pct, 50);
    if t.ev_method = '50_50' and v_pct not in (0, v_start_pct, 100) then
      raise exception 'Task "%" is measured start/finish: report 0, % (started) or 100 (finished)', t.name, v_start_pct;
    end if;
  end if;
  if (p ->> 'actual_finish') is not null and v_pct < 100 then raise exception 'A finished task must be 100%%'; end if;
  if (p ->> 'actual_start')::date > coalesce((p ->> 'actual_finish')::date, (p ->> 'actual_start')::date) then
    raise exception 'Actual start is after actual finish';
  end if;
  if coalesce((p ->> 'remaining_days')::numeric, 0) < 0 then raise exception 'Remaining duration cannot be negative'; end if;
  if v_pct >= 100 and coalesce(cfg.enforce_hold_points, true) then
    select a.name || ' on ' || e.code into v_hold from public.task_element_links l
      join public.element_activities a on a.element_id = l.element_id and a.is_hold_point and a.verified_pct < 100
      join public.elements e on e.id = l.element_id
      where l.task_id = t.id and l.deleted_at is null limit 1;
    if v_hold is not null then raise exception 'Hold point "%" must be signed off before "%" can be finished', v_hold, t.name; end if;
  end if;

  insert into public.task_progress (id, project_id, task_id, status_date, original_status_date, rolled_from_period_id, method,
    pct_complete, qty_done, qty, steps, remaining_days, actual_start, actual_finish, delay_cause, remarks, source, reported_by, device_id)
  values (v_id, t.project_id, t.id, v_date, v_orig, v_period, t.ev_method, round(v_pct, 2), v_qdone, v_qty, v_steps,
    (p ->> 'remaining_days')::numeric, (p ->> 'actual_start')::date, (p ->> 'actual_finish')::date, nullif(p ->> 'delay_cause', ''),
    v_remarks, case when app.has_role('site_engineer') then 'field' else 'office' end, auth.uid(), app.device_id());
  update public.schedule_tasks set reported_pct = round(v_pct, 2) where id = t.id;
  if v_qty is not null then
    update public.task_boq_links l set reported_qty = y.qty_to_date
      from jsonb_to_recordset(v_qty) as y(boq_item_id uuid, qty_to_date numeric)
      where l.task_id = t.id and l.boq_item_id = y.boq_item_id;
  end if;
  if v_steps is not null then
    update public.task_steps s set reported_pct = y.done_pct
      from jsonb_to_recordset(v_steps) as y(step_id uuid, done_pct numeric) where s.id = y.step_id and s.task_id = t.id;
  end if;
  perform app.notify_roles(t.project_id, '{office_engineer}', 'Task progress to verify',
    t.name || ' at ' || round(v_pct, 1) || '%' || case when v_orig is not null then ' (late report — counted in the next period)' else '' end,
    'task_progress', v_id);
  return app.op_done(p, 'report_task_progress', jsonb_build_object('ok', true, 'id', v_id, 'status_date', v_date,
    'pct_complete', round(v_pct, 2), 'rolled_to_next_period', v_orig is not null));
end $$;

create or replace function app.verify_task_progress_one(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u public.task_progress; t public.schedule_tasks; cfg public.project_settings;
  v_approve boolean := coalesce((p ->> 'approve')::boolean, true);
  v_pct numeric; v_qty jsonb; v_steps jsonb; v_status text; v_cut date; v_date date; v_orig date; v_period uuid; v_sp numeric;
begin
  select * into u from public.task_progress where id = (p ->> 'progress_id')::uuid for update;
  if not found then raise exception 'Progress report not found'; end if;
  perform app.require_member(u.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if u.status <> 'reported' then raise exception 'Progress report already %', u.status; end if;
  if u.reported_by = auth.uid() and not app.has_role('admin') then
    raise exception 'You cannot verify your own progress report';
  end if;
  select * into t from public.schedule_tasks where id = u.task_id;
  cfg := app.evm_cfg(u.project_id);

  if t.ev_method = 'units' then
    v_qty := coalesce(p -> 'verified_qty', u.qty);
    v_pct := app.units_pct(t.id, v_qty);
  elsif t.ev_method = 'steps' then
    v_steps := coalesce(p -> 'verified_steps', u.steps);
    v_pct := app.steps_pct(t.id, v_steps);
  else
    v_pct := coalesce((p ->> 'verified_pct')::numeric, u.pct_complete);
    if v_pct < 0 or v_pct > 100 then raise exception 'Percent must be between 0 and 100'; end if;
    if t.ev_method in ('0_100','milestone') and v_pct not in (0, 100) then raise exception 'Task is measured 0/100'; end if;
    v_sp := coalesce(t.start_pct, cfg.evm_default_start_pct, 50);
    if t.ev_method = '50_50' and v_pct not in (0, v_sp, 100) then raise exception 'Task is measured 0 / % / 100', v_sp; end if;
  end if;
  v_status := case when not v_approve then 'rejected'
                   when round(v_pct, 2) <> coalesce(u.pct_complete, -1)
                     or coalesce(v_qty, 'null'::jsonb) <> coalesce(u.qty, 'null'::jsonb)
                     or coalesce(v_steps, 'null'::jsonb) <> coalesce(u.steps, 'null'::jsonb)
                     or (p ? 'actual_start' and (p ->> 'actual_start')::date is distinct from u.actual_start)
                     or (p ? 'actual_finish' and (p ->> 'actual_finish')::date is distinct from u.actual_finish) then 'adjusted'
                   else 'verified' end;
  if v_status <> 'verified' and coalesce(trim(p ->> 'comment'), '') = '' then
    raise exception 'A comment is required when adjusting or rejecting progress';
  end if;
  v_date := u.status_date; v_orig := u.original_status_date; v_period := u.rolled_from_period_id;
  v_cut := app.closed_cutoff(u.project_id);
  if v_approve and v_cut is not null and v_date <= v_cut then     -- verified after the period closed → next period
    v_orig := coalesce(v_orig, v_date); v_period := coalesce(v_period, app.closed_period_for(u.project_id, v_date)); v_date := v_cut + 1;
  end if;
  update public.task_progress set status = v_status, verified_by = auth.uid(), verified_at = now(),
    status_date = v_date, original_status_date = v_orig, rolled_from_period_id = v_period,
    verified_pct = case when v_approve then round(v_pct, 2) end,
    verified_qty = case when v_approve then v_qty end, verified_steps = case when v_approve then v_steps end,
    verified_actual_start = case when v_approve then coalesce((p ->> 'actual_start')::date, u.actual_start) end,
    verified_actual_finish = case when v_approve then coalesce((p ->> 'actual_finish')::date, u.actual_finish,
                                                              case when v_pct >= 100 then v_date end) end,
    verified_remaining_days = case when v_approve then coalesce((p ->> 'remaining_days')::numeric, u.remaining_days) end,
    verify_comment = nullif(p ->> 'comment', '')
  where id = u.id;
  if v_approve and v_steps is not null then
    update public.task_steps s set verified_pct = least(100, greatest(0, y.done_pct))
      from jsonb_to_recordset(v_steps) as y(step_id uuid, done_pct numeric) where s.id = y.step_id and s.task_id = t.id;
  end if;
  perform app.refresh_task_progress(t.id);
  perform app.notify_user(u.reported_by, u.project_id, 'Task progress ' || v_status, coalesce(p ->> 'comment', t.name), 'task_progress', u.id);
  return jsonb_build_object('ok', true, 'id', u.id, 'status', v_status, 'verified_pct', case when v_approve then round(v_pct, 2) end,
                            'status_date', v_date);
end $$;
revoke execute on function app.verify_task_progress_one(jsonb) from public;

create or replace function public.verify_task_progress(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); it jsonb; v_out jsonb := '[]'::jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  if p ? 'items' then
    for it in select y from jsonb_array_elements(p -> 'items') y loop
      v_out := v_out || app.verify_task_progress_one(it);
    end loop;
    return app.op_done(p, 'verify_task_progress', jsonb_build_object('ok', true, 'items', v_out));
  end if;
  return app.op_done(p, 'verify_task_progress', app.verify_task_progress_one(p));
end $$;

-- -----------------------------------------------------------------------------
-- RPC: baselines
-- -----------------------------------------------------------------------------

create or replace function public.set_baseline(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  sc public.schedules; cfg public.project_settings; v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_no int; v_src text; v_num int; v_cost text := coalesce(p ->> 'cost_source', 'value');
  v_unm text := coalesce(p ->> 'unmapped_value', 'msp_cost'); v_n int; v_nofile int; v_tot record; v_budget numeric; v_alloc numeric;
begin
  if v_seen is not null then return v_seen; end if;
  select * into sc from public.schedules where id = (p ->> 'schedule_id')::uuid;
  if not found then raise exception 'Schedule not found'; end if;
  perform app.require_member(sc.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  cfg := app.evm_cfg(sc.project_id);
  if v_cost not in ('value','msp_baseline_cost','budget_lines','value_less_margin') then raise exception 'Unknown cost source %', v_cost; end if;
  if v_unm not in ('msp_cost','zero') then raise exception 'Unknown unmapped value rule %', v_unm; end if;
  if exists (select 1 from public.schedule_baselines where schedule_id = sc.id and status = 'proposed') then
    raise exception 'A proposed baseline is still waiting for approval';
  end if;
  if exists (select 1 from public.schedule_baselines where schedule_id = sc.id and status in ('approved','superseded'))
     and coalesce(trim(p ->> 'reason'), '') = '' then
    raise exception 'A re-baseline needs a reason (e.g. approved change order or recovery programme)';
  end if;
  v_num := coalesce((p ->> 'msp_baseline_number')::int, 0);
  v_src := coalesce(p ->> 'source', case when exists (select 1 from public.schedule_tasks where schedule_id = sc.id
                                        and deleted_at is null and msp_baseline_start is not null) then 'msp_baseline' else 'current_plan' end);
  if v_src not in ('msp_baseline','current_plan') then raise exception 'Unknown baseline source %', v_src; end if;
  select coalesce(max(baseline_no), 0) + 1 into v_no from public.schedule_baselines where schedule_id = sc.id;

  insert into public.schedule_baselines (id, project_id, schedule_id, baseline_no, name, source, msp_baseline_number,
    from_version_id, effective_from, reason, cost_source, unmapped_value)
  values (v_id, sc.project_id, sc.id, v_no, coalesce(nullif(p ->> 'name', ''), case when v_no = 1 then 'Contract baseline' else 'Re-baseline ' || v_no end),
    v_src, case when v_src = 'msp_baseline' then v_num end, sc.current_version_id,
    coalesce((p ->> 'effective_from')::date, sc.status_date, sc.planned_start, app.eat_date(now())), nullif(p ->> 'reason', ''), v_cost, v_unm);

  -- dates per leaf task (file baseline n, else current plan)
  insert into public.schedule_baseline_tasks (baseline_id, task_id, project_id, bl_start, bl_finish, bl_duration_days, accrual, is_point)
  select v_id, t.id, t.project_id, x.bs, greatest(x.bf, x.bs), coalesce(x.bd, t.duration_days, 0),
         case when t.is_milestone then 'end' else t.cost_accrual end, t.is_milestone or coalesce(x.bd, t.duration_days, 0) = 0
  from public.schedule_tasks t
  cross join lateral (
    select coalesce(case when v_src = 'msp_baseline' then left(b ->> 'start', 10)::date end, t.planned_start) as bs,
           coalesce(case when v_src = 'msp_baseline' then left(b ->> 'finish', 10)::date end, t.planned_finish) as bf,
           case when v_src = 'msp_baseline' and b is not null then (b ->> 'duration_days')::numeric end as bd,
           b is not null as from_file
    from (select (select y from jsonb_array_elements(t.msp_baselines) y where coalesce((y ->> 'number')::int, 0) = v_num
                  and y ->> 'start' is not null limit 1) as b) z) x
  where t.schedule_id = sc.id and t.deleted_at is null and not t.is_summary and t.source_state = 'active'
    and x.bs is not null and x.bf is not null;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'No dated tasks to baseline'; end if;
  select count(*) into v_nofile from public.schedule_baseline_tasks bt join public.schedule_tasks t on t.id = bt.task_id
    where bt.baseline_id = v_id and v_src = 'msp_baseline'
      and not exists (select 1 from jsonb_array_elements(t.msp_baselines) y where coalesce((y ->> 'number')::int, 0) = v_num and y ->> 'start' is not null);

  -- BAC: value = Σ link qty × BoQ rate (unmapped tasks: MSP cost or 0); cost per cost_source
  insert into public.schedule_baseline_task_costs (baseline_id, task_id, project_id, bac_value, bac_cost)
  select v_id, bt.task_id, bt.project_id, v.bv, 0
  from public.schedule_baseline_tasks bt
  left join public.schedule_task_costs k on k.task_id = bt.task_id
  cross join lateral (
    select coalesce(nullif((select round(sum(l.qty_share * r.rate), 2) from public.task_boq_links l
                            join public.boq_rates r on r.boq_item_id = l.boq_item_id
                            where l.task_id = bt.task_id and l.deleted_at is null), 0),
                    case when v_unm = 'msp_cost' then coalesce(
                      (select (y ->> 'cost')::numeric from jsonb_array_elements(k.baselines) y where coalesce((y ->> 'number')::int, 0) = v_num limit 1),
                      k.msp_baseline_cost, k.msp_cost) end, 0) as bv) v
  where bt.baseline_id = v_id;

  if v_cost = 'value' then
    update public.schedule_baseline_task_costs set bac_cost = bac_value where baseline_id = v_id;
  elsif v_cost = 'value_less_margin' then
    update public.schedule_baseline_task_costs set bac_cost = round(bac_value * (1 - coalesce(cfg.evm_margin_pct, 0) / 100), 2) where baseline_id = v_id;
  elsif v_cost = 'msp_baseline_cost' then
    update public.schedule_baseline_task_costs c set bac_cost = coalesce(
      (select (y ->> 'cost')::numeric from public.schedule_task_costs k, jsonb_array_elements(k.baselines) y
        where k.task_id = c.task_id and coalesce((y ->> 'number')::int, 0) = v_num limit 1),
      (select coalesce(k.msp_baseline_cost, k.msp_cost) from public.schedule_task_costs k where k.task_id = c.task_id), 0)
    where c.baseline_id = v_id;
  else   -- budget_lines: BoQ-scoped lines pro rata by link qty; the rest spread by value
    update public.schedule_baseline_task_costs c set bac_cost = coalesce(a.amt, 0)
    from (select l.task_id, sum(b.amt * l.qty_share / nullif(tot.q, 0)) as amt
          from public.task_boq_links l
          join public.schedule_baseline_tasks bt on bt.task_id = l.task_id and bt.baseline_id = v_id
          join (select boq_item_id, sum(budget_amount) as amt from public.budget_lines
                where project_id = sc.project_id and deleted_at is null and boq_item_id is not null group by 1) b on b.boq_item_id = l.boq_item_id
          join (select l2.boq_item_id, sum(l2.qty_share) as q from public.task_boq_links l2
                join public.schedule_baseline_tasks bt2 on bt2.task_id = l2.task_id and bt2.baseline_id = v_id
                where l2.deleted_at is null group by 1) tot on tot.boq_item_id = l.boq_item_id
          where l.deleted_at is null group by l.task_id) a
    where c.baseline_id = v_id and c.task_id = a.task_id;
    select coalesce(sum(budget_amount), 0) into v_budget from public.budget_lines where project_id = sc.project_id and deleted_at is null;
    select coalesce(sum(bac_cost), 0) into v_alloc from public.schedule_baseline_task_costs where baseline_id = v_id;
    if v_budget > v_alloc then
      update public.schedule_baseline_task_costs c set bac_cost = round(c.bac_cost + (v_budget - v_alloc) *
        case when x.tv > 0 then c.bac_value / x.tv else 1.0 / x.n end, 2)
      from (select sum(bac_value) tv, count(*) n from public.schedule_baseline_task_costs where baseline_id = v_id) x
      where c.baseline_id = v_id;
    end if;
  end if;
  update public.schedule_baselines set task_count = v_n where id = v_id;
  select round(sum(bac_value), 2) bv, round(sum(bac_cost), 2) bc into v_tot from public.schedule_baseline_task_costs where baseline_id = v_id;
  perform app.notify_roles(sc.project_id, '{coordinator,manager}', 'Baseline to approve: ' || sc.name || ' #' || v_no,
    coalesce(nullif(p ->> 'reason', ''), 'New baseline'), 'schedule_baseline', v_id);
  return app.op_done(p, 'set_baseline', jsonb_build_object('ok', true, 'id', v_id, 'baseline_no', v_no, 'status', 'proposed',
    'tasks', v_n, 'without_file_baseline', v_nofile)
    || case when app.can_see_prices() then jsonb_build_object('bac_value', v_tot.bv, 'bac_cost', v_tot.bc,
         'contract_value', (select round(sum(b.quantity * r.rate), 2) from public.boq_items b join public.boq_rates r on r.boq_item_id = b.id
                            where b.project_id = sc.project_id and b.deleted_at is null),
         'budget_total', (select round(sum(budget_amount), 2) from public.budget_lines where project_id = sc.project_id and deleted_at is null))
       else '{}'::jsonb end);
end $$;

create or replace function public.approve_baseline(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  b public.schedule_baselines; v_approve boolean := coalesce((p ->> 'approve')::boolean, true);
begin
  if v_seen is not null then return v_seen; end if;
  select * into b from public.schedule_baselines where id = (p ->> 'baseline_id')::uuid for update;
  if not found then raise exception 'Baseline not found'; end if;
  perform app.require_member(b.project_id);
  perform app.require_role('coordinator','manager','admin');
  if b.status <> 'proposed' then raise exception 'Baseline is already %', b.status; end if;
  if b.proposed_by = auth.uid() and not app.has_role('admin') then
    raise exception 'You cannot approve a baseline you proposed';
  end if;
  if not v_approve then
    if coalesce(trim(p ->> 'comment'), '') = '' then raise exception 'A comment is required to reject a baseline'; end if;
    update public.schedule_baselines set status = 'rejected', approved_by = auth.uid(), approved_at = now(),
      decision_comment = p ->> 'comment' where id = b.id;
  else
    update public.schedule_baselines set status = 'superseded'
      where schedule_id = b.schedule_id and status = 'approved' and id <> b.id;
    update public.schedule_baselines set status = 'approved', approved_by = auth.uid(), approved_at = now(),
      decision_comment = nullif(p ->> 'comment', '') where id = b.id;
    update public.schedules set approved_baseline_id = b.id where id = b.schedule_id;
    update public.schedule_tasks t set baseline_start = bt.bl_start, baseline_finish = bt.bl_finish
      from public.schedule_baseline_tasks bt where bt.baseline_id = b.id and bt.task_id = t.id;
    update public.schedule_tasks t set baseline_start = null, baseline_finish = null
      where t.schedule_id = b.schedule_id and not t.is_summary
        and not exists (select 1 from public.schedule_baseline_tasks bt where bt.baseline_id = b.id and bt.task_id = t.id);
    perform app.rollup_summaries(b.schedule_id);
  end if;
  perform app.notify_user(b.proposed_by, b.project_id, 'Baseline ' || case when v_approve then 'approved' else 'rejected' end,
    coalesce(p ->> 'comment', b.name), 'schedule_baseline', b.id);
  return app.op_done(p, 'approve_baseline', jsonb_build_object('ok', true, 'id', b.id,
    'status', case when v_approve then 'approved' else 'rejected' end));
end $$;

-- -----------------------------------------------------------------------------
-- RPC: forecast
-- -----------------------------------------------------------------------------

create or replace function public.run_forecast(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  sc public.schedules; v_s date; v_res jsonb; v_ev numeric; es record;
begin
  if v_seen is not null then return v_seen; end if;
  select * into sc from public.schedules where id = (p ->> 'schedule_id')::uuid;
  if not found then raise exception 'Schedule not found'; end if;
  perform app.require_member(sc.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  v_s := coalesce((p ->> 'status_date')::date, app.eat_date(now()));
  if v_s > app.eat_date(now()) then raise exception 'Status date cannot be in the future'; end if;
  v_res := app.run_cpm(sc.id, v_s, true);
  select coalesce(sum(r.ev), 0) into v_ev from app.pvev_rows(sc.id, v_s) r;
  select * into es from app.earned_schedule(sc.id, v_s, v_ev);
  update public.schedules set es_finish = es.es_finish where id = sc.id;
  return app.op_done(p, 'run_forecast', v_res || jsonb_build_object('ok', true, 'status_date', v_s, 'es_finish', es.es_finish,
    'spi_t', es.spi_t, 'sv_t_days', es.sv_t_days));
end $$;

-- -----------------------------------------------------------------------------
-- RPC: periods (open → prepared → closed; reopen by a manager)
-- -----------------------------------------------------------------------------

create or replace function public.open_period(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  sc public.schedules; prev public.evm_periods; v_kind text := coalesce(p ->> 'kind', 'monthly');
  v_start date; v_sd date := (p ->> 'status_date')::date; v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid()); v_no int;
begin
  if v_seen is not null then return v_seen; end if;
  select * into sc from public.schedules where id = (p ->> 'schedule_id')::uuid;
  if not found then raise exception 'Schedule not found'; end if;
  perform app.require_member(sc.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if v_kind not in ('weekly','monthly') then raise exception 'Period kind must be weekly or monthly'; end if;
  if v_sd is null then raise exception 'Status (cut-off) date is required'; end if;
  if exists (select 1 from public.evm_periods where schedule_id = sc.id and kind = v_kind and status <> 'closed') then
    raise exception 'Close the current % period before opening the next one', v_kind;
  end if;
  select * into prev from public.evm_periods where schedule_id = sc.id and kind = v_kind order by period_no desc limit 1;
  if found then
    v_start := coalesce((p ->> 'period_start')::date, prev.status_date + 1);
    if v_start <> prev.status_date + 1 then
      raise exception 'Periods must be contiguous: the next % period starts on %', v_kind, prev.status_date + 1;
    end if;
    v_no := coalesce((p ->> 'period_no')::int, prev.period_no + 1);
  else
    v_start := coalesce((p ->> 'period_start')::date, sc.planned_start, v_sd);
    v_no := coalesce((p ->> 'period_no')::int, 1);
  end if;
  if v_sd < v_start then raise exception 'Cut-off date % is before the period start %', v_sd, v_start; end if;
  insert into public.evm_periods (id, project_id, schedule_id, period_no, kind, period_start, status_date, baseline_id)
  values (v_id, sc.project_id, sc.id, v_no, v_kind, v_start, v_sd, sc.approved_baseline_id);
  return app.op_done(p, 'open_period', jsonb_build_object('ok', true, 'id', v_id, 'period_no', v_no, 'period_start', v_start,
                                                         'status_date', v_sd));
end $$;

-- Threshold checks at a status date (no money in the result).
create or replace function app.period_checks(p_period uuid, p_carry uuid[] default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ep public.evm_periods; pj record; v_block jsonb := '[]'::jsonb; v_breach jsonb := '[]'::jsonb; v_warn jsonb := '[]'::jsonb;
  v_pending int; v_tcpi numeric;
begin
  select * into ep from public.evm_periods where id = p_period;
  select count(*) into v_pending from public.task_progress tp join public.schedule_tasks t on t.id = tp.task_id
    where t.schedule_id = ep.schedule_id and tp.status = 'reported' and tp.status_date <= ep.status_date
      and not (tp.id = any (coalesce(p_carry, '{}')));
  if v_pending > 0 then
    v_block := v_block || jsonb_build_object('issue', 'unverified_progress', 'count', v_pending,
      'message', v_pending || ' progress report(s) dated on or before the cut-off still need verification');
  end if;
  if ep.baseline_id is null and not exists (select 1 from public.schedules where id = ep.schedule_id and approved_baseline_id is not null) then
    v_block := v_block || jsonb_build_object('issue', 'no_baseline', 'message', 'No approved baseline');
  end if;
  select * into pj from app.evm_project_raw(ep.schedule_id, ep.status_date);
  if pj.spi_status in ('critical','warning') then
    v_breach := v_breach || jsonb_build_object('indicator', 'spi', 'value', pj.spi, 'band', pj.spi_status);
  end if;
  if pj.cpi_status in ('critical','warning') then
    v_breach := v_breach || jsonb_build_object('indicator', 'cpi', 'value', pj.cpi, 'band', pj.cpi_status);
  end if;
  if pj.spi_t_status in ('critical','warning') then
    v_breach := v_breach || jsonb_build_object('indicator', 'spi_t', 'value', pj.spi_t, 'band', pj.spi_t_status);
  end if;
  if pj.tcpi_status = 'warning' then
    v_breach := v_breach || jsonb_build_object('indicator', 'tcpi', 'value', pj.tcpi, 'band', 'warning');
  end if;
  if pj.cpi_status = 'info' or pj.spi_status = 'info' then
    v_warn := v_warn || to_jsonb('An index above 1.15 — check for front-loaded progress claims or missing actual cost'::text);
  end if;
  if not exists (select 1 from public.cost_entries ce where ce.project_id = ep.project_id
                 and ce.entry_date between ep.period_start and ep.status_date) then
    v_warn := v_warn || to_jsonb('No labour / equipment / subcontract cost entries in this period'::text);
  end if;
  return jsonb_build_object('blocking', v_block, 'breaches', v_breach, 'warnings', v_warn,
    'pct_planned', pj.pct_planned, 'pct_earned', pj.pct_earned, 'spi', pj.spi, 'cpi', pj.cpi, 'spi_t', pj.spi_t,
    'sv_t_days', pj.sv_t_days, 'es_finish', pj.es_finish, 'fc_finish', pj.fc_finish);
end $$;
revoke execute on function app.period_checks(uuid, uuid[]) from public;

create or replace function public.prepare_period_close(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  ep public.evm_periods; v_chk jsonb; v_carry uuid[];
begin
  if v_seen is not null then return v_seen; end if;
  select * into ep from public.evm_periods where id = (p ->> 'period_id')::uuid for update;
  if not found then raise exception 'Period not found'; end if;
  perform app.require_member(ep.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if ep.status = 'closed' then raise exception 'Period is already closed'; end if;
  v_carry := array(select (jsonb_array_elements_text(coalesce(p -> 'carry_ids', '[]'::jsonb)))::uuid);
  perform app.run_cpm(ep.schedule_id, ep.status_date, true);
  v_chk := app.period_checks(ep.id, v_carry) || jsonb_build_object('carry_ids', to_jsonb(v_carry));
  update public.evm_periods set status = 'prepared', prepared_by = auth.uid(), prepared_at = now(), prepared_summary = v_chk,
    baseline_id = coalesce(baseline_id, (select approved_baseline_id from public.schedules where id = ep.schedule_id))
  where id = ep.id;
  perform app.notify_roles(ep.project_id, '{coordinator,manager}', 'Progress period ready to close',
    ep.kind || ' period ' || ep.period_no || ' (cut-off ' || to_char(ep.status_date, 'DD Mon YYYY') || ')', 'evm_period', ep.id);
  return app.op_done(p, 'prepare_period_close', jsonb_build_object('ok', true, 'id', ep.id, 'status', 'prepared') || v_chk);
end $$;

create or replace function public.close_period(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  ep public.evm_periods; sc public.schedules; v_chk jsonb; br jsonb; v_missing text; v_carry uuid[]; pj record; v_rows int;
  v_prev uuid;
begin
  if v_seen is not null then return v_seen; end if;
  select * into ep from public.evm_periods where id = (p ->> 'period_id')::uuid for update;
  if not found then raise exception 'Period not found'; end if;
  perform app.require_member(ep.project_id);
  perform app.require_role('coordinator','manager','admin');
  if ep.status <> 'prepared' then raise exception 'Prepare the period close first (status: %)', ep.status; end if;
  select * into sc from public.schedules where id = ep.schedule_id;
  v_carry := array(select (jsonb_array_elements_text(coalesce(ep.prepared_summary -> 'carry_ids', '[]'::jsonb)))::uuid);
  perform app.run_cpm(ep.schedule_id, ep.status_date, true);
  v_chk := app.period_checks(ep.id, v_carry);
  if jsonb_array_length(v_chk -> 'blocking') > 0 then
    raise exception 'Cannot close: %', (v_chk -> 'blocking' -> 0 ->> 'message');
  end if;
  for br in select y from jsonb_array_elements(v_chk -> 'breaches') y where y ->> 'band' = 'critical' loop
    if not exists (select 1 from public.evm_variance_notes n where n.period_id = ep.id and n.task_id is null
                   and n.indicator = br ->> 'indicator') then
      v_missing := coalesce(v_missing || ', ', '') || upper(br ->> 'indicator') || ' ' || (br ->> 'value');
    end if;
  end loop;
  if v_missing is not null then raise exception 'Variance explanation needed before closing: %', v_missing; end if;

  -- immutable snapshots
  insert into public.evm_task_status (period_id, project_id, task_id, level, pct_planned, pct_earned, spi,
    forecast_start, forecast_finish, total_float_days, is_critical, actual_start, actual_finish)
  select ep.id, ep.project_id, r.task_id, 'task', r.pct_planned, r.pct_earned, r.spi, t.forecast_start, t.forecast_finish,
         t.total_float_days, t.is_critical, t.actual_start, t.actual_finish
  from app.evm_task_raw(ep.schedule_id, ep.status_date) r join public.schedule_tasks t on t.id = r.task_id where not t.is_summary;
  insert into public.evm_task_status (period_id, project_id, task_id, level, pct_planned, pct_earned, spi,
    forecast_start, forecast_finish, total_float_days, is_critical, actual_start, actual_finish)
  select ep.id, ep.project_id, w.task_id, 'wbs', w.pct_planned, w.pct_earned, w.spi, t.forecast_start, t.forecast_finish,
         t.total_float_days, t.is_critical, t.actual_start, t.actual_finish
  from app.evm_wbs_raw(ep.schedule_id, ep.status_date) w join public.schedule_tasks t on t.id = w.task_id;
  select * into pj from app.evm_project_raw(ep.schedule_id, ep.status_date);
  insert into public.evm_task_status (period_id, project_id, task_id, level, pct_planned, pct_earned, spi, spi_t, sv_t_days,
    forecast_finish)
  values (ep.id, ep.project_id, null, 'project', pj.pct_planned, pj.pct_earned, pj.spi, pj.spi_t, pj.sv_t_days, sc.fc_finish);

  insert into public.evm_snapshots (period_id, project_id, task_id, level, bac, pv, ev, ac, bac_value, pv_value, ev_value,
    sv, cv, spi, cpi, eac, etc, vac, tcpi)
  select ep.id, ep.project_id, r.task_id, 'task', r.bac, r.pv, r.ev, r.ac, r.bac_value, r.pv_value, r.ev_value,
         r.sv, r.cv, r.spi, r.cpi, r.eac, r.etc, r.vac, r.tcpi
  from app.evm_task_raw(ep.schedule_id, ep.status_date) r join public.schedule_tasks t on t.id = r.task_id where not t.is_summary;
  insert into public.evm_snapshots (period_id, project_id, task_id, level, bac, pv, ev, ac, bac_value, pv_value, ev_value,
    sv, cv, spi, cpi, eac, etc, vac, tcpi)
  select ep.id, ep.project_id, w.task_id, 'wbs', w.bac, w.pv, w.ev, w.ac, w.bac_value, w.pv_value, w.ev_value,
         w.sv, w.cv, w.spi, w.cpi, w.eac, w.etc, w.vac, w.tcpi
  from app.evm_wbs_raw(ep.schedule_id, ep.status_date) w;
  insert into public.evm_snapshots (period_id, project_id, task_id, level, bac, pv, ev, ac, bac_value, pv_value, ev_value,
    sv, cv, spi, cpi, eac, etc, vac, tcpi, ac_unallocated, es_days, spi_t)
  values (ep.id, ep.project_id, null, 'project', pj.bac, pj.pv, pj.ev, pj.ac, pj.bac_value, pj.pv_value, pj.ev_value,
          pj.sv, pj.cv, pj.spi, pj.cpi, pj.eac, pj.etc, pj.vac, pj.tcpi, pj.ac_unallocated, pj.es_days, pj.spi_t);

  select id into v_prev from public.evm_periods where schedule_id = ep.schedule_id and kind = ep.kind and status = 'closed'
    and period_no < ep.period_no order by period_no desc limit 1;
  insert into public.period_boq_progress (period_id, boq_item_id, project_id, qty_contract, qty_to_date, qty_previous, qty_this_period)
  select ep.id, b.boq_item_id, ep.project_id, b.qty_contract, b.qty_to_date, coalesce(pb.qty_to_date, 0),
         b.qty_to_date - coalesce(pb.qty_to_date, 0)
  from app.boq_progress_raw(ep.schedule_id, ep.status_date) b
  left join public.period_boq_progress pb on pb.period_id = v_prev and pb.boq_item_id = b.boq_item_id;
  get diagnostics v_rows = row_count;

  update public.evm_periods set status = 'closed', closed_by = auth.uid(), closed_at = now(), close_comment = nullif(p ->> 'comment', ''),
    prepared_summary = v_chk || jsonb_build_object('carry_ids', to_jsonb(v_carry)),
    baseline_id = coalesce(baseline_id, sc.approved_baseline_id)
  where id = ep.id;
  if pj.spi_status = 'critical' then
    perform app.raise_alert(ep.project_id, 'evm_spi', 'critical', 'evm_period', ep.id, 'spi:' || ep.id,
      'Schedule performance ' || pj.spi || ' at cut-off ' || to_char(ep.status_date, 'DD Mon'),
      jsonb_build_object('summary', 'Work done is behind plan (SPI ' || pj.spi || ')'));
  end if;
  if pj.cpi_status = 'critical' then
    perform app.raise_alert(ep.project_id, 'evm_cpi', 'critical', 'evm_period', ep.id, 'cpi:' || ep.id,
      'Cost performance ' || pj.cpi || ' at cut-off ' || to_char(ep.status_date, 'DD Mon'),
      jsonb_build_object('summary', 'Work is costing more than budgeted (CPI ' || pj.cpi || ')'));
  end if;
  perform app.notify_roles(ep.project_id, '{coordinator,manager,office_engineer}', 'Progress period closed',
    ep.kind || ' period ' || ep.period_no || ': planned ' || coalesce(pj.pct_planned::text, '–') || '%, earned '
    || coalesce(pj.pct_earned::text, '–') || '%', 'evm_period', ep.id);
  return app.op_done(p, 'close_period', jsonb_build_object('ok', true, 'id', ep.id, 'status', 'closed', 'boq_items', v_rows,
    'pct_planned', pj.pct_planned, 'pct_earned', pj.pct_earned, 'spi', pj.spi, 'spi_t', pj.spi_t));
end $$;

create or replace function public.reopen_period(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); ep public.evm_periods;
begin
  if v_seen is not null then return v_seen; end if;
  select * into ep from public.evm_periods where id = (p ->> 'period_id')::uuid for update;
  if not found then raise exception 'Period not found'; end if;
  perform app.require_member(ep.project_id);
  perform app.require_role('manager','admin');
  if ep.status <> 'closed' then raise exception 'Only a closed period can be reopened'; end if;
  if coalesce(trim(p ->> 'reason'), '') = '' then raise exception 'A reason is required to reopen a period'; end if;
  if exists (select 1 from public.evm_periods where schedule_id = ep.schedule_id and status = 'closed' and status_date > ep.status_date) then
    raise exception 'Only the latest closed period can be reopened';
  end if;
  -- keep an audited copy of the snapshot before it is removed
  insert into public.audit_log (user_id, device_id, project_id, table_name, record_id, action, old_data, new_data)
  values (auth.uid(), app.device_id(), ep.project_id, 'evm_periods', ep.id::text, 'reopen',
    jsonb_build_object('period', to_jsonb(ep),
      'evm_task_status', (select jsonb_agg(to_jsonb(x)) from public.evm_task_status x where x.period_id = ep.id),
      'evm_snapshots', (select jsonb_agg(to_jsonb(x)) from public.evm_snapshots x where x.period_id = ep.id),
      'period_boq_progress', (select jsonb_agg(to_jsonb(x)) from public.period_boq_progress x where x.period_id = ep.id)),
    jsonb_build_object('reason', p ->> 'reason'));
  update public.evm_periods set status = 'open', reopened_reason = p ->> 'reason', reopen_count = reopen_count + 1,
    closed_by = null, closed_at = null where id = ep.id;
  delete from public.evm_task_status where period_id = ep.id;
  delete from public.evm_snapshots where period_id = ep.id;
  delete from public.period_boq_progress where period_id = ep.id;
  perform app.notify_roles(ep.project_id, '{coordinator,manager,office_engineer}', 'Progress period reopened',
    ep.kind || ' period ' || ep.period_no || ': ' || (p ->> 'reason'), 'evm_period', ep.id, true);
  return app.op_done(p, 'reopen_period', jsonb_build_object('ok', true, 'id', ep.id, 'status', 'open'));
end $$;

create or replace function public.save_variance_note(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); ep public.evm_periods; v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
begin
  if v_seen is not null then return v_seen; end if;
  select * into ep from public.evm_periods where id = (p ->> 'period_id')::uuid;
  if not found then raise exception 'Period not found'; end if;
  perform app.require_member(ep.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if coalesce(trim(p ->> 'cause'), '') = '' then raise exception 'Describe the cause of the variance'; end if;
  insert into public.evm_variance_notes (id, project_id, period_id, task_id, indicator, cause, impact, corrective_action, owner_id, due_date)
  values (v_id, ep.project_id, ep.id, (p ->> 'task_id')::uuid, lower(coalesce(p ->> 'indicator', 'other')), p ->> 'cause',
          p ->> 'impact', p ->> 'corrective_action', (p ->> 'owner_id')::uuid, (p ->> 'due_date')::date)
  on conflict (id) do update set cause = excluded.cause, impact = excluded.impact, corrective_action = excluded.corrective_action,
    owner_id = excluded.owner_id, due_date = excluded.due_date, indicator = excluded.indicator;
  return app.op_done(p, 'save_variance_note', jsonb_build_object('ok', true, 'id', v_id));
end $$;

-- -----------------------------------------------------------------------------
-- RPC: actual cost
-- -----------------------------------------------------------------------------

create or replace function public.record_actual_cost(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_project uuid := (p ->> 'project_id')::uuid; v_id uuid := (p ->> 'id')::uuid;
  v_date date := coalesce((p ->> 'entry_date')::date, app.eat_date(now())); v_orig date; v_period uuid; v_cut date;
  v_amount numeric := (p ->> 'amount')::numeric;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_prices();
  perform app.require_role_txt('coordinator','manager','procurement','admin','office_engineer');
  if v_id is null or coalesce(p ->> 'number', '') = '' then raise exception 'Cost entry id and number are required'; end if;
  if coalesce(p ->> 'category', '') not in ('labour','equipment','subcontract','material_direct','overhead','other') then
    raise exception 'Unknown cost category %', p ->> 'category';
  end if;
  if coalesce(trim(p ->> 'description'), '') = '' then raise exception 'Describe the cost'; end if;
  if v_amount is null and (p ->> 'qty') is not null and (p ->> 'rate') is not null then
    v_amount := round((p ->> 'qty')::numeric * (p ->> 'rate')::numeric, 2);
  end if;
  if v_amount is null then raise exception 'Amount (or quantity × rate) is required'; end if;
  if v_date > app.eat_date(now()) then raise exception 'Costs are recorded on the date the work was done (not in the future)'; end if;
  if (p ->> 'task_id') is not null and not exists (select 1 from public.schedule_tasks where id = (p ->> 'task_id')::uuid and project_id = v_project) then
    raise exception 'Task not found in this project';
  end if;
  v_cut := app.closed_cutoff(v_project);
  if v_cut is not null and v_date <= v_cut then
    v_orig := v_date; v_period := app.closed_period_for(v_project, v_date); v_date := v_cut + 1;
  end if;
  insert into public.cost_entries (id, project_id, number, entry_date, original_entry_date, relates_to_period_id, category, task_id,
    boq_item_id, element_id, description, supplier_id, subcontractor, qty, uom, rate, amount, source, source_ref, is_estimate)
  values (v_id, v_project, p ->> 'number', v_date, v_orig, coalesce((p ->> 'relates_to_period_id')::uuid, v_period), p ->> 'category',
    (p ->> 'task_id')::uuid, (p ->> 'boq_item_id')::uuid, (p ->> 'element_id')::uuid, p ->> 'description', (p ->> 'supplier_id')::uuid,
    nullif(p ->> 'subcontractor', ''), (p ->> 'qty')::numeric, nullif(p ->> 'uom', ''), (p ->> 'rate')::numeric, v_amount,
    coalesce(p ->> 'source', 'manual'), nullif(p ->> 'source_ref', ''), coalesce((p ->> 'is_estimate')::boolean, false));
  return app.op_done(p, 'record_actual_cost', jsonb_build_object('ok', true, 'id', v_id, 'entry_date', v_date,
    'rolled_to_next_period', v_orig is not null));
end $$;

create or replace function public.reverse_cost_entry(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); o public.cost_entries; v_cut date; v_date date;
begin
  if v_seen is not null then return v_seen; end if;
  select * into o from public.cost_entries where id = (p ->> 'reversal_of')::uuid;
  if not found then raise exception 'Cost entry not found'; end if;
  perform app.require_member(o.project_id);
  perform app.require_prices();
  perform app.require_role_txt('coordinator','manager','procurement','admin','office_engineer');
  if o.reversal_of is not null then raise exception 'A reversal cannot be reversed'; end if;
  if exists (select 1 from public.cost_entries where reversal_of = o.id) then raise exception 'Cost entry % is already reversed', o.number; end if;
  if coalesce(trim(p ->> 'reason'), '') = '' then raise exception 'A reason is required to reverse a cost'; end if;
  v_cut := app.closed_cutoff(o.project_id);
  v_date := greatest(o.entry_date, coalesce(v_cut + 1, o.entry_date));
  insert into public.cost_entries (id, project_id, number, entry_date, original_entry_date, relates_to_period_id, category, task_id,
    boq_item_id, element_id, description, supplier_id, subcontractor, qty, uom, rate, amount, source, source_ref, is_estimate, reversal_of)
  values ((p ->> 'id')::uuid, o.project_id, p ->> 'number', v_date, case when v_date <> o.entry_date then o.entry_date end,
    o.relates_to_period_id, o.category, o.task_id, o.boq_item_id, o.element_id, 'Reversal of ' || o.number || ': ' || (p ->> 'reason'),
    o.supplier_id, o.subcontractor, -o.qty, o.uom, o.rate, -o.amount, o.source, o.source_ref, o.is_estimate, o.id);
  return app.op_done(p, 'reverse_cost_entry', jsonb_build_object('ok', true, 'id', (p ->> 'id')::uuid, 'entry_date', v_date));
end $$;

create or replace function public.record_resource_usage(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_project uuid := (p ->> 'project_id')::uuid;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  if coalesce(p ->> 'kind', '') not in ('labour','equipment','subcontract') then raise exception 'Kind must be labour, equipment or subcontract'; end if;
  if coalesce((p ->> 'qty')::numeric, 0) <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if coalesce(p ->> 'uom', '') = '' then raise exception 'Unit (e.g. man-hours) is required'; end if;
  insert into public.resource_usage (id, project_id, usage_date, kind, task_id, trade_id, equipment, subcontractor, boq_item_id,
    qty, uom, diary_id, remarks)
  values ((p ->> 'id')::uuid, v_project, coalesce((p ->> 'usage_date')::date, app.eat_date(now())), p ->> 'kind',
    (p ->> 'task_id')::uuid, (p ->> 'trade_id')::uuid, nullif(p ->> 'equipment', ''), nullif(p ->> 'subcontractor', ''),
    (p ->> 'boq_item_id')::uuid, (p ->> 'qty')::numeric, p ->> 'uom', (p ->> 'diary_id')::uuid, nullif(p ->> 'remarks', ''));
  return app.op_done(p, 'record_resource_usage', jsonb_build_object('ok', true, 'id', (p ->> 'id')::uuid));
end $$;

create or replace function public.save_cost_rate(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_project uuid := (p ->> 'project_id')::uuid;
begin
  if v_seen is not null then return v_seen; end if;
  if v_project is not null then perform app.require_member(v_project); end if;
  perform app.require_prices();
  perform app.require_role_txt('coordinator','manager','procurement','admin');
  insert into public.cost_rates (id, project_id, kind, trade_id, equipment, subcontractor, boq_item_id, uom, rate, valid_from)
  values ((p ->> 'id')::uuid, v_project, p ->> 'kind', (p ->> 'trade_id')::uuid, nullif(p ->> 'equipment', ''),
    nullif(p ->> 'subcontractor', ''), (p ->> 'boq_item_id')::uuid, p ->> 'uom', (p ->> 'rate')::numeric,
    coalesce((p ->> 'valid_from')::date, app.eat_date(now())))
  on conflict (id) do update set rate = excluded.rate, valid_from = excluded.valid_from, uom = excluded.uom;
  return app.op_done(p, 'save_cost_rate', jsonb_build_object('ok', true, 'id', (p ->> 'id')::uuid));
end $$;

-- Estimated cost entries from resource usage × rates (flagged is_estimate; superseded by real entries).
create or replace function public.estimate_costs_from_usage(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_project uuid := (p ->> 'project_id')::uuid; v_code text; v_n int := 0; u record; v_rate numeric;
  v_cut date;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_prices();
  perform app.require_role_txt('coordinator','manager','procurement','admin');
  select code into v_code from public.projects where id = v_project;
  v_cut := app.closed_cutoff(v_project);
  for u in select * from public.resource_usage ru where ru.project_id = v_project
           and ru.usage_date between coalesce((p ->> 'from')::date, '-infinity'::date) and coalesce((p ->> 'to')::date, 'infinity'::date)
           and ru.usage_date > coalesce(v_cut, '-infinity'::date)
           and not exists (select 1 from public.cost_entries ce where ce.source_ref = 'usage:' || ru.id) loop
    select r.rate into v_rate from public.cost_rates r
      where (r.project_id = v_project or r.project_id is null) and r.kind = u.kind and lower(r.uom) = lower(u.uom)
        and r.valid_from <= u.usage_date
        and (r.trade_id is null or r.trade_id = u.trade_id) and (r.equipment is null or lower(r.equipment) = lower(coalesce(u.equipment, '')))
        and (r.subcontractor is null or lower(r.subcontractor) = lower(coalesce(u.subcontractor, '')))
        and (r.boq_item_id is null or r.boq_item_id = u.boq_item_id)
      order by (r.project_id is not null) desc, (r.trade_id is not null or r.equipment is not null or r.subcontractor is not null or r.boq_item_id is not null) desc,
               r.valid_from desc limit 1;
    continue when v_rate is null;
    insert into public.cost_entries (id, project_id, number, entry_date, category, task_id, boq_item_id, description, subcontractor,
      qty, uom, rate, amount, source, source_ref, is_estimate)
    values (gen_random_uuid(), v_project, v_code || '-CE-EST-' || replace(u.id::text, '-', ''), u.usage_date, u.kind, u.task_id,
      u.boq_item_id, 'Estimate from ' || u.kind || ' usage', u.subcontractor, u.qty, u.uom, v_rate, round(u.qty * v_rate, 2),
      'diary_estimate', 'usage:' || u.id, true);
    v_n := v_n + 1;
  end loop;
  return app.op_done(p, 'estimate_costs_from_usage', jsonb_build_object('ok', true, 'created', v_n));
end $$;

-- S-curve data for any grain incl. daily (price roles).
create or replace function public.get_evm_timeseries(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sc public.schedules; v jsonb;
begin
  select * into sc from public.schedules where id = (p ->> 'schedule_id')::uuid;
  if not found then raise exception 'Schedule not found'; end if;
  perform app.require_member(sc.project_id);
  perform app.require_prices();
  select coalesce(jsonb_agg(to_jsonb(x) order by x.period_end), '[]'::jsonb) into v
    from app.evm_timeseries_raw(sc.id, coalesce(p ->> 'grain', 'week'), (p ->> 'status_date')::date) x;
  return v;
end $$;

-- Checked wrappers used by the views (raw functions are not executable by clients).
create or replace function app.evm_task_v(p_schedule uuid, p_s date)
returns table (task_id uuid, msp_uid int, wbs text, name text, outline_level int, parent_id uuid, ev_method text,
               status_date date, bac numeric, pv numeric, ev numeric, ac numeric, bac_value numeric, pv_value numeric,
               ev_value numeric, pct_planned numeric, pct_earned numeric, sv numeric, cv numeric, spi numeric, cpi numeric,
               eac numeric, etc numeric, vac numeric, tcpi numeric, eac_fallback boolean, spi_status text, cpi_status text)
language sql stable security definer set search_path = public as $$
  select * from app.evm_task_raw(p_schedule, p_s) where app.can_see_schedule_money(p_schedule)
$$;

create or replace function app.evm_wbs_v(p_schedule uuid, p_s date)
returns table (task_id uuid, msp_uid int, wbs text, name text, outline_level int, parent_id uuid, status_date date,
               bac numeric, pv numeric, ev numeric, ac numeric, bac_value numeric, pv_value numeric, ev_value numeric,
               pct_planned numeric, pct_earned numeric, sv numeric, cv numeric, spi numeric, cpi numeric, eac numeric,
               etc numeric, vac numeric, tcpi numeric, eac_fallback boolean, spi_status text, cpi_status text, leaf_tasks int)
language sql stable security definer set search_path = public as $$
  select * from app.evm_wbs_raw(p_schedule, p_s) where app.can_see_schedule_money(p_schedule)
$$;

create or replace function app.evm_project_v(p_schedule uuid, p_s date)
returns table (status_date date, bac numeric, pv numeric, ev numeric, ac numeric, ac_unallocated numeric,
               bac_value numeric, pv_value numeric, ev_value numeric, pct_planned numeric, pct_earned numeric,
               sv numeric, cv numeric, spi numeric, cpi numeric, eac numeric, etc numeric, vac numeric, tcpi numeric,
               tcpi_eac numeric, eac_fallback boolean, eac_method text, cost_basis text,
               es_days numeric, at_days int, pd_days int, spi_t numeric, sv_t_days numeric, ieac_t_days numeric,
               es_finish date, fc_finish date, baseline_start date, baseline_finish date,
               spi_status text, cpi_status text, spi_t_status text, tcpi_status text,
               baseline_id uuid, unbaselined_tasks int, ac_coverage_pct numeric)
language sql stable security definer set search_path = public as $$
  select * from app.evm_project_raw(p_schedule, p_s) where app.can_see_schedule_money(p_schedule)
$$;

create or replace function app.evm_timeseries_v(p_schedule uuid, p_grain text, p_s date default null)
returns table (grain text, period_end date, as_of date, is_actual boolean, pv numeric, ev numeric, ac numeric,
               pv_value numeric, ev_value numeric)
language sql stable security definer set search_path = public as $$
  select * from app.evm_timeseries_raw(p_schedule, p_grain, p_s) where app.can_see_schedule_money(p_schedule)
$$;

create or replace function app.material_alloc_v(p_project uuid)
returns table (project_id uuid, ledger_id uuid, txn_date date, element_id uuid, material_spec_id uuid,
               boq_item_id uuid, task_id uuid, share numeric, qty numeric, amount numeric)
language sql stable security definer set search_path = public as $$
  select * from app.material_alloc(p_project) where app.can_see_prices() and app.is_member(p_project)
$$;

create or replace function app.boq_progress_v(p_schedule uuid, p_s date)
returns table (boq_item_id uuid, qty_contract numeric, qty_mapped numeric, qty_to_date numeric)
language sql stable security definer set search_path = public as $$
  select * from app.boq_progress_raw(p_schedule, p_s) where exists (select 1 from public.schedules s where s.id = p_schedule and app.is_member(s.project_id))
$$;

-- -----------------------------------------------------------------------------
-- Views (security_invoker; money views are empty for roles that cannot see prices)
-- -----------------------------------------------------------------------------


create or replace view public.v_evm_task with (security_invoker = true) as
select s.project_id, s.id as schedule_id, m.*
from public.schedules s
cross join lateral app.evm_task_v(s.id, coalesce(s.status_date, app.eat_date(now()))) m
where app.can_see_schedule_money(s.id);

create or replace view public.v_evm_wbs with (security_invoker = true) as
select s.project_id, s.id as schedule_id, m.*
from public.schedules s
cross join lateral app.evm_wbs_v(s.id, coalesce(s.status_date, app.eat_date(now()))) m
where app.can_see_schedule_money(s.id);

create or replace view public.v_evm_project with (security_invoker = true) as
select s.project_id, s.id as schedule_id, s.name as schedule_name, m.*
from public.schedules s
cross join lateral app.evm_project_v(s.id, coalesce(s.status_date, app.eat_date(now()))) m
where app.can_see_schedule_money(s.id);

create or replace view public.v_evm_timeseries with (security_invoker = true) as
select s.project_id, s.id as schedule_id, m.*
from public.schedules s
cross join lateral (select 'week'::text as g union all select 'month') g
cross join lateral app.evm_timeseries_v(s.id, g.g, s.status_date) m
where app.can_see_schedule_money(s.id);

create or replace view public.v_ac_material_alloc with (security_invoker = true) as
select m.*, t.msp_uid, t.name as task_name, e.code as element_code, sp.label as spec_label
from public.projects pj
cross join lateral app.material_alloc_v(pj.id) m
left join public.schedule_tasks t on t.id = m.task_id
left join public.elements e on e.id = m.element_id
left join public.v_specs sp on sp.id = m.material_spec_id
where app.can_see_prices() and app.is_member(pj.id);

create or replace view public.v_progress_overview with (security_invoker = true) as
select s.project_id, s.id as schedule_id, m.*
from public.schedules s
cross join lateral app.progress_overview(s.id, s.status_date) m;

create or replace view public.v_boq_progress with (security_invoker = true) as
select s.project_id, s.id as schedule_id, b.item_no, b.description, b.unit, m.boq_item_id, m.qty_contract, m.qty_mapped,
       m.qty_to_date, round(100 * m.qty_to_date / nullif(m.qty_contract, 0), 2) as pct_of_contract,
       coalesce(s.status_date, app.eat_date(now())) as status_date
from public.schedules s
cross join lateral app.boq_progress_v(s.id, coalesce(s.status_date, app.eat_date(now()))) m
join public.boq_items b on b.id = m.boq_item_id
where app.is_member(s.project_id);

-- Mapping check (no money): BoQ quantity vs quantity mapped to tasks.
create or replace view public.v_boq_mapping_check with (security_invoker = true) as
select b.project_id, b.id as boq_item_id, b.item_no, b.description, b.unit, b.quantity,
       coalesce(x.mapped, 0) as mapped_qty, coalesce(x.tasks, 0) as tasks,
       case when coalesce(x.tasks, 0) = 0 then 'unmapped'
            when coalesce(x.mapped, 0) < b.quantity - 0.0005 then 'under_mapped'
            when coalesce(x.mapped, 0) > b.quantity + 0.0005 then 'over_mapped' else 'ok' end as mapping_status
from public.boq_items b
left join lateral (
  select sum(l.qty_share) as mapped, count(*)::int as tasks from public.task_boq_links l
  join public.schedule_tasks t on t.id = l.task_id and t.deleted_at is null
  where l.boq_item_id = b.id and l.deleted_at is null) x on true
where b.deleted_at is null;

grant select on public.v_evm_task, public.v_evm_wbs, public.v_evm_project, public.v_evm_timeseries, public.v_ac_material_alloc,
  public.v_progress_overview, public.v_boq_progress, public.v_boq_mapping_check to authenticated;

-- -----------------------------------------------------------------------------
-- Approval inbox: task progress to verify, baselines to approve, periods to close
-- (wraps the previous app.approvals_for, whatever migration defined it last)
-- -----------------------------------------------------------------------------

alter function app.approvals_for(uuid) rename to approvals_for_pre_schedule;

create or replace function app.approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_role text;
begin
  return query select * from app.approvals_for_pre_schedule(p_user);    -- also checks the caller may read p_user's inbox
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null then return; end if;
  return query
  with mem as (
    select pm.project_id as pid from public.project_members pm where pm.user_id = p_user
    union select pj.id from public.projects pj where v_role = 'admin')
  select x.kind, x.entity_type, x.entity_id, x.project_id, x.number, x.title, x.status, x.requested_by, x.requested_at,
         x.is_urgent, x.actions, round((extract(epoch from now() - coalesce(x.requested_at, now())) / 3600)::numeric, 1)
  from (
    select 'task_progress_verify'::text as kind, 'task_progress'::text as entity_type, tp.id as entity_id, tp.project_id,
           coalesce(t.wbs, t.msp_uid::text) as number,
           'Verify ' || t.name || ' (' || coalesce(round(tp.pct_complete, 1)::text, '?') || '%)' as title,
           tp.status, tp.reported_by as requested_by, tp.created_at as requested_at,
           (tp.original_status_date is not null) as is_urgent, array['approve','reject'] as actions
    from public.task_progress tp join public.schedule_tasks t on t.id = tp.task_id
    where tp.project_id in (select pid from mem) and tp.status = 'reported' and tp.reported_by <> p_user
      and v_role in ('office_engineer','coordinator','manager','admin')
    union all
    select 'baseline_approve', 'schedule_baseline', b.id, b.project_id, 'BL-' || b.baseline_no,
           'Approve baseline "' || b.name || '"' || coalesce(' — ' || b.reason, ''), b.status, b.proposed_by, b.proposed_at,
           b.baseline_no > 1, array['approve','reject']
    from public.schedule_baselines b
    where b.project_id in (select pid from mem) and b.status = 'proposed' and b.proposed_by is distinct from p_user
      and v_role in ('coordinator','manager','admin')
    union all
    select 'period_close', 'evm_period', ep.id, ep.project_id, upper(left(ep.kind, 1)) || '-' || ep.period_no,
           'Close ' || ep.kind || ' progress period ' || ep.period_no || ' (cut-off ' || to_char(ep.status_date, 'DD Mon YYYY') || ')',
           ep.status, ep.prepared_by, ep.prepared_at, false, array['approve']
    from public.evm_periods ep
    where ep.project_id in (select pid from mem) and ep.status = 'prepared' and v_role in ('coordinator','manager','admin')
  ) x;
end $$;

create or replace view public.v_my_approvals as
select * from app.approvals_for(auth.uid());
grant select on public.v_my_approvals to authenticated;

-- -----------------------------------------------------------------------------
-- Grants: RPCs are for signed-in users only
-- -----------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array['import_schedule','save_task_setup','auto_link_tasks','report_task_progress','verify_task_progress',
    'set_baseline','approve_baseline','run_forecast','open_period','prepare_period_close','close_period','reopen_period',
    'save_variance_note','record_actual_cost','reverse_cost_entry','record_resource_usage','save_cost_rate',
    'estimate_costs_from_usage','get_evm_timeseries'] loop
    execute format('revoke execute on function public.%I(jsonb) from public, anon', f);
    execute format('grant execute on function public.%I(jsonb) to authenticated', f);
  end loop;
end $$;
