"use client";

// Module-level pub/sub for "the recurring-todo completion log may have
// changed." The stats page subscribes; the todos page notifies after a
// successful manual toggle of a recurring task. This bridges the gap that
// `visibilitychange` doesn't cover — intra-app navigation between /todos and
// /stats keeps the document visible the whole time, so the stats page's
// mount-time fetch can race with a still-in-flight toggle PATCH and lose.
// Broadcasting on PATCH success forces a follow-up fetch that observes the
// committed server state.

const listeners = new Set<() => void>();

export function notifyStatsMayHaveChanged(): void {
  for (const fn of listeners) fn();
}

export function subscribeStatsMayHaveChanged(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
