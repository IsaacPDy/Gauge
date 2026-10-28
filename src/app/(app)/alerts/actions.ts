"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { dbErrorMessage } from "@/db/errors";
import type { Json } from "@/db/json";
import * as alertsRepo from "@/db/repos/alerts";
import { audit } from "@/lib/audit";
import { normalizeThresholds } from "@/lib/engine/alerts";
import { recalculateWorkspace } from "@/lib/jobs/recalc";
import { getSession } from "@/lib/session";
import { safeNext, withParams } from "@/lib/urls";

const uuid = z.uuid();

async function loadAlert(form: FormData) {
  const session = await getSession();
  const id = uuid.parse(form.get("alertId"));
  const alert = await alertsRepo.getAlert(session.scope, id);
  if (!alert) throw new Error("Alert not found");
  return { ...session, alert };
}

function back(form: FormData, fallback: string) {
  return safeNext(form.get("back"), fallback);
}

export async function acknowledgeAlert(form: FormData) {
  const { scope, alert } = await loadAlert(form);
  if (alert.status === "open") {
    await alertsRepo.acknowledgeAlert(scope, alert.id);
  }
  revalidatePath("/", "layout");
  redirect(withParams(back(form, "/alerts"), { ok: "Acknowledged. You will still be notified if it escalates." }));
}

export async function muteAlert(form: FormData) {
  const { scope, alert } = await loadAlert(form);
  const duration = z.enum(["1d", "7d", "cycle"]).parse(form.get("duration"));
  const until =
    duration === "cycle" && alert.cycle_reset_at
      ? new Date(alert.cycle_reset_at)
      : new Date(Date.now() + (duration === "1d" ? 1 : duration === "7d" ? 7 : 30) * 86_400_000);
  await alertsRepo.muteAlert(scope, alert.id, until.toISOString());
  revalidatePath("/", "layout");
  redirect(withParams(back(form, "/alerts"), { ok: `Muted until ${until.toUTCString().slice(0, 16)}. No notifications for this condition until then.` }));
}

export async function unmuteAlert(form: FormData) {
  const { scope, alert } = await loadAlert(form);
  await alertsRepo.unmuteAlert(scope, alert.id);
  revalidatePath("/", "layout");
  redirect(withParams(back(form, "/alerts"), { ok: "Unmuted." }));
}

export async function openNotification(form: FormData) {
  const { scope } = await getSession();
  const deliveryId = uuid.parse(form.get("deliveryId"));
  const alertId = await alertsRepo.markDeliveryRead(scope, deliveryId);
  revalidatePath("/", "layout");
  redirect(alertId ? `/alerts/${alertId}` : "/alerts?tab=inbox");
}

export async function markAllRead() {
  const { scope } = await getSession();
  await alertsRepo.markAllInAppRead(scope);
  revalidatePath("/", "layout");
  redirect(withParams("/alerts?tab=inbox", { ok: "All notifications marked as read." }));
}

const SEVERITIES = ["info", "warning", "critical", "limit_reached"] as const;

export async function saveAlertRules(form: FormData) {
  const { scope, user, workspace } = await getSession();
  const rules = await alertsRepo.listAlertRules(scope);
  let failure: string | null = null;
  for (const rule of rules) {
    const patch: { enabled: boolean; notify_in_app: boolean; notify_email: boolean; thresholds?: Json } = {
      enabled: form.get(`${rule.category}.enabled`) === "on",
      notify_in_app: form.get(`${rule.category}.in_app`) === "on",
      notify_email: form.get(`${rule.category}.email`) === "on",
    };
    if (rule.category === "quota_threshold") {
      const percents = form.getAll("threshold.percent").map(Number);
      const severities = form.getAll("threshold.severity").map(String);
      const list = percents
        .map((p, i) => ({ percent: p, severity: severities[i] }))
        .filter((t) => Number.isFinite(t.percent) && t.percent > 0 && (SEVERITIES as readonly string[]).includes(t.severity));
      const normalized = normalizeThresholds(list);
      if (!normalized) redirect(withParams("/alerts/rules", { error: "Add at least one threshold between 1% and 1000%." }));
      patch.thresholds = normalized as unknown as Json;
    }
    try {
      await alertsRepo.updateAlertRule(scope, rule.id, patch);
    } catch (e) {
      failure = dbErrorMessage(e);
      break;
    }
  }
  if (failure) redirect(withParams("/alerts/rules", { error: failure }));
  await audit({ workspaceId: workspace.id, actorId: user.id, action: "alert_rules.update" });
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams("/alerts/rules", { ok: "Alert rules saved." }));
}
