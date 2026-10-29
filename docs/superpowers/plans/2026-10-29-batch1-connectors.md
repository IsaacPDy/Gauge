# Batch 1 Connectors (Vercel, Cloudflare, Neon) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users connect Vercel, Cloudflare and Neon accounts with an API token, discover their projects and resources, and collect usage on the existing schedule.

**Architecture:** Each provider is a `ProviderAdapter` (`src/lib/providers/<id>/adapter.ts`) registered in `registry.ts`; the existing sync, recalc, alert and dashboard code is provider-agnostic and picks them up. A generic `/providers/connect/[provider]` page and `connectToken` server action replace per-provider connect code for token providers, driven by a new `tokenConnect` field on each adapter. Shared helpers in `src/lib/providers/collect.ts` keep the three adapters' outcome bookkeeping identical.

**Tech Stack:** Next.js 16 (App Router, server actions), TypeScript, Vitest, Drizzle on Neon Postgres, zod.

**Spec:** `docs/superpowers/specs/2026-10-29-batch1-connectors-design.md`

**Ground rules for the implementer**
- Read `AGENTS.md`: this Next.js version differs from older docs; check `node_modules/next/dist/docs/` before using an unfamiliar Next API.
- Another session may be editing this checkout. Commit only the files your task lists (`git commit -- <paths>`), never `git add -A`.
- Run tests with `npx vitest run <file>`; the full suite is `npm test`; types with `npm run typecheck`.
- One deviation from the spec, found while planning: `cost_records` hold one row per account per billing cycle (the demo adapter reports cycle totals), so Vercel reports a **cycle-to-date** cost per team, not one row per day.
- Cloudflare `validate` lists accounts instead of calling `/user/tokens/verify`, because account-owned tokens can't use the user endpoint; a token that sees no accounts is rejected with a message naming Account Settings: Read.
- The spec's `connectToken` action test is covered by `tokenProvider` unit tests (the guard the action relies on) plus the browser check in Task 9, because the action itself needs a live session and database.
- Vercel billing metrics are written only for days the billing API returned rows for. They are not zero-filled, so a wrong service-name mapping shows as missing data, never as a false zero.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/providers/http.ts` (modify) | Add `requestText`; `requestJson` builds on it |
| `src/lib/providers/collect.ts` (create) | Outcome and observation helpers shared by the new adapters |
| `src/lib/providers/types.ts` (modify) | `TokenConnectInfo`, optional `tokenConnect` on `ProviderAdapter` |
| `src/lib/types.ts` (modify) | `ProviderId` gains `vercel`, `neon` |
| `db/migrations/0002_batch1_providers.sql` (create) | Widen `provider_connections.provider` check |
| `src/lib/providers/registry.ts` (modify) | Register adapters, mark catalog entries available, `tokenProvider()` |
| `src/lib/providers/neon/adapter.ts` (create) | Neon adapter |
| `src/lib/providers/cloudflare/adapter.ts` (create) | Cloudflare adapter |
| `src/lib/providers/vercel/adapter.ts` (create) | Vercel adapter |
| `src/app/(app)/providers/token-form.tsx` (modify) | Provider-specific label, hint, placeholder |
| `src/app/(app)/providers/actions.ts` (modify) | `connectToken`, provider-aware disconnect note |
| `src/app/(app)/providers/connect/[provider]/page.tsx` (create) | Generic token connect page |
| `src/app/(app)/providers/[id]/page.tsx` (modify) | Replace-token form for every token provider |
| `tests/helpers/mock-fetch.ts` (create) | Route-based fake `fetch` that can return JSON or raw text |
| `tests/http.test.ts`, `tests/collect.test.ts`, `tests/registry.test.ts`, `tests/neon-adapter.test.ts`, `tests/cloudflare-adapter.test.ts`, `tests/vercel-adapter.test.ts` (create) | Unit tests |

---

### Task 1: `requestText` in the HTTP helper

**Files:**
- Modify: `src/lib/providers/http.ts:49-73`
- Test: `tests/http.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/http.test.ts
import { describe, expect, it } from "vitest";
import { requestJson, requestText } from "@/lib/providers/http";
import { ProviderError } from "@/lib/providers/types";

const respond = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("requestText", () => {
  it("returns the raw body", async () => {
    await expect(requestText("https://x.test/a", { fetch: respond(200, '{"a":1}\n{"a":2}\n') })).resolves.toBe('{"a":1}\n{"a":2}\n');
  });

  it("maps error statuses like requestJson", async () => {
    const err = await requestText("https://x.test/a", { fetch: respond(403, "nope"), retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("permission_denied");
  });
});

describe("requestJson", () => {
  it("still parses JSON and rejects invalid JSON", async () => {
    await expect(requestJson("https://x.test/a", { fetch: respond(200, '{"ok":true}') })).resolves.toEqual({ ok: true });
    const err = await requestJson("https://x.test/a", { fetch: respond(200, "{oops") }).catch((e) => e);
    expect(err.code).toBe("invalid_response");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/http.test.ts`
Expected: FAIL, `requestText` is not exported.

- [ ] **Step 3: Implement**

Replace the existing `requestJson` function (from `export async function requestJson` to the end of the file) with:

```ts
/** Fetches a URL with retries and normalized errors, returning the body as text. */
export async function requestText(url: string, opts: RequestOptions = {}): Promise<string> {
  const { fetch: fetchImpl = fetch, timeoutMs = 20_000, retries = 2, backoffMs = 500, ...init } = opts;
  let attempt = 0;
  for (;;) {
    let err: ProviderError;
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (res.ok) return text;
      err = errorForStatus(res, text);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const name = (e as Error)?.name;
      err = new ProviderError("network", name === "TimeoutError" ? "Request timed out" : "Network error contacting provider");
    }
    if (!err.retryable || attempt >= retries) throw err;
    const delay = Math.min(10_000, err.options.retryAfterMs ?? backoffMs * 2 ** attempt + Math.random() * backoffMs);
    attempt++;
    await sleep(delay);
  }
}

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const text = await requestText(url, opts);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError("invalid_response", "Provider returned invalid JSON");
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/http.test.ts tests/supabase-adapter.test.ts`
Expected: PASS (Supabase tests confirm `requestJson` behaves as before).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(providers): add requestText for non-JSON provider responses" -- src/lib/providers/http.ts tests/http.test.ts
```
(Stage the new test first: `git add tests/http.test.ts`.)

---

### Task 2: Shared collection helpers and the test fetch mock

**Files:**
- Create: `src/lib/providers/collect.ts`
- Create: `tests/helpers/mock-fetch.ts`
- Test: `tests/collect.test.ts`

- [ ] **Step 1: Write the test fetch mock** (used by every adapter test)

```ts
// tests/helpers/mock-fetch.ts
/** A route handler returns [status, body]; string bodies are sent as-is, anything else as JSON. */
export type Route = (url: URL, body?: unknown) => [number, unknown];

/** Fake fetch keyed by "METHOD /path" (query string ignored). Unmatched requests get a 404. */
export function mockFetch(routes: Record<string, Route>, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push(`${key}${url.search}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const route = routes[key];
    const [status, payload] = route ? route(url, body) : [404, { message: `not mocked: ${key}` }];
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
  }) as typeof fetch;
}
```

- [ ] **Step 2: Write the failing helper test**

```ts
// tests/collect.test.ts
import { describe, expect, it } from "vitest";
import { dayObservation, emptyResult, recordFailure, recordOk, recordUnsupported, utcDays } from "@/lib/providers/collect";
import { ProviderError } from "@/lib/providers/types";

const now = new Date("2026-10-09T12:00:00Z");
const scope = { resourceExternalId: "r1" };

describe("collect helpers", () => {
  it("lists UTC days inclusively", () => {
    expect(utcDays(new Date("2026-10-07T18:00:00Z"), now).map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
    ]);
  });

  it("marks today's daily bucket partial unless told otherwise", () => {
    expect(dayObservation("m", scope, new Date("2026-10-08T05:00:00Z"), 3, now).quality).toBe("ok");
    expect(dayObservation("m", scope, now, 3, now).quality).toBe("partial");
    expect(dayObservation("m", scope, now, 3, now, { quality: "ok", source: "derived" })).toMatchObject({
      quality: "ok",
      source: "derived",
      bucketStart: new Date("2026-10-09T00:00:00Z"),
      bucketEnd: new Date("2026-10-10T00:00:00Z"),
    });
  });

  it("records permission errors as unavailable and other errors as error", () => {
    const r = emptyResult();
    recordFailure(r, ["a", "b"], [scope], new ProviderError("permission_denied", "no"));
    recordFailure(r, ["c"], [scope], new ProviderError("invalid_response", "bad"));
    expect(r.outcomes.map((o) => [o.metricKey, o.status, o.errorCode])).toEqual([
      ["a", "unavailable", "permission_denied"],
      ["b", "unavailable", "permission_denied"],
      ["c", "error", "invalid_response"],
    ]);
  });

  it("rethrows authentication failures", () => {
    expect(() => recordFailure(emptyResult(), ["a"], [scope], new ProviderError("auth_invalid", "revoked"))).toThrow("revoked");
  });

  it("records ok and unsupported outcomes", () => {
    const r = emptyResult();
    recordOk(r, ["a"], [scope]);
    recordUnsupported(r, [{ key: "u", supported: false, unsupportedReason: "why" } as never], scope);
    expect(r.outcomes).toEqual([
      { metricKey: "a", scope, status: "ok" },
      { metricKey: "u", scope, status: "unsupported", detail: "why" },
    ]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/collect.test.ts`
Expected: FAIL, cannot resolve `@/lib/providers/collect`.

- [ ] **Step 4: Implement `src/lib/providers/collect.ts`**

```ts
import { DAY_MS, startOfUtcDay } from "../engine/time";
import type { MetricDefinition } from "../types";
import { type CollectResult, type MetricOutcome, type Observation, ProviderError, type ScopeRef } from "./types";

export function emptyResult(): CollectResult {
  return { observations: [], outcomes: [], quotas: [], costs: [] };
}

/** Revoked or expired credentials make the whole connection unusable, so they abort a run. */
export function isAuthFailure(e: unknown): boolean {
  return e instanceof ProviderError && (e.code === "auth_invalid" || e.code === "auth_expired");
}

/**
 * Records a failed read for every metric and scope. Missing permission reads as
 * "unavailable", anything else as "error". Authentication failures are rethrown.
 */
export function recordFailure(result: CollectResult, metricKeys: string[], scopes: ScopeRef[], e: unknown): void {
  if (isAuthFailure(e)) throw e;
  const err = e instanceof ProviderError ? e : new ProviderError("unknown", (e as Error)?.message ?? "Unknown error");
  const status: MetricOutcome["status"] = err.code === "permission_denied" ? "unavailable" : "error";
  for (const scope of scopes) {
    for (const metricKey of metricKeys) result.outcomes.push({ metricKey, scope, status, errorCode: err.code, detail: err.message });
  }
}

export function recordOk(result: CollectResult, metricKeys: string[], scopes: ScopeRef[]): void {
  for (const scope of scopes) for (const metricKey of metricKeys) result.outcomes.push({ metricKey, scope, status: "ok" });
}

export function recordUnsupported(result: CollectResult, metrics: MetricDefinition[], scope: ScopeRef): void {
  for (const m of metrics.filter((x) => !x.supported)) {
    result.outcomes.push({ metricKey: m.key, scope, status: "unsupported", detail: m.unsupportedReason });
  }
}

/** A one-day bucket. Today's bucket is still filling, so it defaults to "partial". */
export function dayObservation(
  metricKey: string,
  scope: ScopeRef,
  day: Date,
  value: number,
  now: Date,
  opts: { source?: Observation["source"]; quality?: Observation["quality"]; dimensions?: Record<string, number> } = {},
): Observation {
  const start = startOfUtcDay(day);
  const isToday = start.getTime() === startOfUtcDay(now).getTime();
  return {
    metricKey,
    scope,
    bucketStart: start,
    bucketEnd: new Date(start.getTime() + DAY_MS),
    value,
    observedAt: now,
    quality: opts.quality ?? (isToday ? "partial" : "ok"),
    source: opts.source ?? "provider",
    ...(opts.dimensions ? { dimensions: opts.dimensions } : {}),
  };
}

/** UTC day starts from `from` through `to`, inclusive. */
export function utcDays(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  for (let t = startOfUtcDay(from).getTime(); t <= startOfUtcDay(to).getTime(); t += DAY_MS) days.push(new Date(t));
  return days;
}

/** Numbers sometimes arrive as strings; anything unparseable reads as null. */
export function toNumber(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/collect.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/providers/collect.ts tests/collect.test.ts tests/helpers/mock-fetch.ts
git commit -m "feat(providers): shared collection helpers for new adapters" -- src/lib/providers/collect.ts tests/collect.test.ts tests/helpers/mock-fetch.ts
```

---

### Task 3: Provider ids, migration, connect-info type and `tokenProvider`

**Files:**
- Modify: `src/lib/types.ts:4`
- Modify: `src/lib/providers/types.ts` (append to `ProviderAdapter`)
- Create: `db/migrations/0002_batch1_providers.sql`
- Modify: `src/lib/providers/registry.ts`
- Test: `tests/registry.test.ts`

- [ ] **Step 1: Write the failing registry test**

```ts
// tests/registry.test.ts
import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG, getAdapter, tokenProvider } from "@/lib/providers/registry";

describe("tokenProvider", () => {
  it("returns available adapters that accept tokens", () => {
    expect(tokenProvider("supabase")?.id).toBe("supabase");
  });

  it("rejects the demo provider, planned providers and unknown ids", () => {
    expect(tokenProvider("demo")).toBeNull();
    expect(tokenProvider("aws")).toBeNull();
    expect(tokenProvider("nope")).toBeNull();
  });

  it("every available catalog entry has an adapter", () => {
    for (const p of PROVIDER_CATALOG.filter((x) => x.available)) expect(getAdapter(p.id), p.id).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL, `tokenProvider` is not exported.

- [ ] **Step 3: Widen `ProviderId`** in `src/lib/types.ts` line 4:

```ts
export type ProviderId = "supabase" | "cloudflare" | "firebase" | "aws" | "vercel" | "neon" | "demo";
```

- [ ] **Step 4: Add the connect-info type** to `src/lib/providers/types.ts`. Insert above `export interface ProviderAdapter`:

```ts
/** What the generic connect page shows for a provider that takes a pasted token. */
export interface TokenConnectInfo {
  /** "Access token", "API token", "API key". */
  tokenLabel: string;
  /** Shown next to the label, e.g. "(starts with sbp_)". */
  tokenHint?: string;
  placeholder?: string;
  /** Where the user creates the token. */
  createUrl: string;
  steps: string[];
  /** Exact permission names to grant, shown as chips. */
  permissions?: string[];
  /** Shown when the provider's tokens can do more than read. */
  warning?: string;
}
```

and add this field to `ProviderAdapter`, after `recommendations`:

```ts
  /** Present when users can connect by pasting a token on the generic connect page. */
  tokenConnect?: TokenConnectInfo;
```

- [ ] **Step 5: Write the migration** `db/migrations/0002_batch1_providers.sql`:

```sql
-- Batch 1 connectors: Vercel and Neon join the providers a connection may use.
alter table public.provider_connections drop constraint provider_connections_provider_check;
alter table public.provider_connections add constraint provider_connections_provider_check
  check (provider in ('supabase', 'cloudflare', 'firebase', 'aws', 'vercel', 'neon', 'demo'));
```

- [ ] **Step 6: Add `tokenProvider`** to `src/lib/providers/registry.ts`, after `getAdapter`. It needs `PROVIDER_CATALOG`, which is declared later in the file, so place the function **after** the `PROVIDER_NAMES` declaration:

```ts
/**
 * The adapter for a provider the user may connect with a pasted token: it must be
 * available in the catalog and accept token auth. Null otherwise (including demo).
 */
export function tokenProvider(id: string): ProviderAdapter | null {
  const adapter = getAdapter(id);
  const listed = PROVIDER_CATALOG.find((p) => p.id === id);
  if (!adapter || !listed?.available || !adapter.authMethods.includes("token")) return null;
  return adapter;
}
```

- [ ] **Step 7: Run tests and types**

Run: `npx vitest run tests/registry.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Apply the migration to the dev database**

Run: `npm run db:migrate`
Expected: output lists `0002_batch1_providers.sql` as applied. If it reports that `provider_connections_provider_check` does not exist, run `psql "$DATABASE_URL" -c "\d public.provider_connections"` (URL from `.env.local`), use the constraint name shown there in the migration, and rerun.

- [ ] **Step 9: Commit**

```bash
git add db/migrations/0002_batch1_providers.sql tests/registry.test.ts
git commit -m "feat(providers): provider ids, migration and tokenProvider for batch 1" -- src/lib/types.ts src/lib/providers/types.ts src/lib/providers/registry.ts db/migrations/0002_batch1_providers.sql tests/registry.test.ts
```

---

### Task 4: Neon adapter

**Files:**
- Create: `src/lib/providers/neon/adapter.ts`
- Modify: `src/lib/providers/registry.ts` (register, mark available)
- Test: `tests/neon-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/neon-adapter.test.ts
import { describe, expect, it } from "vitest";
import { billingCycle } from "@/lib/engine/time";
import { N, neonAdapter, normalizeNeonPlan } from "@/lib/providers/neon/adapter";
import { tokenProvider } from "@/lib/providers/registry";
import { mockFetch } from "./helpers/mock-fetch";

const now = new Date("2026-10-09T12:00:00Z");
const cycle = billingCycle(now, 1);
const ctx = (f: typeof fetch) => ({ credentials: { kind: "token" as const, token: "napi_test" }, now, fetch: f });

describe("neon adapter", () => {
  it("normalizes subscription types", () => {
    expect(normalizeNeonPlan("free_v3")).toBe("free");
    expect(normalizeNeonPlan("launch")).toBe("launch");
    expect(normalizeNeonPlan("Scale")).toBe("scale");
    expect(normalizeNeonPlan(undefined)).toBeNull();
  });

  it("validates with the user's email", async () => {
    const f = mockFetch({ "GET /api/v2/users/me": () => [200, { id: "u1", email: "dev@example.com" }] });
    await expect(neonAdapter.validate(ctx(f))).resolves.toMatchObject({ identity: "dev@example.com" });
  });

  it("discovers organizations and pages through projects", async () => {
    const f = mockFetch({
      "GET /api/v2/users/me/organizations": () => [200, { organizations: [{ id: "org-a", name: "Acme", plan: "free_v3" }] }],
      "GET /api/v2/projects": (url) =>
        url.searchParams.get("cursor")
          ? [200, { projects: [{ id: "p3", name: "three", region_id: "aws-us-east-2" }], pagination: { cursor: "p3" } }]
          : [200, { projects: Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: `n${i}`, region_id: "aws-eu-central-1" })), pagination: { cursor: "p99" } }],
    });
    const d = await neonAdapter.discover(ctx(f));
    expect(d.accounts).toEqual([
      expect.objectContaining({ externalId: "org-a", name: "Acme", plan: "free", accountType: "organization" }),
    ]);
    expect(d.resources).toHaveLength(101);
    expect(d.resources[0]).toMatchObject({ externalId: "p0", accountExternalId: "org-a", resourceType: "project", region: "aws-eu-central-1", status: "active" });
  });

  it("collects current-period counters and isolates a missing field", async () => {
    const f = mockFetch({
      "GET /api/v2/projects/p1": () => [
        200,
        {
          project: {
            id: "p1",
            compute_time_seconds: 7200,
            synthetic_storage_size: 1_000_000,
            written_data_bytes: 5_000,
            consumption_period_start: "2026-10-01T00:00:00Z",
          },
        },
      ],
    });
    const r = await neonAdapter.collect(ctx(f), {
      since: new Date("2026-10-01T00:00:00Z"),
      accounts: [{ externalId: "org-a", plan: "free", cycle }],
      resources: [{ externalId: "p1", accountExternalId: "org-a", providerStatus: null, cycle }],
    });
    const value = (k: string) => r.observations.find((o) => o.metricKey === k);
    expect(value(N.computeHours)).toMatchObject({ value: 2, source: "derived", quality: "ok" });
    expect(value(N.computeHours)?.dimensions).toEqual({ consumption_period_start: Date.parse("2026-10-01T00:00:00Z") });
    expect(value(N.storage)?.value).toBe(1_000_000);
    expect(value(N.dataWritten)?.value).toBe(5_000);
    expect(value(N.dataTransfer)).toBeUndefined();
    expect(r.outcomes.find((o) => o.metricKey === N.dataTransfer)).toMatchObject({ status: "error", errorCode: "invalid_response" });
    expect(r.outcomes.filter((o) => o.status === "ok")).toHaveLength(3);
  });

  it("aborts the run when the key is revoked", async () => {
    const f = mockFetch({ "GET /api/v2/projects/p1": () => [401, { message: "unauthorized" }] });
    const run = neonAdapter.collect(ctx(f), {
      since: now,
      accounts: [],
      resources: [{ externalId: "p1", accountExternalId: "org-a", providerStatus: null, cycle }],
    });
    await expect(run).rejects.toMatchObject({ code: "auth_invalid" });
  });

  it("is connectable with a token", () => {
    expect(tokenProvider("neon")?.tokenConnect?.tokenLabel).toBe("API key");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/neon-adapter.test.ts`
Expected: FAIL, cannot resolve `@/lib/providers/neon/adapter`.

- [ ] **Step 3: Implement `src/lib/providers/neon/adapter.ts`**

```ts
import { GB } from "../../units";
import type { MetricDefinition } from "../../types";
import { dayObservation, emptyResult, recordFailure, recordOk, toNumber } from "../collect";
import { requestJson } from "../http";
import {
  type AdapterContext,
  type CollectResult,
  type CollectTarget,
  type DiscoveredAccount,
  type DiscoveredResource,
  type Discovery,
  type PlanAllowance,
  ProviderError,
  type ProviderAdapter,
} from "../types";

// Verified against the Neon API reference (neon.com/docs/reference/api) and
// neon.com/pricing on 2026-10-29. Re-verify before changing.

export const NEON_API_URL = process.env.NEON_API_URL ?? "https://console.neon.tech/api/v2";

const VERIFIED = "2026-10-29";
const PRICING = "https://neon.com/pricing";
const PAGE = 100;

export const N = {
  computeHours: "neon.compute_hours",
  storage: "neon.storage",
  dataWritten: "neon.data_written",
  dataTransfer: "neon.data_transfer",
} as const;

const metrics: MetricDefinition[] = [
  {
    key: N.computeHours,
    provider: "neon",
    name: "Compute hours",
    description: "CU-hours used by the project's computes in the current consumption period (compute_time_seconds ÷ 3600).",
    unit: "count",
    aggregation: "cumulative",
    scopeLevel: "resource",
    derivation: "derived",
    supported: true,
  },
  {
    key: N.storage,
    provider: "neon",
    name: "Storage",
    description:
      "Project storage including history (synthetic_storage_size). Neon bills the hourly average (GB-months), so the current size approximates billed storage.",
    unit: "bytes",
    aggregation: "gauge",
    scopeLevel: "resource",
    derivation: "reported",
    supported: true,
  },
  {
    key: N.dataWritten,
    provider: "neon",
    name: "Data written",
    description: "Data written to the project's storage in the current consumption period.",
    unit: "bytes",
    aggregation: "cumulative",
    scopeLevel: "resource",
    derivation: "reported",
    supported: true,
  },
  {
    key: N.dataTransfer,
    provider: "neon",
    name: "Data transfer",
    description: "Public network transfer (egress) in the current consumption period.",
    unit: "bytes",
    aggregation: "cumulative",
    scopeLevel: "resource",
    derivation: "reported",
    supported: true,
  },
];

const planAllowances: PlanAllowance[] = [
  {
    plan: "free",
    metricKey: N.computeHours,
    scope: "resource",
    limit: 100,
    overageEffect: "restriction",
    note: "Free plan includes 100 CU-hours per project each month; computes are suspended beyond that.",
    sourceUrl: PRICING,
    verifiedAt: VERIFIED,
  },
  {
    plan: "free",
    metricKey: N.storage,
    scope: "resource",
    limit: 1 * GB,
    overageEffect: "restriction",
    note: "Free plan includes 1 GB of storage per project (20 GB across the account).",
    sourceUrl: PRICING,
    verifiedAt: VERIFIED,
  },
  {
    plan: "free",
    metricKey: N.dataTransfer,
    scope: "resource",
    limit: 5 * GB,
    overageEffect: "restriction",
    note: "Free plan includes 5 GB of public network transfer per project.",
    sourceUrl: PRICING,
    verifiedAt: VERIFIED,
  },
  ...["launch", "scale"].map(
    (plan): PlanAllowance => ({
      plan,
      metricKey: N.dataTransfer,
      scope: "resource",
      limit: 500 * GB,
      overageEffect: "charges",
      note: "500 GB of public network transfer included per project, then $0.10 per GB.",
      sourceUrl: PRICING,
      verifiedAt: VERIFIED,
    }),
  ),
];

const recommendations: Record<string, string> = {
  [N.computeHours]:
    "Check which branches keep computes awake (open connections, cron jobs, polling). Lower the autoscaling maximum or let computes scale to zero sooner.",
  [N.storage]: "Delete unused branches and data, and shorten the history (restore) window if you don't need it.",
  [N.dataWritten]: "Look for write-heavy jobs such as bulk imports, frequent upserts or logging tables.",
  [N.dataTransfer]: "Cache query results closer to users and avoid fetching large result sets you don't use.",
};

interface Org {
  id: string;
  name: string;
  plan?: string;
}
interface ProjectSummary {
  id: string;
  name: string;
  region_id?: string;
}
type ProjectDetail = Record<string, unknown> & { id: string; consumption_period_start?: string };

/** Neon subscription types carry version suffixes ("free_v3"); keep only the plan family. */
export function normalizeNeonPlan(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const p = plan.toLowerCase();
  for (const family of ["free", "launch", "scale", "business", "enterprise"]) if (p.startsWith(family)) return family;
  return p;
}

function client(ctx: AdapterContext) {
  if (ctx.credentials.kind !== "token") throw new ProviderError("auth_invalid", "Neon connections use an API key");
  const headers = { Authorization: `Bearer ${ctx.credentials.token}`, Accept: "application/json" };
  return { get: <T>(path: string) => requestJson<T>(`${NEON_API_URL}${path}`, { headers, fetch: ctx.fetch }) };
}

export const neonAdapter: ProviderAdapter = {
  id: "neon",
  name: "Neon",
  authMethods: ["token"],
  capabilities: {
    accountDiscovery: { level: "supported", note: "Organizations and their plans" },
    resourceDiscovery: { level: "supported", note: "Projects and regions" },
    usageMetrics: { level: "supported", note: "Compute hours, storage, data written and data transfer per project." },
    quotaRetrieval: { level: "unsupported", note: "Plan allowances are suggested from Neon's pricing page and need your confirmation." },
    actualCost: { level: "unsupported", note: "The Neon API has no billing endpoint." },
    forecastingInputs: { level: "supported", note: "A snapshot is stored on every sync." },
    billingCycleMetadata: { level: "partial", note: "Each project reports its consumption period; set the organization's cycle day to match." },
    accountControls: { level: "unsupported", note: "Limit Gauge never changes plans or computes." },
  },
  metrics,
  pricingRules: [],
  planAllowances,
  recommendations,
  tokenConnect: {
    tokenLabel: "API key",
    placeholder: "napi_…",
    createUrl: "https://console.neon.tech/app/settings/api-keys",
    steps: [
      "Open Account settings → API keys in the Neon Console (or ask a teammate with the Viewer role to do it).",
      "Create a personal API key and copy it.",
      "Paste it below. Limit Gauge discovers every organization and project the key can see.",
    ],
    warning:
      "Neon API keys are not read-only. A personal key from a member with the Viewer role can only read. Limit Gauge only sends read requests and encrypts the key at rest.",
  },

  async validate(ctx) {
    const me = await client(ctx).get<{ email?: string; name?: string }>("/users/me");
    if (!me) throw new ProviderError("invalid_response", "Unexpected user response");
    return { identity: me.email ?? me.name ?? "Neon account", grantedScopes: ["API key (Neon keys are not read-only)"] };
  },

  async discover(ctx): Promise<Discovery> {
    const api = client(ctx);
    const res = await api.get<{ organizations?: Org[] }>("/users/me/organizations");
    const orgs = res?.organizations;
    if (!Array.isArray(orgs)) throw new ProviderError("invalid_response", "Unexpected organizations response");

    const accounts: DiscoveredAccount[] = [];
    const resources: DiscoveredResource[] = [];
    for (const org of orgs) {
      accounts.push({
        externalId: org.id,
        name: org.name,
        accountType: "organization",
        plan: normalizeNeonPlan(org.plan),
        billingCurrency: "USD",
        dashboardUrl: `https://console.neon.tech/app/${org.id}/projects`,
      });
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const qs = new URLSearchParams({ org_id: org.id, limit: String(PAGE) });
        if (cursor) qs.set("cursor", cursor);
        const r = await api.get<{ projects?: ProjectSummary[]; pagination?: { cursor?: string } }>(`/projects?${qs}`);
        const projects = r?.projects;
        if (!Array.isArray(projects)) throw new ProviderError("invalid_response", "Unexpected projects response");
        for (const p of projects) {
          resources.push({
            externalId: p.id,
            accountExternalId: org.id,
            name: p.name,
            resourceType: "project",
            region: p.region_id ?? null,
            plan: null,
            providerStatus: null,
            status: "active",
            dashboardUrl: `https://console.neon.tech/app/projects/${p.id}`,
          });
        }
        const next = r?.pagination?.cursor;
        if (projects.length < PAGE || !next || next === cursor) break;
        cursor = next;
      }
    }
    return { accounts, resources };
  },

  async collect(ctx, target: CollectTarget): Promise<CollectResult> {
    const api = client(ctx);
    const now = ctx.now;
    const result = emptyResult();

    for (const r of target.resources) {
      const scope = { resourceExternalId: r.externalId };
      try {
        const res = await api.get<{ project?: ProjectDetail }>(`/projects/${encodeURIComponent(r.externalId)}`);
        const p = res?.project;
        if (!p) throw new ProviderError("invalid_response", "Unexpected project response");
        const periodStart = p.consumption_period_start ? Date.parse(p.consumption_period_start) : NaN;
        const dimensions = Number.isFinite(periodStart) ? { consumption_period_start: periodStart } : undefined;

        const read = (field: string, metricKey: string, toValue: (v: number) => number, source: "provider" | "derived" = "provider") => {
          const v = toNumber(p[field]);
          if (v === null || v < 0) {
            recordFailure(result, [metricKey], [scope], new ProviderError("invalid_response", `Project response is missing ${field}`));
            return;
          }
          result.observations.push(dayObservation(metricKey, scope, now, toValue(v), now, { quality: "ok", source, dimensions }));
          recordOk(result, [metricKey], [scope]);
        };
        read("compute_time_seconds", N.computeHours, (v) => Math.round((v / 3600) * 100) / 100, "derived");
        read("synthetic_storage_size", N.storage, (v) => v);
        read("written_data_bytes", N.dataWritten, (v) => v);
        read("data_transfer_bytes", N.dataTransfer, (v) => v);
      } catch (e) {
        recordFailure(result, metrics.map((m) => m.key), [scope], e);
      }
    }
    return result;
  },
};
```

- [ ] **Step 4: Register the adapter** in `src/lib/providers/registry.ts`:

Add the import next to the others:

```ts
import { neonAdapter } from "./neon/adapter";
```

Add to `ADAPTERS`:

```ts
const ADAPTERS: Partial<Record<ProviderId, ProviderAdapter>> = {
  supabase: supabaseAdapter,
  neon: neonAdapter,
  demo: demoAdapter,
};
```

In `PROVIDER_CATALOG`, change the Neon entry's `available: false` to `available: true`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/neon-adapter.test.ts tests/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/providers/neon/adapter.ts tests/neon-adapter.test.ts
git commit -m "feat(providers): Neon adapter" -- src/lib/providers/neon/adapter.ts src/lib/providers/registry.ts tests/neon-adapter.test.ts
```

---

### Task 5: Cloudflare adapter

**Files:**
- Create: `src/lib/providers/cloudflare/adapter.ts`
- Modify: `src/lib/providers/registry.ts` (register, mark available)
- Test: `tests/cloudflare-adapter.test.ts`

Resource external ids are `<accountId>:<kind>:<name>` with kind `worker`, `r2` or `d1` (D1 uses the database UUID as name), because two accounts in one connection can hold Workers or buckets with the same name.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cloudflare-adapter.test.ts
import { describe, expect, it } from "vitest";
import { billingCycle } from "@/lib/engine/time";
import { C, cloudflareAdapter } from "@/lib/providers/cloudflare/adapter";
import { tokenProvider } from "@/lib/providers/registry";
import { mockFetch } from "./helpers/mock-fetch";

const now = new Date("2026-10-09T12:00:00Z");
const cycle = billingCycle(now, 1);
const ctx = (f: typeof fetch) => ({ credentials: { kind: "token" as const, token: "cf_test" }, now, fetch: f });
const ok = (result: unknown, info?: object) => [200, { success: true, errors: [], result, result_info: info }] as [number, unknown];
const gql = (rows: unknown[]) => [200, { data: { viewer: { accounts: [{ rows }] } }, errors: null }] as [number, unknown];

const target = {
  since: new Date("2026-10-07T00:00:00Z"),
  accounts: [{ externalId: "acc1", plan: null, cycle }],
  resources: [
    { externalId: "acc1:worker:api", accountExternalId: "acc1", providerStatus: null, cycle },
    { externalId: "acc1:r2:media", accountExternalId: "acc1", providerStatus: null, cycle },
    { externalId: "acc1:d1:db-uuid", accountExternalId: "acc1", providerStatus: null, cycle },
  ],
};

describe("cloudflare adapter", () => {
  it("validate needs at least one visible account", async () => {
    const none = mockFetch({ "GET /client/v4/accounts": () => ok([], { page: 1, total_pages: 1 }) });
    await expect(cloudflareAdapter.validate(ctx(none))).rejects.toMatchObject({ code: "permission_denied" });
    const one = mockFetch({ "GET /client/v4/accounts": () => ok([{ id: "acc1", name: "Acme" }], { page: 1, total_pages: 1 }) });
    await expect(cloudflareAdapter.validate(ctx(one))).resolves.toMatchObject({ identity: "1 account" });
  });

  it("discovers Workers, R2 buckets and D1 databases, skipping types it cannot read", async () => {
    const f = mockFetch({
      "GET /client/v4/accounts": () => ok([{ id: "acc1", name: "Acme" }], { page: 1, total_pages: 1 }),
      "GET /client/v4/accounts/acc1/workers/scripts": () => ok([{ id: "api" }]),
      "GET /client/v4/accounts/acc1/r2/buckets": () => [403, { success: false, errors: [{ message: "forbidden" }] }],
      "GET /client/v4/accounts/acc1/d1/database": () => ok([{ uuid: "db-uuid", name: "main" }], { page: 1, total_pages: 1 }),
    });
    const d = await cloudflareAdapter.discover(ctx(f));
    expect(d.accounts[0]).toMatchObject({ externalId: "acc1", name: "Acme", accountType: "account", plan: null });
    expect(d.accounts[0].metadata).toEqual({ skipped: [expect.stringContaining("R2")] });
    expect(d.resources.map((r) => [r.externalId, r.resourceType, r.name])).toEqual([
      ["acc1:worker:api", "worker", "api"],
      ["acc1:d1:db-uuid", "d1_database", "main"],
    ]);
  });

  it("collects daily usage from GraphQL with zero-filled request days", async () => {
    const f = mockFetch({
      "POST /client/v4/graphql": (_url, body) => {
        const q = (body as { query: string }).query;
        if (q.includes("workersInvocationsAdaptive"))
          return gql([
            { dimensions: { date: "2026-10-07", scriptName: "api" }, sum: { requests: 100, cpuTimeUs: 2_500_000 } },
            { dimensions: { date: "2026-10-09", scriptName: "api" }, sum: { requests: 5, cpuTimeUs: 1000 } },
            { dimensions: { date: "2026-10-09", scriptName: "unmonitored" }, sum: { requests: 9, cpuTimeUs: 1 } },
          ]);
        if (q.includes("r2OperationsAdaptiveGroups"))
          return gql([
            { dimensions: { date: "2026-10-08", bucketName: "media", actionType: "PutObject" }, sum: { requests: 7 } },
            { dimensions: { date: "2026-10-08", bucketName: "media", actionType: "GetObject" }, sum: { requests: 40 } },
            { dimensions: { date: "2026-10-08", bucketName: "media", actionType: "DeleteObject" }, sum: { requests: 3 } },
          ]);
        if (q.includes("r2StorageAdaptiveGroups"))
          return gql([{ dimensions: { date: "2026-10-08", bucketName: "media" }, max: { payloadSize: 900, metadataSize: 100 } }]);
        if (q.includes("d1AnalyticsAdaptiveGroups")) return [200, { data: null, errors: [{ message: "not authorized for that account" }] }];
        if (q.includes("d1StorageAdaptiveGroups")) return gql([{ dimensions: { date: "2026-10-09", databaseId: "db-uuid" }, max: { databaseSizeBytes: 4096 } }]);
        return [400, { errors: [{ message: "unexpected query" }] }];
      },
    });
    const r = await cloudflareAdapter.collect(ctx(f), target);
    const series = (k: string) => r.observations.filter((o) => o.metricKey === k).map((o) => [o.bucketStart.toISOString().slice(0, 10), o.value]);

    expect(series(C.workersRequests)).toEqual([
      ["2026-10-07", 100],
      ["2026-10-08", 0],
      ["2026-10-09", 5],
    ]);
    expect(series(C.workersCpuTime)).toEqual([
      ["2026-10-07", 2500],
      ["2026-10-08", 0],
      ["2026-10-09", 1],
    ]);
    expect(series(C.r2ClassA)).toContainEqual(["2026-10-08", 7]);
    expect(series(C.r2ClassB)).toContainEqual(["2026-10-08", 40]);
    expect(series(C.r2Storage)).toEqual([["2026-10-08", 1000]]);
    expect(series(C.d1Storage)).toEqual([["2026-10-09", 4096]]);
    expect(series(C.d1RowsRead)).toEqual([]);
    expect(r.outcomes.find((o) => o.metricKey === C.d1RowsRead)).toMatchObject({ status: "unavailable", errorCode: "permission_denied" });
    expect(r.outcomes.find((o) => o.metricKey === C.workersRequests)).toMatchObject({ status: "ok" });
  });

  it("is connectable with a read-only token", () => {
    const info = tokenProvider("cloudflare")?.tokenConnect;
    expect(info?.permissions).toContain("Account Analytics: Read");
    expect(info?.warning).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/cloudflare-adapter.test.ts`
Expected: FAIL, cannot resolve `@/lib/providers/cloudflare/adapter`.

- [ ] **Step 3: Implement `src/lib/providers/cloudflare/adapter.ts`**

```ts
import { DAY_MS, dayKey, startOfUtcDay } from "../../engine/time";
import type { MetricDefinition } from "../../types";
import { dayObservation, emptyResult, isAuthFailure, recordFailure, recordOk, toNumber, utcDays } from "../collect";
import { requestJson } from "../http";
import {
  type AdapterContext,
  type CollectResult,
  type CollectTarget,
  type DiscoveredAccount,
  type DiscoveredResource,
  type Discovery,
  ProviderError,
  type ProviderAdapter,
} from "../types";

// Verified against developers.cloudflare.com (GraphQL Analytics API, Workers, R2 and D1
// metrics docs, R2 pricing) on 2026-10-29. Dataset field names are confirmed against a
// live account in the batch 1 live check. Re-verify before changing.

export const CLOUDFLARE_API_URL = process.env.CLOUDFLARE_API_URL ?? "https://api.cloudflare.com/client/v4";

/** Adaptive datasets answer at most 30 days per query on every plan. */
const MAX_DAYS = 30;

export const C = {
  workersRequests: "cloudflare.workers_requests",
  workersCpuTime: "cloudflare.workers_cpu_time",
  r2ClassA: "cloudflare.r2_class_a_ops",
  r2ClassB: "cloudflare.r2_class_b_ops",
  r2Storage: "cloudflare.r2_storage",
  d1RowsRead: "cloudflare.d1_rows_read",
  d1RowsWritten: "cloudflare.d1_rows_written",
  d1Storage: "cloudflare.d1_storage",
} as const;

const metric = (key: string, name: string, description: string, unit: "count" | "bytes", aggregation: "incremental" | "gauge"): MetricDefinition => ({
  key,
  provider: "cloudflare",
  name,
  description,
  unit,
  aggregation,
  scopeLevel: "resource",
  derivation: "reported",
  supported: true,
});

const metrics: MetricDefinition[] = [
  metric(C.workersRequests, "Workers requests", "Daily requests to the Worker. The Free plan allows 100,000 requests a day across the account.", "count", "incremental"),
  metric(C.workersCpuTime, "Workers CPU time (ms)", "Daily CPU time used by the Worker, in milliseconds.", "count", "incremental"),
  metric(C.r2ClassA, "R2 Class A operations", "Daily writes and lists (PutObject, ListObjects, multipart uploads and similar).", "count", "incremental"),
  metric(C.r2ClassB, "R2 Class B operations", "Daily reads (GetObject, HeadObject and similar).", "count", "incremental"),
  metric(C.r2Storage, "R2 storage", "Stored object and metadata size. R2 bills the monthly average (GB-months).", "bytes", "gauge"),
  metric(C.d1RowsRead, "D1 rows read", "Daily rows read by queries against the database.", "count", "incremental"),
  metric(C.d1RowsWritten, "D1 rows written", "Daily rows written by queries against the database.", "count", "incremental"),
  metric(C.d1Storage, "D1 storage", "Database size.", "bytes", "gauge"),
];

const recommendations: Record<string, string> = {
  [C.workersRequests]: "Look for bots or retry loops in the Worker's analytics and cache responses at the edge where you can.",
  [C.workersCpuTime]: "Profile the Worker for expensive work per request (parsing, crypto, large JSON) and cache results.",
  [C.r2ClassA]: "Batch writes and avoid listing buckets on hot paths.",
  [C.r2ClassB]: "Put a cache in front of frequently read objects so repeat reads don't reach R2.",
  [C.r2Storage]: "Delete unused objects or add lifecycle rules to expire old ones.",
  [C.d1RowsRead]: "Add indexes for frequent queries; full table scans count every row read.",
  [C.d1RowsWritten]: "Batch writes and avoid rewriting unchanged rows.",
  [C.d1Storage]: "Delete old rows or archive them elsewhere.",
};

/** R2 operation classes from developers.cloudflare.com/r2/pricing. Anything else is free. */
const R2_CLASS_A = new Set([
  "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload",
  "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts",
  "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration",
]);
const R2_CLASS_B = new Set([
  "HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

type Kind = "worker" | "r2" | "d1";
const RESOURCE_TYPE: Record<Kind, string> = { worker: "worker", r2: "r2_bucket", d1: "d1_database" };

const resourceId = (accountId: string, kind: Kind, name: string) => `${accountId}:${kind}:${name}`;
function parseResourceId(id: string): { accountId: string; kind: Kind; name: string } | null {
  const [accountId, kind, ...rest] = id.split(":");
  if (!accountId || !(kind in RESOURCE_TYPE) || !rest.length) return null;
  return { accountId, kind: kind as Kind, name: rest.join(":") };
}

interface Envelope<T> {
  success?: boolean;
  result?: T;
  result_info?: { page?: number; total_pages?: number };
}
type GqlRow = { dimensions?: Record<string, string>; sum?: Record<string, unknown>; max?: Record<string, unknown> };

function client(ctx: AdapterContext) {
  if (ctx.credentials.kind !== "token") throw new ProviderError("auth_invalid", "Cloudflare connections use an API token");
  const headers = { Authorization: `Bearer ${ctx.credentials.token}`, Accept: "application/json" };
  return {
    get: <T>(path: string) => requestJson<Envelope<T>>(`${CLOUDFLARE_API_URL}${path}`, { headers, fetch: ctx.fetch }),
    async gql(query: string, variables: Record<string, string>): Promise<GqlRow[]> {
      const res = await requestJson<{ data?: { viewer?: { accounts?: { rows?: GqlRow[] }[] } } | null; errors?: { message?: string }[] | null }>(
        `${CLOUDFLARE_API_URL}/graphql`,
        { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }), fetch: ctx.fetch },
      );
      if (res?.errors?.length) {
        const message = res.errors.map((e) => e.message ?? "").join("; ");
        // GraphQL answers 200 even for authorization failures.
        if (/not authori[sz]ed|permission|access denied|forbidden/i.test(message)) throw new ProviderError("permission_denied", message);
        throw new ProviderError("invalid_response", message || "GraphQL query failed");
      }
      const rows = res?.data?.viewer?.accounts?.[0]?.rows;
      if (!Array.isArray(rows)) throw new ProviderError("invalid_response", "GraphQL response has no rows");
      return rows;
    },
  };
}
type Api = ReturnType<typeof client>;

/** Lists a paginated v4 collection (page/per_page with result_info.total_pages). */
async function pagedList<T>(api: Api, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const env = await api.get<T[]>(`${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=50`);
    if (!Array.isArray(env?.result)) throw new ProviderError("invalid_response", `Unexpected response from ${path}`);
    out.push(...env.result);
    if (page >= (env.result_info?.total_pages ?? 1)) break;
  }
  return out;
}

const query = (node: string, dimensions: string, values: string) =>
  `query ($accountTag: string!, $from: Date!, $to: Date!) { viewer { accounts(filter: { accountTag: $accountTag }) { rows: ${node}(limit: 10000, filter: { date_geq: $from, date_leq: $to }) { dimensions { ${dimensions} } ${values} } } } }`;

interface Dataset {
  kind: Kind;
  metricKeys: string[];
  gauge: boolean;
  query: string;
  /** Resource name and per-metric values for one row, or null to ignore the row. */
  read(row: GqlRow): { name: string; values: Record<string, number> } | null;
}

const num = (v: unknown) => toNumber(v) ?? 0;

const DATASETS: Dataset[] = [
  {
    kind: "worker",
    metricKeys: [C.workersRequests, C.workersCpuTime],
    gauge: false,
    query: query("workersInvocationsAdaptive", "date scriptName", "sum { requests cpuTimeUs }"),
    read: (row) =>
      row.dimensions?.scriptName
        ? { name: row.dimensions.scriptName, values: { [C.workersRequests]: num(row.sum?.requests), [C.workersCpuTime]: num(row.sum?.cpuTimeUs) / 1000 } }
        : null,
  },
  {
    kind: "r2",
    metricKeys: [C.r2ClassA, C.r2ClassB],
    gauge: false,
    query: query("r2OperationsAdaptiveGroups", "date bucketName actionType", "sum { requests }"),
    read: (row) => {
      const action = row.dimensions?.actionType ?? "";
      const key = R2_CLASS_A.has(action) ? C.r2ClassA : R2_CLASS_B.has(action) ? C.r2ClassB : null;
      return row.dimensions?.bucketName && key ? { name: row.dimensions.bucketName, values: { [key]: num(row.sum?.requests) } } : null;
    },
  },
  {
    kind: "r2",
    metricKeys: [C.r2Storage],
    gauge: true,
    query: query("r2StorageAdaptiveGroups", "date bucketName", "max { payloadSize metadataSize }"),
    read: (row) =>
      row.dimensions?.bucketName
        ? { name: row.dimensions.bucketName, values: { [C.r2Storage]: num(row.max?.payloadSize) + num(row.max?.metadataSize) } }
        : null,
  },
  {
    kind: "d1",
    metricKeys: [C.d1RowsRead, C.d1RowsWritten],
    gauge: false,
    query: query("d1AnalyticsAdaptiveGroups", "date databaseId", "sum { rowsRead rowsWritten }"),
    read: (row) =>
      row.dimensions?.databaseId
        ? { name: row.dimensions.databaseId, values: { [C.d1RowsRead]: num(row.sum?.rowsRead), [C.d1RowsWritten]: num(row.sum?.rowsWritten) } }
        : null,
  },
  {
    kind: "d1",
    metricKeys: [C.d1Storage],
    gauge: true,
    query: query("d1StorageAdaptiveGroups", "date databaseId", "max { databaseSizeBytes }"),
    read: (row) => (row.dimensions?.databaseId ? { name: row.dimensions.databaseId, values: { [C.d1Storage]: num(row.max?.databaseSizeBytes) } } : null),
  },
];

export const cloudflareAdapter: ProviderAdapter = {
  id: "cloudflare",
  name: "Cloudflare",
  authMethods: ["token"],
  capabilities: {
    accountDiscovery: { level: "supported", note: "Accounts the token can see" },
    resourceDiscovery: { level: "supported", note: "Workers, R2 buckets and D1 databases" },
    usageMetrics: { level: "supported", note: "Workers requests and CPU time, R2 operations and storage, D1 rows and storage, daily." },
    quotaRetrieval: { level: "unsupported", note: "Set limits yourself; plan detection would need billing permissions." },
    actualCost: { level: "unsupported", note: "Not collected; it would need billing permissions." },
    forecastingInputs: { level: "supported", note: "Up to 30 days of daily history per sync." },
    billingCycleMetadata: { level: "unsupported", note: "Set each account's billing cycle day manually." },
    accountControls: { level: "unsupported", note: "Limit Gauge never changes Workers, buckets or databases." },
  },
  metrics,
  pricingRules: [],
  planAllowances: [],
  recommendations,
  tokenConnect: {
    tokenLabel: "API token",
    createUrl: "https://dash.cloudflare.com/profile/api-tokens",
    steps: [
      "Open My Profile → API Tokens in the Cloudflare dashboard and choose Create Token → Create Custom Token.",
      "Add each permission below at the Account level, set to Read.",
      "Under Account Resources, include the accounts you want to monitor, then create the token and copy it.",
    ],
    permissions: ["Account Settings: Read", "Account Analytics: Read", "Workers Scripts: Read", "Workers R2 Storage: Read", "D1: Read"],
  },

  async validate(ctx) {
    const accounts = await pagedList<{ id: string }>(client(ctx), "/accounts");
    if (!accounts.length) {
      throw new ProviderError("permission_denied", "The token can't see any accounts. Add the Account Settings: Read permission.");
    }
    return {
      identity: `${accounts.length} account${accounts.length === 1 ? "" : "s"}`,
      grantedScopes: cloudflareAdapter.tokenConnect!.permissions!,
    };
  },

  async discover(ctx): Promise<Discovery> {
    const api = client(ctx);
    const list = await pagedList<{ id: string; name: string }>(api, "/accounts");
    const accounts: DiscoveredAccount[] = [];
    const resources: DiscoveredResource[] = [];

    for (const a of list) {
      const skipped: string[] = [];
      const dash = `https://dash.cloudflare.com/${a.id}`;
      const tryType = async (label: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (e) {
          if (isAuthFailure(e)) throw e;
          skipped.push(`${label}: ${(e as Error).message}`);
        }
      };
      const resource = (kind: Kind, name: string, display: string, dashboardUrl: string): DiscoveredResource => ({
        externalId: resourceId(a.id, kind, name),
        accountExternalId: a.id,
        name: display,
        resourceType: RESOURCE_TYPE[kind],
        region: null,
        plan: null,
        providerStatus: null,
        status: "active",
        dashboardUrl,
      });

      await tryType("Workers", async () => {
        const env = await api.get<{ id: string }[]>(`/accounts/${a.id}/workers/scripts`);
        if (!Array.isArray(env?.result)) throw new ProviderError("invalid_response", "Unexpected Workers response");
        for (const s of env.result) resources.push(resource("worker", s.id, s.id, `${dash}/workers/services/view/${s.id}/production`));
      });
      await tryType("R2", async () => {
        const env = await api.get<{ buckets?: { name: string }[] }>(`/accounts/${a.id}/r2/buckets?per_page=1000`);
        const buckets = env?.result?.buckets;
        if (!Array.isArray(buckets)) throw new ProviderError("invalid_response", "Unexpected R2 response");
        for (const b of buckets) resources.push(resource("r2", b.name, b.name, `${dash}/r2/default/buckets/${b.name}`));
      });
      await tryType("D1", async () => {
        const dbs = await pagedList<{ uuid: string; name: string }>(api, `/accounts/${a.id}/d1/database`);
        for (const d of dbs) resources.push(resource("d1", d.uuid, d.name, `${dash}/workers/d1/databases/${d.uuid}`));
      });

      accounts.push({
        externalId: a.id,
        name: a.name,
        accountType: "account",
        plan: null,
        billingCurrency: "USD",
        dashboardUrl: dash,
        ...(skipped.length ? { metadata: { skipped } } : {}),
      });
    }
    return { accounts, resources };
  },

  async collect(ctx, target: CollectTarget): Promise<CollectResult> {
    const api = client(ctx);
    const now = ctx.now;
    const result = emptyResult();
    const today = startOfUtcDay(now);
    const from = new Date(Math.max(startOfUtcDay(target.since).getTime(), today.getTime() - (MAX_DAYS - 1) * DAY_MS));
    const days = utcDays(from, today);

    const parsed = target.resources.map((r) => ({ id: r.externalId, ...parseResourceId(r.externalId) }));
    const accountIds = [...new Set(parsed.map((p) => p.accountId).filter(Boolean) as string[])];

    for (const accountId of accountIds) {
      for (const ds of DATASETS) {
        const monitored = parsed.filter((p) => p.accountId === accountId && p.kind === ds.kind) as { id: string; name: string }[];
        if (!monitored.length) continue;
        const scopes = monitored.map((m) => ({ resourceExternalId: m.id }));
        try {
          const rows = await api.gql(ds.query, { accountTag: accountId, from: dayKey(from), to: dayKey(today) });
          // name|date → metric → value (summed for counters, max for gauges)
          const agg = new Map<string, Record<string, number>>();
          for (const row of rows) {
            const read = ds.read(row);
            const date = row.dimensions?.date;
            if (!read || !date) continue;
            const key = `${read.name}|${date}`;
            const cur = agg.get(key) ?? {};
            for (const [k, v] of Object.entries(read.values)) cur[k] = ds.gauge ? Math.max(cur[k] ?? 0, v) : (cur[k] ?? 0) + v;
            agg.set(key, cur);
          }
          for (const m of monitored) {
            const scope = { resourceExternalId: m.id };
            for (const day of days) {
              const values = agg.get(`${m.name}|${dayKey(day)}`);
              // Counters with no rows on a day really were zero; gauges only exist when measured.
              if (!values && ds.gauge) continue;
              for (const k of ds.metricKeys) {
                if (ds.gauge && values?.[k] === undefined) continue;
                result.observations.push(dayObservation(k, scope, day, values?.[k] ?? 0, now, ds.gauge ? { quality: "ok" } : {}));
              }
            }
          }
          recordOk(result, ds.metricKeys, scopes);
        } catch (e) {
          recordFailure(result, ds.metricKeys, scopes, e);
        }
      }
    }
    return result;
  },
};
```

- [ ] **Step 4: Register the adapter** in `src/lib/providers/registry.ts`:

```ts
import { cloudflareAdapter } from "./cloudflare/adapter";
```

```ts
const ADAPTERS: Partial<Record<ProviderId, ProviderAdapter>> = {
  supabase: supabaseAdapter,
  neon: neonAdapter,
  cloudflare: cloudflareAdapter,
  demo: demoAdapter,
};
```

Set the Cloudflare catalog entry to `available: true`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/cloudflare-adapter.test.ts tests/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/providers/cloudflare/adapter.ts tests/cloudflare-adapter.test.ts
git commit -m "feat(providers): Cloudflare adapter" -- src/lib/providers/cloudflare/adapter.ts src/lib/providers/registry.ts tests/cloudflare-adapter.test.ts
```

---

### Task 6: Vercel adapter

**Files:**
- Create: `src/lib/providers/vercel/adapter.ts`
- Modify: `src/lib/providers/registry.ts` (register, mark available)
- Test: `tests/vercel-adapter.test.ts`

Accounts are teams, keyed by team id (`team_…`). When a token sees no teams, the personal account is used with external id `user:<id>` and no `teamId` query parameter.

- [ ] **Step 1: Write the failing test**

```ts
// tests/vercel-adapter.test.ts
import { describe, expect, it } from "vitest";
import { billingCycle } from "@/lib/engine/time";
import { tokenProvider } from "@/lib/providers/registry";
import { V, parseFocusJsonl, vercelAdapter } from "@/lib/providers/vercel/adapter";
import { mockFetch } from "./helpers/mock-fetch";

const now = new Date("2026-10-09T12:00:00Z");
const cycle = billingCycle(now, 1);
const ctx = (f: typeof fetch) => ({ credentials: { kind: "token" as const, token: "vercel_test" }, now, fetch: f });
const ms = (iso: string) => Date.parse(iso);

const deployments = () =>
  [
    200,
    {
      deployments: [
        { uid: "d1", created: ms("2026-10-07T10:00:00Z") },
        { uid: "d2", created: ms("2026-10-07T15:00:00Z") },
        { uid: "d3", created: ms("2026-10-09T09:00:00Z") },
      ],
      pagination: { next: null },
    },
  ] as [number, unknown];

const target = (plan: string) => ({
  since: new Date("2026-10-07T00:00:00Z"),
  accounts: [{ externalId: "team_1", plan, cycle }],
  resources: [{ externalId: "prj_1", accountExternalId: "team_1", providerStatus: null, cycle }],
});

describe("vercel adapter", () => {
  it("parses FOCUS JSONL and rejects garbage", () => {
    expect(parseFocusJsonl('{"BilledCost":"1.5"}\n\n{"BilledCost":2}\n')).toHaveLength(2);
    expect(() => parseFocusJsonl("not json")).toThrow(/JSONL/);
  });

  it("discovers teams with plans and pages through projects", async () => {
    const f = mockFetch({
      "GET /v2/user": () => [200, { user: { id: "u1", username: "dev" } }],
      "GET /v2/teams": () => [200, { teams: [{ id: "team_1", slug: "acme", name: "Acme" }], pagination: { next: null } }],
      "GET /v2/teams/team_1": () => [200, { id: "team_1", slug: "acme", name: "Acme", billing: { plan: "pro" } }],
      "GET /v10/projects": (url) =>
        url.searchParams.get("from")
          ? [200, { projects: [{ id: "prj_2", name: "web" }], pagination: { next: null } }]
          : [200, { projects: [{ id: "prj_1", name: "api" }], pagination: { next: 1700000000000 } }],
    });
    const d = await vercelAdapter.discover(ctx(f));
    expect(d.accounts).toEqual([expect.objectContaining({ externalId: "team_1", name: "Acme", plan: "pro", dashboardUrl: "https://vercel.com/acme" })]);
    expect(d.resources.map((r) => [r.externalId, r.accountExternalId, r.dashboardUrl])).toEqual([
      ["prj_1", "team_1", "https://vercel.com/acme/api"],
      ["prj_2", "team_1", "https://vercel.com/acme/web"],
    ]);
  });

  it("falls back to the personal account when the token sees no teams", async () => {
    const f = mockFetch({
      "GET /v2/user": () => [200, { user: { id: "u1", username: "dev", name: "Dev" } }],
      "GET /v2/teams": () => [200, { teams: [], pagination: { next: null } }],
      "GET /v10/projects": () => [200, { projects: [{ id: "prj_9", name: "site" }], pagination: { next: null } }],
    });
    const d = await vercelAdapter.discover(ctx(f));
    expect(d.accounts[0]).toMatchObject({ externalId: "user:u1", name: "Dev", plan: "hobby" });
    expect(d.resources[0]).toMatchObject({ externalId: "prj_9", accountExternalId: "user:u1" });
  });

  it("on Hobby counts deployments and marks billing metrics unsupported without calling billing", async () => {
    const calls: string[] = [];
    const f = mockFetch({ "GET /v6/deployments": deployments }, calls);
    const r = await vercelAdapter.collect(ctx(f), target("hobby"));
    expect(r.observations.filter((o) => o.metricKey === V.deployments).map((o) => [o.bucketStart.toISOString().slice(0, 10), o.value])).toEqual([
      ["2026-10-07", 2],
      ["2026-10-08", 0],
      ["2026-10-09", 1],
    ]);
    expect(r.outcomes.find((o) => o.metricKey === V.functionInvocations)).toMatchObject({ status: "unsupported" });
    expect(calls.some((c) => c.includes("/v1/billing/charges"))).toBe(false);
    expect(calls[0]).toContain("teamId=team_1");
  });

  it("on Pro maps billing charges to metrics and reports cycle-to-date cost", async () => {
    const rows = [
      { ChargeCategory: "Usage", ChargePeriodStart: "2026-10-08T00:00:00Z", ServiceName: "Function Invocations", ConsumedQuantity: "1200", ConsumedUnit: "Invocations", BilledCost: "0.72", BillingCurrency: "USD", Tags: { ProjectId: "prj_1" } },
      { ChargeCategory: "Usage", ChargePeriodStart: "2026-10-08T00:00:00Z", ServiceName: "Fast Data Transfer", ConsumedQuantity: 2, ConsumedUnit: "GB", BilledCost: 0.3, BillingCurrency: "USD", Tags: { ProjectId: "prj_1" } },
      { ChargeCategory: "Usage", ChargePeriodStart: "2026-10-08T00:00:00Z", ServiceName: "Image Optimization", ConsumedQuantity: 10, ConsumedUnit: "Images", BilledCost: 1, BillingCurrency: "USD", Tags: { ProjectId: "prj_1" } },
      { ChargeCategory: "Usage", ChargePeriodStart: "2026-10-08T00:00:00Z", ServiceName: "Function Invocations", ConsumedQuantity: 99, ConsumedUnit: "Invocations", BilledCost: 0.5, BillingCurrency: "USD", Tags: { ProjectId: "prj_other" } },
      { ChargeCategory: "Purchase", ChargePeriodStart: "2026-10-01T00:00:00Z", ServiceName: "Pro Plan", BilledCost: 20, BillingCurrency: "USD", Tags: {} },
    ];
    const f = mockFetch({
      "GET /v6/deployments": deployments,
      "GET /v1/billing/charges": () => [200, rows.map((r) => JSON.stringify(r)).join("\n")],
    });
    const r = await vercelAdapter.collect(ctx(f), target("pro"));
    const series = (k: string) => r.observations.filter((o) => o.metricKey === k).map((o) => [o.bucketStart.toISOString().slice(0, 10), o.value]);
    expect(series(V.functionInvocations)).toEqual([["2026-10-08", 1200]]);
    expect(series(V.dataTransfer)).toEqual([["2026-10-08", 2 * 1024 ** 3]]);
    expect(series(V.edgeRequests)).toEqual([]);
    expect(r.costs).toEqual([
      { accountExternalId: "team_1", periodStart: cycle.start, periodEnd: cycle.end, amount: 22.52, currency: "USD" },
    ]);
    expect(r.outcomes.filter((o) => o.status === "ok").map((o) => o.metricKey).sort()).toEqual(
      [V.buildMinutes, V.dataTransfer, V.deployments, V.edgeRequests, V.functionInvocations].sort(),
    );
  });

  it("reports billing metrics unavailable on a 403 but keeps deployments", async () => {
    const f = mockFetch({
      "GET /v6/deployments": deployments,
      "GET /v1/billing/charges": () => [403, { error: { code: "forbidden", message: "Not allowed" } }],
    });
    const r = await vercelAdapter.collect(ctx(f), target("pro"));
    expect(r.outcomes.find((o) => o.metricKey === V.dataTransfer)).toMatchObject({ status: "unavailable", errorCode: "permission_denied" });
    expect(r.outcomes.find((o) => o.metricKey === V.deployments)).toMatchObject({ status: "ok" });
  });

  it("is connectable with a token and warns that it is not read-only", () => {
    expect(tokenProvider("vercel")?.tokenConnect?.warning).toMatch(/more than read/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/vercel-adapter.test.ts`
Expected: FAIL, cannot resolve `@/lib/providers/vercel/adapter`.

- [ ] **Step 3: Implement `src/lib/providers/vercel/adapter.ts`**

```ts
import { GB, MB } from "../../units";
import { startOfUtcDay } from "../../engine/time";
import type { MetricDefinition } from "../../types";
import { dayObservation, emptyResult, isAuthFailure, recordFailure, recordOk, toNumber, utcDays } from "../collect";
import { requestJson, requestText } from "../http";
import {
  type AdapterContext,
  type CollectResult,
  type CollectTarget,
  type DiscoveredAccount,
  type DiscoveredResource,
  type Discovery,
  type PlanAllowance,
  ProviderError,
  type ProviderAdapter,
} from "../types";

// Verified against vercel.com/docs/rest-api (user, teams, projects, deployments, FOCUS
// billing charges) and vercel.com/pricing on 2026-10-29. The billing service-name mapping
// is confirmed against a live Pro response in the batch 1 live check. Re-verify before changing.

export const VERCEL_API_URL = process.env.VERCEL_API_URL ?? "https://api.vercel.com";

const VERIFIED = "2026-10-29";
const PRICING = "https://vercel.com/pricing";
const HOBBY_DETAIL = "Vercel reports usage through its billing API on Pro and Enterprise teams only.";

export const V = {
  deployments: "vercel.deployments",
  functionInvocations: "vercel.function_invocations",
  dataTransfer: "vercel.data_transfer",
  edgeRequests: "vercel.edge_requests",
  buildMinutes: "vercel.build_minutes",
} as const;

const BILLING_METRICS: string[] = [V.functionInvocations, V.dataTransfer, V.edgeRequests, V.buildMinutes];

const metric = (key: string, name: string, description: string, unit: "count" | "bytes", derivation: "reported" | "derived"): MetricDefinition => ({
  key,
  provider: "vercel",
  name,
  description,
  unit,
  aggregation: "incremental",
  scopeLevel: "resource",
  derivation,
  supported: true,
});

const metrics: MetricDefinition[] = [
  metric(V.deployments, "Deployments", "Deployments created per day, counted from the project's deployment list. Hobby allows 100 a day.", "count", "derived"),
  metric(V.functionInvocations, "Function invocations", "Daily function invocations from Vercel's billing data (Pro and Enterprise).", "count", "reported"),
  metric(V.dataTransfer, "Data transfer", "Daily Fast Data Transfer from Vercel's billing data (Pro and Enterprise).", "bytes", "reported"),
  metric(V.edgeRequests, "Edge requests", "Daily edge (CDN) requests from Vercel's billing data (Pro and Enterprise).", "count", "reported"),
  metric(V.buildMinutes, "Build minutes", "Daily build minutes from Vercel's billing data (Pro and Enterprise).", "count", "reported"),
];

const planAllowances: PlanAllowance[] = [
  {
    plan: "pro",
    metricKey: V.edgeRequests,
    scope: "account",
    limit: 1_000_000,
    overageEffect: "charges",
    note: "Pro's free Flat Rate CDN tier covers 1M edge requests a month; above it Vercel moves you to a paid tier.",
    sourceUrl: PRICING,
    verifiedAt: VERIFIED,
  },
  {
    plan: "pro",
    metricKey: V.dataTransfer,
    scope: "account",
    limit: 1024 * GB,
    overageEffect: "charges",
    note: "Pro's free Flat Rate CDN tier includes 1 TB of Fast Data Transfer a month.",
    sourceUrl: PRICING,
    verifiedAt: VERIFIED,
  },
];

const recommendations: Record<string, string> = {
  [V.deployments]: "Batch commits or limit preview deployments to the branches you review (Ignored Build Step).",
  [V.functionInvocations]: "Cache responses (ISR, CDN headers) so repeat requests don't invoke functions, and look for bots or polling clients.",
  [V.dataTransfer]: "Compress and resize assets, and move large downloads to object storage.",
  [V.edgeRequests]: "Bundle small assets and check for bots or aggressive prefetching.",
  [V.buildMinutes]: "Skip builds for unchanged projects in monorepos and cache dependencies between builds.",
};

/** FOCUS ServiceName → metric, matched case-insensitively. Unmatched services count toward cost only. */
const SERVICE_METRICS: { match: RegExp; metricKey: string }[] = [
  { match: /function invocation/i, metricKey: V.functionInvocations },
  { match: /data transfer/i, metricKey: V.dataTransfer },
  { match: /edge request|cdn request/i, metricKey: V.edgeRequests },
  { match: /build minute|build time/i, metricKey: V.buildMinutes },
];

/** Converts a consumed quantity to the metric's unit; null when the unit is not understood. */
function toMetricUnits(metricKey: string, quantity: number, unit: string | null | undefined): number | null {
  const u = (unit ?? "").trim().toLowerCase();
  if (metricKey === V.dataTransfer) {
    if (u === "gb") return quantity * GB;
    if (u === "tb") return quantity * 1024 * GB;
    if (u === "mb") return quantity * MB;
    if (u === "b" || u === "bytes") return quantity;
    return null;
  }
  if (metricKey === V.buildMinutes && (u === "hours" || u === "hour" || u === "h")) return quantity * 60;
  return quantity;
}

interface FocusRow {
  BilledCost?: number | string;
  BillingCurrency?: string;
  ChargeCategory?: string;
  ChargePeriodStart?: string;
  ConsumedQuantity?: number | string | null;
  ConsumedUnit?: string | null;
  ServiceName?: string;
  Tags?: Record<string, unknown> | string | null;
}

export function parseFocusJsonl(text: string): FocusRow[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as FocusRow;
      } catch {
        throw new ProviderError("invalid_response", "Billing charges are not valid JSONL");
      }
    });
}

function projectIdOf(tags: FocusRow["Tags"]): string | null {
  let t: unknown = tags;
  if (typeof t === "string") {
    try {
      t = JSON.parse(t);
    } catch {
      return null;
    }
  }
  const id = t && typeof t === "object" ? ((t as Record<string, unknown>).ProjectId ?? (t as Record<string, unknown>).projectId) : null;
  return typeof id === "string" ? id : null;
}

const isTeam = (accountExternalId: string | null) => !!accountExternalId && !accountExternalId.startsWith("user:");
const teamQuery = (accountExternalId: string | null): Record<string, string> => (isTeam(accountExternalId) ? { teamId: accountExternalId! } : {});

function client(ctx: AdapterContext) {
  if (ctx.credentials.kind !== "token") throw new ProviderError("auth_invalid", "Vercel connections use an access token");
  const headers = { Authorization: `Bearer ${ctx.credentials.token}` };
  const url = (path: string, query: Record<string, string>) => {
    const qs = new URLSearchParams(query).toString();
    return `${VERCEL_API_URL}${path}${qs ? `?${qs}` : ""}`;
  };
  return {
    get: <T>(path: string, query: Record<string, string> = {}) =>
      requestJson<T>(url(path, query), { headers: { ...headers, Accept: "application/json" }, fetch: ctx.fetch }),
    text: (path: string, query: Record<string, string> = {}) => requestText(url(path, query), { headers, fetch: ctx.fetch, timeoutMs: 60_000 }),
  };
}
type Api = ReturnType<typeof client>;

interface User {
  id: string;
  username: string;
  name?: string | null;
  billing?: { plan?: string } | null;
}
interface Team {
  id: string;
  slug: string;
  name: string;
  billing?: { plan?: string } | null;
}

async function listDeploymentTimes(api: Api, accountExternalId: string | null, projectId: string, sinceMs: number): Promise<number[]> {
  const times: number[] = [];
  let until: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = { ...teamQuery(accountExternalId), projectId, since: String(sinceMs), limit: "100" };
    if (until) query.until = until;
    const res = await api.get<{ deployments?: { created?: number }[]; pagination?: { next?: number | null } }>("/v6/deployments", query);
    if (!Array.isArray(res?.deployments)) throw new ProviderError("invalid_response", "Unexpected deployments response");
    for (const d of res.deployments) if (typeof d.created === "number" && d.created >= sinceMs) times.push(d.created);
    const next = res.pagination?.next;
    if (!next) break;
    until = String(next);
  }
  return times;
}

export const vercelAdapter: ProviderAdapter = {
  id: "vercel",
  name: "Vercel",
  authMethods: ["token"],
  capabilities: {
    accountDiscovery: { level: "supported", note: "Teams and their plans" },
    resourceDiscovery: { level: "supported", note: "Projects" },
    usageMetrics: { level: "partial", note: "Deployments on every plan; invocations, data transfer, edge requests and build minutes on Pro and Enterprise." },
    quotaRetrieval: { level: "unsupported", note: "Plan allowances are suggested from Vercel's pricing page and need your confirmation." },
    actualCost: { level: "partial", note: "Cycle-to-date billed cost on Pro and Enterprise teams." },
    forecastingInputs: { level: "partial", note: "Daily history on Pro and Enterprise; deployments only on Hobby." },
    billingCycleMetadata: { level: "unsupported", note: "Set each team's billing cycle day manually." },
    accountControls: { level: "unsupported", note: "Limit Gauge never changes projects, plans or spend management." },
  },
  metrics,
  pricingRules: [],
  planAllowances,
  recommendations,
  tokenConnect: {
    tokenLabel: "Access token",
    createUrl: "https://vercel.com/account/settings/tokens",
    steps: [
      "Open Account Settings → Tokens in the Vercel dashboard and create a token.",
      "Set its scope to the team you want to monitor and choose an expiry.",
      "Copy the token and paste it below.",
    ],
    warning:
      "Vercel tokens can do more than read. Limit Gauge only sends read requests and encrypts the token at rest. Scope it to one team and set an expiry.",
  },

  async validate(ctx) {
    const res = await client(ctx).get<{ user?: User }>("/v2/user");
    if (!res?.user) throw new ProviderError("invalid_response", "Unexpected user response");
    return { identity: res.user.username, grantedScopes: ["access token (can do more than read)"] };
  },

  async discover(ctx): Promise<Discovery> {
    const api = client(ctx);
    const me = (await api.get<{ user?: User }>("/v2/user"))?.user;
    if (!me) throw new ProviderError("invalid_response", "Unexpected user response");

    const teams: Team[] = [];
    let until: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await api.get<{ teams?: Team[]; pagination?: { next?: number | null } }>("/v2/teams", { limit: "100", ...(until ? { until } : {}) });
      if (!Array.isArray(res?.teams)) throw new ProviderError("invalid_response", "Unexpected teams response");
      teams.push(...res.teams);
      if (!res.pagination?.next) break;
      until = String(res.pagination.next);
    }

    const accounts: DiscoveredAccount[] = [];
    for (const t of teams) {
      let plan = t.billing?.plan ?? null;
      if (!plan) {
        try {
          plan = (await api.get<Team>(`/v2/teams/${encodeURIComponent(t.id)}`))?.billing?.plan ?? null;
        } catch (e) {
          if (isAuthFailure(e)) throw e;
          // The plan is optional metadata; a missing permission must not block discovery.
        }
      }
      accounts.push({
        externalId: t.id,
        name: t.name,
        accountType: "organization",
        plan: plan?.toLowerCase() ?? null,
        billingCurrency: "USD",
        dashboardUrl: `https://vercel.com/${t.slug}`,
      });
    }
    if (!accounts.length) {
      accounts.push({
        externalId: `user:${me.id}`,
        name: me.name ?? me.username,
        accountType: "account",
        plan: me.billing?.plan?.toLowerCase() ?? "hobby",
        billingCurrency: "USD",
        dashboardUrl: `https://vercel.com/${me.username}`,
      });
    }

    const resources: DiscoveredResource[] = [];
    for (const a of accounts) {
      const slug = a.dashboardUrl!.slice("https://vercel.com/".length);
      let from: string | undefined;
      for (let page = 0; page < 50; page++) {
        const res = await api.get<{ projects?: { id: string; name: string }[]; pagination?: { next?: number | null } }>("/v10/projects", {
          ...teamQuery(a.externalId),
          limit: "100",
          ...(from ? { from } : {}),
        });
        if (!Array.isArray(res?.projects)) throw new ProviderError("invalid_response", "Unexpected projects response");
        for (const p of res.projects) {
          resources.push({
            externalId: p.id,
            accountExternalId: a.externalId,
            name: p.name,
            resourceType: "project",
            region: null,
            plan: null,
            providerStatus: null,
            status: "active",
            dashboardUrl: `https://vercel.com/${slug}/${p.name}`,
          });
        }
        if (!res.pagination?.next) break;
        from = String(res.pagination.next);
      }
    }
    return { accounts, resources };
  },

  async collect(ctx, target: CollectTarget): Promise<CollectResult> {
    const api = client(ctx);
    const now = ctx.now;
    const result = emptyResult();
    const from = startOfUtcDay(target.since);

    for (const r of target.resources) {
      const scope = { resourceExternalId: r.externalId };
      try {
        const times = await listDeploymentTimes(api, r.accountExternalId, r.externalId, from.getTime());
        const perDay = new Map<number, number>();
        for (const t of times) {
          const day = startOfUtcDay(new Date(t)).getTime();
          perDay.set(day, (perDay.get(day) ?? 0) + 1);
        }
        for (const day of utcDays(from, now)) {
          result.observations.push(dayObservation(V.deployments, scope, day, perDay.get(day.getTime()) ?? 0, now, { source: "derived" }));
        }
        recordOk(result, [V.deployments], [scope]);
      } catch (e) {
        recordFailure(result, [V.deployments], [scope], e);
      }
    }

    for (const account of target.accounts) {
      const resources = target.resources.filter((r) => r.accountExternalId === account.externalId);
      if (!resources.length) continue;
      const scopes = resources.map((r) => ({ resourceExternalId: r.externalId }));

      if (!isTeam(account.externalId) || account.plan === "hobby") {
        for (const scope of scopes) {
          for (const metricKey of BILLING_METRICS) result.outcomes.push({ metricKey, scope, status: "unsupported", detail: HOBBY_DETAIL });
        }
        continue;
      }

      try {
        const start = new Date(Math.min(from.getTime(), account.cycle.start.getTime()));
        const rows = parseFocusJsonl(
          await api.text("/v1/billing/charges", { teamId: account.externalId, from: start.toISOString(), to: now.toISOString() }),
        );
        const monitored = new Set(resources.map((r) => r.externalId));
        const usage = new Map<string, number>(); // metric|project|dayMs → value
        let cycleCost = 0;
        let currency = "USD";
        for (const row of rows) {
          const periodStart = row.ChargePeriodStart ? new Date(row.ChargePeriodStart) : null;
          if (!periodStart || Number.isNaN(periodStart.getTime())) continue;
          if (row.BillingCurrency) currency = row.BillingCurrency;
          if (periodStart >= account.cycle.start && periodStart < account.cycle.end) cycleCost += toNumber(row.BilledCost) ?? 0;
          if (row.ChargeCategory !== "Usage" || periodStart < from) continue;
          const metricKey = SERVICE_METRICS.find((s) => s.match.test(row.ServiceName ?? ""))?.metricKey;
          const project = projectIdOf(row.Tags);
          if (!metricKey || !project || !monitored.has(project)) continue;
          const value = toMetricUnits(metricKey, toNumber(row.ConsumedQuantity) ?? 0, row.ConsumedUnit);
          if (value === null) continue;
          const key = `${metricKey}|${project}|${startOfUtcDay(periodStart).getTime()}`;
          usage.set(key, (usage.get(key) ?? 0) + value);
        }
        for (const [key, value] of usage) {
          const [metricKey, project, day] = key.split("|");
          result.observations.push(dayObservation(metricKey, { resourceExternalId: project }, new Date(Number(day)), value, now));
        }
        result.costs.push({
          accountExternalId: account.externalId,
          periodStart: account.cycle.start,
          periodEnd: account.cycle.end,
          amount: Math.round(cycleCost * 100) / 100,
          currency,
        });
        recordOk(result, BILLING_METRICS, scopes);
      } catch (e) {
        recordFailure(result, BILLING_METRICS, scopes, e);
      }
    }
    return result;
  },
};
```

Check the test's expected cost: rows in the cycle sum to 0.72 + 0.3 + 1 + 0.5 + 20 = 22.52 (the `prj_other` row is outside the monitored set but still billed to the team).

- [ ] **Step 4: Register the adapter** in `src/lib/providers/registry.ts`:

```ts
import { vercelAdapter } from "./vercel/adapter";
```

```ts
const ADAPTERS: Partial<Record<ProviderId, ProviderAdapter>> = {
  supabase: supabaseAdapter,
  neon: neonAdapter,
  cloudflare: cloudflareAdapter,
  vercel: vercelAdapter,
  demo: demoAdapter,
};
```

Set the Vercel catalog entry to `available: true`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/vercel-adapter.test.ts tests/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/providers/vercel/adapter.ts tests/vercel-adapter.test.ts
git commit -m "feat(providers): Vercel adapter" -- src/lib/providers/vercel/adapter.ts src/lib/providers/registry.ts tests/vercel-adapter.test.ts
```

---

### Task 7: Generic token connect page and `connectToken`

**Files:**
- Modify: `src/app/(app)/providers/token-form.tsx`
- Modify: `src/app/(app)/providers/actions.ts:66-129`
- Create: `src/app/(app)/providers/connect/[provider]/page.tsx`

This task is UI and server-action wiring over code already covered by unit tests (`tokenProvider`, adapters). It is verified in the browser in Task 9.

- [ ] **Step 1: Make the token form provider-aware.** Replace the body of `src/app/(app)/providers/token-form.tsx` with:

```tsx
"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/form-controls";
import { Input, Label, Notice } from "@/components/ui";
import type { FormState } from "./actions";

export function TokenForm({
  action,
  connectionId,
  withLabel,
  submit,
  defaultLabel = "Supabase",
  tokenLabel = "Personal access token",
  tokenHint = "(starts with sbp_)",
  placeholder = "sbp_…",
}: {
  action: (s: FormState, f: FormData) => Promise<FormState>;
  connectionId?: string;
  withLabel?: boolean;
  submit: string;
  defaultLabel?: string;
  tokenLabel?: string;
  tokenHint?: string;
  placeholder?: string;
}) {
  const [state, formAction] = useActionState(action, undefined);
  return (
    <form action={formAction} className="space-y-3" autoComplete="off">
      {state?.error ? <Notice tone="crit">{state.error}</Notice> : null}
      {connectionId ? <input type="hidden" name="connectionId" value={connectionId} /> : null}
      {withLabel ? (
        <div>
          <Label htmlFor="label">Connection name</Label>
          <Input id="label" name="label" defaultValue={defaultLabel} maxLength={80} required />
        </div>
      ) : null}
      <div>
        <Label htmlFor="token" hint={tokenHint || undefined}>
          {tokenLabel}
        </Label>
        <Input id="token" name="token" type="password" autoComplete="off" spellCheck={false} placeholder={placeholder} required />
      </div>
      <SubmitButton pendingText="Validating and discovering…">{submit}</SubmitButton>
    </form>
  );
}
```

Callers for non-Supabase providers pass `tokenHint={info.tokenHint ?? ""}` and `placeholder={info.placeholder ?? ""}` so Supabase's defaults never leak onto other providers.

- [ ] **Step 2: Generalize the connect action.** In `src/app/(app)/providers/actions.ts`:

Change the import from the registry to:

```ts
import { demoEnabled, getAdapter, PROVIDER_NAMES, tokenProvider } from "@/lib/providers/registry";
```

Change `createConnection`'s `provider` field type (line ~71) from `"supabase" | "demo"` to `ProviderId`, and add `ProviderId` to the imports:

```ts
import type { ProviderId } from "@/lib/types";
```

Replace the whole `connectSupabaseToken` function with:

```ts
/** Connects any token provider. Bound to a provider id on the connect page. */
export async function connectToken(provider: string, _: FormState, form: FormData): Promise<FormState> {
  const adapter = tokenProvider(provider);
  if (!adapter) return { error: "This provider can't be connected with a token yet." };
  const { user, workspace, scope } = await getSession();
  const parsed = tokenForm.safeParse({ label: form.get("label"), token: form.get("token") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  if (await tooManyConnectionAttempts(workspace.id)) return { error: "Too many connection attempts. Try again in an hour." };

  const credentials: Credentials = { kind: "token", token: parsed.data.token };
  let grantedScopes: string[];
  try {
    ({ grantedScopes } = await adapter.validate({ credentials, now: new Date() }));
  } catch (e) {
    await audit({ workspaceId: workspace.id, actorId: user.id, action: "connection.create_failed", details: { provider: adapter.id } });
    return { error: describeProviderError(e) };
  }
  const id = await createConnection({
    scope,
    provider: adapter.id,
    label: parsed.data.label,
    authMethod: "token",
    credentials,
    grantedScopes,
  });
  redirect(`/providers/${id}?setup=1`);
}

export async function connectSupabaseToken(state: FormState, form: FormData): Promise<FormState> {
  return connectToken("supabase", state, form);
}
```

In `disconnect`, replace the `note` constant with:

```ts
  const note =
    connection.auth_method === "token"
      ? `Disconnected and deleted the stored token. Also revoke the token in your ${PROVIDER_NAMES[connection.provider] ?? connection.provider} account settings.`
      : "Disconnected and deleted the stored credentials.";
```

- [ ] **Step 3: Create the connect page** `src/app/(app)/providers/connect/[provider]/page.tsx`:

```tsx
import { ExternalLink, KeyRound } from "lucide-react";
import { notFound } from "next/navigation";
import { Card, CardBody, CardHeader, Notice, PageHeader } from "@/components/ui";
import { tokenProvider } from "@/lib/providers/registry";
import { connectToken } from "../../actions";
import { TokenForm } from "../../token-form";

export async function generateMetadata({ params }: PageProps<"/providers/connect/[provider]">) {
  const adapter = tokenProvider((await params).provider);
  return { title: adapter ? `Connect ${adapter.name}` : "Connect a provider" };
}

export default async function ConnectTokenPage({ params }: PageProps<"/providers/connect/[provider]">) {
  const adapter = tokenProvider((await params).provider);
  const info = adapter?.tokenConnect;
  if (!adapter || !info) notFound();

  return (
    <>
      <PageHeader
        title={`Connect ${adapter.name}`}
        description={`Limit Gauge reads your ${adapter.name} projects and usage with an API token. It never changes anything in your account.`}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={`Create a ${info.tokenLabel.toLowerCase()}`} />
          <CardBody className="space-y-4">
            <ol className="list-decimal space-y-2 pl-5 text-sm text-text">
              {info.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {info.permissions?.length ? (
              <div className="space-y-2">
                <p className="text-sm text-muted">Permissions to grant:</p>
                <ul className="flex flex-wrap gap-1.5">
                  {info.permissions.map((p) => (
                    <li key={p} className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <a href={info.createUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
              Open {adapter.name} token settings <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                <KeyRound className="size-4 text-muted" aria-hidden /> {info.tokenLabel}
              </span>
            }
            description="Stored encrypted and never shown again after saving."
          />
          <CardBody className="space-y-4">
            {info.warning ? <Notice tone="warn">{info.warning}</Notice> : null}
            <TokenForm
              action={connectToken.bind(null, adapter.id)}
              withLabel
              defaultLabel={adapter.name}
              tokenLabel={info.tokenLabel}
              tokenHint={info.tokenHint ?? ""}
              placeholder={info.placeholder ?? ""}
              submit="Validate and connect"
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests pass. If `PageProps<"/providers/connect/[provider]">` is reported as unknown, run `npx next typegen` once (Next generates route types) and rerun the typecheck.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/providers/connect/[provider]/page.tsx"
git commit -m "feat(providers): generic token connect page and connectToken action" -- "src/app/(app)/providers/token-form.tsx" "src/app/(app)/providers/actions.ts" "src/app/(app)/providers/connect/[provider]/page.tsx"
```

---

### Task 8: Replace-token form for every token provider

**Files:**
- Modify: `src/app/(app)/providers/[id]/page.tsx:10` (imports) and `:178-194` (credentials card)

- [ ] **Step 1: Import the adapter lookup** — `getAdapter` is already imported from the registry on line 10; nothing to add.

- [ ] **Step 2: Add the generic replace-token block.** In the Credentials card, directly after the closing `) : null}` of the `conn.provider === "supabase"` block and before the `conn.provider === "demo"` block, insert:

```tsx
            {conn.provider !== "supabase" && getAdapter(conn.provider)?.tokenConnect ? (
              <details open={conn.status === "reauth_required" || conn.status === "disconnected"}>
                <summary className="cursor-pointer text-sm font-medium">
                  Replace {getAdapter(conn.provider)!.tokenConnect!.tokenLabel.toLowerCase()}
                </summary>
                <div className="mt-3">
                  <TokenForm
                    action={replaceToken}
                    connectionId={conn.id}
                    tokenLabel={getAdapter(conn.provider)!.tokenConnect!.tokenLabel}
                    tokenHint={getAdapter(conn.provider)!.tokenConnect!.tokenHint ?? ""}
                    placeholder={getAdapter(conn.provider)!.tokenConnect!.placeholder ?? ""}
                    submit="Validate and replace"
                  />
                </div>
              </details>
            ) : null}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(providers): replace tokens on any token provider's connection page" -- "src/app/(app)/providers/[id]/page.tsx"
```

---

### Task 9: Verify in the app and against real accounts

**Files:** whichever adapter mapping the live responses prove wrong.

- [ ] **Step 1: Full checks**

Run: `npm run typecheck && npm test`
Expected: no type errors, all tests pass.

- [ ] **Step 2: Start the app** with the `cloudwatch` entry in `.claude/launch.json` (port 3100) via the browser preview tool, and sign in with the test user from `.env.local` (`TEST_USER_EMAIL` / `TEST_USER_PASSWORD`).

- [ ] **Step 3: Check the pages render**
  - `/providers`: Vercel, Cloudflare and Neon cards show "Available" with a Connect button.
  - `/providers/connect/vercel`, `/providers/connect/cloudflare`, `/providers/connect/neon`: steps, permission chips (Cloudflare only), warning (Vercel and Neon only), token form.
  - `/providers/connect/aws` and `/providers/connect/demo`: 404.
  - Submitting a fake token (e.g. `xxxxxxxxxxxx`) shows "The provider rejected these credentials…".
  - No console errors (`read_console_messages`).

- [ ] **Step 4: Live check with real tokens.** Ask the user to paste a real token for each provider into the connect form themselves (never type or log tokens). After each connection syncs:
  - The connection page lists the expected accounts and resources.
  - **Cloudflare:** if a dataset reports `invalid_response` with a GraphQL field error, fix the field names in `DATASETS` (the error message names the unknown field) and add a test case reproducing the corrected shape.
  - **Vercel (Pro team):** if billing metrics stay empty while the team has usage, have the server log the distinct `ServiceName` / `ConsumedUnit` pairs once (temporary `console.log` in `collect`, removed before committing), update `SERVICE_METRICS` / `toMetricUnits`, and add a test row for each corrected name. On Hobby, confirm deployments appear and billing metrics read "not available on Hobby".
  - **Neon:** confirm the four metrics appear per monitored project and the account plan reads `free` / `launch` / `scale`. If `plan` is missing from the organizations response, read it from the first project's `owner.subscription_type` instead (via `GET /projects/{id}`), with a test.

- [ ] **Step 5: Commit any mapping fixes**

```bash
git commit -m "fix(providers): align batch 1 mappings with live API responses" -- <the adapter and test files you changed>
```

- [ ] **Step 6: Update docs.** In `README.md`, change the sentence naming Supabase as the first real integration to list Supabase, Vercel, Cloudflare and Neon, and commit:

```bash
git commit -m "docs: list the batch 1 connectors" -- README.md
```
