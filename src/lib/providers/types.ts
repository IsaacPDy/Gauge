import type { Cycle } from "../engine/time";
import type { MetricDefinition, OverageEffect, PricingRule, ProviderId, Unit } from "../types";

// ---------------------------------------------------------------------------
// Errors: every adapter normalizes provider failures into these codes so the
// collector can decide between retrying, backing off and asking the user to act.
// ---------------------------------------------------------------------------

export type ProviderErrorCode =
  | "auth_invalid" // credentials rejected (revoked, wrong token)
  | "auth_expired" // OAuth token expired and could not be refreshed
  | "permission_denied" // authenticated but missing a scope / role
  | "not_found"
  | "rate_limited"
  | "provider_unavailable" // 5xx, maintenance
  | "network" // DNS, timeout, connection reset
  | "invalid_response" // unexpected payload shape
  | "unknown";

export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    message: string,
    public options: { retryable?: boolean; retryAfterMs?: number; status?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }
  get retryable() {
    return this.options.retryable ?? ["rate_limited", "provider_unavailable", "network"].includes(this.code);
  }
  /** Errors that make the whole connection unusable until the user acts. */
  get requiresUser() {
    return this.code === "auth_invalid" || this.code === "auth_expired" || this.code === "permission_denied";
  }
}

// ---------------------------------------------------------------------------
// Capabilities (PRD §9 "Integration Capability Model")
// ---------------------------------------------------------------------------

export type CapabilityLevel = "supported" | "partial" | "unsupported";

export interface Capability {
  level: CapabilityLevel;
  note?: string;
}

export interface Capabilities {
  accountDiscovery: Capability;
  resourceDiscovery: Capability;
  usageMetrics: Capability;
  quotaRetrieval: Capability;
  actualCost: Capability;
  forecastingInputs: Capability;
  billingCycleMetadata: Capability;
  accountControls: Capability;
}

export const CAPABILITY_LABELS: Record<keyof Capabilities, string> = {
  accountDiscovery: "Account discovery",
  resourceDiscovery: "Resource discovery",
  usageMetrics: "Resource usage metrics",
  quotaRetrieval: "Quota retrieval",
  actualCost: "Actual cost retrieval",
  forecastingInputs: "Forecasting inputs",
  billingCycleMetadata: "Billing-cycle metadata",
  accountControls: "Account-level controls",
};

// ---------------------------------------------------------------------------
// Credentials (decrypted form; only ever handled in server code)
// ---------------------------------------------------------------------------

export type DemoSimulation = "none" | "auth_expired" | "rate_limited" | "outage" | "permission";

export type Credentials =
  | { kind: "token"; token: string }
  | { kind: "oauth"; accessToken: string; refreshToken: string; expiresAt: string }
  | { kind: "demo"; simulate: DemoSimulation };

export interface AdapterContext {
  credentials: Credentials;
  now: Date;
  fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoveredAccount {
  externalId: string;
  name: string;
  accountType: "organization" | "billing_account" | "account";
  plan: string | null;
  billingCurrency: string | null;
  dashboardUrl: string | null;
  metadata?: Record<string, unknown>;
}

export interface DiscoveredResource {
  externalId: string;
  accountExternalId: string | null;
  name: string;
  resourceType: string;
  region: string | null;
  plan: string | null;
  providerStatus: string | null;
  status: "active" | "deleted";
  dashboardUrl: string | null;
  metadata?: Record<string, unknown>;
}

export interface Discovery {
  accounts: DiscoveredAccount[];
  resources: DiscoveredResource[];
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export type ScopeRef = { resourceExternalId: string } | { accountExternalId: string };

export interface CollectTarget {
  accounts: { externalId: string; plan: string | null; cycle: Cycle }[];
  /** Monitored resources only. */
  resources: { externalId: string; accountExternalId: string | null; providerStatus: string | null; cycle: Cycle }[];
  /** Earliest bucket worth (re)collecting; adapters may backfill history from here. */
  since: Date;
}

export interface Observation {
  metricKey: string;
  scope: ScopeRef;
  bucketStart: Date;
  bucketEnd: Date;
  value: number;
  observedAt: Date;
  quality: "ok" | "partial" | "estimated";
  source: "provider" | "derived" | "estimated" | "demo";
  dimensions?: Record<string, number>;
}

export type MetricOutcomeStatus = "ok" | "unsupported" | "unavailable" | "error";

export interface MetricOutcome {
  metricKey: string;
  scope: ScopeRef;
  status: MetricOutcomeStatus;
  errorCode?: ProviderErrorCode;
  detail?: string;
}

export interface ProviderQuota {
  metricKey: string;
  scope: ScopeRef;
  limit: number;
  unit: Unit;
  overageEffect: OverageEffect;
  notes?: string;
}

export interface ReportedCost {
  accountExternalId: string;
  periodStart: Date;
  periodEnd: Date;
  amount: number;
  currency: string;
}

export interface CollectResult {
  observations: Observation[];
  outcomes: MetricOutcome[];
  quotas: ProviderQuota[];
  costs: ReportedCost[];
}

// ---------------------------------------------------------------------------
// Plan allowance suggestions. These come from published documentation, not from an
// API, so they are only ever applied after the user confirms them.
// ---------------------------------------------------------------------------

export interface PlanAllowance {
  plan: string;
  metricKey: string;
  scope: "account" | "resource";
  limit: number;
  overageEffect: OverageEffect;
  note: string;
  sourceUrl: string;
  verifiedAt: string;
}

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

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  authMethods: ("oauth" | "token" | "demo")[];
  capabilities: Capabilities;
  metrics: MetricDefinition[];
  pricingRules: PricingRule[];
  planAllowances: PlanAllowance[];
  /** Recommended next action per metric, shown in alerts. */
  recommendations: Record<string, string>;
  /** Present when users can connect by pasting a token on the generic connect page. */
  tokenConnect?: TokenConnectInfo;
  /** Throws ProviderError when the credentials cannot be used. */
  validate(ctx: AdapterContext): Promise<{ identity: string; grantedScopes: string[] }>;
  discover(ctx: AdapterContext): Promise<Discovery>;
  /**
   * Per-metric failures are reported in `outcomes`; only connection-level failures
   * (authentication, provider outage) throw.
   */
  collect(ctx: AdapterContext, target: CollectTarget): Promise<CollectResult>;
}
