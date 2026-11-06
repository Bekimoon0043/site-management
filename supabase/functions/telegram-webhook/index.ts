// Telegram bot webhook (backlog F1). Register once:
//   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
//     -d url=https://<ref>.supabase.co/functions/v1/telegram-webhook \
//     -d secret_token=$TELEGRAM_WEBHOOK_SECRET -d 'allowed_updates=["message","callback_query"]'
//
// Handles:
//   /start <code>   link this chat to the user who created the code in the app (tg_link_chat)
//   /stop           unlink (tg_unlink_chat)
//   inline buttons  callback_data "<token>:<ap|rj|rv|rt|ak>" → tg_run_action, which runs the
//                   normal RPC as the token's user (app.run_action_as: RLS, limits, audit apply)
//   Reject          asks for a reason with ForceReply; the reply (carrying "ref:<token>") runs it.
//
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2';

interface TgUser { id: number; username?: string }
interface TgMessage { message_id: number; chat: { id: number }; from?: TgUser; text?: string; reply_to_message?: TgMessage }
interface TgCallback { id: string; from: TgUser; data?: string; message?: TgMessage }
interface TgUpdate { message?: TgMessage; callback_query?: TgCallback }

const BOT = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const tg = (method: string, body: Record<string, unknown>) =>
  fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => null);

const say = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  tg('sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CALLBACK = /^([A-Za-z0-9_-]{8,40}):([a-z]{2})$/;
const REF = /ref:([A-Za-z0-9_-]{8,40})/;
const DONE: Record<string, string> = { ap: 'Approved', rj: 'Rejected', rv: 'Reviewed', rt: 'Returned', ak: 'Acknowledged' };

async function runAction(token: string, action: string, chatId: number, comment?: string) {
  const { data, error } = await admin.rpc('tg_run_action', { p: { token, action, chat_id: chatId, comment } });
  return error ? { ok: false as const, message: error.message } : { ok: true as const, data };
}

async function onMessage(m: TgMessage) {
  const chatId = m.chat.id;
  const text = (m.text ?? '').trim();

  const start = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{6,64})$/.exec(text);
  if (start) {
    const { data, error } = await admin.rpc('tg_link_chat', { p: { code: start[1], chat_id: chatId, username: m.from?.username } });
    if (error || !data?.ok) return say(chatId, esc(data?.error ?? error?.message ?? 'Could not link this chat.'));
    return say(chatId, `Linked to <b>${esc(data.full_name || 'your account')}</b>. You will receive approvals and alerts here. Send /stop to unlink.`);
  }
  if (/^\/start\b/.test(text)) return say(chatId, 'Open the app → Profile → Connect Telegram to get a link.');
  if (/^\/stop\b/.test(text)) {
    await admin.rpc('tg_unlink_chat', { p: { chat_id: chatId } });
    return say(chatId, 'This chat is no longer linked. You will not receive notifications here.');
  }

  // Reason for a rejection (reply to our ForceReply prompt).
  const ref = m.reply_to_message?.text ? REF.exec(m.reply_to_message.text) : null;
  if (ref) {
    if (!text) return say(chatId, 'Please type the reason.');
    const res = await runAction(ref[1], 'rj', chatId, text);
    return say(chatId, res.ok ? `Rejected: ${esc(text)}` : esc(res.message));
  }
}

async function onCallback(q: TgCallback) {
  const chatId = q.message?.chat.id ?? q.from.id;
  const parsed = CALLBACK.exec(q.data ?? '');
  if (!parsed) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Unknown button' });
  const [, token, code] = parsed;

  if (code === 'rj') {
    await tg('answerCallbackQuery', { callback_query_id: q.id });
    return say(chatId, `Reply to this message with the reason for rejecting.\n<code>ref:${token}</code>`,
      { reply_markup: { force_reply: true, input_field_placeholder: 'Reason' } });
  }

  const res = await runAction(token, code, chatId);
  await tg('answerCallbackQuery', {
    callback_query_id: q.id, text: res.ok ? DONE[code] ?? 'Done' : res.message.slice(0, 190), show_alert: !res.ok,
  });
  if (res.ok && q.message) {
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
    await say(chatId, `${DONE[code] ?? 'Done'} ✓`, { reply_to_message_id: q.message.message_id });
  }
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
  if (!secret || req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    const update = (await req.json()) as TgUpdate;
    if (update.callback_query) await onCallback(update.callback_query);
    else if (update.message) await onMessage(update.message);
  } catch (e) {
    console.error('telegram-webhook', e);
  }
  // Always 200 so Telegram does not retry (tokens are single-use anyway).
  return new Response('ok');
});
