"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: ReadonlyArray<{ href: string; label: string; match: (p: string) => boolean }> = [
  { href: "/hub", label: "Stats", match: (p) => p === "/hub" },
  { href: "/hub/recurring", label: "Recurring", match: (p) => p.startsWith("/hub/recurring") },
  { href: "/hub/completed", label: "Completed", match: (p) => p.startsWith("/hub/completed") },
  { href: "/hub/settings", label: "Settings", match: (p) => p.startsWith("/hub/settings") },
];

export default function HubTabs() {
  const pathname = usePathname() ?? "";
  return (
    <div
      role="tablist"
      aria-label="Hub sections"
      className="mb-6 flex gap-1 rounded-lg border border-border-on-surface bg-surface p-1"
    >
      {TABS.map((tab) => {
        const isActive = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={isActive}
            className={`flex-1 rounded-md px-3 py-1.5 text-center text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-surface ${
              isActive
                ? "bg-primary font-semibold text-white shadow-md"
                : "font-medium text-on-surface/60 hover:bg-surface-hover hover:text-on-surface"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
