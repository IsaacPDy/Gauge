"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { deleteCredentials } from "@/lib/jobs/credentials";
import { oauthConfigured, revokeTokens } from "@/lib/providers/supabase/oauth";
import { getSession } from "@/lib/session";
import { adminClient } from "@/lib/supabase/admin";
import { withParams } from "@/lib/urls";

const done = (ok: string) => redirect(withParams("/settings", { ok }));
const fail = (error: string) => redirect(withParams("/settings", { error }));

export async function updateProfile(form: FormData) {
  const { supabase, user } = await getSession();
  const name = z.string().trim().max(80).parse(form.get("displayName") ?? "");
  await supabase.from("profiles").update({ display_name: name || null }).eq("id", user.id);
  done("Profile saved.");
}

export async function updateWorkspace(form: FormData) {
  const { supabase, workspace } = await getSession();
  const parsed = z.string().trim().min(1).max(80).safeParse(form.get("name"));
  if (!parsed.success) fail("Workspace name must be 1–80 characters.");
  await supabase.from("workspaces").update({ name: parsed.data! }).eq("id", workspace.id);
  revalidatePath("/", "layout");
  done("Workspace renamed.");
}

export async function updateNotifications(form: FormData) {
  const { supabase, user, workspace } = await getSession();
  const parsed = z
    .object({
      notify_in_app: z.boolean(),
      notify_email: z.boolean(),
      email_min_severity: z.enum(["info", "warning", "critical", "limit_reached"]),
      alert_email: z.union([z.literal(""), z.email()]),
      stale_after_hours: z.coerce.number().int().min(1).max(720),
    })
    .safeParse({
      notify_in_app: form.get("notify_in_app") === "on",
      notify_email: form.get("notify_email") === "on",
      email_min_severity: form.get("email_min_severity"),
      alert_email: String(form.get("alert_email") ?? "").trim(),
      stale_after_hours: form.get("stale_after_hours"),
    });
  if (!parsed.success) fail("Check the notification settings: " + (parsed.error.issues[0]?.message ?? "invalid value"));
  const { error } = await supabase
    .from("workspaces")
    .update({ ...parsed.data!, alert_email: parsed.data!.alert_email || null })
    .eq("id", workspace.id);
  if (error) fail(error.message);
  await audit({ workspaceId: workspace.id, actorId: user.id, action: "settings.notifications" });
  done("Notification preferences saved.");
}

export async function changePassword(form: FormData) {
  const { supabase, user } = await getSession();
  const current = String(form.get("current") ?? "");
  const next = String(form.get("password") ?? "");
  if (next.length < 8) fail("The new password must have at least 8 characters.");
  if (next !== form.get("confirm")) fail("The new passwords do not match.");
  // Re-authenticate before changing a credential.
  const { error: authError } = await supabase.auth.signInWithPassword({ email: user.email!, password: current });
  if (authError) fail("Your current password is incorrect.");
  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) fail(error.message);
  await audit({ workspaceId: null, actorId: user.id, action: "auth.password_changed" });
  done("Password changed.");
}

/** Deletes the account, its workspace and all monitoring data, after revoking provider access. */
export async function deleteAccount(form: FormData) {
  const { supabase, user, workspace } = await getSession();
  if (String(form.get("confirm") ?? "").trim().toLowerCase() !== (user.email ?? "").toLowerCase()) {
    fail("Type your email address exactly to confirm deletion.");
  }
  const admin = adminClient();
  const { data: connections } = await admin.from("provider_connections").select("id").eq("workspace_id", workspace.id);
  for (const c of connections ?? []) {
    const creds = await deleteCredentials(admin, c.id);
    if (creds?.kind === "oauth" && oauthConfigured()) await revokeTokens(creds.refreshToken).catch(() => undefined);
  }
  await audit({ workspaceId: null, actorId: null, action: "account.deleted", details: { connectionsRevoked: connections?.length ?? 0 } });
  await supabase.auth.signOut();
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) fail(`Could not delete the account: ${error.message}`);
  redirect("/login?deleted=1");
}
