const PUBLIC_PATHS = ["/login", "/signup", "/forgot-password", "/reset-password", "/auth", "/api/cron", "/api/integrations"];

/** Paths a signed-out visitor may load. Everything else goes through the session check. */
export function isPublicPath(path: string): boolean {
  return path === "/" || PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}
