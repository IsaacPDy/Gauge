import "server-only";
import { cookies } from "next/headers";
import { CURRENCY_COOKIE, type Display, type DisplayCurrency, displayFor, parseDisplayCurrency, type UsdPhpRate } from "./currency";
import { getUsdPhpRate } from "./fx";

export async function getDisplayCurrency(): Promise<DisplayCurrency> {
  return parseDisplayCurrency((await cookies()).get(CURRENCY_COOKIE)?.value);
}

/** The viewer's chosen currency and the rate it is shown at. */
export async function getDisplay(): Promise<{ display: Display; usdPhp: UsdPhpRate }> {
  const [currency, usdPhp] = await Promise.all([getDisplayCurrency(), getUsdPhpRate()]);
  return { display: displayFor(currency, usdPhp), usdPhp };
}
