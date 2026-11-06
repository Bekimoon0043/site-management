// Photos & documents (migration 20261105000020_photos.sql): visibility follows the record type (payment / price /
// stock documents) on the attachments table and on storage paths, location from the element, caption / tag edits
// and the soft delete rules.
//
//   node supabase/tests/photos.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID as uuid } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();

const STUBS = `
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
grant usage on schema public, auth, storage to anon, authenticated, service_role;
`;
const GRANTS = `
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant select, insert on storage.objects to authenticated;
grant execute on all functions in schema auth to authenticated, service_role;
`;

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ✓', msg); } else { failed++; console.log('  ✗', msg); } };
async function as(userId, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', '', false)`, [userId ?? '']);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rpc = async (name, p) => (await db.query(`select public.${name}($1::jsonb) as r`, [JSON.stringify(p)])).rows[0].r;
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
async function expectError(promise, pattern, msg) {
  try { await promise; ok(false, `${msg} (no error raised)`); }
  catch (e) { ok(pattern.test(e.message), `${msg} → "${e.message}"`); }
}

async function main() {
  console.log('Applying migrations…');
  await db.exec(STUBS);
  for (const f of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    try { await db.exec(readFileSync(join(root, 'migrations', f), 'utf8')); }
    catch (e) { throw new Error(`${f}: ${e.message}`); }
  }
  await db.exec(readFileSync(join(root, 'seed.sql'), 'utf8'));
  await db.exec(GRANTS);

  const U = {};
  for (const role of ['admin', 'coordinator', 'manager', 'office_engineer', 'site_engineer', 'store_keeper', 'security', 'finance', 'procurement']) {
    U[role] = uuid();
    await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4)`,
      [U[role], `${role}@test.et`, { full_name: role }, { role }]);
  }
  U.site2 = uuid();
  await db.query(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, 'site2@test.et', '{"full_name":"site2"}', '{"role":"site_engineer"}')`, [U.site2]);
  const P = uuid(), P2 = uuid(), B = uuid(), L = uuid(), E = uuid(), B2 = uuid(), L2 = uuid(), B3 = uuid();
  await as(U.admin, async () => {
    await db.query(`insert into projects (id, code, name) values ($1, 'APT', 'Apartment'), ($2, 'OTH', 'Other')`, [P, P2]);
    for (const r of Object.keys(U).filter((r) => r !== 'admin')) await db.query(`insert into project_members values ($1, $2)`, [P, U[r]]);
  });
  await db.query(`insert into blocks (id, project_id, code, name) values ($1, $2, 'A', 'Block A'), ($3, $4, 'Z', 'Other block'), ($5, $2, 'B', 'Block B')`, [B, P, B2, P2, B3]);
  await db.query(`insert into levels (id, project_id, block_id, code, name) values ($1, $2, $3, 'L1', 'Level 1'), ($4, $5, $6, 'Z1', 'Other level')`, [L, P, B, L2, P2, B2]);
  await db.query(`insert into elements (id, project_id, block_id, level_id, code, element_type) values ($1, $2, $3, $4, 'C1', 'column')`, [E, P, B, L]);

  const add = (user, entity_type, entity_id, extra = {}) => as(user, async () => {
    const id = uuid();
    await db.query(`insert into attachments (id, project_id, entity_type, entity_id, kind, storage_path, mime_type, source, caption, tag, block_id, level_id, created_by)
      values ($1, $2, $3, $4, $5, $6, 'image/jpeg', $7, $8, $9, $10, $11, $12)`,
      [id, extra.project ?? P, entity_type, entity_id, extra.kind ?? 'photo', `${extra.project ?? P}/${entity_type}/${id}.jpg`, extra.source ?? 'upload', extra.caption ?? null, extra.tag ?? null,
       extra.block ?? null, extra.level ?? null, user]);
    return id;
  });
  const sees = async (user, id) => (await as(user, () => one(`select count(*)::int c from attachments where id = $1`, [id]))).c === 1;

  console.log('\nGeneral site photos and location');
  const s1 = await add(U.site_engineer, 'site', P, { caption: 'North elevation', tag: 'progress' });
  ok(await sees(U.store_keeper, s1) && await sees(U.security, s1), 'site photo visible to every project member');
  const e1 = await add(U.site_engineer, 'element', E, { tag: 'before' });
  const loc = await one(`select block_id, level_id from attachments where id = $1`, [e1]);
  ok(loc.block_id === B && loc.level_id === L, 'element photo gets the element block / level');
  const explicit = await add(U.site_engineer, 'site', P, { level: L });
  ok((await one(`select block_id from attachments where id = $1`, [explicit])).block_id === B, 'explicit level derives its block');
  await expectError(add(U.site_engineer, 'site', P, { block: B2 }), /Block is not in this project/, 'block from another project rejected');
  await expectError(add(U.site_engineer, 'site', P, { level: L2 }), /Level is not in this project/, 'level from another project rejected on insert');
  await expectError(add(U.site_engineer, 'site', P, { block: B3, level: L }), /Block does not match level/, 'mismatched block and level rejected on insert');
  await expectError(add(U.site_engineer, 'site', P, { tag: 'random' }), /attachments_tag_check|check constraint/, 'unknown tag rejected');
  await expectError(add(U.site_engineer, 'site', P2, { project: P2 }), /row-level security|policy/, 'cannot attach to a project you are not on');

  console.log('\nPayment, price and stock documents');
  await expectError(add(U.store_keeper, 'client_ipc', uuid(), { kind: 'signed_certificate' }), /row-level security|policy/, 'store keeper cannot attach to a client IPC');
  const ipc = await add(U.manager, 'client_ipc', uuid(), { kind: 'signed_certificate' });
  ok(await sees(U.coordinator, ipc) && await sees(U.finance, ipc), 'IPC scan visible to price roles (coordinator, finance)');
  ok(!(await sees(U.site_engineer, ipc)) && !(await sees(U.store_keeper, ipc)) && !(await sees(U.office_engineer, ipc)), 'IPC scan hidden from site engineer, store keeper, office engineer (no price access)');
  const sc = await add(U.office_engineer, 'sc_certificate', uuid(), { kind: 'measurement' });
  ok(await sees(U.finance, sc) && await sees(U.coordinator, sc), 'subcontract measurement visible to payment roles');
  ok(!(await sees(U.site_engineer, sc)) && !(await sees(U.procurement, sc)) && !(await sees(U.store_keeper, sc)), 'subcontract measurement hidden from site engineer, procurement, store keeper');
  const pr = await add(U.site_engineer, 'payroll', uuid(), { kind: 'attendance_sheet' });
  ok(await sees(U.site_engineer, pr) && await sees(U.finance, pr) && !(await sees(U.store_keeper, pr)), 'attendance sheet: site engineer + payment roles, not store keeper');
  const cnt = await add(U.store_keeper, 'stock_count', uuid());
  ok(await sees(U.store_keeper, cnt) && !(await sees(U.security, cnt)), 'stock count photo hidden from the gate guard');
  const q = await add(U.procurement, 'quotation', uuid(), { kind: 'proforma' });
  ok(await sees(U.manager, q) && !(await sees(U.site_engineer, q)), 'supplier proforma only for price roles');
  const si = await add(U.procurement, 'supplier_invoice', uuid(), { kind: 'invoice' });
  ok(await sees(U.finance, si) && await sees(U.procurement, si) && !(await sees(U.site_engineer, si)) && !(await sees(U.store_keeper, si)),
    'supplier invoice scan visible only to price roles');

  console.log('\nStorage paths');
  const vis = async (user, path) => (await as(user, () => one(`select app.storage_path_visible($1) v`, [path]))).v;
  ok(await vis(U.store_keeper, `${P}/site/x.jpg`) && !(await vis(U.store_keeper, `${P}/client_ipc/x.jpg`)) && !(await vis(U.store_keeper, `${P2}/site/x.jpg`)),
    'store keeper: own project site files yes; IPC files and other projects no');
  ok(!(await vis(U.store_keeper, 'not-a-uuid/site/x.jpg')), 'malformed path is not visible');
  ok(await vis(U.finance, `${P}/supplier_invoice/x.pdf`) && !(await vis(U.site_engineer, `${P}/supplier_invoice/x.pdf`)),
    'storage visibility matches supplier invoice table visibility');
  await expectError(as(U.store_keeper, () => db.query(`insert into storage.objects (bucket_id, name) values ('attachments', 'not-a-uuid/site/x.jpg')`)),
    /row-level security|policy/, 'malformed storage insert fails closed without a uuid cast error');
  await expectError(as(U.store_keeper, () => db.query(`insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [`${P}/sc_certificate/a.pdf`])),
    /row-level security|policy/, 'store keeper cannot upload a file under sc_certificate');
  await as(U.office_engineer, () => db.query(`insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [`${P}/sc_certificate/b.pdf`]));
  ok((await as(U.office_engineer, () => one(`select count(*)::int c from storage.objects where name = $1`, [`${P}/sc_certificate/b.pdf`]))).c === 1
    && (await as(U.site_engineer, () => one(`select count(*)::int c from storage.objects where name = $1`, [`${P}/sc_certificate/b.pdf`]))).c === 0,
    'office engineer uploads the measurement file; site engineer cannot read it');

  console.log('\nEdit and delete');
  const r1 = await as(U.site_engineer, () => rpc('update_attachment', { id: s1, caption: 'North elevation — level 3 slab', tag: 'after', level_id: L }));
  const s1r = await one(`select caption, tag, block_id, level_id from attachments where id = $1`, [s1]);
  ok(r1.ok && s1r.caption === 'North elevation — level 3 slab' && s1r.tag === 'after' && s1r.level_id === L && s1r.block_id === B, 'uploader edits caption, tag and level (block follows the level)');
  await expectError(as(U.site2, () => rpc('update_attachment', { id: s1, caption: 'x' })), /Only the person/, 'another site engineer cannot change it');
  await expectError(as(U.site_engineer, () => rpc('update_attachment', { id: s1, level_id: L2 })), /not in this project/, 'level from another project rejected');
  await expectError(as(U.site_engineer, () => rpc('update_attachment', { id: s1, block_id: B3 })), /Block does not match level/, 'cannot move a levelled photo to an unrelated block');
  await expectError(as(U.site_engineer, () => rpc('update_attachment', { id: s1, block_id: B3, level_id: L })), /Block does not match level/, 'mismatched block and level rejected on edit');
  await expectError(as(U.site_engineer, () => rpc('update_attachment', { id: ipc, caption: 'x' })), /not found/, 'cannot edit a document you cannot see');
  const r2 = await as(U.site_engineer, () => rpc('update_attachment', { id: e1, delete: true }));
  ok(r2.deleted && (await one(`select deleted_at is not null d, deleted_by from attachments where id = $1`, [e1])).deleted_by === U.site_engineer, 'uploader deletes within 24 h (soft delete, who is kept)');
  await db.query(`update attachments set created_at = now() - interval '2 days' where id = $1`, [s1]);
  await expectError(as(U.site_engineer, () => rpc('update_attachment', { id: s1, delete: true })), /within 24 hours/, 'uploader cannot delete after 24 h');
  ok((await as(U.coordinator, () => rpc('update_attachment', { id: s1, delete: true }))).deleted, 'coordinator can delete later');
  await expectError(as(U.coordinator, () => rpc('update_attachment', { id: s1, caption: 'again' })), /not found/, 'a deleted photo cannot be edited');
  await expectError(as(U.site_engineer, () => db.query(`insert into attachments (id, project_id, entity_type, entity_id, storage_path, deleted_at, created_by) values ($1, $2, 'site', $2, 'x', now(), $3)`, [uuid(), P, U.site_engineer])),
    /row-level security|policy/, 'cannot insert an already-deleted row');

  const beforeRerun = (await one(`select count(*)::int c from attachments`)).c;
  await db.exec(readFileSync(join(root, 'migrations', '20261105000020_photos.sql'), 'utf8'));
  ok((await one(`select count(*)::int c from attachments`)).c === beforeRerun && await sees(U.site_engineer, si) === false,
    'photos migration is re-runnable without changing rows or visibility');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
