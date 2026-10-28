import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export const testUrl = process.env.DATABASE_URL_TEST;
export const hasTestDb = Boolean(testUrl);

/**
 * Points the app's `db` at DATABASE_URL_TEST and applies migrations to it.
 * Call (and await) before anything touches `db` (a static import is fine; running a query is not).
 *
 * DATABASE_URL_TEST may be the same Neon branch as DATABASE_URL (the project owner chose to
 * test on `dev`). That is safe only because the tests create users with random ids and delete
 * exactly those in `afterAll`; a test must never drop, truncate or bulk-delete anything.
 */
export async function useTestDb() {
  if (!testUrl) throw new Error("DATABASE_URL_TEST is not set");
  const url = testUrl;
  if ((globalThis as Record<symbol, unknown>)[Symbol.for("limitgauge.db")]) {
    throw new Error("db was created before useTestDb() ran; do not touch @/db/client before it resolves");
  }
  process.env.DATABASE_URL = url;
  const { migrate } = await import("@/db/migrate");
  await migrate(url);
}
