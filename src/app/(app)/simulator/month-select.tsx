"use client";

import { Select } from "@/components/ui";

export function MonthSelect({
  months,
  value,
  onChange,
  label = "Month",
}: {
  months: number;
  value: number;
  onChange: (month: number) => void;
  /** The select's accessible name, so several month selects on a page can be told apart. */
  label?: string;
}) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-7 w-auto text-xs">
      {Array.from({ length: months }, (_, i) => i + 1).map((m) => (
        <option key={m} value={m}>
          Month {m}
        </option>
      ))}
    </Select>
  );
}
