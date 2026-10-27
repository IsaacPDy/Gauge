import { runSchedulerTick } from "./scheduler";
import { ensureReferenceData } from "./reference";

const KEY = Symbol.for("cloudwatch.scheduler");
type Global = typeof globalThis & { [KEY]?: NodeJS.Timeout };

/** Development convenience: run the scheduler inside the Next.js server process. */
export function startInProcessScheduler() {
  ensureReferenceData().catch((e) => console.error("[scheduler] reference data sync failed:", e.message));
  if (process.env.RUN_SCHEDULER_IN_PROCESS !== "true") return;
  const g = globalThis as Global;
  if (g[KEY]) return; // hot reload: keep a single interval
  const seconds = Math.max(15, Number(process.env.SCHEDULER_INTERVAL_SECONDS ?? 60));
  g[KEY] = setInterval(() => {
    runSchedulerTick().catch((e) => console.error("[scheduler] tick failed:", e));
  }, seconds * 1000);
  console.info(`[scheduler] running in-process every ${seconds}s`);
}
