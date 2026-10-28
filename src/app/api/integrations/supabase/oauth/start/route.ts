import { lt } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ensureUserWorkspace } from "@/db/bootstrap";
import { db } from "@/db/client";
import { getConnection } from "@/db/repos/inventory";
import { oauth_states } from "@/db/schema";
import { requireWorkspace } from "@/db/scope";
import { auth } from "@/lib/auth/server";
import { encryptSecret, pkceChallenge, randomToken } from "@/lib/crypto";
import { authorizeUrl, oauthConfigured } from "@/lib/providers/supabase/oauth";

export const dynamic = "force-dynamic";

/** Starts the Supabase OAuth flow (authorization code + PKCE, one-time state). */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const { data: session } = await auth.getSession();
  const user = session?.user;
  if (!user) return NextResponse.redirect(new URL("/login", origin));
  if (!oauthConfigured()) {
    return NextResponse.redirect(new URL("/providers/connect/supabase?error=OAuth+is+not+configured+on+this+server", origin));
  }

  const workspace = await ensureUserWorkspace({ id: user.id, email: user.email });
  const scope = await requireWorkspace(user.id, workspace.id);

  // Reauthorizing an existing connection: confirm it belongs to this workspace first.
  const connectionId = request.nextUrl.searchParams.get("connectionId");
  if (connectionId && (!z.uuid().safeParse(connectionId).success || !(await getConnection(scope, connectionId)))) {
    return NextResponse.redirect(new URL("/providers?error=Connection+not+found", origin));
  }

  const state = randomToken(32);
  const verifier = randomToken(48);
  await db.delete(oauth_states).where(lt(oauth_states.expires_at, new Date().toISOString()));
  try {
    await db.insert(oauth_states).values({
      state,
      workspace_id: workspace.id,
      user_id: user.id,
      provider: "supabase",
      code_verifier_ciphertext: encryptSecret(verifier, `oauth-state:${state}`),
      connection_id: connectionId,
    });
  } catch {
    return NextResponse.redirect(new URL("/providers?error=Could+not+start+authorization", origin));
  }

  return NextResponse.redirect(authorizeUrl(state, pkceChallenge(verifier)));
}
