import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth/server";
import { clearAuthCookies } from "@/lib/auth/cookies";

export async function POST(request: NextRequest) {
  const { error } = await auth.signOut();
  // Always drop the cookies locally, even when the server could not revoke the session.
  await clearAuthCookies();
  const login = new URL("/login", request.nextUrl.origin);
  if (error) {
    login.search = `?error=${encodeURIComponent("Signed out on this device, but the server could not confirm the session was revoked.")}`;
  }
  return NextResponse.redirect(login, { status: 303 });
}
