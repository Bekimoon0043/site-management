# Site Console (web)

Management web console for the Site Materials Management & Progress Tracking system. It is a React + Vite + TypeScript single-page app that talks directly to Supabase. All business rules are enforced in the database (RLS + RPC functions in `../supabase/migrations`); the console only hides what a role cannot do.

## Setup

1. Apply the database migrations and seed to your Supabase project (see the repository README).
2. Configure the app:
   ```sh
   cp .env.example .env
   # edit .env: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (Supabase → Project settings → API)
   ```
3. Install and run:
   ```sh
   npm install
   npm run dev        # http://localhost:5173
   ```

User management (create, deactivate, reset password) calls the `admin-users` edge function, so deploy it first: `supabase functions deploy admin-users`.

## Build and deploy

```sh
npm run build      # type-checks (tsc -b) and writes static files to dist/
npm run preview    # serve dist/ locally
```

`dist/` is a static site and can go on any static host (Netlify, Vercel, Cloudflare Pages, S3, nginx). Configure the host to serve `index.html` for unknown paths, because the app uses client-side routes such as `/requests/<id>`:

- Netlify: add `public/_redirects` with `/*  /index.html  200`
- Vercel: a rewrite of `/(.*)` to `/index.html`

Set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` as build-time environment variables on the host. The anon key is public by design, because RLS protects the data.

## What's in it

| Page | Covers |
|---|---|
| Dashboard | Management tiles that drill down to their lists: progress, delays, approvals and ageing, low stock, variance alerts, wastage, pending adjustments, counts and verifications, emergency issues, issued cost (FR-DB-02, §4.9) |
| Requests | MR register with filters; detail with lines, element split, on-site stock, history, issues, attachments; review / approve (partial) / reject / return / cancel / close |
| Store | Stock balance, low stock, bin card with running balance, GRN / MIV / MRN registers with reversal, wastage approvals, stock count approvals, transfers, emergency-issue regularisation |
| Progress | Roll-up by block/level, element progress, delay report, verification queue (verify / adjust / reject), planned-vs-actual S-curve |
| Reports | MR register, approval ageing, GRN register, stock ledger, stock status, issue register by element, consumption vs BoQ, wastage, supplier performance, progress, delays, issued cost. Filterable; Excel export and print/PDF |
| Elements & BoQ | Element register, activities and take-off vs issued; take-off quantities; BoQ items with rates (price roles only); Excel import with templates and validated preview |
| Materials | Grades/specs, materials, unit conversions, prices (price roles only), suppliers, Excel import |
| Project setup | Projects and workflow settings (review step, hold points, escalation, variance thresholds), members, blocks/levels/zones, stores, opening balances |
| Users / Settings / Audit log | Accounts via the edge function, price-visibility roles, approval limits (BR-08), audit viewer with Excel export |

Each browser gets a persistent device id. It is sent as the `x-device-id` header (audit trail) and registered with `register_device` after login.
