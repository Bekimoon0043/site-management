-- =============================================================================
-- Tools & small equipment register (store keeper): returnable items tracked separately from consumables.
--   tool_items      one row per tagged tool (drill, vibrator, level, safety harness …) with its current state
--   tool_movements  history: issue → return (condition checked) / repair / lost / found / dispose
-- Store practice: a sign-out / sign-in register for hand tools, power tools and minor equipment, the store keeper
-- inspects returned tools before restocking; losses are reported to the site / project manager.
-- Writes go through public.save_tool / public.tool_action; overdue returns appear in the store keeper's inbox.
-- Re-runnable.
-- =============================================================================

create table if not exists public.tool_items (
  id           uuid primary key,
  project_id   uuid not null references public.projects (id),
  store_id     uuid references public.stores (id),
  tag          text not null,
  name         text not null,
  category     text not null default 'hand_tool'
                 check (category in ('hand_tool','power_tool','measuring','equipment','safety','formwork','other')),
  serial_no    text,
  status       text not null default 'in_store' check (status in ('in_store','issued','repair','lost','disposed')),
  condition    text not null default 'good' check (condition in ('good','fair','damaged')),
  holder_id    uuid references public.profiles (id),
  holder_name  text,
  issued_at    timestamptz,
  due_on       date,
  notes        text,
  created_by   uuid not null references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (project_id, tag)
);

create table if not exists public.tool_movements (
  id           uuid primary key default gen_random_uuid(),
  tool_id      uuid not null references public.tool_items (id) on delete cascade,
  project_id   uuid not null references public.projects (id),
  action       text not null check (action in ('issue','return','repair','repaired','lost','found','dispose')),
  holder_id    uuid references public.profiles (id),
  holder_name  text,
  due_on       date,
  condition    text check (condition in ('good','fair','damaged')),
  note         text,
  created_by   uuid not null references public.profiles (id),
  created_at   timestamptz not null default now()
);
create index if not exists tool_movements_tool_idx on public.tool_movements (tool_id, created_at);
create index if not exists tool_items_project_idx on public.tool_items (project_id, status);

do $$
declare t text;
begin
  foreach t in array array['tool_items','tool_movements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists member_read on public.%I', t);
    execute format('create policy member_read on public.%I for select to authenticated using (app.is_member(project_id))', t);
  end loop;
  drop trigger if exists touch_updated_at on public.tool_items;
  create trigger touch_updated_at before update on public.tool_items for each row execute function app.touch_updated_at();
  drop trigger if exists audit on public.tool_items;
  create trigger audit after insert or update or delete on public.tool_items for each row execute function app.audit();
end $$;

create or replace view public.v_tools with (security_invoker = true) as
select t.*, st.name as store_name,
       coalesce(pr.full_name, t.holder_name) as holder,
       (t.status = 'issued' and t.due_on is not null and t.due_on < app.local_date(now())) as is_overdue,
       case when t.status = 'issued' and t.due_on is not null then app.local_date(now()) - t.due_on end as days_overdue
from public.tool_items t
left join public.stores st on st.id = t.store_id
left join public.profiles pr on pr.id = t.holder_id
where t.deleted_at is null;
grant select on public.v_tools to authenticated;

-- {id, project_id, tag?, name, category?, store_id?, serial_no?, condition?, notes?}
create or replace function public.save_tool(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_project uuid := (p ->> 'project_id')::uuid; t public.tool_items; v_tag text := nullif(upper(trim(p ->> 'tag')), '');
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role_txt('store_keeper', 'coordinator', 'manager', 'admin');
  if nullif(trim(p ->> 'name'), '') is null then raise exception 'Enter the tool name'; end if;
  if (p ->> 'store_id') is not null and not exists (select 1 from public.stores where id = (p ->> 'store_id')::uuid and project_id = v_project) then
    raise exception 'Store is not in this project';
  end if;
  select * into t from public.tool_items where id = v_id for update;
  if found then
    if t.project_id <> v_project then raise exception 'Tool belongs to another project'; end if;
    update public.tool_items set tag = coalesce(v_tag, tag), name = trim(p ->> 'name'), category = coalesce(nullif(p ->> 'category', ''), category),
      store_id = coalesce((p ->> 'store_id')::uuid, store_id), serial_no = nullif(trim(p ->> 'serial_no'), ''),
      condition = coalesce(nullif(p ->> 'condition', ''), condition), notes = nullif(trim(p ->> 'notes'), '')
    where id = v_id;
  else
    v_tag := coalesce(v_tag, 'T-' || lpad(((select count(*) from public.tool_items where project_id = v_project) + 1)::text, 4, '0'));
    if exists (select 1 from public.tool_items where project_id = v_project and tag = v_tag) then
      raise exception 'Tag % is already used in this project', v_tag;
    end if;
    insert into public.tool_items (id, project_id, store_id, tag, name, category, serial_no, condition, notes, created_by)
    values (v_id, v_project, (p ->> 'store_id')::uuid, v_tag, trim(p ->> 'name'), coalesce(nullif(p ->> 'category', ''), 'hand_tool'),
      nullif(trim(p ->> 'serial_no'), ''), coalesce(nullif(p ->> 'condition', ''), 'good'), nullif(trim(p ->> 'notes'), ''), auth.uid());
  end if;
  return app.op_done(p, 'save_tool', jsonb_build_object('ok', true, 'id', v_id, 'tag', (select tag from public.tool_items where id = v_id)));
end $$;

-- {tool_id, action: issue|return|repair|repaired|lost|found|dispose, holder_id?, holder_name?, due_on?, condition?, note?}
create or replace function public.tool_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); t public.tool_items; a text := p ->> 'action'; v_note text := nullif(trim(p ->> 'note'), '');
  v_cond text := nullif(p ->> 'condition', ''); v_holder uuid := (p ->> 'holder_id')::uuid; v_hname text := nullif(trim(p ->> 'holder_name'), '');
  v_to text; v_due date := nullif(p ->> 'due_on', '')::date;
begin
  if v_seen is not null then return v_seen; end if;
  select * into t from public.tool_items where id = (p ->> 'tool_id')::uuid and deleted_at is null for update;
  if not found then raise exception 'Tool not found'; end if;
  perform app.require_member(t.project_id);
  if a = 'dispose' then perform app.require_role_txt('coordinator', 'manager', 'admin');
  else perform app.require_role_txt('store_keeper', 'coordinator', 'manager', 'admin'); end if;
  if v_cond is not null and v_cond not in ('good','fair','damaged') then raise exception 'Unknown condition %', v_cond; end if;

  if a = 'issue' then
    if t.status <> 'in_store' then
      raise exception '% is % — only a tool in the store can be issued', t.tag,
        case t.status when 'repair' then 'under repair' else t.status end;
    end if;
    if t.condition = 'damaged' then raise exception '% is damaged — send it for repair first', t.tag; end if;
    if v_holder is null and v_hname is null then raise exception 'Who receives the tool?'; end if;
    if v_holder is not null and not exists (select 1 from public.project_members where project_id = t.project_id and user_id = v_holder) then
      raise exception 'The receiver is not a member of this project';
    end if;
    if v_due is not null and v_due < app.local_date(now()) then raise exception 'The return date cannot be in the past'; end if;
    update public.tool_items set status = 'issued', holder_id = v_holder, holder_name = v_hname, issued_at = now(), due_on = v_due where id = t.id;
  elsif a = 'return' then
    if t.status <> 'issued' then raise exception '% is not issued', t.tag; end if;
    if v_cond is null then raise exception 'Record the condition of the returned tool'; end if;
    if v_cond = 'damaged' and v_note is null then raise exception 'Describe the damage'; end if;
    v_to := case when v_cond = 'damaged' then 'repair' else 'in_store' end;
    update public.tool_items set status = v_to, condition = v_cond, holder_id = null, holder_name = null, issued_at = null, due_on = null where id = t.id;
    if v_cond = 'damaged' then
      perform app.notify_roles_txt(t.project_id, '{coordinator}', 'Tool returned damaged: ' || t.tag || ' ' || t.name,
        concat_ws(' · ', 'Returned by ' || coalesce((select full_name from public.profiles where id = t.holder_id), t.holder_name), v_note), 'tool', t.id);
    end if;
  elsif a = 'repair' then
    if t.status <> 'in_store' then raise exception 'Only a tool in the store can be sent for repair'; end if;
    update public.tool_items set status = 'repair', condition = 'damaged' where id = t.id;
  elsif a = 'repaired' then
    if t.status <> 'repair' then raise exception '% is not under repair', t.tag; end if;
    update public.tool_items set status = 'in_store', condition = coalesce(v_cond, 'good') where id = t.id;
  elsif a = 'lost' then
    if t.status not in ('issued','in_store') then raise exception 'Only an issued or stored tool can be reported lost'; end if;
    if v_note is null then raise exception 'Say how the tool was lost'; end if;
    update public.tool_items set status = 'lost' where id = t.id;
    perform app.notify_roles_txt(t.project_id, '{coordinator,manager}', 'Tool lost: ' || t.tag || ' ' || t.name,
      concat_ws(' · ', 'Last with ' || coalesce((select full_name from public.profiles where id = t.holder_id), t.holder_name), v_note), 'tool', t.id, true);
  elsif a = 'found' then
    if t.status <> 'lost' then raise exception '% is not lost', t.tag; end if;
    update public.tool_items set status = 'in_store', condition = coalesce(v_cond, condition), holder_id = null, holder_name = null, issued_at = null, due_on = null where id = t.id;
  elsif a = 'dispose' then
    if t.status not in ('in_store','repair','lost') then raise exception 'Return the tool before disposing of it'; end if;
    if v_note is null then raise exception 'Give the reason for disposal'; end if;
    update public.tool_items set status = 'disposed' where id = t.id;
  else
    raise exception 'Unknown action %', a;
  end if;

  insert into public.tool_movements (tool_id, project_id, action, holder_id, holder_name, due_on, condition, note, created_by)
  values (t.id, t.project_id, a,
    case when a in ('return','lost') then t.holder_id else v_holder end,
    case when a in ('return','lost') then t.holder_name else v_hname end,
    case when a = 'issue' then v_due end, v_cond, v_note, auth.uid());
  return app.op_done(p, 'tool_action', jsonb_build_object('ok', true, 'id', t.id, 'tag', t.tag,
    'status', (select status from public.tool_items where id = t.id)));
end $$;

-- Inbox: tools not returned by their due date (store keeper chases them).
create or replace function app.tools_approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_role text;
begin
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null or v_role not in ('store_keeper', 'admin') then return; end if;
  return query
  select 'tool_overdue'::text, 'tool'::text, t.id, t.project_id, t.tag,
         'Get back ' || t.tag || ' ' || t.name || ' from ' || coalesce(pr.full_name, t.holder_name, '?')
           || ' (due ' || to_char(t.due_on, 'DD Mon') || ')',
         t.status, t.created_by, t.due_on::timestamptz, app.local_date(now()) - t.due_on > 3, array['open'],
         round((extract(epoch from now() - t.due_on::timestamptz) / 3600)::numeric, 1)
  from public.tool_items t left join public.profiles pr on pr.id = t.holder_id
  where t.deleted_at is null and t.status = 'issued' and t.due_on < app.local_date(now())
    and t.project_id in (select pm.project_id from public.project_members pm where pm.user_id = p_user
                         union select pj.id from public.projects pj where v_role = 'admin');
end $$;
revoke execute on function app.tools_approvals_for(uuid) from public;
insert into app.approval_sources (fn) values ('app.tools_approvals_for') on conflict do nothing;
