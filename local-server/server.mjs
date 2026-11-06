// Local stand-in for Supabase, for development without a hosted project.
//
// Runs the real migrations in PGlite (Postgres compiled to WASM, persisted to
// local-server/data) and serves the subset of the Supabase HTTP API that the
// web console and mobile app use:
//   /auth/v1      password sign-in, refresh, user, logout
//   /rest/v1      PostgREST-style table reads/writes (filters, order, paging,
//                 one-level embeds, upsert) and /rpc/<fn> — executed under RLS
//                 as the signed-in user, exactly like Supabase
//   /storage/v1   object upload + signed URLs (files under local-server/data/storage)
//   /functions/v1/admin-users   same contract as supabase/functions/admin-users
//
// Switching to hosted Supabase later only changes the apps' .env files.
//
//   npm run local            (from the repo root)
//
// Environment: PORT (default 54321), SM_DATA_DIR (default local-server/data),
// SM_DEMO=basic for the small original demo instead of the rich ~10-week one.
// `npm run local:reset` deletes the database and storage (keeps jwt-secret).

import { PGlite } from '@electric-sql/pglite';
import http from 'node:http';
import os from 'node:os';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemo } from './demo.mjs';
import { seedRichDemo } from './demo-rich.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const DATA = process.env.SM_DATA_DIR ? resolve(process.env.SM_DATA_DIR) : join(here, 'data');
const STORAGE = join(DATA, 'storage');
const PORT = Number(process.env.PORT ?? 54321);
mkdirSync(STORAGE, { recursive: true });

// ---------------------------------------------------------------------------
// Secrets & JWT (HS256)
// ---------------------------------------------------------------------------

const secretFile = join(DATA, 'jwt-secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex'));
const SECRET = readFileSync(secretFile, 'utf8').trim();
const ACCESS_TTL = 3600;

const b64url = (b) => Buffer.from(b).toString('base64url');
function signJwt(payload) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyJwt(token) {
  const [head, body, sig] = (token ?? '').split('.');
  if (!sig) return null;
  const expect = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (claims.exp && claims.exp < Date.now() / 1000) return null;
  return claims;
}
export const ANON_KEY = signJwt({ iss: 'supabase-local', role: 'anon', iat: 1761696000, exp: 2077056000 });

const hashPassword = (pw) => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(pw, salt, 32).toString('hex')}`;
};
const checkPassword = (pw, stored) => {
  const [, salt, hash] = (stored ?? '').split('$');
  if (!hash) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(pw, salt, 32));
};

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new PGlite(join(DATA, 'pg'));

// PGlite is a single connection: every request runs serially in its own transaction.
let chain = Promise.resolve();
const serial = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

async function tx(ctx, fn) {
  return serial(async () => {
    await db.exec('begin');
    try {
      await db.query(
        `select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true),
                set_config('request.headers', $3, true)`,
        [ctx.sub ?? '', ctx.role, JSON.stringify(ctx.headers ?? {})]);
      if (ctx.role === 'authenticated' || ctx.role === 'anon') await db.exec(`set local role ${ctx.role}`);
      const out = await fn();
      await db.exec('commit');
      return out;
    } catch (e) {
      await db.exec('rollback');
      throw e;
    }
  });
}
export const asUser = (userId, fn) => tx({ sub: userId, role: 'authenticated' }, fn);
const asService = (fn) => tx({ role: 'service_role' }, fn);

const AUTH_STUB = `
do $$ begin
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
exception when duplicate_object then null; end $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key, email text unique, phone text unique, encrypted_password text,
  raw_user_meta_data jsonb not null default '{}', raw_app_meta_data jsonb not null default '{}',
  banned boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists auth.refresh_tokens (token text primary key, user_id uuid not null, revoked boolean not null default false,
  created_at timestamptz not null default now());
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as
  $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema public, auth, storage to anon, authenticated;
create table if not exists public._local_migrations (name text primary key, applied_at timestamptz default now());
`;

const GRANTS = `
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
revoke all on public._local_migrations from anon, authenticated;
`;

const MAX_ROWS = Number(process.env.LOCAL_MAX_ROWS ?? 1000);
let fkeys = [];    // { name, table, column, ftable, fcolumn }
let pkeys = {};    // table -> [cols]
let relations = new Set();

async function migrate() {
  await db.exec(AUTH_STUB);
  const applied = new Set((await db.query('select name from public._local_migrations')).rows.map((r) => r.name));
  const dir = join(root, 'supabase', 'migrations');
  let fresh = false;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(f)) continue;
    console.log('  applying', f);
    await db.exec(readFileSync(join(dir, f), 'utf8'));
    await db.query('insert into public._local_migrations (name) values ($1)', [f]);
    fresh = true;
  }
  if (!applied.has('seed.sql')) {
    await db.exec(readFileSync(join(root, 'supabase', 'seed.sql'), 'utf8'));
    await db.query(`insert into public._local_migrations (name) values ('seed.sql')`);
  }
  await db.exec(GRANTS);
  return fresh;
}

async function loadCatalog() {
  fkeys = (await db.query(`
    select c.conname as name, c.conrelid::regclass::text as table, a.attname as column, c.confrelid::regclass::text as ftable, fa.attname as fcolumn
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute fa on fa.attrelid = c.confrelid and fa.attnum = c.confkey[1]
    where c.contype = 'f' and array_length(c.conkey, 1) = 1 and c.connamespace = 'public'::regnamespace`)).rows
    .map((r) => ({ ...r, table: r.table.replace(/^public\./, ''), ftable: r.ftable.replace(/^public\./, '') }));
  pkeys = {};
  for (const r of (await db.query(`
    select tc.relname as table, array_agg(a.attname order by array_position(i.indkey, a.attnum)) as cols
    from pg_index i join pg_class tc on tc.oid = i.indrelid
    join pg_attribute a on a.attrelid = tc.oid and a.attnum = any (i.indkey)
    where i.indisprimary and tc.relnamespace = 'public'::regnamespace group by tc.relname`)).rows) pkeys[r.table] = r.cols;
  relations = new Set((await db.query(`
    select table_name from information_schema.tables where table_schema = 'public' and table_name not like '\\_%'`)).rows
    .map((r) => r.table_name));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, prefer, range, accept, accept-profile, content-profile, x-client-info, x-device-id, x-upsert, x-supabase-api-version, cache-control',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Location',
};
class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, {
    ...CORS,
    ...(body === undefined || isBuf ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...headers,
  });
  res.end(body === undefined ? undefined : isBuf ? body : JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
const readJson = async (req) => {
  const b = await readBody(req);
  return b.length ? JSON.parse(b.toString('utf8')) : {};
};
function bearerClaims(req) {
  const h = req.headers.authorization ?? '';
  const claims = verifyJwt(h.replace(/^Bearer\s+/i, ''));
  if (h && !claims) throw new HttpError(401, 'JWT expired or invalid', { code: 'PGRST301' });
  return claims;
}
function pgError(e) {
  const status = e.code === '42501' ? 403 : e.code === '23505' ? 409 : e.code?.startsWith('22') || e.code?.startsWith('23') || e.code === 'P0001' ? 400 : 400;
  return { status, body: { code: e.code ?? 'LOCAL', message: e.message, details: e.detail ?? null, hint: e.hint ?? null } };
}

// ---------------------------------------------------------------------------
// Auth (GoTrue subset)
// ---------------------------------------------------------------------------

const userJson = (u) => ({
  id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, phone: u.phone ?? '',
  app_metadata: { provider: u.email ? 'email' : 'phone', providers: [u.email ? 'email' : 'phone'], ...u.raw_app_meta_data },
  user_metadata: u.raw_user_meta_data ?? {},
  email_confirmed_at: u.created_at, phone_confirmed_at: u.phone ? u.created_at : null, confirmed_at: u.created_at,
  created_at: u.created_at, updated_at: u.updated_at, identities: [],
});

async function session(u) {
  const now = Math.floor(Date.now() / 1000);
  const refresh = randomBytes(24).toString('base64url');
  await serial(() => db.query('insert into auth.refresh_tokens (token, user_id) values ($1, $2)', [refresh, u.id]));
  return {
    access_token: signJwt({ sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email, phone: u.phone,
      app_metadata: u.raw_app_meta_data, iat: now, exp: now + ACCESS_TTL, session_id: randomUUID() }),
    token_type: 'bearer', expires_in: ACCESS_TTL, expires_at: now + ACCESS_TTL, refresh_token: refresh, user: userJson(u),
  };
}
const authFail = (msg, code = 'invalid_credentials') =>
  new HttpError(400, msg, { error: 'invalid_grant', error_description: msg, code, msg });

async function handleAuth(req, res, path, url) {
  if (path === '/token' && req.method === 'POST') {
    const body = await readJson(req);
    const grant = url.searchParams.get('grant_type');
    let user;
    if (grant === 'password') {
      const id = (body.email ?? '').trim().toLowerCase() || (body.phone ?? '').trim();
      user = (await serial(() => db.query('select * from auth.users where lower(email) = $1 or phone = $1', [id]))).rows[0];
      if (!user || !checkPassword(body.password ?? '', user.encrypted_password)) throw authFail('Invalid login credentials');
    } else if (grant === 'refresh_token') {
      const row = (await serial(() => db.query(
        `update auth.refresh_tokens set revoked = true where token = $1 and not revoked returning user_id`, [body.refresh_token]))).rows[0];
      if (!row) throw authFail('Invalid Refresh Token', 'refresh_token_not_found');
      user = (await serial(() => db.query('select * from auth.users where id = $1', [row.user_id]))).rows[0];
    } else {
      throw new HttpError(400, 'Unsupported grant type');
    }
    if (!user || user.banned) throw authFail('User is banned', 'user_banned');
    return send(res, 200, await session(user));
  }
  if (path === '/user' && req.method === 'GET') {
    const claims = bearerClaims(req);
    if (!claims?.sub) throw new HttpError(401, 'Not signed in', { code: 'no_authorization', msg: 'Not signed in' });
    const user = (await serial(() => db.query('select * from auth.users where id = $1', [claims.sub]))).rows[0];
    if (!user) throw new HttpError(404, 'User not found', { msg: 'User not found' });
    return send(res, 200, userJson(user));
  }
  if (path === '/logout' && req.method === 'POST') {
    const claims = verifyJwt((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    if (claims?.sub) await serial(() => db.query('update auth.refresh_tokens set revoked = true where user_id = $1', [claims.sub]));
    return send(res, 204);
  }
  if (path === '/settings') return send(res, 200, { external: { email: true, phone: true }, disable_signup: true });
  throw new HttpError(404, 'Not found');
}

export async function createAuthUser({ email, phone, password, full_name = '', role = 'site_engineer' }) {
  const id = randomUUID();
  await db.query(
    `insert into auth.users (id, email, phone, encrypted_password, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4, $5, $6)`,
    [id, email ? email.toLowerCase() : null, phone || null, hashPassword(password), { full_name }, { role }]);
  await db.query('update public.profiles set full_name = $2, phone = $3 where id = $1', [id, full_name, phone || null]);
  return id;
}

// ---------------------------------------------------------------------------
// REST (PostgREST subset)
// ---------------------------------------------------------------------------

const IDENT = /^[a-z_][a-z0-9_]*$/;
const q = (id) => {
  if (!IDENT.test(id)) throw new HttpError(400, `Invalid identifier "${id}"`);
  return `"${id}"`;
};
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and']);

function splitTop(s) {
  const out = []; let depth = 0; let cur = ''; let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseSelect(s) {
  return splitTop(s || '*').map((item) => {
    if (item === '*') return { type: 'star' };
    // [alias:]name[!hint][!inner|!left](…) — hint = FK constraint or column name, as in PostgREST
    const m = item.match(/^(?:([a-z_][a-z0-9_]*)\s*:\s*)?([a-z_][a-z0-9_]*)((?:![a-z0-9_]+)*)\((.*)\)$/s);
    if (m) {
      const bangs = m[3].split('!').filter(Boolean);
      return { type: 'embed', alias: m[1] ?? m[2], name: m[2], inner: bangs.includes('inner'),
        hint: bangs.find((b) => b !== 'inner' && b !== 'left') ?? null, items: parseSelect(m[4]) };
    }
    const col = item.split(':').pop().split('::')[0].trim();
    return { type: 'col', name: col };
  });
}

class Params {
  constructor() { this.values = []; }
  add(v) { this.values.push(v); return `$${this.values.length}`; }
}

function condition(alias, col, expr, P) {
  let neg = false;
  if (expr.startsWith('not.')) { neg = true; expr = expr.slice(4); }
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot);
  const val = expr.slice(dot + 1);
  const c = `${alias}.${q(col)}`;
  const ops = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  let sql;
  if (ops[op]) sql = `${c} ${ops[op]} ${P.add(val)}`;
  else if (op === 'is') {
    const v = val.toLowerCase();
    if (!['null', 'true', 'false', 'unknown'].includes(v)) throw new HttpError(400, `Invalid is value ${val}`);
    sql = `${c} is ${v}`;
  } else if (op === 'in') {
    const items = splitTop(val.replace(/^\(|\)$/g, '')).map((x) => x.replace(/^"|"$/g, ''));
    sql = items.length ? `${c} in (${items.map((x) => P.add(x)).join(', ')})` : 'false';
  } else if (op === 'like' || op === 'ilike') sql = `${c} ${op} ${P.add(val.replace(/\*/g, '%'))}`;
  else if (op === 'cs') sql = `${c} @> ${P.add(val)}`;
  else throw new HttpError(400, `Unsupported operator ${op}`);
  return neg ? `not (${sql})` : sql;
}

// Like PostgREST: several FKs between the two tables are ambiguous unless the embed names one (name!fk_or_column(…)).
function relation(from, to, hint) {
  const ok = (f) => !hint || f.name === hint || f.column === hint;
  const cands = [
    ...fkeys.filter((f) => f.table === from && f.ftable === to && ok(f)).map((f) => ({ kind: 'm2o', local: f.column, remote: f.fcolumn, fk: f.name })),
    ...(from === to ? [] : fkeys.filter((f) => f.table === to && f.ftable === from && ok(f)).map((f) => ({ kind: 'o2m', local: f.fcolumn, remote: f.column, fk: f.name }))),
  ];
  if (cands.length > 1) {
    throw new HttpError(300, `Could not embed because more than one relationship was found for '${from}' and '${to}'`,
      { code: 'PGRST201', hint: `Try changing '${to}' to one of: ${cands.map((c) => `${to}!${c.fk}`).join(', ')}` });
  }
  if (cands.length) return cands[0];
  throw new HttpError(400, `Could not find a relationship between '${from}' and '${to}'`, { code: 'PGRST200' });
}

let aliasSeq = 0;
function selectList(table, alias, items, embedFilters, P, where) {
  return items.map((it) => {
    if (it.type === 'star') return `${alias}.*`;
    if (it.type === 'col') return `${alias}.${q(it.name)}`;
    if (!relations.has(it.name)) throw new HttpError(400, `Unknown relation ${it.name}`);
    const rel = relation(table, it.name, it.hint);
    const ea = `e${++aliasSeq}`;
    const conds = [`${ea}.${q(rel.remote)} = ${alias}.${q(rel.local)}`,
      ...(embedFilters[it.name] ?? []).map(([col, expr]) => condition(ea, col, expr, P))];
    const inner = `select ${selectList(it.name, ea, it.items, {}, P, null)} from public.${q(it.name)} ${ea} where ${conds.join(' and ')}`;
    if (it.inner && where) where.push(`exists (select 1 from public.${q(it.name)} ${ea} where ${conds.join(' and ')})`);
    return rel.kind === 'm2o'
      ? `(select row_to_json(_x) from (${inner}) _x) as ${q(it.alias)}`
      : `(select coalesce(json_agg(_x), '[]'::json) from (${inner}) _x) as ${q(it.alias)}`;
  }).join(', ');
}

function whereClause(url, alias, P) {
  const where = [];
  const embedFilters = {};
  for (const [key, val] of url.searchParams) {
    if (RESERVED.has(key)) continue;
    if (key.includes('.')) {
      const [rel, col] = key.split('.');
      (embedFilters[rel] ??= []).push([col, val]);
    } else where.push(condition(alias, key, val, P));
  }
  for (const key of ['or', 'and']) {
    const v = url.searchParams.get(key);
    if (!v) continue;
    const parts = splitTop(v.replace(/^\(|\)$/g, '')).map((p) => {
      const d = p.indexOf('.');
      return condition(alias, p.slice(0, d), p.slice(d + 1), P);
    });
    where.push(`(${parts.join(key === 'or' ? ' or ' : ' and ')})`);
  }
  return { where, embedFilters };
}

function orderClause(url, alias) {
  const o = url.searchParams.get('order');
  if (!o) return '';
  return ' order by ' + o.split(',').map((part) => {
    const [col, ...mods] = part.split('.');
    return `${alias}.${q(col)}${mods.includes('desc') ? ' desc' : ' asc'}${mods.includes('nullsfirst') ? ' nulls first' : mods.includes('nullslast') ? ' nulls last' : ''}`;
  }).join(', ');
}

async function handleRest(req, res, path, url) {
  const claims = bearerClaims(req);
  const role = claims?.role === 'authenticated' ? 'authenticated' : 'anon';
  const ctx = { sub: claims?.sub, role, headers: { 'x-device-id': req.headers['x-device-id'] } };
  const prefer = req.headers.prefer ?? '';
  const wantObject = (req.headers.accept ?? '').includes('vnd.pgrst.object');

  // RPC
  const rpc = path.match(/^\/rpc\/([a-z_][a-z0-9_]*)$/);
  if (rpc) {
    const args = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readJson(req);
    const P = new Params();
    const named = Object.entries(args).map(([k, v]) => `${q(k)} => ${P.add(v !== null && typeof v === 'object' ? JSON.stringify(v) : v)}`);
    const out = await tx(ctx, () => db.query(`select to_json(public.${q(rpc[1])}(${named.join(', ')})) as r`, P.values));
    return send(res, 200, out.rows[0]?.r ?? null);
  }

  const table = path.replace(/^\//, '');
  if (!relations.has(table)) throw new HttpError(404, `relation "public.${table}" does not exist`, { code: '42P01' });
  aliasSeq = 0;
  const P = new Params();
  const { where, embedFilters } = whereClause(url, 't0', P);
  const whereSql = () => (where.length ? ` where ${where.join(' and ')}` : '');

  if (req.method === 'GET' || req.method === 'HEAD') {
    const list = selectList(table, 't0', parseSelect(url.searchParams.get('select')), embedFilters, P, where);
    // Hosted Supabase caps every response at max_rows (1000 by default) — mimic it so truncated lists show up locally.
    const limit = Math.min(Number(url.searchParams.get('limit') ?? MAX_ROWS), MAX_ROWS);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const page = ` limit ${limit}${offset ? ` offset ${offset}` : ''}`;
    const rows = req.method === 'HEAD' ? [] : (await tx(ctx, () => db.query(
      `select coalesce(json_agg(_r), '[]'::json) as data from (select ${list} from public.${q(table)} t0${whereSql()}${orderClause(url, 't0')}${page}) _r`,
      P.values))).rows[0].data;
    const headers = {};
    if (prefer.includes('count=')) {
      // count query reuses the filter params; embeds only matter for !inner filters already in `where`
      const total = (await tx(ctx, () => db.query(`select count(*)::int n from public.${q(table)} t0${whereSql()}`, P.values))).rows[0].n;
      headers['Content-Range'] = rows.length ? `${offset}-${offset + rows.length - 1}/${total}` : `*/${total}`;
    }
    if (req.method === 'HEAD') return send(res, 200, undefined, headers);
    if (wantObject) {
      if (rows.length !== 1) throw new HttpError(406, 'JSON object requested, multiple (or no) rows returned', { code: 'PGRST116', details: `The result contains ${rows.length} rows` });
      return send(res, 200, rows[0], headers);
    }
    return send(res, 200, rows, headers);
  }

  const returning = prefer.includes('return=representation');
  const finish = (rows, status) => {
    if (!returning) return send(res, status === 201 ? 201 : 204);
    if (wantObject) {
      if (rows.length !== 1) throw new HttpError(406, 'JSON object requested, multiple (or no) rows returned', { code: 'PGRST116' });
      return send(res, status, rows[0]);
    }
    return send(res, status, rows);
  };

  if (req.method === 'POST') {
    let body = await readJson(req);
    if (!Array.isArray(body)) body = [body];
    if (!body.length) return finish([], 201);
    const cols = [...new Set(body.flatMap((r) => Object.keys(r)))];
    const colSql = cols.map(q).join(', ');
    let conflict = '';
    if (prefer.includes('resolution=')) {
      const target = (url.searchParams.get('on_conflict') ?? (pkeys[table] ?? ['id']).join(',')).split(',').map((c) => c.trim());
      const updates = cols.filter((c) => !target.includes(c));
      conflict = ` on conflict (${target.map(q).join(', ')}) ` + (prefer.includes('ignore-duplicates') || !updates.length
        ? 'do nothing'
        : `do update set ${updates.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}`);
    }
    const rows = (await tx(ctx, () => db.query(
      `with w as (insert into public.${q(table)} (${colSql}) select ${colSql} from json_populate_recordset(null::public.${q(table)}, ${P.add(JSON.stringify(body))}::json)${conflict} returning *)
       select coalesce(json_agg(w), '[]'::json) as data from w`, P.values))).rows[0].data;
    return finish(rows, 201);
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const cols = Object.keys(body);
    if (!cols.length) return finish([], 200);
    const rows = (await tx(ctx, () => db.query(
      `with w as (update public.${q(table)} t0 set ${cols.map((c) => `${q(c)} = _s.${q(c)}`).join(', ')}
         from json_populate_record(null::public.${q(table)}, ${P.add(JSON.stringify(body))}::json) _s${whereSql()} returning t0.*)
       select coalesce(json_agg(w), '[]'::json) as data from w`, P.values))).rows[0].data;
    return finish(rows, 200);
  }

  if (req.method === 'DELETE') {
    if (!where.length) throw new HttpError(400, 'DELETE requires a filter', { code: '21000' });
    const rows = (await tx(ctx, () => db.query(
      `with w as (delete from public.${q(table)} t0${whereSql()} returning t0.*) select coalesce(json_agg(w), '[]'::json) as data from w`,
      P.values))).rows[0].data;
    return finish(rows, 200);
  }
  throw new HttpError(405, 'Method not allowed');
}

// ---------------------------------------------------------------------------
// Storage (single private bucket on disk, signed URLs)
// ---------------------------------------------------------------------------

const signPath = (p, exp) => createHmac('sha256', SECRET).update(`${p}:${exp}`).digest('base64url');
const safePath = (bucket, p) => {
  const full = normalize(join(STORAGE, bucket, p));
  if (!full.startsWith(join(STORAGE, bucket))) throw new HttpError(400, 'Invalid path');
  return full;
};

async function handleStorage(req, res, path, url) {
  // signed download (no auth header — the token is the credential)
  let m = path.match(/^\/object\/sign\/([^/]+)\/(.+)$/);
  if (m && req.method === 'GET') {
    const p = decodeURIComponent(m[2]);
    const [exp, sig] = (url.searchParams.get('token') ?? '').split('.');
    if (!sig || Number(exp) < Date.now() / 1000 || sig !== signPath(`${m[1]}/${p}`, exp)) throw new HttpError(400, 'Invalid or expired signature');
    const file = safePath(m[1], p);
    if (!existsSync(file)) throw new HttpError(404, 'Object not found');
    return send(res, 200, readFileSync(file), { 'Content-Type': p.endsWith('.png') ? 'image/png' : p.endsWith('.pdf') ? 'application/pdf' : p.endsWith('.webp') ? 'image/webp' : /\.hei[cf]$/.test(p) ? 'image/heic' : 'image/jpeg' });
  }

  const claims = bearerClaims(req);
  if (claims?.role !== 'authenticated') throw new HttpError(401, 'Not signed in');
  const member = async (p) => {
    const project = p.split('/')[0];
    // Same rule as the storage.objects policies: member of the project + allowed to see that record type.
    const ok = (await asUser(claims.sub, () => db.query(`select case when to_regproc('app.storage_path_visible') is null
      then app.is_member($1::text::uuid) else app.storage_path_visible($2::text) end as ok`, [project, p]))).rows[0].ok;
    if (!ok) throw new HttpError(403, 'new row violates row-level security policy');
  };
  const signed = (bucket, p, expiresIn) => {
    const exp = Math.floor(Date.now() / 1000) + Number(expiresIn ?? 3600);
    return `/object/sign/${bucket}/${p.split('/').map(encodeURIComponent).join('/')}?token=${exp}.${signPath(`${bucket}/${p}`, exp)}`;
  };

  m = path.match(/^\/object\/sign\/([^/]+)$/);   // createSignedUrls
  if (m && req.method === 'POST') {
    const body = await readJson(req);
    const out = [];
    for (const p of body.paths ?? []) {
      try { await member(p); out.push({ path: p, signedURL: signed(m[1], p, body.expiresIn), error: null }); }
      catch { out.push({ path: p, signedURL: null, error: 'Object not found' }); }
    }
    return send(res, 200, out);
  }
  m = path.match(/^\/object\/sign\/([^/]+)\/(.+)$/);  // createSignedUrl
  if (m && req.method === 'POST') {
    const body = await readJson(req);
    await member(decodeURIComponent(m[2]));
    return send(res, 200, { signedURL: signed(m[1], decodeURIComponent(m[2]), body.expiresIn) });
  }
  m = path.match(/^\/object\/([^/]+)\/(.+)$/);   // upload
  if (m && (req.method === 'POST' || req.method === 'PUT')) {
    const p = decodeURIComponent(m[2]);
    await member(p);
    const file = safePath(m[1], p);
    if (existsSync(file) && req.headers['x-upsert'] !== 'true' && req.method === 'POST') {
      throw new HttpError(409, 'The resource already exists', { error: 'Duplicate', statusCode: '409' });
    }
    mkdirSync(dirname(file), { recursive: true });
    let data = await readBody(req);
    const ct = req.headers['content-type'] ?? '';
    if (ct.startsWith('multipart/form-data')) {
      // supabase-js sends Blob/File bodies as multipart: take the first file part
      const boundary = '--' + ct.split('boundary=')[1];
      const parts = data.toString('latin1').split(boundary).filter((x) => x.includes('\r\n\r\n'));
      const filePart = parts.find((x) => /filename=|name=""/.test(x)) ?? parts[parts.length - 1];
      const start = filePart.indexOf('\r\n\r\n') + 4;
      data = Buffer.from(filePart.slice(start, filePart.lastIndexOf('\r\n')), 'latin1');
    }
    writeFileSync(file, data);
    return send(res, 200, { Key: `${m[1]}/${p}`, Id: randomUUID() });
  }
  throw new HttpError(404, 'Not found');
}

// ---------------------------------------------------------------------------
// Edge function: admin-users (same contract as supabase/functions/admin-users)
// ---------------------------------------------------------------------------

const ROLES = ['store_keeper', 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'procurement', 'admin', 'security', 'finance', 'client'];

async function adminUsers(req, res) {
  const claims = bearerClaims(req);
  if (!claims?.sub) throw new HttpError(401, 'Not signed in');
  const body = await readJson(req);
  const out = await asService(async () => {
    const caller = (await db.query('select role, is_active from public.profiles where id = $1', [claims.sub])).rows[0];
    if (!caller?.is_active || !['admin', 'manager', 'coordinator'].includes(caller.role)) throw new HttpError(403, 'Only management can manage users');
    const checkRole = (r) => {
      if (r === undefined) return;
      if (!ROLES.includes(r)) throw new HttpError(400, 'Invalid role');
      if (r === 'admin' && caller.role !== 'admin') throw new HttpError(403, 'Only an administrator can grant the admin role');
    };
    const guardTarget = async (id) => {
      const t = (await db.query('select role from public.profiles where id = $1', [id])).rows[0];
      if (!t) throw new HttpError(404, 'User not found');
      if (t.role === 'admin' && caller.role !== 'admin') throw new HttpError(403, 'Only an administrator can change an administrator');
    };
    switch (body.action) {
      case 'create': {
        checkRole(body.role);
        if (!body.email && !body.phone) throw new HttpError(400, 'Email or phone is required');
        if (!body.password || String(body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
        const dup = (await db.query('select 1 from auth.users where lower(email) = lower($1) or phone = $2', [body.email ?? '', body.phone ?? ''])).rows[0];
        if (dup) throw new HttpError(400, 'A user with this email or phone already exists');
        const id = await createAuthUser(body);
        for (const pid of body.project_ids ?? []) {
          await db.query('insert into public.project_members (project_id, user_id) values ($1, $2) on conflict do nothing', [pid, id]);
        }
        return { user_id: id };
      }
      case 'update': {
        await guardTarget(body.user_id);
        checkRole(body.role);
        for (const k of ['full_name', 'phone', 'role']) {
          if (body[k] !== undefined) await db.query(`update public.profiles set ${q(k)} = $2 where id = $1`, [body.user_id, body[k]]);
        }
        if (body.role) await db.query(`update auth.users set raw_app_meta_data = raw_app_meta_data || jsonb_build_object('role', $2::text) where id = $1`, [body.user_id, body.role]);
        return { ok: true };
      }
      case 'set_active': {
        await guardTarget(body.user_id);
        if (body.user_id === claims.sub) throw new HttpError(400, 'You cannot deactivate yourself');
        await db.query('update public.profiles set is_active = $2 where id = $1', [body.user_id, !!body.is_active]);
        await db.query('update auth.users set banned = $2 where id = $1', [body.user_id, !body.is_active]);
        if (!body.is_active) await db.query('update auth.refresh_tokens set revoked = true where user_id = $1', [body.user_id]);
        return { ok: true };
      }
      case 'reset_password': {
        await guardTarget(body.user_id);
        if (!body.password || String(body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
        await db.query('update auth.users set encrypted_password = $2 where id = $1', [body.user_id, hashPassword(body.password)]);
        return { ok: true };
      }
      default:
        throw new HttpError(400, 'Unknown action');
    }
  });
  return send(res, 200, out);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') return send(res, 204);
    if (p === '/' || p === '/health') return send(res, 200, { ok: true, service: 'supabase-local' });
    if (p.startsWith('/auth/v1')) return await handleAuth(req, res, p.slice(8), url);
    if (p.startsWith('/rest/v1')) return await handleRest(req, res, p.slice(8), url);
    if (p.startsWith('/storage/v1')) return await handleStorage(req, res, p.slice(11), url);
    if (p === '/functions/v1/admin-users' && req.method === 'POST') return await adminUsers(req, res);
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (e instanceof HttpError) {
      if (process.env.DEBUG) console.warn(req.method, p, e.status, e.message);
      return send(res, e.status, { message: e.message, error: e.message, ...e.extra });
    }
    const { status, body } = pgError(e);
    console.warn(`${req.method} ${p} → ${status}: ${e.message}`);
    return send(res, status, body);
  }
});

console.log('Preparing local database…');
await migrate();
await loadCatalog();
// Seed only an empty database — new migrations on an existing one must not re-create the demo.
const empty = (await db.query('select not exists (select 1 from auth.users) as e')).rows[0].e;
if (empty) {
  const rich = process.env.SM_DEMO !== 'basic';
  await seedDemo({ db, asUser, createAuthUser }, { activity: !rich });
  if (rich) await seedRichDemo({ db, asUser, createAuthUser });
}

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254')).map((i) => i.address);
  console.log(`
Local Supabase running
  API URL (this PC):  http://localhost:${PORT}
  API URL (phone):    ${lan.map((a) => `http://${a}:${PORT}`).join('  ') || '(no LAN address found)'}
  anon key:           ${ANON_KEY}

Demo logins (password demo1234):
  admin@site.local · manager@site.local · coordinator@site.local · office@site.local
  site@site.local · store@site.local · procurement@site.local · gate@site.local · client@site.local
  Data directory:     ${DATA}
`);
});
