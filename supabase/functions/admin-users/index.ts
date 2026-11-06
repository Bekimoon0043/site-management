// User management (FR-ACC-05, SRS §3 "User management").
// Needs the service role, so it runs as an Edge Function rather than an RPC.
//
//   { action: 'create', email?, phone?, password, full_name, role, project_ids? } -> { user_id }
//   { action: 'update', user_id, full_name?, role?, phone? }                       -> { ok }
//   { action: 'set_active', user_id, is_active }                                   -> { ok }
//   { action: 'reset_password', user_id, password }                                -> { ok }

import { createClient } from 'npm:@supabase/supabase-js@2';

const ROLES = ['store_keeper', 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'procurement', 'admin', 'security', 'finance', 'client'];
const MANAGERS = ['admin', 'manager', 'coordinator'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-device-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

    // Identify the caller from their JWT.
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
    const { data: { user }, error: authErr } = await admin.auth.getUser(jwt);
    if (authErr || !user) throw new HttpError(401, 'Not signed in');
    const { data: caller } = await admin.from('profiles').select('role, is_active').eq('id', user.id).single();
    if (!caller?.is_active || !MANAGERS.includes(caller.role)) throw new HttpError(403, 'Only management can manage users');

    const body = await req.json();
    const checkRole = (role: unknown) => {
      if (role === undefined) return;
      if (typeof role !== 'string' || !ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
      if (role === 'admin' && caller.role !== 'admin') throw new HttpError(403, 'Only an administrator can grant the admin role');
    };
    const guardTarget = async (userId: string) => {
      const { data: target } = await admin.from('profiles').select('role').eq('id', userId).single();
      if (!target) throw new HttpError(404, 'User not found');
      if (target.role === 'admin' && caller.role !== 'admin') throw new HttpError(403, 'Only an administrator can change an administrator');
    };

    switch (body.action) {
      case 'create': {
        checkRole(body.role);
        if (!body.email && !body.phone) throw new HttpError(400, 'Email or phone is required');
        if (!body.password || String(body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
        const { data, error } = await admin.auth.admin.createUser({
          email: body.email || undefined,
          phone: body.phone || undefined,
          password: body.password,
          email_confirm: true,
          phone_confirm: true,
          user_metadata: { full_name: body.full_name ?? '' },
          app_metadata: { role: body.role ?? 'site_engineer' },
        });
        if (error) throw new HttpError(400, error.message);
        const id = data.user.id;
        // The on_auth_user_created trigger creates the profile; fill in the rest.
        await admin.from('profiles').update({ full_name: body.full_name ?? '', phone: body.phone ?? null }).eq('id', id);
        if (Array.isArray(body.project_ids) && body.project_ids.length) {
          const { error: mErr } = await admin.from('project_members')
            .insert(body.project_ids.map((project_id: string) => ({ project_id, user_id: id })));
          if (mErr) throw new HttpError(400, mErr.message);
        }
        return json({ user_id: id });
      }

      case 'update': {
        await guardTarget(body.user_id);
        checkRole(body.role);
        const patch: Record<string, unknown> = {};
        if (body.full_name !== undefined) patch.full_name = body.full_name;
        if (body.phone !== undefined) patch.phone = body.phone;
        if (body.role !== undefined) patch.role = body.role;
        const { error } = await admin.from('profiles').update(patch).eq('id', body.user_id);
        if (error) throw new HttpError(400, error.message);
        if (body.role !== undefined) {
          await admin.auth.admin.updateUserById(body.user_id, { app_metadata: { role: body.role } });
        }
        return json({ ok: true });
      }

      case 'set_active': {
        await guardTarget(body.user_id);
        if (body.user_id === user.id) throw new HttpError(400, 'You cannot deactivate yourself');
        const active = !!body.is_active;
        const { error } = await admin.from('profiles').update({ is_active: active }).eq('id', body.user_id);
        if (error) throw new HttpError(400, error.message);
        // Ban blocks sign-in and refresh, which ends existing sessions once their access token expires.
        await admin.auth.admin.updateUserById(body.user_id, { ban_duration: active ? 'none' : '876000h' });
        return json({ ok: true });
      }

      case 'reset_password': {
        await guardTarget(body.user_id);
        if (!body.password || String(body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
        const { error } = await admin.auth.admin.updateUserById(body.user_id, { password: body.password });
        if (error) throw new HttpError(400, error.message);
        return json({ ok: true });
      }

      default:
        throw new HttpError(400, 'Unknown action');
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
