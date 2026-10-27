"use client";

import clsx from "clsx";
import { Bell, Boxes, Calculator, Cloud, Gauge, Home, Settings, Siren } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/applications", label: "Applications", icon: Boxes },
  { href: "/providers", label: "Providers", icon: Cloud },
  { href: "/usage", label: "Usage", icon: Gauge },
  { href: "/simulator", label: "Simulator", icon: Calculator },
  { href: "/alerts", label: "Alerts", icon: Siren },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function SideNav({ alertCount }: { alertCount: number }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = path === href || path.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
              active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
            {href === "/alerts" && alertCount > 0 ? (
              <span className="num ml-auto rounded-full bg-crit px-1.5 text-[11px] leading-4 font-semibold text-white" aria-label={`${alertCount} active`}>
                {alertCount}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function InboxLink({ unread }: { unread: number }) {
  return (
    <Link
      href="/alerts?tab=inbox"
      className="relative inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
    >
      <Bell className="size-4" aria-hidden />
      {unread > 0 ? (
        <span className="num absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-crit px-1 text-center text-[10px] leading-4 font-semibold text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </Link>
  );
}
