-- =============================================================================
-- Helpers, triggers and row-level security
-- =============================================================================

grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Identity helpers
-- -----------------------------------------------------------------------------

create or replace function app.my_role() returns public.app_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

create or replace function app.has_role(variadic roles public.app_role[]) returns boolean
language sql stable as $$
  select coalesce(app.my_role() = any (roles), false)
$$;

create or replace function app.is_member(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid() and pr.is_active
      and (pr.role = 'admin'
           or exists (select 1 from public.project_members m
                      where m.project_id = p_project and m.user_id = pr.id))
  )
$$;

create or replace function app.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and is_active)
$$;

create or replace function app.can_see_prices() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(app.my_role() = 'admin' or app.my_role() = any (coalesce((select price_roles from public.app_settings where id = 1), array[]::public.app_role[])), false)
$$;

create or replace function app.require_member(p_project uuid) returns void
language plpgsql stable as $$
begin
  if p_project is null or not app.is_member(p_project) then
    raise exception 'You are not assigned to this project' using errcode = '42501';
  end if;
end $$;

create or replace function app.require_role(variadic roles public.app_role[]) returns void
language plpgsql stable as $$
begin
  if not app.has_role(variadic roles) then
    raise exception 'Your role (%) is not allowed to perform this action', coalesce(app.my_role()::text, 'inactive')
      using errcode = '42501';
  end if;
end $$;

-- Device id sent by the apps in the x-device-id header (FR-AU-01).
create or replace function app.device_id() returns uuid
language plpgsql stable as $$
declare v text;
begin
  v := nullif(current_setting('request.headers', true), '')::json ->> 'x-device-id';
  return v::uuid;
exception when others then
  return null;
end $$;

-- -----------------------------------------------------------------------------
-- Generic triggers
-- -----------------------------------------------------------------------------

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function app.audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_rec jsonb := coalesce(v_new, v_old);
begin
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return new;
  end if;
  insert into public.audit_log (user_id, device_id, project_id, table_name, record_id, action, old_data, new_data)
  values (auth.uid(), app.device_id(),
          case when v_rec ? 'project_id' then (v_rec ->> 'project_id')::uuid
               when tg_table_name = 'projects' then (v_rec ->> 'id')::uuid end,
          tg_table_name, coalesce(v_rec ->> 'id', v_rec ->> 'material_spec_id', v_rec ->> 'boq_item_id'),
          lower(tg_op), v_old, v_new);
  return coalesce(new, old);
end $$;

create or replace function app.block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% records are immutable; post a reversing entry instead (BR-07)', tg_table_name
    using errcode = '42501';
end $$;

do $$
declare t text;
begin
  -- updated_at maintenance
  foreach t in array array[
    'profiles','projects','project_settings','project_members','blocks','levels','zones','stores',
    'activity_templates','elements','element_activities','materials','material_specs','spec_conversions',
    'spec_equivalents','spec_prices','suppliers','boq_items','boq_rates','element_takeoffs',
    'material_requests','mr_lines','mr_line_elements','grns','mivs','mrns','transfers','transfer_lines',
    'stock_counts','adjustments','progress_updates','notifications','approval_limits','devices','app_settings',
    'push_tokens'
  ] loop
    execute format('create trigger touch_updated_at before update on public.%I
                    for each row execute function app.touch_updated_at()', t);
  end loop;

  -- audit trail (FR-AU-01, FR-MD-08)
  foreach t in array array[
    'profiles','projects','project_settings','project_members','blocks','levels','zones','stores',
    'elements','materials','material_specs','spec_conversions','spec_prices','suppliers','boq_items',
    'boq_rates','element_takeoffs','approval_limits','app_settings','activity_templates',
    'material_requests','mr_lines','grns','mivs','mrns','transfers','stock_counts','adjustments',
    'progress_updates','attachments'
  ] loop
    execute format('create trigger audit after insert or update or delete on public.%I
                    for each row execute function app.audit()', t);
  end loop;

  -- posted records cannot be edited or deleted (FR-AU-02)
  foreach t in array array['stock_ledger','grn_lines','mrn_lines','stock_count_lines','adjustment_lines'] loop
    execute format('create trigger immutable before update or delete on public.%I
                    for each row execute function app.block_mutation()', t);
  end loop;
  foreach t in array array['grns','mivs','mrns','transfers','stock_counts','adjustments','material_requests','progress_updates','audit_log'] loop
    execute format('create trigger no_delete before delete on public.%I
                    for each row execute function app.block_mutation()', t);
  end loop;
end $$;

create trigger immutable before update on public.audit_log
  for each row execute function app.block_mutation();

-- Issue lines are immutable except linking an emergency issue to its request (BR-01).
create or replace function app.guard_miv_line() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.mr_line_id is not null
     or (to_jsonb(new) - 'mr_line_id' - 'updated_at') <> (to_jsonb(old) - 'mr_line_id' - 'updated_at') then
    raise exception 'miv_lines records are immutable; post a reversing entry instead (BR-07)' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger immutable before update or delete on public.miv_lines
  for each row execute function app.guard_miv_line();

-- -----------------------------------------------------------------------------
-- Domain triggers
-- -----------------------------------------------------------------------------

-- New auth user -> profile. Role comes from app_metadata, which only the
-- service role (admin-users edge function) can set.
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email, phone, role)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'full_name', ''),
          new.email, new.phone,
          coalesce((new.raw_app_meta_data ->> 'role')::public.app_role, 'site_engineer'))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- Only admins (or the service role / direct SQL, e.g. bootstrapping the first
-- admin in the SQL editor) may change role / active flag.
create or replace function app.guard_profile() returns trigger
language plpgsql as $$
begin
  if (new.role is distinct from old.role or new.is_active is distinct from old.is_active)
     and auth.uid() is not null
     and coalesce(auth.role(), '') <> 'service_role'
     and not app.has_role('admin') then
    raise exception 'Only an administrator can change roles or deactivate users' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger guard_profile before update on public.profiles
  for each row execute function app.guard_profile();

create or replace function app.new_project_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.project_settings (project_id) values (new.id) on conflict do nothing;
  if auth.uid() is not null then
    insert into public.project_members (project_id, user_id) values (new.id, auth.uid()) on conflict do nothing;
  end if;
  return new;
end $$;

create trigger project_defaults after insert on public.projects
  for each row execute function app.new_project_defaults();

-- Each new element gets the activity sequence for its type (FR-PG-01).
create or replace function app.seed_element_activities() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.element_activities (project_id, element_id, template_id, seq, name, weight, is_hold_point)
  select new.project_id, new.id, t.id, t.seq, t.name, t.weight, t.is_hold_point
  from public.activity_templates t
  where lower(t.element_type) = lower(new.element_type)
  on conflict (element_id, seq) do nothing;
  return new;
end $$;

create trigger seed_activities after insert on public.elements
  for each row execute function app.seed_element_activities();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','app_settings','projects','project_settings','project_members','devices','push_tokens',
    'approval_limits','blocks','levels','zones','stores','activity_templates','elements','element_activities',
    'materials','material_specs','spec_conversions','spec_equivalents','spec_prices','suppliers','boq_items',
    'boq_rates','element_takeoffs','material_requests','mr_lines','mr_line_elements','mr_events','mr_versions',
    'grns','grn_lines','mivs','miv_lines','mrns','mrn_lines','transfers','transfer_lines','stock_counts',
    'stock_count_lines','adjustments','adjustment_lines','stock_ledger','progress_updates','attachments',
    'notifications','audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Global reference data: readable by every active user.
create policy read_all on public.profiles for select to authenticated using (app.is_active_user());
create policy update_self on public.profiles for update to authenticated
  using (id = auth.uid() or app.has_role('admin')) with check (id = auth.uid() or app.has_role('admin'));

create policy read_all on public.app_settings for select to authenticated using (app.is_active_user());
create policy admin_write on public.app_settings for update to authenticated
  using (app.has_role('admin','manager')) with check (app.has_role('admin','manager'));

do $$
declare t text;
begin
  foreach t in array array['activity_templates','materials','material_specs','spec_conversions','spec_equivalents'] loop
    execute format('create policy read_all on public.%I for select to authenticated using (app.is_active_user())', t);
    execute format($p$create policy master_write on public.%I for all to authenticated
      using (app.has_role('office_engineer','coordinator','manager','admin'))
      with check (app.has_role('office_engineer','coordinator','manager','admin'))$p$, t);
  end loop;
end $$;

create policy read_all on public.suppliers for select to authenticated using (app.is_active_user());
create policy master_write on public.suppliers for all to authenticated
  using (app.has_role('coordinator','manager','procurement','admin'))
  with check (app.has_role('coordinator','manager','procurement','admin'));

create policy read_all on public.approval_limits for select to authenticated using (app.is_active_user());
create policy mgmt_write on public.approval_limits for all to authenticated
  using (app.has_role('manager','admin')) with check (app.has_role('manager','admin'));

-- Prices: only roles listed in app_settings.price_roles (FR-ACC-03, NFR-05).
create policy price_read on public.spec_prices for select to authenticated using (app.can_see_prices());
create policy price_write on public.spec_prices for all to authenticated
  using (app.can_see_prices() and app.has_role('coordinator','manager','procurement','admin'))
  with check (app.can_see_prices() and app.has_role('coordinator','manager','procurement','admin'));
create policy price_read on public.boq_rates for select to authenticated
  using (app.can_see_prices() and app.is_member((select project_id from public.boq_items b where b.id = boq_item_id)));
create policy price_write on public.boq_rates for all to authenticated
  using (app.can_see_prices() and app.has_role('coordinator','manager','procurement','admin'))
  with check (app.can_see_prices() and app.has_role('coordinator','manager','procurement','admin'));

-- Projects (FR-ACC-04).
create policy member_read on public.projects for select to authenticated using (app.is_member(id));
create policy mgmt_insert on public.projects for insert to authenticated
  with check (app.has_role('coordinator','manager','admin'));
create policy mgmt_update on public.projects for update to authenticated
  using (app.is_member(id) and app.has_role('coordinator','manager','admin'))
  with check (app.has_role('coordinator','manager','admin'));

create policy member_read on public.project_settings for select to authenticated using (app.is_member(project_id));
create policy mgmt_write on public.project_settings for update to authenticated
  using (app.is_member(project_id) and app.has_role('coordinator','manager','admin'))
  with check (app.has_role('coordinator','manager','admin'));

create policy member_read on public.project_members for select to authenticated using (app.is_member(project_id));
create policy mgmt_write on public.project_members for all to authenticated
  using (app.is_member(project_id) and app.has_role('coordinator','manager','admin'))
  with check (app.is_member(project_id) and app.has_role('coordinator','manager','admin'));

create policy own on public.devices for select to authenticated using (user_id = auth.uid());
create policy own on public.push_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Project-scoped master data: members read; engineers/management write.
do $$
declare t text;
begin
  foreach t in array array['blocks','levels','zones','stores','elements','boq_items','element_takeoffs'] loop
    execute format('create policy member_read on public.%I for select to authenticated using (app.is_member(project_id))', t);
    execute format($p$create policy master_write on public.%I for all to authenticated
      using (app.is_member(project_id) and app.has_role('office_engineer','coordinator','manager','admin'))
      with check (app.is_member(project_id) and app.has_role('office_engineer','coordinator','manager','admin'))$p$, t);
  end loop;
end $$;

-- Transactional tables: members read; all writes go through security-definer RPCs.
do $$
declare t text;
begin
  foreach t in array array[
    'element_activities','material_requests','mr_lines','mr_line_elements','mr_events','mr_versions',
    'grns','grn_lines','mivs','miv_lines','mrns','mrn_lines','transfer_lines','stock_counts',
    'stock_count_lines','adjustments','adjustment_lines','stock_ledger','progress_updates'
  ] loop
    execute format('create policy member_read on public.%I for select to authenticated using (app.is_member(project_id))', t);
  end loop;
end $$;

-- Transfers are visible to both the sending and the receiving project.
create policy member_read on public.transfers for select to authenticated
  using (app.is_member(project_id) or app.is_member(to_project_id));

create policy member_read on public.attachments for select to authenticated using (app.is_member(project_id));
create policy member_insert on public.attachments for insert to authenticated
  with check (app.is_member(project_id) and created_by = auth.uid());

create policy own_read on public.notifications for select to authenticated using (user_id = auth.uid());
create policy own_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy mgmt_read on public.audit_log for select to authenticated
  using (app.has_role('coordinator','manager','admin')
         and (project_id is null or app.is_member(project_id)));

-- -----------------------------------------------------------------------------
-- Storage: photos, delivery notes, signatures. Path = <project_id>/<entity>/<file>
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public) values ('attachments', 'attachments', false)
on conflict (id) do nothing;

create policy attachments_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and app.is_member(((storage.foldername(name))[1])::uuid));
create policy attachments_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and app.is_member(((storage.foldername(name))[1])::uuid));
