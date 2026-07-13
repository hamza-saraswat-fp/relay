# Relay

Customer-facing support ticket status pages for FieldPulse. One public, unguessable link per
Salesforce Account (`/t/{token}`), served from a Supabase read-store that syncs from Salesforce
every 6 hours — page loads never touch the Salesforce API.

**Architecture source of truth:** `../docs/relay-backend-architecture.md`
**Linear:** [Relay project](https://linear.app/fieldpulse/project/relay-e7e7451fa6f8) — this repo is IAI-235.

## Stack

Next.js (App Router) on Vercel · Supabase (Postgres, service-role only) · OpenRouter (Claude Sonnet 5
— update cleaning + safety pass) · Salesforce REST (bulk SOQL reads + one Account-field write per new account).

## Local setup

```bash
npm install
cp .env.example .env.local   # fill in values (see table in .env.example)
npm run dev
```

Without Supabase credentials the app still builds and runs; `/t/{token}` will 404 (fails closed)
and `/api/sync` returns 401/501.

## Database

Migrations live in `supabase/migrations/`. Apply with the Supabase CLI once the project exists:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

Schema: `accounts` (token = public slug) · `cases` (status_chip enum) · `case_updates`
(Claude-cleaned latest update + safety_flag) · `sync_runs` (observability). RLS is enabled with no
policies — only the service role can read/write; all rendering is server-side.

## Sync (`/api/sync`)

| Endpoint | Trigger | Method | Auth |
|---|---|---|---|
| `/api/sync` | Vercel Cron (every 6h, `vercel.json`) | GET | `Authorization: Bearer $CRON_SECRET` (Vercel adds this automatically when the `CRON_SECRET` env var is set) |
| `/api/sync` | Manual refresh (CS pre-share) | POST | `x-relay-sync-key: $RELAY_SYNC_KEY` |
| `/api/salesforce/case-created` | SF automation on case create (onboarding pattern) | POST | `Authorization: Bearer $SALESFORCE_INTEGRATION_KEY` |

**Reads use Salesforce Bulk API 2.0** (`lib/salesforce.ts`) — submit query job → poll → download CSV
— to stay off the org's REST quota. The sync (`lib/sync.ts`, IAI-212) maps status → chip, cleans the
latest outbound email into a customer update (IAI-214), and upserts into Supabase; it is read-only
against Salesforce. The case-create endpoint (IAI-237) mints a permanent token per account and returns
the tracker URL for the SF automation to write into `Relay_Tracker_Link__c` — **new cases only, no
backfill**. Live runs need the Supabase + Salesforce sandbox credentials.

## Deploy

1. Push this repo to GitHub, import into Vercel.
2. Set all env vars from `.env.example` in Vercel project settings (incl. `CRON_SECRET` so cron
   invocations are authenticated).
3. `vercel.json` registers the cron automatically on deploy.

## Salesforce dependencies (IAI-236, via Saffi)

Integration user / Connected App (read Case + EmailMessage, write one Account field) ·
`Relay_Tracker_Link__c` custom field on Account · API budget sign-off · sandbox for SOQL validation.
