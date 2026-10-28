"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { deleteUserData } from "@/db/bootstrap";
import { dbErrorMessage } from "@/db/errors";
import * as account from "@/db/repos/account";
import { listConnections } from "@/db/repos/inventory";
import { audit } from "@/lib/audit";
import { auth } from "@/lib/auth/server";
import { clearAuthCookies } from "@/lib/auth/cookies";
import { passwordChangeMessage } from "@/lib/auth/messages";
import { deleteCredentials } from "@/lib/jobs/credentials";
import { oauthConfigured, revokeTokens } from "@/lib/providers/supabase/oauth";
import { getSession } from "@/lib/session";
import { withParams } from "@/lib/urls";

const done = (ok: string) => redirect(withParams("/settings", { ok }));
const fail = (error: string) => redirect(withParams("/settings", { error }));

export async function updateProfile(form: FormData) {
  const { scope } = await getSession();
  const name = z.string().trim().max(80).parse(form.get("displayName") ?? "");
  await account.setDisplayName(scope, name || null);
  done("Profile saved.");
}

export async function updateWorkspace(form: FormData) {
  const { scope } = await getSession();
  const parsed = z.string().trim().min(1).max(80).safeParse(form.get("name"));
  if (!parsed.success) fail("Workspace name must be 1–80 characters.");
  await account.updateWorkspace(scope, { name: parsed.data! });
  revalidatePath("/", "layout");
  done("Workspace renamed.");
}

export async function updateNotifications(form: FormData) {
  const { scope, user, workspace } = await getSession();
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
  let failure: string | null = null;
  try {
    await account.updateWorkspace(scope, { ...parsed.data!, alert_email: parsed.data!.alert_email || null });
  } catch (e) {
    failure = dbErrorMessage(e);
  }
  if (failure) fail(failure); // outside the try: redirect() works by throwing
  await audit({ workspaceId: workspace.id, actorId: user.id, action: "settings.notifications" });
  done("Notification preferences saved.");
}

export async function changePassword(form: FormData) {
  const { user } = await getSession();
  const current = String(form.get("current") ?? "");
  const next = String(form.get("password") ?? "");
  if (next.length < 8) fail("The new password must have at least 8 characters.");
  if (next !== form.get("confirm")) fail("The new passwords do not match.");
  // Neon Auth checks the current password itself before changing a credential.
  const { error } = await auth.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
  if (error) fail(passwordChangeMessage(error));
  await audit({ workspaceId: null, actorId: user.id, action: "auth.password_changed" });
  done("Password changed.");
}

/** Deletes the account, its workspace and all monitoring data, after revoking provider access. */
export async function deleteAccount(form: FormData) {
  const { user, scope } = await getSession();
  if (String(form.get("confirm") ?? "").trim().toLowerCase() !== (user.email ?? "").toLowerCase()) {
    fail("Type your email address exactly to confirm deletion.");
  }
  const connections = await listConnections(scope);
  for (const c of connections) {
    const creds = await deleteCredentials(c.id);
    if (creds?.kind === "oauth" && oauthConfigured()) await revokeTokens(creds.refreshToken).catch(() => undefined);
  }
  await audit({ workspaceId: null, actorId: null, action: "account.deleted", details: { connectionsRevoked: connections.length } });
  // Delete the login first: if Neon refuses, nothing of the user's data has been removed yet.
  const { data, error } = await auth.deleteUser();
  if (error) fail(`Could not delete the account: ${error.message ?? "unknown error"}`);
  if (data?.success === false) fail("Could not delete the account.");
  // The SDK trusts its cached session cookie for up to 5 minutes; drop it so the deleted account
  // cannot be "resurrected" by ensureUserWorkspace() on the next request.
  await clearAuthCookies();
  // The login is already gone, so a failure here must not become an error page: the user can no
  // longer sign in to retry. Any data left behind is orphaned and would need a cleanup job.
  try {
    await deleteUserData(user.id);
  } catch (e) {
    console.error("[account] data cleanup failed after login deletion:", dbErrorMessage(e), user.id);
  }
  redirect("/login?deleted=1");
}
