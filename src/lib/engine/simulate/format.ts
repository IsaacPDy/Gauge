import { formatCount } from "../../units";

/** "21.60 GB", "350 GB", "50.0K users". Fractions are kept for small amounts. */
export function formatAmount(n: number, unit: string): string {
  const abs = Math.abs(n);
  const num = abs < 100 && !Number.isInteger(n) ? n.toFixed(abs < 10 ? 2 : 1) : formatCount(n);
  return unit ? `${num} ${unit}` : num;
}

export function formatQps(n: number): string {
  return Math.abs(n) < 10 ? n.toFixed(1) : formatCount(n);
}

/** Small per-user amounts such as $0.0012, which cents rounding would hide. */
export function formatPerUser(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 3 }).format(n);
}
