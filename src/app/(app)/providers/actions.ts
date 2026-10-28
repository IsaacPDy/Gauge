"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { dbErrorMessage, friendlyDbError } from "@/db/errors";
import type { Json } from "@/db/json";
import * as applicationsRepo from "@/db/repos/applications";
import * as inventory from "@/db/repos/inventory";
import type { WorkspaceScope } from "@/db/scope";
import { audit, countRecentAudits } from "@/lib/audit";
import { deleteCredentials, saveCredentials } from "@/lib/jobs/credentials";
import { recalculateWorkspace } from "@/lib/jobs/recalc";
import { runConnectionSync } from "@/lib/jobs/sync";
import { demoEnabled, getAdapter } from "@/lib/providers/registry";
import { oauthConfigured, revokeTokens } from "@/lib/providers/supabase/oauth";
import { type Credentials, type DemoSimulation, ProviderError } from "@/lib/providers/types";
import { getSession } from "@/lib/session";
import { safeNext, withParams } from "@/lib/urls";

export type FormState = { error?: string } | undefined;

const uuid = z.uuid();

/** Confirms the signed-in user's workspace owns this connection. */
async function ownedConnection(connectionId: unknown) {
  const id = uuid.parse(connectionId);
  const session = await getSession();
  const connection = await inventory.getConnection(session.scope, id);
  if (!connection) throw new Error("Connection not found");
  return { ...session, connection };
}

function syncInBackground(connectionId: string, workspaceId: string, trigger: "manual" | "connect") {
  after(async () => {
    try {
      await runConnectionSync(connectionId, trigger);
      await recalculateWorkspace(workspaceId);
    } catch (e) {
      console.error("[sync] background sync failed:", dbErrorMessage(e));
    }
  });
}

function describeProviderError(e: unknown): string {
  if (!(e instanceof ProviderError)) return "Something went wrong while contacting the provider. Try again.";
  switch (e.code) {
    case "auth_invalid":
    case "auth_expired":
      return "The provider rejected these credentials. Check that the token is correct and has not been revoked.";
    case "permission_denied":
      return "The credentials are valid but lack the read permissions Limit Gauge needs.";
    case "rate_limited":
      return "The provider is rate limiting requests. Wait a minute and try again.";
    case "provider_unavailable":
    case "network":
      return "The provider could not be reached. Check its status page and try again.";
    default:
      return `Unexpected response from the provider (${e.code}).`;
  }
}

async function tooManyConnectionAttempts(workspaceId: string) {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  return (await countRecentAudits(workspaceId, ["connection.create", "connection.create_failed"], since)) >= 20;
}

async function createConnection(opts: {
  scope: WorkspaceScope;
  provider: "supabase" | "demo";
  label: string;
  authMethod: "token" | "demo" | "oauth";
  credentials: Credentials;
  grantedScopes: string[];
}) {
  const adapter = getAdapter(opts.provider)!;
  const conn = await inventory.insertConnection(opts.scope, {
    provider: opts.provider,
    label: opts.label,
    auth_method: opts.authMethod,
    status: "syncing",
    granted_scopes: opts.grantedScopes,
    capabilities: { declared: adapter.capabilities } as unknown as Json,
  });
  await saveCredentials(conn, opts.credentials);
  await audit({
    workspaceId: opts.scope.workspaceId,
    actorId: opts.scope.userId,
    action: "connection.create",
    targetType: "provider_connection",
    targetId: conn.id,
    details: { provider: opts.provider, authMethod: opts.authMethod },
  });
  // Discovery runs right away so the user can pick resources to monitor.
  await runConnectionSync(conn.id, "connect");
  await recalculateWorkspace(opts.scope.workspaceId);
  return conn.id;
}

const tokenForm = z.object({
  label: z.string().trim().min(1, "Give the connection a name").max(80),
  token: z.string().trim().min(10, "Paste a valid access token").max(500),
});

export async function connectSupabaseToken(_: FormState, form: FormData): Promise<FormState> {
  const { user, workspace, scope } = await getSession();
  const parsed = tokenForm.safeParse({ label: form.get("label"), token: form.get("token") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  if (await tooManyConnectionAttempts(workspace.id)) return { error: "Too many connection attempts. Try again in an hour." };

  const credentials: Credentials = { kind: "token", token: parsed.data.token };
  let grantedScopes: string[];
  try {
    ({ grantedScopes } = await getAdapter("supabase")!.validate({ credentials, now: new Date() }));
  } catch (e) {
    await audit({ workspaceId: workspace.id, actorId: user.id, action: "connection.create_failed", details: { provider: "supabase" } });
    return { error: describeProviderError(e) };
  }
  const id = await createConnection({
    scope,
    provider: "supabase",
    label: parsed.data.label,
    authMethod: "token",
    credentials,
    grantedScopes,
  });
  redirect(`/providers/${id}?setup=1`);
}

export async function connectDemo() {
  const { scope } = await getSession();
  if (!demoEnabled()) redirect(withParams("/providers", { error: "The Demo provider is disabled." }));
  const id = await createConnection({
    scope,
    provider: "demo",
    label: "Demo Cloud",
    authMethod: "demo",
    credentials: { kind: "demo", simulate: "none" },
    grantedScopes: ["demo:read"],
  });
  redirect(`/providers/${id}?setup=1`);
}

export async function replaceToken(_: FormState, form: FormData): Promise<FormState> {
  const { user, workspace, scope, connection } = await ownedConnection(form.get("connectionId"));
  const token = z.string().trim().min(10).max(500).safeParse(form.get("token"));
  if (!token.success) return { error: "Paste a valid access token." };
  const credentials: Credentials = { kind: "token", token: token.data };
  try {
    await getAdapter(connection.provider)!.validate({ credentials, now: new Date() });
  } catch (e) {
    return { error: describeProviderError(e) };
  }
  await saveCredentials(connection, credentials);
  await inventory.patchConnection(scope, connection.id, {
    auth_method: "token",
    status: "syncing",
    status_detail: null,
    status_changed_at: new Date().toISOString(),
    next_sync_at: new Date().toISOString(),
    consecutive_failures: 0,
    disconnected_at: null,
  });
  await audit({ workspaceId: workspace.id, actorId: user.id, action: "connection.credentials_rotated", targetType: "provider_connection", targetId: connection.id });
  syncInBackground(connection.id, workspace.id, "manual");
  redirect(withParams(`/providers/${connection.id}`, { ok: "Credentials replaced. Syncing now." }));
}

export async function syncNow(form: FormData) {
  const { scope, workspace, connection } = await ownedConnection(form.get("connectionId"));
  const back = `/providers/${connection.id}`;
  if (connection.status === "disconnected") redirect(withParams(back, { error: "Reconnect this provider before syncing." }));
  if (connection.last_manual_sync_at && Date.now() - Date.parse(connection.last_manual_sync_at) < 60_000) {
    redirect(withParams(back, { error: "Please wait a minute between manual syncs." }));
  }
  await inventory.patchConnection(scope, connection.id, { last_manual_sync_at: new Date().toISOString() });
  syncInBackground(connection.id, workspace.id, "manual");
  redirect(withParams(back, { ok: "Sync started." }));
}

/** Save which discovered resources are monitored (bulk form on the connection page). */
export async function saveMonitoring(form: FormData) {
  const { scope, workspace, connection } = await ownedConnection(form.get("connectionId"));
  const all = z.array(uuid).parse(form.getAll("ids"));
  const selected = new Set(z.array(uuid).parse(form.getAll("monitor")));
  const on = all.filter((id) => selected.has(id));
  const off = all.filter((id) => !selected.has(id));
  if (on.length) await inventory.setResourcesMonitored(scope, on, true, connection.id);
  if (off.length) await inventory.setResourcesMonitored(scope, off, false, connection.id);
  syncInBackground(connection.id, workspace.id, "manual");
  revalidatePath("/", "layout");
  redirect(withParams(`/providers/${connection.id}`, { ok: `Monitoring ${on.length} resource${on.length === 1 ? "" : "s"}. Collecting usage now.` }));
}

/** Toggle monitoring for resources from the all-resources list. */
export async function setMonitored(form: FormData) {
  const { scope, workspace } = await getSession();
  const ids = z.array(uuid).min(1).parse(form.getAll("ids"));
  const monitored = form.get("monitored") === "true";
  const connectionIds = await inventory.setResourcesMonitored(scope, ids, monitored);
  for (const connectionId of connectionIds) {
    if (monitored) syncInBackground(connectionId, workspace.id, "manual");
  }
  if (!monitored) after(() => recalculateWorkspace(workspace.id).then(() => undefined));
  revalidatePath("/", "layout");
  redirect(withParams(safeNext(form.get("back"), "/providers/resources"), { ok: monitored ? "Monitoring started." : "Monitoring stopped." }));
}

export async function assignResource(form: FormData) {
  const { scope, workspace } = await getSession();
  const resourceId = uuid.parse(form.get("resourceId"));
  const appId = form.get("applicationId");
  if (typeof appId === "string" && appId) {
    try {
      await applicationsRepo.assignResources(scope, uuid.parse(appId), [resourceId]);
    } catch (e) {
      console.error("[providers] could not assign resource:", dbErrorMessage(e));
      throw new Error(`Could not assign resource: ${friendlyDbError(e)}`);
    }
  } else {
    await applicationsRepo.unassignResource(scope, resourceId);
  }
  after(() => recalculateWorkspace(workspace.id).then(() => undefined));
  revalidatePath("/", "layout");
  redirect(safeNext(form.get("back"), "/providers/resources"));
}

export async function updateAccountCycle(form: FormData) {
  const { scope, workspace } = await getSession();
  const accountId = uuid.parse(form.get("accountId"));
  const day = z.coerce.number().int().min(1).max(28).parse(form.get("day"));
  const connectionId = await inventory.setAccountCycleDay(scope, accountId, day);
  if (!connectionId) throw new Error("Account not found");
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams(`/providers/${connectionId}`, { ok: `Billing cycle now resets on day ${day} of each month.` }));
}

export async function renameConnection(form: FormData) {
  const { scope, connection } = await ownedConnection(form.get("connectionId"));
  const label = z.string().trim().min(1).max(80).parse(form.get("label"));
  await inventory.patchConnection(scope, connection.id, { label });
  revalidatePath("/", "layout");
  redirect(withParams(`/providers/${connection.id}`, { ok: "Renamed." }));
}

/** Stops collection and revokes/deletes stored credentials. Historical data is kept. */
export async function disconnect(form: FormData) {
  const { user, workspace, scope, connection } = await ownedConnection(form.get("connectionId"));
  const creds = await deleteCredentials(connection.id);
  let revoked = false;
  if (creds?.kind === "oauth" && oauthConfigured()) {
    revoked = await revokeTokens(creds.refreshToken).then(
      () => true,
      () => false,
    );
  }
  await inventory.patchConnection(scope, connection.id, {
    status: "disconnected",
    status_detail: "Disconnected by user. Stored credentials were deleted.",
    status_changed_at: new Date().toISOString(),
    disconnected_at: new Date().toISOString(),
    next_sync_at: null,
    locked_until: null,
  });
  await audit({
    workspaceId: workspace.id,
    actorId: user.id,
    action: "connection.disconnect",
    targetType: "provider_connection",
    targetId: connection.id,
    details: { oauthRevoked: revoked },
  });
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  const note =
    connection.auth_method === "token"
      ? "Disconnected and deleted the stored token. Also revoke the token in your Supabase account settings."
      : "Disconnected and deleted the stored credentials.";
  redirect(withParams(`/providers/${connection.id}`, { ok: note }));
}

/** Deletes the connection with all discovered resources, usage history and quotas. */
export async function removeConnection(form: FormData) {
  const { user, workspace, scope, connection } = await ownedConnection(form.get("connectionId"));
  const creds = await deleteCredentials(connection.id);
  if (creds?.kind === "oauth" && oauthConfigured()) await revokeTokens(creds.refreshToken).catch(() => undefined);
  await inventory.deleteConnection(scope, connection.id);
  await audit({
    workspaceId: workspace.id,
    actorId: user.id,
    action: "connection.delete",
    targetType: "provider_connection",
    targetId: connection.id,
    details: { provider: connection.provider, label: connection.label },
  });
  await recalculateWorkspace(workspace.id);
  revalidatePath("/", "layout");
  redirect(withParams("/providers", { ok: `Removed “${connection.label}” and its data.` }));
}

export async function setDemoSimulation(form: FormData) {
  const { scope, workspace, connection } = await ownedConnection(form.get("connectionId"));
  if (connection.provider !== "demo") throw new Error("Only demo connections can simulate failures");
  const simulate = z.enum(["none", "auth_expired", "rate_limited", "outage", "permission"]).parse(form.get("simulate")) as DemoSimulation;
  await saveCredentials(connection, { kind: "demo", simulate });
  if (simulate === "none" && connection.status !== "connected") {
    await inventory.patchConnection(scope, connection.id, { next_sync_at: new Date().toISOString() });
  }
  syncInBackground(connection.id, workspace.id, "manual");
  redirect(withParams(`/providers/${connection.id}`, { ok: simulate === "none" ? "Simulation off. Syncing." : `Simulating “${simulate}”. Syncing now.` }));
}
