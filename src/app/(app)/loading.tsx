export default function Loading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading">
      <div className="h-6 w-48 rounded bg-surface-2" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-24 rounded-lg bg-surface-2" />
        ))}
      </div>
      <div className="h-64 rounded-lg bg-surface-2" />
    </div>
  );
}
