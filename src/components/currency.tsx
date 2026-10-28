"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { createContext, useContext, useMemo, useState, useTransition } from "react";
import { CURRENCY_COOKIE, DISPLAY_CURRENCIES, type Display, type DisplayCurrency, displayFor, USD_DISPLAY, type UsdPhpRate } from "@/lib/currency";

const CurrencyContext = createContext<{ display: Display; usdPhp: UsdPhpRate | null; setCurrency: (c: DisplayCurrency) => void }>({
  display: USD_DISPLAY,
  usdPhp: null,
  setCurrency: () => {},
});

/** Seeded from the cookie and the server's rate so the first render matches hydration. */
export function CurrencyProvider({ initial, usdPhp, children }: { initial: DisplayCurrency; usdPhp: UsdPhpRate; children: React.ReactNode }) {
  const router = useRouter();
  const [currency, setState] = useState(initial);
  const [, startTransition] = useTransition();
  const display = useMemo(() => displayFor(currency, usdPhp), [currency, usdPhp]);
  const setCurrency = (c: DisplayCurrency) => {
    setState(c);
    document.cookie = `${CURRENCY_COOKIE}=${c}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    // Server-rendered pages format money too, so re-render them with the new cookie.
    startTransition(() => router.refresh());
  };
  return <CurrencyContext.Provider value={{ display, usdPhp, setCurrency }}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): Display {
  return useContext(CurrencyContext).display;
}

function rateNote(r: UsdPhpRate | null): string {
  if (!r) return "Amounts are priced in USD.";
  const rate = `₱${r.rate.toLocaleString("en-US", { maximumFractionDigits: 2 })} = $1`;
  return r.live
    ? `Amounts are priced in USD. Pesos use the ECB reference rate of ${rate} (${r.date}).`
    : `Amounts are priced in USD. The live rate is unavailable, so pesos use an approximate ${rate}.`;
}

export function CurrencyToggle() {
  const { display, usdPhp, setCurrency } = useContext(CurrencyContext);
  return (
    <div role="group" aria-label="Currency" title={rateNote(usdPhp)} className="inline-flex h-8 items-center rounded-md border border-border p-0.5 text-xs font-medium">
      {DISPLAY_CURRENCIES.map((c) => (
        <button
          key={c}
          type="button"
          aria-pressed={display.currency === c}
          onClick={() => display.currency !== c && setCurrency(c)}
          className={clsx("h-full rounded px-2 transition-colors", display.currency === c ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text")}
        >
          {c}
        </button>
      ))}
    </div>
  );
}
