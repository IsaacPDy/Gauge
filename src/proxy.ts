import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth/server";
import { isPublicPath } from "@/lib/auth/paths";

const LOGIN = "/login";
const sdkMiddleware = auth.middleware({ loginUrl: LOGIN });

// Keeps signed-out users away from app pages. Authorization itself is enforced by workspace
// scopes (src/db/scope.ts) and server checks. The SDK middleware also refreshes its session cache
// cookies where they are writable.
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (isPublicPath(path)) return NextResponse.next();

  const response = await sdkMiddleware(request);

  // The SDK redirects signed-out users to the login URL; keep the return path (?next=).
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location) {
    const target = new URL(location, request.nextUrl.origin);
    if (target.origin === request.nextUrl.origin && target.pathname === LOGIN) {
      target.search = `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
      const redirect = NextResponse.redirect(target);
      for (const cookie of response.headers.getSetCookie()) redirect.headers.append("Set-Cookie", cookie);
      return redirect;
    }
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:png|jpg|svg|ico)$).*)"],
};
