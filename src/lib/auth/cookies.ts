import "server-only";
import { cookies } from "next/headers";
import { NEON_AUTH_COOKIE_PREFIX } from "@neondatabase/auth/server";

/**
 * Expires every Neon Auth cookie sent with the request (session token, cached session data,
 * challenge cookies, including the "__Secure-" variants). Call after sign-out or account deletion
 * so a failed or skipped upstream revocation cannot leave a usable session cookie behind.
 * Only works where cookies are writable (route handlers and server actions).
 */
export async function clearAuthCookies(): Promise<void> {
  const store = await cookies();
  for (const { name } of store.getAll()) {
    if (!name.startsWith(NEON_AUTH_COOKIE_PREFIX)) continue;
    // "__Secure-" cookies are only accepted (and so only expired) when the Set-Cookie carries Secure.
    store.set({ name, value: "", path: "/", maxAge: 0, httpOnly: true, secure: true, sameSite: "lax" });
  }
}
