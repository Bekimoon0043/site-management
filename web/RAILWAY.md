# Deploying the Web Console on Railway

## Recommended setup (current)

The Dockerfile and `railway.toml` now live at the **repository root**.

### 1. Railway service settings

| Setting | Value |
|---------|-------|
| **Root Directory** | *(leave empty / blank)* |
| **Builder** | Dockerfile |

### 2. Environment variables

Add these in the service → **Variables**:

```
VITE_SUPABASE_URL=https://altaudsxszkszeehlgxl.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_TELEGRAM_BOT=Sitemanagement_bot
```

> Do **not** put the Telegram bot token here.  
> Put the token only in Supabase secrets.

### 3. Deploy

Redeploy. You should see in the logs:

```
==========================
Using detected Dockerfile!
==========================
```

## Telegram bot setup (Supabase)

```bash
npx supabase secrets set TELEGRAM_BOT_TOKEN=your-bot-token
npx supabase secrets set TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)

npx supabase functions deploy telegram-webhook --no-verify-jwt

# Then register the webhook with Telegram (use the secret you just set)
```

Also deploy `admin-users` and `send-push` if you haven’t already.
