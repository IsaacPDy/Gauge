import { decryptSecret, encryptSecret } from "../crypto";
import { refreshTokens } from "../providers/supabase/oauth";
import { type Credentials, ProviderError } from "../providers/types";
import type { AdminClient } from "../supabase/admin";

export async function saveCredentials(
  admin: AdminClient,
  connection: { id: string; workspace_id: string },
  credentials: Credentials,
): Promise<void> {
  const { error } = await admin.from("provider_credentials").upsert(
    {
      connection_id: connection.id,
      workspace_id: connection.workspace_id,
      ciphertext: encryptSecret(JSON.stringify(credentials), connection.id),
      key_version: 1,
      expires_at: credentials.kind === "oauth" ? credentials.expiresAt : null,
    },
    { onConflict: "connection_id" },
  );
  if (error) throw new Error(`Storing credentials failed: ${error.message}`);
}

export async function deleteCredentials(admin: AdminClient, connectionId: string): Promise<Credentials | null> {
  const existing = await readCredentials(admin, connectionId).catch(() => null);
  await admin.from("provider_credentials").delete().eq("connection_id", connectionId);
  return existing;
}

async function readCredentials(admin: AdminClient, connectionId: string): Promise<Credentials | null> {
  const { data, error } = await admin
    .from("provider_credentials")
    .select("ciphertext")
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error) throw new Error(`Reading credentials failed: ${error.message}`);
  if (!data) return null;
  return JSON.parse(decryptSecret(data.ciphertext, connectionId)) as Credentials;
}

/** Decrypts stored credentials, refreshing OAuth tokens that expire within 5 minutes. */
export async function loadCredentials(
  admin: AdminClient,
  connection: { id: string; workspace_id: string; provider: string },
  now = new Date(),
): Promise<Credentials> {
  const creds = await readCredentials(admin, connection.id);
  if (!creds) throw new ProviderError("auth_invalid", "No stored credentials for this connection");
  if (creds.kind === "oauth" && Date.parse(creds.expiresAt) - now.getTime() < 5 * 60_000) {
    if (connection.provider !== "supabase") throw new ProviderError("auth_expired", "OAuth token expired");
    const refreshed = await refreshTokens(creds.refreshToken);
    const next: Credentials = { kind: "oauth", ...refreshed };
    await saveCredentials(admin, connection, next);
    return next;
  }
  return creds;
}
