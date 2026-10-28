import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth/server";
import { clearAuthCookies } from "@/lib/auth/cookies";

export async function POST(request: NextRequest) {
  let failed = false;
  try {
    failed = !!(await auth.signOut()).error;
  } catch {
    failed = true; // a thrown network error is treated like an error result
  }
  // Always drop the cookies locally, even when the server could not revoke the session.
  await clearAuthCookies();
  const login = new URL("/login", request.nextUrl.origin);
  if (failed) {
    login.search = `?error=${encodeURIComponent("Signed out on this device, but the server could not confirm the session was revoked.")}`;
  }
  return NextResponse.redirect(login, { status: 303 });
}
