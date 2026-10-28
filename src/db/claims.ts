import { eq, inArray, sql } from "drizzle-orm";
import { db } from "./client";
import { notification_deliveries, provider_connections } from "./schema";
import type { Row } from "./types";

// The claim_* SQL functions lock and stamp rows atomically (FOR UPDATE SKIP LOCKED). We take
// only the ids from them and re-read the rows through Drizzle so they have the app's row shape.

const idsOf = (res: { rows: unknown[] }) => (res.rows as { id: string }[]).map((r) => r.id);

export async function claimDueConnections(limit: number): Promise<Row<"provider_connections">[]> {
  const ids = idsOf(await db.execute(sql`select id from public.claim_due_connections(${limit})`));
  return ids.length ? db.select().from(provider_connections).where(inArray(provider_connections.id, ids)) : [];
}

export async function claimConnection(connectionId: string): Promise<Row<"provider_connections"> | undefined> {
  const ids = idsOf(await db.execute(sql`select id from public.claim_connection(${connectionId}::uuid)`));
  if (!ids.length) return undefined;
  return (await db.select().from(provider_connections).where(eq(provider_connections.id, ids[0])))[0];
}

export async function claimDueDeliveries(limit: number): Promise<Row<"notification_deliveries">[]> {
  const ids = idsOf(await db.execute(sql`select id from public.claim_due_deliveries(${limit})`));
  return ids.length ? db.select().from(notification_deliveries).where(inArray(notification_deliveries.id, ids)) : [];
}
