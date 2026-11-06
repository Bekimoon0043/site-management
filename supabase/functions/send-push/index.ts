// Push delivery for notifications (FR-NT-01). Wire it up with a Database
// Webhook: table public.notifications, event INSERT, type "Supabase Edge
// Function" -> send-push. Sends through the Expo push service, which forwards
// to Firebase Cloud Messaging on Android.

import { createClient } from 'npm:@supabase/supabase-js@2';

interface WebhookPayload {
  type: 'INSERT';
  table: string;
  record: { id: string; user_id: string; title: string; body: string | null; entity_type: string | null; entity_id: string | null; is_critical: boolean };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('PUSH_WEBHOOK_SECRET');
  if (secret && req.headers.get('x-webhook-secret') !== secret) {
    return new Response('forbidden', { status: 403 });
  }

  const payload = (await req.json()) as WebhookPayload;
  if (payload.type !== 'INSERT' || payload.table !== 'notifications') return new Response('ignored');
  const n = payload.record;

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const { data: tokens } = await admin.from('push_tokens').select('token').eq('user_id', n.user_id);
  if (!tokens?.length) return new Response('no tokens');

  const messages = tokens.map(({ token }) => ({
    to: token,
    title: n.title,
    body: n.body ?? undefined,
    sound: 'default',
    priority: n.is_critical ? 'high' : 'default',
    channelId: n.is_critical ? 'critical' : 'default',
    data: { notification_id: n.id, entity_type: n.entity_type, entity_id: n.entity_id },
  }));

  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  const result = await res.json();

  // Drop tokens Expo reports as no longer registered.
  const tickets: { status: string; details?: { error?: string } }[] = result?.data ?? [];
  const dead = tickets
    .map((t, i) => (t.status === 'error' && t.details?.error === 'DeviceNotRegistered' ? tokens[i].token : null))
    .filter((t): t is string => !!t);
  if (dead.length) await admin.from('push_tokens').delete().in('token', dead);

  return new Response(JSON.stringify({ sent: messages.length, removed: dead.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
