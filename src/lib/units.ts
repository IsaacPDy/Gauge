import type { Unit } from "./types";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Binary multiples, labelled the way provider dashboards label them (1 GB = 1024³ bytes). */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes)) return "—";
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const sign = bytes < 0 ? "-" : "";
  return `${sign}${v.toFixed(i === 0 ? 0 : v < 10 ? digits : Math.max(0, digits - 1))} ${BYTE_UNITS[i]}`;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
  return Math.round(n).toLocaleString("en-US");
}

export function formatValue(value: number | null | undefined, unit: Unit | string): string {
  if (value === null || value === undefined) return "—";
  return unit === "bytes" ? formatBytes(value) : formatCount(value);
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatPercent(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

export const GB = 1024 ** 3;
export const MB = 1024 ** 2;

/** Parse "8 GB", "500MB", "1.5k", "100000" into the metric's base unit. */
export function parseQuantity(input: string, unit: Unit | string): number | null {
  const m = input.trim().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const suffix = m[2].toLowerCase();
  if (unit === "bytes") {
    const mult: Record<string, number> = { "": 1, b: 1, kb: 1024, mb: MB, gb: GB, tb: 1024 * GB };
    return suffix in mult ? Math.round(n * mult[suffix]) : null;
  }
  const mult: Record<string, number> = { "": 1, k: 1e3, m: 1e6, b: 1e9 };
  return suffix in mult ? Math.round(n * mult[suffix]) : null;
}

/** Round axis ticks in display units (e.g. 0, 200 MB, 400 MB, 600 MB) covering `max`. */
export function niceTicks(max: number, unit: Unit | string, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  let scale = 1;
  if (unit === "bytes") {
    while (max / scale >= 1024 && scale < 1024 ** 5) scale *= 1024;
  }
  const scaled = max / scale;
  const raw = scaled / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v <= scaled + step * 0.001; v += step) ticks.push(v * scale);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step * scale);
  return ticks;
}
