// `npm run db:reset -- --yes` — drops and recreates the public schema, then re-applies the
// migrations. Neon Auth users (the neon_auth schema) are kept; their workspace is re-created
// the next time they load the app. Refuses to run unless NEON_BRANCH is "dev" and the command
// line names the target database host: npm run db:reset -- --yes --host=<host> (see src/db/reset-guard.ts).
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";
import { migrate } from "../src/db/migrate";
import { checkResetGuard } from "../src/db/reset-guard";

neonConfig.webSocketConstructor = ws;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  const guard = checkResetGuard({ url, branch: process.env.NEON_BRANCH, argv: process.argv.slice(2) });
  if (!guard.ok) return fail(guard.message);

  const pool = new Pool({ connectionString: url });
  try {
    await pool.query("drop schema public cascade; create schema public;");
  } finally {
    await pool.end();
  }
  console.info(`Reset. Applied: ${(await migrate(url as string)).join(", ")}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
