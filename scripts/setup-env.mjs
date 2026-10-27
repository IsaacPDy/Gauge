// Writes .env.local for local development from `supabase status` plus freshly
// generated secrets. Existing values in .env.local are preserved.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const parse = (text) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^"(.*)"$/, "$1")]),
  );

let status;
try {
  status = JSON.parse(execSync("supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString());
} catch {
  console.error("Could not read `supabase status`. Start the local stack first: npm run db:start");
  process.exit(1);
}

const example = parse(readFileSync(".env.example", "utf8"));
const existing = existsSync(".env.local") ? parse(readFileSync(".env.local", "utf8")) : {};

const generated = {
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  CRON_SECRET: randomBytes(24).toString("base64url"),
};

const merged = { ...example, ...generated, ...Object.fromEntries(Object.entries(existing).filter(([, v]) => v !== "")) };
// Supabase keys always follow the running stack.
for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) merged[k] = generated[k];

const quote = (v) => (/[\s"#]/.test(v) ? JSON.stringify(v) : v);
writeFileSync(".env.local", Object.entries(merged).map(([k, v]) => `${k}=${quote(v)}`).join("\n") + "\n", { mode: 0o600 });
console.log("Wrote .env.local (secrets not printed).");
