import { convertUsd, type Display, USD_DISPLAY } from "../../currency";
import { formatCount } from "../../units";

/** "21.6 GB", "350 GB", "50.0K users". Fractions are kept for small amounts. */
export function formatAmount(n: number, unit: string): string {
  const abs = Math.abs(n);
  const num = abs < 100 && !Number.isInteger(n) ? n.toFixed(abs < 10 ? 2 : 1) : formatCount(n);
  return unit ? `${num} ${unit}` : num;
}

export function formatQps(n: number): string {
  return Math.abs(n) < 10 ? n.toFixed(1) : formatCount(n);
}

/** Per-user amounts (given in USD): small ones such as $0.00123 keep 3 significant digits, which cents rounding would hide. */
export function formatPerUser(usd: number, display: Display = USD_DISPLAY): string {
  const n = convertUsd(usd, display);
  const opts: Intl.NumberFormatOptions = Math.abs(n) < 1 ? { maximumSignificantDigits: 3 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return new Intl.NumberFormat("en-US", { style: "currency", currency: display.currency, ...opts }).format(n);
}
