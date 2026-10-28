import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import type { Json } from "@/db/json";
import { oauth_states, provider_connections } from "@/db/schema";
import { audit } from "@/lib/audit";
import { decryptSecret } from "@/lib/crypto";
import { saveCredentials } from "@/lib/jobs/credentials";
import { recalculateWorkspace } from "@/lib/jobs/recalc";
import { runConnectionSync } from "@/lib/jobs/sync";
import { getAdapter } from "@/lib/providers/registry";
import { SUPABASE_SCOPES } from "@/lib/providers/supabase/adapter";
import { exchangeCode } from "@/lib/providers/supabase/oauth";
import type { Credentials } from "@/lib/providers/types";
import { auth } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const fail = (msg: string) => NextResponse.redirect(new URL(`/providers/connect/supabase?error=${encodeURIComponent(msg)}`, origin));
  const params = request.nextUrl.searchParams;

  const { data: session } = await auth.getSession();
  const user = session?.user;
  if (!user) return NextResponse.redirect(new URL("/login", origin));

  if (params.get("error")) return fail("Authorization was cancelled or denied in Supabase.");
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return fail("The authorization response was incomplete.");

  // One-time state: delete it as we read it, then validate owner and expiry.
  const [saved] = await db.delete(oauth_states).where(eq(oauth_states.state, state)).returning();
  if (!saved || saved.user_id !== user.id || Date.parse(saved.expires_at) < Date.now()) {
    return fail("The authorization request expired or did not originate here. Please try again.");
  }

  let credentials: Credentials;
  try {
    const verifier = decryptSecret(saved.code_verifier_ciphertext, `oauth-state:${state}`);
    const tokens = await exchangeCode(code, verifier);
    credentials = { kind: "oauth", ...tokens };
    await getAdapter("supabase")!.validate({ credentials, now: new Date() });
  } catch {
    return fail("Supabase did not accept the authorization. Please try again.");
  }

  let connectionId = saved.connection_id;
  if (connectionId) {
    await saveCredentials({ id: connectionId, workspace_id: saved.workspace_id }, credentials);
    await db
      .update(provider_connections)
      .set({
        auth_method: "oauth",
        status: "syncing",
        status_detail: null,
        status_changed_at: new Date().toISOString(),
        granted_scopes: [...SUPABASE_SCOPES],
        next_sync_at: new Date().toISOString(),
        consecutive_failures: 0,
        disconnected_at: null,
      })
      .where(and(eq(provider_connections.id, connectionId), eq(provider_connections.workspace_id, saved.workspace_id)));
    await audit({ workspaceId: saved.workspace_id, actorId: user.id, action: "connection.reauthorize", targetType: "provider_connection", targetId: connectionId });
  } else {
    let conn: { id: string; workspace_id: string } | undefined;
    try {
      [conn] = await db
        .insert(provider_connections)
        .values({
          workspace_id: saved.workspace_id,
          provider: "supabase",
          label: "Supabase",
          auth_method: "oauth",
          granted_scopes: [...SUPABASE_SCOPES],
          capabilities: { declared: getAdapter("supabase")!.capabilities } as unknown as Json,
          created_by: user.id,
        })
        .returning({ id: provider_connections.id, workspace_id: provider_connections.workspace_id });
    } catch {
      return fail("Could not save the connection.");
    }
    if (!conn) return fail("Could not save the connection.");
    connectionId = conn.id;
    await saveCredentials(conn, credentials);
    await audit({
      workspaceId: saved.workspace_id,
      actorId: user.id,
      action: "connection.create",
      targetType: "provider_connection",
      targetId: conn.id,
      details: { provider: "supabase", authMethod: "oauth" },
    });
  }

  await runConnectionSync(connectionId, "connect");
  await recalculateWorkspace(saved.workspace_id);
  return NextResponse.redirect(new URL(`/providers/${connectionId}?setup=1`, origin));
}
