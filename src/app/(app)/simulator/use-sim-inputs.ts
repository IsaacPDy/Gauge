"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { decode, encode, type PresetKey, presetInputs, type SimInputs } from "@/lib/engine/simulate/inputs";

/**
 * Simulator inputs mirrored into the URL, shared by the simulator and the plan comparison.
 * `onNavigate` runs when the URL changes from outside (a link, Back/Forward).
 */
export function useSimInputs(initialNotices: string[], onNavigate?: () => void) {
  const params = useSearchParams();
  const urlQuery = params.toString();
  // Seed from the live URL rather than server props: on Back, Next.js can restore a cached
  // render whose props describe an older query than the one in the address bar.
  const [inputs, setInputs] = useState(() => decode(Object.fromEntries(params)).inputs);
  const [urlNotices, setUrlNotices] = useState(initialNotices);
  const query = encode(inputs);
  const edited = query !== encode(presetInputs(inputs.preset));

  const navigateRef = useRef(onNavigate);
  useEffect(() => {
    navigateRef.current = onNavigate;
  }, [onNavigate]);

  // The query this hook last wrote, so its own writes aren't read back as navigation.
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

  // Follow URL changes this hook didn't make (a nav link, Back/Forward).
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
    navigateRef.current?.();
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

  return { inputs, query, edited, urlNotices, change, choosePreset };
}
