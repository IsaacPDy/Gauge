import { formatCount } from "../../units";
import { overageCost, round2 } from "../cost";
import { type Catalog, type ComputeKey, computeSize, type PriceSheet, type Service, sheetFor } from "./catalog";
import type { ResolvedStack } from "./stack";
import type { MonthUsage } from "./workload";

export interface LineItem {
  service: Service;
  key: string;
  label: string;
  unit: string;
  usage: number;
  included: number;
  billable: number;
  /** USD, rounded to cents. Credits are negative. */
  cost: number;
  restricted: boolean;
  note?: string;
}

export function enabledPlans(stack: ResolvedStack): { service: Service; plan: string }[] {
  const plans: [Service, string | null][] = [
    ["supabase", stack.supabase],
    ["upstash", stack.cache ? "payg" : null],
    ["vercel", stack.vercel],
    ["cloudflare", stack.cloudflare],
  ];
  return plans.flatMap(([service, plan]) => (plan === null ? [] : [{ service, plan }]));
}

function usageFor(service: Service, u: MonthUsage, stack: ResolvedStack): Record<string, number> {
  switch (service) {
    case "supabase": {
      const files = stack.fileStore === "supabase";
      return {
        mau: u.mau,
        db_disk_gb: u.dbSizeGB,
        storage_gb: files ? u.storageGB : 0,
        egress_gb: u.supabaseEgressGB + (files ? u.fileEgressGB : 0),
        fn_invocations: u.fnInvocations,
        rt_peak: u.rtPeakConnections,
        rt_messages: u.rtMessages,
      };
    }
    case "upstash":
      return { commands: u.cacheCommands, storage_gb: u.cacheStorageGB };
    case "vercel": {
      const host = stack.host === "vercel";
      return {
        edge_requests: host ? u.requests : 0,
        fn_invocations: host ? u.serverRequests : 0,
        cpu_hours: host ? u.cpuMs / 3_600_000 : 0,
        transfer_gb: host ? u.hostEgressGB : 0,
      };
    }
    case "cloudflare": {
      const host = stack.host === "cloudflare";
      const r2 = stack.fileStore === "r2";
      return {
        requests: host ? u.serverRequests : 0,
        cpu_ms: host ? u.cpuMs : 0,
        r2_storage_gb: r2 ? u.storageGB : 0,
        r2_class_a: r2 ? u.fileWrites : 0,
        r2_class_b: r2 ? u.fileReads : 0,
      };
    }
  }
}

function fixed(service: Service, key: string, label: string, cost: number): LineItem {
  return { service, key, label, unit: "", usage: 1, included: 0, billable: 1, cost, restricted: false };
}

function priceSheet(sheet: PriceSheet, usage: Record<string, number>, compute: ComputeKey | null, seats: number, catalog: Catalog, u: MonthUsage): LineItem[] {
  const items: LineItem[] = [];
  if (sheet.baseFee > 0) {
    const label = sheet.perSeat ? `${sheet.label} plan (${seats} seat${seats === 1 ? "" : "s"})` : `${sheet.label} plan`;
    items.push(fixed(sheet.service, "base", label, round2(sheet.baseFee * (sheet.perSeat ? seats : 1))));
  }
  if (compute) {
    const size = computeSize(catalog, compute);
    items.push(fixed(sheet.service, "compute", `${size.label} compute`, size.monthlyPrice));
  }
  for (const item of sheet.items) {
    const used = usage[item.key] ?? 0;
    const billable = Math.max(0, used - item.includedQuantity);
    items.push({
      service: sheet.service,
      key: item.key,
      label: item.label,
      unit: item.unit,
      usage: used,
      included: item.includedQuantity,
      billable,
      cost: item.unitPrice === null ? 0 : overageCost(used, { ...item, unitPrice: item.unitPrice }),
      restricted: item.unitPrice === null && billable > 0,
      note: sheet.service === "upstash" && item.key === "storage_gb" ? `About ${formatCount(u.cacheKeys)} keys.` : item.note,
    });
  }
  if (sheet.credit) {
    const applies = new Set(sheet.credit.appliesTo);
    const eligible = items.filter((i) => applies.has(i.key)).reduce((s, i) => s + i.cost, 0);
    const credit = round2(Math.min(sheet.credit.amount, eligible));
    if (credit > 0) items.push(fixed(sheet.service, "credit", "Included usage credit", -credit));
  }
  return items;
}

/** Line items for one month. `compute` is the Supabase compute size, when Supabase is on. */
export function priceMonth(u: MonthUsage, stack: ResolvedStack, compute: ComputeKey | null, catalog: Catalog): LineItem[] {
  return enabledPlans(stack).flatMap(({ service, plan }) => {
    const sheet = sheetFor(catalog, service, plan);
    if (!sheet) throw new Error(`No price sheet for ${service} ${plan}`);
    return priceSheet(sheet, usageFor(service, u, stack), service === "supabase" ? compute : null, stack.seats, catalog, u);
  });
}
