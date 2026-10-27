"use client";

import { useEffect, useMemo, useState } from "react";
import { Notice } from "@/components/ui";
import { simulate } from "@/lib/engine/simulate";
import { encode, type PresetKey, presetInputs, type SimInputs } from "@/lib/engine/simulate/inputs";

export function SimulatorView({ initialInputs, initialNotices }: { initialInputs: SimInputs; initialNotices: string[] }) {
  const [inputs, setInputs] = useState(initialInputs);
  const [urlNotices, setUrlNotices] = useState(initialNotices);
  const [month, setMonth] = useState(1);
  const result = useMemo(() => simulate(inputs), [inputs]);
  const query = encode(inputs);
  const edited = query !== encode(presetInputs(inputs.preset));

  // Mirror inputs into the URL so a scenario can be bookmarked or shared. The native
  // history API avoids re-running the server component on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      const url = `${window.location.pathname}?${query}`;
      if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
    }, 300);
    return () => clearTimeout(id);
  }, [query]);

  const change = (next: SimInputs) => {
    setUrlNotices([]);
    setInputs(next);
  };

  const choosePreset = (preset: PresetKey) => {
    if (preset === inputs.preset && !edited) return;
    if (edited && !window.confirm("Switch preset? Your changes to the current one will be lost.")) return;
    change(presetInputs(preset));
  };

  const notices = [...urlNotices, ...result.notices];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0">
        {/* Replaced by <SimulatorForm> in Task 12. */}
        <pre className="text-xs">{JSON.stringify({ edited, preset: inputs.preset, choosePreset: typeof choosePreset, change: typeof change }, null, 2)}</pre>
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
        {/* Replaced by <SimulatorResults> in Task 13. */}
        <pre className="text-xs">{JSON.stringify({ month, setMonth: typeof setMonth, total: result.months[0]?.total }, null, 2)}</pre>
      </div>
    </div>
  );
}
