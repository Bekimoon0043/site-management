-- =============================================================================
-- Approvals inbox registry. New modules (payments, client billing …) add their inbox items by registering a
-- function with the same row shape as app.approvals_for(uuid):
--
--   create or replace function app.payments_approvals_for(p_user uuid) returns table (<same columns>) …;
--   insert into app.approval_sources (fn) values ('app.payments_approvals_for') on conflict do nothing;
--
-- instead of renaming app.approvals_for or re-creating v_my_approvals (two modules doing that would undo
-- each other). Each source must itself only return items the caller may act on (it runs as definer).
-- =============================================================================

create table if not exists app.approval_sources (
  fn text primary key check (fn ~ '^app\.[a-z_][a-z0-9_]*$')
);
revoke all on app.approval_sources from public;

create or replace function app.extra_approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
declare f text;
begin
  if p_user is distinct from auth.uid() and not app.has_role('admin') then return; end if;
  for f in select s.fn from app.approval_sources s where to_regproc(s.fn) is not null order by s.fn loop
    return query execute format('select * from %s($1)', f) using p_user;
  end loop;
end $$;
revoke execute on function app.extra_approvals_for(uuid) from public;
grant execute on function app.extra_approvals_for(uuid) to authenticated;

create or replace view public.v_my_approvals as
  select * from app.approvals_for(auth.uid())
  union all
  select * from app.lookahead_approvals_for(auth.uid())
  union all
  select * from app.extra_approvals_for(auth.uid());
grant select on public.v_my_approvals to authenticated;
