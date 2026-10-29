/** A route handler returns [status, body]; string bodies are sent as-is, anything else as JSON. */
export type Route = (url: URL, body?: unknown) => [number, unknown];

/** Fake fetch keyed by "METHOD /path" (query string ignored). Unmatched requests get a 404. */
export function mockFetch(routes: Record<string, Route>, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push(`${key}${url.search}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const route = routes[key];
    const [status, payload] = route ? route(url, body) : [404, { message: `not mocked: ${key}` }];
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
  }) as typeof fetch;
}
