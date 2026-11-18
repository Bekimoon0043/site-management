# Deploying the Web Console on Railway

## 1. Create a new project on Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select `Bekimoon0043/site-management`
3. After the service is created, open **Settings**:

| Setting | Value |
|---------|-------|
| **Root Directory** | `web` |
| **Builder** | Dockerfile (auto-detected) |

## 2. Add environment variables

In the service → **Variables**, add these (they are used at **build time**):

```
VITE_SUPABASE_URL=https://altaudsxszkszeehlgxl.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
VITE_TELEGRAM_BOT=Sitemanagement_bot
```

> **Important:** Do **not** put the Telegram bot token here.  
> The token belongs only in Supabase Edge Function secrets.

## 3. Deploy

Railway will build the Docker image and start the service automatically.  
The app will be available at the generated `*.up.railway.app` URL.

### Custom domain (optional)
Settings → Domains → Add custom domain.

## 4. Telegram bot setup (Supabase side)

The bot token must be set as Supabase secrets (not in Railway):

```bash
npx supabase secrets set TELEGRAM_BOT_TOKEN=9240772572:AAHo... 
npx supabase secrets set TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)
```

Then deploy the webhook function and register it:

```bash
npx supabase functions deploy telegram-webhook --no-verify-jwt

# Register the webhook (replace SECRET with the value you just set)
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://altaudsxszkszeehlgxl.supabase.co/functions/v1/telegram-webhook" \
  -d "secret_token=YOUR_TELEGRAM_WEBHOOK_SECRET" \
  -d 'allowed_updates=["message","callback_query"]'
```

Also make sure these Edge Functions are deployed:
- `admin-users`
- `send-push`
- `telegram-webhook`
- `dispatch-notification` (if used)

## Notes

- The web app is a pure static SPA. All business logic and security live in Supabase (RLS + RPCs).
- SPA routing is handled by `serve -s` (unknown paths fall back to `index.html`).
- Rebuild is required if you change any `VITE_*` variable.
