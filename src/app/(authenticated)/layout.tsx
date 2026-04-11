"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [username, setUsername] = useState("");

  useEffect(() => {
    api.auth.status().then(({ data }) => {
      if (data?.needsSetup) {
        router.replace("/setup");
      } else if (!data?.isAuthenticated) {
        router.replace("/login");
      } else {
        setUsername((data.user as { username: string })?.username ?? "");
        setChecked(true);
      }
    });
  }, [router]);

  async function handleLogout() {
    await api.auth.logout();
    router.push("/login");
  }

  if (!checked) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
          <h1 className="text-lg font-semibold text-text">Home Control</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-text-muted">{username}</span>
            <button
              onClick={handleLogout}
              className="rounded-lg px-3 py-1.5 text-sm text-text-muted hover:bg-surface-hover hover:text-text"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
