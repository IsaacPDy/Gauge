import {
  type Backend,
  BACKENDS,
  type CloudflareChoice,
  type FileStore,
  type FirebaseChoice,
  type Host,
  HOSTS,
  type SimInputs,
  type SupabaseChoice,
  type VercelChoice,
} from "./inputs";

export interface ResolvedStack {
  /** Priced Supabase plan. Not necessarily the database: see `backend`. */
  supabase: Exclude<SupabaseChoice, "off"> | null;
  firebase: Exclude<FirebaseChoice, "off"> | null;
  /** Which service holds the database, auth, functions and realtime. */
  backend: Backend | null;
  compute: SimInputs["compute"];
  /** Whether the cache is priced. */
  cache: boolean;
  cacheBlockedReason: string | null;
  vercel: Exclude<VercelChoice, "off"> | null;
  seats: number;
  cloudflare: Exclude<CloudflareChoice, "off"> | null;
  host: Host;
  fileStore: FileStore;
}

export const DIRECT_REASON =
  "A cache needs a server-side API host (Vercel or Cloudflare). With the client calling Supabase directly there is nowhere to put one.";
export const NO_SUPABASE_REASON = "The cache is modelled in front of a Supabase database. Turn on Supabase to price it.";
export const FIREBASE_BACKEND_REASON = "The cache is modelled in front of a Supabase database. Firebase is the database, so it isn't priced.";

const BACKEND_LABELS: Record<Backend, string> = { supabase: "Supabase", firebase: "Firebase" };
const STORE_LABELS: Record<FileStore, string> = { supabase: "Supabase Storage", r2: "Cloudflare R2", firebase: "Cloud Storage for Firebase" };

const HOST_OFF: Record<Host, string> = {
  vercel: "Vercel is turned off",
  cloudflare: "Cloudflare is turned off",
  direct: "Supabase is turned off",
};
const HOST_NOW: Record<Exclude<Host, "direct">, string> = {
  vercel: "the API runs on Vercel",
  cloudflare: "the API runs on Cloudflare Workers",
};

/** Applies the routing rules so every mix of services is coherent. */
export function resolveStack(inputs: SimInputs): { stack: ResolvedStack; notices: string[] } {
  const notices: string[] = [];
  let supabase = inputs.supabase === "off" ? null : inputs.supabase;
  let firebase = inputs.firebase === "off" ? null : inputs.firebase;
  const vercel = inputs.vercel === "off" ? null : inputs.vercel;
  const cloudflare = inputs.cloudflare === "off" ? null : inputs.cloudflare;

  // `db` is only offered while both backends are on, so falling back from an off one needs no notice.
  const backendOn: Record<Backend, boolean> = { supabase: supabase !== null, firebase: firebase !== null };
  const backend = backendOn[inputs.db] ? inputs.db : (BACKENDS.find((b) => backendOn[b]) ?? null);

  const hostOn: Record<Host, boolean> = { vercel: vercel !== null, cloudflare: cloudflare !== null, direct: backend !== null };
  const hostNow = (h: Host) => (h === "direct" ? `the client calls ${BACKEND_LABELS[backend ?? "supabase"]} directly` : HOST_NOW[h]);
  let host = inputs.host;
  if (!hostOn[host]) {
    host = HOSTS.find((h) => hostOn[h]) ?? "direct";
    // With nothing on at all the page shows an empty state, so no notice is needed.
    if (hostOn[host]) notices.push(`${HOST_OFF[inputs.host]}, so ${hostNow(host)}.`);
  }

  let fileStore = inputs.fileStore;
  if (fileStore === "r2" && cloudflare === null) {
    fileStore = backend ?? "supabase";
    notices.push(
      backend !== null
        ? `R2 file storage needs Cloudflare, so ${STORE_LABELS[backend]} is used.`
        : "R2 file storage needs Cloudflare, and Supabase is off, so file storage isn't priced.",
    );
  } else if (fileStore === "firebase" && firebase === null) {
    fileStore = "supabase";
    notices.push(
      supabase !== null
        ? "Cloud Storage for Firebase needs Firebase, so Supabase Storage is used."
        : "Cloud Storage for Firebase needs Firebase, and Supabase is off, so file storage isn't priced.",
    );
  } else if (fileStore === "supabase" && supabase === null && firebase !== null) {
    fileStore = "firebase";
    notices.push("Supabase is off, so files are stored in Cloud Storage for Firebase.");
  }

  let cache = inputs.cache !== "off";
  let cacheBlockedReason: string | null = null;
  if (cache && backend !== "supabase") {
    cache = false;
    if (backend === "firebase") {
      cacheBlockedReason = FIREBASE_BACKEND_REASON;
      notices.push("The cache is modelled in front of a Supabase database, so it isn't priced while Firebase is the database.");
    } else {
      cacheBlockedReason = NO_SUPABASE_REASON;
      notices.push("The cache is modelled in front of a Supabase database, so it isn't priced while Supabase is off.");
    }
  } else if (cache && host === "direct") {
    cache = false;
    cacheBlockedReason = DIRECT_REASON;
  }

  // A backend that holds neither the database nor the files would only add its base fee.
  if (supabase !== null && backend !== "supabase" && fileStore !== "supabase") {
    supabase = null;
    notices.push("Supabase is on, but Firebase is the database and nothing else uses it, so it isn't priced.");
  }
  if (firebase !== null && backend !== "firebase" && fileStore !== "firebase") {
    firebase = null;
    notices.push("Firebase is on, but Supabase is the database and nothing else uses it, so it isn't priced.");
  }

  return {
    stack: { supabase, firebase, backend, compute: inputs.compute, cache, cacheBlockedReason, vercel, seats: inputs.seats, cloudflare, host, fileStore },
    notices,
  };
}
