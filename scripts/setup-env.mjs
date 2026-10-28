// Prepares .env.local for development: copies the keys from .env.example and generates the
// secrets. Existing values in .env.local are preserved, so it is safe to re-run. The Neon
// connection strings and Auth URL come from the Neon console; this script cannot create them.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const parse = (text) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^"(.*)"$/, "$1")]),
  );

const example = parse(readFileSync(".env.example", "utf8"));
const existing = existsSync(".env.local") ? parse(readFileSync(".env.local", "utf8")) : {};

const generated = {
  CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  CRON_SECRET: randomBytes(24).toString("base64url"),
  NEON_AUTH_COOKIE_SECRET: randomBytes(32).toString("base64"),
};

const merged = { ...example, ...generated, ...Object.fromEntries(Object.entries(existing).filter(([, v]) => v !== "")) };

const quote = (v) => (/[\s"#]/.test(v) ? JSON.stringify(v) : v);
writeFileSync(".env.local", Object.entries(merged).map(([k, v]) => `${k}=${quote(v)}`).join("\n") + "\n", { mode: 0o600 });
// `mode` only applies when the file is created; tighten a pre-existing file too.
chmodSync(".env.local", 0o600);

const missing = ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "NEON_AUTH_BASE_URL"].filter((k) => !merged[k]);
if (missing.length) {
  console.warn(`.env.local written. Still to fill in from the Neon console: ${missing.join(", ")}`);
} else {
  console.info(".env.local is ready. Next: npm run db:migrate && npm run dev");
}
