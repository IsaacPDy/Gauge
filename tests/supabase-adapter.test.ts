import { describe, expect, it } from "vitest";
import { supabaseAdapter, M } from "@/lib/providers/supabase/adapter";
import { requestJson } from "@/lib/providers/http";
import { ProviderError } from "@/lib/providers/types";
import { billingCycle } from "@/lib/engine/time";

const now = new Date("2026-10-09T12:00:00Z");
const cycle = billingCycle(now, 1);

function mockFetch(routes: Record<string, (body?: unknown) => [number, unknown]>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const route = Object.entries(routes).find(([k]) => (k.endsWith("*") ? key.startsWith(k.slice(0, -1)) : key === k));
    const [status, payload] = route ? route[1](body) : [404, { message: "not mocked" }];
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const ctx = (fetchImpl: typeof fetch) => ({ credentials: { kind: "token" as const, token: "sbp_test" }, now, fetch: fetchImpl });
const target = {
  since: new Date("2026-09-01T00:00:00Z"),
  accounts: [{ externalId: "org1", plan: "free", cycle }],
  resources: [{ externalId: "abcdefghijklmnopqrst", accountExternalId: "org1", providerStatus: "ACTIVE_HEALTHY", cycle }],
};

describe("supabase adapter", () => {
  it("discovers organizations with plans and projects", async () => {
    const f = mockFetch({
      "GET /v1/organizations": () => [200, [{ id: "org1", slug: "org1", name: "My Org" }]],
      "GET /v1/organizations/org1": () => [200, { id: "org1", name: "My Org", plan: "free" }],
      "GET /v1/projects": () => [200, [{ ref: "abcdefghijklmnopqrst", organization_slug: "org1", name: "app", region: "eu-west-1", status: "ACTIVE_HEALTHY" }]],
    });
    const d = await supabaseAdapter.discover(ctx(f));
    expect(d.accounts[0]).toMatchObject({ externalId: "org1", plan: "free" });
    expect(d.resources[0]).toMatchObject({ externalId: "abcdefghijklmnopqrst", accountExternalId: "org1", status: "active" });
  });

  it("collects metrics, keeps per-metric failures separate and never invents unsupported data", async () => {
    const f = mockFetch({
      "POST /v1/projects/abcdefghijklmnopqrst/database/query/read-only": (body) => {
        const q = (body as { query: string }).query;
        if (q.includes("pg_database_size")) return [201, [{ database_size: "1048576" }]];
        if (q.includes("storage.objects")) return [403, { message: "denied" }];
        return [201, [{ mau: 42 }]];
      },
      "GET /v1/projects/abcdefghijklmnopqrst/config/disk/util": () => [200, { timestamp: "2026-10-09T11:00:00", metrics: { fs_used_bytes: 2e9, fs_size_bytes: 8e9, fs_avail_bytes: 6e9 } }],
      "GET /v1/projects/abcdefghijklmnopqrst/analytics/endpoints/usage.api-counts": () => [
        200,
        {
          result: [
            { timestamp: "2026-10-07T10:00:00Z", total_rest_requests: 5, total_auth_requests: 0, total_storage_requests: 0, total_realtime_requests: 0 },
            { timestamp: "2026-10-08T10:00:00Z", total_rest_requests: 10, total_auth_requests: 2, total_storage_requests: 1, total_realtime_requests: 0 },
            { timestamp: "2026-10-09T09:00:00Z", total_rest_requests: 3, total_auth_requests: 0, total_storage_requests: 0, total_realtime_requests: 0 },
          ],
        },
      ],
      "GET /v1/projects/abcdefghijklmnopqrst/functions": () => [200, [{ id: "f1" }, { id: "f2" }]],
      "GET /v1/organizations/org1/entitlements": () => [
        200,
        { entitlements: [{ feature: { key: "function.max_count", type: "numeric" }, hasAccess: true, type: "numeric", config: { enabled: true, value: 100, unlimited: false, unit: "count" } }] },
      ],
    });
    const r = await supabaseAdapter.collect(ctx(f), target);
    const byKey = (k: string) => r.observations.filter((o) => o.metricKey === k);

    expect(byKey(M.databaseSize)[0].value).toBe(1048576);
    expect(byKey(M.mau)[0]).toMatchObject({ value: 42, source: "estimated" });
    expect(byKey(M.diskUsage)[0].value).toBe(2e9);
    expect(byKey(M.functionCount)[0].value).toBe(2);
    // Oldest (possibly truncated) day skipped; today flagged partial.
    expect(byKey(M.apiRequests).map((o) => [o.bucketStart.toISOString().slice(0, 10), o.value, o.quality])).toEqual([
      ["2026-10-08", 13, "ok"],
      ["2026-10-09", 3, "partial"],
    ]);
    expect(byKey(M.storageSize)).toHaveLength(0);
    expect(r.outcomes.find((o) => o.metricKey === M.storageSize)).toMatchObject({ status: "error", errorCode: "permission_denied" });
    expect(r.outcomes.find((o) => o.metricKey === M.egress)).toMatchObject({ status: "unsupported" });
    expect(r.quotas.map((q) => [q.metricKey, q.limit])).toEqual([
      [M.diskUsage, 8e9],
      [M.functionCount, 100],
    ]);
  });

  it("aborts the run on rejected credentials", async () => {
    const f = mockFetch({ "POST *": () => [401, { message: "invalid token" }], "GET *": () => [401, {}] });
    await expect(supabaseAdapter.collect(ctx(f), target)).rejects.toMatchObject({ code: "auth_invalid" });
  });

  it("reports paused projects as unavailable instead of zero", async () => {
    const r = await supabaseAdapter.collect(ctx(mockFetch({})), {
      ...target,
      resources: [{ ...target.resources[0], providerStatus: "INACTIVE" }],
    });
    expect(r.observations).toHaveLength(0);
    expect(r.outcomes.every((o) => o.status === "unavailable")).toBe(true);
  });
});

describe("http error normalization", () => {
  it("retries transient failures and honours Retry-After", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return calls < 3 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    await expect(requestJson("https://x.test", { fetch: f, backoffMs: 0 })).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("does not retry authentication errors", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response("no", { status: 401 });
    }) as typeof fetch;
    const err = (await requestJson("https://x.test", { fetch: f, backoffMs: 0 }).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("auth_invalid");
    expect(calls).toBe(1);
  });

  it("classifies rate limits with retry-after", async () => {
    const f = (async () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } })) as typeof fetch;
    const err = (await requestJson("https://x.test", { fetch: f, retries: 0 }).catch((e) => e)) as ProviderError;
    expect(err.code).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });
});
