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
