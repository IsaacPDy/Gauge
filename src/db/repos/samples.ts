import { and, asc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../client";
import { usage_samples } from "../schema";
import type { WorkspaceScope } from "../scope";

/**
 * Usage samples from `from` onwards. Scope filters:
 * - resourceIds + accountIds: samples for either set
 * - resourceIds only: resource-level samples
 * - accountIds only: account-level samples (no resource)
 * An empty id list matches nothing, as before.
 */
export function loadSamples(
  s: WorkspaceScope,
  opts: { metricKeys?: string[]; resourceIds?: string[]; accountIds?: string[]; from: Date },
) {
  const where: (SQL | undefined)[] = [eq(usage_samples.workspace_id, s.workspaceId), gte(usage_samples.bucket_start, opts.from.toISOString())];
  if (opts.metricKeys?.length) where.push(inArray(usage_samples.metric_key, opts.metricKeys));
  if (opts.resourceIds && opts.accountIds) {
    const either = [
      opts.resourceIds.length ? inArray(usage_samples.resource_id, opts.resourceIds) : undefined,
      opts.accountIds.length ? inArray(usage_samples.account_id, opts.accountIds) : undefined,
    ].filter((c): c is SQL => c !== undefined);
    where.push(either.length ? or(...either)! : sql`false`);
  } else if (opts.resourceIds) {
    where.push(opts.resourceIds.length ? inArray(usage_samples.resource_id, opts.resourceIds) : sql`false`);
  } else if (opts.accountIds) {
    where.push(isNull(usage_samples.resource_id));
    where.push(opts.accountIds.length ? inArray(usage_samples.account_id, opts.accountIds) : sql`false`);
  }
  return db
    .select({
      metric_key: usage_samples.metric_key,
      resource_id: usage_samples.resource_id,
      account_id: usage_samples.account_id,
      bucket_start: usage_samples.bucket_start,
      bucket_end: usage_samples.bucket_end,
      value: usage_samples.value,
      observed_at: usage_samples.observed_at,
      collected_at: usage_samples.collected_at,
      quality: usage_samples.quality,
      source: usage_samples.source,
      dimensions: usage_samples.dimensions,
    })
    .from(usage_samples)
    .where(and(...where))
    .orderBy(asc(usage_samples.bucket_start), asc(usage_samples.id));
}
