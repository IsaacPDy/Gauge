"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // Next forwards browser errors to the dev log, so a failure like this can be diagnosed without DevTools.
  useEffect(() => {
    console.error("[app-error]", error.name, error.message, error.digest ?? "(no server digest)");
  }, [error]);
  return (
    <div role="alert" className="mx-auto max-w-md rounded-lg border border-crit/30 bg-crit-soft p-6 text-center">
      <p className="font-medium text-crit">Something went wrong</p>
      <p className="mt-1 text-sm text-text/80">
        The page could not be loaded. Your monitoring data is unaffected.
        {error.digest ? <span className="mt-1 block font-mono text-xs text-muted">Reference: {error.digest}</span> : null}
      </p>
      <Button className="mt-4" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
