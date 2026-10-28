// `npm run db:reset -- --yes` — drops and recreates the public schema, then re-applies the
// migrations. Neon Auth users (the neon_auth schema) are kept; their workspace is re-created
// the next time they load the app. Refuses to run unless NEON_BRANCH is "dev".
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";
import { migrate } from "../src/db/migrate";

neonConfig.webSocketConstructor = ws;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) return fail("Set DATABASE_URL_UNPOOLED in .env.local first.");
  if (process.env.NEON_BRANCH !== "dev") return fail('Refusing to reset: NEON_BRANCH is not "dev" in .env.local.');
  if (!process.argv.includes("--yes")) return fail("Add --yes to confirm that all app data on the dev branch will be deleted.");

  const pool = new Pool({ connectionString: url });
  try {
    await pool.query("drop schema public cascade; create schema public;");
  } finally {
    await pool.end();
  }
  console.info(`Reset. Applied: ${(await migrate(url)).join(", ")}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
