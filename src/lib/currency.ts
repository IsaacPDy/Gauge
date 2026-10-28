import { formatMoney } from "./units";

/** Currencies the viewer can choose to see amounts in. Prices and stored costs stay in USD. */
export const DISPLAY_CURRENCIES = ["USD", "PHP"] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

export const CURRENCY_COOKIE = "cw_currency";

/** Pesos per dollar, and whether it is today's reference rate or the fallback. */
export interface UsdPhpRate {
  rate: number;
  /** Day the rate was published (YYYY-MM-DD); null for the fallback. */
  date: string | null;
  live: boolean;
}

/** A currency to show amounts in, with how many of its units one US dollar buys. */
export interface Display {
  currency: DisplayCurrency;
  rate: number;
}

export const USD_DISPLAY: Display = { currency: "USD", rate: 1 };

export function parseDisplayCurrency(value: string | undefined | null): DisplayCurrency {
  return (DISPLAY_CURRENCIES as readonly string[]).includes(value ?? "") ? (value as DisplayCurrency) : "USD";
}

export function displayFor(currency: DisplayCurrency, usdPhp: UsdPhpRate): Display {
  return currency === "PHP" ? { currency, rate: usdPhp.rate } : USD_DISPLAY;
}

export function convertUsd(amount: number, to: Display): number {
  return amount * to.rate;
}

export function formatUsdAs(amount: number, to: Display): string {
  return formatMoney(convertUsd(amount, to), to.currency);
}

/** A stored cost in its own currency. Only USD is converted; there is no rate for anything else. */
export function formatCost(amount: number, currency: string, to: Display): string {
  return currency === "USD" ? formatUsdAs(amount, to) : formatMoney(amount, currency);
}

export function currencySymbol(c: DisplayCurrency): string {
  return c === "PHP" ? "₱" : "$";
}
