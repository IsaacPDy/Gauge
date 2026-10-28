import { and, asc, eq } from "drizzle-orm";
import { db } from "../client";
import type { Json } from "../json";
import { quota_evaluations, quota_rules } from "../schema";
import type { WorkspaceScope } from "../scope";

/** Quotas with their latest evaluation (null when not evaluated yet). */
export async function listQuotasWithEvaluations(s: WorkspaceScope) {
  const rows = await db
    .select({ quota: quota_rules, evaluation: quota_evaluations })
    .from(quota_rules)
    .leftJoin(quota_evaluations, eq(quota_evaluations.quota_rule_id, quota_rules.id))
    .where(eq(quota_rules.workspace_id, s.workspaceId))
    .orderBy(asc(quota_rules.created_at));
  return rows.map((r) => ({ ...r.quota, quota_evaluations: r.evaluation }));
}

export interface UserQuotaValues {
  limit_value: number;
  overage_effect: string;
  pricing_rule_id: string | null;
  thresholds?: Json | null;
  notes: string | null;
  plan_hint?: string | null;
  verified_at: string;
}

/**
 * Creates or updates the user's own quota for a scope. Only `source = 'user'` rows are ever
 * written or matched here: provider-reported quotas belong to the collector. Throws if the
 * account/resource is not in the workspace (composite foreign key).
 */
export async function saveUserQuota(
  s: WorkspaceScope,
  key: { metric_key: string; scope_type: "account" | "resource"; scopeId: string; unit: string },
  values: UserQuotaValues,
): Promise<void> {
  const scopeColumn = key.scope_type === "account" ? quota_rules.account_id : quota_rules.resource_id;
  const [existing] = await db
    .select({ id: quota_rules.id })
    .from(quota_rules)
    .where(
      and(
        eq(quota_rules.workspace_id, s.workspaceId),
        eq(quota_rules.metric_key, key.metric_key),
        eq(scopeColumn, key.scopeId),
        eq(quota_rules.source, "user"),
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(quota_rules)
      .set(values)
      .where(and(eq(quota_rules.id, existing.id), eq(quota_rules.workspace_id, s.workspaceId), eq(quota_rules.source, "user")));
    return;
  }
  await db.insert(quota_rules).values({
    ...values,
    workspace_id: s.workspaceId,
    metric_key: key.metric_key,
    scope_type: key.scope_type,
    account_id: key.scope_type === "account" ? key.scopeId : null,
    resource_id: key.scope_type === "resource" ? key.scopeId : null,
    unit: key.unit,
    source: "user",
    created_by: s.userId,
  });
}

export async function deleteUserQuota(s: WorkspaceScope, id: string): Promise<void> {
  await db
    .delete(quota_rules)
    .where(and(eq(quota_rules.id, id), eq(quota_rules.workspace_id, s.workspaceId), eq(quota_rules.source, "user")));
}
