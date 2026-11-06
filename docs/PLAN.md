# Build Plan & SRS Traceability

Source: *SRS – Site Materials Management and Progress Tracking App, v0.1 (29 Oct 2026)*.

## Architecture

| Layer | Technology | Notes |
|---|---|---|
| Database / API | Supabase (Postgres 17, PostgREST, Auth, Storage) | Business rules in `security definer` RPCs; RLS on every table |
| Server functions | Supabase Edge Functions (Deno) | `admin-users` (service-role user admin), `send-push` (Expo → FCM) |
| Mobile | Expo SDK 58, React Native, TypeScript | expo-sqlite + SQLCipher, persistent outbox, background photo upload |
| Web console | React + Vite + TypeScript | Setup, Excel import/export, management dashboard, reports, users, audit |

Stack change from the first draft plan: React Native/Expo replaced Flutter because the build machine has no
Flutter/Android SDK and Expo's cloud builds (EAS) produce APKs without one; the backend is Supabase as requested.

### Key design decisions

1. **RPC-only writes for transactions.** Clients cannot insert into GRN/MIV/ledger tables; the RPCs validate
   and post atomically. This is what makes BR-01…BR-08 enforceable even with offline clients.
2. **Append-only stock ledger** with `available` / `quarantine` status. Corrections via `reverse_document`.
3. **Idempotent outbox.** Every RPC payload carries `op_id`; `app.processed_ops` returns the original result on replay.
4. **Collision-free offline numbering** via device prefixes from `register_device`.
5. **Conflict policy (FR-OF-03).** Stock transactions are append-only (no conflicts). Request edits are
   allowed only before approval and are versioned. Progress is append-only reports + verification.
   A server-side rule violation (e.g. stock already issued by another device) marks the outbox entry
   *failed* with the reason; the user retries or discards.

## SRS coverage (this build)

| Area | Requirements | Status |
|---|---|---|
| Access control | FR-ACC-01…05 | ✅ email/phone + password, biometric unlock (mobile), RLS per project, price roles, deactivate (ban) |
| Master data | FR-MD-01…08 | ✅ projects/blocks/levels/zones, elements, materials+grades, conversions, equivalents, suppliers, stores, Excel import, audit |
| Material request | FR-MR-01…06, 09 | ✅ multi-line, element split, stock/BoQ balance, over-BoQ reason, lead-time warning, drafts, clone, versions |
| | FR-MR-07 look-ahead | ✅ flag + required date; ⏳ schedule-driven suggestions (Phase 2) |
| | FR-MR-08 pour templates | ⏳ Phase 2 (take-offs already stored per element) |
| Workflow | FR-WF-02, 03, 05, 06 | ✅ |
| | FR-WF-01 configurable routing | ◐ review step on/off per project + value limits per role (BR-08) |
| | FR-WF-04 escalation | ✅ `escalate_pending_requests()` via pg_cron |
| Procurement | FR-PR-01…07 | ⏳ Phase 2 (statuses `sourced`/`ordered` reserved) |
| Receiving | FR-RC-01…05, 07, 08 | ✅ |
| | FR-RC-06 ready-mix batch tickets | ⏳ Phase 3 |
| Store | FR-ST-01…09, 12 | ✅ ledger, MIV + acknowledgement, over-issue/grade guards, partial issues, MRN, transfers, wastage approval, counts, low-stock |
| | FR-ST-10 batch tracking | ◐ batch no. recorded on GRN/MIV/ledger; batch-level balances Phase 3 |
| | FR-ST-11 QR scanning | ⏳ Phase 3 |
| Progress | FR-PG-01…07 | ✅ activity templates, report/verify, hold points, delays, weighted roll-up, planned vs issued |
| | FR-PG-08 site diary, FR-PG-10 snags | ⏳ Phase 3 |
| | FR-PG-09 schedule import / S-curve | ◐ planned dates via element import; simple S-curve on web |
| Consumption & cost | FR-CC-01, 03 | ✅ views `v_element_consumption`, `v_element_cost` |
| | FR-CC-02 variance alerts | ◐ highlighted on dashboard against project thresholds; push alert Phase 2 |
| | FR-CC-04 committed cost, FR-CC-05 rebar reconciliation | ⏳ need POs / BBS (Phase 2–3) |
| Dashboards | FR-DB-01…03 | ✅ per role, drill-down, last-sync + cached |
| Notifications | FR-NT-01 | ✅ in-app + push for request/approval/arrival/issue/adjustment/count/escalation |
| | FR-NT-02 preferences, FR-NT-03 SMS | ⏳ |
| Reports | FR-RP-01, 02, 04 | ✅ web (Excel + print/PDF); mobile PDF forms |
| | FR-RP-03 company-branded forms | ◐ generic layout; logo/templates when supplied (Open Question 10) |
| Offline | FR-OF-01…06 | ✅ |
| Audit | FR-AU-01…03 | ✅ triggers capture user + device; posted records immutable |

✅ done · ◐ partial · ⏳ later phase

## Roadmap

- **Phase 2:** RFQ / quotations / PO (PDF, share), supplier delivery tracking, committed cost, pour templates,
  look-ahead from schedule, variance push alerts, notification preferences.
- **Phase 3:** site diary, snag list, ready-mix batch tickets, rebar reconciliation vs BBS, batch balances,
  QR scanning, Amharic UI, Ethiopian calendar display.
- **Phase 4:** accounting/ERP and planning integrations, analytics, supplier portal.

## Open questions still affecting configuration

From SRS §11: approval value limits (→ `approval_limits`), whether site roles see prices (default: no),
review step required (default: yes), hosting region / data residency, and the company's form templates.
