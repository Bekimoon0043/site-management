// Daily project summary to linked Telegram groups (project_channels with kind
// 'daily_summary'): yesterday's receipts, issues, progress, gate activity and
// alerts, dated in both calendars. Text is built in SQL (public.daily_summary_plan).
//
// Schedule with pg_cron + pg_net at 18:00 EAT (15:00 UTC):
//   select cron.schedule('daily-summary', '0 15 * * *', $$
//     select net.http_post('https://<ref>.supabase.co/functions/v1/daily-summary',
//       '{"today": true}'::jsonb, '{}'::jsonb,
//       jsonb_build_object('x-cron-secret', '<CRON_SECRET>', 'Content-Type', 'application/json'))
//   $$);
// Body: {} → yesterday (EAT); {"today": true} → today; {"date": "YYYY-MM-DD"}; optional "project_id".
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, CRON_SECRET.

import { createClient } from 'npm:@supabase/supabase-js@2';

interface SummaryMessage { project_id: string; chat_id: number; text: string; counts: Record<string, number> }

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return new Response('forbidden', { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { date?: string; today?: boolean; project_id?: string };
  // Ethiopia is UTC+3 all year.
  const eatToday = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const date = body.date ?? (body.today ? eatToday : undefined);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin.rpc('daily_summary_plan', { p: { date, project_id: body.project_id } });
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });

  const bot = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
  const messages = (data?.messages ?? []) as SummaryMessage[];
  const results = await Promise.all(messages.map(async (m) => {
    const res = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: m.chat_id, text: m.text, parse_mode: 'HTML', disable_notification: true }),
    });
    return { project_id: m.project_id, ok: (await res.json())?.ok ?? false };
  }));

  return new Response(JSON.stringify({ ok: true, date: data?.date, sent: results }), { headers: { 'Content-Type': 'application/json' } });
});
