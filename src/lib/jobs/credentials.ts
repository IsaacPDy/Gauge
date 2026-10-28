import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { provider_credentials } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../crypto";
import { refreshTokens } from "../providers/supabase/oauth";
import { type Credentials, ProviderError } from "../providers/types";

export async function saveCredentials(connection: { id: string; workspace_id: string }, credentials: Credentials): Promise<void> {
  const values = {
    connection_id: connection.id,
    workspace_id: connection.workspace_id,
    ciphertext: encryptSecret(JSON.stringify(credentials), connection.id),
    key_version: 1,
    expires_at: credentials.kind === "oauth" ? credentials.expiresAt : null,
  };
  try {
    await db
      .insert(provider_credentials)
      .values(values)
      .onConflictDoUpdate({
        target: provider_credentials.connection_id,
        set: { workspace_id: values.workspace_id, ciphertext: values.ciphertext, key_version: 1, expires_at: values.expires_at },
      });
  } catch (e) {
    throw new Error(`Storing credentials failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function deleteCredentials(connectionId: string): Promise<Credentials | null> {
  const existing = await readCredentials(connectionId).catch(() => null);
  await db.delete(provider_credentials).where(eq(provider_credentials.connection_id, connectionId));
  return existing;
}

async function readCredentials(connectionId: string): Promise<Credentials | null> {
  const [row] = await db
    .select({ ciphertext: provider_credentials.ciphertext })
    .from(provider_credentials)
    .where(eq(provider_credentials.connection_id, connectionId))
    .limit(1);
  if (!row) return null;
  return JSON.parse(decryptSecret(row.ciphertext, connectionId)) as Credentials;
}

/** Decrypts stored credentials, refreshing OAuth tokens that expire within 5 minutes. */
export async function loadCredentials(
  connection: { id: string; workspace_id: string; provider: string },
  now = new Date(),
): Promise<Credentials> {
  const creds = await readCredentials(connection.id);
  if (!creds) throw new ProviderError("auth_invalid", "No stored credentials for this connection");
  if (creds.kind === "oauth" && Date.parse(creds.expiresAt) - now.getTime() < 5 * 60_000) {
    if (connection.provider !== "supabase") throw new ProviderError("auth_expired", "OAuth token expired");
    const refreshed = await refreshTokens(creds.refreshToken);
    const next: Credentials = { kind: "oauth", ...refreshed };
    await saveCredentials(connection, next);
    return next;
  }
  return creds;
}
