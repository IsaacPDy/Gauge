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
