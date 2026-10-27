import { adminClient } from "../supabase/admin";
import { allMetricDefinitions, allPricingRules } from "../providers/registry";

let synced: Promise<void> | null = null;

/**
 * Metric definitions and pricing rules are defined in code (versioned with the adapters)
 * and mirrored into the database so quotas, samples and costs can reference them.
 */
export function ensureReferenceData(): Promise<void> {
  synced ??= (async () => {
    const admin = adminClient();
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
      updated_at: new Date().toISOString(),
    }));
    const { error: mErr } = await admin.from("metric_definitions").upsert(metrics, { onConflict: "key" });
    if (mErr) throw new Error(`Syncing metric definitions failed: ${mErr.message}`);

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
      updated_at: new Date().toISOString(),
    }));
    const { error: pErr } = await admin.from("pricing_rules").upsert(rules, { onConflict: "id" });
    if (pErr) throw new Error(`Syncing pricing rules failed: ${pErr.message}`);
  })().catch((e) => {
    synced = null; // retry next time
    throw e;
  });
  return synced;
}
