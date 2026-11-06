-- =============================================================================
-- Photos & documents everywhere (web upload, bulk import, site photo gallery, before/after).
--
-- * attachments gets caption, tag (before / after / progress / issue / handover / other), block / level,
--   file name + size and a soft delete (evidence is never physically removed; the audit trigger keeps the trail).
-- * Who sees an attachment follows the record it belongs to (app.attachment_visible): payment documents only
--   for payment roles, price documents (client IPC, variations, quotations, POs) only for price roles, stock
--   books not for the gate guard. Enforced on the table AND on the storage files (path = project/entity_type/file).
-- * entity_type 'site' (entity_id = project id) holds general site photos uploaded in the gallery.
-- * Location (block / level) is filled from the linked element / snag / inspection / progress update when not given.
-- * public.update_attachment: caption / tag / location, or delete (uploader within 24 h, or coordinator / manager / admin).
-- Re-runnable.
-- =============================================================================

alter table public.attachments add column if not exists caption    text;
alter table public.attachments add column if not exists tag        text;
alter table public.attachments add column if not exists block_id   uuid references public.blocks (id);
alter table public.attachments add column if not exists level_id   uuid references public.levels (id);
alter table public.attachments add column if not exists file_name  text;
alter table public.attachments add column if not exists size_bytes bigint;
alter table public.attachments add column if not exists deleted_at timestamptz;
alter table public.attachments add column if not exists deleted_by uuid references public.profiles (id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'attachments_tag_check') then
    alter table public.attachments add constraint attachments_tag_check
      check (tag is null or tag in ('before','after','progress','issue','handover','other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'attachments_caption_len') then
    alter table public.attachments add constraint attachments_caption_len check (caption is null or length(caption) <= 500);
  end if;
end $$;

select app.extend_check_values('public.attachments', 'kind',
  array['photo','delivery_note','signature','document','proforma','batch_ticket','bbs','drawing','diary',
        'measurement','attendance_sheet','signed_certificate','site_instruction','invoice','report']);
select app.extend_check_values('public.attachments', 'source', array['camera','gallery','upload']);

create index if not exists attachments_project_created_idx on public.attachments (project_id, created_at desc) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Visibility by the type of record the file belongs to
-- ---------------------------------------------------------------------------
create or replace function app.attachment_visible(p_entity_type text, p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.is_member(p_project) and case
    when p_entity_type in ('sc_certificate','subcontract','subcontractor','payment') then app.can_see_payments(p_project)
    when p_entity_type in ('payroll','labour_payroll') then app.can_see_payments(p_project) or app.has_role_txt('site_engineer')
    when p_entity_type in ('client_ipc','variation','quotation','purchase_order','rfq','supplier_invoice') then app.can_see_prices()
    when p_entity_type in ('stock_count','adjustment') then coalesce(app.my_role()::text, '') <> 'security'
    else true
  end
$$;
revoke execute on function app.attachment_visible(text, uuid) from public;
grant execute on function app.attachment_visible(text, uuid) to authenticated;

-- storage object name = <project_id>/<entity_type>/<file>
create or replace function app.storage_path_visible(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare f text[] := storage.foldername(p_name); v_project uuid;
begin
  begin v_project := f[1]::uuid; exception when others then return false; end;
  return app.attachment_visible(coalesce(f[2], ''), v_project);
end $$;
revoke execute on function app.storage_path_visible(text) from public;
grant execute on function app.storage_path_visible(text) to authenticated;

drop policy if exists entity_read on public.attachments;
create policy entity_read on public.attachments as restrictive for select to authenticated
  using (app.attachment_visible(entity_type, project_id));
drop policy if exists entity_insert on public.attachments;
create policy entity_insert on public.attachments as restrictive for insert to authenticated
  with check (app.attachment_visible(entity_type, project_id) and deleted_at is null);

-- Replace the original member-only policies too: their direct uuid cast rejected malformed paths with an error.
drop policy if exists attachments_read on storage.objects;
create policy attachments_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and app.storage_path_visible(name));
drop policy if exists attachments_insert on storage.objects;
create policy attachments_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and app.storage_path_visible(name));
drop policy if exists attachments_entity_read on storage.objects;
create policy attachments_entity_read on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'attachments' or app.storage_path_visible(name));
drop policy if exists attachments_entity_insert on storage.objects;
create policy attachments_entity_insert on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'attachments' or app.storage_path_visible(name));

-- ---------------------------------------------------------------------------
-- Validate supplied locations, then inherit block / level from the linked record.
-- ---------------------------------------------------------------------------
create or replace function app.attachment_location() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_el uuid; b uuid; l uuid; v_block uuid; v_project uuid;
begin
  if new.level_id is not null then
    select lv.block_id, lv.project_id into v_block, v_project from public.levels lv where lv.id = new.level_id;
    if not found or v_project <> new.project_id then raise exception 'Level is not in this project'; end if;
    if new.block_id is not null and new.block_id <> v_block then raise exception 'Block does not match level'; end if;
    new.block_id := v_block;
  elsif new.block_id is not null and not exists (
    select 1 from public.blocks b where b.id = new.block_id and b.project_id = new.project_id
  ) then
    raise exception 'Block is not in this project';
  end if;
  if new.block_id is not null or new.level_id is not null then return new; end if;
  if new.entity_type = 'element' then v_el := new.entity_id;
  elsif new.entity_type = 'snag' then
    select s.block_id, s.level_id, s.element_id into b, l, v_el from public.snags s where s.id = new.entity_id and s.project_id = new.project_id;
    if b is not null or l is not null then new.block_id := b; new.level_id := l; return new; end if;
  elsif new.entity_type = 'inspection' then
    select i.element_id into v_el from public.inspections i where i.id = new.entity_id and i.project_id = new.project_id;
  elsif new.entity_type = 'progress_update' then
    select p.element_id into v_el from public.progress_updates p where p.id = new.entity_id and p.project_id = new.project_id;
  end if;
  if v_el is not null then
    select e.block_id, e.level_id into new.block_id, new.level_id from public.elements e where e.id = v_el and e.project_id = new.project_id;
  end if;
  return new;
end $$;
drop trigger if exists location on public.attachments;
create trigger location before insert on public.attachments for each row execute function app.attachment_location();

-- ---------------------------------------------------------------------------
-- Edit caption / tag / location, or delete (soft)
-- p: {id, caption?, tag?, block_id?, level_id?, delete?: bool}
-- ---------------------------------------------------------------------------
create or replace function public.update_attachment(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.attachments; v_mgmt boolean; v_block uuid;
begin
  select * into a from public.attachments where id = (p ->> 'id')::uuid for update;
  if not found or a.deleted_at is not null or not app.attachment_visible(a.entity_type, a.project_id) then
    raise exception 'Attachment not found';
  end if;
  v_mgmt := app.has_role_txt('coordinator', 'manager', 'admin');
  if coalesce((p ->> 'delete')::boolean, false) then
    if not (v_mgmt or (a.created_by = auth.uid() and a.created_at > now() - interval '24 hours')) then
      raise exception 'Only the person who added it (within 24 hours) or a coordinator / manager can delete a photo' using errcode = '42501';
    end if;
    update public.attachments set deleted_at = now(), deleted_by = auth.uid(), updated_at = now() where id = a.id;
    return jsonb_build_object('ok', true, 'id', a.id, 'deleted', true);
  end if;
  if not (v_mgmt or a.created_by = auth.uid()) then
    raise exception 'Only the person who added it or a coordinator / manager can change it' using errcode = '42501';
  end if;
  if p ? 'level_id' and nullif(p ->> 'level_id', '') is not null then
    select l.block_id into v_block from public.levels l
      where l.id = (p ->> 'level_id')::uuid and l.project_id = a.project_id;
    if not found then raise exception 'Level is not in this project'; end if;
    if p ? 'block_id' and nullif(p ->> 'block_id', '') is not null
       and (p ->> 'block_id')::uuid <> v_block then
      raise exception 'Block does not match level';
    end if;
  end if;
  if p ? 'block_id' and nullif(p ->> 'block_id', '') is not null then
    if not exists (select 1 from public.blocks b where b.id = (p ->> 'block_id')::uuid and b.project_id = a.project_id) then
      raise exception 'Block is not in this project';
    end if;
    if not (p ? 'level_id') and a.level_id is not null and not exists (
      select 1 from public.levels l where l.id = a.level_id and l.block_id = (p ->> 'block_id')::uuid
    ) then
      raise exception 'Block does not match level';
    end if;
  elsif p ? 'block_id' and not (p ? 'level_id') and a.level_id is not null then
    raise exception 'Clear the level before clearing its block';
  end if;
  update public.attachments set
    caption  = case when p ? 'caption' then nullif(trim(p ->> 'caption'), '') else caption end,
    tag      = case when p ? 'tag' then nullif(p ->> 'tag', '') else tag end,
    block_id = case
      when p ? 'level_id' and nullif(p ->> 'level_id', '') is not null then v_block
      when p ? 'block_id' then nullif(p ->> 'block_id', '')::uuid else block_id end,
    level_id = case when p ? 'level_id' then nullif(p ->> 'level_id', '')::uuid else level_id end,
    updated_at = now()
  where id = a.id;
  return jsonb_build_object('ok', true, 'id', a.id);
end $$;
revoke execute on function public.update_attachment(jsonb) from public;
grant execute on function public.update_attachment(jsonb) to authenticated;
