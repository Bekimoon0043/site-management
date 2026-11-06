import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const stubs = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text, phone text,
  raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema public, auth, storage to anon, authenticated;
`;

try {
  await db.exec(stubs);
  const files = readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
  const latest = files.filter((f) => f >= '20261105');
  for (const f of latest) {
    await db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
    console.log(`  ✓ reapplied ${f}`);
  }
  console.log(`${latest.length} passed, 0 failed — new migrations are re-runnable`);
} finally {
  await db.close();
}
