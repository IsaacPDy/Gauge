"use client";

import { useMemo, useState } from "react";
import { useCurrency } from "@/components/currency";
import { Notice } from "@/components/ui";
import { formatUsdAs } from "@/lib/currency";
import { simulate } from "@/lib/engine/simulate";
import { SimulatorForm } from "./simulator-form";
import { SimulatorResults } from "./simulator-results";
import { useSimInputs } from "./use-sim-inputs";

export function SimulatorView({ initialNotices, now }: { initialNotices: string[]; now: string }) {
  const [month, setMonth] = useState(1);
  const sim = useSimInputs(initialNotices, () => setMonth(1));
  const display = useCurrency();
  const result = useMemo(() => simulate(sim.inputs, { now: new Date(now), money: (n) => formatUsdAs(n, display) }), [sim.inputs, now, display]);
  const notices = [...sim.urlNotices, ...result.notices];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0">
        <SimulatorForm inputs={sim.inputs} edited={sim.edited} onChange={sim.change} onPreset={sim.choosePreset} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {notices.length > 0 ? (
          <Notice tone="warn" title="Some settings were adjusted">
            <ul className="list-disc pl-4">
              {notices.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <SimulatorResults result={result} month={month} onMonth={setMonth} query={sim.query} />
      </div>
    </div>
  );
}
