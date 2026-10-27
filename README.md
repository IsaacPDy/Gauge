# CloudWatch — unified cloud usage & cost monitoring

CloudWatch connects to your cloud accounts with read-only access, discovers your projects, collects usage on a schedule, compares it against provider-reported or user-configured limits, forecasts the end of the billing cycle, and warns you (in-app and by email) before you hit a limit or an unexpected bill.

It implements checkpoints 1–6 of the PRD (`writing-block.md`): the full MVP definition of done, plus forecasting and cost estimates. Supabase is the first real integration. A clearly labelled **Demo provider** (development only) generates sample data so you can explore the whole product without credentials.

> CloudWatch monitors and forecasts. It never shuts down services, changes plans or caps spending, and every estimate is labelled as one.

## Quick start (local)

Prerequisites: Node 20.9+, Docker Desktop (running), and the Supabase CLI.

```bash
npm install
```

```bash
npm run db:start
```

```bash
npm run setup:env
```

```bash
npm run dev
```

Then open http://localhost:3100. The app uses port 3100 so it does not collide with other apps on 3000.

1. Create an account. A private workspace is created automatically.
2. **Providers → Add demo connection** (or **Connect Supabase** with a personal access token or OAuth).
3. Choose the resources to monitor. Usage history appears within seconds.
4. Explore **Home**, **Usage**, **Limits & quotas** and **Alerts**. Alert emails land in the local Mailpit inbox at http://127.0.0.1:54324.

`setup:env` writes `.env.local` from `supabase status` and generates the credential encryption key and cron secret. It keeps existing values, so it is safe to re-run. A local test account's credentials are stored in `.env.local` (`TEST_USER_*`).

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server on :3100. With `RUN_SCHEDULER_IN_PROCESS=true` it also runs collection and alert delivery every 60 s |
| `npm run worker` / `worker:once` | Standalone scheduler loop / single pass (for production-style setups) |
| `npm test` | Unit tests plus RLS isolation tests (the latter run when the local Supabase stack is up) |
| `npm run typecheck` | TypeScript check |
| `npm run db:reset` | Re-create the local database from `supabase/migrations` |
| `npm run db:types` | Regenerate `src/lib/supabase/database.types.ts` after schema changes |

## Architecture

```
Provider APIs ──▶ Adapters (src/lib/providers) ──▶ Sync job (jobs/sync.ts)
                                                     │  idempotent upserts
                                                     ▼
                                     PostgreSQL (Supabase, RLS per workspace)
                                                     │
                     Recalculation (jobs/recalc.ts): quota evaluations, forecasts,
                     cost estimates, alert evaluation, dedupe/escalation, delivery queue
                                                     │
                       ┌─────────────────────────────┴────────────────────────┐
                       ▼                                                      ▼
          Dashboard (Next.js server components,                  Email deliveries (jobs/notify.ts)
          reads stored snapshots only)                           with retries and backoff
```

| Area | Where | Notes |
|---|---|---|
| Schema, RLS, privileges | `supabase/migrations/` | Every workspace table is RLS-scoped. Users get only column-level grants they need. `provider_credentials` and `oauth_states` have no grants at all. |
| Provider adapters | `src/lib/providers/` | Common interface with a declared capability model. Unsupported data is reported as `unsupported`, never invented or shown as zero. |
| Pure engine | `src/lib/engine/` | Billing cycles, usage aggregation (gauge / cumulative / incremental), forecasting, cost estimates, alert evaluation and connection health. Deterministic and unit-tested. |
| Jobs | `src/lib/jobs/` | Sync (discover → collect → persist), recalculation, notifications, scheduler. Connections are claimed with `FOR UPDATE SKIP LOCKED`, so workers can run in parallel. |
| UI | `src/app/(app)/` | Home, Applications, Providers, Usage explorer, Limits & quotas, Alerts, Settings |

### Key behaviours (mapped to the PRD)

- **Idempotency.** Resources are keyed by provider ID, and samples by `(connection, metric, scope, bucket)`. Re-syncing overwrites instead of duplicating, and user choices (monitoring, application grouping, billing-cycle day) are never overwritten.
- **Quota sources.** *Provider-reported* limits come from APIs (for example, Supabase provisioned disk size and the Edge Function entitlement). *User-configured* limits always take precedence. Published plan allowances are only **suggested**: they cite their source, show the date they were verified, and apply only after you confirm them. Unknown limits stay unknown.
- **Billing scope.** Organization-wide quotas (MAU, storage) sum the monitored projects in the organization and flag partial coverage. They are never attributed to a single application.
- **Forecasting.** `projected = current + avg daily usage × remaining days`, using up to 7 valid daily observations. It needs at least 3; stale data produces no forecast. Cumulative counters are never differenced across a cycle reset. Gauges use linear growth.
- **Alerts.** Thresholds default to 50/75/90/100% and can be customized per workspace or per quota. Each threshold fires at most once per billing cycle, and a higher threshold escalates (supersedes) a lower one. Alerts can be acknowledged or muted (1 day, 7 days, or until the cycle resets). Alerts resolve automatically when the condition clears. Each alert's deliveries are unique per channel, so retries can't duplicate notifications.
- **Connection health.** Provider errors are normalized: auth failures pause collection until you reauthorize, missing permissions retry daily, and transient errors (429/5xx/network) back off exponentially. Data older than your freshness threshold raises a *stale* alert. Failures never erase data or read as zero usage.
- **Costs.** Provider-reported spend is kept separate from calculated estimates. Each estimate carries its pricing rule and version, and currencies are never mixed.

### Supabase integration

Verified on 2026-10-09 against the Management API OpenAPI spec and the "Manage your usage" docs.

| Metric | Source | Notes |
|---|---|---|
| Database size | `POST /v1/projects/{ref}/database/query/read-only` (`pg_database_size`) | Free plan limit (500 MB, read-only mode) is a plan suggestion |
| Disk usage | `GET /v1/projects/{ref}/config/disk/util` | Provisioned size becomes a provider-reported limit |
| Storage size | read-only SQL over `storage.objects` | Derived; Supabase bills the cycle average |
| Monthly active users | read-only SQL over `auth.users.last_sign_in_at` | **Estimate**; undercounts token refreshes |
| API requests | `GET …/analytics/endpoints/usage.api-counts` | Daily totals with REST/Auth/Storage/Realtime breakdown |
| Edge Functions deployed | `GET /v1/projects/{ref}/functions` + org entitlements | Entitlement is a provider-reported limit |
| Egress, function invocations | — | Shown as **unsupported** (not exposed reliably by the API) |

**OAuth (recommended).** Create an OAuth app in your Supabase organization with redirect URI `${APP_URL}/api/integrations/supabase/oauth/callback`, then set `SUPABASE_OAUTH_CLIENT_ID` and `SUPABASE_OAUTH_CLIENT_SECRET`. The flow uses PKCE and a one-time, expiring, encrypted state. It requests only read scopes: `organizations:read projects:read analytics:read database:read edge_functions:read`.

**Personal access tokens** work without an OAuth app. Supabase does not scope them, so the UI warns about this and recommends revoking the token in Supabase after disconnecting.

## Deploying

1. **Database.** Create a Supabase project, then run `supabase link` and `supabase db push`. In Auth settings, enable email confirmations, set the Site URL to your domain, and configure SMTP.
2. **App.** Deploy to Vercel or any Node host, with these env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`, the email settings (`EMAIL_TRANSPORT=resend` + `RESEND_API_KEY`, or SMTP), and optionally the Supabase OAuth credentials. Set `ENABLE_DEMO_PROVIDER=false` and `RUN_SCHEDULER_IN_PROCESS=false`.
3. **Scheduling.** `vercel.json` calls `/api/cron/tick` every 15 minutes, and Vercel sends `Authorization: Bearer $CRON_SECRET` automatically. Vercel's Hobby plan only allows daily crons. Elsewhere, run `npm run worker` as a separate process, or have any scheduler call the endpoint with the bearer token. Each connection's collection interval defaults to 6 hours.

## Tests

`npm test` runs 50 tests:

- **Engine**: cycles, aggregation, forecasting (including reset boundaries and reproducibility), costs, alert dedupe keys, health, units, and failure backoff.
- **Supabase adapter**: mocked API covering parsing, per-metric failures, auth aborts, paused projects, retries and rate limits.
- **RLS isolation**: two real users against the local database. They check cross-workspace reads and writes, that credentials can't be read, that provider quotas can't be written by users, column grants, and the worker RPCs.

## Not yet built (later checkpoints)

- Cloudflare, Firebase/GCP and AWS adapters (Checkpoint 7+). The catalog shows them as "coming soon", and the adapter interface is ready for them.
- Checkpoint 8 launch items: data-retention jobs, encryption-key rotation tooling, CSP headers, privacy policy and terms, production monitoring, and end-to-end browser tests.
- Team workspaces, Slack/Discord/webhook channels, anomaly detection and CSV export (Phase 2+).
