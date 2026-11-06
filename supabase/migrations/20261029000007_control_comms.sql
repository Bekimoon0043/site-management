-- =============================================================================
-- Site control, evidence, communication & language (backlog P1 #10–#12 + H1)
--
--   D1  gate passes, gate events, vehicle log; stock status `on_loan`
--   D2  alert rules + alerts, app.run_alert_rules() (pg_cron)
--   E1  QR labels signed with a per-project HMAC key (offline verification)
--   E2  tamper-evident attachments (sha256, source, captured_at, geofence)
--   F1  Telegram linking, single-use action tokens, notification prefs,
--       project channels, app.run_action_as()
--   F3  v_my_approvals
--   H1  profiles.locale / calendar, *_am names, Ethiopian calendar functions
--
-- NOTE on the new enum value: `alter type ... add value` may run inside the
-- migration transaction, but the new value cannot be *used* until commit.
-- Nothing in this file casts the literal 'security' to app_role at creation
-- time: role checks for it compare app.my_role()::text (see app.has_role_txt).
-- =============================================================================

alter type public.app_role add value if not exists 'security';

-- -----------------------------------------------------------------------------
-- Generic helpers
-- -----------------------------------------------------------------------------

-- Text-based role checks, usable with roles added after the enum was created.
create or replace function app.has_role_txt(variadic roles text[]) returns boolean
language sql stable as $$
  select coalesce(app.my_role()::text = any (roles), false)
$$;

create or replace function app.require_role_txt(variadic roles text[]) returns void
language plpgsql stable as $$
begin
  if not app.has_role_txt(variadic roles) then
    raise exception 'Your role (%) is not allowed to perform this action', coalesce(app.my_role()::text, 'inactive')
      using errcode = '42501';
  end if;
end $$;

create or replace function app.notify_roles_txt(p_project uuid, p_roles text[], p_title text, p_body text,
  p_entity_type text, p_entity uuid, p_critical boolean default false) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, project_id, title, body, entity_type, entity_id, is_critical)
  select pr.id, p_project, p_title, p_body, p_entity_type, p_entity, p_critical
  from public.profiles pr
  join public.project_members m on m.user_id = pr.id and m.project_id = p_project
  where pr.is_active and pr.role::text = any (p_roles) and pr.id is distinct from auth.uid()
$$;

-- Ethiopia is UTC+3 all year (no DST); avoids depending on tz data.
create or replace function app.eat_now() returns timestamp
language sql stable as $$ select (now() at time zone 'UTC') + interval '3 hours' $$;

create or replace function app.eat_date(p_ts timestamptz) returns date
language sql stable as $$ select ((p_ts at time zone 'UTC') + interval '3 hours')::date $$;

-- Extend a single-column `col = any(array[...])` CHECK constraint with more
-- values, keeping whatever values other migrations already added.
create or replace function app.extend_check_values(p_table regclass, p_column text, p_values text[]) returns void
language plpgsql as $$
declare
  c record;
  v_vals text[] := p_values;
  v_att smallint;
begin
  select attnum into v_att from pg_attribute where attrelid = p_table and attname = p_column and not attisdropped;
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    where con.conrelid = p_table and con.contype = 'c' and con.conkey = array[v_att]
  loop
    v_vals := v_vals || array(select (regexp_matches(c.def, '''([^'']*)''', 'g'))[1]);
    execute format('alter table %s drop constraint %I', p_table, c.conname);
  end loop;
  v_vals := array(select distinct x from unnest(v_vals) x order by x);
  execute format('alter table %s add constraint %I check (%I = any (%L::text[]))',
    p_table, (select relname from pg_class where oid = p_table) || '_' || p_column || '_check', p_column, v_vals);
end $$;

create or replace function app.b64url(p bytea) returns text
language sql immutable as $$
  select translate(rtrim(replace(encode(p, 'base64'), E'\n', ''), '='), '+/', '-_')
$$;

-- Cryptographically random bytes from gen_random_uuid (built in; no pgcrypto needed).
create or replace function app.random_bytes(n int) returns bytea
language sql volatile as $$
  select substring(string_agg(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), ''::bytea) from 1 for n)
  from generate_series(1, (n + 15) / 16)
$$;

-- HMAC-SHA256 (RFC 2104) on the built-in sha256(); identical to Node/WebCrypto HMAC.
create or replace function app.hmac_sha256(p_key bytea, p_msg bytea) returns bytea
language plpgsql immutable as $$
declare
  k bytea := p_key;
  ipad bytea; opad bytea;
  i int;
begin
  if length(k) > 64 then k := sha256(k); end if;
  k := k || decode(repeat('00', 64 - length(k)), 'hex');
  ipad := k; opad := k;
  for i in 0..63 loop
    ipad := set_byte(ipad, i, get_byte(k, i) # 54);   -- 0x36
    opad := set_byte(opad, i, get_byte(k, i) # 92);   -- 0x5c
  end loop;
  return sha256(opad || sha256(ipad || p_msg));
end $$;

create or replace function app.distance_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8) returns float8
language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

create or replace function app.norm_plate(p text) returns text
language sql immutable as $$ select nullif(upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')), '') $$;

create or replace function app.html_escape(p text) returns text
language sql immutable as $$ select replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') $$;

-- -----------------------------------------------------------------------------
-- Ethiopian calendar (H1). Dates are always stored Gregorian; these are for
-- display, reports and input conversion. Algorithm: Julian Day Number with
-- the Amete Mihret epoch (JDN 1723856), 12×30-day months + Pagume (5 days,
-- 6 in a year where year % 4 = 3).
-- -----------------------------------------------------------------------------

create or replace function app.ethiopian_parts(p_date date, out y int, out m int, out d int)
language plpgsql immutable as $$
declare
  jdn int := to_char(p_date, 'J')::int;
  r int := (jdn - 1723856) % 1461;
  n int := (r % 365) + 365 * (r / 1460);
begin
  y := 4 * ((jdn - 1723856) / 1461) + r / 365 - r / 1460;
  m := n / 30 + 1;
  d := n % 30 + 1;
end $$;

create or replace function app.from_ethiopian(p_y int, p_m int, p_d int) returns date
language plpgsql immutable as $$
begin
  if p_m < 1 or p_m > 13 or p_d < 1 or p_d > 30 or (p_m = 13 and p_d > case when p_y % 4 = 3 then 6 else 5 end) then
    raise exception 'Invalid Ethiopian date %-%-%', p_y, p_m, p_d;
  end if;
  return to_date((1723856 + 365 + 365 * (p_y - 1) + p_y / 4 + 30 * p_m + p_d - 31)::text, 'J');
end $$;

create or replace function app.ethiopian_month_name(p_m int, p_lang text default 'en') returns text
language sql immutable as $$
  select case when p_lang = 'am'
    then (array['መስከረም','ጥቅምት','ኅዳር','ታኅሣሥ','ጥር','የካቲት','መጋቢት','ሚያዝያ','ግንቦት','ሰኔ','ሐምሌ','ነሐሴ','ጳጉሜ'])[p_m]
    else (array['Meskerem','Tikimt','Hidar','Tahsas','Tir','Yekatit','Megabit','Miyazya','Ginbot','Sene','Hamle','Nehase','Pagume'])[p_m]
  end
$$;

-- e.g. app.to_ethiopian('2026-09-11') = 'Meskerem 1, 2019'; with 'am' → 'መስከረም 1, 2019'
create or replace function app.to_ethiopian(p_date date, p_lang text default 'en') returns text
language sql immutable as $$
  select app.ethiopian_month_name(e.m, p_lang) || ' ' || e.d || ', ' || e.y
  from app.ethiopian_parts(p_date) e
$$;

-- ISO-like 'YYYY-MM-DD' in the Ethiopian calendar (sortable, for exports).
create or replace function app.to_ethiopian_iso(p_date date) returns text
language sql immutable as $$
  select lpad(e.y::text, 4, '0') || '-' || lpad(e.m::text, 2, '0') || '-' || lpad(e.d::text, 2, '0')
  from app.ethiopian_parts(p_date) e
$$;

-- Ethiopian fiscal year runs Hamle 1 – Sene 30 (≈ 8 July – 7 July).
create or replace function app.eth_fiscal_year(p_date date) returns int
language sql immutable as $$
  select e.y + case when e.m >= 11 then 1 else 0 end from app.ethiopian_parts(p_date) e
$$;

-- -----------------------------------------------------------------------------
-- Column additions to existing tables
-- -----------------------------------------------------------------------------

alter table public.profiles
  add column if not exists locale text not null default 'en' check (locale in ('en','am')),
  add column if not exists calendar text not null default 'gregorian' check (calendar in ('gregorian','ethiopian'));

alter table public.materials add column if not exists name_am text;
alter table public.material_specs add column if not exists description_am text;
alter table public.activity_templates add column if not exists name_am text;

-- Project geofence (E2): centre + radius.
alter table public.projects
  add column if not exists site_lat double precision check (site_lat between -90 and 90),
  add column if not exists site_lng double precision check (site_lng between -180 and 180),
  add column if not exists site_radius_m int not null default 300 check (site_radius_m > 0);

-- Telegram approvals only up to this request value (null = no cap).
alter table public.project_settings
  add column if not exists telegram_approval_max_value numeric(18,2);

-- Tamper-evident evidence (E2).
alter table public.attachments
  add column if not exists captured_at timestamptz,
  add column if not exists sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  add column if not exists source text not null default 'camera' check (source in ('camera','gallery')),
  add column if not exists gps_accuracy_m real check (gps_accuracy_m >= 0),
  add column if not exists outside_site boolean,
  add column if not exists device_id uuid;

select app.extend_check_values('public.attachments', 'kind',
  array['photo','delivery_note','signature','document','proforma','batch_ticket','bbs','drawing','diary']);

-- Gate passes move stock out (gate_out) and back (gate_in); returnables sit in on_loan.
select app.extend_check_values('public.stock_ledger', 'txn_type', array['gate_out','gate_in']);
select app.extend_check_values('public.stock_ledger', 'stock_status', array['available','quarantine','on_loan']);

-- -----------------------------------------------------------------------------
-- D1 Gate passes & vehicle log
-- -----------------------------------------------------------------------------

create table public.gate_passes (
  id                uuid primary key,
  project_id        uuid not null references public.projects (id),
  number            text not null unique,
  pass_type         text not null check (pass_type in ('returnable','non_returnable')),
  store_id          uuid references public.stores (id),
  destination       text not null,
  purpose           text not null,
  vehicle_plate     text,
  driver_name       text,
  driver_phone      text,
  expected_return   date,
  linked_doc_type   text,
  linked_doc_id     uuid,
  status            text not null default 'draft'
                    check (status in ('draft','pending','approved','rejected','exited','partially_returned','returned','cancelled')),
  requested_by      uuid not null references public.profiles (id),
  submitted_at      timestamptz,
  approved_by       uuid references public.profiles (id),
  approved_at       timestamptz,
  decision_comment  text,
  qr_code           text,                    -- signed QR string, set on approval
  exited_at         timestamptz,
  returned_at       timestamptz,
  device_id         uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (pass_type <> 'returnable' or expected_return is not null)
);
create index gate_passes_project_idx on public.gate_passes (project_id, status);

create table public.gate_pass_lines (
  id                uuid primary key,
  gate_pass_id      uuid not null references public.gate_passes (id) on delete cascade,
  project_id        uuid not null references public.projects (id),
  line_no           int not null,
  material_spec_id  uuid references public.material_specs (id),
  description       text,
  qty               numeric(16,3) not null check (qty > 0),
  uom               text,
  qty_returned      numeric(16,3) not null default 0 check (qty_returned >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  check (material_spec_id is not null or description is not null),
  check (qty_returned <= qty)
);
create index gate_pass_lines_pass_idx on public.gate_pass_lines (gate_pass_id);

create table public.vehicle_movements (
  id               uuid primary key,
  project_id       uuid not null references public.projects (id),
  number           text not null unique,
  direction        text not null check (direction in ('in','out')),
  plate            text not null,
  driver_name      text,
  purpose          text,
  loaded           boolean not null default false,
  linked_doc_type  text check (linked_doc_type in ('grn','gate_pass','transfer','other')),
  linked_doc_id    uuid,
  flagged          boolean not null default false,   -- loaded exit without a linked document
  at               timestamptz not null,
  actor            uuid references public.profiles (id),
  device_id        uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index vehicle_movements_project_idx on public.vehicle_movements (project_id, at desc);

create table public.gate_events (
  id            uuid primary key,
  project_id    uuid not null references public.projects (id),
  gate_pass_id  uuid references public.gate_passes (id),
  event         text not null check (event in ('exit_verified','exit_mismatch','return_in')),
  plate_seen    text,
  matches       boolean,
  note          text,
  payload       jsonb,
  actor         uuid references public.profiles (id),
  at            timestamptz not null,
  device_id     uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index gate_events_pass_idx on public.gate_events (gate_pass_id);

-- -----------------------------------------------------------------------------
-- D2 Alert rules & alerts
-- -----------------------------------------------------------------------------

create table public.alert_rules (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects (id) on delete cascade,   -- null = company default
  rule        text not null check (rule in ('consumption_variance','large_adjustment','emergency_not_regularised',
                                            'gate_pass_overdue','delivery_outside_geofence')),
  threshold   numeric not null default 0,
  params      jsonb not null default '{}'::jsonb,
  severity    text not null default 'warning' check (severity in ('info','warning','critical')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique nulls not distinct (project_id, rule)
);

insert into public.alert_rules (project_id, rule, threshold, params, severity) values
  (null, 'consumption_variance',      5,   '{"note":"% over earned qty; project_settings.variance_thresholds per category wins"}', 'warning'),
  (null, 'large_adjustment',          100, '{"lookback_days":7}', 'warning'),
  (null, 'emergency_not_regularised', 24,  '{"unit":"hours"}', 'critical'),
  (null, 'gate_pass_overdue',         0,   '{"unit":"days grace"}', 'warning'),
  (null, 'delivery_outside_geofence', 0,   '{"lookback_days":7,"entity_types":["grn","vehicle_movement","gate_pass"]}', 'warning');

create table public.alerts (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  rule         text not null,
  severity     text not null check (severity in ('info','warning','critical')),
  entity_type  text,
  entity_id    uuid,
  dedupe_key   text not null,
  title        text not null,
  details      jsonb not null default '{}'::jsonb,
  status       text not null default 'open' check (status in ('open','acknowledged','closed')),
  acked_by     uuid references public.profiles (id),
  acked_at     timestamptz,
  closed_by    uuid references public.profiles (id),
  closed_at    timestamptz,
  close_note   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index alerts_open_dedupe_idx on public.alerts (project_id, rule, dedupe_key) where status <> 'closed';
create index alerts_project_idx on public.alerts (project_id, status, created_at desc);

-- -----------------------------------------------------------------------------
-- E1 QR labels & project keys
-- -----------------------------------------------------------------------------

create table public.qr_labels (
  id           uuid primary key,
  project_id   uuid not null references public.projects (id),
  entity_type  text not null check (entity_type in ('material','spec','store','element','tool','gate_pass','document')),
  entity_id    uuid not null,
  label        text,
  code         text not null unique,
  printed_at   timestamptz,
  printed_by   uuid references public.profiles (id),
  created_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index qr_labels_entity_idx on public.qr_labels (entity_type, entity_id);

-- Server-side secrets. RLS enabled with no policies: invisible to clients.
create table public.project_keys (
  project_id   uuid primary key references public.projects (id) on delete cascade,
  qr_secret    bytea not null,
  key_version  int not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- F1 Telegram & notification preferences
-- -----------------------------------------------------------------------------

create table public.telegram_links (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  chat_id    bigint not null unique,
  username   text,
  linked_at  timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.telegram_link_codes (            -- server only
  code        text primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.telegram_action_tokens (         -- server only
  token            text primary key,                 -- 16 chars base64url; callback_data = token:code (≤ 64 bytes)
  user_id          uuid not null references public.profiles (id) on delete cascade,
  project_id       uuid references public.projects (id) on delete cascade,
  entity_type      text not null,
  entity_id        uuid not null,
  allowed_actions  text[] not null,
  expires_at       timestamptz not null,
  used_at          timestamptz,
  used_action      text,
  result           jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index telegram_action_tokens_entity_idx on public.telegram_action_tokens (user_id, entity_id);

create table public.notification_prefs (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  event       text not null,           -- notifications.entity_type (material_request, grn, miv, alert, gate_pass, …) or '*'
  in_app      boolean not null default true,
  push        boolean not null default true,
  telegram    boolean not null default true,
  sms         boolean not null default false,
  quiet_from  time,                    -- local (EAT) time; critical notifications ignore quiet hours
  quiet_to    time,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, event)
);

create table public.project_channels (
  id          uuid primary key,
  project_id  uuid not null references public.projects (id) on delete cascade,
  chat_id     bigint not null,
  title       text,
  kinds       text[] not null default '{daily_summary,alerts}',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, chat_id)
);

-- -----------------------------------------------------------------------------
-- Triggers: updated_at, audit, immutability, indexes
-- -----------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['gate_passes','gate_pass_lines','vehicle_movements','gate_events','alert_rules','alerts',
    'qr_labels','project_keys','telegram_links','telegram_link_codes','telegram_action_tokens','notification_prefs',
    'project_channels'] loop
    execute format('create trigger touch_updated_at before update on public.%I
                    for each row execute function app.touch_updated_at()', t);
    execute format('create index %I on public.%I (updated_at)', t || '_updated_at_idx', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;

  foreach t in array array['gate_passes','gate_pass_lines','vehicle_movements','alert_rules','alerts','qr_labels',
    'telegram_links','project_channels'] loop
    execute format('create trigger audit after insert or update or delete on public.%I
                    for each row execute function app.audit()', t);
  end loop;

  foreach t in array array['gate_passes','vehicle_movements','alerts'] loop
    execute format('create trigger no_delete before delete on public.%I
                    for each row execute function app.block_mutation()', t);
  end loop;
end $$;

create trigger immutable before update or delete on public.gate_events
  for each row execute function app.block_mutation();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['gate_passes','gate_pass_lines','vehicle_movements','gate_events','alerts','qr_labels','project_channels'] loop
    execute format('create policy member_read on public.%I for select to authenticated using (app.is_member(project_id))', t);
  end loop;
end $$;

create policy read_all on public.alert_rules for select to authenticated
  using (app.is_active_user() and (project_id is null or app.is_member(project_id)));
create policy own_read on public.telegram_links for select to authenticated using (user_id = auth.uid());
create policy own_read on public.notification_prefs for select to authenticated using (user_id = auth.uid());
-- project_keys, telegram_link_codes, telegram_action_tokens: no policies (server only).

-- The gate guard sees gate passes and the vehicle log, not stock books.
do $$
declare t text;
begin
  foreach t in array array['stock_ledger','adjustments','adjustment_lines','stock_counts','stock_count_lines'] loop
    execute format($p$create policy not_security on public.%I as restrictive for select to authenticated
      using (coalesce(app.my_role()::text, '') <> 'security')$p$, t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- E2 Attachment evidence: server computes outside_site from the geofence
-- -----------------------------------------------------------------------------

create or replace function app.attachment_evidence() returns trigger
language plpgsql security definer set search_path = public as $$
declare pr record;
begin
  new.sha256 := lower(nullif(trim(new.sha256), ''));
  new.device_id := coalesce(new.device_id, app.device_id());
  select site_lat, site_lng, site_radius_m into pr from public.projects where id = new.project_id;
  if new.latitude is null or new.longitude is null or pr.site_lat is null or pr.site_lng is null then
    new.outside_site := null;          -- unknown
  else
    new.outside_site := app.distance_m(new.latitude, new.longitude, pr.site_lat, pr.site_lng) > pr.site_radius_m;
  end if;
  return new;
end $$;

create trigger evidence before insert or update on public.attachments
  for each row execute function app.attachment_evidence();

-- -----------------------------------------------------------------------------
-- Alerts
-- -----------------------------------------------------------------------------

create or replace function app.raise_alert(p_project uuid, p_rule text, p_severity text, p_entity_type text,
  p_entity uuid, p_key text, p_title text, p_details jsonb default '{}'::jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.alerts (project_id, rule, severity, entity_type, entity_id, dedupe_key, title, details)
  values (p_project, p_rule, p_severity, p_entity_type, p_entity, coalesce(p_key, p_entity::text), p_title, coalesce(p_details, '{}'))
  on conflict (project_id, rule, dedupe_key) where status <> 'closed' do nothing
  returning id into v_id;
  if v_id is null then return false; end if;
  perform app.notify_roles_txt(p_project, array['coordinator','manager'], 'Alert: ' || p_title,
    p_details ->> 'summary', 'alert', v_id, p_severity = 'critical');
  return true;
end $$;

-- Evaluate all active rules (project rule overrides the company default).
-- Schedule: select cron.schedule('run-alert-rules', '*/15 * * * *', 'select app.run_alert_rules()');
create or replace function app.run_alert_rules(p_project uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare
  r record; x record;
  v_n int := 0;
  v_days int;
begin
  for r in
    select distinct on (p.id, ar.rule) p.id as project_id, ar.rule, ar.threshold, ar.params, ar.severity, ar.is_active
    from public.projects p
    join public.alert_rules ar on ar.project_id = p.id or ar.project_id is null
    where p.is_active and (p_project is null or p.id = p_project)
    order by p.id, ar.rule, ar.project_id nulls last
  loop
    continue when not r.is_active;
    v_days := coalesce((r.params ->> 'lookback_days')::int, 7);

    if r.rule = 'consumption_variance' then
      for x in
        select c.element_id, c.element_code, c.material_spec_id, c.label, c.variance_pct, c.issued_qty, c.earned_qty,
               coalesce((ps.variance_thresholds ->> c.category)::numeric, r.threshold) as limit_pct
        from public.v_element_consumption c
        left join public.project_settings ps on ps.project_id = c.project_id
        where c.project_id = r.project_id
          and c.variance_pct > coalesce((ps.variance_thresholds ->> c.category)::numeric, r.threshold)
      loop
        if app.raise_alert(r.project_id, r.rule, r.severity, 'element', x.element_id, x.element_id || ':' || x.material_spec_id,
             'Over-issue of ' || x.label || ' on ' || x.element_code || ' (+' || x.variance_pct || '%)',
             jsonb_build_object('summary', 'Issued ' || x.issued_qty || ' vs ' || round(x.earned_qty, 3) || ' earned; limit ' || x.limit_pct || '%',
               'material_spec_id', x.material_spec_id, 'variance_pct', x.variance_pct, 'limit_pct', x.limit_pct)) then
          v_n := v_n + 1;
        end if;
      end loop;

    elsif r.rule = 'large_adjustment' then
      for x in
        select a.id, a.number, a.adj_type, sum(abs(l.qty_delta)) as qty
        from public.adjustments a join public.adjustment_lines l on l.adjustment_id = a.id
        where a.project_id = r.project_id and a.status = 'approved' and a.decided_at > now() - make_interval(days => v_days)
        group by a.id, a.number, a.adj_type
        having sum(abs(l.qty_delta)) > r.threshold
      loop
        if app.raise_alert(r.project_id, r.rule, r.severity, 'adjustment', x.id, null,
             'Large stock adjustment ' || x.number || ' (' || x.qty || ')',
             jsonb_build_object('summary', x.adj_type || ' of ' || x.qty || ' exceeds ' || r.threshold, 'qty', x.qty)) then
          v_n := v_n + 1;
        end if;
      end loop;

    elsif r.rule = 'emergency_not_regularised' then
      for x in
        select m.id, m.number, m.issued_at from public.mivs m
        where m.project_id = r.project_id and m.is_emergency and m.mr_id is null and m.status <> 'reversed'
          and m.issued_at < now() - make_interval(hours => r.threshold::int)
      loop
        if app.raise_alert(r.project_id, r.rule, r.severity, 'miv', x.id, null,
             'Emergency issue ' || x.number || ' not regularised',
             jsonb_build_object('summary', 'Issued ' || to_char(x.issued_at, 'DD Mon HH24:MI') || ', no approved request linked')) then
          v_n := v_n + 1;
        end if;
      end loop;

    elsif r.rule = 'gate_pass_overdue' then
      for x in
        select g.id, g.number, g.expected_return, g.destination from public.gate_passes g
        where g.project_id = r.project_id and g.pass_type = 'returnable' and g.status in ('exited','partially_returned')
          and g.expected_return < app.eat_now()::date - r.threshold::int
      loop
        if app.raise_alert(r.project_id, r.rule, r.severity, 'gate_pass', x.id, null,
             'Gate pass ' || x.number || ' overdue for return',
             jsonb_build_object('summary', 'Expected back ' || x.expected_return || ' from ' || x.destination)) then
          v_n := v_n + 1;
        end if;
      end loop;

    elsif r.rule = 'delivery_outside_geofence' then
      for x in
        select a.entity_type, a.entity_id, min(a.created_at) as at, count(*) as photos from public.attachments a
        where a.project_id = r.project_id and a.outside_site
          and a.entity_type = any (coalesce(array(select jsonb_array_elements_text(r.params -> 'entity_types')), array['grn']))
          and a.created_at > now() - make_interval(days => v_days)
        group by a.entity_type, a.entity_id
      loop
        if app.raise_alert(r.project_id, r.rule, r.severity, x.entity_type, x.entity_id, null,
             'Evidence captured outside the site geofence (' || x.entity_type || ')',
             jsonb_build_object('summary', x.photos || ' photo(s) taken outside the site radius')) then
          v_n := v_n + 1;
        end if;
      end loop;
    end if;
  end loop;
  return v_n;
end $$;

revoke execute on function app.run_alert_rules(uuid) from public;

create or replace function public.evaluate_alerts(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform app.require_member((p ->> 'project_id')::uuid);
  perform app.require_role('coordinator','manager','admin');
  return jsonb_build_object('ok', true, 'created', app.run_alert_rules((p ->> 'project_id')::uuid));
end $$;

create or replace function public.alert_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  a public.alerts;
  v_action text := p ->> 'action';
  v_note text := nullif(trim(p ->> 'note'), '');
begin
  if v_seen is not null then return v_seen; end if;
  select * into a from public.alerts where id = (p ->> 'alert_id')::uuid for update;
  if not found then raise exception 'Alert not found'; end if;
  perform app.require_member(a.project_id);
  perform app.require_role('coordinator','manager','admin');
  if a.status = 'closed' then raise exception 'Alert already closed'; end if;
  if v_action = 'acknowledge' then
    update public.alerts set status = 'acknowledged', acked_by = auth.uid(), acked_at = now() where id = a.id;
  elsif v_action = 'close' then
    if v_note is null then raise exception 'A closing note is required'; end if;
    update public.alerts set status = 'closed', closed_by = auth.uid(), closed_at = now(), close_note = v_note where id = a.id;
  else
    raise exception 'Unknown action %', v_action;
  end if;
  return app.op_done(p, 'alert_action', jsonb_build_object('ok', true, 'id', a.id,
    'status', (select status from public.alerts where id = a.id)));
end $$;

create or replace function public.save_alert_rule(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_project uuid := (p ->> 'project_id')::uuid;
  v_id uuid;
begin
  if v_seen is not null then return v_seen; end if;
  if v_project is null then
    perform app.require_role('admin');
  else
    perform app.require_member(v_project);
    perform app.require_role('coordinator','manager','admin');
  end if;
  insert into public.alert_rules (project_id, rule, threshold, params, severity, is_active)
  values (v_project, p ->> 'rule', coalesce((p ->> 'threshold')::numeric, 0), coalesce(p -> 'params', '{}'),
    coalesce(p ->> 'severity', 'warning'), coalesce((p ->> 'is_active')::boolean, true))
  on conflict (project_id, rule) do update set
    threshold = coalesce((p ->> 'threshold')::numeric, public.alert_rules.threshold),
    params = coalesce(p -> 'params', public.alert_rules.params),
    severity = coalesce(p ->> 'severity', public.alert_rules.severity),
    is_active = coalesce((p ->> 'is_active')::boolean, public.alert_rules.is_active)
  returning id into v_id;
  return app.op_done(p, 'save_alert_rule', jsonb_build_object('ok', true, 'id', v_id));
end $$;

-- -----------------------------------------------------------------------------
-- E1 QR signing. Format (documented in shared/contract-control.ts):
--   SM1:<entity_type>:<project_id>:<entity_id>:<sig>
--   sig = base64url( first 16 bytes of HMAC-SHA256(project key, everything before ":<sig>") )
-- -----------------------------------------------------------------------------

create or replace function app.qr_key(p_project uuid) returns bytea
language plpgsql security definer set search_path = public as $$
declare k bytea;
begin
  select qr_secret into k from public.project_keys where project_id = p_project;
  if k is null then
    insert into public.project_keys (project_id, qr_secret) values (p_project, app.random_bytes(32))
    on conflict (project_id) do nothing;
    select qr_secret into k from public.project_keys where project_id = p_project;
  end if;
  return k;
end $$;

create or replace function app.qr_sign(p_project uuid, p_entity_type text, p_entity uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_msg text := 'SM1:' || p_entity_type || ':' || p_project || ':' || p_entity;
begin
  return v_msg || ':' || app.b64url(substring(app.hmac_sha256(app.qr_key(p_project), convert_to(v_msg, 'UTF8')) from 1 for 16));
end $$;

create or replace function app.qr_verify(p_code text,
  out valid boolean, out project_id uuid, out entity_type text, out entity_id uuid)
language plpgsql security definer set search_path = public as $$
declare parts text[] := string_to_array(p_code, ':');
begin
  valid := false;
  if array_length(parts, 1) <> 5 or parts[1] <> 'SM1' then return; end if;
  begin
    project_id := parts[3]::uuid; entity_id := parts[4]::uuid;
  exception when others then return;
  end;
  entity_type := parts[2];
  if not exists (select 1 from public.project_keys k where k.project_id = qr_verify.project_id) then return; end if;
  valid := app.qr_sign(project_id, entity_type, entity_id) = p_code;
end $$;

revoke execute on function app.qr_key(uuid) from public;

create or replace function public.sign_qr(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_project uuid := (p ->> 'project_id')::uuid;
begin
  perform app.require_member(v_project);
  if (p ->> 'entity_id') is null or coalesce(p ->> 'entity_type', '') !~ '^[a-z_]+$' then raise exception 'entity_type and entity_id are required'; end if;
  return jsonb_build_object('ok', true, 'code', app.qr_sign(v_project, p ->> 'entity_type', (p ->> 'entity_id')::uuid));
end $$;

create or replace function public.verify_qr(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v record;
begin
  select * into v from app.qr_verify(p ->> 'code');
  if v.valid and not app.is_member(v.project_id) then
    return jsonb_build_object('valid', true, 'project_id', v.project_id, 'member', false);
  end if;
  return jsonb_build_object('valid', coalesce(v.valid, false), 'project_id', v.project_id,
    'entity_type', v.entity_type, 'entity_id', v.entity_id, 'member', coalesce(v.valid, false));
end $$;

-- Key for offline verification; only roles that verify at the gate / store get it.
create or replace function public.get_qr_key(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_project uuid := (p ->> 'project_id')::uuid;
begin
  perform app.require_member(v_project);
  perform app.require_role_txt('security','store_keeper','coordinator','manager','admin');
  return jsonb_build_object('project_id', v_project, 'alg', 'HMAC-SHA256-128', 'format', 'SM1',
    'key_hex', encode(app.qr_key(v_project), 'hex'),
    'key_version', (select key_version from public.project_keys where project_id = v_project));
end $$;

create or replace function public.register_qr_labels(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_project uuid := (p ->> 'project_id')::uuid;
  l jsonb;
  v_out jsonb := '[]'::jsonb;
  v_code text;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('store_keeper','office_engineer','coordinator','manager','admin');
  for l in select * from jsonb_array_elements(coalesce(p -> 'labels', '[]'::jsonb)) loop
    v_code := app.qr_sign(v_project, l ->> 'entity_type', (l ->> 'entity_id')::uuid);
    insert into public.qr_labels (id, project_id, entity_type, entity_id, label, code, created_by)
    values ((l ->> 'id')::uuid, v_project, l ->> 'entity_type', (l ->> 'entity_id')::uuid, nullif(l ->> 'label', ''), v_code, auth.uid())
    on conflict (id) do update set label = excluded.label, deleted_at = null
    where public.qr_labels.project_id = v_project;
    v_out := v_out || jsonb_build_object('id', l ->> 'id', 'code', v_code);
  end loop;
  return app.op_done(p, 'register_qr_labels', jsonb_build_object('ok', true, 'labels', v_out));
end $$;

create or replace function public.mark_qr_printed(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update public.qr_labels set printed_at = now(), printed_by = auth.uid()
  where id in (select (jsonb_array_elements_text(coalesce(p -> 'ids', '[]'::jsonb)))::uuid)
    and app.is_member(project_id) and app.has_role('store_keeper','office_engineer','coordinator','manager','admin');
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'updated', v_n);
end $$;

-- -----------------------------------------------------------------------------
-- D1 Gate pass RPCs
-- -----------------------------------------------------------------------------

create or replace function public.save_gate_pass(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  v_type text := coalesce(p ->> 'pass_type', 'returnable');
  v_store uuid := (p ->> 'store_id')::uuid;
  v_submit boolean := coalesce((p ->> 'submit')::boolean, false);
  g public.gate_passes;
  l jsonb; v_n int := 0; v_ids uuid[] := '{}';
  v_status text;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('store_keeper','site_engineer','office_engineer','coordinator','manager','admin');
  if v_type not in ('returnable','non_returnable') then raise exception 'Gate pass type must be returnable or non_returnable'; end if;
  if coalesce(trim(p ->> 'destination'), '') = '' then raise exception 'Destination is required'; end if;
  if coalesce(trim(p ->> 'purpose'), '') = '' then raise exception 'Purpose is required'; end if;
  if v_type = 'returnable' and p ->> 'expected_return' is null then
    raise exception 'Expected return date is required for a returnable gate pass';
  end if;
  if v_store is not null then perform app.require_store(v_project, v_store); end if;

  select * into g from public.gate_passes where id = v_id for update;
  if found then
    if g.project_id <> v_project then raise exception 'Gate pass belongs to another project'; end if;
    if g.requested_by <> auth.uid() and not app.has_role('coordinator','manager','admin') then
      raise exception 'Only the requester can edit this gate pass';
    end if;
    if g.status not in ('draft','pending','rejected') then
      raise exception 'Gate pass % can no longer be edited (status: %)', g.number, g.status;
    end if;
    update public.gate_passes set pass_type = v_type, store_id = v_store,
      destination = trim(p ->> 'destination'), purpose = trim(p ->> 'purpose'),
      vehicle_plate = nullif(trim(p ->> 'vehicle_plate'), ''), driver_name = nullif(p ->> 'driver_name', ''),
      driver_phone = nullif(p ->> 'driver_phone', ''), expected_return = (p ->> 'expected_return')::date,
      linked_doc_type = nullif(p ->> 'linked_doc_type', ''), linked_doc_id = (p ->> 'linked_doc_id')::uuid,
      status = 'draft', decision_comment = null
    where id = v_id;
  else
    insert into public.gate_passes (id, project_id, number, pass_type, store_id, destination, purpose, vehicle_plate,
      driver_name, driver_phone, expected_return, linked_doc_type, linked_doc_id, requested_by, device_id)
    values (v_id, v_project, p ->> 'number', v_type, v_store, trim(p ->> 'destination'), trim(p ->> 'purpose'),
      nullif(trim(p ->> 'vehicle_plate'), ''), nullif(p ->> 'driver_name', ''), nullif(p ->> 'driver_phone', ''),
      (p ->> 'expected_return')::date, nullif(p ->> 'linked_doc_type', ''), (p ->> 'linked_doc_id')::uuid,
      auth.uid(), app.device_id());
  end if;

  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_n := v_n + 1;
    if coalesce((l ->> 'qty')::numeric, 0) <= 0 then raise exception 'Line %: quantity must be greater than zero', v_n; end if;
    if l ->> 'material_spec_id' is null and coalesce(trim(l ->> 'description'), '') = '' then
      raise exception 'Line %: choose a material or describe the item', v_n;
    end if;
    if l ->> 'material_spec_id' is not null and v_store is null then
      raise exception 'Line %: a store is required for stock items', v_n;
    end if;
    v_ids := v_ids || (l ->> 'id')::uuid;
    insert into public.gate_pass_lines (id, gate_pass_id, project_id, line_no, material_spec_id, description, qty, uom)
    values ((l ->> 'id')::uuid, v_id, v_project, v_n, (l ->> 'material_spec_id')::uuid, nullif(trim(l ->> 'description'), ''),
      (l ->> 'qty')::numeric,
      coalesce(nullif(l ->> 'uom', ''), (select uom from public.material_specs where id = (l ->> 'material_spec_id')::uuid)))
    on conflict (id) do update set line_no = excluded.line_no, material_spec_id = excluded.material_spec_id,
      description = excluded.description, qty = excluded.qty, uom = excluded.uom, deleted_at = null
    where public.gate_pass_lines.gate_pass_id = v_id;
  end loop;
  if v_n = 0 then raise exception 'A gate pass needs at least one line'; end if;
  update public.gate_pass_lines set deleted_at = now()
    where gate_pass_id = v_id and deleted_at is null and not (id = any (v_ids));

  if v_submit then
    update public.gate_passes set status = 'pending', submitted_at = now() where id = v_id
    returning * into g;
    perform app.notify_roles_txt(v_project, array['coordinator','manager'], 'Gate pass to approve: ' || g.number,
      initcap(replace(g.pass_type, '_', '-')) || ' to ' || g.destination || ' — ' || g.purpose, 'gate_pass', v_id,
      g.pass_type = 'non_returnable');
  end if;
  select status into v_status from public.gate_passes where id = v_id;
  return app.op_done(p, 'save_gate_pass', jsonb_build_object('ok', true, 'id', v_id, 'status', v_status));
end $$;

create or replace function public.gate_pass_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_action text := p ->> 'action';
  v_comment text := nullif(trim(p ->> 'comment'), '');
  g public.gate_passes;
  s record;
  v_to text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into g from public.gate_passes where id = (p ->> 'gate_pass_id')::uuid for update;
  if not found then raise exception 'Gate pass not found'; end if;
  perform app.require_member(g.project_id);

  case v_action
  when 'approve' then
    perform app.require_role('coordinator','manager','admin');
    if g.status <> 'pending' then raise exception 'Only pending gate passes can be approved (status: %)', g.status; end if;
    for s in
      select l.material_spec_id, sum(l.qty) as qty from public.gate_pass_lines l
      where l.gate_pass_id = g.id and l.deleted_at is null and l.material_spec_id is not null
      group by l.material_spec_id
    loop
      if app.stock_qty(g.store_id, s.material_spec_id) < s.qty then
        raise exception 'Insufficient available stock of %: available %, on gate pass %',
          app.spec_label(s.material_spec_id), app.stock_qty(g.store_id, s.material_spec_id), s.qty;
      end if;
    end loop;
    v_to := 'approved';
    update public.gate_passes set approved_by = auth.uid(), approved_at = now(), decision_comment = v_comment,
      qr_code = app.qr_sign(g.project_id, 'gate_pass', g.id)
    where id = g.id;
    perform app.notify_roles_txt(g.project_id, array['security'], 'Gate pass approved: ' || g.number,
      coalesce(g.vehicle_plate || ' — ', '') || g.destination, 'gate_pass', g.id);

  when 'reject' then
    perform app.require_role('coordinator','manager','admin');
    if v_comment is null then raise exception 'A reason is required to reject'; end if;
    if g.status <> 'pending' then raise exception 'Only pending gate passes can be rejected'; end if;
    v_to := 'rejected';
    update public.gate_passes set decision_comment = v_comment where id = g.id;

  when 'cancel' then
    if g.requested_by <> auth.uid() and not app.has_role('coordinator','manager','admin') then
      raise exception 'Only the requester or management can cancel';
    end if;
    if g.status not in ('draft','pending','approved','rejected') then raise exception 'Gate pass cannot be cancelled after exit'; end if;
    v_to := 'cancelled';

  else
    raise exception 'Unknown action %', v_action;
  end case;

  update public.gate_passes set status = v_to where id = g.id;
  perform app.notify_user(g.requested_by, g.project_id, 'Gate pass ' || g.number || ': ' || v_action,
    coalesce(v_comment, 'Status: ' || v_to), 'gate_pass', g.id);
  return app.op_done(p, 'gate_pass_action', jsonb_build_object('ok', true, 'id', g.id, 'status', v_to));
end $$;

-- Guard checks the vehicle out. On match stock leaves (non-returnable) or moves to on_loan (returnable).
create or replace function public.verify_gate_pass(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_event uuid := (p ->> 'id')::uuid;
  v_at timestamptz := coalesce((p ->> 'at')::timestamptz, now());
  g public.gate_passes;
  l public.gate_pass_lines;
  v_match boolean;
  v_reason text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into g from public.gate_passes where id = (p ->> 'gate_pass_id')::uuid for update;
  if not found then raise exception 'Gate pass not found'; end if;
  perform app.require_member(g.project_id);
  perform app.require_role_txt('security','store_keeper','coordinator','manager','admin');
  if g.status <> 'approved' then
    raise exception 'Gate pass % is not approved for exit (status: %)', g.number, g.status;
  end if;

  v_match := coalesce((p ->> 'matches')::boolean, false);
  if v_match and g.vehicle_plate is not null and app.norm_plate(p ->> 'plate_seen') is distinct from app.norm_plate(g.vehicle_plate) then
    v_match := false;
    v_reason := 'Plate seen ' || coalesce(p ->> 'plate_seen', '—') || ' ≠ ' || g.vehicle_plate;
  end if;

  insert into public.gate_events (id, project_id, gate_pass_id, event, plate_seen, matches, note, actor, at, device_id)
  values (v_event, g.project_id, g.id, case when v_match then 'exit_verified' else 'exit_mismatch' end,
    nullif(p ->> 'plate_seen', ''), v_match, coalesce(nullif(p ->> 'note', ''), v_reason), auth.uid(), v_at, app.device_id());

  if v_match then
    for l in select * from public.gate_pass_lines where gate_pass_id = g.id and deleted_at is null and material_spec_id is not null
             order by line_no loop
      perform app.require_stock(g.store_id, l.material_spec_id, l.qty);
      perform app.post_ledger(g.project_id, g.store_id, l.material_spec_id, -l.qty, 'available', 'gate_out',
        'gate_pass', g.id, g.number, l.id, null, null, null, v_at);
      if g.pass_type = 'returnable' then
        perform app.post_ledger(g.project_id, g.store_id, l.material_spec_id, l.qty, 'on_loan', 'gate_out',
          'gate_pass', g.id, g.number, l.id, null, null, null, v_at);
      end if;
    end loop;
    update public.gate_passes set status = 'exited', exited_at = v_at where id = g.id;
    perform app.notify_user(g.requested_by, g.project_id, 'Gate pass ' || g.number || ' left site',
      coalesce(p ->> 'plate_seen', g.vehicle_plate), 'gate_pass', g.id);
  else
    perform app.raise_alert(g.project_id, 'gate_mismatch', 'critical', 'gate_pass', g.id, v_event::text,
      'Gate pass ' || g.number || ': load or vehicle mismatch at gate',
      jsonb_build_object('summary', coalesce(nullif(p ->> 'note', ''), v_reason, 'Guard reported mismatch'),
        'plate_seen', p ->> 'plate_seen', 'event_id', v_event));
  end if;

  return app.op_done(p, 'verify_gate_pass', jsonb_build_object('ok', true, 'id', g.id, 'event_id', v_event,
    'matched', v_match, 'status', case when v_match then 'exited' else g.status end));
end $$;

create or replace function public.return_gate_pass(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_event uuid := (p ->> 'id')::uuid;
  v_at timestamptz := coalesce((p ->> 'at')::timestamptz, now());
  g public.gate_passes;
  gl public.gate_pass_lines;
  x jsonb; v_q numeric; v_n int := 0;
  v_status text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into g from public.gate_passes where id = (p ->> 'gate_pass_id')::uuid for update;
  if not found then raise exception 'Gate pass not found'; end if;
  perform app.require_member(g.project_id);
  perform app.require_role_txt('security','store_keeper','coordinator','manager','admin');
  if g.pass_type <> 'returnable' or g.status not in ('exited','partially_returned') then
    raise exception 'Only returnable gate passes that have left site can be returned (status: %)', g.status;
  end if;

  insert into public.gate_events (id, project_id, gate_pass_id, event, plate_seen, matches, note, payload, actor, at, device_id)
  values (v_event, g.project_id, g.id, 'return_in', nullif(p ->> 'plate_seen', ''), true, nullif(p ->> 'note', ''),
    p -> 'lines', auth.uid(), v_at, app.device_id());

  for x in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_n := v_n + 1;
    select * into gl from public.gate_pass_lines
      where id = (x ->> 'gate_pass_line_id')::uuid and gate_pass_id = g.id and deleted_at is null for update;
    if not found then raise exception 'Line %: not on this gate pass', v_n; end if;
    v_q := coalesce((x ->> 'qty_returned')::numeric, 0);
    if v_q <= 0 then raise exception 'Line %: returned quantity must be greater than zero', v_n; end if;
    if v_q > gl.qty - gl.qty_returned + 0.0005 then
      raise exception 'Line %: returning % but only % is out', v_n, v_q, gl.qty - gl.qty_returned;
    end if;
    update public.gate_pass_lines set qty_returned = qty_returned + v_q where id = gl.id;
    if gl.material_spec_id is not null then
      perform app.require_stock(g.store_id, gl.material_spec_id, v_q, 'on_loan');
      perform app.post_ledger(g.project_id, g.store_id, gl.material_spec_id, -v_q, 'on_loan', 'gate_in',
        'gate_pass', g.id, g.number, gl.id, null, null, null, v_at);
      perform app.post_ledger(g.project_id, g.store_id, gl.material_spec_id, v_q, 'available', 'gate_in',
        'gate_pass', g.id, g.number, gl.id, null, null, null, v_at);
    end if;
  end loop;
  if v_n = 0 then raise exception 'Enter the returned quantities'; end if;

  v_status := case when exists (select 1 from public.gate_pass_lines where gate_pass_id = g.id and deleted_at is null
                                  and qty_returned < qty) then 'partially_returned' else 'returned' end;
  update public.gate_passes set status = v_status, returned_at = case when v_status = 'returned' then v_at end where id = g.id;
  if v_status = 'returned' then
    update public.alerts set status = 'closed', closed_at = now(), closed_by = auth.uid(), close_note = 'Returned'
      where project_id = g.project_id and rule = 'gate_pass_overdue' and entity_id = g.id and status <> 'closed';
  end if;
  return app.op_done(p, 'return_gate_pass', jsonb_build_object('ok', true, 'id', g.id, 'status', v_status));
end $$;

create or replace function public.log_vehicle(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  v_dir text := p ->> 'direction';
  v_loaded boolean := coalesce((p ->> 'loaded')::boolean, false);
  v_doc_type text := nullif(p ->> 'linked_doc_type', '');
  v_doc uuid := (p ->> 'linked_doc_id')::uuid;
  v_flag boolean;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role_txt('security','store_keeper','coordinator','manager','admin');
  if v_dir not in ('in','out') then raise exception 'Direction must be in or out'; end if;
  if app.norm_plate(p ->> 'plate') is null then raise exception 'Plate number is required'; end if;
  if v_doc is not null and v_doc_type in ('grn','gate_pass') then
    if (v_doc_type = 'grn' and not exists (select 1 from public.grns where id = v_doc and project_id = v_project))
       or (v_doc_type = 'gate_pass' and not exists (select 1 from public.gate_passes where id = v_doc and project_id = v_project)) then
      raise exception 'Linked % not found in this project', v_doc_type;
    end if;
  end if;
  v_flag := v_dir = 'out' and v_loaded and v_doc is null;

  insert into public.vehicle_movements (id, project_id, number, direction, plate, driver_name, purpose, loaded,
    linked_doc_type, linked_doc_id, flagged, at, actor, device_id)
  values (v_id, v_project, p ->> 'number', v_dir, upper(trim(p ->> 'plate')), nullif(p ->> 'driver_name', ''),
    nullif(p ->> 'purpose', ''), v_loaded, v_doc_type, v_doc, v_flag, coalesce((p ->> 'at')::timestamptz, now()),
    auth.uid(), app.device_id());

  if v_flag then
    perform app.raise_alert(v_project, 'unmatched_vehicle_exit', 'critical', 'vehicle_movement', v_id, null,
      'Loaded vehicle ' || upper(trim(p ->> 'plate')) || ' left without a gate pass',
      jsonb_build_object('summary', coalesce(p ->> 'purpose', 'No document linked'), 'number', p ->> 'number'));
  end if;
  return app.op_done(p, 'log_vehicle', jsonb_build_object('ok', true, 'id', v_id, 'flagged', v_flag));
end $$;

-- -----------------------------------------------------------------------------
-- F3 Approval inbox
-- -----------------------------------------------------------------------------

create or replace function app.approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_role text;
begin
  -- Users may only read their own inbox; server contexts (service role, pg_cron) may read anyone's.
  if p_user is distinct from auth.uid()
     and (auth.uid() is not null or coalesce(auth.role(), '') in ('anon','authenticated')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null then return; end if;

  return query
  with mem as (
    select pm.project_id as pid from public.project_members pm where pm.user_id = p_user
    union select pj.id from public.projects pj where v_role = 'admin'
  )
  select x.kind, x.entity_type, x.entity_id, x.project_id, x.number, x.title, x.status, x.requested_by, x.requested_at,
         x.is_urgent, x.actions, round((extract(epoch from now() - coalesce(x.requested_at, now())) / 3600)::numeric, 1)
  from (
    select 'mr_review'::text as kind, 'material_request'::text as entity_type, r.id as entity_id, r.project_id, r.number,
           'Review material request ' || r.number as title, r.status::text as status, r.requested_by,
           r.submitted_at as requested_at, r.priority <> 'normal' as is_urgent, array['review','return'] as actions
    from public.material_requests r join public.project_settings s on s.project_id = r.project_id
    where r.project_id in (select pid from mem) and r.status = 'submitted' and s.require_review
      and v_role = 'office_engineer'
    union all
    select 'mr_approve', 'material_request', r.id, r.project_id, r.number, 'Approve material request ' || r.number,
           r.status::text, r.requested_by, coalesce(r.reviewed_at, r.submitted_at), r.priority <> 'normal',
           array['approve','reject','return']
    from public.material_requests r join public.project_settings s on s.project_id = r.project_id
    where r.project_id in (select pid from mem) and v_role in ('coordinator','manager','admin')
      and (r.status = 'reviewed' or (r.status = 'submitted' and not s.require_review))
    union all
    select 'adjustment', 'adjustment', a.id, a.project_id, a.number, 'Approve ' || replace(a.adj_type, '_', ' ') || ' ' || a.number,
           a.status, a.requested_by, a.created_at, false, array['approve','reject']
    from public.adjustments a
    where a.project_id in (select pid from mem) and a.status = 'pending' and v_role in ('coordinator','manager','admin')
    union all
    select 'stock_count', 'stock_count', c.id, c.project_id, c.number, 'Approve stock count ' || c.number,
           c.status, c.counted_by, c.counted_at, false, array['approve','reject']
    from public.stock_counts c
    where c.project_id in (select pid from mem) and c.status = 'submitted' and v_role in ('coordinator','manager','admin')
    union all
    select 'progress_verify', 'progress_update', u.id, u.project_id, e.code,
           'Verify ' || ea.name || ' on ' || e.code || ' (' || u.pct_complete || '%)',
           u.status, u.reported_by, u.created_at, false, array['approve','reject']
    from public.progress_updates u
    join public.element_activities ea on ea.id = u.element_activity_id
    join public.elements e on e.id = u.element_id
    where u.project_id in (select pid from mem) and u.status = 'reported' and u.reported_by <> p_user
      and v_role in ('office_engineer','coordinator','manager','admin')
    union all
    select 'gate_pass_approve', 'gate_pass', g.id, g.project_id, g.number,
           'Approve ' || replace(g.pass_type, '_', '-') || ' gate pass ' || g.number,
           g.status, g.requested_by, g.submitted_at, g.pass_type = 'non_returnable', array['approve','reject']
    from public.gate_passes g
    where g.project_id in (select pid from mem) and g.status = 'pending' and v_role in ('coordinator','manager','admin')
    union all
    select 'gate_exit', 'gate_pass', g.id, g.project_id, g.number,
           'Check out ' || g.number || coalesce(' — ' || g.vehicle_plate, ''),
           g.status, g.requested_by, g.approved_at, false, array['verify']
    from public.gate_passes g
    where g.project_id in (select pid from mem) and g.status = 'approved' and v_role = 'security'
    union all
    select 'miv_ack', 'miv', m.id, m.project_id, m.number, 'Acknowledge materials received ' || m.number,
           m.status, m.issued_by, m.issued_at, false, array['acknowledge']
    from public.mivs m
    where m.project_id in (select pid from mem) and m.status = 'pending_ack' and m.issued_to = p_user
  ) x;

  -- Purchase orders (migration 0005: status 'submitted' awaits coordinator/manager), when present.
  if to_regclass('public.purchase_orders') is not null and v_role in ('coordinator','manager','admin') then
    begin
      return query execute $q$
        select 'po_approve'::text, 'purchase_order'::text, po.id, po.project_id, po.number::text,
               ('Approve purchase order ' || po.number)::text, po.status::text, po.created_by,
               coalesce(po.submitted_at, po.created_at), false, array['approve','reject']::text[],
               round((extract(epoch from now() - coalesce(po.submitted_at, po.created_at)) / 3600)::numeric, 1)
        from public.purchase_orders po
        where po.status = 'submitted'
          and po.project_id in (select pm.project_id from public.project_members pm where pm.user_id = $1
                                union select pj.id from public.projects pj where $2 = 'admin')
      $q$ using p_user, v_role;
    exception when others then
      null;   -- different PO shape; skip rather than break the inbox
    end;
  end if;
end $$;

create or replace view public.v_my_approvals as
select * from app.approvals_for(auth.uid());

grant select on public.v_my_approvals to authenticated;

-- -----------------------------------------------------------------------------
-- F1 Telegram linking & preferences (user RPCs)
-- -----------------------------------------------------------------------------

create or replace function public.create_telegram_link_code(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_code text; v_exp timestamptz := now() + interval '15 minutes';
begin
  if not app.is_active_user() then raise exception 'Account is inactive' using errcode = '42501'; end if;
  delete from public.telegram_link_codes where user_id = auth.uid() and used_at is null;
  v_code := app.b64url(app.random_bytes(9));
  insert into public.telegram_link_codes (code, user_id, expires_at) values (v_code, auth.uid(), v_exp);
  return jsonb_build_object('ok', true, 'code', v_code, 'expires_at', v_exp);
end $$;

create or replace function public.unlink_telegram(p jsonb) returns jsonb
language sql security definer set search_path = public as $$
  delete from public.telegram_links where user_id = auth.uid();
  select jsonb_build_object('ok', true);
$$;

create or replace function public.set_notification_prefs(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  x jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  if not app.is_active_user() then raise exception 'Account is inactive' using errcode = '42501'; end if;
  for x in select * from jsonb_array_elements(coalesce(p -> 'prefs', '[]'::jsonb)) loop
    if coalesce(x ->> 'event', '') = '' then raise exception 'event is required ("*" for all)'; end if;
    insert into public.notification_prefs (user_id, event, in_app, push, telegram, sms, quiet_from, quiet_to)
    values (auth.uid(), x ->> 'event', coalesce((x ->> 'in_app')::boolean, true), coalesce((x ->> 'push')::boolean, true),
      coalesce((x ->> 'telegram')::boolean, true), coalesce((x ->> 'sms')::boolean, false),
      (x ->> 'quiet_from')::time, (x ->> 'quiet_to')::time)
    on conflict (user_id, event) do update set in_app = excluded.in_app, push = excluded.push,
      telegram = excluded.telegram, sms = excluded.sms, quiet_from = excluded.quiet_from, quiet_to = excluded.quiet_to;
  end loop;
  return app.op_done(p, 'set_notification_prefs', jsonb_build_object('ok', true));
end $$;

create or replace function public.save_project_channel(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_project uuid := (p ->> 'project_id')::uuid;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('coordinator','manager','admin');
  insert into public.project_channels (id, project_id, chat_id, title, kinds, is_active)
  values ((p ->> 'id')::uuid, v_project, (p ->> 'chat_id')::bigint, nullif(p ->> 'title', ''),
    coalesce(array(select jsonb_array_elements_text(p -> 'kinds')), '{daily_summary,alerts}'),
    coalesce((p ->> 'is_active')::boolean, true))
  on conflict (id) do update set chat_id = excluded.chat_id, title = excluded.title, kinds = excluded.kinds,
    is_active = excluded.is_active
  where public.project_channels.project_id = v_project;
  return app.op_done(p, 'save_project_channel', jsonb_build_object('ok', true, 'id', p ->> 'id'));
end $$;

create or replace function public.set_my_locale(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set locale = coalesce(p ->> 'locale', locale), calendar = coalesce(p ->> 'calendar', calendar)
  where id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

-- -----------------------------------------------------------------------------
-- F1 Telegram action tokens & run-as
-- -----------------------------------------------------------------------------

-- Actions that may be executed from a Telegram button (all others: open the app).
create or replace function app.telegram_action_code(p_action text) returns text
language sql immutable as $$
  select case p_action when 'approve' then 'ap' when 'reject' then 'rj' when 'review' then 'rv'
                       when 'return' then 'rt' when 'acknowledge' then 'ak' end
$$;

create or replace function app.telegram_action_from_code(p_code text) returns text
language sql immutable as $$
  select case p_code when 'ap' then 'approve' when 'rj' then 'reject' when 'rv' then 'review'
                     when 'rt' then 'return' when 'ak' then 'acknowledge' else p_code end
$$;

create or replace function app.issue_action_token(p_user uuid, p_project uuid, p_entity_type text, p_entity uuid,
  p_actions text[], p_ttl interval default interval '72 hours') returns text
language plpgsql security definer set search_path = public as $$
declare v_token text := app.b64url(app.random_bytes(12));
begin
  insert into public.telegram_action_tokens (token, user_id, project_id, entity_type, entity_id, allowed_actions, expires_at)
  values (v_token, p_user, p_project, p_entity_type, p_entity, p_actions, now() + p_ttl);
  return v_token;
end $$;

-- Executes a Telegram button action AS the token's user: request.jwt.claim.sub
-- is set for the rest of this transaction, so the regular RPC applies the
-- user's role, membership, approval limits, audit (user id) and notifications.
-- Single-use: the token (and the user's other tokens for the same entity) is
-- consumed on success. On failure the transaction rolls back and the token
-- stays usable (e.g. a reject that still needs a reason).
create or replace function app.run_action_as(p_token text, p_action text, p_comment text default null,
  p_chat_id bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t public.telegram_action_tokens;
  v_prev_sub text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_prev_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
  v_prev_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_res jsonb;
  v_op uuid := gen_random_uuid();
  v_cap numeric; v_value numeric;
begin
  select * into t from public.telegram_action_tokens where token = p_token for update;
  if not found then raise exception 'This button is not valid' using errcode = '42501'; end if;
  if t.used_at is not null then raise exception 'This button was already used' using errcode = '42501'; end if;
  if t.expires_at < now() then raise exception 'This button has expired — please open the app' using errcode = '42501'; end if;
  if not (p_action = any (t.allowed_actions)) then raise exception 'Action % is not allowed here', p_action using errcode = '42501'; end if;
  if p_chat_id is not null and not exists (select 1 from public.telegram_links where user_id = t.user_id and chat_id = p_chat_id) then
    raise exception 'This Telegram chat is not linked to the approver' using errcode = '42501';
  end if;

  if t.entity_type = 'material_request' and p_action = 'approve' then
    select s.telegram_approval_max_value into v_cap
      from public.material_requests r join public.project_settings s on s.project_id = r.project_id where r.id = t.entity_id;
    if v_cap is not null then
      select coalesce(sum(coalesce(l.approved_qty, l.qty) * sp.unit_price), 0) into v_value
        from public.mr_lines l join public.spec_prices sp on sp.material_spec_id = l.material_spec_id
        where l.mr_id = t.entity_id and l.deleted_at is null;
      if v_value > v_cap then
        raise exception 'Requests above % must be approved in the app', v_cap using errcode = '42501';
      end if;
    end if;
  end if;

  perform set_config('request.jwt.claim.sub', t.user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', t.user_id, 'role', 'authenticated', 'amr', jsonb_build_array('telegram'))::text, true);
  begin
    case t.entity_type
    when 'material_request' then
      v_res := public.mr_action(jsonb_build_object('op_id', v_op, 'mr_id', t.entity_id, 'action', p_action, 'comment', p_comment));
    when 'adjustment' then
      v_res := public.decide_adjustment(jsonb_build_object('op_id', v_op, 'adjustment_id', t.entity_id,
        'approve', p_action = 'approve', 'comment', p_comment));
    when 'stock_count' then
      v_res := public.decide_stock_count(jsonb_build_object('op_id', v_op, 'count_id', t.entity_id,
        'approve', p_action = 'approve', 'comment', p_comment));
    when 'progress_update' then
      v_res := public.verify_progress(jsonb_build_object('op_id', v_op, 'progress_id', t.entity_id,
        'approve', p_action = 'approve', 'comment', p_comment));
    when 'gate_pass' then
      v_res := public.gate_pass_action(jsonb_build_object('op_id', v_op, 'gate_pass_id', t.entity_id,
        'action', p_action, 'comment', p_comment));
    when 'miv' then
      v_res := public.acknowledge_miv(jsonb_build_object('miv_id', t.entity_id));
    when 'purchase_order' then   -- po_action lives in migration 0005; called dynamically
      execute 'select public.po_action($1)' into v_res
        using jsonb_build_object('op_id', v_op, 'po_id', t.entity_id, 'action', p_action, 'comment', p_comment);
    else
      raise exception 'Unsupported entity %', t.entity_type;
    end case;
  exception when others then
    perform set_config('request.jwt.claim.sub', v_prev_sub, true);
    perform set_config('request.jwt.claim.role', v_prev_role, true);
    perform set_config('request.jwt.claims', v_prev_claims, true);
    raise;
  end;
  perform set_config('request.jwt.claim.sub', v_prev_sub, true);
  perform set_config('request.jwt.claim.role', v_prev_role, true);
  perform set_config('request.jwt.claims', v_prev_claims, true);

  update public.telegram_action_tokens set used_at = now(),
    used_action = case when token = p_token then p_action else 'superseded' end,
    result = case when token = p_token then v_res end
  where user_id = t.user_id and entity_id = t.entity_id and used_at is null;

  return jsonb_build_object('ok', true, 'entity_type', t.entity_type, 'entity_id', t.entity_id,
    'action', p_action, 'user_id', t.user_id, 'result', v_res);
end $$;

revoke execute on function app.run_action_as(text, text, text, bigint) from public;
revoke execute on function app.issue_action_token(uuid, uuid, text, uuid, text[], interval) from public;

-- Effective channel preferences for (user, event).
create or replace function app.effective_prefs(p_user uuid, p_event text,
  out in_app boolean, out push boolean, out telegram boolean, out sms boolean, out quiet_from time, out quiet_to time)
language sql stable security definer set search_path = public as $$
  select coalesce(x.in_app, true), coalesce(x.push, true), coalesce(x.telegram, true), coalesce(x.sms, false),
         x.quiet_from, x.quiet_to
  from (select 1) d
  left join lateral (
    select * from public.notification_prefs np
    where np.user_id = p_user and np.event in (coalesce(p_event, '*'), '*')
    order by (np.event = '*') limit 1) x on true
$$;

create or replace function app.in_quiet_hours(p_from time, p_to time, p_now time) returns boolean
language sql immutable as $$
  select p_from is not null and p_to is not null and p_from <> p_to and
    case when p_from < p_to then p_now >= p_from and p_now < p_to
         else p_now >= p_from or p_now < p_to end
$$;

-- -----------------------------------------------------------------------------
-- Service-role RPCs used by the Edge Functions
-- -----------------------------------------------------------------------------

-- telegram-webhook: "/start <code>"
create or replace function public.tg_link_chat(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.telegram_link_codes; v_name text;
begin
  select * into c from public.telegram_link_codes where code = p ->> 'code' for update;
  if not found or c.used_at is not null or c.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'Link code is invalid or expired. Create a new one in the app.');
  end if;
  update public.telegram_link_codes set used_at = now() where code = c.code;
  delete from public.telegram_links where chat_id = (p ->> 'chat_id')::bigint and user_id <> c.user_id;
  insert into public.telegram_links (user_id, chat_id, username, linked_at)
  values (c.user_id, (p ->> 'chat_id')::bigint, nullif(p ->> 'username', ''), now())
  on conflict (user_id) do update set chat_id = excluded.chat_id, username = excluded.username, linked_at = now();
  select full_name into v_name from public.profiles where id = c.user_id;
  return jsonb_build_object('ok', true, 'user_id', c.user_id, 'full_name', v_name);
end $$;

-- telegram-webhook: "/stop"
create or replace function public.tg_unlink_chat(p jsonb) returns jsonb
language sql security definer set search_path = public as $$
  delete from public.telegram_links where chat_id = (p ->> 'chat_id')::bigint;
  select jsonb_build_object('ok', true);
$$;

-- telegram-webhook: inline button → {token, action ('ap'|'approve'…), comment?, chat_id}
create or replace function public.tg_run_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return app.run_action_as(p ->> 'token', app.telegram_action_from_code(p ->> 'action'),
    nullif(trim(p ->> 'comment'), ''), (p ->> 'chat_id')::bigint);
end $$;

-- dispatch-notification: decide channels for one notification and build the
-- Telegram message (with single-use action buttons when the recipient can act).
create or replace function public.notification_dispatch_plan(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  n public.notifications;
  pr record;
  v_quiet boolean;
  v_chat bigint;
  v_phone text;
  v_code text;
  v_buttons jsonb := '[]'::jsonb;
  a record; act text;
  v_text text;
  v_tg jsonb;
begin
  select * into n from public.notifications where id = (p ->> 'notification_id')::uuid;
  if not found then return jsonb_build_object('ok', false, 'error', 'notification not found'); end if;
  select * into pr from app.effective_prefs(n.user_id, n.entity_type);
  v_quiet := not n.is_critical and app.in_quiet_hours(pr.quiet_from, pr.quiet_to, app.eat_now()::time);
  select chat_id into v_chat from public.telegram_links where user_id = n.user_id;
  select phone into v_phone from public.profiles where id = n.user_id;
  select code into v_code from public.projects where id = n.project_id;

  if v_chat is not null and pr.telegram and not v_quiet then
    for a in select * from app.approvals_for(n.user_id) x where x.entity_id = n.entity_id limit 1 loop
      for act in select unnest(a.actions) loop
        continue when app.telegram_action_code(act) is null;
        v_buttons := v_buttons || jsonb_build_object('action', act);
      end loop;
      if jsonb_array_length(v_buttons) > 0 then
        v_code := coalesce(v_code, '');
        declare v_token text := app.issue_action_token(n.user_id, a.project_id, a.entity_type, a.entity_id,
          array(select b ->> 'action' from jsonb_array_elements(v_buttons) b));
        begin
          v_buttons := (select jsonb_agg(jsonb_build_object('text', initcap(b ->> 'action'),
                          'callback_data', v_token || ':' || app.telegram_action_code(b ->> 'action')))
                        from jsonb_array_elements(v_buttons) b);
        end;
      end if;
    end loop;
    v_text := '<b>' || app.html_escape(n.title) || '</b>'
      || coalesce(E'\n' || app.html_escape(n.body), '')
      || case when v_code is not null and v_code <> '' then E'\n<i>' || app.html_escape(v_code) || '</i>' else '' end;
    v_tg := jsonb_build_object('chat_id', v_chat, 'text', v_text, 'parse_mode', 'HTML',
      'reply_markup', case when jsonb_array_length(v_buttons) > 0
                           then jsonb_build_object('inline_keyboard', jsonb_build_array(v_buttons)) end);
  end if;

  return jsonb_build_object('ok', true, 'notification_id', n.id, 'user_id', n.user_id, 'quiet', v_quiet,
    'in_app', pr.in_app, 'push', pr.push and not v_quiet, 'sms', pr.sms and n.is_critical and v_phone is not null,
    'phone', v_phone, 'telegram', v_tg);
end $$;

-- daily-summary: one message per active project channel with kind 'daily_summary'.
create or replace function public.daily_summary_plan(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_day date := coalesce((p ->> 'date')::date, app.eat_now()::date - 1);
  c record;
  v_out jsonb := '[]'::jsonb;
  v_grn int; v_grn_l int; v_miv int; v_miv_l int; v_rep int; v_ver int; v_new_al int; v_open_al int;
  v_gp_out int; v_gp_mis int; v_veh int;
  v_text text;
begin
  for c in
    select pc.chat_id, pj.id as project_id, pj.code, pj.name
    from public.project_channels pc join public.projects pj on pj.id = pc.project_id
    where pc.is_active and pj.is_active and 'daily_summary' = any (pc.kinds)
      and (p ->> 'project_id' is null or pj.id = (p ->> 'project_id')::uuid)
  loop
    select count(distinct g.id), count(l.id) into v_grn, v_grn_l from public.grns g
      left join public.grn_lines l on l.grn_id = g.id
      where g.project_id = c.project_id and g.status = 'posted' and app.eat_date(g.received_at) = v_day;
    select count(distinct m.id), count(l.id) into v_miv, v_miv_l from public.mivs m
      left join public.miv_lines l on l.miv_id = m.id
      where m.project_id = c.project_id and m.status <> 'reversed' and app.eat_date(m.issued_at) = v_day;
    select count(*) filter (where u.report_date = v_day),
           count(*) filter (where u.status in ('verified','adjusted') and app.eat_date(u.verified_at) = v_day)
      into v_rep, v_ver from public.progress_updates u where u.project_id = c.project_id;
    select count(*) filter (where app.eat_date(al.created_at) = v_day), count(*) filter (where al.status <> 'closed')
      into v_new_al, v_open_al from public.alerts al where al.project_id = c.project_id;
    select count(*) filter (where ge.event = 'exit_verified'), count(*) filter (where ge.event = 'exit_mismatch')
      into v_gp_out, v_gp_mis from public.gate_events ge where ge.project_id = c.project_id and app.eat_date(ge.at) = v_day;
    select count(*) into v_veh from public.vehicle_movements vm where vm.project_id = c.project_id and app.eat_date(vm.at) = v_day;

    v_text := '<b>' || app.html_escape(c.code || ' — ' || c.name) || '</b>' || E'\n'
      || to_char(v_day, 'Dy DD Mon YYYY') || ' · ' || app.to_ethiopian(v_day) || ' E.C. / ' || app.to_ethiopian(v_day, 'am') || E'\n\n'
      || 'Receipts (GRN): ' || v_grn || ' (' || v_grn_l || ' lines)' || E'\n'
      || 'Issues (MIV): ' || v_miv || ' (' || v_miv_l || ' lines)' || E'\n'
      || 'Progress: ' || v_rep || ' reported, ' || v_ver || ' verified' || E'\n'
      || 'Gate: ' || v_gp_out || ' passes out' || case when v_gp_mis > 0 then ', ' || v_gp_mis || ' MISMATCH' else '' end
      || ', ' || v_veh || ' vehicle movements' || E'\n'
      || 'Alerts: ' || v_new_al || ' new, ' || v_open_al || ' open';
    v_out := v_out || jsonb_build_object('project_id', c.project_id, 'chat_id', c.chat_id, 'text', v_text,
      'counts', jsonb_build_object('grn', v_grn, 'miv', v_miv, 'progress_reported', v_rep, 'progress_verified', v_ver,
        'alerts_new', v_new_al, 'alerts_open', v_open_al, 'gate_out', v_gp_out, 'gate_mismatch', v_gp_mis, 'vehicles', v_veh));
  end loop;
  return jsonb_build_object('ok', true, 'date', v_day, 'messages', v_out);
end $$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array['evaluate_alerts','alert_action','save_alert_rule','sign_qr','verify_qr','get_qr_key',
    'register_qr_labels','mark_qr_printed','save_gate_pass','gate_pass_action','verify_gate_pass','return_gate_pass',
    'log_vehicle','create_telegram_link_code','unlink_telegram','set_notification_prefs','save_project_channel',
    'set_my_locale'] loop
    execute format('revoke execute on function public.%I(jsonb) from public, anon', f);
    execute format('grant execute on function public.%I(jsonb) to authenticated', f);
  end loop;
  -- Edge Functions only (service role key).
  foreach f in array array['tg_link_chat','tg_unlink_chat','tg_run_action','notification_dispatch_plan','daily_summary_plan'] loop
    execute format('revoke execute on function public.%I(jsonb) from public, anon, authenticated', f);
    execute format('grant execute on function public.%I(jsonb) to service_role', f);
  end loop;
end $$;
