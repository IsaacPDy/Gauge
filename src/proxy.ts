import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth/server";

const PUBLIC_PATHS = ["/login", "/signup", "/forgot-password", "/reset-password", "/auth", "/api/auth", "/api/cron", "/api/integrations"];

// Keeps signed-out users away from app pages. Authorization itself is enforced by workspace
// scopes (src/db/scope.ts) and server checks.
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublic = path === "/" || PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
  if (isPublic) return NextResponse.next();

  const { data } = await auth.getSession();
  if (!data?.user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:png|jpg|svg|ico)$).*)"],
};
