-- =============================================================================
-- Site Materials Management & Progress Tracking — core schema
-- Every table carries updated_at so mobile clients can pull changes
-- incrementally. Transactional tables are written only through RPC functions
-- (see 20261029000003_functions.sql); RLS allows reads to project members.
-- =============================================================================

create schema if not exists app;

create type public.app_role as enum (
  'store_keeper', 'site_engineer', 'office_engineer',
  'coordinator', 'manager', 'procurement', 'admin'
);

create type public.mr_status as enum (
  'draft', 'submitted', 'reviewed', 'returned', 'approved',
  'sourced', 'ordered',                       -- reserved for Phase 2 procurement
  'partially_issued', 'issued', 'closed', 'rejected', 'cancelled'
);

create type public.mr_priority as enum ('normal', 'urgent', 'critical');

-- -----------------------------------------------------------------------------
-- Users, projects, devices
-- -----------------------------------------------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null default '',
  email       text,
  phone       text,
  role        public.app_role not null default 'site_engineer',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.app_settings (
  id           int primary key default 1 check (id = 1),
  company_name text not null default 'Company',
  price_roles  public.app_role[] not null default '{coordinator,manager,procurement,admin}',
  updated_at   timestamptz not null default now()
);
insert into public.app_settings (id) values (1);

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9-]{2,12}$'),
  name        text not null,
  location    text,
  client      text,
  start_date  date,
  end_date    date,
  currency    text not null default 'ETB',
  is_active   boolean not null default true,
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.project_settings (
  project_id                uuid primary key references public.projects (id) on delete cascade,
  require_review            boolean not null default true,   -- Office Engineer review step before approval
  enforce_hold_points       boolean not null default true,   -- FR-PG-05
  escalation_hours          int not null default 24,         -- FR-WF-04
  variance_thresholds       jsonb not null default '{"Reinforcement": 3, "Concrete": 2}'::jsonb, -- FR-CC-02, % by category
  updated_at                timestamptz not null default now()
);

create table public.project_members (
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- A device gets a short unique prefix used in offline document numbers (FR-OF-06).
create sequence app.device_seq;
create table public.devices (
  id            uuid primary key,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  prefix        text not null unique,
  name          text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.push_tokens (
  token       text primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  platform    text,
  updated_at  timestamptz not null default now()
);

-- BR-08: approval limits by value and role (project_id null = company default).
create table public.approval_limits (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects (id) on delete cascade,
  role        public.app_role not null,
  max_value   numeric(18,2) not null,
  updated_at  timestamptz not null default now(),
  unique nulls not distinct (project_id, role)
);

-- -----------------------------------------------------------------------------
-- Project breakdown and structural elements (FR-MD-01, FR-MD-02)
-- -----------------------------------------------------------------------------

create table public.blocks (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  code        text not null,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (project_id, code)
);

create table public.levels (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  block_id    uuid not null references public.blocks (id) on delete cascade,
  code        text not null,
  name        text not null,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (block_id, code)
);

create table public.zones (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  level_id    uuid references public.levels (id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table public.stores (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  name        text not null,
  store_type  text not null default 'main' check (store_type in ('main','satellite','yard','batching')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (project_id, name)
);

-- Configurable activity sequence per element type (FR-PG-01).
create table public.activity_templates (
  id            uuid primary key default gen_random_uuid(),
  element_type  text not null,
  seq           int not null,
  name          text not null,
  weight        numeric(6,2) not null default 1,
  is_hold_point boolean not null default false,
  updated_at    timestamptz not null default now(),
  unique (element_type, seq)
);

create table public.elements (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  block_id        uuid references public.blocks (id),
  level_id        uuid references public.levels (id),
  zone_id         uuid references public.zones (id),
  code            text not null,
  element_type    text not null,
  grid            text,
  drawing_ref     text,
  dimensions      text,
  planned_start   date,
  planned_finish  date,
  actual_start    date,
  actual_finish   date,
  progress_pct    numeric(5,2) not null default 0,
  status          text not null default 'not_started' check (status in ('not_started','in_progress','completed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique nulls not distinct (project_id, block_id, level_id, code)
);

create table public.element_activities (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  element_id      uuid not null references public.elements (id) on delete cascade,
  template_id     uuid references public.activity_templates (id),
  seq             int not null,
  name            text not null,
  weight          numeric(6,2) not null default 1,
  is_hold_point   boolean not null default false,
  reported_pct    numeric(5,2) not null default 0,
  verified_pct    numeric(5,2) not null default 0,
  updated_at      timestamptz not null default now(),
  unique (element_id, seq)
);

-- -----------------------------------------------------------------------------
-- Materials, BoQ, take-off, suppliers (FR-MD-03..06)
-- -----------------------------------------------------------------------------

create table public.materials (
  id            uuid primary key default gen_random_uuid(),
  category      text not null,
  name          text not null,
  standard_ref  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (category, name)
);

-- The selectable item: a material at a given grade/specification (FR-MD-05).
create table public.material_specs (
  id              uuid primary key default gen_random_uuid(),
  material_id     uuid not null references public.materials (id) on delete cascade,
  grade           text not null default '',
  description     text,
  uom             text not null,
  wastage_pct     numeric(5,2) not null default 0,
  min_level       numeric(14,3) not null default 0,
  reorder_level   numeric(14,3) not null default 0,
  lead_time_days  int not null default 0,
  track_batches   boolean not null default false,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (material_id, grade)
);

-- Alternative units: 1 alt_uom = factor × base uom (FR-ST-12).
create table public.spec_conversions (
  id                uuid primary key default gen_random_uuid(),
  material_spec_id  uuid not null references public.material_specs (id) on delete cascade,
  alt_uom           text not null,
  factor            numeric(14,6) not null check (factor > 0),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  unique (material_spec_id, alt_uom)
);

create table public.spec_equivalents (
  material_spec_id    uuid not null references public.material_specs (id) on delete cascade,
  equivalent_spec_id  uuid not null references public.material_specs (id) on delete cascade,
  updated_at          timestamptz not null default now(),
  primary key (material_spec_id, equivalent_spec_id)
);

-- Prices live in their own table so RLS can hide them from site roles (FR-ACC-03, NFR-05).
create table public.spec_prices (
  material_spec_id  uuid primary key references public.material_specs (id) on delete cascade,
  unit_price        numeric(18,2) not null,
  currency          text not null default 'ETB',
  updated_at        timestamptz not null default now()
);

create table public.suppliers (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  contact_person  text,
  phone           text,
  email           text,
  address         text,
  categories      text[] not null default '{}',
  rating          numeric(2,1) check (rating between 0 and 5),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create table public.boq_items (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  item_no      text not null,
  description  text not null,
  unit         text not null,
  quantity     numeric(16,3) not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (project_id, item_no)
);

create table public.boq_rates (
  boq_item_id  uuid primary key references public.boq_items (id) on delete cascade,
  rate         numeric(18,2) not null,
  updated_at   timestamptz not null default now()
);

-- Planned (take-off) quantity of each material spec per element; the basis for
-- BoQ balance checks (FR-MR-03/04) and consumption variance (FR-PG-07, FR-CC-01).
create table public.element_takeoffs (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id) on delete cascade,
  element_id        uuid not null references public.elements (id) on delete cascade,
  material_spec_id  uuid not null references public.material_specs (id),
  boq_item_id       uuid references public.boq_items (id),
  planned_qty       numeric(16,3) not null check (planned_qty >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  unique (element_id, material_spec_id)
);

-- -----------------------------------------------------------------------------
-- Material requests (4.2, 4.3)
-- -----------------------------------------------------------------------------

create table public.material_requests (
  id                 uuid primary key,
  project_id         uuid not null references public.projects (id),
  number             text not null unique,
  block_id           uuid references public.blocks (id),
  requested_by       uuid not null references public.profiles (id),
  requester_role     public.app_role not null,
  status             public.mr_status not null default 'draft',
  priority           public.mr_priority not null default 'normal',
  required_date      date not null,
  delivery_location  text,
  store_id           uuid references public.stores (id),
  drawing_ref        text,
  purpose            text,
  is_lookahead       boolean not null default false,
  version            int not null default 1,
  device_created_at  timestamptz,
  submitted_at       timestamptz,
  reviewed_by        uuid references public.profiles (id),
  reviewed_at        timestamptz,
  approved_by        uuid references public.profiles (id),
  approved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.mr_lines (
  id                uuid primary key,
  mr_id             uuid not null references public.material_requests (id) on delete cascade,
  project_id        uuid not null references public.projects (id),
  line_no           int not null,
  material_spec_id  uuid not null references public.material_specs (id),
  qty               numeric(16,3) not null check (qty > 0),
  approved_qty      numeric(16,3),
  required_date     date,
  remarks           text,
  boq_item_id       uuid references public.boq_items (id),
  exceeds_boq       boolean not null default false,
  over_boq_reason   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create table public.mr_line_elements (
  id          uuid primary key,
  mr_line_id  uuid not null references public.mr_lines (id) on delete cascade,
  project_id  uuid not null references public.projects (id),
  element_id  uuid not null references public.elements (id),
  qty         numeric(16,3) not null check (qty > 0),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Approval history / status changes (FR-WF-06).
create table public.mr_events (
  id           uuid primary key default gen_random_uuid(),
  mr_id        uuid not null references public.material_requests (id) on delete cascade,
  project_id   uuid not null references public.projects (id),
  action       text not null,
  from_status  public.mr_status,
  to_status    public.mr_status,
  comment      text,
  payload      jsonb,
  actor        uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Versioned snapshots of every request edit (FR-MR-09).
create table public.mr_versions (
  id          uuid primary key default gen_random_uuid(),
  mr_id       uuid not null references public.material_requests (id) on delete cascade,
  project_id  uuid not null references public.projects (id),
  version     int not null,
  snapshot    jsonb not null,
  changed_by  uuid references public.profiles (id),
  changed_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Store transactions (4.5, 4.6)
-- -----------------------------------------------------------------------------

create table public.grns (
  id                  uuid primary key,
  project_id          uuid not null references public.projects (id),
  number              text not null unique,
  store_id            uuid not null references public.stores (id),
  supplier_id         uuid references public.suppliers (id),
  supplier_name       text,
  delivery_note_no    text,
  vehicle_plate       text,
  driver_name         text,
  received_at         timestamptz not null,
  remarks             text,
  supplier_signature  text,          -- SVG path data captured on screen (FR-RC-05)
  status              text not null default 'posted' check (status in ('posted','reversed')),
  confirmed_by        uuid references public.profiles (id),   -- FR-RC-07
  confirmed_at        timestamptz,
  reversed_by         uuid references public.profiles (id),
  reversal_reason     text,
  created_by          uuid not null references public.profiles (id),
  device_id           uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.grn_lines (
  id                 uuid primary key,
  grn_id             uuid not null references public.grns (id),
  project_id         uuid not null references public.projects (id),
  line_no            int not null,
  material_spec_id   uuid not null references public.material_specs (id),
  mr_line_id         uuid references public.mr_lines (id),
  ordered_qty        numeric(16,3),
  qty_delivered      numeric(16,3) not null check (qty_delivered >= 0),
  qty_accepted       numeric(16,3) not null check (qty_accepted >= 0),
  qty_rejected       numeric(16,3) not null default 0 check (qty_rejected >= 0),
  entered_uom        text,
  entered_qty        numeric(16,3),
  batch_no           text,
  inspection_result  text not null default 'pass' check (inspection_result in ('pass','conditional','reject')),
  inspection_notes   text,
  variance_flag      text check (variance_flag in ('shortage','excess','wrong_grade')),
  updated_at         timestamptz not null default now()
);

create table public.mivs (
  id                  uuid primary key,
  project_id          uuid not null references public.projects (id),
  number              text not null unique,
  store_id            uuid not null references public.stores (id),
  mr_id               uuid references public.material_requests (id),
  issued_to           uuid not null references public.profiles (id),
  issued_by           uuid not null references public.profiles (id),
  issued_at           timestamptz not null,
  status              text not null default 'pending_ack' check (status in ('pending_ack','acknowledged','reversed')),
  acknowledged_at     timestamptz,
  receiver_signature  text,
  is_emergency        boolean not null default false,   -- BR-01
  emergency_reason    text,
  regularised_at      timestamptz,
  remarks             text,
  reversed_by         uuid references public.profiles (id),
  reversal_reason     text,
  device_id           uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.miv_lines (
  id                   uuid primary key,
  miv_id               uuid not null references public.mivs (id),
  project_id           uuid not null references public.projects (id),
  line_no              int not null,
  mr_line_id           uuid references public.mr_lines (id),
  material_spec_id     uuid not null references public.material_specs (id),
  element_id           uuid not null references public.elements (id),   -- BR-02
  qty                  numeric(16,3) not null check (qty > 0),
  batch_no             text,
  substitution_reason  text,                                             -- BR-05
  updated_at           timestamptz not null default now()
);

create table public.mrns (
  id               uuid primary key,
  project_id       uuid not null references public.projects (id),
  number           text not null unique,
  store_id         uuid not null references public.stores (id),
  miv_id           uuid references public.mivs (id),
  returned_by      uuid references public.profiles (id),
  received_by      uuid not null references public.profiles (id),
  returned_at      timestamptz not null,
  remarks          text,
  status           text not null default 'posted' check (status in ('posted','reversed')),
  reversed_by      uuid references public.profiles (id),
  reversal_reason  text,
  device_id        uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.mrn_lines (
  id                uuid primary key,
  mrn_id            uuid not null references public.mrns (id),
  project_id        uuid not null references public.projects (id),
  line_no           int not null,
  material_spec_id  uuid not null references public.material_specs (id),
  element_id        uuid references public.elements (id),
  mr_line_id        uuid references public.mr_lines (id),
  qty               numeric(16,3) not null check (qty > 0),
  condition         text not null default 'good' check (condition in ('good','damaged')),
  updated_at        timestamptz not null default now()
);

create table public.transfers (
  id              uuid primary key,
  project_id      uuid not null references public.projects (id),
  number          text not null unique,
  from_store_id   uuid not null references public.stores (id),
  to_project_id   uuid not null references public.projects (id),
  to_store_id     uuid not null references public.stores (id),
  status          text not null default 'in_transit' check (status in ('in_transit','received')),
  sent_by         uuid not null references public.profiles (id),
  sent_at         timestamptz not null,
  received_by     uuid references public.profiles (id),
  received_at     timestamptz,
  remarks         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.transfer_lines (
  id                uuid primary key,
  transfer_id       uuid not null references public.transfers (id),
  project_id        uuid not null references public.projects (id),
  line_no           int not null,
  material_spec_id  uuid not null references public.material_specs (id),
  qty               numeric(16,3) not null check (qty > 0),
  qty_received      numeric(16,3),
  updated_at        timestamptz not null default now()
);

create table public.stock_counts (
  id           uuid primary key,
  project_id   uuid not null references public.projects (id),
  number       text not null unique,
  store_id     uuid not null references public.stores (id),
  count_type   text not null default 'periodic' check (count_type in ('periodic','spot')),
  counted_by   uuid not null references public.profiles (id),
  counted_at   timestamptz not null,
  status       text not null default 'submitted' check (status in ('submitted','approved','rejected')),
  decided_by   uuid references public.profiles (id),
  decided_at   timestamptz,
  decision_comment text,
  remarks      text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.stock_count_lines (
  id                uuid primary key,
  count_id          uuid not null references public.stock_counts (id),
  project_id        uuid not null references public.projects (id),
  material_spec_id  uuid not null references public.material_specs (id),
  system_qty        numeric(16,3) not null,
  counted_qty       numeric(16,3) not null check (counted_qty >= 0),
  variance          numeric(16,3) generated always as (counted_qty - system_qty) stored,
  updated_at        timestamptz not null default now()
);

-- Wastage, damage, loss and count variances (FR-ST-07, FR-ST-08).
create table public.adjustments (
  id                uuid primary key,
  project_id        uuid not null references public.projects (id),
  number            text not null unique,
  store_id          uuid not null references public.stores (id),
  adj_type          text not null check (adj_type in ('wastage','damage','loss','write_off','count_variance')),
  reason_code       text,
  remarks           text,
  stock_count_id    uuid references public.stock_counts (id),
  status            text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by      uuid not null references public.profiles (id),
  decided_by        uuid references public.profiles (id),
  decided_at        timestamptz,
  decision_comment  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.adjustment_lines (
  id                uuid primary key,
  adjustment_id     uuid not null references public.adjustments (id),
  project_id        uuid not null references public.projects (id),
  line_no           int not null,
  material_spec_id  uuid not null references public.material_specs (id),
  element_id        uuid references public.elements (id),
  stock_status      text not null default 'available' check (stock_status in ('available','quarantine')),
  qty_delta         numeric(16,3) not null check (qty_delta <> 0),
  updated_at        timestamptz not null default now()
);

-- Append-only digital bin card (FR-ST-01). Never updated or deleted (BR-07).
create table public.stock_ledger (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id),
  store_id          uuid not null references public.stores (id),
  material_spec_id  uuid not null references public.material_specs (id),
  qty               numeric(16,3) not null check (qty <> 0),
  stock_status      text not null default 'available' check (stock_status in ('available','quarantine')),
  txn_type          text not null check (txn_type in ('opening','grn','miv','mrn','transfer_out','transfer_in','adjustment','reversal')),
  doc_type          text not null,
  doc_id            uuid not null,
  doc_number        text not null,
  doc_line_id       uuid,
  element_id        uuid references public.elements (id),
  mr_line_id        uuid references public.mr_lines (id),
  batch_no          text,
  reversal_of       uuid references public.stock_ledger (id),
  txn_at            timestamptz not null,
  created_by        uuid references public.profiles (id),
  device_id         uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index stock_ledger_balance_idx on public.stock_ledger (store_id, material_spec_id, stock_status);
create index stock_ledger_element_idx on public.stock_ledger (element_id, material_spec_id) where element_id is not null;
create index stock_ledger_doc_idx on public.stock_ledger (doc_id);

-- -----------------------------------------------------------------------------
-- Progress (4.7)
-- -----------------------------------------------------------------------------

create table public.progress_updates (
  id                   uuid primary key,
  project_id           uuid not null references public.projects (id),
  element_id           uuid not null references public.elements (id),
  element_activity_id  uuid not null references public.element_activities (id),
  report_date          date not null,
  pct_complete         numeric(5,2) not null check (pct_complete between 0 and 100),
  qty_achieved         numeric(16,3),
  uom                  text,
  remarks              text,
  status               text not null default 'reported' check (status in ('reported','verified','adjusted','rejected')),
  reported_by          uuid not null references public.profiles (id),
  verified_by          uuid references public.profiles (id),
  verified_at          timestamptz,
  verified_pct         numeric(5,2),
  verify_comment       text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Attachments, notifications, audit, idempotency
-- -----------------------------------------------------------------------------

create table public.attachments (
  id            uuid primary key,
  project_id    uuid not null references public.projects (id),
  entity_type   text not null,
  entity_id     uuid not null,
  kind          text not null default 'photo' check (kind in ('photo','delivery_note','signature','document')),
  storage_path  text not null,
  mime_type     text,
  latitude      double precision,
  longitude     double precision,
  created_by    uuid not null references public.profiles (id) default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index attachments_entity_idx on public.attachments (entity_type, entity_id);

create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  project_id   uuid references public.projects (id) on delete cascade,
  title        text not null,
  body         text,
  entity_type  text,
  entity_id    uuid,
  is_critical  boolean not null default false,
  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  device_id   uuid,
  project_id  uuid,
  table_name  text not null,
  record_id   text,
  action      text not null,
  old_data    jsonb,
  new_data    jsonb
);
create index audit_log_record_idx on public.audit_log (table_name, record_id);
create index audit_log_at_idx on public.audit_log (at desc);

-- Every RPC from the mobile outbox carries an op_id; replays return the stored result.
create table app.processed_ops (
  op_id       uuid primary key,
  fn          text not null,
  user_id     uuid,
  result      jsonb,
  created_at  timestamptz not null default now()
);

-- Updated-at indexes for incremental sync pulls.
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','projects','project_settings','project_members','blocks','levels','zones','stores',
    'activity_templates','elements','element_activities','materials','material_specs','spec_conversions',
    'spec_equivalents','spec_prices','suppliers','boq_items','boq_rates','element_takeoffs',
    'material_requests','mr_lines','mr_line_elements','mr_events','grns','grn_lines','mivs','miv_lines',
    'mrns','mrn_lines','transfers','transfer_lines','stock_counts','stock_count_lines','adjustments',
    'adjustment_lines','stock_ledger','progress_updates','attachments','notifications','approval_limits',
    'devices','app_settings','mr_versions'
  ] loop
    execute format('create index %I on public.%I (updated_at)', t || '_updated_at_idx', t);
  end loop;
end $$;
