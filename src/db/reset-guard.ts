// Pure checks for `npm run db:reset` (scripts/db-reset.ts). No database access, so it is unit-tested.

export type ResetGuardResult = { ok: true; host: string } | { ok: false; message: string };

const HOST_FLAG = "--host=";

/**
 * Decides whether a reset may run against `url`. All of these must hold:
 * - the URL parses (it is never printed: it contains credentials);
 * - NEON_BRANCH is "dev" (a label in .env.local, so it only catches honest mistakes);
 * - `--host=<host of the URL>` was typed on the command line, which an inline
 *   `DATABASE_URL_UNPOOLED=<other url> npm run db:reset` cannot satisfy by accident;
 * - `--yes` was given.
 * Refusals name the actual target host (not a secret) and the exact command to retype.
 */
export function checkResetGuard(input: { url: string | undefined; branch: string | undefined; argv: readonly string[] }): ResetGuardResult {
  const { url, branch, argv } = input;
  if (!url) return { ok: false, message: "Set DATABASE_URL_UNPOOLED in .env.local first." };

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { ok: false, message: "Refusing to reset: the database URL is not a valid URL." };
  }
  if (!host) return { ok: false, message: "Refusing to reset: the database URL has no host." };

  if (branch !== "dev") return { ok: false, message: 'Refusing to reset: NEON_BRANCH is not "dev" in .env.local.' };

  const command = `npm run db:reset -- --yes --host=${host}`;
  const typed = argv.find((a) => a.startsWith(HOST_FLAG))?.slice(HOST_FLAG.length);
  if (typed !== host) {
    return {
      ok: false,
      message: `Refusing to reset: this would wipe the app data on ${host}. If that is the dev branch, run:\n  ${command}`,
    };
  }
  if (!argv.includes("--yes")) {
    return { ok: false, message: `Add --yes to confirm that all app data on ${host} will be deleted:\n  ${command}` };
  }
  return { ok: true, host };
}
