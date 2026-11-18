# Deploying the Web Console on Railway

## Recommended setup (Railpack)

### 1. Service Settings

| Setting | Value |
|---------|-------|
| **Root Directory** | `web` |
| **Builder** | Railpack (default) |

### 2. Environment Variables

```
VITE_SUPABASE_URL=https://altaudsxszkszeehlgxl.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_TELEGRAM_BOT=Sitemanagement_bot
```

These must be present at **build time** (Vite inlines them).

### 3. Deploy

Just redeploy. Railpack will:
1. Run `npm install`
2. Run `npm run build`
3. Start with `npx serve -s dist -l $PORT`

## Telegram bot (Supabase side only)

Do **not** put the bot token in Railway.

```bash
npx supabase secrets set TELEGRAM_BOT_TOKEN=your-token
npx supabase secrets set TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)
npx supabase functions deploy telegram-webhook --no-verify-jwt
```
