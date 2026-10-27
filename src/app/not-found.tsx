import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[60dvh] flex-col items-center justify-center px-4 text-center">
      <p className="text-sm font-semibold text-accent">404</p>
      <h1 className="mt-1 text-lg font-semibold">Not found</h1>
      <p className="mt-1 text-sm text-muted">This page does not exist, or it belongs to a different workspace.</p>
      <Link href="/home" className="mt-4 text-sm text-accent hover:underline">
        Back to home
      </Link>
    </main>
  );
}
