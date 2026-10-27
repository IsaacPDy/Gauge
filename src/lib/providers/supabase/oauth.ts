import { requestJson } from "../http";
import { ProviderError } from "../types";
import { SUPABASE_API_URL, SUPABASE_SCOPES } from "./adapter";

export function oauthConfigured(): boolean {
  return Boolean(process.env.SUPABASE_OAUTH_CLIENT_ID && process.env.SUPABASE_OAUTH_CLIENT_SECRET);
}

export function oauthRedirectUri(): string {
  return `${process.env.APP_URL ?? "http://localhost:3000"}/api/integrations/supabase/oauth/callback`;
}

function basicAuth() {
  const id = process.env.SUPABASE_OAUTH_CLIENT_ID!;
  const secret = process.env.SUPABASE_OAUTH_CLIENT_SECRET!;
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

export function authorizeUrl(state: string, codeChallenge: string): string {
  const url = new URL(`${SUPABASE_API_URL}/v1/oauth/authorize`);
  url.searchParams.set("client_id", process.env.SUPABASE_OAUTH_CLIENT_ID!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", oauthRedirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  const scopes = (process.env.SUPABASE_OAUTH_SCOPES ?? SUPABASE_SCOPES.join(" ")).trim();
  if (scopes) url.searchParams.set("scope", scopes);
  return url.toString();
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

function toTokens(res: TokenResponse, previousRefresh?: string): OAuthTokens {
  if (!res?.access_token) throw new ProviderError("invalid_response", "Token response missing access_token");
  const refreshToken = res.refresh_token ?? previousRefresh;
  if (!refreshToken) throw new ProviderError("invalid_response", "Token response missing refresh_token");
  return {
    accessToken: res.access_token,
    refreshToken,
    expiresAt: new Date(Date.now() + (res.expires_in ?? 3600) * 1000).toISOString(),
  };
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  return requestJson<TokenResponse>(`${SUPABASE_API_URL}/v1/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
    retries: 1,
  });
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokens> {
  const res = await tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: oauthRedirectUri(),
  });
  return toTokens(res);
}

/** A rejected refresh token means the user must reauthorize. */
export async function refreshTokens(refreshToken: string): Promise<OAuthTokens> {
  try {
    return toTokens(await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }), refreshToken);
  } catch (e) {
    if (e instanceof ProviderError && (e.options.status === 400 || e.options.status === 401)) {
      throw new ProviderError("auth_expired", "Supabase refused to refresh the OAuth token; reauthorization is required");
    }
    throw e;
  }
}

/** Best effort: revokes the app's authorization so the stored tokens become useless. */
export async function revokeTokens(refreshToken: string): Promise<void> {
  await requestJson(`${SUPABASE_API_URL}/v1/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SUPABASE_OAUTH_CLIENT_ID,
      client_secret: process.env.SUPABASE_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
    retries: 1,
  });
}
