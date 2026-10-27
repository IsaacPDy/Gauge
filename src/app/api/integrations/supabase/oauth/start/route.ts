import { NextResponse, type NextRequest } from "next/server";
import { encryptSecret, pkceChallenge, randomToken } from "@/lib/crypto";
import { authorizeUrl, oauthConfigured } from "@/lib/providers/supabase/oauth";
import { adminClient } from "@/lib/supabase/admin";
import { createUserClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Starts the Supabase OAuth flow (authorization code + PKCE, one-time state). */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", origin));
  if (!oauthConfigured()) {
    return NextResponse.redirect(new URL("/providers/connect/supabase?error=OAuth+is+not+configured+on+this+server", origin));
  }

  const { data: workspace } = await supabase.from("workspaces").select("id").order("created_at").limit(1).maybeSingle();
  if (!workspace) return NextResponse.redirect(new URL("/providers?error=Workspace+not+found", origin));

  // Reauthorizing an existing connection: confirm ownership through RLS first.
  const connectionId = request.nextUrl.searchParams.get("connectionId");
  if (connectionId) {
    const { data: conn } = await supabase.from("provider_connections").select("id").eq("id", connectionId).maybeSingle();
    if (!conn) return NextResponse.redirect(new URL("/providers?error=Connection+not+found", origin));
  }

  const state = randomToken(32);
  const verifier = randomToken(48);
  const admin = adminClient();
  await admin.from("oauth_states").delete().lt("expires_at", new Date().toISOString());
  const { error } = await admin.from("oauth_states").insert({
    state,
    workspace_id: workspace.id,
    user_id: user.id,
    provider: "supabase",
    code_verifier_ciphertext: encryptSecret(verifier, `oauth-state:${state}`),
    connection_id: connectionId,
  });
  if (error) return NextResponse.redirect(new URL("/providers?error=Could+not+start+authorization", origin));

  return NextResponse.redirect(authorizeUrl(state, pkceChallenge(verifier)));
}
