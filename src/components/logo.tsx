export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight text-text ${className}`}>
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
        <rect width="32" height="32" rx="7" fill="var(--accent)" />
        <path d="M10.5 22h11a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 10.6 14.2 4 4 0 0 0 10.5 22Z" fill="var(--surface)" />
        <path d="M12 19.5h2l1.5-3 2 5 1.5-2.5h1.5" fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      CloudWatch
    </span>
  );
}
