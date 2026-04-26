"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { exitGuestMode, isGuestMode } from "@/lib/guest-mode";
import { GUEST_USERNAME } from "@/lib/todos/local-repository";

const subscribeNoop = () => () => {};

export default function SettingsPage() {
  const router = useRouter();
  const isGuest = useSyncExternalStore(subscribeNoop, isGuestMode, () => false);
  const [apiUsername, setApiUsername] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const username = isGuest ? GUEST_USERNAME : apiUsername;

  useEffect(() => {
    if (isGuest) return;
    api.auth.status().then(({ data }) => {
      if (data?.isAuthenticated) {
        setApiUsername((data.user as { username: string })?.username ?? "");
      }
    });
  }, [isGuest]);

  async function handleLogout() {
    setLoggingOut(true);
    if (isGuest) {
      exitGuestMode();
    } else {
      await api.auth.logout();
    }
    router.push("/login");
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-text">Settings</h2>
        <p className="text-sm text-text-muted">Manage your account</p>
      </div>

      <section className="mb-6 rounded-lg border border-border-on-surface bg-surface p-4">
        <h3 className="mb-2 text-sm font-medium text-on-surface/60">Account</h3>
        <p className="text-on-surface">{username || "—"}</p>
      </section>

      <section className="rounded-lg border border-border-on-surface bg-surface p-4">
        <h3 className="mb-2 text-sm font-medium text-on-surface/60">Session</h3>
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loggingOut ? "Signing out..." : "Sign Out"}
        </button>
      </section>
    </div>
  );
}
