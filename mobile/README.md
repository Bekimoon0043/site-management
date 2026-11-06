# Site Materials — Android app

React Native + Expo SDK 58 (TypeScript, expo-router). Offline-first client for the
Supabase backend in `../supabase`.

## Setup

```bash
cd mobile
cp .env.example .env          # fill in your Supabase URL and anon key
npm install                   # .npmrc sets legacy-peer-deps
npx expo start                # dev server
```

`EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` come from Supabase →
Project settings → API. Apply the migrations in `../supabase/migrations` first and
create users through the web console (or the `admin-users` edge function); the app
has no self-signup.

## Development build (required for the full feature set)

Several features need native modules that **Expo Go does not include**:

| Feature | Expo Go | Dev / release build |
|---|---|---|
| Local database | works, **unencrypted** (`PRAGMA key` is ignored) | encrypted with SQLCipher |
| Push notifications | not available (in-app notifications still work) | Expo push via `push_tokens` |
| Camera, GPS, biometrics, print/share | works | works |

Build and install a development client once, then use `npx expo start` as usual:

```bash
npx eas-cli@latest login
npx eas-cli@latest build -p android --profile development
```

## Installable APK

```bash
npx eas-cli@latest build -p android --profile preview      # or: npm run build:apk
```

EAS builds in the cloud, so no local Android SDK is needed. For push notifications,
run `npx eas-cli@latest init` once so `extra.eas.projectId` is set in the app config.

## How it works

- **Local store** (`src/lib/db.ts`): one encrypted SQLite table `rows(tbl, pk, project_id, parent, …, json)`
  holds every synced table, indexed by project and parent id for fast lookups.
- **Pull** (`src/lib/sync.ts`): each table in `SYNC_TABLES` is fetched incrementally by
  `updated_at` (per-table cursor, 2-minute overlap, 1000-row pages). RLS limits rows to
  the user's projects.
- **Push**: every write is an outbox entry sent FIFO as `supabase.rpc(name, { p })`
  with an `op_id`, so retries are idempotent. Network errors retry later; business-rule
  rejections are marked **failed** and shown on the Sync screen (retry / discard).
- **Optimistic apply** (`src/lib/optimistic.ts`): each op immediately writes the
  expected rows locally (including pending stock-ledger rows), tagged with the op id.
  Server copies replace them on pull; discarding a failed op rolls them back.
- **Document numbers**: `<PROJECT>-<TYPE>-<DEVICE>-<SEQ>`. The device prefix comes
  from `register_device`, and the counters are local, so numbers never collide offline.
- **Photos**: compressed to ≤1280 px JPEG, geotagged, queued and uploaded to the
  `attachments` bucket during sync (optional Wi-Fi only).

Sync runs on start, after every change, on reconnect, when the app returns to the
foreground, and every 3 minutes.

## UI / design system

"Blueprint & Beacon" tokens and themes (light, dark, sunlight) live in `src/theme`; the component library is
`src/components/ui` — see `src/components/README.md` for components and screen templates. Navigation is role-based
bottom tabs in `src/app/(tabs)`; create/post flows push on the root stack.

Icons use `@react-native-vector-icons/material-design-icons` (static import). The font is embedded by the package's
Android module at build time, so **a new dev/release build is needed** after pulling this change (Expo Go shows blank
icons). Lists use `@shopify/flash-list`; photos use `expo-image` with 320 px thumbnails made at capture; haptics use
`expo-haptics`.

## Checks

```bash
npm run typecheck                       # tsc --noEmit
npx expo export --platform android      # bundle check
```
