import type { ComputeKey } from "./catalog";
import { type FileStore, type Host, HOST_LABELS, HOSTS, type SimInputs } from "./inputs";

export interface ResolvedStack {
  supabase: "free" | "pro" | "team" | null;
  compute: "auto" | ComputeKey;
  /** Whether the cache is priced. */
  cache: boolean;
  cacheBlockedReason: string | null;
  vercel: "hobby" | "pro" | null;
  seats: number;
  cloudflare: "free" | "paid" | null;
  host: Host;
  fileStore: FileStore;
}

export const DIRECT_REASON =
  "A cache needs a server-side API host (Vercel or Cloudflare). With the client calling Supabase directly there is nowhere to put one.";
export const NO_SUPABASE_REASON = "The cache is modelled in front of a Supabase database. Turn on Supabase to price it.";

/** Applies the routing rules so every mix of services is coherent. */
export function resolveStack(inputs: SimInputs): { stack: ResolvedStack; notices: string[] } {
  const notices: string[] = [];
  const supabase = inputs.supabase === "off" ? null : inputs.supabase;
  const vercel = inputs.vercel === "off" ? null : inputs.vercel;
  const cloudflare = inputs.cloudflare === "off" ? null : inputs.cloudflare;

  const hostOn: Record<Host, boolean> = { vercel: vercel !== null, cloudflare: cloudflare !== null, direct: supabase !== null };
  let host = inputs.host;
  if (!hostOn[host]) {
    host = HOSTS.find((h) => hostOn[h]) ?? "direct";
    if (host !== inputs.host) notices.push(`${HOST_LABELS[inputs.host]} is turned off, so the API host is ${HOST_LABELS[host]}.`);
  }

  let fileStore = inputs.fileStore;
  if (fileStore === "r2" && cloudflare === null) {
    fileStore = "supabase";
    notices.push("R2 file storage needs Cloudflare, so Supabase Storage is used.");
  }

  let cache = inputs.cache !== "off";
  let cacheBlockedReason: string | null = null;
  if (cache && supabase === null) {
    cache = false;
    cacheBlockedReason = NO_SUPABASE_REASON;
  } else if (cache && host === "direct") {
    cache = false;
    cacheBlockedReason = DIRECT_REASON;
  }

  return {
    stack: { supabase, compute: inputs.compute, cache, cacheBlockedReason, vercel, seats: inputs.seats, cloudflare, host, fileStore },
    notices,
  };
}
