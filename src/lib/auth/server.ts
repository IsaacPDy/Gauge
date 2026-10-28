import { createNeonAuth } from "@neondatabase/auth/next/server";

/** Neon Auth (managed Better Auth). Server-side only: sessions, sign-in/out and the proxy handler. */
export const auth = createNeonAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
});
