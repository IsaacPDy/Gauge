# Move the database and auth from local Supabase to Neon

Date: 2026-10-28

## Goal

Stop running the Supabase stack in Docker (high RAM). Host the database on Neon, replace Supabase Auth with Neon Auth (managed Better Auth), and replace the supabase-js query layer with Drizzle. Start with an empty database; no data is migrated from the local stack.

## Decisions

| Question | Decision |
|---|---|
| Auth | Neon Auth (managed Better Auth, `@neondatabase/auth`) |
| Data layer | Drizzle over Neon's serverless driver, no RLS, workspace checks in app code |
| Existing data | Start fresh. Re-create the test user; the Demo provider regenerates its data |
| Environments | One Neon project. Branch `main` is prod and stays empty. Branch `dev` holds all dev data and its own Neon Auth instance. `.env.local` points only at `dev` |
| Local stack | Remove the cloudwatch Docker containers once the app works against Neon |

Out of scope: production deployment on Neon `main`, OAuth sign-in providers, email verification, and the Cloudflare adapter.

## Current state

- Supabase Auth: login, signup, forgot/reset password, change password and delete account in `src/app/(auth)/actions.ts` and `src/app/(app)/settings/actions.ts`. `src/proxy.ts` refreshes the session cookie and redirects signed-out users. `src/app/auth/callback` exchanges the email-confirmation code and `src/app/auth/signout` signs out.
- Data: 114 `.from("table")` calls in 25 files and 3 `.rpc()` calls, through `createUserClient()` (RLS applies) and `adminClient()` (service role). Both are used in 17 files.
- Schema: `supabase/migrations/20261009000000_init.sql`, 21 tables with RLS. Seven tables reference `auth.users`. A trigger `on_auth_user_created` runs `handle_new_user()`, which creates the profile, workspace, owner membership and four default alert rules.
- Worker SQL functions `claim_due_connections`, `claim_connection` and `claim_due_deliveries` are plain SQL and unchanged by this work.
- `src/app/api/integrations/supabase/*` is a monitored provider, not this app's own database. It stays.

## Design

### 1. Neon setup

- The user creates the Neon project and the `dev` branch in the Neon console, enables Auth on `dev`, and puts `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_AUTH_BASE_URL` and `NEON_AUTH_COOKIE_SECRET` directly into `.env.local`. Secrets are not pasted in chat.
- No Neon CLI or MCP tool is available in this environment, so project creation is a manual step.
- Before enabling Auth, check Neon Auth's plan and pricing limits.

### 2. Schema

- A Drizzle schema in `src/db/schema.ts` defines the same 21 tables. `drizzle-kit` generates SQL migrations in `drizzle/`. The Supabase migration is not ported line by line.
- Removed: all RLS policies and `enable row level security`, `is_workspace_member`, `auth.uid()`, grants to `authenticated` and `service_role`, and the `extensions` schema usage.
- Foreign keys to `auth.users` become references to `neon_auth.user`. The id type of that table (uuid or text) is checked first with `information_schema`, and the `user_id`-style columns are given the same type.
- The signup trigger is replaced by `ensureUserWorkspace(userId)`. It runs in one transaction with `ON CONFLICT DO NOTHING`, is idempotent, and is called from the session helper on the first authenticated request. It creates the profile, workspace, owner membership and the four default alert rules from `handle_new_user()`.
- The `claim_*` functions are kept as SQL in a custom migration.

### 3. Data layer

- `src/db/index.ts` exports one `db` built on `@neondatabase/serverless` with a Pool (WebSocket), because the HTTP driver cannot run interactive transactions. The worker script uses the same module.
- `createUserClient()` and `adminClient()` are removed. `src/lib/supabase/` is deleted, and `database.types.ts` is replaced by types inferred from the Drizzle schema.
- Workspace isolation is enforced by type. `requireWorkspace(userId, workspaceId)` checks membership and returns a `WorkspaceScope`. Repository functions under `src/db/repos/` take a `WorkspaceScope` and always filter by its workspace id. User-facing code has no other way to read or write workspace tables.
- The collector, alert engine and credential store already choose a workspace themselves. They construct a `WorkspaceScope` from the connection or rule they are processing.
- The 114 queries are rewritten into repositories one feature area at a time, with the app typechecking after each area.

### 4. Auth

- `src/lib/auth/server.ts` creates the `createNeonAuth({ baseUrl, cookies: { secret } })` instance. `src/lib/auth/client.ts` creates the client. A route at `src/app/api/auth/[...path]/route.ts` exports `auth.handler()`.
- `src/proxy.ts` keeps its public-path allowlist and reads the session with `auth.getSession()`. `/api/auth` is added to the public paths.
- `src/lib/session.ts` maps the Neon session to the `{ userId, email }` shape the rest of the app uses, and calls `ensureUserWorkspace`.

| Flow | Neon call |
|---|---|
| Sign up | `auth.signUp.email`, with `name` derived from the email local part |
| Sign in | `auth.signIn.email` |
| Sign out | `auth.signOut` |
| Change password | `auth.changePassword` |
| Delete account | Re-check the password with `signIn.email`, then `auth.deleteUser` and delete the user's workspace rows |
| Forgot and reset password | Better Auth reset methods. The exact method names are confirmed against the SDK at implementation time |

- `src/app/auth/callback` (the Supabase code exchange) is removed. Email verification stays off in dev.
- Neon's shared sender (`auth@mail.myneon.app`) sends auth emails in dev. Neon documents that password reset works with the shared sender.
- Neon's "Allow Localhost" setting stays on for the `dev` branch. The trusted domain and redirect settings for `http://localhost:3100` are set in the console.
- Safari needs HTTPS for the cookie in dev; `next dev --experimental-https` is documented in the README if needed.

### 5. App email

- Alert and notification email keeps nodemailer and Resend. Mailpit disappears with Supabase, so `.env.example` sets `EMAIL_TRANSPORT=console` for dev.

### 6. Env, scripts, dependencies

- `.env.example` and `.env.local`: remove `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`; add the four Neon variables. `SUPABASE_OAUTH_*` stays for the provider integration.
- `package.json` scripts: remove `db:start` and `db:types`. Add `db:generate` and `db:migrate` (drizzle-kit). `db:reset` drops and recreates the public schema and refuses to run unless `DATABASE_URL` points at the `dev` branch.
- `scripts/setup-env.mjs` is rewritten: no `supabase status`; it generates `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET` and `NEON_AUTH_COOKIE_SECRET` and preserves existing values.
- Remove the `supabase/` directory and the `@supabase/ssr` and `@supabase/supabase-js` packages. Add `drizzle-orm`, `drizzle-kit`, `@neondatabase/serverless`, `ws` and `@neondatabase/auth`.
- README and the local-setup memory note are updated.

### 7. Testing

- Existing unit tests (simulator, currency) are unchanged.
- New integration tests cover tenant isolation: for each repository, user A cannot read, update or delete user B's rows. They also cover `ensureUserWorkspace` being idempotent and the `claim_*` functions.
- Integration tests run against a throwaway Neon branch (`test`, created from `dev`) through `DATABASE_URL_TEST`, and are skipped when that variable is unset.
- Manual verification in the browser against `dev`: sign up, sign in, workspace created, Demo provider data renders, change password, forgot password, delete account, sign out.

### 8. Cutover and cleanup

Only after typecheck, tests and the manual browser check pass:

1. `supabase stop` for the cloudwatch project, which removes the `supabase_*_cloudwatch` containers. The `gg-reporting` containers and everything else in Docker are left alone.
2. The data volume is kept unless the user confirms it should be dropped (`--no-backup`).
3. Docker Desktop itself is not quit.

### 9. Branching

The migration is done in a separate git worktree on `feat/neon-migration`, so it does not mix with the uncommitted simulator and currency work on `feat/cost-simulator`. Both touch the `(app)` pages, so expect to resolve some conflicts when the two branches meet.

## Risks

- Dropping RLS makes a missing workspace filter a data leak. The `WorkspaceScope` type and the isolation tests are the mitigation.
- Neon Auth is a newer managed product. Switching to self-hosted Better Auth later is possible because users live in the project's own database, but is not planned here.
- Facts to confirm during implementation: the `neon_auth.user` id type, whether `neon_auth.user` can be a foreign key target with `on delete cascade`, and the reset-password method names.
