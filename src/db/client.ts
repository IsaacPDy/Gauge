import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";

neonConfig.webSocketConstructor = ws;

export type Db = ReturnType<typeof drizzle<typeof schema>>;

const KEY = Symbol.for("limitgauge.db");
type Global = typeof globalThis & { [KEY]?: Db };

function create(): Db {
  if (typeof window !== "undefined") throw new Error("db must never be used in the browser");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set (see .env.example)");
  const pool = new Pool({ connectionString: url, max: 5 });
  pool.on("error", (e: Error) => console.error("[db] idle client error:", e.message));
  return drizzle(pool, { schema });
}

function get(): Db {
  const g = globalThis as Global;
  return (g[KEY] ??= create()); // one pool per process, also across Next.js hot reloads
}

/** Created on first use, so importing this module never needs DATABASE_URL (builds, unit tests). */
export const db: Db = new Proxy({} as Db, { get: (_target, prop) => Reflect.get(get(), prop) });

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
