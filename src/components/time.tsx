/** Relative time rendered on the server, with the exact UTC timestamp on hover. */
export function TimeAgo({ iso, prefix }: { iso: string | null | undefined; prefix?: string }) {
  if (!iso) return <span className="text-faint">never</span>;
  const t = new Date(iso);
  return (
    <time dateTime={iso} title={t.toUTCString()} className="whitespace-nowrap">
      {prefix}
      {relative(t)}
    </time>
  );
}

export function relative(t: Date, now = new Date()): string {
  const diff = t.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return diff < 0 ? `${n} ${name}${n === 1 ? "" : "s"} ago` : `in ${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return diff < 0 ? "just now" : "in under a minute";
}

export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" } : { timeZone: "UTC" }),
  });
}
