// Standalone worker: `npm run worker` (loop) or `npm run worker:once` (single pass).
import { runSchedulerTick } from "../src/lib/jobs/scheduler";

const once = process.argv.includes("--once");
const intervalMs = Math.max(15, Number(process.env.SCHEDULER_INTERVAL_SECONDS ?? 60)) * 1000;

async function tick() {
  const started = Date.now();
  try {
    const s = await runSchedulerTick();
    console.info(
      `[worker] synced=${s.synced.length} recalculated=${s.recalculated} emails sent=${s.delivered.sent} failed=${s.delivered.failed} (${Date.now() - started}ms)`,
    );
  } catch (e) {
    console.error("[worker] tick failed:", e);
  }
}

async function main() {
  if (once) {
    await tick();
    process.exit(0);
  }
  console.info(`[worker] running every ${intervalMs / 1000}s`);
  await tick();
  setInterval(tick, intervalMs);
}

void main();
