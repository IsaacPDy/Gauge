"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Notice } from "@/components/ui";
import { simulate } from "@/lib/engine/simulate";
import { decode, encode, type PresetKey, presetInputs, type SimInputs } from "@/lib/engine/simulate/inputs";
import { SimulatorForm } from "./simulator-form";
import { SimulatorResults } from "./simulator-results";

export function SimulatorView({ initialNotices, now }: { initialNotices: string[]; now: string }) {
  const params = useSearchParams();
  const urlQuery = params.toString();
  // Seed from the live URL rather than server props: on Back, Next.js can restore a cached
  // render whose props describe an older query than the one in the address bar.
  const [inputs, setInputs] = useState(() => decode(Object.fromEntries(params)).inputs);
  const [urlNotices, setUrlNotices] = useState(initialNotices);
  const [month, setMonth] = useState(1);
  const result = useMemo(() => simulate(inputs, { now: new Date(now) }), [inputs, now]);
  const query = encode(inputs);
  const edited = query !== encode(presetInputs(inputs.preset));

  // The query this component last wrote, so its own writes aren't read back as navigation.
  const lastWritten = useRef<string | null>(null);
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  // A write that was never read back (e.g. the page was hidden first) mustn't mask a later visit.
  useEffect(
    () => () => {
      lastWritten.current = null;
    },
    [],
  );

  // Mirror inputs into the URL so a scenario can be bookmarked or shared. The native
  // history API avoids re-running the server component on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      if (window.location.search.slice(1) === query) return;
      lastWritten.current = query;
      window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
    }, 300);
    return () => clearTimeout(id);
  }, [query]);

  // Follow URL changes this component didn't make (a nav link to /simulator, Back/Forward).
  // Our own write is skipped once, even if the user has typed on since it was scheduled.
  useEffect(() => {
    if (urlQuery === lastWritten.current) {
      lastWritten.current = null;
      return;
    }
    if (urlQuery === queryRef.current) return;
    const next = decode(Object.fromEntries(new URLSearchParams(urlQuery)));
    if (encode(next.inputs) === queryRef.current) return;
    setInputs(next.inputs);
    setUrlNotices(next.notices);
    setMonth(1);
  }, [urlQuery]);

  const change = (next: SimInputs) => {
    setUrlNotices([]);
    setInputs(next);
  };

  const choosePreset = (preset: PresetKey) => {
    if (preset === inputs.preset && !edited) return;
    const prompt = preset === inputs.preset ? "Reset to the preset? Your changes will be lost." : "Switch preset? Your changes to the current one will be lost.";
    if (edited && !window.confirm(prompt)) return;
    change(presetInputs(preset));
  };

  const notices = [...urlNotices, ...result.notices];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0">
        <SimulatorForm inputs={inputs} edited={edited} onChange={change} onPreset={choosePreset} />
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
        <SimulatorResults result={result} month={month} onMonth={setMonth} />
      </div>
    </div>
  );
}
