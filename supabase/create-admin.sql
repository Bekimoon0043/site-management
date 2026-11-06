-- =============================================================================
-- Create (or promote) an administrator — run in Supabase SQL Editor.
-- 1. Change the three values in the `params` block below.
-- 2. Run. You can then sign in to the web console and the app with that email + password.
-- If the email already exists, it just sets the password, confirms the email and makes it admin.
-- =============================================================================

do $$
declare
  -- >>> CHANGE THESE <<<
  v_email     text := 'REPLACE_WITH_ADMIN_EMAIL';
  v_password  text := 'REPLACE_WITH_A_STRONG_UNIQUE_PASSWORD';
  v_full_name text := 'System Administrator';
  -- >>> --------------- <<<
  v_id uuid;
begin
  if v_email = 'REPLACE_WITH_ADMIN_EMAIL'
     or v_password = 'REPLACE_WITH_A_STRONG_UNIQUE_PASSWORD'
     or length(v_password) < 14 then
    raise exception 'Replace the admin email and use a unique password of at least 14 characters before running this script';
  end if;

  select id into v_id from auth.users where lower(email) = lower(v_email);

  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', lower(v_email),
      extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'role', 'admin'),
      jsonb_build_object('full_name', v_full_name), now(), now(),
      '', '', '', ''
    );
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, v_id::text,
            jsonb_build_object('sub', v_id::text, 'email', lower(v_email), 'email_verified', true),
            'email', now(), now(), now());
  else
    update auth.users
       set encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           raw_app_meta_data  = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'admin'),
           updated_at = now()
     where id = v_id;
  end if;

  -- The on_auth_user_created trigger creates the profile; make sure it is an active admin.
  insert into public.profiles (id, full_name, email, role, is_active)
  values (v_id, v_full_name, lower(v_email), 'admin', true)
  on conflict (id) do update set role = 'admin', is_active = true, full_name = excluded.full_name, email = excluded.email;

  raise notice 'Admin ready: % (id %)', v_email, v_id;
end $$;

-- Check:
select email, full_name, role, is_active from public.profiles where role = 'admin';
