export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight text-text ${className}`}>
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
        <rect width="32" height="32" rx="7" fill="var(--accent)" />
        <path d="M7.5 21.5a8.5 8.5 0 0 1 17 0" fill="none" stroke="var(--surface)" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M16 21.5l4.2-6.2" fill="none" stroke="var(--surface)" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="16" cy="21.5" r="2" fill="var(--surface)" />
      </svg>
      Limit Gauge
    </span>
  );
}
