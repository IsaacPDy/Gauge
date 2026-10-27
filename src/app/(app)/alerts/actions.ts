"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { normalizeThresholds } from "@/lib/engine/alerts";
import { recalculateWorkspace } from "@/lib/jobs/recalc";
import { getSession } from "@/lib/session";
import type { Json } from "@/lib/supabase/database.types";
import { safeNext, withParams } from "@/lib/urls";

const uuid = z.uuid();

async function loadAlert(form: FormData) {
  const session = await getSession();
  const id = uuid.parse(form.get("alertId"));
  const { data } = await session.supabase.from("alerts").select("*").eq("id", id).maybeSingle();
  if (!data) throw new Error("Alert not found");
  return { ...session, alert: data };
}

function back(form: FormData, fallback: string) {
  return safeNext(form.get("back"), fallback);
}

export async function acknowledgeAlert(form: FormData) {
  const { supabase, user, alert } = await loadAlert(form);
  if (alert.status === "open") {
    await supabase
      .from("alerts")
      .update({ status: "acknowledged", acknowledged_at: new Date().toISOString(), acknowledged_by: user.id })
      .eq("id", alert.id);
  }
  revalidatePath("/", "layout");
  redirect(withParams(back(form, "/alerts"), { ok: "Acknowledged. You will still be notified if it escalates." }));
}

export async function muteAlert(form: FormData) {
  const { supabase, alert } = await loadAlert(form);
  const duration = z.enum(["1d", "7d", "cycle"]).parse(form.get("duration"));
  const until =
    duration === "cycle" && alert.cycle_reset_at
      ? new Date(alert.cycle_reset_at)
      : new Date(Date.now() + (duration === "1d" ? 1 : duration === "7d" ? 7 : 30) * 86_400_000);
  await supabase.from("alerts").update({ status: "muted", muted_until: until.toISOString() }).eq("id", alert.id);
  revalidatePath("/", "layout");
  redirect(withParams(back(form, "/alerts"), { ok: `Muted until ${until.toUTCString().slice(0, 16)}. No notifications for this condition until then.` }));
}

export async function unmuteAlert(form: FormData) {
  const { supabase, alert } = await loadAlert(form);
  await supabase.from("alerts").update({ status: "open", muted_until: null }).eq("id", alert.id);
  revalidatePath("/", "layout");
  redirect(withParams(back(form, "/alerts"), { ok: "Unmuted." }));
}

export async function openNotification(form: FormData) {
  const { supabase } = await getSession();
  const deliveryId = uuid.parse(form.get("deliveryId"));
  const { data } = await supabase
    .from("notification_deliveries")
    .update({ read_at: new Date().toISOString() })
    .eq("id", deliveryId)
    .select("alert_id")
    .maybeSingle();
  revalidatePath("/", "layout");
  redirect(data ? `/alerts/${data.alert_id}` : "/alerts?tab=inbox");
}

export async function markAllRead() {
  const { supabase } = await getSession();
  await supabase.from("notification_deliveries").update({ read_at: new Date().toISOString() }).eq("channel", "in_app").is("read_at", null);
  revalidatePath("/", "layout");
  redirect(withParams("/alerts?tab=inbox", { ok: "All notifications marked as read." }));
}

const SEVERITIES = ["info", "warning", "critical", "limit_reached"] as const;

export async function saveAlertRules(form: FormData) {
  const { supabase, user, workspace } = await getSession();
  const { data: rules } = await supabase.from("alert_rules").select("*");
  for (const rule of rules ?? []) {
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
    const { error } = await supabase.from("alert_rules").update(patch).eq("id", rule.id);
    if (error) redirect(withParams("/alerts/rules", { error: error.message }));
  }
  await audit({ workspaceId: workspace.id, actorId: user.id, action: "alert_rules.update" });
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams("/alerts/rules", { ok: "Alert rules saved." }));
}
