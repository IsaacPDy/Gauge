import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="mb-8">
        <Logo className="text-lg" />
      </div>
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-sm">{children}</div>
      <p className="mt-6 max-w-sm text-center text-xs text-faint">
        CloudWatch monitors usage and sends early warnings. It does not cap spending or change your cloud resources.
      </p>
    </main>
  );
}
