/** Only allow same-site relative redirects ("/foo"), never "//evil.com" or absolute URLs. */
export function safeNext(next: unknown, fallback = "/home"): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

export function appUrl(path = ""): string {
  return `${process.env.APP_URL ?? "http://localhost:3000"}${path}`;
}

export function withParams(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]);
  const s = q.toString();
  return s ? `${path}${path.includes("?") ? "&" : "?"}${s}` : path;
}
