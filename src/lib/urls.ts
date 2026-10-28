/**
 * Only allow same-site relative redirects ("/foo?x=1#y"). Anything else falls back.
 * Control characters and backslashes are rejected because URL parsers strip tabs/newlines
 * and treat "\" as "/", which would turn "/\t/evil.com" or "/\evil.com" into an external URL.
 */
export function safeNext(next: unknown, fallback = "/home"): string {
  if (typeof next !== "string" || !next.startsWith("/")) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  const u = new URL(next, "http://x.invalid");
  if (u.origin !== "http://x.invalid") return fallback;
  // Normalisation can create a protocol-relative path: "/..//x" becomes "//x".
  const result = u.pathname + u.search + u.hash;
  return result.startsWith("//") ? fallback : result;
}

export function appUrl(path = ""): string {
  let base = process.env.APP_URL;
  if (!base) {
    if (process.env.NODE_ENV === "production") throw new Error("APP_URL must be set in production (the public origin of this app).");
    base = "http://localhost:3100";
  }
  return `${base.replace(/\/+$/, "")}${path}`;
}

export function withParams(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]);
  const s = q.toString();
  return s ? `${path}${path.includes("?") ? "&" : "?"}${s}` : path;
}
