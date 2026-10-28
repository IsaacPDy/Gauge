import { z } from "zod";
import type { UsdPhpRate } from "./currency";

/** ECB reference rates via Frankfurter: free, no key, published once per working day. */
const SOURCE_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=PHP";
/** Used until the first successful fetch, or when the source is unreachable. */
export const FALLBACK_PHP_PER_USD = 64;

const LIVE_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 3000;

const Body = z.object({ date: z.string(), rates: z.object({ PHP: z.number().positive() }) });

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Remembers the last rate so pages don't wait on the network: a good rate is kept for six
 * hours, and after a failure the last good rate (or the fallback) is used for ten minutes
 * before trying again.
 */
export function createRateSource(fetchImpl: Fetch = fetch, clock: () => number = Date.now) {
  let current: UsdPhpRate = { rate: FALLBACK_PHP_PER_USD, date: null, live: false };
  let freshUntil = 0;
  let inflight: Promise<UsdPhpRate> | null = null;

  async function refresh(): Promise<UsdPhpRate> {
    try {
      const res = await fetchImpl(SOURCE_URL, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Body.parse(await res.json());
      current = { rate: body.rates.PHP, date: body.date, live: true };
      freshUntil = clock() + LIVE_TTL_MS;
    } catch (e) {
      console.warn(`Exchange rate fetch failed, using ${current.live ? "the last good rate" : "the fallback rate"}:`, e instanceof Error ? e.message : e);
      freshUntil = clock() + RETRY_AFTER_MS;
    }
    return current;
  }

  return function getUsdPhpRate(): Promise<UsdPhpRate> {
    if (clock() < freshUntil) return Promise.resolve(current);
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

export const getUsdPhpRate = createRateSource();
