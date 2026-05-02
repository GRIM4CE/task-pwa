"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { api, type VacationPeriod } from "@/lib/api-client";
import { exitGuestMode, isGuestMode } from "@/lib/guest-mode";
import { notifyStatsMayHaveChanged } from "@/lib/stats-events";
import { GUEST_USERNAME, localTodoRepository } from "@/lib/todos/local-repository";

const subscribeNoop = () => () => {};

export default function SettingsPage() {
  const router = useRouter();
  const isGuest = useSyncExternalStore(subscribeNoop, isGuestMode, () => false);
  const [apiUsername, setApiUsername] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [vacation, setVacation] = useState<VacationPeriod | null>(null);
  const [vacationLoading, setVacationLoading] = useState(true);
  const [vacationToggling, setVacationToggling] = useState(false);
  const [vacationError, setVacationError] = useState<string | null>(null);
  const username = isGuest ? GUEST_USERNAME : apiUsername;

  useEffect(() => {
    if (isGuest) return;
    api.auth.status().then(({ data }) => {
      if (data?.isAuthenticated) {
        setApiUsername((data.user as { username: string })?.username ?? "");
      }
    });
  }, [isGuest]);

  useEffect(() => {
    let cancelled = false;
    const load = isGuest
      ? localTodoRepository.vacation()
      : api.vacation.get();
    load.then(({ data }) => {
      if (cancelled) return;
      setVacation(data?.active ?? null);
      setVacationLoading(false);
    });
    return () => {
      cancelled = true;
    };
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

  async function handleToggleVacation() {
    setVacationToggling(true);
    setVacationError(null);
    const action = vacation ? "end" : "start";
    const { data, error } = isGuest
      ? await localTodoRepository.setVacation(action)
      : await api.vacation.set(action);
    setVacationToggling(false);
    if (error || !data) {
      setVacationError(error ?? "Could not update vacation");
      return;
    }
    setVacation(data.active);
    // Stats page caches its last fetch; broadcast so it refetches and the
    // yellow neutralization shows up immediately.
    notifyStatsMayHaveChanged();
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

      <section className="mb-6 rounded-lg border border-border-on-surface bg-surface p-4">
        <h3 className="mb-1 text-sm font-medium text-on-surface/60">Vacation</h3>
        <p className="mb-3 text-sm text-on-surface/70">
          Pause habit tracking. Missed recurring days and slips on avoid todos
          count as neutral instead of broken streaks. Completions still count
          normally.
        </p>
        {vacation && (
          <p className="mb-3 text-sm text-on-surface">
            On vacation since{" "}
            <span className="font-medium">
              {new Date(vacation.startsAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            .
          </p>
        )}
        <button
          onClick={handleToggleVacation}
          disabled={vacationLoading || vacationToggling}
          className={`rounded-lg px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed ${
            vacation ? "bg-primary" : "bg-warning"
          }`}
        >
          {vacationToggling
            ? vacation
              ? "Ending vacation..."
              : "Starting vacation..."
            : vacation
              ? "End vacation"
              : "Start vacation"}
        </button>
        {vacationError && (
          <p className="mt-2 text-sm text-danger">{vacationError}</p>
        )}
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
