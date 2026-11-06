-- =============================================================================
-- Field & quality (P1 #6–#9):
--   site diary · inspection checklists (hold points) · snags · concrete pours,
--   ready-mix batch tickets, site batching & cube tests · rebar BBS reconciliation.
--
-- Conventions as in 0001–0004: client-generated uuid ids and document numbers
-- (<PROJECT>-<TYPE>-<DEVICE>-<SEQ>, types SD, INS, SNG, POUR, CUBE, BBS),
-- project_id + updated_at on every row, RLS read for members, writes only via
-- security-definer RPCs taking a single jsonb `p` with `op_id`.
-- Stock effects of pours reuse public.post_grn / public.post_miv / app.post_ledger,
-- so concrete and cement are never entered twice.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Small helpers
-- -----------------------------------------------------------------------------

-- Site-local calendar date (projects are in Ethiopia; UTC+3, no DST).
create or replace function app.local_date(p_ts timestamptz) returns date
language sql stable as $$ select (p_ts at time zone 'Africa/Addis_Ababa')::date $$;

-- Bar diameter from a rebar grade label such as 'S-400 Ø16'.
create or replace function app.spec_diameter(p_grade text) returns int
language sql immutable as $$
  select (regexp_match(coalesce(p_grade, ''), '(?:Ø|ø|Φ|φ|dia\.?\s*)\s*(\d{1,2})', 'i'))[1]::int
$$;

-- kg per unit of measure for mass-based reconciliations (null = not a mass unit).
create or replace function app.uom_kg(p_uom text) returns numeric
language sql immutable as $$
  select case lower(trim(coalesce(p_uom, '')))
    when 'kg' then 1 when 'qtl' then 100 when 'quintal' then 100
    when 'tonne' then 1000 when 't' then 1000 when 'ton' then 1000
    when 'bag' then 50 when 'bag (50kg)' then 50 end
$$;

-- Characteristic cube strength from a grade label: 'C-25/30' → 30, 'C25' → 25.
create or replace function app.grade_cube_strength(p_grade text) returns numeric
language sql immutable as $$
  select coalesce((regexp_match(coalesce(p_grade, ''), '(\d+)\s*/\s*(\d+)'))[2]::numeric,
                  (regexp_match(coalesce(p_grade, ''), '(\d+)'))[1]::numeric)
$$;

-- Fraction of the 28-day strength expected at an early age (indicative only).
create or replace function app.cube_age_factor(p_age int) returns numeric
language sql immutable as $$
  select case when p_age >= 28 then 1.0 when p_age >= 21 then 0.95 when p_age >= 14 then 0.85
              when p_age >= 7 then 0.65 when p_age >= 3 then 0.40 else 0.25 end
$$;

-- Fill defaults for missing/null keys of each row in a jsonb array.
create or replace function app.with_defaults(p_rows jsonb, p_defaults jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(p_defaults || jsonb_build_object('_ord', o) || jsonb_strip_nulls(r) order by o), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as x(r, o)
$$;

-- Replace-by-id for child rows of a draft document: upsert the rows sent,
-- soft-delete the ones not sent. Rows owned by another parent are ignored.
create or replace function app.replace_children(p_table text, p_fk text, p_parent uuid, p_project uuid,
  p_rows jsonb, p_cols text[]) returns void
language plpgsql security definer set search_path = public as $$
declare v_ids uuid[];
begin
  p_rows := coalesce(p_rows, '[]'::jsonb);
  if exists (select 1 from jsonb_array_elements(p_rows) r where r ->> 'id' is null) then
    raise exception 'Every % row needs an id', replace(p_table, '_', ' ');
  end if;
  select coalesce(array_agg((r ->> 'id')::uuid), '{}') into v_ids from jsonb_array_elements(p_rows) r;
  execute format($f$
    insert into public.%1$I as t (id, %2$I, project_id, %3$s)
    select x.id, $1, $2, %4$s from jsonb_populate_recordset(null::public.%1$I, $3) x
    on conflict (id) do update set %5$s, deleted_at = null
    where t.%2$I = $1 $f$,
    p_table, p_fk,
    (select string_agg(format('%I', c), ', ') from unnest(p_cols) c),
    (select string_agg(format('x.%I', c), ', ') from unnest(p_cols) c),
    (select string_agg(format('%1$I = excluded.%1$I', c), ', ') from unnest(p_cols) c))
  using p_parent, p_project, p_rows;
  execute format('update public.%1$I set deleted_at = now() where %2$I = $1 and deleted_at is null and not (id = any ($2))',
    p_table, p_fk) using p_parent, v_ids;
end $$;

-- =============================================================================
-- P1-6 Site diary
-- =============================================================================

create table public.labour_trades (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  name_am     text,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

insert into public.labour_trades (name, name_am, sort_order) values
  ('Mason', 'ግንበኛ', 1), ('Carpenter', 'አናጢ', 2), ('Bar bender', 'ብረት አጣማሚ', 3),
  ('Daily labourer', 'የቀን ሰራተኛ', 4), ('Plasterer', 'ልስን ሰራተኛ', 5), ('Electrician', 'ኤሌክትሪሲያን', 6),
  ('Plumber', 'ቧንቧ ሰራተኛ', 7), ('Welder', 'በያጅ', 8), ('Painter', 'ቀለም ቀቢ', 9),
  ('Tiler', 'ሴራሚክ ነጣፊ', 10), ('Equipment operator', 'ኦፕሬተር', 11), ('Foreman', 'ፎርማን', 12),
  ('Guard', 'ጥበቃ', 13)
on conflict (name) do nothing;

create table public.site_diaries (
  id              uuid primary key,
  project_id      uuid not null references public.projects (id),
  number          text not null unique,
  diary_date      date not null,
  block_id        uuid references public.blocks (id),
  weather_am      text check (weather_am in ('sunny','cloudy','rain','heavy_rain','windy','fog')),
  weather_pm      text check (weather_pm in ('sunny','cloudy','rain','heavy_rain','windy','fog')),
  rain_hours      numeric(4,1) check (rain_hours between 0 and 24),
  temp_min        numeric(4,1),
  temp_max        numeric(4,1),
  weather_source  text not null default 'manual' check (weather_source in ('manual','api')),
  work_summary    text,
  safety_notes    text,
  notes           text,
  status          text not null default 'draft' check (status in ('draft','submitted','signed')),
  version         int not null default 1,
  created_by      uuid not null references public.profiles (id),
  submitted_at    timestamptz,
  signed_by       uuid references public.profiles (id),
  signed_at       timestamptz,
  sign_comment    text,
  device_id       uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique nulls not distinct (project_id, block_id, diary_date)
);

create table public.diary_labour (
  id             uuid primary key,
  diary_id       uuid not null references public.site_diaries (id),
  project_id     uuid not null references public.projects (id),
  trade_id       uuid references public.labour_trades (id),
  trade_name     text,
  subcontractor  text,
  headcount      int not null check (headcount >= 0),
  hours          numeric(6,1) check (hours >= 0),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  check (trade_id is not null or trade_name is not null)
);

create table public.diary_equipment (
  id            uuid primary key,
  diary_id      uuid not null references public.site_diaries (id),
  project_id    uuid not null references public.projects (id),
  equipment     text not null,
  qty           int not null default 1 check (qty > 0),
  hours_worked  numeric(5,1) check (hours_worked >= 0),
  hours_idle    numeric(5,1) check (hours_idle >= 0),
  idle_reason   text,
  status        text not null default 'working' check (status in ('working','idle','breakdown')),
  note          text,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table public.diary_delays (
  id           uuid primary key,
  diary_id     uuid not null references public.site_diaries (id),
  project_id   uuid not null references public.projects (id),
  cause        text not null check (cause in ('rain','weather','cement_shortage','material_shortage','power_cut',
                 'water_shortage','design_change','design_info','payment','labour','equipment','client','permit','other')),
  hours_lost   numeric(5,1) check (hours_lost >= 0),
  element_id   uuid references public.elements (id),
  description  text,
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create table public.diary_visitors (
  id            uuid primary key,
  diary_id      uuid not null references public.site_diaries (id),
  project_id    uuid not null references public.projects (id),
  name          text not null,
  organisation  text,
  purpose       text,
  time_in       time,
  time_out      time,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- Instructions received on site (consultant / client / management).
create table public.diary_instructions (
  id            uuid primary key,
  diary_id      uuid not null references public.site_diaries (id),
  project_id    uuid not null references public.projects (id),
  given_by      text,
  organisation  text,
  instruction   text not null,
  element_id    uuid references public.elements (id),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- Elements worked on that day.
create table public.diary_elements (
  id          uuid primary key,
  diary_id    uuid not null references public.site_diaries (id),
  project_id  uuid not null references public.projects (id),
  element_id  uuid not null references public.elements (id),
  note        text,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Later changes to a submitted/signed diary. Insert-only.
create table public.diary_addenda (
  id          uuid primary key,
  diary_id    uuid not null references public.site_diaries (id),
  project_id  uuid not null references public.projects (id),
  text        text not null,
  created_by  uuid not null references public.profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index diary_labour_diary_idx on public.diary_labour (diary_id);
create index diary_equipment_diary_idx on public.diary_equipment (diary_id);
create index diary_delays_diary_idx on public.diary_delays (diary_id);
create index diary_visitors_diary_idx on public.diary_visitors (diary_id);
create index diary_instructions_diary_idx on public.diary_instructions (diary_id);
create index diary_elements_diary_idx on public.diary_elements (diary_id);
create index diary_addenda_diary_idx on public.diary_addenda (diary_id);

-- =============================================================================
-- P1-7 Inspection checklists & snags
-- =============================================================================

-- project_id null = company-wide template (like activity_templates).
create table public.checklist_templates (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid references public.projects (id),
  code             text not null,
  name             text not null,
  name_am          text,
  description      text,
  element_types    text[] not null default '{}',  -- lower-case element types it applies to
  hold_activities  text[] not null default '{}',  -- activity names (hold points) it must pass to clear
  version          int not null default 1,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique nulls not distinct (project_id, code)
);

create table public.checklist_template_items (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references public.checklist_templates (id) on delete cascade,
  project_id      uuid references public.projects (id),
  seq             int not null,
  text            text not null,
  text_am         text,
  item_type       text not null default 'yes_no' check (item_type in ('yes_no','value','photo','text')),
  min_value       numeric,
  max_value       numeric,
  unit            text,
  photo_required  boolean not null default false,
  is_critical     boolean not null default false,
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index checklist_template_items_tpl_idx on public.checklist_template_items (template_id);

create table public.inspections (
  id                   uuid primary key,
  project_id           uuid not null references public.projects (id),
  number               text not null unique,
  template_id          uuid not null references public.checklist_templates (id),
  template_version     int,
  element_id           uuid not null references public.elements (id),
  element_activity_id  uuid references public.element_activities (id),
  status               text not null default 'requested' check (status in ('requested','completed','cancelled')),
  result               text check (result in ('pass','conditional','fail')),
  requested_by         uuid references public.profiles (id),
  requested_at         timestamptz,
  requested_for        timestamptz,
  inspector_id         uuid references public.profiles (id),
  inspected_at         timestamptz,
  consultant_name      text,
  remarks              text,
  reinspection_of      uuid references public.inspections (id),
  device_id            uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index inspections_activity_idx on public.inspections (element_activity_id);
create index inspections_element_idx on public.inspections (element_id);

create table public.snags (
  id                uuid primary key,
  project_id        uuid not null references public.projects (id),
  number            text not null unique,
  element_id        uuid references public.elements (id),
  block_id          uuid references public.blocks (id),
  level_id          uuid references public.levels (id),
  location_text     text,
  category          text,
  trade             text,
  severity          text not null default 'medium' check (severity in ('low','medium','high','critical')),
  title             text not null,
  description       text,
  assignee_user_id  uuid references public.profiles (id),
  assignee_party    text,
  due_date          date,
  source_type       text not null default 'walk' check (source_type in ('inspection','pour','cube','diary','walk','other')),
  source_id         uuid,
  status            text not null default 'open'
                    check (status in ('open','in_progress','ready_for_review','closed','reopened','cancelled')),
  raised_by         uuid references public.profiles (id),
  closed_by         uuid references public.profiles (id),
  closed_at         timestamptz,
  device_id         uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index snags_element_idx on public.snags (element_id);
create index snags_source_idx on public.snags (source_id);

create table public.snag_events (
  id           uuid primary key default gen_random_uuid(),
  snag_id      uuid not null references public.snags (id),
  project_id   uuid not null references public.projects (id),
  action       text not null,
  from_status  text,
  to_status    text,
  comment      text,
  actor        uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index snag_events_snag_idx on public.snag_events (snag_id);

create table public.inspection_items (
  id                uuid primary key,
  inspection_id     uuid not null references public.inspections (id),
  project_id        uuid not null references public.projects (id),
  template_item_id  uuid not null references public.checklist_template_items (id),
  seq               int not null,
  text              text not null,           -- snapshot of the template wording
  item_type         text not null,
  is_critical       boolean not null default false,
  response          text not null check (response in ('pass','fail','na')),
  value_num         numeric,
  value_text        text,
  snag_id           uuid references public.snags (id),
  updated_at        timestamptz not null default now()
);
create index inspection_items_insp_idx on public.inspection_items (inspection_id);

-- Starter templates (company-wide). Hold-point names match seed.sql activity_templates.
with t as (
  insert into public.checklist_templates (code, name, name_am, description, element_types, hold_activities) values
    ('REBAR', 'Rebar inspection (before pour)', 'የብረት ፍተሻ', 'Reinforcement checked against drawings/BBS before formwork is closed or concrete placed',
       '{footing,column,beam}', '{"rebar & formwork inspection"}'),
    ('FORMWORK', 'Formwork inspection', 'የቅርጽ ፍተሻ', 'Formwork dimensions, alignment, tightness and support',
       '{footing,column,beam}', '{"rebar & formwork inspection"}'),
    ('PREPOUR-SLAB', 'Pre-pour inspection — slab / stair', 'ከሙሌት በፊት ፍተሻ', 'Formwork, reinforcement, embeds and readiness before casting',
       '{slab,staircase}', '{"pre-pour inspection"}'),
    ('BLOCKWORK', 'Blockwork inspection', 'የብሎኬት ስራ ፍተሻ', 'HCB walls: material, alignment, bonding and ties',
       '{wall}', '{}')
  on conflict (project_id, code) do nothing
  returning id, code
)
insert into public.checklist_template_items (template_id, seq, text, item_type, min_value, max_value, unit, photo_required, is_critical)
select t.id, v.seq, v.text, v.item_type, v.min_value, v.max_value, v.unit, v.photo_required, v.is_critical
from t join (values
  ('REBAR', 1, 'Bar diameters and steel grade as per drawing / BBS', 'yes_no', null::numeric, null::numeric, null, false, true),
  ('REBAR', 2, 'Number of bars and spacing as per drawing', 'yes_no', null, null, null, false, true),
  ('REBAR', 3, 'Lap / anchorage lengths not less than specified', 'yes_no', null, null, null, false, true),
  ('REBAR', 4, 'Stirrup / link spacing and 135° hooks', 'yes_no', null, null, null, false, true),
  ('REBAR', 5, 'Concrete cover (spacer blocks) measured', 'value', 20, 75, 'mm', false, true),
  ('REBAR', 6, 'Bars clean — no loose rust, oil or mud', 'yes_no', null, null, null, false, false),
  ('REBAR', 7, 'Bars tied securely, cage rigid', 'yes_no', null, null, null, false, false),
  ('REBAR', 8, 'Starter bars / dowels positioned for next lift', 'yes_no', null, null, null, false, false),
  ('REBAR', 9, 'Photo of reinforcement', 'photo', null, null, null, true, false),
  ('FORMWORK', 1, 'Dimensions and position as per drawing', 'yes_no', null, null, null, false, true),
  ('FORMWORK', 2, 'Out of plumb / level (per 3 m)', 'value', 0, 5, 'mm', false, true),
  ('FORMWORK', 3, 'Props, ties and bracing adequate', 'yes_no', null, null, null, false, true),
  ('FORMWORK', 4, 'Joints tight (grout-proof)', 'yes_no', null, null, null, false, false),
  ('FORMWORK', 5, 'Release agent applied, forms clean', 'yes_no', null, null, null, false, false),
  ('FORMWORK', 6, 'Photo of formwork', 'photo', null, null, null, true, false),
  ('PREPOUR-SLAB', 1, 'Formwork level and shoring adequate', 'yes_no', null, null, null, false, true),
  ('PREPOUR-SLAB', 2, 'Reinforcement as per drawing (diameter, spacing, laps)', 'yes_no', null, null, null, false, true),
  ('PREPOUR-SLAB', 3, 'Bottom cover measured', 'value', 15, 50, 'mm', false, true),
  ('PREPOUR-SLAB', 4, 'Top steel chairs / spacers in place', 'yes_no', null, null, null, false, false),
  ('PREPOUR-SLAB', 5, 'MEP sleeves, conduits and embeds positioned', 'yes_no', null, null, null, false, true),
  ('PREPOUR-SLAB', 6, 'Slab thickness at edge forms', 'value', null, null, 'mm', false, false),
  ('PREPOUR-SLAB', 7, 'Debris removed, forms wetted', 'yes_no', null, null, null, false, false),
  ('PREPOUR-SLAB', 8, 'Construction joints prepared', 'yes_no', null, null, null, false, false),
  ('PREPOUR-SLAB', 9, 'Concrete supply, vibrators, labour and lighting ready', 'yes_no', null, null, null, false, false),
  ('PREPOUR-SLAB', 10, 'Photo before pour', 'photo', null, null, null, true, false),
  ('BLOCKWORK', 1, 'HCB class / thickness as specified', 'yes_no', null, null, null, false, true),
  ('BLOCKWORK', 2, 'Mortar mix as specified', 'yes_no', null, null, null, false, false),
  ('BLOCKWORK', 3, 'Wall out of plumb (per storey)', 'value', 0, 10, 'mm', false, false),
  ('BLOCKWORK', 4, 'Bond pattern and joint thickness (~10 mm)', 'yes_no', null, null, null, false, false),
  ('BLOCKWORK', 5, 'Ties / dowels to columns installed', 'yes_no', null, null, null, false, true),
  ('BLOCKWORK', 6, 'Openings and lintel positions as per drawing', 'yes_no', null, null, null, false, false),
  ('BLOCKWORK', 7, 'Photo of wall', 'photo', null, null, null, true, false)
) as v(code, seq, text, item_type, min_value, max_value, unit, photo_required, is_critical) on v.code = t.code;

-- =============================================================================
-- P1-8 Concrete pours, ready-mix tickets, site batching, cubes
-- =============================================================================

create table public.mix_designs (
  id                   uuid primary key,
  project_id           uuid not null references public.projects (id),
  code                 text not null,
  grade                text not null,                      -- e.g. C-25/30
  source               text not null default 'ready_mix' check (source in ('ready_mix','site')),
  material_spec_id     uuid references public.material_specs (id),  -- concrete spec received for ready-mix
  target_strength_mpa  numeric(5,1) not null check (target_strength_mpa > 0), -- characteristic cube strength
  cement_spec_id       uuid references public.material_specs (id),
  cement_kg_per_m3     numeric(7,2),
  water_cement_ratio   numeric(4,2),
  sand_m3_per_m3       numeric(6,3),
  aggregate_m3_per_m3  numeric(6,3),
  target_slump_mm      int,
  slump_tolerance_mm   int not null default 25,
  remarks              text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  unique (project_id, code)
);

create table public.pours (
  id              uuid primary key,
  project_id      uuid not null references public.projects (id),
  number          text not null unique,
  pour_date       date not null,
  mix_design_id   uuid not null references public.mix_designs (id),
  method          text not null check (method in ('ready_mix','site_batched')),
  supplier_id     uuid references public.suppliers (id),
  supplier_name   text,
  store_id        uuid references public.stores (id),            -- receiving / batching store
  mr_id           uuid references public.material_requests (id), -- optional approved request issues are booked against
  planned_m3      numeric(10,3) not null check (planned_m3 > 0),
  actual_m3       numeric(10,3),
  start_at        timestamptz,
  end_at          timestamptz,
  weather         text,
  curing_method   text,
  status          text not null default 'planned' check (status in ('planned','in_progress','completed','cancelled')),
  remarks         text,
  created_by      uuid not null references public.profiles (id),
  closed_by       uuid references public.profiles (id),
  device_id       uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.pour_elements (
  id          uuid primary key,
  pour_id     uuid not null references public.pours (id),
  project_id  uuid not null references public.projects (id),
  element_id  uuid not null references public.elements (id),
  planned_m3  numeric(10,3) check (planned_m3 >= 0),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index pour_elements_pour_idx on public.pour_elements (pour_id);

-- Ready-mix batch tickets (FR-RC-06). Append-only once posted/rejected.
create table public.pour_trucks (
  id               uuid primary key,
  pour_id          uuid not null references public.pours (id),
  project_id       uuid not null references public.projects (id),
  seq              int not null,
  ticket_no        text not null,
  supplier_name    text,
  truck_plate      text,
  volume_m3        numeric(6,2) not null check (volume_m3 > 0),
  batched_at       timestamptz,
  arrived_at       timestamptz,
  discharge_start  timestamptz,
  discharge_end    timestamptz,
  slump_mm         int,
  concrete_temp_c  numeric(4,1),
  water_added_l    numeric(6,1),
  accepted         boolean not null,
  reject_reason    text,
  status           text not null check (status in ('awaiting_receipt','posted','rejected')),
  warnings         text[] not null default '{}',
  grn_id           uuid references public.grns (id),
  miv_id           uuid references public.mivs (id),
  recorded_by      uuid not null references public.profiles (id),
  received_by      uuid references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (pour_id, ticket_no)
);

-- Site-batched mixes. Append-only.
create table public.pour_batches (
  id            uuid primary key,
  pour_id       uuid not null references public.pours (id),
  project_id    uuid not null references public.projects (id),
  seq           int not null,
  volume_m3     numeric(6,3) check (volume_m3 > 0),
  cement_bags   numeric(6,2) not null check (cement_bags >= 0),
  sand_m3       numeric(6,3),
  aggregate_m3  numeric(6,3),
  water_l       numeric(7,1),
  slump_mm      int,
  mixer         text,
  batched_at    timestamptz not null default now(),
  recorded_by   uuid not null references public.profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Stock documents posted for a pour (truck GRN/MIV pairs and material issues).
create table public.pour_issues (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id),
  pour_id     uuid not null references public.pours (id),
  miv_id      uuid not null references public.mivs (id),
  grn_id      uuid references public.grns (id),
  truck_id    uuid references public.pour_trucks (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index pour_issues_pour_idx on public.pour_issues (pour_id);

create table public.cube_sets (
  id                     uuid primary key,
  project_id             uuid not null references public.projects (id),
  number                 text not null unique,
  pour_id                uuid not null references public.pours (id),
  truck_id               uuid references public.pour_trucks (id),
  element_id             uuid references public.elements (id),
  sampled_at             timestamptz not null,
  cubes_count            int not null default 3 check (cubes_count > 0),
  cube_size_mm           int not null default 150,
  test_ages              int[] not null default '{7,28}',
  lab_name               text,
  required_strength_mpa  numeric(5,1) not null,
  result_early           text check (result_early in ('ok','low')),
  result_28d             text check (result_28d in ('pass','fail')),
  mean_28d_mpa           numeric(6,2),
  snag_id                uuid references public.snags (id),
  created_by             uuid not null references public.profiles (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table public.cube_results (
  id             uuid primary key,
  cube_set_id    uuid not null references public.cube_sets (id),
  project_id     uuid not null references public.projects (id),
  cube_label     text not null,
  age_days       int not null check (age_days > 0),
  tested_on      date,
  load_kn        numeric(8,2),
  strength_mpa   numeric(6,2) not null,
  density_kg_m3  numeric(7,1),
  failure_mode   text,
  passed         boolean not null,
  recorded_by    uuid not null references public.profiles (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index cube_results_set_idx on public.cube_results (cube_set_id);

-- =============================================================================
-- P1-9 Rebar BBS
-- =============================================================================

create table public.bbs_schedules (
  id           uuid primary key,
  project_id   uuid not null references public.projects (id),
  number       text not null unique,
  element_id   uuid not null references public.elements (id),
  revision     int not null default 0,
  drawing_ref  text,
  remarks      text,
  status       text not null default 'draft' check (status in ('draft','approved','superseded')),
  created_by   uuid not null references public.profiles (id),
  approved_by  uuid references public.profiles (id),
  approved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (element_id, revision)
);

create table public.bbs_lines (
  id                uuid primary key,
  bbs_id            uuid not null references public.bbs_schedules (id),
  project_id        uuid not null references public.projects (id),
  line_no           int not null,
  bar_mark          text not null,
  material_spec_id  uuid references public.material_specs (id),
  diameter_mm       int not null check (diameter_mm between 4 and 50),
  shape_code        text,
  no_of_members     int not null default 1 check (no_of_members > 0),
  bars_per_member   int not null check (bars_per_member > 0),
  cut_length_m      numeric(8,3) not null check (cut_length_m > 0),
  total_length_m    numeric(12,3) generated always as (no_of_members * bars_per_member * cut_length_m) stored,
  unit_weight_kg_m  numeric(8,4) generated always as (round(diameter_mm * diameter_mm / 162.0, 4)) stored,
  weight_kg         numeric(12,3) generated always as
                      (round(no_of_members * bars_per_member * cut_length_m * diameter_mm * diameter_mm / 162.0, 3)) stored,
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index bbs_lines_bbs_idx on public.bbs_lines (bbs_id);

-- =============================================================================
-- Triggers: updated_at, audit, immutability
-- =============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'labour_trades','site_diaries','diary_labour','diary_equipment','diary_delays','diary_visitors',
    'diary_instructions','diary_elements','diary_addenda','checklist_templates','checklist_template_items',
    'inspections','inspection_items','snags','snag_events','mix_designs','pours','pour_elements','pour_trucks',
    'pour_batches','pour_issues','cube_sets','cube_results','bbs_schedules','bbs_lines'
  ] loop
    execute format('create index %I on public.%I (updated_at)', t || '_updated_at_idx', t);
    execute format('create trigger touch_updated_at before update on public.%I
                    for each row execute function app.touch_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;

  foreach t in array array['labour_trades','site_diaries','checklist_templates','inspections','snags','mix_designs',
                           'pours','pour_trucks','cube_sets','cube_results','bbs_schedules'] loop
    execute format('create trigger audit after insert or update or delete on public.%I
                    for each row execute function app.audit()', t);
  end loop;

  -- insert-only records
  foreach t in array array['diary_addenda','inspection_items','snag_events','pour_batches','pour_issues','cube_results'] loop
    execute format('create trigger immutable before update or delete on public.%I
                    for each row execute function app.block_mutation()', t);
  end loop;
  foreach t in array array['site_diaries','inspections','snags','pours','pour_trucks','cube_sets','bbs_schedules',
                           'pour_elements','bbs_lines','diary_labour','diary_equipment','diary_delays','diary_visitors',
                           'diary_instructions','diary_elements'] loop
    execute format('create trigger no_delete before delete on public.%I
                    for each row execute function app.block_mutation()', t);
  end loop;
end $$;

-- Signed diaries are frozen; later changes go to diary_addenda.
create or replace function app.guard_site_diary() returns trigger
language plpgsql as $$
begin
  if old.status = 'signed' and (to_jsonb(new) - 'updated_at') <> (to_jsonb(old) - 'updated_at') then
    raise exception 'Site diary % is signed and cannot be changed; add an addendum instead', old.number
      using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_signed before update on public.site_diaries
  for each row execute function app.guard_site_diary();

create or replace function app.guard_diary_child() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.site_diaries where id = new.diary_id and status = 'signed') then
    raise exception 'Site diary is signed and cannot be changed; add an addendum instead' using errcode = '42501';
  end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['diary_labour','diary_equipment','diary_delays','diary_visitors','diary_instructions','diary_elements'] loop
    execute format('create trigger guard_signed before insert or update on public.%I
                    for each row execute function app.guard_diary_child()', t);
  end loop;
end $$;

-- A completed inspection is a record of fact; re-inspect with a new one.
create or replace function app.guard_inspection() returns trigger
language plpgsql as $$
begin
  if old.status <> 'requested' and (to_jsonb(new) - 'updated_at') <> (to_jsonb(old) - 'updated_at') then
    raise exception 'Inspection % is % and cannot be changed; record a re-inspection', old.number, old.status
      using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_completed before update on public.inspections
  for each row execute function app.guard_inspection();

create or replace function app.guard_snag() returns trigger
language plpgsql as $$
begin
  if old.status in ('closed','cancelled') and not (old.status = 'closed' and new.status = 'reopened')
     and (to_jsonb(new) - 'updated_at') <> (to_jsonb(old) - 'updated_at') then
    raise exception 'Snag % is % and cannot be changed', old.number, old.status using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_closed before update on public.snags
  for each row execute function app.guard_snag();

create or replace function app.guard_pour() returns trigger
language plpgsql as $$
begin
  if old.status in ('completed','cancelled') and (to_jsonb(new) - 'updated_at') <> (to_jsonb(old) - 'updated_at') then
    raise exception 'Pour % is % and cannot be changed', old.number, old.status using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_closed before update on public.pours
  for each row execute function app.guard_pour();

-- Trucks: only an awaiting_receipt truck may be updated (to posted).
create or replace function app.guard_pour_truck() returns trigger
language plpgsql as $$
begin
  if old.status <> 'awaiting_receipt' and (to_jsonb(new) - 'updated_at') <> (to_jsonb(old) - 'updated_at') then
    raise exception 'pour_trucks records are immutable once posted or rejected' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger immutable before update on public.pour_trucks
  for each row execute function app.guard_pour_truck();

-- Approved BBS: only approved → superseded is allowed; lines frozen.
create or replace function app.guard_bbs() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft'
     and not (old.status = 'approved' and new.status = 'superseded'
              and (to_jsonb(new) - 'updated_at' - 'status') = (to_jsonb(old) - 'updated_at' - 'status'))
     and (to_jsonb(new) - 'updated_at') <> (to_jsonb(old) - 'updated_at') then
    raise exception 'BBS % is % and cannot be changed; issue a new revision', old.number, old.status using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_approved before update on public.bbs_schedules
  for each row execute function app.guard_bbs();

create or replace function app.guard_bbs_line() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from public.bbs_schedules where id = new.bbs_id and status <> 'draft') then
    raise exception 'BBS is approved; issue a new revision' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_approved before insert or update on public.bbs_lines
  for each row execute function app.guard_bbs_line();

-- =============================================================================
-- Row-level security: members read; writes through RPCs (masters: see below)
-- =============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'site_diaries','diary_labour','diary_equipment','diary_delays','diary_visitors','diary_instructions',
    'diary_elements','diary_addenda','inspections','inspection_items','snags','snag_events','mix_designs','pours',
    'pour_elements','pour_trucks','pour_batches','pour_issues','cube_sets','cube_results','bbs_schedules','bbs_lines'
  ] loop
    execute format('create policy member_read on public.%I for select to authenticated using (app.is_member(project_id))', t);
  end loop;
end $$;

create policy read_all on public.labour_trades for select to authenticated using (app.is_active_user());
create policy master_write on public.labour_trades for all to authenticated
  using (app.has_role('office_engineer','coordinator','manager','admin'))
  with check (app.has_role('office_engineer','coordinator','manager','admin'));

create policy member_read on public.checklist_templates for select to authenticated
  using (case when project_id is null then app.is_active_user() else app.is_member(project_id) end);
create policy member_read on public.checklist_template_items for select to authenticated
  using (case when project_id is null then app.is_active_user() else app.is_member(project_id) end);

-- =============================================================================
-- Snags (C2)
-- =============================================================================

create or replace function app.create_snag(p jsonb, p_project uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_el public.elements;
  v_sev text := coalesce(nullif(p ->> 'severity', ''), 'medium');
begin
  if coalesce(trim(p ->> 'title'), '') = '' then raise exception 'Snag title is required'; end if;
  if coalesce(p ->> 'number', '') = '' then raise exception 'Snag number is required'; end if;
  if p ->> 'element_id' is not null then
    select * into v_el from public.elements where id = (p ->> 'element_id')::uuid and project_id = p_project;
    if not found then raise exception 'Element does not belong to this project'; end if;
  end if;
  if p ->> 'assignee_user_id' is not null and not exists (
      select 1 from public.project_members where project_id = p_project and user_id = (p ->> 'assignee_user_id')::uuid) then
    raise exception 'Assignee is not a member of this project';
  end if;
  insert into public.snags (id, project_id, number, element_id, block_id, level_id, location_text, category, trade,
    severity, title, description, assignee_user_id, assignee_party, due_date, source_type, source_id, raised_by, device_id)
  values (v_id, p_project, p ->> 'number', v_el.id, coalesce((p ->> 'block_id')::uuid, v_el.block_id),
    coalesce((p ->> 'level_id')::uuid, v_el.level_id), nullif(p ->> 'location_text', ''), nullif(p ->> 'category', ''),
    nullif(p ->> 'trade', ''), v_sev, trim(p ->> 'title'), nullif(p ->> 'description', ''),
    (p ->> 'assignee_user_id')::uuid, nullif(p ->> 'assignee_party', ''), (p ->> 'due_date')::date,
    coalesce(nullif(p ->> 'source_type', ''), 'walk'), (p ->> 'source_id')::uuid, auth.uid(), app.device_id());
  insert into public.snag_events (snag_id, project_id, action, to_status, comment, actor)
  values (v_id, p_project, 'create', 'open', nullif(p ->> 'description', ''), auth.uid());
  perform app.notify_user((p ->> 'assignee_user_id')::uuid, p_project, 'Snag assigned: ' || trim(p ->> 'title'),
    (p ->> 'number') || coalesce(' — due ' || to_char((p ->> 'due_date')::date, 'DD Mon'), ''), 'snag', v_id, v_sev = 'critical');
  if v_sev in ('high','critical') then
    perform app.notify_roles(p_project, '{site_engineer,office_engineer,coordinator}', initcap(v_sev) || ' snag ' || (p ->> 'number'),
      trim(p ->> 'title') || coalesce(' at ' || v_el.code, ''), 'snag', v_id, v_sev = 'critical');
  end if;
  return v_id;
end $$;

create or replace function public.save_snag(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  s public.snags;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  select * into s from public.snags where id = v_id for update;
  if not found then
    perform app.create_snag(p, v_project);
  else
    if s.project_id <> v_project then raise exception 'Snag belongs to another project'; end if;
    if s.status in ('closed','cancelled') then raise exception 'Snag % is % and cannot be edited', s.number, s.status; end if;
    if p ->> 'element_id' is not null and not exists (
        select 1 from public.elements where id = (p ->> 'element_id')::uuid and project_id = v_project) then
      raise exception 'Element does not belong to this project';
    end if;
    if p ->> 'assignee_user_id' is not null and not exists (
        select 1 from public.project_members where project_id = v_project and user_id = (p ->> 'assignee_user_id')::uuid) then
      raise exception 'Assignee is not a member of this project';
    end if;
    if coalesce(trim(p ->> 'title'), '') = '' then raise exception 'Snag title is required'; end if;
    update public.snags set
      element_id = (p ->> 'element_id')::uuid, location_text = nullif(p ->> 'location_text', ''),
      category = nullif(p ->> 'category', ''), trade = nullif(p ->> 'trade', ''),
      severity = coalesce(nullif(p ->> 'severity', ''), severity), title = trim(p ->> 'title'),
      description = nullif(p ->> 'description', ''), assignee_user_id = (p ->> 'assignee_user_id')::uuid,
      assignee_party = nullif(p ->> 'assignee_party', ''), due_date = (p ->> 'due_date')::date
    where id = v_id;
    insert into public.snag_events (snag_id, project_id, action, from_status, to_status, comment, actor)
    values (v_id, v_project, 'edit', s.status, s.status, null, auth.uid());
    if (p ->> 'assignee_user_id')::uuid is distinct from s.assignee_user_id then
      perform app.notify_user((p ->> 'assignee_user_id')::uuid, v_project, 'Snag assigned: ' || trim(p ->> 'title'),
        s.number, 'snag', v_id);
    end if;
  end if;
  return app.op_done(p, 'save_snag', jsonb_build_object('ok', true, 'id', v_id,
    'status', (select status from public.snags where id = v_id)));
end $$;

-- start: open/reopened → in_progress · ready: → ready_for_review · close: ready_for_review → closed
-- reopen: ready_for_review/closed → reopened · cancel: open/in_progress/reopened → cancelled
create or replace function public.snag_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_action text := p ->> 'action';
  v_comment text := nullif(trim(p ->> 'comment'), '');
  s public.snags;
  v_from text[]; v_to text;
  v_reviewer boolean;
begin
  if v_seen is not null then return v_seen; end if;
  select * into s from public.snags where id = (p ->> 'snag_id')::uuid for update;
  if not found then raise exception 'Snag not found'; end if;
  perform app.require_member(s.project_id);
  v_reviewer := app.has_role('office_engineer','coordinator','manager','admin');

  case v_action
  when 'start' then v_from := '{open,reopened}'; v_to := 'in_progress';
  when 'ready' then v_from := '{open,in_progress,reopened}'; v_to := 'ready_for_review';
  when 'close' then v_from := '{ready_for_review}'; v_to := 'closed';
  when 'reopen' then v_from := '{ready_for_review,closed}'; v_to := 'reopened';
  when 'cancel' then v_from := '{open,in_progress,reopened}'; v_to := 'cancelled';
  else raise exception 'Unknown snag action %', v_action;
  end case;

  if v_action in ('start','ready') then
    if not (v_reviewer or app.has_role('site_engineer') or s.assignee_user_id = auth.uid()) then
      raise exception 'Only the assignee or engineers can update this snag' using errcode = '42501';
    end if;
  else
    perform app.require_role('office_engineer','coordinator','manager','admin');
  end if;
  if v_action in ('reopen','cancel') and v_comment is null then
    raise exception 'A comment is required to % a snag', v_action;
  end if;
  if not (s.status = any (v_from)) then
    raise exception 'Snag % cannot be moved to % from status %', s.number, replace(v_to, '_', ' '), s.status;
  end if;

  update public.snags set status = v_to,
    closed_by = case when v_to = 'closed' then auth.uid() when v_to = 'reopened' then null else closed_by end,
    closed_at = case when v_to = 'closed' then now() when v_to = 'reopened' then null else closed_at end
  where id = s.id;
  insert into public.snag_events (snag_id, project_id, action, from_status, to_status, comment, actor)
  values (s.id, s.project_id, v_action, s.status, v_to, v_comment, auth.uid());

  if v_to = 'ready_for_review' then
    perform app.notify_roles(s.project_id, '{office_engineer}', 'Snag ready for review: ' || s.number, s.title, 'snag', s.id);
  else
    perform app.notify_user(coalesce(s.assignee_user_id, s.raised_by), s.project_id,
      'Snag ' || s.number || ': ' || replace(v_to, '_', ' '), coalesce(v_comment, s.title), 'snag', s.id);
    if s.assignee_user_id is not null and s.raised_by is distinct from s.assignee_user_id then
      perform app.notify_user(s.raised_by, s.project_id, 'Snag ' || s.number || ': ' || replace(v_to, '_', ' '),
        coalesce(v_comment, s.title), 'snag', s.id);
    end if;
  end if;
  return app.op_done(p, 'snag_action', jsonb_build_object('ok', true, 'id', s.id, 'status', v_to));
end $$;

-- =============================================================================
-- Inspections (C1)
-- =============================================================================

create or replace function public.save_checklist_template(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_project uuid := (p ->> 'project_id')::uuid;
  t public.checklist_templates;
  v_items jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  if v_project is null then
    perform app.require_role('coordinator','manager','admin');
  else
    perform app.require_member(v_project);
    perform app.require_role('office_engineer','coordinator','manager','admin');
  end if;
  if coalesce(trim(p ->> 'code'), '') = '' or coalesce(trim(p ->> 'name'), '') = '' then
    raise exception 'Template code and name are required';
  end if;
  v_items := app.with_defaults(p -> 'items', '{"item_type":"yes_no","photo_required":false,"is_critical":false}'::jsonb);
  if jsonb_array_length(v_items) = 0 then raise exception 'A checklist needs at least one item'; end if;
  select jsonb_agg(r || jsonb_build_object('seq', coalesce((r ->> 'seq')::int, (r ->> '_ord')::int))) into v_items
    from jsonb_array_elements(v_items) r;
  if exists (select 1 from jsonb_array_elements(v_items) r where coalesce(trim(r ->> 'text'), '') = '') then
    raise exception 'Every checklist item needs text';
  end if;

  select * into t from public.checklist_templates where id = v_id for update;
  if found then
    if t.project_id is distinct from v_project then raise exception 'Template belongs to another project'; end if;
    update public.checklist_templates set code = trim(p ->> 'code'), name = trim(p ->> 'name'),
      name_am = nullif(p ->> 'name_am', ''), description = nullif(p ->> 'description', ''),
      element_types = coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(p -> 'element_types') x), element_types),
      hold_activities = coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(p -> 'hold_activities') x), hold_activities),
      is_active = coalesce((p ->> 'is_active')::boolean, is_active),
      version = version + case when exists (select 1 from public.inspections where template_id = v_id) then 1 else 0 end
    where id = v_id;
  else
    insert into public.checklist_templates (id, project_id, code, name, name_am, description, element_types, hold_activities, is_active)
    values (v_id, v_project, trim(p ->> 'code'), trim(p ->> 'name'), nullif(p ->> 'name_am', ''), nullif(p ->> 'description', ''),
      coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(p -> 'element_types') x), '{}'),
      coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(p -> 'hold_activities') x), '{}'),
      coalesce((p ->> 'is_active')::boolean, true));
  end if;
  perform app.replace_children('checklist_template_items', 'template_id', v_id, v_project, v_items,
    array['seq','text','text_am','item_type','min_value','max_value','unit','photo_required','is_critical']);
  return app.op_done(p, 'save_checklist_template', jsonb_build_object('ok', true, 'id', v_id,
    'version', (select version from public.checklist_templates where id = v_id)));
end $$;

create or replace function app.validate_inspection(i public.inspections) returns void
language plpgsql stable security definer set search_path = public as $$
declare t public.checklist_templates; r public.inspections;
begin
  select * into t from public.checklist_templates where id = i.template_id and deleted_at is null;
  if not found or (t.project_id is not null and t.project_id <> i.project_id) then
    raise exception 'Checklist template not found for this project';
  end if;
  if not t.is_active then raise exception 'Checklist template % is inactive', t.code; end if;
  if not exists (select 1 from public.elements where id = i.element_id and project_id = i.project_id) then
    raise exception 'Element does not belong to this project';
  end if;
  if i.element_activity_id is not null and not exists (
      select 1 from public.element_activities where id = i.element_activity_id and element_id = i.element_id) then
    raise exception 'Activity does not belong to this element';
  end if;
  if i.reinspection_of is not null then
    select * into r from public.inspections where id = i.reinspection_of;
    if not found or r.element_id <> i.element_id or r.template_id <> i.template_id then
      raise exception 'A re-inspection must be for the same element and checklist';
    end if;
  end if;
end $$;

-- Clears a hold point once every checklist required for it has a passing
-- latest inspection. Returns {cleared, pending:[template names]}.
create or replace function app.try_clear_hold_point(p_activity uuid, p_inspection uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a public.element_activities;
  e public.elements;
  v_pending text[];
  v_number text;
begin
  select * into a from public.element_activities where id = p_activity for update;
  if not found or not a.is_hold_point then
    return jsonb_build_object('cleared', false, 'pending', '[]'::jsonb, 'hold_point', false);
  end if;
  if a.verified_pct >= 100 then return jsonb_build_object('cleared', true, 'pending', '[]'::jsonb, 'hold_point', true); end if;
  select * into e from public.elements where id = a.element_id;
  select coalesce(array_agg(t.name order by t.code), '{}') into v_pending
  from public.checklist_templates t
  where t.deleted_at is null and t.is_active and (t.project_id is null or t.project_id = a.project_id)
    and exists (select 1 from unnest(t.element_types) et where lower(et) = lower(e.element_type))
    and exists (select 1 from unnest(t.hold_activities) ha where lower(ha) = lower(a.name))
    and not coalesce((select ins.result in ('pass','conditional') from public.inspections ins
                      where ins.element_activity_id = a.id and ins.template_id = t.id and ins.status = 'completed'
                      order by ins.inspected_at desc, ins.created_at desc limit 1), false);
  if cardinality(v_pending) > 0 then
    return jsonb_build_object('cleared', false, 'pending', to_jsonb(v_pending), 'hold_point', true);
  end if;

  select number into v_number from public.inspections where id = p_inspection;
  update public.element_activities set verified_pct = 100, reported_pct = 100 where id = a.id;
  insert into public.progress_updates (id, project_id, element_id, element_activity_id, report_date, pct_complete,
    remarks, status, reported_by, verified_by, verified_at, verified_pct, verify_comment)
  values (gen_random_uuid(), a.project_id, a.element_id, a.id, app.local_date(now()), 100,
    'Hold point passed — inspection ' || v_number, 'verified', auth.uid(), auth.uid(), now(), 100, 'Inspection ' || v_number);
  perform app.refresh_element_progress(a.element_id);
  perform app.notify_roles(a.project_id, '{site_engineer}', 'Hold point cleared: ' || e.code,
    a.name || ' passed (' || v_number || ')', 'inspection', p_inspection);
  return jsonb_build_object('cleared', true, 'pending', '[]'::jsonb, 'hold_point', true);
end $$;

-- Site engineer asks for a hold-point inspection.
create or replace function public.request_inspection(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_project uuid := (p ->> 'project_id')::uuid;
  i public.inspections;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  insert into public.inspections (id, project_id, number, template_id, element_id, element_activity_id, status,
    requested_by, requested_at, requested_for, remarks, reinspection_of, device_id)
  values ((p ->> 'id')::uuid, v_project, p ->> 'number', (p ->> 'template_id')::uuid, (p ->> 'element_id')::uuid,
    (p ->> 'element_activity_id')::uuid, 'requested', auth.uid(), now(), (p ->> 'requested_for')::timestamptz,
    nullif(p ->> 'remarks', ''), (p ->> 'reinspection_of')::uuid, app.device_id())
  returning * into i;
  perform app.validate_inspection(i);
  perform app.notify_roles(v_project, '{office_engineer,coordinator}', 'Inspection requested: ' || i.number,
    (select t.name || ' — ' || e.code from public.checklist_templates t, public.elements e
      where t.id = i.template_id and e.id = i.element_id), 'inspection', i.id);
  return app.op_done(p, 'request_inspection', jsonb_build_object('ok', true, 'id', i.id, 'status', i.status));
end $$;

create or replace function public.submit_inspection(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid;
  i public.inspections;
  t public.checklist_templates;
  ti public.checklist_template_items;
  x jsonb;
  v_resp text; v_val numeric; v_snag uuid; v_snags uuid[] := '{}';
  v_any_fail boolean := false; v_crit_fail boolean := false;
  v_result text; v_hold jsonb := '{"cleared":false,"pending":[],"hold_point":false}'::jsonb;
  v_n int := 0; v_code text;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_role('office_engineer','coordinator','manager','admin');
  select * into i from public.inspections where id = v_id for update;
  if found then
    perform app.require_member(i.project_id);
    if i.status <> 'requested' then raise exception 'Inspection % is already %', i.number, i.status; end if;
  else
    v_project := (p ->> 'project_id')::uuid;
    perform app.require_member(v_project);
    insert into public.inspections (id, project_id, number, template_id, element_id, element_activity_id, status,
      requested_by, requested_at, reinspection_of, device_id)
    values (v_id, v_project, p ->> 'number', (p ->> 'template_id')::uuid, (p ->> 'element_id')::uuid,
      (p ->> 'element_activity_id')::uuid, 'requested', auth.uid(), now(), (p ->> 'reinspection_of')::uuid, app.device_id())
    returning * into i;
    perform app.validate_inspection(i);
  end if;
  v_project := i.project_id;
  select * into t from public.checklist_templates where id = i.template_id;
  select code into v_code from public.elements where id = i.element_id;

  for ti in select * from public.checklist_template_items where template_id = i.template_id and deleted_at is null order by seq loop
    v_n := v_n + 1;
    select value into x from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb))
      where (value ->> 'template_item_id')::uuid = ti.id limit 1;
    if x is null then raise exception 'Item % "%": a response is required', ti.seq, ti.text; end if;
    v_resp := nullif(x ->> 'response', '');
    v_val := (x ->> 'value_num')::numeric;
    if ti.item_type = 'value' and v_resp is distinct from 'na' then
      if v_val is null then raise exception 'Item % "%": a measured value is required', ti.seq, ti.text; end if;
      v_resp := case when (ti.min_value is null or v_val >= ti.min_value) and (ti.max_value is null or v_val <= ti.max_value)
                     then 'pass' else 'fail' end;
    elsif ti.item_type = 'text' and v_resp is null then
      v_resp := case when nullif(trim(x ->> 'value_text'), '') is null then 'na' else 'pass' end;
    end if;
    if v_resp is null or v_resp not in ('pass','fail','na') then
      raise exception 'Item % "%": response must be pass, fail or na', ti.seq, ti.text;
    end if;
    if v_resp = 'na' and ti.is_critical then
      raise exception 'Item % "%" is critical and cannot be marked N/A', ti.seq, ti.text;
    end if;

    v_snag := null;
    if v_resp = 'fail' then
      v_any_fail := true;
      v_crit_fail := v_crit_fail or ti.is_critical;
      if ti.is_critical or coalesce((x ->> 'create_snag')::boolean, false) then
        v_snag := app.create_snag(jsonb_build_object(
          'id', coalesce(x ->> 'snag_id', gen_random_uuid()::text),
          'number', coalesce(nullif(x ->> 'snag_number', ''), i.number || '-S' || ti.seq),
          'element_id', i.element_id,
          'severity', case when ti.is_critical then 'high' else 'medium' end,
          'category', 'quality',
          'trade', p -> 'snag_defaults' ->> 'trade',
          'title', ti.text || ' — failed (' || t.code || ')',
          'description', concat_ws(' · ', 'Inspection ' || i.number, 'Value ' || v_val || coalesce(' ' || ti.unit, ''),
                                   nullif(trim(x ->> 'value_text'), '')),
          'assignee_user_id', p -> 'snag_defaults' ->> 'assignee_user_id',
          'assignee_party', p -> 'snag_defaults' ->> 'assignee_party',
          'due_date', p -> 'snag_defaults' ->> 'due_date',
          'source_type', 'inspection', 'source_id', i.id), v_project);
        v_snags := v_snags || v_snag;
      end if;
    end if;
    insert into public.inspection_items (id, inspection_id, project_id, template_item_id, seq, text, item_type, is_critical,
      response, value_num, value_text, snag_id)
    values (coalesce((x ->> 'id')::uuid, gen_random_uuid()), i.id, v_project, ti.id, ti.seq, ti.text, ti.item_type,
      ti.is_critical, v_resp, v_val, nullif(trim(x ->> 'value_text'), ''), v_snag);
  end loop;
  if v_n = 0 then raise exception 'Checklist % has no items', t.code; end if;

  v_result := case when v_crit_fail then 'fail' when v_any_fail then 'conditional' else 'pass' end;
  update public.inspections set status = 'completed', result = v_result, template_version = t.version,
    inspector_id = auth.uid(), inspected_at = coalesce((p ->> 'inspected_at')::timestamptz, now()),
    consultant_name = nullif(p ->> 'consultant_name', ''), remarks = coalesce(nullif(p ->> 'remarks', ''), remarks)
  where id = i.id;

  if v_result <> 'fail' and i.element_activity_id is not null then
    v_hold := app.try_clear_hold_point(i.element_activity_id, i.id);
  end if;

  perform app.notify_user(i.requested_by, v_project, 'Inspection ' || i.number || ': ' || v_result,
    t.name || ' — ' || v_code, 'inspection', i.id, v_result = 'fail');
  if v_result = 'fail' then
    perform app.notify_roles(v_project, '{site_engineer}', 'Inspection failed: ' || v_code,
      t.name || ' (' || i.number || ') — ' || cardinality(v_snags) || ' snag(s) raised', 'inspection', i.id);
  end if;
  return app.op_done(p, 'submit_inspection', jsonb_build_object('ok', true, 'id', i.id, 'result', v_result,
    'hold_point_cleared', (v_hold ->> 'cleared')::boolean, 'pending_checklists', v_hold -> 'pending',
    'snag_ids', to_jsonb(v_snags)));
end $$;

create or replace function public.cancel_inspection(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); i public.inspections;
begin
  if v_seen is not null then return v_seen; end if;
  select * into i from public.inspections where id = (p ->> 'inspection_id')::uuid for update;
  if not found then raise exception 'Inspection not found'; end if;
  perform app.require_member(i.project_id);
  if i.requested_by is distinct from auth.uid() and not app.has_role('office_engineer','coordinator','manager','admin') then
    raise exception 'Only the requester or reviewers can cancel this inspection' using errcode = '42501';
  end if;
  if i.status <> 'requested' then raise exception 'Only requested inspections can be cancelled'; end if;
  update public.inspections set status = 'cancelled', remarks = coalesce(nullif(p ->> 'comment', ''), remarks) where id = i.id;
  return app.op_done(p, 'cancel_inspection', jsonb_build_object('ok', true, 'id', i.id, 'status', 'cancelled'));
end $$;

-- =============================================================================
-- Site diary RPCs (B1)
-- =============================================================================

create or replace function public.save_site_diary(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  v_date date := (p ->> 'diary_date')::date;
  v_block uuid := (p ->> 'block_id')::uuid;
  v_submit boolean := coalesce((p ->> 'submit')::boolean, false);
  d public.site_diaries;
  v_other uuid;
  v_status text;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  if v_date is null then raise exception 'Diary date is required'; end if;
  if v_date > app.local_date(now()) then raise exception 'A diary cannot be written for a future date'; end if;
  if v_block is not null and not exists (select 1 from public.blocks where id = v_block and project_id = v_project) then
    raise exception 'Block does not belong to this project';
  end if;

  select id into v_other from public.site_diaries
    where project_id = v_project and block_id is not distinct from v_block and diary_date = v_date and id <> v_id;
  select * into d from public.site_diaries where id = v_id for update;

  if not found then
    if v_other is not null then
      -- One diary per project/block/day: the client offers "append as addendum".
      return app.op_done(p, 'save_site_diary', jsonb_build_object('ok', false, 'conflict', 'exists', 'existing_id', v_other,
        'existing_number', (select number from public.site_diaries where id = v_other)));
    end if;
    insert into public.site_diaries (id, project_id, number, diary_date, block_id, weather_am, weather_pm, rain_hours,
      temp_min, temp_max, weather_source, work_summary, safety_notes, notes, created_by, device_id)
    values (v_id, v_project, p ->> 'number', v_date, v_block, nullif(p ->> 'weather_am', ''), nullif(p ->> 'weather_pm', ''),
      (p ->> 'rain_hours')::numeric, (p ->> 'temp_min')::numeric, (p ->> 'temp_max')::numeric,
      coalesce(nullif(p ->> 'weather_source', ''), 'manual'), nullif(p ->> 'work_summary', ''),
      nullif(p ->> 'safety_notes', ''), nullif(p ->> 'notes', ''), auth.uid(), app.device_id());
  else
    if d.project_id <> v_project then raise exception 'Diary belongs to another project'; end if;
    if d.status = 'signed' then
      raise exception 'Site diary % is signed and cannot be changed; add an addendum instead', d.number;
    end if;
    if d.created_by <> auth.uid() and not app.has_role('office_engineer','coordinator','manager','admin') then
      raise exception 'Only the author can edit this diary' using errcode = '42501';
    end if;
    if v_other is not null then raise exception 'Another diary already exists for this project/block on %', v_date; end if;
    update public.site_diaries set diary_date = v_date, block_id = v_block,
      weather_am = nullif(p ->> 'weather_am', ''), weather_pm = nullif(p ->> 'weather_pm', ''),
      rain_hours = (p ->> 'rain_hours')::numeric, temp_min = (p ->> 'temp_min')::numeric, temp_max = (p ->> 'temp_max')::numeric,
      weather_source = coalesce(nullif(p ->> 'weather_source', ''), 'manual'), work_summary = nullif(p ->> 'work_summary', ''),
      safety_notes = nullif(p ->> 'safety_notes', ''), notes = nullif(p ->> 'notes', ''),
      version = version + 1,
      status = case when status = 'submitted' and not v_submit then 'draft' else status end
    where id = v_id;
  end if;

  if p ? 'labour' then
    perform app.replace_children('diary_labour', 'diary_id', v_id, v_project, p -> 'labour',
      array['trade_id','trade_name','subcontractor','headcount','hours']);
  end if;
  if p ? 'equipment' then
    perform app.replace_children('diary_equipment', 'diary_id', v_id, v_project,
      app.with_defaults(p -> 'equipment', '{"qty":1,"status":"working"}'::jsonb),
      array['equipment','qty','hours_worked','hours_idle','idle_reason','status','note']);
  end if;
  if p ? 'delays' then
    perform app.replace_children('diary_delays', 'diary_id', v_id, v_project, p -> 'delays',
      array['cause','hours_lost','element_id','description']);
  end if;
  if p ? 'visitors' then
    perform app.replace_children('diary_visitors', 'diary_id', v_id, v_project, p -> 'visitors',
      array['name','organisation','purpose','time_in','time_out']);
  end if;
  if p ? 'instructions' then
    perform app.replace_children('diary_instructions', 'diary_id', v_id, v_project, p -> 'instructions',
      array['given_by','organisation','instruction','element_id']);
  end if;
  if p ? 'elements' then
    perform app.replace_children('diary_elements', 'diary_id', v_id, v_project, p -> 'elements',
      array['element_id','note']);
  end if;
  if exists (select 1 from public.diary_delays x join public.elements e on e.id = x.element_id
             where x.diary_id = v_id and e.project_id <> v_project
             union all
             select 1 from public.diary_instructions x join public.elements e on e.id = x.element_id
             where x.diary_id = v_id and e.project_id <> v_project
             union all
             select 1 from public.diary_elements x join public.elements e on e.id = x.element_id
             where x.diary_id = v_id and e.project_id <> v_project) then
    raise exception 'Diary references an element of another project';
  end if;

  if v_submit then
    select * into d from public.site_diaries where id = v_id;
    if d.status = 'draft' then
      if d.weather_am is null and d.weather_pm is null then raise exception 'Record the weather before submitting'; end if;
      if d.work_summary is null and not exists (select 1 from public.diary_labour where diary_id = v_id and deleted_at is null) then
        raise exception 'Record the work done or the labour on site before submitting';
      end if;
      update public.site_diaries set status = 'submitted', submitted_at = now() where id = v_id;
      perform app.notify_roles(v_project, '{office_engineer,coordinator}', 'Site diary to sign: ' || d.number,
        to_char(d.diary_date, 'DD Mon YYYY'), 'site_diary', v_id);
    end if;
  end if;

  select status into v_status from public.site_diaries where id = v_id;
  return app.op_done(p, 'save_site_diary', jsonb_build_object('ok', true, 'id', v_id, 'status', v_status));
end $$;

create or replace function public.sign_site_diary(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_approve boolean := coalesce((p ->> 'approve')::boolean, true);
  v_comment text := nullif(trim(p ->> 'comment'), '');
  d public.site_diaries;
  v_to text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into d from public.site_diaries where id = (p ->> 'diary_id')::uuid for update;
  if not found then raise exception 'Site diary not found'; end if;
  perform app.require_member(d.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if d.status <> 'submitted' then raise exception 'Only submitted diaries can be signed (status: %)', d.status; end if;
  if d.created_by = auth.uid() and not app.has_role('admin') then
    raise exception 'The author cannot sign their own diary' using errcode = '42501';
  end if;
  if not v_approve and v_comment is null then raise exception 'Say what needs correcting when returning a diary'; end if;
  v_to := case when v_approve then 'signed' else 'draft' end;
  update public.site_diaries set status = v_to,
    signed_by = case when v_approve then auth.uid() end, signed_at = case when v_approve then now() end,
    sign_comment = v_comment
  where id = d.id;
  perform app.notify_user(d.created_by, d.project_id, 'Site diary ' || d.number || (case when v_approve then ' signed' else ' returned' end),
    v_comment, 'site_diary', d.id);
  return app.op_done(p, 'sign_site_diary', jsonb_build_object('ok', true, 'id', d.id, 'status', v_to));
end $$;

create or replace function public.add_diary_addendum(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); d public.site_diaries;
begin
  if v_seen is not null then return v_seen; end if;
  select * into d from public.site_diaries where id = (p ->> 'diary_id')::uuid;
  if not found then raise exception 'Site diary not found'; end if;
  perform app.require_member(d.project_id);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  if coalesce(trim(p ->> 'text'), '') = '' then raise exception 'Addendum text is required'; end if;
  insert into public.diary_addenda (id, diary_id, project_id, text, created_by)
  values ((p ->> 'id')::uuid, d.id, d.project_id, trim(p ->> 'text'), auth.uid());
  if d.status = 'signed' then
    perform app.notify_user(d.signed_by, d.project_id, 'Addendum to signed diary ' || d.number, left(trim(p ->> 'text'), 120),
      'site_diary', d.id);
  end if;
  return app.op_done(p, 'add_diary_addendum', jsonb_build_object('ok', true, 'id', (p ->> 'id')::uuid, 'diary_id', d.id));
end $$;

-- =============================================================================
-- Concrete pours (C3)
-- =============================================================================

create or replace function public.save_mix_design(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  v_source text := coalesce(nullif(p ->> 'source', ''), 'ready_mix');
  v_fck numeric := coalesce((p ->> 'target_strength_mpa')::numeric, app.grade_cube_strength(p ->> 'grade'));
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if coalesce(trim(p ->> 'grade'), '') = '' then raise exception 'Concrete grade is required'; end if;
  if v_fck is null then raise exception 'Target (characteristic cube) strength is required'; end if;
  if v_source = 'ready_mix' and p ->> 'material_spec_id' is null then
    raise exception 'A ready-mix design needs the concrete material/grade it is received as';
  end if;
  if exists (select 1 from public.pours where mix_design_id = v_id) then
    raise exception 'Mix design is used by pours; create a new mix design instead of editing it';
  end if;
  insert into public.mix_designs (id, project_id, code, grade, source, material_spec_id, target_strength_mpa, cement_spec_id,
    cement_kg_per_m3, water_cement_ratio, sand_m3_per_m3, aggregate_m3_per_m3, target_slump_mm, slump_tolerance_mm, remarks)
  values (v_id, v_project, coalesce(nullif(trim(p ->> 'code'), ''), trim(p ->> 'grade')), trim(p ->> 'grade'), v_source,
    (p ->> 'material_spec_id')::uuid, v_fck, (p ->> 'cement_spec_id')::uuid, (p ->> 'cement_kg_per_m3')::numeric,
    (p ->> 'water_cement_ratio')::numeric, (p ->> 'sand_m3_per_m3')::numeric, (p ->> 'aggregate_m3_per_m3')::numeric,
    (p ->> 'target_slump_mm')::int, coalesce((p ->> 'slump_tolerance_mm')::int, 25), nullif(p ->> 'remarks', ''))
  on conflict (id) do update set code = excluded.code, grade = excluded.grade, source = excluded.source,
    material_spec_id = excluded.material_spec_id, target_strength_mpa = excluded.target_strength_mpa,
    cement_spec_id = excluded.cement_spec_id, cement_kg_per_m3 = excluded.cement_kg_per_m3,
    water_cement_ratio = excluded.water_cement_ratio, sand_m3_per_m3 = excluded.sand_m3_per_m3,
    aggregate_m3_per_m3 = excluded.aggregate_m3_per_m3, target_slump_mm = excluded.target_slump_mm,
    slump_tolerance_mm = excluded.slump_tolerance_mm, remarks = excluded.remarks, deleted_at = null
  where public.mix_designs.project_id = v_project;
  return app.op_done(p, 'save_mix_design', jsonb_build_object('ok', true, 'id', v_id));
end $$;

-- Hold points before casting must be cleared for every element of the pour.
create or replace function app.require_pour_hold_points(p_pour uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v record; v_enforce boolean;
begin
  select coalesce(s.enforce_hold_points, true) into v_enforce
    from public.pours p left join public.project_settings s on s.project_id = p.project_id where p.id = p_pour;
  if not coalesce(v_enforce, true) then return; end if;
  select e.code, a.name into v
  from public.pour_elements pe
  join public.elements e on e.id = pe.element_id
  join public.element_activities a on a.element_id = pe.element_id and a.is_hold_point and a.verified_pct < 100
  where pe.pour_id = p_pour and pe.deleted_at is null
    and a.seq < coalesce((select min(c.seq) from public.element_activities c
                          where c.element_id = pe.element_id and (c.name ilike 'cast%' or c.name ilike 'concret%')), 2147483647)
  order by e.code, a.seq limit 1;
  if found then
    raise exception 'Hold point "%" on element % must pass inspection before pouring', v.name, v.code;
  end if;
end $$;

create or replace function public.save_pour(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  v_method text := p ->> 'method';
  md public.mix_designs;
  pr public.pours;
  v_els jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  select * into md from public.mix_designs where id = (p ->> 'mix_design_id')::uuid and project_id = v_project and deleted_at is null;
  if not found then raise exception 'Mix design not found in this project'; end if;
  if v_method is null then v_method := case when md.source = 'site' then 'site_batched' else 'ready_mix' end; end if;
  if v_method = 'ready_mix' and md.material_spec_id is null then
    raise exception 'Mix design % has no concrete material/grade for ready-mix receipt', md.code;
  end if;
  if p ->> 'store_id' is not null then perform app.require_store(v_project, (p ->> 'store_id')::uuid); end if;
  if p ->> 'mr_id' is not null and not exists (select 1 from public.material_requests where id = (p ->> 'mr_id')::uuid and project_id = v_project) then
    raise exception 'Request not found in this project';
  end if;
  if coalesce((p ->> 'planned_m3')::numeric, 0) <= 0 then raise exception 'Planned volume is required'; end if;
  v_els := coalesce(p -> 'elements', '[]'::jsonb);
  if jsonb_array_length(v_els) = 0 then raise exception 'A pour needs at least one element'; end if;
  if exists (select 1 from jsonb_array_elements(v_els) x left join public.elements e on e.id = (x ->> 'element_id')::uuid
             where e.id is null or e.project_id <> v_project) then
    raise exception 'Pour element does not belong to this project';
  end if;
  if (select count(distinct x ->> 'element_id') from jsonb_array_elements(v_els) x) <> jsonb_array_length(v_els) then
    raise exception 'An element is listed twice in the pour';
  end if;

  select * into pr from public.pours where id = v_id for update;
  if found then
    if pr.project_id <> v_project then raise exception 'Pour belongs to another project'; end if;
    if pr.status not in ('planned','in_progress') then raise exception 'Pour % is % and cannot be edited', pr.number, pr.status; end if;
    if exists (select 1 from public.pour_issues where pour_id = v_id) or exists (select 1 from public.pour_batches where pour_id = v_id)
       or exists (select 1 from public.pour_trucks where pour_id = v_id) then
      if pr.mix_design_id <> md.id or pr.method <> v_method then
        raise exception 'Mix design and method cannot change after concrete has been recorded';
      end if;
      if exists (select 1 from public.pour_elements pe where pe.pour_id = v_id and pe.deleted_at is null
                 and not exists (select 1 from jsonb_array_elements(v_els) x where (x ->> 'element_id')::uuid = pe.element_id))
         or exists (select 1 from jsonb_array_elements(v_els) x where not exists (
                 select 1 from public.pour_elements pe where pe.pour_id = v_id and pe.deleted_at is null
                 and pe.element_id = (x ->> 'element_id')::uuid)) then
        raise exception 'Elements cannot change after concrete has been recorded';
      end if;
    end if;
    update public.pours set pour_date = (p ->> 'pour_date')::date, mix_design_id = md.id, method = v_method,
      supplier_id = (p ->> 'supplier_id')::uuid, supplier_name = nullif(p ->> 'supplier_name', ''),
      store_id = (p ->> 'store_id')::uuid, mr_id = (p ->> 'mr_id')::uuid, planned_m3 = (p ->> 'planned_m3')::numeric,
      weather = nullif(p ->> 'weather', ''), curing_method = nullif(p ->> 'curing_method', ''), remarks = nullif(p ->> 'remarks', '')
    where id = v_id;
  else
    insert into public.pours (id, project_id, number, pour_date, mix_design_id, method, supplier_id, supplier_name, store_id,
      mr_id, planned_m3, weather, curing_method, remarks, created_by, device_id)
    values (v_id, v_project, p ->> 'number', coalesce((p ->> 'pour_date')::date, app.local_date(now())), md.id, v_method,
      (p ->> 'supplier_id')::uuid, nullif(p ->> 'supplier_name', ''), (p ->> 'store_id')::uuid, (p ->> 'mr_id')::uuid,
      (p ->> 'planned_m3')::numeric, nullif(p ->> 'weather', ''), nullif(p ->> 'curing_method', ''),
      nullif(p ->> 'remarks', ''), auth.uid(), app.device_id());
  end if;
  -- elements whose ids changed but element is the same keep their row
  select jsonb_agg(x || jsonb_build_object('id', coalesce(
           (select pe.id::text from public.pour_elements pe where pe.pour_id = v_id and pe.element_id = (x ->> 'element_id')::uuid limit 1),
           x ->> 'id'))) into v_els
    from jsonb_array_elements(v_els) x;
  perform app.replace_children('pour_elements', 'pour_id', v_id, v_project, v_els, array['element_id','planned_m3']);
  return app.op_done(p, 'save_pour', jsonb_build_object('ok', true, 'id', v_id,
    'status', (select status from public.pours where id = v_id)));
end $$;

-- Issue materials to a pour's elements, split pro-rata by planned m³.
-- With an approved request on the pour this goes through public.post_miv
-- (approved balances, BR-01); otherwise the pour itself authorises the issue
-- and the same MIV/ledger rows are written directly.
create or replace function app.pour_issue(pr public.pours, p_store uuid, p_miv uuid, p_number text, p_lines jsonb,
  p_at timestamptz, p_remarks text, p_truck uuid default null, p_grn uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_cnt int; v_total numeric; v_out jsonb := '[]'::jsonb;
  l jsonb; el record; v_i int; v_alloc numeric; v_rem numeric; v_qty numeric; v_spec uuid; v_mrline uuid; o jsonb; v_n int := 0;
begin
  if coalesce(p_number, '') = '' then raise exception 'An MIV number is required'; end if;
  perform app.require_store(pr.project_id, p_store);
  select count(*), coalesce(sum(coalesce(planned_m3, 0)), 0) into v_cnt, v_total
    from public.pour_elements where pour_id = pr.id and deleted_at is null;
  if v_cnt = 0 then raise exception 'Pour % has no elements', pr.number; end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_spec := (l ->> 'material_spec_id')::uuid;
    v_qty := (l ->> 'qty')::numeric;
    if v_spec is null or coalesce(v_qty, 0) <= 0 then raise exception 'Each issue line needs a material and a quantity'; end if;
    v_mrline := null;
    if pr.mr_id is not null then
      select id into v_mrline from public.mr_lines where mr_id = pr.mr_id and material_spec_id = v_spec and deleted_at is null
        order by line_no limit 1;
      if v_mrline is null then
        raise exception 'Request on pour % has no line for %', pr.number, app.spec_label(v_spec);
      end if;
    end if;
    v_rem := v_qty; v_i := 0;
    for el in select element_id, planned_m3 from public.pour_elements where pour_id = pr.id and deleted_at is null order by element_id loop
      v_i := v_i + 1;
      v_alloc := case when v_i = v_cnt then v_rem
                      else round(v_qty * case when v_total > 0 then coalesce(el.planned_m3, 0) / v_total else 1.0 / v_cnt end, 3) end;
      v_rem := v_rem - v_alloc;
      if v_alloc > 0 then
        v_out := v_out || jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'material_spec_id', v_spec,
          'element_id', el.element_id, 'qty', v_alloc, 'mr_line_id', v_mrline, 'batch_no', nullif(l ->> 'batch_no', '')));
      end if;
    end loop;
  end loop;
  if jsonb_array_length(v_out) = 0 then raise exception 'Nothing to issue'; end if;

  if pr.mr_id is not null then
    perform public.post_miv(jsonb_build_object('id', p_miv, 'project_id', pr.project_id, 'store_id', p_store,
      'number', p_number, 'mr_id', pr.mr_id, 'issued_to', pr.created_by, 'issued_at', p_at, 'remarks', p_remarks,
      'lines', v_out));
  else
    perform app.require_role('store_keeper','coordinator','manager','admin');
    insert into public.mivs (id, project_id, number, store_id, mr_id, issued_to, issued_by, issued_at, status,
      acknowledged_at, is_emergency, remarks, device_id)
    values (p_miv, pr.project_id, p_number, p_store, null, pr.created_by, auth.uid(), p_at, 'acknowledged', now(), false,
      p_remarks, app.device_id());
    for o in select * from jsonb_array_elements(v_out) loop
      v_n := v_n + 1;
      perform app.require_stock(p_store, (o ->> 'material_spec_id')::uuid, (o ->> 'qty')::numeric);
      insert into public.miv_lines (id, miv_id, project_id, line_no, material_spec_id, element_id, qty, batch_no)
      values ((o ->> 'id')::uuid, p_miv, pr.project_id, v_n, (o ->> 'material_spec_id')::uuid, (o ->> 'element_id')::uuid,
        (o ->> 'qty')::numeric, o ->> 'batch_no');
      perform app.post_ledger(pr.project_id, p_store, (o ->> 'material_spec_id')::uuid, -(o ->> 'qty')::numeric, 'available',
        'miv', 'miv', p_miv, p_number, (o ->> 'id')::uuid, (o ->> 'element_id')::uuid, null, o ->> 'batch_no', p_at);
    end loop;
  end if;
  -- Concrete placed in the element is received by the pour itself.
  update public.mivs set status = 'acknowledged', acknowledged_at = coalesce(acknowledged_at, now())
    where id = p_miv and status = 'pending_ack';
  insert into public.pour_issues (project_id, pour_id, miv_id, grn_id, truck_id)
  values (pr.project_id, pr.id, p_miv, p_grn, p_truck);
end $$;

-- Posts an accepted ready-mix truck: GRN into the pour's store (public.post_grn)
-- and MIV of the same volume to the pour's elements, in one transaction.
create or replace function app.post_pour_truck(p_truck uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t public.pour_trucks; pr public.pours; md public.mix_designs;
  v_store uuid; v_at timestamptz;
  v_grn uuid := coalesce((p ->> 'grn_id')::uuid, gen_random_uuid());
  v_miv uuid := coalesce((p ->> 'miv_id')::uuid, gen_random_uuid());
begin
  perform app.require_role('store_keeper','coordinator','manager','admin');
  select * into t from public.pour_trucks where id = p_truck for update;
  select * into pr from public.pours where id = t.pour_id;
  select * into md from public.mix_designs where id = pr.mix_design_id;
  v_store := coalesce((p ->> 'store_id')::uuid, pr.store_id);
  if v_store is null then raise exception 'Choose the store that receives the ready-mix concrete'; end if;
  if coalesce(p ->> 'grn_number', '') = '' or coalesce(p ->> 'miv_number', '') = '' then
    raise exception 'GRN and MIV numbers are required to post an accepted truck';
  end if;
  v_at := coalesce(t.discharge_start, t.arrived_at, now());
  perform public.post_grn(jsonb_build_object('id', v_grn, 'project_id', pr.project_id, 'store_id', v_store,
    'number', p ->> 'grn_number', 'supplier_id', pr.supplier_id, 'supplier_name', coalesce(t.supplier_name, pr.supplier_name),
    'delivery_note_no', t.ticket_no, 'vehicle_plate', t.truck_plate, 'received_at', v_at,
    'remarks', 'Ready-mix ticket ' || t.ticket_no || ' for pour ' || pr.number,
    'lines', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'material_spec_id', md.material_spec_id,
      'qty_delivered', t.volume_m3, 'batch_no', t.ticket_no))));
  perform app.pour_issue(pr, v_store, v_miv, p ->> 'miv_number',
    jsonb_build_array(jsonb_build_object('material_spec_id', md.material_spec_id, 'qty', t.volume_m3, 'batch_no', t.ticket_no)),
    v_at, 'Ready-mix ticket ' || t.ticket_no || ' placed in pour ' || pr.number, t.id, v_grn);
  update public.pour_trucks set status = 'posted', grn_id = v_grn, miv_id = v_miv, received_by = auth.uid() where id = t.id;
  return jsonb_build_object('grn_id', v_grn, 'miv_id', v_miv);
end $$;

create or replace function app.start_pour(p_pour uuid, p_at timestamptz) returns void
language sql security definer set search_path = public as $$
  update public.pours set status = 'in_progress', start_at = coalesce(start_at, p_at, now())
  where id = p_pour and status = 'planned';
$$;

create or replace function public.add_pour_truck(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  pr public.pours; md public.mix_designs;
  v_accepted boolean := (p ->> 'accepted')::boolean;
  v_warn text[] := '{}';
  v_batched timestamptz := (p ->> 'batched_at')::timestamptz;
  v_arrived timestamptz := (p ->> 'arrived_at')::timestamptz;
  v_slump int := (p ->> 'slump_mm')::int;
  v_status text;
  v_post jsonb := '{}'::jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  select * into pr from public.pours where id = (p ->> 'pour_id')::uuid for update;
  if not found then raise exception 'Pour not found'; end if;
  perform app.require_member(pr.project_id);
  perform app.require_role('site_engineer','store_keeper','office_engineer','coordinator','manager','admin');
  if pr.method <> 'ready_mix' then raise exception 'Pour % is site-batched; record batches instead of trucks', pr.number; end if;
  if pr.status not in ('planned','in_progress') then raise exception 'Pour % is %', pr.number, pr.status; end if;
  if v_accepted is null then raise exception 'Say whether the truck was accepted or rejected'; end if;
  if coalesce(trim(p ->> 'ticket_no'), '') = '' then raise exception 'Batch ticket number is required'; end if;
  if coalesce((p ->> 'volume_m3')::numeric, 0) <= 0 then raise exception 'Truck volume is required'; end if;
  if not v_accepted and coalesce(trim(p ->> 'reject_reason'), '') = '' then raise exception 'A reason is required to reject a truck'; end if;
  if v_accepted then perform app.require_pour_hold_points(pr.id); end if;
  select * into md from public.mix_designs where id = pr.mix_design_id;

  if v_batched is not null and v_arrived is not null and v_arrived - v_batched > interval '90 minutes' then
    v_warn := v_warn || 'late_arrival'::text;
  end if;
  if coalesce((p ->> 'water_added_l')::numeric, 0) > 0 then v_warn := v_warn || 'water_added'::text; end if;
  if v_slump is not null and md.target_slump_mm is not null and abs(v_slump - md.target_slump_mm) > md.slump_tolerance_mm then
    v_warn := v_warn || 'slump_out_of_range'::text;
  end if;
  if coalesce((p ->> 'concrete_temp_c')::numeric, 0) > 32 then v_warn := v_warn || 'hot_concrete'::text; end if;

  v_status := case when not v_accepted then 'rejected' else 'awaiting_receipt' end;
  insert into public.pour_trucks (id, pour_id, project_id, seq, ticket_no, supplier_name, truck_plate, volume_m3, batched_at,
    arrived_at, discharge_start, discharge_end, slump_mm, concrete_temp_c, water_added_l, accepted, reject_reason, status,
    warnings, recorded_by)
  values (v_id, pr.id, pr.project_id,
    coalesce((p ->> 'seq')::int, (select coalesce(max(seq), 0) + 1 from public.pour_trucks where pour_id = pr.id)),
    trim(p ->> 'ticket_no'), nullif(p ->> 'supplier_name', ''), nullif(p ->> 'truck_plate', ''), (p ->> 'volume_m3')::numeric,
    v_batched, v_arrived, (p ->> 'discharge_start')::timestamptz, (p ->> 'discharge_end')::timestamptz, v_slump,
    (p ->> 'concrete_temp_c')::numeric, (p ->> 'water_added_l')::numeric, v_accepted, nullif(trim(p ->> 'reject_reason'), ''),
    v_status, v_warn, auth.uid());
  perform app.start_pour(pr.id, coalesce((p ->> 'discharge_start')::timestamptz, v_arrived));

  if v_accepted then
    if app.has_role('store_keeper','coordinator','manager','admin') then
      v_post := app.post_pour_truck(v_id, p);
      v_status := 'posted';
    else
      perform app.notify_roles(pr.project_id, '{store_keeper}', 'Ready-mix truck to receive: ' || (p ->> 'ticket_no'),
        (p ->> 'volume_m3') || ' m³ for pour ' || pr.number, 'pour_truck', v_id);
    end if;
  end if;
  return app.op_done(p, 'add_pour_truck', jsonb_build_object('ok', true, 'id', v_id, 'status', v_status,
    'warnings', to_jsonb(v_warn)) || v_post);
end $$;

-- Store keeper posts a truck recorded by the site engineer.
create or replace function public.receive_pour_truck(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); t public.pour_trucks; pr public.pours; v_post jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  select * into t from public.pour_trucks where id = (p ->> 'truck_id')::uuid for update;
  if not found then raise exception 'Truck not found'; end if;
  perform app.require_member(t.project_id);
  perform app.require_role('store_keeper','coordinator','manager','admin');
  if t.status <> 'awaiting_receipt' then raise exception 'Truck % is already %', t.ticket_no, t.status; end if;
  select * into pr from public.pours where id = t.pour_id;
  if pr.status = 'cancelled' then raise exception 'Pour % is cancelled', pr.number; end if;
  perform app.require_pour_hold_points(pr.id);
  v_post := app.post_pour_truck(t.id, p);
  return app.op_done(p, 'receive_pour_truck', jsonb_build_object('ok', true, 'id', t.id, 'status', 'posted') || v_post);
end $$;

create or replace function public.add_pour_batch(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); pr public.pours; v_at timestamptz := coalesce((p ->> 'batched_at')::timestamptz, now());
begin
  if v_seen is not null then return v_seen; end if;
  select * into pr from public.pours where id = (p ->> 'pour_id')::uuid for update;
  if not found then raise exception 'Pour not found'; end if;
  perform app.require_member(pr.project_id);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  if pr.method <> 'site_batched' then raise exception 'Pour % is ready-mix; record trucks instead of batches', pr.number; end if;
  if pr.status not in ('planned','in_progress') then raise exception 'Pour % is %', pr.number, pr.status; end if;
  if (p ->> 'cement_bags') is null then raise exception 'Cement bags used are required'; end if;
  perform app.require_pour_hold_points(pr.id);
  insert into public.pour_batches (id, pour_id, project_id, seq, volume_m3, cement_bags, sand_m3, aggregate_m3, water_l,
    slump_mm, mixer, batched_at, recorded_by)
  values ((p ->> 'id')::uuid, pr.id, pr.project_id,
    coalesce((p ->> 'seq')::int, (select coalesce(max(seq), 0) + 1 from public.pour_batches where pour_id = pr.id)),
    (p ->> 'volume_m3')::numeric, (p ->> 'cement_bags')::numeric, (p ->> 'sand_m3')::numeric, (p ->> 'aggregate_m3')::numeric,
    (p ->> 'water_l')::numeric, (p ->> 'slump_mm')::int, nullif(p ->> 'mixer', ''), v_at, auth.uid());
  perform app.start_pour(pr.id, v_at);
  return app.op_done(p, 'add_pour_batch', jsonb_build_object('ok', true, 'id', (p ->> 'id')::uuid));
end $$;

-- Store keeper issues cement / sand / aggregate (or admixtures) to a pour.
create or replace function public.issue_pour_materials(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); pr public.pours; v_miv uuid := (p ->> 'miv_id')::uuid;
begin
  if v_seen is not null then return v_seen; end if;
  select * into pr from public.pours where id = (p ->> 'pour_id')::uuid for update;
  if not found then raise exception 'Pour not found'; end if;
  perform app.require_member(pr.project_id);
  perform app.require_role('store_keeper','coordinator','manager','admin');
  if pr.status = 'cancelled' then raise exception 'Pour % is cancelled', pr.number; end if;
  if v_miv is null then raise exception 'miv_id is required'; end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'An issue needs at least one line'; end if;
  perform app.pour_issue(pr, coalesce((p ->> 'store_id')::uuid, pr.store_id), v_miv, p ->> 'number', p -> 'lines',
    coalesce((p ->> 'issued_at')::timestamptz, now()), coalesce(nullif(p ->> 'remarks', ''), 'Issued to pour ' || pr.number));
  return app.op_done(p, 'issue_pour_materials', jsonb_build_object('ok', true, 'id', v_miv));
end $$;

-- Completes (or cancels) a pour. Completion reports the casting activity of
-- each element at 100 % for the office engineer to verify.
create or replace function public.close_pour(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  pr public.pours;
  v_actual numeric; v_cast record; v_n int := 0;
begin
  if v_seen is not null then return v_seen; end if;
  select * into pr from public.pours where id = (p ->> 'pour_id')::uuid for update;
  if not found then raise exception 'Pour not found'; end if;
  perform app.require_member(pr.project_id);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  if pr.status not in ('planned','in_progress') then raise exception 'Pour % is already %', pr.number, pr.status; end if;

  if coalesce((p ->> 'cancel')::boolean, false) then
    if exists (select 1 from public.pour_issues where pour_id = pr.id) or exists (select 1 from public.pour_batches where pour_id = pr.id)
       or exists (select 1 from public.pour_trucks where pour_id = pr.id and status <> 'rejected') then
      raise exception 'Pour % already has concrete recorded and cannot be cancelled', pr.number;
    end if;
    update public.pours set status = 'cancelled', closed_by = auth.uid(), remarks = coalesce(nullif(p ->> 'remarks', ''), remarks)
      where id = pr.id;
    return app.op_done(p, 'close_pour', jsonb_build_object('ok', true, 'id', pr.id, 'status', 'cancelled'));
  end if;

  if exists (select 1 from public.pour_trucks where pour_id = pr.id and status = 'awaiting_receipt') then
    raise exception 'Some accepted trucks are still waiting for the store keeper to receive them';
  end if;
  v_actual := coalesce((p ->> 'actual_m3')::numeric,
    case when pr.method = 'ready_mix' then (select sum(volume_m3) from public.pour_trucks where pour_id = pr.id and status = 'posted')
         else (select sum(volume_m3) from public.pour_batches where pour_id = pr.id) end);
  if coalesce(v_actual, 0) <= 0 then raise exception 'Actual volume poured is required'; end if;
  update public.pours set status = 'completed', actual_m3 = v_actual, closed_by = auth.uid(),
    end_at = coalesce((p ->> 'end_at')::timestamptz, now()), start_at = coalesce(start_at, (p ->> 'end_at')::timestamptz, now()),
    remarks = coalesce(nullif(p ->> 'remarks', ''), remarks)
  where id = pr.id;

  for v_cast in
    select distinct on (a.element_id) a.* from public.pour_elements pe
    join public.element_activities a on a.element_id = pe.element_id and (a.name ilike 'cast%' or a.name ilike 'concret%')
    where pe.pour_id = pr.id and pe.deleted_at is null and a.reported_pct < 100
    order by a.element_id, a.seq
  loop
    insert into public.progress_updates (id, project_id, element_id, element_activity_id, report_date, pct_complete, uom, remarks, reported_by)
    values (gen_random_uuid(), pr.project_id, v_cast.element_id, v_cast.id, app.local_date(coalesce((p ->> 'end_at')::timestamptz, now())),
      100, 'm3', 'Pour ' || pr.number, auth.uid());
    update public.element_activities set reported_pct = 100 where id = v_cast.id;
    update public.elements set actual_start = coalesce(actual_start, pr.pour_date),
      status = case when status = 'not_started' then 'in_progress' else status end where id = v_cast.element_id;
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then
    perform app.notify_roles(pr.project_id, '{office_engineer}', 'Pour completed: ' || pr.number,
      v_actual || ' m³ (planned ' || pr.planned_m3 || ') — casting to verify', 'pour', pr.id);
  end if;
  return app.op_done(p, 'close_pour', jsonb_build_object('ok', true, 'id', pr.id, 'status', 'completed', 'actual_m3', v_actual,
    'over_pour_pct', round((v_actual / pr.planned_m3 - 1) * 100, 2)));
end $$;

create or replace function public.save_cube_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); pr public.pours; v_fck numeric;
begin
  if v_seen is not null then return v_seen; end if;
  select * into pr from public.pours where id = (p ->> 'pour_id')::uuid;
  if not found then raise exception 'Pour not found'; end if;
  perform app.require_member(pr.project_id);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  if p ->> 'truck_id' is not null and not exists (select 1 from public.pour_trucks where id = (p ->> 'truck_id')::uuid and pour_id = pr.id) then
    raise exception 'Truck does not belong to this pour';
  end if;
  if p ->> 'element_id' is not null and not exists (
      select 1 from public.pour_elements where pour_id = pr.id and element_id = (p ->> 'element_id')::uuid and deleted_at is null) then
    raise exception 'Element is not part of this pour';
  end if;
  select target_strength_mpa into v_fck from public.mix_designs where id = pr.mix_design_id;
  insert into public.cube_sets (id, project_id, number, pour_id, truck_id, element_id, sampled_at, cubes_count, cube_size_mm,
    test_ages, lab_name, required_strength_mpa, created_by)
  values ((p ->> 'id')::uuid, pr.project_id, p ->> 'number', pr.id, (p ->> 'truck_id')::uuid, (p ->> 'element_id')::uuid,
    coalesce((p ->> 'sampled_at')::timestamptz, now()), coalesce((p ->> 'cubes_count')::int, 3),
    coalesce((p ->> 'cube_size_mm')::int, 150),
    coalesce((select array_agg(x::int order by x::int) from jsonb_array_elements_text(p -> 'test_ages') x), '{7,28}'),
    nullif(p ->> 'lab_name', ''), v_fck, auth.uid());
  return app.op_done(p, 'save_cube_set', jsonb_build_object('ok', true, 'id', (p ->> 'id')::uuid));
end $$;

-- Lab results. Each cube passes if strength ≥ fck × age factor (28 d: ≥ fck − 4).
-- The 28-day set passes if mean ≥ fck and every cube ≥ fck − 4 (EN 206 style).
-- A failed 28-day set raises a critical snag and alerts management.
create or replace function public.record_cube_results(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  c public.cube_sets; pr public.pours;
  r jsonb; v_str numeric; v_age int; v_fck numeric;
  v_mean numeric; v_min numeric; v_cnt int;
  v_early text; v_28 text; v_snag uuid; v_el uuid; v_code text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into c from public.cube_sets where id = (p ->> 'cube_set_id')::uuid for update;
  if not found then raise exception 'Cube set not found'; end if;
  perform app.require_member(c.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if jsonb_array_length(coalesce(p -> 'results', '[]'::jsonb)) = 0 then raise exception 'Enter at least one cube result'; end if;
  v_fck := c.required_strength_mpa;
  select * into pr from public.pours where id = c.pour_id;

  for r in select * from jsonb_array_elements(p -> 'results') loop
    v_age := (r ->> 'age_days')::int;
    if v_age is null or v_age <= 0 then raise exception 'Cube age (days) is required'; end if;
    v_str := coalesce((r ->> 'strength_mpa')::numeric,
                      round((r ->> 'load_kn')::numeric * 1000 / (c.cube_size_mm * c.cube_size_mm), 2));
    if v_str is null then raise exception 'Cube %: enter the crushing load (kN) or strength (MPa)', r ->> 'cube_label'; end if;
    insert into public.cube_results (id, cube_set_id, project_id, cube_label, age_days, tested_on, load_kn, strength_mpa,
      density_kg_m3, failure_mode, passed, recorded_by)
    values ((r ->> 'id')::uuid, c.id, c.project_id, coalesce(nullif(r ->> 'cube_label', ''), 'cube'), v_age,
      coalesce((r ->> 'tested_on')::date, (c.sampled_at + make_interval(days => v_age))::date), (r ->> 'load_kn')::numeric,
      v_str, (r ->> 'density_kg_m3')::numeric, nullif(r ->> 'failure_mode', ''),
      case when v_age >= 28 then v_str >= v_fck - 4 else v_str >= v_fck * app.cube_age_factor(v_age) end, auth.uid());
  end loop;

  -- early-age indication
  select case when count(*) = 0 then null when bool_and(passed) then 'ok' else 'low' end into v_early
    from public.cube_results where cube_set_id = c.id and age_days < 28;
  -- 28-day compliance
  select avg(strength_mpa), min(strength_mpa), count(*) into v_mean, v_min, v_cnt
    from public.cube_results where cube_set_id = c.id and age_days >= 28;
  v_28 := case when v_cnt > 0 then case when v_mean >= v_fck and v_min >= v_fck - 4 then 'pass' else 'fail' end end;

  update public.cube_sets set result_early = coalesce(v_early, result_early), result_28d = coalesce(v_28, result_28d),
    mean_28d_mpa = coalesce(round(v_mean, 2), mean_28d_mpa)
  where id = c.id;

  if v_early = 'low' and c.result_early is distinct from 'low' then
    perform app.notify_roles(c.project_id, '{office_engineer}', 'Low early cube strength: ' || c.number,
      'Pour ' || pr.number || ' — watch the 28-day result', 'cube_set', c.id);
  end if;

  if v_28 = 'fail' and c.result_28d is distinct from 'fail' then
    v_el := coalesce(c.element_id, (select element_id from public.pour_elements where pour_id = c.pour_id and deleted_at is null
                                     order by planned_m3 desc nulls last limit 1));
    select code into v_code from public.elements where id = v_el;
    v_snag := app.create_snag(jsonb_build_object(
      'id', coalesce(p -> 'snag' ->> 'id', gen_random_uuid()::text),
      'number', coalesce(nullif(p -> 'snag' ->> 'number', ''), c.number || '-S1'),
      'element_id', v_el, 'severity', 'critical', 'category', 'concrete strength', 'trade', 'concrete',
      'title', '28-day cube failure ' || c.number || ' (' || round(v_mean, 1) || ' < ' || v_fck || ' MPa)',
      'description', 'Pour ' || pr.number || ': mean ' || round(v_mean, 1) || ' MPa, min ' || round(v_min, 1) ||
                     ' MPa vs required ' || v_fck || ' MPa. Consider cores / structural review.',
      'assignee_user_id', p -> 'snag' ->> 'assignee_user_id',
      'source_type', 'cube', 'source_id', c.id), c.project_id);
    update public.cube_sets set snag_id = v_snag where id = c.id;
    perform app.notify_roles(c.project_id, '{manager,coordinator,office_engineer}', 'Concrete cube FAILURE: ' || c.number,
      'Pour ' || pr.number || coalesce(' / ' || v_code, '') || ': 28-day mean ' || round(v_mean, 1) || ' MPa, required ' || v_fck,
      'cube_set', c.id, true);
  end if;
  return app.op_done(p, 'record_cube_results', jsonb_build_object('ok', true, 'id', c.id,
    'result_early', coalesce(v_early, c.result_early), 'result_28d', coalesce(v_28, c.result_28d),
    'mean_28d_mpa', round(v_mean, 2), 'snag_id', v_snag));
end $$;

-- =============================================================================
-- BBS (C4)
-- =============================================================================

create or replace function public.save_bbs(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  b public.bbs_schedules;
  v_lines jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if not exists (select 1 from public.elements where id = (p ->> 'element_id')::uuid and project_id = v_project) then
    raise exception 'Element does not belong to this project';
  end if;
  v_lines := app.with_defaults(p -> 'lines', '{"no_of_members":1}'::jsonb);
  if jsonb_array_length(v_lines) = 0 then raise exception 'A bar bending schedule needs at least one line'; end if;
  select jsonb_agg(r || jsonb_build_object('line_no', (r ->> '_ord')::int,
           'diameter_mm', coalesce((r ->> 'diameter_mm')::int,
             (select app.spec_diameter(s.grade) from public.material_specs s where s.id = (r ->> 'material_spec_id')::uuid))))
    into v_lines from jsonb_array_elements(v_lines) r;
  if exists (select 1 from jsonb_array_elements(v_lines) r where r ->> 'diameter_mm' is null or coalesce(trim(r ->> 'bar_mark'), '') = '') then
    raise exception 'Every BBS line needs a bar mark and a diameter';
  end if;

  select * into b from public.bbs_schedules where id = v_id for update;
  if found then
    if b.project_id <> v_project then raise exception 'BBS belongs to another project'; end if;
    if b.status <> 'draft' then raise exception 'BBS % is %; issue a new revision', b.number, b.status; end if;
    update public.bbs_schedules set element_id = (p ->> 'element_id')::uuid,
      revision = coalesce((p ->> 'revision')::int, revision), drawing_ref = nullif(p ->> 'drawing_ref', ''),
      remarks = nullif(p ->> 'remarks', '')
    where id = v_id;
  else
    insert into public.bbs_schedules (id, project_id, number, element_id, revision, drawing_ref, remarks, created_by)
    values (v_id, v_project, p ->> 'number', (p ->> 'element_id')::uuid,
      coalesce((p ->> 'revision')::int, (select coalesce(max(revision) + 1, 0) from public.bbs_schedules
                                         where element_id = (p ->> 'element_id')::uuid)),
      nullif(p ->> 'drawing_ref', ''), nullif(p ->> 'remarks', ''), auth.uid());
  end if;
  perform app.replace_children('bbs_lines', 'bbs_id', v_id, v_project, v_lines,
    array['line_no','bar_mark','material_spec_id','diameter_mm','shape_code','no_of_members','bars_per_member','cut_length_m']);
  return app.op_done(p, 'save_bbs', jsonb_build_object('ok', true, 'id', v_id,
    'total_kg', (select coalesce(sum(weight_kg), 0) from public.bbs_lines where bbs_id = v_id and deleted_at is null)));
end $$;

-- Approves a BBS revision, supersedes the previous approved one and
-- (optionally) sets the element's rebar take-offs to the BBS weights.
create or replace function public.approve_bbs(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); b public.bbs_schedules; v_upd int := 0;
begin
  if v_seen is not null then return v_seen; end if;
  select * into b from public.bbs_schedules where id = (p ->> 'bbs_id')::uuid for update;
  if not found then raise exception 'BBS not found'; end if;
  perform app.require_member(b.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if b.status <> 'draft' then raise exception 'BBS % is already %', b.number, b.status; end if;
  if not exists (select 1 from public.bbs_lines where bbs_id = b.id and deleted_at is null) then raise exception 'BBS has no lines'; end if;
  update public.bbs_schedules set status = 'superseded'
    where element_id = b.element_id and status = 'approved' and id <> b.id;
  update public.bbs_schedules set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = b.id;
  if coalesce((p ->> 'update_takeoff')::boolean, false) then
    insert into public.element_takeoffs (project_id, element_id, material_spec_id, planned_qty)
    select b.project_id, b.element_id, l.material_spec_id, round(sum(l.weight_kg) / coalesce(app.uom_kg(s.uom), 1), 3)
    from public.bbs_lines l join public.material_specs s on s.id = l.material_spec_id
    where l.bbs_id = b.id and l.deleted_at is null and l.material_spec_id is not null
    group by l.material_spec_id, s.uom
    on conflict (element_id, material_spec_id) do update set planned_qty = excluded.planned_qty, deleted_at = null;
    get diagnostics v_upd = row_count;
  end if;
  return app.op_done(p, 'approve_bbs', jsonb_build_object('ok', true, 'id', b.id, 'status', 'approved', 'takeoffs_updated', v_upd));
end $$;

-- =============================================================================
-- Views
-- =============================================================================

-- Everything that happened on a day, for the diary's auto sections and PDF.
create or replace view public.v_diary_activity with (security_invoker = true) as
select g.project_id, app.local_date(g.received_at) as activity_date, 'grn'::text as kind, g.id as doc_id, g.number,
       null::uuid as block_id, null::uuid as element_id,
       coalesce(g.supplier_name, su.name, 'Receipt') || ': ' ||
         coalesce((select string_agg(app.spec_label(l.material_spec_id) || ' ' || l.qty_accepted, ', ' order by l.line_no)
                   from public.grn_lines l where l.grn_id = g.id), '') as summary,
       g.status, g.created_by as actor, g.received_at as at
from public.grns g left join public.suppliers su on su.id = g.supplier_id
union all
select m.project_id, app.local_date(m.issued_at), 'miv', m.id, m.number, null, null,
       coalesce((select string_agg(app.spec_label(l.material_spec_id) || ' ' || l.qty || ' → ' || e.code, ', ' order by l.line_no)
                 from public.miv_lines l join public.elements e on e.id = l.element_id where l.miv_id = m.id), ''),
       m.status, m.issued_by, m.issued_at
from public.mivs m
union all
select u.project_id, u.report_date, 'progress', u.id, e.code, e.block_id, u.element_id,
       a.name || ' ' || u.pct_complete || '%' || coalesce(' (verified ' || u.verified_pct || '%)', ''),
       u.status, u.reported_by, u.created_at
from public.progress_updates u join public.elements e on e.id = u.element_id
join public.element_activities a on a.id = u.element_activity_id
union all
select po.project_id, po.pour_date, 'pour', po.id, po.number,
       (select e.block_id from public.pour_elements pe join public.elements e on e.id = pe.element_id
         where pe.pour_id = po.id and pe.deleted_at is null limit 1), null,
       md.grade || ' ' || coalesce(po.actual_m3, po.planned_m3) || ' m³ — ' ||
         coalesce((select string_agg(e.code, ', ') from public.pour_elements pe join public.elements e on e.id = pe.element_id
                   where pe.pour_id = po.id and pe.deleted_at is null), ''),
       po.status, po.created_by, coalesce(po.start_at, po.created_at)
from public.pours po join public.mix_designs md on md.id = po.mix_design_id
union all
select i.project_id, app.local_date(coalesce(i.inspected_at, i.requested_at, i.created_at)), 'inspection', i.id, i.number,
       e.block_id, i.element_id, t.name || ' — ' || e.code || coalesce(': ' || i.result, ' (' || i.status || ')'),
       i.status, coalesce(i.inspector_id, i.requested_by), coalesce(i.inspected_at, i.created_at)
from public.inspections i join public.checklist_templates t on t.id = i.template_id join public.elements e on e.id = i.element_id
union all
select s.project_id, app.local_date(s.created_at), 'snag', s.id, s.number, s.block_id, s.element_id,
       s.severity || ': ' || s.title, s.status, s.raised_by, s.created_at
from public.snags s;

-- Auto summary for a diary: {grn:[…], miv:[…], progress:[…], pour:[…], inspection:[…], snag:[…]}.
-- Runs as the caller, so RLS applies.
create or replace function public.get_diary_summary(p jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_object_agg(kind, items), '{}'::jsonb) from (
    select kind, jsonb_agg(jsonb_build_object('id', doc_id, 'number', number, 'summary', summary, 'status', status,
             'element_id', element_id, 'at', at) order by at) as items
    from public.v_diary_activity
    where project_id = (p ->> 'project_id')::uuid and activity_date = (p ->> 'diary_date')::date
      and (p ->> 'block_id' is null or block_id is null or block_id = (p ->> 'block_id')::uuid)
    group by kind) x
$$;

create or replace view public.v_pour_summary with (security_invoker = true) as
with t as (
  select pour_id, count(*) as trucks, count(*) filter (where status = 'rejected') as trucks_rejected,
         count(*) filter (where status = 'awaiting_receipt') as trucks_awaiting,
         coalesce(sum(volume_m3) filter (where status = 'posted'), 0) as accepted_m3,
         coalesce(sum(volume_m3) filter (where status = 'rejected'), 0) as rejected_m3,
         count(*) filter (where cardinality(warnings) > 0) as trucks_with_warnings
  from public.pour_trucks group by pour_id),
b as (
  select pour_id, count(*) as batches, coalesce(sum(volume_m3), 0) as batched_m3, coalesce(sum(cement_bags), 0) as cement_bags
  from public.pour_batches group by pour_id),
ci as (
  select pi.pour_id, -sum(l.qty * coalesce(app.uom_kg(s.uom), 0)) as cement_kg_issued
  from public.pour_issues pi
  join public.stock_ledger l on l.doc_id = pi.miv_id and l.doc_type = 'miv'
  join public.material_specs s on s.id = l.material_spec_id
  join public.materials m on m.id = s.material_id and m.category = 'Cement'
  group by pi.pour_id),
cs as (
  select pour_id, count(*) as cube_sets, count(*) filter (where result_28d = 'fail') as cube_sets_failed,
         count(*) filter (where result_28d = 'pass') as cube_sets_passed
  from public.cube_sets group by pour_id),
v as (
  select po.id, coalesce(po.actual_m3, nullif(b.batched_m3, 0), nullif(t.accepted_m3, 0)) as vol
  from public.pours po left join t on t.pour_id = po.id left join b on b.pour_id = po.id)
select po.id as pour_id, po.project_id, po.number, po.pour_date, po.method, po.status, md.code as mix_code, md.grade,
       md.target_strength_mpa, po.planned_m3, po.actual_m3,
       case when po.actual_m3 is not null then round((po.actual_m3 / po.planned_m3 - 1) * 100, 2) end as over_pour_pct,
       coalesce(t.trucks, 0) as trucks, coalesce(t.trucks_rejected, 0) as trucks_rejected,
       coalesce(t.trucks_awaiting, 0) as trucks_awaiting, coalesce(t.accepted_m3, 0) as accepted_m3,
       coalesce(t.rejected_m3, 0) as rejected_m3, coalesce(t.trucks_with_warnings, 0) as trucks_with_warnings,
       coalesce(b.batches, 0) as batches, coalesce(b.batched_m3, 0) as batched_m3, coalesce(b.cement_bags, 0) as cement_bags,
       coalesce(ci.cement_kg_issued, 0) as cement_kg_issued,
       md.cement_kg_per_m3 as design_cement_kg_per_m3,
       round(md.cement_kg_per_m3 * v.vol, 1) as design_cement_kg,
       case when v.vol > 0 then round(coalesce(b.cement_bags, 0) * 50 / v.vol, 1) end as batched_cement_kg_per_m3,
       case when v.vol > 0 then round(coalesce(ci.cement_kg_issued, 0) / v.vol, 1) end as issued_cement_kg_per_m3,
       case when v.vol > 0 and md.cement_kg_per_m3 > 0 and ci.cement_kg_issued is not null
            then round((ci.cement_kg_issued / v.vol / md.cement_kg_per_m3 - 1) * 100, 2) end as cement_variance_pct,
       coalesce(cs.cube_sets, 0) as cube_sets, coalesce(cs.cube_sets_passed, 0) as cube_sets_passed,
       coalesce(cs.cube_sets_failed, 0) as cube_sets_failed
from public.pours po
join public.mix_designs md on md.id = po.mix_design_id
join v on v.id = po.id
left join t on t.pour_id = po.id
left join b on b.pour_id = po.id
left join ci on ci.pour_id = po.id
left join cs on cs.pour_id = po.id;

-- Cube tests due / overdue (one row per set and test age without results).
create or replace view public.v_cubes_due with (security_invoker = true) as
select c.id as cube_set_id, c.project_id, c.number, c.pour_id, po.number as pour_number, c.element_id, a.age_days,
       (app.local_date(c.sampled_at) + a.age_days) as due_date,
       case when app.local_date(c.sampled_at) + a.age_days < app.local_date(now()) then 'overdue'
            when app.local_date(c.sampled_at) + a.age_days = app.local_date(now()) then 'due'
            else 'upcoming' end as due_status,
       c.lab_name, c.cubes_count
from public.cube_sets c
join public.pours po on po.id = c.pour_id
cross join lateral unnest(c.test_ages) as a(age_days)
where not exists (select 1 from public.cube_results r where r.cube_set_id = c.id and r.age_days = a.age_days);

-- FR-CC-05: BBS kg vs take-off vs issued vs returned, per element and bar diameter.
-- The current BBS of an element is its latest approved revision, else the latest draft.
create or replace view public.v_rebar_reconciliation with (security_invoker = true) as
with cur as (
  select distinct on (b.element_id) b.*
  from public.bbs_schedules b
  where b.deleted_at is null and b.status <> 'superseded'
  order by b.element_id, (b.status = 'approved') desc, b.revision desc),
bbs as (
  select c.project_id, c.element_id, l.diameter_mm, c.id as bbs_id, c.number as bbs_number, c.revision, c.status,
         sum(l.weight_kg) as bbs_kg
  from cur c join public.bbs_lines l on l.bbs_id = c.id and l.deleted_at is null
  group by c.project_id, c.element_id, l.diameter_mm, c.id, c.number, c.revision, c.status),
rebar as (
  select s.id, app.spec_diameter(s.grade) as dia, coalesce(app.uom_kg(s.uom), 1) as kgf, s.wastage_pct
  from public.material_specs s join public.materials m on m.id = s.material_id
  where m.category = 'Reinforcement' and app.spec_diameter(s.grade) is not null),
tk as (
  select t.project_id, t.element_id, r.dia, sum(t.planned_qty * r.kgf) as takeoff_kg, max(r.wastage_pct) as wastage_pct
  from public.element_takeoffs t join rebar r on r.id = t.material_spec_id
  where t.deleted_at is null group by t.project_id, t.element_id, r.dia),
mv as (
  select l.project_id, l.element_id, r.dia,
         -coalesce(sum(l.qty * r.kgf) filter (where l.doc_type = 'miv'), 0) as issued_kg,
         coalesce(sum(l.qty * r.kgf) filter (where l.doc_type = 'mrn'), 0) as returned_kg,
         max(r.wastage_pct) as wastage_pct
  from public.stock_ledger l join rebar r on r.id = l.material_spec_id
  where l.element_id is not null and l.doc_type in ('miv','mrn')
  group by l.project_id, l.element_id, r.dia),
k as (
  select project_id, element_id, diameter_mm from bbs
  union select project_id, element_id, dia from tk
  union select project_id, element_id, dia from mv),
x as (
  select k.project_id, k.element_id, k.diameter_mm, b.bbs_id, b.bbs_number, b.revision as bbs_revision, b.status as bbs_status,
         round(coalesce(b.bbs_kg, 0), 3) as bbs_kg, round(coalesce(t.takeoff_kg, 0), 3) as takeoff_kg,
         round(coalesce(m.issued_kg, 0), 3) as issued_kg, round(coalesce(m.returned_kg, 0), 3) as returned_kg,
         coalesce(t.wastage_pct, m.wastage_pct, 3) as allowance_pct
  from k
  left join bbs b on b.element_id = k.element_id and b.diameter_mm = k.diameter_mm
  left join tk t on t.element_id = k.element_id and t.dia = k.diameter_mm
  left join mv m on m.element_id = k.element_id and m.dia = k.diameter_mm)
select x.project_id, x.element_id, e.code as element_code, e.element_type, e.block_id, e.level_id, e.status as element_status,
       x.diameter_mm, x.bbs_id, x.bbs_number, x.bbs_revision, x.bbs_status,
       x.bbs_kg, x.takeoff_kg, x.issued_kg, x.returned_kg,
       x.issued_kg - x.returned_kg as net_issued_kg,
       coalesce(nullif(x.bbs_kg, 0), x.takeoff_kg) as basis_kg,
       round(x.issued_kg - x.returned_kg - coalesce(nullif(x.bbs_kg, 0), x.takeoff_kg), 3) as variance_kg,
       case when coalesce(nullif(x.bbs_kg, 0), x.takeoff_kg) > 0
            then round(((x.issued_kg - x.returned_kg) / coalesce(nullif(x.bbs_kg, 0), x.takeoff_kg) - 1) * 100, 2) end as variance_pct,
       case when x.takeoff_kg > 0 and x.bbs_kg > 0 then round((x.bbs_kg / x.takeoff_kg - 1) * 100, 2) end as bbs_vs_takeoff_pct,
       x.allowance_pct,
       case when coalesce(nullif(x.bbs_kg, 0), x.takeoff_kg) = 0 then case when x.issued_kg - x.returned_kg > 0 then 'no_basis' else 'ok' end
            when ((x.issued_kg - x.returned_kg) / coalesce(nullif(x.bbs_kg, 0), x.takeoff_kg) - 1) * 100 > x.allowance_pct then 'over'
            when e.status = 'completed'
                 and ((x.issued_kg - x.returned_kg) / coalesce(nullif(x.bbs_kg, 0), x.takeoff_kg) - 1) * 100 < -x.allowance_pct then 'under'
            else 'ok' end as flag
from x join public.elements e on e.id = x.element_id;

grant select on public.v_diary_activity, public.v_pour_summary, public.v_cubes_due, public.v_rebar_reconciliation to authenticated;

-- =============================================================================
-- Grants
-- =============================================================================

do $$
declare f text;
begin
  foreach f in array array['save_snag','snag_action','save_checklist_template','request_inspection','submit_inspection',
    'cancel_inspection','save_site_diary','sign_site_diary','add_diary_addendum','get_diary_summary','save_mix_design',
    'save_pour','add_pour_truck','receive_pour_truck','add_pour_batch','issue_pour_materials','close_pour',
    'save_cube_set','record_cube_results','save_bbs','approve_bbs'] loop
    execute format('revoke execute on function public.%I(jsonb) from public, anon', f);
    execute format('grant execute on function public.%I(jsonb) to authenticated', f);
  end loop;
end $$;

-- Internal security-definer helpers are only callable from the RPCs above.
revoke execute on function app.replace_children(text, text, uuid, uuid, jsonb, text[]) from public;
revoke execute on function app.create_snag(jsonb, uuid) from public;
revoke execute on function app.try_clear_hold_point(uuid, uuid) from public;
revoke execute on function app.pour_issue(public.pours, uuid, uuid, text, jsonb, timestamptz, text, uuid, uuid) from public;
revoke execute on function app.post_pour_truck(uuid, jsonb) from public;
revoke execute on function app.start_pour(uuid, timestamptz) from public;
