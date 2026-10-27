export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export interface Cycle {
  start: Date;
  end: Date;
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

export function dayKey(d: Date): string {
  return startOfUtcDay(d).toISOString().slice(0, 10);
}

/**
 * Billing cycle containing `at`, resetting at 00:00 UTC on `anchorDay` (1–28) each month.
 * Anchor days above 28 are rejected because they do not exist in every month.
 */
export function billingCycle(at: Date, anchorDay = 1): Cycle {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 28) {
    throw new RangeError(`anchorDay must be an integer between 1 and 28, got ${anchorDay}`);
  }
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  let start = new Date(Date.UTC(y, m, anchorDay));
  if (start.getTime() > at.getTime()) start = new Date(Date.UTC(y, m - 1, anchorDay));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, anchorDay));
  return { start, end };
}

/** Whole and fractional days from `from` until `to` (never negative). */
export function daysUntil(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / DAY_MS);
}
