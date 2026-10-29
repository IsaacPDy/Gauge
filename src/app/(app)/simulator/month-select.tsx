"use client";

import { Select } from "@/components/ui";

export function MonthSelect({ months, value, onChange }: { months: number; value: number; onChange: (month: number) => void }) {
  return (
    <Select aria-label="Month" value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-7 w-auto text-xs">
      {Array.from({ length: months }, (_, i) => i + 1).map((m) => (
        <option key={m} value={m}>
          Month {m}
        </option>
      ))}
    </Select>
  );
}
