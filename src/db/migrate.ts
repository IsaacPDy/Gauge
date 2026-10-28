import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const DIR = join(process.cwd(), "db", "migrations");
const LOCK_ID = 727274;

/**
 * Applies db/migrations/*.sql in filename order, each exactly once, each in its own
 * transaction. Concurrent callers (parallel test files) are serialised by an advisory lock.
 * Returns the names of the migrations applied by this call.
 */
export async function migrate(connectionString: string): Promise<string[]> {
  const pool = new Pool({ connectionString, max: 1 });
  const applied: string[] = [];
  try {
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(`select pg_advisory_xact_lock(${LOCK_ID})`);
        await client.query(
          "create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())",
        );
        const seen = await client.query("select 1 from public.schema_migrations where name = $1", [file]);
        if (seen.rowCount === 0) {
          await client.query(readFileSync(join(DIR, file), "utf8"));
          await client.query("insert into public.schema_migrations (name) values ($1)", [file]);
          applied.push(file);
        }
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
  return applied;
}
