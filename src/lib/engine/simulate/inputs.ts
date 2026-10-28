import { CATALOG, COMPUTE_KEYS, type ComputeKey } from "./catalog";

export const PRESETS = ["side_project", "small_saas", "consumer_app"] as const;
export type PresetKey = (typeof PRESETS)[number];
export const DEFAULT_PRESET: PresetKey = "small_saas";

export type SupabaseChoice = "off" | "free" | "pro" | "team";
export type FirebaseChoice = "off" | "spark" | "blaze";
export type Backend = "supabase" | "firebase";
export type CacheChoice = "off" | "upstash_payg";
export type VercelChoice = "off" | "hobby" | "pro";
export type CloudflareChoice = "off" | "free" | "paid";
export type Host = "vercel" | "cloudflare" | "direct";
export type FileStore = "supabase" | "r2" | "firebase";

export const HOSTS: Host[] = ["vercel", "cloudflare", "direct"];
export const BACKENDS: Backend[] = ["supabase", "firebase"];
export const HOST_LABELS: Record<Host, string> = {
  vercel: "Vercel",
  cloudflare: "Cloudflare Workers",
  direct: "Client calls the backend directly",
};

export interface SimInputs {
  preset: PresetKey;
  // Stack
  supabase: SupabaseChoice;
  compute: "auto" | ComputeKey;
  firebase: FirebaseChoice;
  /** Which backend holds the database when Supabase and Firebase are both on. */
  db: Backend;
  cache: CacheChoice;
  vercel: VercelChoice;
  seats: number;
  cloudflare: CloudflareChoice;
  host: Host;
  fileStore: FileStore;
  // Workload
  mau: number;
  dauPct: number;
  sessionsPerDay: number;
  requestsPerSession: number;
  queriesPerRequest: number;
  dbQueriesOverride: number | null;
  readPct: number;
  hitPct: number;
  peakToAvg: number;
  responseKB: number;
  dbKBPerUser: number;
  fileMBPerUser: number;
  fileDownloadMBPerUser: number;
  functionPct: number;
  realtimePct: number;
  realtimeMsgsPerUserDay: number;
  cpuMs: number;
  growthPct: number;
  // Assumptions
  headroomPct: number;
  queryMs: number;
  cacheValueKB: number;
  cachedKeysPct: number;
  avgFileMB: number;
  planningQps: Partial<Record<ComputeKey, number>>;
}

export type FieldGroup = "stack" | "traffic" | "database" | "data" | "growth" | "assumptions";

export const FIELD_GROUPS: { key: Exclude<FieldGroup, "stack">; label: string }[] = [
  { key: "traffic", label: "Users & traffic" },
  { key: "database", label: "Database" },
  { key: "data", label: "Data & bandwidth" },
  { key: "growth", label: "Growth" },
  { key: "assumptions", label: "Assumptions" },
];

export type NumberKey = { [K in keyof SimInputs]-?: SimInputs[K] extends number | null ? K : never }[keyof SimInputs];
export type EnumKey = "supabase" | "compute" | "firebase" | "db" | "cache" | "vercel" | "cloudflare" | "host" | "fileStore";

export interface NumberField {
  kind: "number";
  name: NumberKey;
  url: string;
  label: string;
  group: FieldGroup;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  integer?: boolean;
  optional?: boolean;
}

export interface EnumField {
  kind: "enum";
  name: EnumKey;
  url: string;
  label: string;
  options: { value: string; label: string }[];
}

type NumberExtras = Partial<Pick<NumberField, "unit" | "hint" | "integer" | "optional">>;

function num(name: NumberKey, url: string, label: string, group: FieldGroup, min: number, max: number, step: number, extra: NumberExtras = {}): NumberField {
  return { kind: "number", name, url, label, group, min, max, step, ...extra };
}

function choice(name: EnumKey, url: string, label: string, options: [string, string][]): EnumField {
  return { kind: "enum", name, url, label, options: options.map(([value, text]) => ({ value, label: text })) };
}

export const ENUM_FIELDS: EnumField[] = [
  choice("supabase", "sb", "Supabase", [["off", "Off"], ["free", "Free"], ["pro", "Pro"], ["team", "Team"]]),
  choice("compute", "cmp", "Database compute", [["auto", "Auto (smallest that fits)"], ...CATALOG.compute.map((c): [string, string] => [c.key, c.label])]),
  choice("firebase", "fb", "Firebase", [["off", "Off"], ["spark", "Spark (no cost)"], ["blaze", "Blaze (pay as you go)"]]),
  choice("db", "db", "Database", [["supabase", "Supabase"], ["firebase", "Firebase (Firestore)"]]),
  choice("cache", "ca", "Cache", [["off", "Off"], ["upstash_payg", "Upstash Redis (pay as you go)"]]),
  choice("vercel", "vc", "Vercel", [["off", "Off"], ["hobby", "Hobby"], ["pro", "Pro"]]),
  choice("cloudflare", "cf", "Cloudflare", [["off", "Off"], ["free", "Workers Free"], ["paid", "Workers Paid"]]),
  choice("host", "host", "API runs on", HOSTS.map((h): [string, string] => [h, HOST_LABELS[h]])),
  choice("fileStore", "fs", "File storage", [["supabase", "Supabase Storage"], ["r2", "Cloudflare R2"], ["firebase", "Cloud Storage for Firebase"]]),
];

export const NUMBER_FIELDS: NumberField[] = [
  num("seats", "seats", "Vercel seats", "stack", 1, 1_000, 1, { integer: true }),
  num("mau", "mau", "Monthly active users", "traffic", 0, 100_000_000, 100, { integer: true, unit: "users" }),
  num("dauPct", "dau", "Daily active share", "traffic", 1, 100, 1, { unit: "%", hint: "of MAU on a typical day" }),
  num("sessionsPerDay", "spd", "Sessions per day", "traffic", 0.1, 50, 0.1, { hint: "per active user" }),
  num("requestsPerSession", "rps", "Requests per session", "traffic", 1, 1_000, 1),
  num("peakToAvg", "pk", "Peak vs. average", "traffic", 1, 50, 0.5, { unit: "×" }),
  num("functionPct", "fn", "Requests using an Edge Function", "traffic", 0, 100, 1, { unit: "%" }),
  num("realtimePct", "rt", "Daily users on Realtime", "traffic", 0, 100, 1, { unit: "%" }),
  num("realtimeMsgsPerUserDay", "rtm", "Realtime messages", "traffic", 0, 100_000, 1, { hint: "per Realtime user per day" }),
  num("cpuMs", "cpu", "CPU time per request", "traffic", 1, 30_000, 1, { unit: "ms", hint: "server functions" }),
  num("queriesPerRequest", "qpr", "DB queries per request", "database", 0, 50, 0.5),
  num("dbQueriesOverride", "dbq", "DB queries per month", "database", 0, 1e13, 1_000, { integer: true, optional: true, hint: "optional; replaces the derived count" }),
  num("readPct", "rd", "Reads", "database", 0, 100, 1, { unit: "%", hint: "of queries" }),
  num("hitPct", "hit", "Cache hit rate", "database", 0, 99, 1, { unit: "%", hint: "of reads" }),
  num("dbKBPerUser", "dbkb", "Database data per user", "database", 0, 100_000, 1, { unit: "KB" }),
  num("responseKB", "kb", "Response size", "data", 0.1, 10_000, 0.1, { unit: "KB", hint: "per API request" }),
  num("fileMBPerUser", "fmb", "Files stored per user", "data", 0, 100_000, 0.1, { unit: "MB" }),
  num("fileDownloadMBPerUser", "fdl", "File downloads per user", "data", 0, 100_000, 0.1, { unit: "MB/mo" }),
  num("growthPct", "g", "Monthly MAU growth", "growth", -50, 200, 1, { unit: "%" }),
  num("headroomPct", "hr", "Compute headroom", "assumptions", 10, 100, 5, { unit: "%", hint: "highest share of capacity to use" }),
  num("queryMs", "qms", "Average query time", "assumptions", 0.1, 10_000, 0.1, { unit: "ms" }),
  num("cachedKeysPct", "ck", "Data held in cache", "assumptions", 0, 100, 1, { unit: "%" }),
  num("cacheValueKB", "cvk", "Cache value size", "assumptions", 0.01, 100_000, 0.01, { unit: "KB" }),
  num("avgFileMB", "fsz", "Average file size", "assumptions", 0.001, 100_000, 0.001, { unit: "MB" }),
];

const FIELDS = [...ENUM_FIELDS, ...NUMBER_FIELDS];
const FIELD_BY_URL = new Map(FIELDS.map((f) => [f.url, f]));
export const QPS_MAX = 10_000_000;

export const PRESET_INFO: Record<PresetKey, { label: string; description: string }> = {
  side_project: { label: "Side project", description: "A few hundred users on free tiers, growing slowly." },
  small_saas: { label: "Small SaaS", description: "Ten thousand users on paid plans, with uploads and some Realtime." },
  consumer_app: { label: "Consumer app", description: "A quarter of a million users with spiky traffic and a pay-as-you-go cache in front of the database." },
};

const ASSUMPTIONS = { headroomPct: 70, queryMs: 5, cacheValueKB: 2, cachedKeysPct: 10, avgFileMB: 0.5 };
const ROUTING = { compute: "auto", firebase: "off", db: "supabase", cloudflare: "off", host: "vercel", fileStore: "supabase", dbQueriesOverride: null } as const;

const PRESET_VALUES: Record<PresetKey, SimInputs> = {
  side_project: {
    preset: "side_project",
    ...ROUTING,
    supabase: "free",
    cache: "off",
    vercel: "hobby",
    seats: 1,
    mau: 500,
    dauPct: 20,
    sessionsPerDay: 1,
    requestsPerSession: 20,
    queriesPerRequest: 2,
    readPct: 85,
    hitPct: 80,
    peakToAvg: 3,
    responseKB: 5,
    dbKBPerUser: 20,
    fileMBPerUser: 1,
    fileDownloadMBPerUser: 2,
    functionPct: 0,
    realtimePct: 0,
    realtimeMsgsPerUserDay: 0,
    cpuMs: 10,
    growthPct: 10,
    ...ASSUMPTIONS,
    planningQps: {},
  },
  small_saas: {
    preset: "small_saas",
    ...ROUTING,
    supabase: "pro",
    cache: "off",
    vercel: "pro",
    seats: 1,
    mau: 10_000,
    dauPct: 25,
    sessionsPerDay: 2,
    requestsPerSession: 40,
    queriesPerRequest: 3,
    readPct: 80,
    hitPct: 80,
    peakToAvg: 4,
    responseKB: 10,
    dbKBPerUser: 200,
    fileMBPerUser: 20,
    fileDownloadMBPerUser: 30,
    functionPct: 5,
    realtimePct: 10,
    realtimeMsgsPerUserDay: 50,
    cpuMs: 20,
    growthPct: 8,
    ...ASSUMPTIONS,
    planningQps: {},
  },
  consumer_app: {
    preset: "consumer_app",
    ...ROUTING,
    supabase: "pro",
    cache: "upstash_payg",
    vercel: "pro",
    seats: 2,
    mau: 250_000,
    dauPct: 15,
    sessionsPerDay: 3,
    requestsPerSession: 30,
    queriesPerRequest: 2,
    readPct: 90,
    hitPct: 85,
    peakToAvg: 6,
    responseKB: 8,
    dbKBPerUser: 50,
    fileMBPerUser: 5,
    fileDownloadMBPerUser: 20,
    functionPct: 10,
    realtimePct: 20,
    realtimeMsgsPerUserDay: 100,
    cpuMs: 15,
    growthPct: 5,
    ...ASSUMPTIONS,
    planningQps: {},
  },
};

export function presetInputs(preset: PresetKey): SimInputs {
  return structuredClone(PRESET_VALUES[preset]);
}

export function clampField(field: NumberField, n: number): number {
  const v = Math.min(field.max, Math.max(field.min, n));
  return field.integer ? Math.round(v) : v;
}

export function clampQps(n: number): number {
  return Math.min(QPS_MAX, Math.max(1, n));
}

type Params = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Echoes URL text in notices without letting a crafted link write a paragraph. */
const quote = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

function parseNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function setValue(inputs: SimInputs, name: EnumKey | NumberKey, value: unknown) {
  (inputs as unknown as Record<string, unknown>)[name] = value;
}

/** Inputs from URL search params: preset first, then every valid override. */
export function decode(params: Params): { inputs: SimInputs; notices: string[] } {
  const notices: string[] = [];
  const p = first(params.p);
  let preset = DEFAULT_PRESET;
  if (p !== undefined) {
    if ((PRESETS as readonly string[]).includes(p)) preset = p as PresetKey;
    else notices.push(`Unknown preset "${quote(p)}", so ${PRESET_INFO[DEFAULT_PRESET].label} is used.`);
  }
  const inputs = presetInputs(preset);

  for (const [key, value] of Object.entries(params)) {
    const raw = first(value);
    if (key === "p" || raw === undefined) continue;

    if (key.startsWith("qps.")) {
      const size = key.slice(4);
      const n = parseNumber(raw);
      if (!(COMPUTE_KEYS as readonly string[]).includes(size) || n === null) {
        notices.push(`Ignored the setting "${quote(key)}".`);
        continue;
      }
      inputs.planningQps[size as ComputeKey] = clampQps(n);
      continue;
    }

    const field = FIELD_BY_URL.get(key);
    if (!field) {
      notices.push(`Ignored the unknown setting "${quote(key)}".`);
      continue;
    }
    if (field.kind === "enum") {
      if (field.options.some((o) => o.value === raw)) setValue(inputs, field.name, raw);
      else notices.push(`Ignored an invalid value for ${field.label}.`);
      continue;
    }
    const n = parseNumber(raw);
    if (n === null) {
      notices.push(`Ignored an invalid value for ${field.label}.`);
      continue;
    }
    setValue(inputs, field.name, clampField(field, n));
  }
  return { inputs, notices };
}

/** Search params holding the preset plus only the values that differ from it. */
export function encode(inputs: SimInputs): string {
  const base = PRESET_VALUES[inputs.preset];
  const out = new URLSearchParams({ p: inputs.preset });
  for (const f of FIELDS) {
    const v = inputs[f.name];
    if (v !== null && v !== base[f.name]) out.set(f.url, String(v));
  }
  for (const k of COMPUTE_KEYS) {
    const v = inputs.planningQps[k];
    if (v !== undefined && v !== base.planningQps[k]) out.set(`qps.${k}`, String(v));
  }
  return out.toString();
}
