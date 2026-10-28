import type { SimInputs } from "./inputs";
import type { ResolvedStack } from "./stack";

const DAYS_PER_MONTH = 30;
const SECONDS_PER_MONTH = DAYS_PER_MONTH * 86_400;

export interface MonthUsage {
  month: number;
  mau: number;
  dau: number;
  requests: number;
  dbQueries: number;
  reads: number;
  writes: number;
  cacheHits: number;
  dbHits: number;
  avgDbQps: number;
  peakDbQps: number;
  /** Concurrent queries at peak (Little's law). */
  peakConnections: number;
  apiEgressGB: number;
  /** API response egress billed by Vercel or Cloudflare. */
  hostEgressGB: number;
  /** DB response egress billed by Supabase (excludes file downloads). */
  supabaseEgressGB: number;
  fileEgressGB: number;
  dbSizeGB: number;
  storageGB: number;
  storageAddedGB: number;
  fnInvocations: number;
  rtPeakConnections: number;
  rtMessages: number;
  serverRequests: number;
  cpuMs: number;
  cacheCommands: number;
  cacheStorageGB: number;
  cacheKeys: number;
  fileWrites: number;
  fileReads: number;
}

/** Monthly usage implied by the inputs. `cacheOn` decides whether reads can hit a cache. */
export function workloadMonths(inputs: SimInputs, stack: ResolvedStack, cacheOn: boolean, months = 12): MonthUsage[] {
  const growth = 1 + inputs.growthPct / 100;
  const server = stack.host !== "direct";
  const cache = cacheOn && server;
  const out: MonthUsage[] = [];
  let usersSoFar = 0;
  let prevMau = 0;

  for (let month = 1; month <= months; month++) {
    const factor = growth ** (month - 1);
    const mau = inputs.mau * factor;
    // Stored data follows everyone who ever joined, so a falling MAU never shrinks it.
    const newUsers = month === 1 ? mau : Math.max(0, mau - prevMau);
    usersSoFar += newUsers;
    prevMau = mau;

    const dau = mau * (inputs.dauPct / 100);
    const requests = dau * inputs.sessionsPerDay * inputs.requestsPerSession * DAYS_PER_MONTH;
    const dbQueries = inputs.dbQueriesOverride !== null ? inputs.dbQueriesOverride * factor : requests * inputs.queriesPerRequest;
    const reads = dbQueries * (inputs.readPct / 100);
    const writes = dbQueries - reads;
    const cacheHits = cache ? reads * (inputs.hitPct / 100) : 0;
    const dbHits = dbQueries - cacheHits;
    const avgDbQps = dbHits / SECONDS_PER_MONTH;
    const peakDbQps = avgDbQps * inputs.peakToAvg;

    const apiEgressGB = (requests * inputs.responseKB) / 1e6;
    const dbSizeGB = (usersSoFar * inputs.dbKBPerUser) / 1e6;
    const storageGB = (usersSoFar * inputs.fileMBPerUser) / 1e3;
    const storageAddedGB = (newUsers * inputs.fileMBPerUser) / 1e3;
    const fileEgressGB = (mau * inputs.fileDownloadMBPerUser) / 1e3;
    const realtimeUsers = dau * (inputs.realtimePct / 100);
    const serverRequests = server ? requests : 0;
    const cacheStorageGB = cache ? dbSizeGB * (inputs.cachedKeysPct / 100) : 0;

    out.push({
      month,
      mau,
      dau,
      requests,
      dbQueries,
      reads,
      writes,
      cacheHits,
      dbHits,
      avgDbQps,
      peakDbQps,
      peakConnections: (peakDbQps * inputs.queryMs) / 1000,
      apiEgressGB,
      hostEgressGB: server ? apiEgressGB : 0,
      supabaseEgressGB: server ? (dbQueries > 0 ? (apiEgressGB * dbHits) / dbQueries : 0) : apiEgressGB,
      fileEgressGB,
      dbSizeGB,
      storageGB,
      storageAddedGB,
      fnInvocations: requests * (inputs.functionPct / 100),
      // Assumes each Realtime user stays connected about an hour a day, scaled by the peak factor.
      rtPeakConnections: (realtimeUsers * inputs.peakToAvg) / 24,
      rtMessages: realtimeUsers * inputs.realtimeMsgsPerUserDay * DAYS_PER_MONTH,
      serverRequests,
      cpuMs: serverRequests * inputs.cpuMs,
      cacheCommands: cache ? reads + (reads - cacheHits) + writes : 0,
      cacheStorageGB,
      cacheKeys: cache ? (cacheStorageGB * 1e6) / inputs.cacheValueKB : 0,
      fileWrites: (storageAddedGB * 1e3) / inputs.avgFileMB,
      fileReads: (fileEgressGB * 1e3) / inputs.avgFileMB,
    });
  }
  return out;
}
