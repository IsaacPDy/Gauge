import { db } from "../../db/client";
import { metric_definitions, pricing_rules } from "../../db/schema";
import { excludedFrom } from "../../db/sql";
import { allMetricDefinitions, allPricingRules } from "../providers/registry";

let synced: Promise<void> | null = null;

/**
 * Metric definitions and pricing rules are defined in code (versioned with the adapters)
 * and mirrored into the database so quotas, samples and costs can reference them.
 */
export function ensureReferenceData(): Promise<void> {
  synced ??= (async () => {
    const updated_at = new Date().toISOString();
    const metrics = allMetricDefinitions().map((m) => ({
      key: m.key,
      provider: m.provider,
      name: m.name,
      description: m.description,
      unit: m.unit,
      aggregation: m.aggregation,
      scope_level: m.scopeLevel,
      derivation: m.derivation,
      supported: m.supported,
      unsupported_reason: m.unsupportedReason ?? null,
      updated_at,
    }));
    if (metrics.length) {
      await db
        .insert(metric_definitions)
        .values(metrics)
        .onConflictDoUpdate({ target: metric_definitions.key, set: excludedFrom(metric_definitions, metrics[0], ["key"]) });
    }

    const rules = allPricingRules().map((r) => ({
      id: r.id,
      provider: r.provider,
      metric_key: r.metricKey,
      plan: r.plan,
      version: r.version,
      currency: r.currency,
      included_quantity: r.includedQuantity,
      unit_price: r.unitPrice,
      unit_size: r.unitSize,
      billing_mode: r.billingMode,
      source_url: r.sourceUrl ?? null,
      verified_at: r.verifiedAt,
      notes: r.notes ?? null,
      updated_at,
    }));
    if (rules.length) {
      await db
        .insert(pricing_rules)
        .values(rules)
        .onConflictDoUpdate({ target: pricing_rules.id, set: excludedFrom(pricing_rules, rules[0], ["id"]) });
    }
  })().catch((e) => {
    synced = null; // retry next time
    throw e;
  });
  return synced;
}
