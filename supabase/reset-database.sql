-- =============================================================================
-- Site Materials Management — RESET an existing Supabase project (DESTRUCTIVE)
--
-- Deletes ALL app tables and ALL app data (projects, stock, requests, schedules…)
-- so setup-1.sql and setup-2.sql can be run on a clean database.
-- Sign-in accounts (Authentication → Users) and uploaded files are kept; their
-- profiles/roles are deleted, so run create-admin.sql again afterwards and
-- re-assign roles to other users.
--
-- Order:  reset-database.sql → setup-1.sql → setup-2.sql → create-admin.sql
-- Paste into Supabase Dashboard → SQL Editor → Run.
-- =============================================================================

drop trigger if exists on_auth_user_created on auth.users;
drop policy if exists attachments_read on storage.objects;
drop policy if exists attachments_insert on storage.objects;

drop schema if exists app cascade;
drop schema if exists public cascade;
create schema public;

-- Supabase's standard privileges for the public schema (RLS still guards every table).
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
comment on schema public is 'standard public schema';
