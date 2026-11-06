// Smoke test: drives the local server through supabase-js, like the apps do.
import { createClient } from '@supabase/supabase-js';
import { randomUUID as uuid } from 'node:crypto';
const URL = process.env.URL ?? 'http://localhost:54321';
const KEY = process.env.KEY;
const client = () => createClient(URL, KEY, { auth: { persistSession: false } });
let fail = 0;
const ok = (c, m, extra = '') => { console.log(c ? '  ✓' : '  ✗', m, extra); if (!c) fail++; };

const office = client();
const s = await office.auth.signInWithPassword({ email: 'office@site.local', password: 'demo1234' });
ok(!s.error, 'office engineer signs in', s.error?.message ?? '');
const bad = await client().auth.signInWithPassword({ email: 'office@site.local', password: 'nope' });
ok(bad.error?.message === 'Invalid login credentials', 'wrong password rejected');

const { data: projects } = await office.from('projects').select('*');
ok(projects?.some((p) => p.code === 'DEMO'), `projects visible: ${projects?.map((p) => p.code)}`);
const P = projects.find((p) => p.code === 'DEMO').id;
// works with both demos: the small one has a single submitted request, the rich one several
const { data: mrs, error: e1 } = await office.from('material_requests').select('*, mr_lines(material_spec_id, qty, deleted_at)').eq('project_id', P).eq('status', 'submitted').order('created_at', { ascending: false }).range(0, 49);
ok(!e1 && mrs.length >= 1 && mrs[0].mr_lines.length >= 1, 'MR with embedded lines', e1?.message ?? '');
const { count } = await office.from('material_requests').select('*', { count: 'exact', head: true }).eq('project_id', P).eq('status', 'submitted');
ok(count === mrs.length, `head count = ${count}`);
const { data: le } = await office.from('mr_line_elements').select('*, mr_lines!inner(mr_id)').eq('mr_lines.mr_id', mrs[0].id).is('deleted_at', null);
ok(le?.length >= 1, `!inner embed filter rows = ${le?.length}`);
const { data: one, error: e2 } = await office.from('projects').select('*').eq('id', P).maybeSingle();
ok(one?.code === 'DEMO', 'maybeSingle', e2?.message ?? '');
const { data: prices } = await office.from('spec_prices').select('*');
ok(prices?.length === 0, 'office engineer cannot see prices');
const r = await office.rpc('mr_action', { p: { op_id: uuid(), mr_id: mrs[0].id, action: 'review', comment: 'Checked' } });
ok(r.data?.status === 'reviewed', 'review via RPC', r.error?.message ?? '');
const r2 = await office.rpc('mr_action', { p: { mr_id: mrs[0].id, action: 'approve' } });
ok(/not allowed/.test(r2.error?.message ?? ''), 'office engineer cannot approve', r2.error?.message);
const { data: blk } = await office.from('blocks').select('*').eq('project_id', P);
const up = await office.from('levels').upsert([{ project_id: P, block_id: blk[0].id, code: 'L3', name: 'Level 3', sort_order: 3 }], { onConflict: 'block_id,code' }).select();
ok(!up.error && up.data?.length === 1, 'upsert levels', up.error?.message ?? '');
const { data: sb } = await office.from('v_stock_balance').select('*').eq('project_id', P).order('label');
ok(sb?.length >= 8 && typeof sb[0].qty === 'number', `stock view rows=${sb?.length}, qty is number`);
const or = await office.from('transfers').select('*').or(`project_id.eq.${P},to_project_id.eq.${P}`);
ok(!or.error, 'or() filter', or.error?.message ?? '');

const coord = client();
await coord.auth.signInWithPassword({ email: 'coordinator@site.local', password: 'demo1234' });
const ap = await coord.rpc('mr_action', { p: { op_id: uuid(), mr_id: mrs[0].id, action: 'approve' } });
ok(ap.data?.status === 'approved', 'coordinator approves', ap.error?.message ?? '');
const fn = await coord.functions.invoke('admin-users', { body: { action: 'create', email: 'new@site.local', password: 'secret12', full_name: 'New Person', role: 'site_engineer', project_ids: [P] } });
ok(fn.data?.user_id, 'admin-users creates user', fn.error?.message ?? JSON.stringify(fn.data));
const newbie = client();
const ns = await newbie.auth.signInWithPassword({ email: 'new@site.local', password: 'secret12' });
ok(!ns.error, 'new user signs in');

const store = client();
await store.auth.signInWithPassword({ email: 'store@site.local', password: 'demo1234' });
const path = `${P}/grn/${uuid()}.jpg`;
const upl = await store.storage.from('attachments').upload(path, new Uint8Array([255, 216, 255, 1, 2, 3]), { contentType: 'image/jpeg', upsert: true });
ok(!upl.error, 'storage upload', upl.error?.message ?? '');
const su = await store.storage.from('attachments').createSignedUrls([path], 60);
const got = await fetch(su.data[0].signedUrl);
ok(got.status === 200 && (await got.arrayBuffer()).byteLength === 6, 'signed URL download');
const refreshed = await store.auth.refreshSession();
ok(!refreshed.error && refreshed.data.session, 'token refresh');
await store.auth.signOut();
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
