"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { dbErrorMessage } from "@/db/errors";
import type { Json } from "@/db/json";
import * as inventory from "@/db/repos/inventory";
import * as quotasRepo from "@/db/repos/quotas";
import { audit } from "@/lib/audit";
import { normalizeThresholds } from "@/lib/engine/alerts";
import { recalculateWorkspace } from "@/lib/jobs/recalc";
import { ensureReferenceData } from "@/lib/jobs/reference";
import { findPricingRule, getAdapter, getMetric } from "@/lib/providers/registry";
import { getSession } from "@/lib/session";
import { SEVERITY_RANK, type Severity } from "@/lib/types";
import { parseQuantity } from "@/lib/units";
import { safeNext, withParams } from "@/lib/urls";

export type QuotaFormState = { error?: string } | undefined;

const uuid = z.uuid();
const effect = z.enum(["charges", "restriction", "both", "none", "unknown"]);

/** "75:warning, 90:critical" → thresholds. Empty means "use the workspace defaults". */
function parseThresholds(input: string): Json | null | "invalid" {
  const s = input.trim();
  if (!s) return null;
  const items = s.split(/[,;\s]+/).filter(Boolean).map((part) => {
    const [p, sev] = part.split(":");
    return { percent: Number(p), severity: (sev ?? "warning").trim() as Severity };
  });
  if (items.some((i) => !Number.isFinite(i.percent) || !(i.severity in SEVERITY_RANK))) return "invalid";
  const normalized = normalizeThresholds(items);
  return normalized ? (normalized as unknown as Json) : "invalid";
}

export async function saveQuota(_: QuotaFormState, form: FormData): Promise<QuotaFormState> {
  const { scope, user, workspace } = await getSession();
  await ensureReferenceData();
  const metricKey = String(form.get("metricKey") ?? "");
  const metric = getMetric(metricKey);
  if (!metric) return { error: "Unknown metric." };
  const scopeType = z.enum(["account", "resource"]).parse(form.get("scopeType"));
  const scopeId = uuid.parse(form.get("scopeId"));
  const limit = parseQuantity(String(form.get("limit") ?? ""), metric.unit);
  if (limit === null) return { error: metric.unit === "bytes" ? "Enter a size such as 500 MB or 8 GB." : "Enter a number such as 50000 or 100k." };
  const overage = effect.safeParse(form.get("overageEffect"));
  if (!overage.success) return { error: "Choose what happens when the limit is exceeded." };
  const thresholds = parseThresholds(String(form.get("thresholds") ?? ""));
  if (thresholds === "invalid") return { error: "Thresholds look like 75:warning, 90:critical, 100:limit_reached." };
  const notes = String(form.get("notes") ?? "").trim().slice(0, 500) || null;

  const ctx = await inventory.getScopePlan(scope, scopeType, scopeId);
  if (!ctx) return { error: "That resource or account no longer exists." };
  const pricing = overage.data === "charges" || overage.data === "both" ? findPricingRule(metricKey, ctx.plan) : null;

  const row = {
    limit_value: limit,
    overage_effect: overage.data,
    thresholds,
    notes,
    pricing_rule_id: pricing?.id ?? null,
    verified_at: new Date().toISOString(),
  };
  try {
    await quotasRepo.saveUserQuota(scope, { metric_key: metricKey, scope_type: scopeType, scopeId, unit: metric.unit }, row);
  } catch (e) {
    return { error: `Could not save the limit: ${dbErrorMessage(e)}` };
  }

  await audit({ workspaceId: workspace.id, actorId: user.id, action: "quota.save", targetType: "quota_rule", details: { metricKey, scopeType, scopeId, limit } });
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams(safeNext(form.get("back"), "/usage/quotas"), { ok: "Limit saved." }));
}

export async function deleteQuota(form: FormData) {
  const { scope, user, workspace } = await getSession();
  const id = uuid.parse(form.get("quotaId"));
  await quotasRepo.deleteUserQuota(scope, id);
  await audit({ workspaceId: workspace.id, actorId: user.id, action: "quota.delete", targetType: "quota_rule", targetId: id });
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams(safeNext(form.get("back"), "/usage/quotas"), { ok: "Your limit was removed." }));
}

/** Confirm a documented plan allowance. Stored as a user-configured limit that cites its source. */
export async function applyPlanAllowance(form: FormData) {
  const { scope, user, workspace } = await getSession();
  await ensureReferenceData();
  const provider = String(form.get("provider"));
  const plan = String(form.get("plan"));
  const metricKey = String(form.get("metricKey"));
  const scopeType = z.enum(["account", "resource"]).parse(form.get("scopeType"));
  const scopeIds = z.array(uuid).min(1).parse(form.getAll("scopeId"));
  const allowance = getAdapter(provider)?.planAllowances.find((a) => a.plan === plan && a.metricKey === metricKey && a.scope === scopeType);
  if (!allowance) throw new Error("Unknown plan allowance");
  const metric = getMetric(metricKey)!;
  const pricing = allowance.overageEffect === "charges" || allowance.overageEffect === "both" ? findPricingRule(metricKey, plan) : null;

  let failure: string | null = null;
  for (const scopeId of scopeIds) {
    try {
      await quotasRepo.saveUserQuota(
        scope,
        { metric_key: metricKey, scope_type: scopeType, scopeId, unit: metric.unit },
        {
          limit_value: allowance.limit,
          overage_effect: allowance.overageEffect,
          pricing_rule_id: pricing?.id ?? null,
          plan_hint: plan,
          notes: `${allowance.note} Source: ${allowance.sourceUrl} (verified ${allowance.verifiedAt}).`,
          verified_at: new Date().toISOString(),
        },
      );
    } catch (e) {
      failure ??= dbErrorMessage(e);
    }
  }
  if (failure) throw new Error(`Could not apply allowance: ${failure}`);
  await audit({ workspaceId: workspace.id, actorId: user.id, action: "quota.apply_plan_allowance", details: { provider, plan, metricKey, count: scopeIds.length } });
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams(safeNext(form.get("back"), "/usage/quotas"), { ok: `Applied the ${plan} plan allowance for ${metric.name}.` }));
}
