// Fan-out of a new notification to push and Telegram per the user's
// notification_prefs (backlog F1, FR-NT-02). Supersedes send-push: point the
// Database Webhook (table public.notifications, INSERT) here INSTEAD of
// send-push, with header x-webhook-secret: $DISPATCH_WEBHOOK_SECRET.
// send-push keeps working unchanged for setups that have not switched.
//
// Channel decisions (quiet hours in EAT, critical bypass, Telegram link,
// single-use Approve/Reject buttons) are made in SQL by
// public.notification_dispatch_plan — this function only delivers.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN,
//          DISPATCH_WEBHOOK_SECRET (falls back to PUSH_WEBHOOK_SECRET).

import { createClient } from 'npm:@supabase/supabase-js@2';

interface WebhookPayload {
  type: 'INSERT';
  table: string;
  record: { id: string; user_id: string; title: string; body: string | null; entity_type: string | null; entity_id: string | null; is_critical: boolean };
}
interface DispatchPlan {
  ok: boolean; error?: string; notification_id: string; user_id: string; quiet: boolean;
  in_app: boolean; push: boolean; sms: boolean; phone: string | null;
  telegram: { chat_id: number; text: string; parse_mode: 'HTML'; reply_markup?: unknown } | null;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const secret = Deno.env.get('DISPATCH_WEBHOOK_SECRET') ?? Deno.env.get('PUSH_WEBHOOK_SECRET');
  if (secret && req.headers.get('x-webhook-secret') !== secret) return new Response('forbidden', { status: 403 });

  const payload = (await req.json()) as WebhookPayload;
  if (payload.type !== 'INSERT' || payload.table !== 'notifications') return new Response('ignored');
  const n = payload.record;

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const { data: plan, error } = await admin.rpc('notification_dispatch_plan', { p: { notification_id: n.id } });
  if (error || !plan?.ok) return json({ ok: false, error: error?.message ?? plan?.error });
  const p = plan as DispatchPlan;
  const out: Record<string, unknown> = { quiet: p.quiet };

  // Push (Expo → FCM), same as send-push.
  if (p.push) {
    const { data: tokens } = await admin.from('push_tokens').select('token').eq('user_id', n.user_id);
    if (tokens?.length) {
      const messages = tokens.map(({ token }) => ({
        to: token, title: n.title, body: n.body ?? undefined, sound: 'default',
        priority: n.is_critical ? 'high' : 'default', channelId: n.is_critical ? 'critical' : 'default',
        data: { notification_id: n.id, entity_type: n.entity_type, entity_id: n.entity_id },
      }));
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(messages),
      });
      const tickets: { status: string; details?: { error?: string } }[] = (await res.json())?.data ?? [];
      const dead = tickets
        .map((t, i) => (t.status === 'error' && t.details?.error === 'DeviceNotRegistered' ? tokens[i].token : null))
        .filter((t): t is string => !!t);
      if (dead.length) await admin.from('push_tokens').delete().in('token', dead);
      out.push = { sent: messages.length, removed: dead.length };
    }
  }

  // Telegram (with single-use action buttons when the user can act).
  if (p.telegram) {
    const bot = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (bot) {
      const res = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...p.telegram, disable_web_page_preview: true }),
      });
      out.telegram = (await res.json())?.ok ?? false;
    }
  }

  // SMS for critical alerts (FR-NT-03) — gateway not contracted yet; plan.sms says when to send.
  if (p.sms) out.sms = 'not_configured';

  return json({ ok: true, ...out });
});
