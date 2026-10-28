import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const DIR = join(process.cwd(), "db", "migrations");
const LOCK_ID = 727274;

/** 1-based line number of a 1-based character offset into `sql` (as reported by Postgres), or undefined. */
export function lineAt(sql: string, position: number): number | undefined {
  if (!Number.isInteger(position) || position < 1) return undefined;
  return sql.slice(0, position - 1).split("\n").length;
}

/**
 * Applies db/migrations/*.sql in filename order, each exactly once, each in its own
 * transaction. Concurrent callers (parallel test files) are serialised by an advisory lock.
 * Returns the names of the migrations applied by this call.
 */
export async function migrate(connectionString: string): Promise<string[]> {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 30_000 });
  const applied: string[] = [];
  try {
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
      const client = await pool.connect();
      let migrationSql: string | undefined;
      try {
        await client.query("begin");
        await client.query(`select pg_advisory_xact_lock(${LOCK_ID})`);
        await client.query(
          "create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())",
        );
        const seen = await client.query("select 1 from public.schema_migrations where name = $1", [file]);
        if (seen.rowCount === 0) {
          migrationSql = readFileSync(join(DIR, file), "utf8");
          await client.query(migrationSql);
          migrationSql = undefined; // later errors (the insert) have positions in a different statement
          await client.query("insert into public.schema_migrations (name) values ($1)", [file]);
          applied.push(file);
        }
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        const message = e instanceof Error ? e.message : String(e);
        const position = (e as { position?: unknown } | null)?.position;
        const line = migrationSql !== undefined && typeof position === "string" ? lineAt(migrationSql, Number(position)) : undefined;
        throw new Error(`Migration ${file} failed${line ? ` at line ${line}` : ""}: ${message}`, { cause: e });
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
  return applied;
}
