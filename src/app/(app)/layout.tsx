import { LogOut } from "lucide-react";
import Link from "next/link";
import { CurrencyProvider, CurrencyToggle } from "@/components/currency";
import { Logo } from "@/components/logo";
import { InboxLink, SideNav } from "@/components/nav";
import { getDisplay } from "@/lib/currency-server";
import { getSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { supabase, user, workspace } = await getSession();
  const [alerts, unread, { display, usdPhp }] = await Promise.all([
    supabase.from("alerts").select("id", { count: "exact", head: true }).eq("status", "open"),
    supabase
      .from("notification_deliveries")
      .select("id", { count: "exact", head: true })
      .eq("channel", "in_app")
      .eq("status", "sent")
      .is("read_at", null),
    getDisplay(),
  ]);

  return (
    <CurrencyProvider initial={display.currency} usdPhp={usdPhp}>
      <div className="flex min-h-dvh flex-col md:flex-row">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
          Skip to content
        </a>
        <aside className="border-b border-border bg-surface md:sticky md:top-0 md:h-dvh md:w-56 md:shrink-0 md:border-r md:border-b-0">
          <div className="flex items-center justify-between px-4 py-3 md:py-4">
            <Link href="/home" aria-label="Limit Gauge home">
              <Logo />
            </Link>
            <div className="flex items-center gap-2 md:hidden">
              <CurrencyToggle />
              <InboxLink unread={unread.count ?? 0} />
            </div>
          </div>
          <div className="px-2 pb-2 md:px-3">
            <SideNav alertCount={alerts.count ?? 0} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="hidden items-center justify-between gap-4 border-b border-border bg-surface px-6 py-2.5 md:flex">
            <p className="truncate text-sm text-muted">
              Workspace <span className="font-medium text-text">{workspace.name}</span>
            </p>
            <div className="flex items-center gap-2">
              <CurrencyToggle />
              <InboxLink unread={unread.count ?? 0} />
              <span className="hidden max-w-48 truncate text-xs text-muted lg:inline">{user.email}</span>
              <form action="/auth/signout" method="post">
                <button
                  type="submit"
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut className="size-4" aria-hidden />
                </button>
              </form>
            </div>
          </header>
          <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6">
            {children}
          </main>
        </div>
      </div>
    </CurrencyProvider>
  );
}
