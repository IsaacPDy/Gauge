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
