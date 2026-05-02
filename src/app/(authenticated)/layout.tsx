"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api-client";
import { isGuestMode } from "@/lib/guest-mode";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";

const subscribeNoop = () => () => {};

function themeForUsername(username: string): string | null {
  if (username.startsWith("juliette")) return "juliette";
  return null;
}

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const isGuest = useSyncExternalStore(subscribeNoop, isGuestMode, () => false);
  const [authChecked, setAuthChecked] = useState(false);
  const checked = isGuest || authChecked;

  useEffect(() => {
    if (isGuest) return;
    api.auth.status().then(({ data }) => {
      if (data?.needsSetup) {
        router.replace("/setup");
      } else if (!data?.isAuthenticated) {
        router.replace("/login");
      } else {
        const username = (data.user as { username?: string } | null)?.username ?? "";
        const theme = themeForUsername(username);
        if (theme) {
          document.documentElement.dataset.theme = theme;
        } else {
          delete document.documentElement.dataset.theme;
        }
        setAuthChecked(true);
      }
    });
  }, [router, isGuest]);

  if (!checked) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const joinedActive = pathname === "/todos" || pathname?.startsWith("/todos/joined");
  const personalActive = pathname?.startsWith("/todos/personal");
  const statsActive = pathname?.startsWith("/stats");
  const settingsActive = pathname?.startsWith("/settings");

  return (
    <div className="min-h-screen flex flex-col">
      <header
        className="border-b border-border-on-surface bg-surface"
        style={{
          marginTop: "calc(-1 * env(safe-area-inset-top))",
          paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)",
        }}
      >
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 pb-3">
          <Link
            href="/todos/joined"
            className="shrink-0 text-lg font-semibold text-on-surface hover:text-primary"
          >
            Todo
          </Link>
          <nav className="flex min-w-0 flex-1 items-center justify-end gap-2" aria-label="Primary">
            <Link
              href="/todos/joined"
              aria-current={joinedActive ? "page" : undefined}
              className={`px-2 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
                joinedActive
                  ? "font-medium text-on-surface underline decoration-primary decoration-2 underline-offset-4"
                  : "text-on-surface/60 hover:text-on-surface hover:underline hover:underline-offset-4"
              }`}
            >
              Joined
            </Link>
            <Link
              href="/todos/personal"
              aria-current={personalActive ? "page" : undefined}
              className={`px-2 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
                personalActive
                  ? "font-medium text-on-surface underline decoration-primary decoration-2 underline-offset-4"
                  : "text-on-surface/60 hover:text-on-surface hover:underline hover:underline-offset-4"
              }`}
            >
              Personal
            </Link>
            <ThemeSwitcher />
            <Link
              href="/stats"
              aria-label="Repeat task stats"
              aria-current={statsActive ? "page" : undefined}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
                statsActive
                  ? "bg-surface-hover text-on-surface"
                  : "text-on-surface/60 hover:bg-surface-hover hover:text-on-surface"
              }`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path d="M3 17a1 1 0 011-1h1V8a1 1 0 112 0v8h2V5a1 1 0 112 0v11h2v-6a1 1 0 112 0v6h1a1 1 0 110 2H4a1 1 0 01-1-1z" />
              </svg>
            </Link>
            <Link
              href="/settings"
              aria-label="Settings"
              aria-current={settingsActive ? "page" : undefined}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
                settingsActive
                  ? "bg-surface-hover text-on-surface"
                  : "text-on-surface/60 hover:bg-surface-hover hover:text-on-surface"
              }`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
                  clipRule="evenodd"
                />
              </svg>
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
