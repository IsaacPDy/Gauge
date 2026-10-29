import { describe, expect, it } from "vitest";
import { workloadMonths } from "@/lib/engine/simulate/workload";
import { inputsWith, stackWith } from "./fixtures";

describe("workloadMonths", () => {
  it("derives month 1 usage from the Small SaaS preset with a cache", () => {
    const [m1] = workloadMonths(inputsWith(), stackWith(), true, 1);
    expect(m1.mau).toBe(10_000);
    expect(m1.dau).toBe(2_500);
    expect(m1.requests).toBe(6_000_000);
    expect(m1.dbQueries).toBe(18_000_000);
    expect(m1.reads).toBeCloseTo(14_400_000);
    expect(m1.writes).toBeCloseTo(3_600_000);
    expect(m1.cacheHits).toBeCloseTo(11_520_000);
    expect(m1.dbHits).toBeCloseTo(6_480_000);
    expect(m1.avgDbQps).toBeCloseTo(2.5);
    expect(m1.peakDbQps).toBeCloseTo(10);
    expect(m1.peakConnections).toBeCloseTo(0.05);
    expect(m1.apiEgressGB).toBeCloseTo(60);
    expect(m1.hostEgressGB).toBeCloseTo(60);
    expect(m1.backendEgressGB).toBeCloseTo(21.6);
    expect(m1.fileEgressGB).toBeCloseTo(300);
    expect(m1.dbSizeGB).toBeCloseTo(2);
    expect(m1.storageGB).toBeCloseTo(200);
    expect(m1.storageAddedGB).toBeCloseTo(200);
    expect(m1.fnInvocations).toBeCloseTo(300_000);
    expect(m1.rtPeakConnections).toBeCloseTo(41.667, 2);
    expect(m1.rtMessages).toBeCloseTo(375_000);
    expect(m1.serverRequests).toBe(6_000_000);
    expect(m1.cpuMs).toBeCloseTo(120_000_000);
    expect(m1.cacheCommands).toBeCloseTo(20_880_000);
    expect(m1.cacheStorageGB).toBeCloseTo(0.2);
    expect(m1.cacheKeys).toBeCloseTo(100_000);
    expect(m1.fileWrites).toBeCloseTo(400_000);
    expect(m1.fileReads).toBeCloseTo(600_000);
  });

  it("has no cache traffic when the cache is off", () => {
    const [m1] = workloadMonths(inputsWith(), stackWith(), false, 1);
    expect(m1.cacheHits).toBe(0);
    expect(m1.dbHits).toBe(m1.dbQueries);
    expect(m1.cacheCommands).toBe(0);
    expect(m1.cacheStorageGB).toBe(0);
    expect(m1.backendEgressGB).toBeCloseTo(60);
  });

  it("compounds growth and accumulates stored data", () => {
    const months = workloadMonths(inputsWith(), stackWith(), false, 2);
    expect(months[1].month).toBe(2);
    expect(months[1].mau).toBeCloseTo(10_800);
    expect(months[1].dbSizeGB).toBeCloseTo(2.16);
    expect(months[1].storageAddedGB).toBeCloseTo(16);
  });

  it("never shrinks stored data when MAU falls", () => {
    const months = workloadMonths(inputsWith({ mau: 1_000, growthPct: -50 }), stackWith(), false, 2);
    expect(months[1].mau).toBe(500);
    expect(months[1].dbSizeGB).toBeCloseTo(months[0].dbSizeGB);
    expect(months[1].storageAddedGB).toBe(0);
  });

  it("uses the DB queries override and grows it", () => {
    const months = workloadMonths(inputsWith({ dbQueriesOverride: 1_000_000, growthPct: 10 }), stackWith(), false, 2);
    expect(months[0].dbQueries).toBe(1_000_000);
    expect(months[1].dbQueries).toBeCloseTo(1_100_000);
  });

  it("bills all API egress to Supabase when the client calls it directly", () => {
    const inputs = inputsWith({ host: "direct" });
    const [m1] = workloadMonths(inputs, stackWith({ host: "direct" }), false, 1);
    expect(m1.backendEgressGB).toBeCloseTo(60);
    expect(m1.hostEgressGB).toBe(0);
    expect(m1.serverRequests).toBe(0);
    expect(m1.cpuMs).toBe(0);
  });

  it("has no cache traffic behind a direct host even when asked", () => {
    const [m1] = workloadMonths(inputsWith({ host: "direct" }), stackWith({ host: "direct" }), true, 1);
    expect(m1.cacheHits).toBe(0);
    expect(m1.cacheCommands).toBe(0);
  });

  it("returns zero egress share, never NaN, without DB queries", () => {
    const [m1] = workloadMonths(inputsWith({ queriesPerRequest: 0 }), stackWith(), false, 1);
    expect(m1.backendEgressGB).toBe(0);
  });
});
