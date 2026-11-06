-- =============================================================================
-- Elements from the schedule. MS Project building schedules are organised floor × trade × element
-- ("1st Floor › B] REBAR › c) To elevation Columns") or trade × element with the level in the name
-- ("4.1 FORMWORK › i) In 1st Basement floor slab"). The web detector (web/src/lib/msp/elements.ts) turns the
-- imported tasks into blocks, levels and elements (one per level × element type), the user reviews them, and
-- this RPC writes them:
--   * blocks / levels are matched by code (created when missing, never renamed);
--   * elements are matched by (block, level, code) — re-running never duplicates; new ones get their activity
--     sequence from activity_templates (trigger seed_activities);
--   * task_element_links (source 'file') say which tasks deliver which element, with the activity range the
--     task covers (formwork task → the element's "Formwork" activity …);
--   * element_takeoffs (planned material per element, tagged with the BoQ item) when the client sends them —
--     the look-ahead material needs and "request from store" use them.
--
-- p: { op_id, schedule_id, block: {id | code, name}, levels: [{code, name, sort_order}],
--      elements: [{ level_code | null, code, element_type, planned_start, planned_finish,
--                   tasks: [{task_id, activity_seq_from, activity_seq_to}],
--                   takeoffs: [{material_spec_id, boq_item_id, qty}] }],
--      replace_links: true }  -- drop this schedule's earlier 'file' links of these tasks that are no longer sent
-- =============================================================================

create or replace function public.create_elements_from_schedule(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  sc public.schedules;
  v_block uuid;
  v_level uuid;
  v_el uuid;
  v_type text;
  v_code text;
  lv jsonb; el jsonb; tk jsonb; tf jsonb;
  v_task public.schedule_tasks;
  v_replace boolean := coalesce((p ->> 'replace_links')::boolean, true);
  v_sent uuid[] := '{}';
  v_el_ids uuid[] := '{}';
  v_pairs text[] := '{}';
  v_blocks int := 0; v_levels int := 0; v_new int := 0; v_matched int := 0; v_links int := 0; v_takeoffs int := 0; v_dropped int := 0;
  v_warn jsonb := '[]'::jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  select * into sc from public.schedules where id = (p ->> 'schedule_id')::uuid;
  if not found then raise exception 'Schedule not found'; end if;
  perform app.require_member(sc.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if jsonb_typeof(p -> 'elements') <> 'array' or jsonb_array_length(p -> 'elements') = 0 then
    raise exception 'No elements to create';
  end if;

  -- block: by id, else by code (created when missing)
  if nullif(p #>> '{block,id}', '') is not null then
    select id into v_block from public.blocks where id = (p #>> '{block,id}')::uuid and project_id = sc.project_id and deleted_at is null;
    if v_block is null then raise exception 'Block does not belong to this project'; end if;
  else
    v_code := upper(btrim(coalesce(nullif(p #>> '{block,code}', ''), 'A')));
    select id into v_block from public.blocks where project_id = sc.project_id and upper(code) = v_code and deleted_at is null;
    if v_block is null then
      insert into public.blocks (project_id, code, name)
      values (sc.project_id, v_code, coalesce(nullif(btrim(p #>> '{block,name}'), ''), 'Block ' || v_code))
      returning id into v_block;
      v_blocks := 1;
    end if;
  end if;

  -- levels: matched by code within the block, created when missing
  for lv in select * from jsonb_array_elements(coalesce(p -> 'levels', '[]'::jsonb)) loop
    v_code := upper(btrim(lv ->> 'code'));
    if v_code is null or v_code = '' then continue; end if;
    if not exists (select 1 from public.levels where block_id = v_block and upper(code) = v_code and deleted_at is null) then
      insert into public.levels (project_id, block_id, code, name, sort_order)
      values (sc.project_id, v_block, v_code, coalesce(nullif(btrim(lv ->> 'name'), ''), v_code), coalesce((lv ->> 'sort_order')::int, 0));
      v_levels := v_levels + 1;
    end if;
  end loop;

  for el in select * from jsonb_array_elements(p -> 'elements') loop
    v_code := upper(btrim(el ->> 'code'));
    v_type := lower(btrim(el ->> 'element_type'));
    if v_code is null or v_code = '' or v_type is null or v_type = '' then raise exception 'Every element needs a code and a type'; end if;
    v_level := null;
    if nullif(el ->> 'level_code', '') is not null then
      select id into v_level from public.levels
       where block_id = v_block and upper(code) = upper(btrim(el ->> 'level_code')) and deleted_at is null;
      if v_level is null then raise exception 'Level % is not in the levels list', el ->> 'level_code'; end if;
    end if;

    select id into v_el from public.elements
     where project_id = sc.project_id and block_id is not distinct from v_block and level_id is not distinct from v_level
       and upper(code) = v_code and deleted_at is null;
    if v_el is null then
      insert into public.elements (project_id, block_id, level_id, code, element_type, planned_start, planned_finish)
      values (sc.project_id, v_block, v_level, v_code, v_type, nullif(el ->> 'planned_start', '')::date, nullif(el ->> 'planned_finish', '')::date)
      returning id into v_el;
      v_new := v_new + 1;
    else
      v_matched := v_matched + 1;
      update public.elements set
        planned_start = coalesce(nullif(el ->> 'planned_start', '')::date, planned_start),
        planned_finish = coalesce(nullif(el ->> 'planned_finish', '')::date, planned_finish)
       where id = v_el and status = 'not_started';
    end if;
    v_el_ids := v_el_ids || v_el;

    for tk in select * from jsonb_array_elements(coalesce(el -> 'tasks', '[]'::jsonb)) loop
      select * into v_task from public.schedule_tasks where id = (tk ->> 'task_id')::uuid;
      if not found or v_task.schedule_id <> sc.id then raise exception 'Task % is not in this schedule', tk ->> 'task_id'; end if;
      if v_task.is_summary then
        v_warn := v_warn || to_jsonb('Summary task "' || v_task.name || '" skipped');
        continue;
      end if;
      insert into public.task_element_links (project_id, task_id, element_id, activity_seq_from, activity_seq_to, source)
      values (sc.project_id, v_task.id, v_el, (tk ->> 'activity_seq_from')::int, (tk ->> 'activity_seq_to')::int, 'file')
      on conflict (task_id, element_id) do update set
        activity_seq_from = excluded.activity_seq_from, activity_seq_to = excluded.activity_seq_to,
        deleted_at = null, updated_at = now()
      where task_element_links.source <> 'ui';
      v_sent := v_sent || v_task.id;
      v_pairs := v_pairs || (v_el::text || ':' || v_task.id::text);
      v_links := v_links + 1;
    end loop;

    for tf in select * from jsonb_array_elements(coalesce(el -> 'takeoffs', '[]'::jsonb)) loop
      if (tf ->> 'qty')::numeric is null or (tf ->> 'qty')::numeric < 0 then raise exception 'Take-off quantity must be zero or more'; end if;
      if not exists (select 1 from public.material_specs where id = (tf ->> 'material_spec_id')::uuid) then
        raise exception 'Unknown material in take-off';
      end if;
      if nullif(tf ->> 'boq_item_id', '') is not null
         and not exists (select 1 from public.boq_items where id = (tf ->> 'boq_item_id')::uuid and project_id = sc.project_id) then
        raise exception 'BoQ item is not in this project';
      end if;
      insert into public.element_takeoffs (project_id, element_id, material_spec_id, boq_item_id, planned_qty)
      values (sc.project_id, v_el, (tf ->> 'material_spec_id')::uuid, nullif(tf ->> 'boq_item_id', '')::uuid, round((tf ->> 'qty')::numeric, 3))
      on conflict (element_id, material_spec_id) do update set
        planned_qty = excluded.planned_qty, boq_item_id = coalesce(excluded.boq_item_id, element_takeoffs.boq_item_id),
        deleted_at = null, updated_at = now();
      v_takeoffs := v_takeoffs + 1;
    end loop;
  end loop;

  -- earlier 'file' links of these elements / tasks (this schedule) that the reviewed list no longer contains
  if v_replace then
    with gone as (
      update public.task_element_links l set deleted_at = now(), updated_at = now()
       where l.project_id = sc.project_id and l.source = 'file' and l.deleted_at is null
         and (l.task_id = any (v_sent) or l.element_id = any (v_el_ids))
         and not ((l.element_id::text || ':' || l.task_id::text) = any (v_pairs))
         and exists (select 1 from public.schedule_tasks st where st.id = l.task_id and st.schedule_id = sc.id)
      returning 1)
    select count(*) into v_dropped from gone;
  end if;

  return app.op_done(p, 'create_elements_from_schedule', jsonb_build_object('ok', true, 'schedule_id', sc.id, 'block_id', v_block,
    'blocks_created', v_blocks, 'levels_created', v_levels, 'elements_created', v_new, 'elements_matched', v_matched,
    'links', v_links, 'links_removed', v_dropped, 'takeoffs', v_takeoffs, 'warnings', v_warn));
end $$;
