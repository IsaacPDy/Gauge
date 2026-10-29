import { ProviderError } from "./types";

export interface RequestOptions extends RequestInit {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra attempts for transient failures (network, 5xx, 429). */
  retries?: number;
  /** Base delay for exponential backoff. Tests pass 0. */
  backoffMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Turn an HTTP response status into a normalized ProviderError. Body text is truncated and never includes request headers. */
export function errorForStatus(res: Response, bodyText: string): ProviderError {
  const snippet = bodyText.slice(0, 200).replace(/\s+/g, " ").trim();
  const msg = (base: string) => (snippet ? `${base}: ${snippet}` : base);
  switch (true) {
    case res.status === 401:
      return new ProviderError("auth_invalid", msg("Credentials were rejected (401)"), { status: 401 });
    case res.status === 403:
      return new ProviderError("permission_denied", msg("Permission denied (403)"), { status: 403 });
    case res.status === 404:
      return new ProviderError("not_found", msg("Not found (404)"), { status: 404 });
    case res.status === 429:
      return new ProviderError("rate_limited", "Rate limited by provider (429)", {
        status: 429,
        retryAfterMs: retryAfterMs(res),
      });
    case res.status >= 500:
      return new ProviderError("provider_unavailable", msg(`Provider error (${res.status})`), { status: res.status });
    default:
      return new ProviderError("unknown", msg(`Unexpected response (${res.status})`), { status: res.status, retryable: false });
  }
}

/** Fetches a URL with retries and normalized errors, returning the body as text. */
export async function requestText(url: string, opts: RequestOptions = {}): Promise<string> {
  const { fetch: fetchImpl = fetch, timeoutMs = 20_000, retries = 2, backoffMs = 500, ...init } = opts;
  let attempt = 0;
  for (;;) {
    let err: ProviderError;
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (res.ok) return text;
      err = errorForStatus(res, text);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const name = (e as Error)?.name;
      err = new ProviderError("network", name === "TimeoutError" ? "Request timed out" : "Network error contacting provider");
    }
    if (!err.retryable || attempt >= retries) throw err;
    const delay = Math.min(10_000, err.options.retryAfterMs ?? backoffMs * 2 ** attempt + Math.random() * backoffMs);
    attempt++;
    await sleep(delay);
  }
}

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const text = await requestText(url, opts);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError("invalid_response", "Provider returned invalid JSON");
  }
}
