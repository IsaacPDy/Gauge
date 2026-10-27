// Shared domain vocabulary. Kept free of runtime dependencies so it can be imported by
// the Next.js app, the background worker and unit tests alike.

export type ProviderId = "supabase" | "cloudflare" | "firebase" | "aws" | "demo";

/**
 * How a metric's values combine over time.
 * - gauge:       instantaneous measurement (database size). Latest value wins.
 * - cumulative:  running total since the billing cycle started (MAU so far). Latest value
 *                within the cycle is the cycle-to-date usage.
 * - incremental: usage that happened during the bucket (requests on a given day). Buckets
 *                within the cycle are summed.
 */
export type Aggregation = "gauge" | "cumulative" | "incremental";

export type ScopeLevel = "account" | "resource";

/** How trustworthy the number is, shown next to every metric. */
export type Derivation = "reported" | "derived" | "estimated";

export type Unit = "bytes" | "count";

export type OverageEffect = "charges" | "restriction" | "both" | "none" | "unknown";

export type Severity = "info" | "warning" | "critical" | "limit_reached";

export const SEVERITY_RANK: Record<Severity, number> = {
  info: 1,
  warning: 2,
  critical: 3,
  limit_reached: 4,
};

export type AlertCategory = "quota_threshold" | "forecast_breach" | "cost_overage" | "integration_health";

export type ConnectionStatus =
  | "connected"
  | "syncing"
  | "reauth_required"
  | "permission_insufficient"
  | "unsupported_capability"
  | "error"
  | "disconnected";

export interface Threshold {
  percent: number;
  severity: Severity;
}

export const DEFAULT_THRESHOLDS: Threshold[] = [
  { percent: 50, severity: "info" },
  { percent: 75, severity: "warning" },
  { percent: 90, severity: "critical" },
  { percent: 100, severity: "limit_reached" },
];

export interface MetricDefinition {
  key: string;
  provider: ProviderId;
  name: string;
  description: string;
  unit: Unit;
  aggregation: Aggregation;
  /** Where the provider measures the value (we always collect per resource or per account). */
  scopeLevel: ScopeLevel;
  derivation: Derivation;
  supported: boolean;
  unsupportedReason?: string;
}

export interface PricingRule {
  id: string;
  provider: ProviderId;
  metricKey: string;
  plan: string;
  version: string;
  currency: string;
  includedQuantity: number;
  /** Price per `unitSize` units of the metric's unit. */
  unitPrice: number;
  unitSize: number;
  billingMode: "per_unit" | "package";
  sourceUrl?: string;
  verifiedAt: string; // YYYY-MM-DD
  notes?: string;
}
