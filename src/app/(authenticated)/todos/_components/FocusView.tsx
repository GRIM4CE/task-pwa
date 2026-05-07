"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type TodoDTO } from "@/lib/api-client";
import {
  isCompletedTodoExpired,
  isRecurringResetDue,
  isScheduledOccurrenceOpen,
  isScheduledRecurrence,
  mostRecentScheduledDate,
} from "@/lib/recurrence";
import { notifyStatsMayHaveChanged } from "@/lib/stats-events";
import {
  cascadeCompleteChildren,
  sortSubtasks,
  sortTodos,
} from "@/lib/todos/domain";
import { useTodoRepository } from "@/lib/todos/use-todo-repository";

type Todo = TodoDTO;

const DISMISS_KEY_PREFIX = "focus.dismissed.";

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

// True when this row counts as part of today's daily routine: a daily-recurring
// row, or a scheduled-recurring row whose current occurrence falls on today.
function isOnTodaysRoutine(t: Todo, nowMs: number): boolean {
  if (t.recurrence === "daily") return true;
  if (isScheduledRecurrence(t.recurrence)) {
    const occ = mostRecentScheduledDate(t, nowMs);
    return occ !== null && isSameLocalDay(occ.getTime(), nowMs);
  }
  return false;
}

// Ad hoc today entries: one-off and weekly-recurring rows manually pinned to
// today, plus subtasks pinned to today. Distinct from routine because the
// user has to pick today each time (weekly+pin doesn't auto-place by weekday).
function isExtraOnToday(t: Todo): boolean {
  if (t.pinnedTo !== "day") return false;
  if (t.parentId !== null) return true;
  return t.recurrence === null || t.recurrence === "weekly";
}

function isCompletedToday(t: Todo, nowMs: number): boolean {
  return (
    t.completed &&
    t.lastCompletedAt !== null &&
    isSameLocalDay(t.lastCompletedAt, nowMs)
  );
}

// True when the row was skipped from Focus today. Skipping defers the row to
// the next local day regardless of recurrence cadence — daily, weekly, and
// scheduled rows all reappear tomorrow rather than waiting for the next
// natural occurrence. Yesterday's skip stamp falls out of this check on the
// midnight rollover (nowMs ticks forward) so the row surfaces again.
function isFocusSkippedToday(t: Todo, nowMs: number): boolean {
  return (
    t.lastFocusSkippedAt !== null &&
    isSameLocalDay(t.lastFocusSkippedAt, nowMs)
  );
}

function readDismissed(dayKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  // Sweep stale per-day entries from prior sessions before reading today's,
  // so the localStorage footprint stays bounded to a single day's set.
  try {
    const todayKey = `${DISMISS_KEY_PREFIX}${dayKey}`;
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(DISMISS_KEY_PREFIX) && k !== todayKey) {
        stale.push(k);
      }
    }
    stale.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // ignore — sweep is best-effort.
  }
  try {
    const raw = window.localStorage.getItem(`${DISMISS_KEY_PREFIX}${dayKey}`);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function writeDismissed(dayKey: string, ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `${DISMISS_KEY_PREFIX}${dayKey}`,
      JSON.stringify([...ids])
    );
  } catch {
    // localStorage unavailable (private mode quota, etc.); dismissals just
    // won't persist across reloads.
  }
}

export default function FocusView() {
  const repo = useTodoRepository();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddTitle, setQuickAddTitle] = useState("");
  const [quickAddSubmitting, setQuickAddSubmitting] = useState(false);
  const quickAddInputRef = useRef<HTMLInputElement>(null);
  // Tracks "now" for visibility filters tied to local-day boundaries — same
  // pattern as TodoListView. Bumped on visibilitychange and once a minute so a
  // scheduled row's occurrence window flips without a manual refresh.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const resettingRef = useRef<Set<string>>(new Set());
  const expiringRef = useRef<Set<string>>(new Set());
  const pendingToggleRef = useRef<Set<string>>(new Set());
  const recentlyToggledRef = useRef(false);
  // Per-id in-flight guard for the Skip action. Without it, a double-tap fires
  // two PATCHes and the second request's rollback snapshot already contains
  // the optimistic skip — a server error then leaves the row in a half-applied
  // state. Mirrors pendingToggleRef.
  const pendingSkipRef = useRef<Set<string>>(new Set());
  // Skip undo: surface a 5s toast after a successful skip so an accidental tap
  // can be reverted. `kind` lets the undo handler send the right inverse patch
  // — recurring rows reset lastFocusSkippedAt, unpinned rows get re-pinned.
  const [pendingSkipUndo, setPendingSkipUndo] = useState<
    | { id: string; title: string; kind: "skip" | "unpin" }
    | null
  >(null);
  const skipUndoTimerRef = useRef<number | null>(null);
  const todayKey = localDayKey(nowMs);
  // Lazy-initialize from localStorage so previously-dismissed suggestions
  // don't flash on first paint after a reload. The effect below still picks
  // up the day rolling over (e.g. the once-a-minute nowMs tick crossing
  // midnight) so a stale set from yesterday gets replaced.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() =>
    readDismissed(localDayKey(Date.now()))
  );

  useEffect(() => {
    setDismissedIds(readDismissed(todayKey));
  }, [todayKey]);

  const expireCompleted = useCallback(
    async (list: Todo[]) => {
      const now = Date.now();
      const toDelete = list.filter(
        (t) =>
          t.parentId === null &&
          t.completed &&
          t.recurrence === null &&
          !expiringRef.current.has(t.id) &&
          isCompletedTodoExpired(t.lastCompletedAt, now)
      );
      if (toDelete.length === 0) return;
      toDelete.forEach((t) => expiringRef.current.add(t.id));
      const results = await Promise.all(
        toDelete.map((t) =>
          repo
            .delete(t.id)
            .then((r) => ({ id: t.id, ok: r.data?.success === true }))
        )
      );
      const deletedIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
      if (deletedIds.size > 0) {
        setTodos((prev) =>
          prev.filter(
            (t) =>
              !deletedIds.has(t.id) &&
              !(t.parentId !== null && deletedIds.has(t.parentId))
          )
        );
      }
      toDelete.forEach((t) => expiringRef.current.delete(t.id));
    },
    [repo]
  );

  const resetDueRecurring = useCallback(
    async (list: Todo[]) => {
      const now = Date.now();
      const due = list.filter(
        (t) =>
          t.completed &&
          t.recurrence !== null &&
          !resettingRef.current.has(t.id) &&
          isRecurringResetDue(t, now)
      );
      if (due.length === 0) return;
      due.forEach((t) => resettingRef.current.add(t.id));
      const results = await Promise.all(
        due.map((t) => repo.update(t.id, { completed: false, autoReset: true }))
      );
      setTodos((prev) => {
        const next = [...prev];
        for (const { data } of results) {
          if (!data) continue;
          const i = next.findIndex((t) => t.id === data.id);
          if (i !== -1) next[i] = data;
        }
        return next;
      });
      due.forEach((t) => resettingRef.current.delete(t.id));
    },
    [repo]
  );

  const loadTodos = useCallback(async () => {
    const { data } = await repo.list();
    if (data) {
      setTodos(data);
      resetDueRecurring(data);
      expireCompleted(data);
    }
    setLoading(false);
  }, [repo, resetDueRecurring, expireCompleted]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTodos();
  }, [loadTodos]);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        setNowMs(Date.now());
        loadTodos();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [loadTodos]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  async function handlePinSuggestion(todo: Todo) {
    const originalPin = todo.pinnedTo;
    setTodos((prev) =>
      prev.map((t) => (t.id === todo.id ? { ...t, pinnedTo: "day" } : t))
    );
    const { data, error } = await repo.update(todo.id, { pinnedTo: "day" });
    if (error) {
      // Roll back only this row's pin — a snapshot of the full list would
      // clobber any unrelated state changes (toggle, refetch, another pin)
      // that landed while this request was in flight.
      setTodos((prev) =>
        prev.map((t) => (t.id === todo.id ? { ...t, pinnedTo: originalPin } : t))
      );
      return;
    }
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
    }
  }

  async function handleQuickAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = quickAddTitle.trim();
    if (!trimmed || quickAddSubmitting) return;
    setQuickAddSubmitting(true);
    const { data } = await repo.create({ title: trimmed, pinnedTo: "day" });
    setQuickAddSubmitting(false);
    if (data) {
      setTodos((prev) => [...prev, data]);
      setQuickAddTitle("");
      setQuickAddOpen(false);
    }
  }

  function handleDismissSuggestion(todo: Todo) {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(todo.id);
      writeDismissed(todayKey, next);
      return next;
    });
  }

  async function handleToggle(todo: Todo) {
    if (recentlyToggledRef.current) return;
    recentlyToggledRef.current = true;
    window.setTimeout(() => {
      recentlyToggledRef.current = false;
    }, 300);
    if (pendingToggleRef.current.has(todo.id)) return;
    pendingToggleRef.current.add(todo.id);

    const next = !todo.completed;
    const previous = todos;
    setTodos((prev) => {
      let updated = prev.map((t) =>
        t.id === todo.id
          ? { ...t, completed: next, lastCompletedAt: next ? Date.now() : null }
          : t
      );
      // Mirror the server-side cascade so day-pinned subtasks of a completed
      // parent disappear from Focus immediately, not on next refetch.
      if (next && todo.parentId === null) {
        updated = cascadeCompleteChildren(updated, todo.id);
      }
      return updated;
    });
    const { data, error } = await repo.update(todo.id, { completed: next });
    pendingToggleRef.current.delete(todo.id);
    if (error) {
      setTodos(previous);
      return;
    }
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
      // Recurring toggles change the completion log that feeds /stats. Notify
      // so a mounted stats page refetches post-commit instead of trusting its
      // mount-race snapshot.
      if (data.recurrence !== null && data.parentId === null) {
        notifyStatsMayHaveChanged();
      }
    }
  }

  function clearSkipUndoTimer() {
    if (skipUndoTimerRef.current !== null) {
      window.clearTimeout(skipUndoTimerRef.current);
      skipUndoTimerRef.current = null;
    }
  }

  function showSkipUndo(id: string, title: string, kind: "skip" | "unpin") {
    clearSkipUndoTimer();
    setPendingSkipUndo({ id, title, kind });
    skipUndoTimerRef.current = window.setTimeout(() => {
      skipUndoTimerRef.current = null;
      setPendingSkipUndo((prev) => (prev?.id === id ? null : prev));
    }, 5000);
  }

  function dismissSkipUndo() {
    clearSkipUndoTimer();
    setPendingSkipUndo(null);
  }

  useEffect(() => {
    return () => {
      if (skipUndoTimerRef.current !== null) {
        window.clearTimeout(skipUndoTimerRef.current);
        skipUndoTimerRef.current = null;
      }
    };
  }, []);

  // Skip the row from today's Focus. Recurring rows get a lastFocusSkippedAt
  // stamp so they reappear tomorrow regardless of recurrence cadence; non-
  // recurring rows just clear `pinnedTo` (the user's pin to today is what put
  // them on Focus in the first place). Both kinds show a 5s undo toast.
  async function handleSkip(todo: Todo) {
    if (pendingSkipRef.current.has(todo.id)) return;
    pendingSkipRef.current.add(todo.id);
    const isRecurring = todo.recurrence !== null;
    // Snapshot just the fields this patch will mutate so an error rolls back
    // only this row — restoring the full `todos` snapshot would clobber any
    // unrelated state changes (toggle, reset, suggestion pin) that landed
    // while the request was in flight. Same pattern as handlePinSuggestion.
    const originalSkipStamp = todo.lastFocusSkippedAt;
    const originalPin = todo.pinnedTo;
    setTodos((prev) =>
      prev.map((t) =>
        t.id === todo.id
          ? isRecurring
            ? { ...t, lastFocusSkippedAt: Date.now() }
            : { ...t, pinnedTo: null }
          : t
      )
    );
    const patch = isRecurring ? { focusSkip: true } : { pinnedTo: null };
    const { data, error } = await repo.update(todo.id, patch);
    pendingSkipRef.current.delete(todo.id);
    if (error) {
      setTodos((prev) =>
        prev.map((t) =>
          t.id === todo.id
            ? isRecurring
              ? { ...t, lastFocusSkippedAt: originalSkipStamp }
              : { ...t, pinnedTo: originalPin }
            : t
        )
      );
      return;
    }
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
    }
    showSkipUndo(todo.id, todo.title, isRecurring ? "skip" : "unpin");
  }

  async function handleUndoSkip() {
    const pending = pendingSkipUndo;
    if (!pending) return;
    dismissSkipUndo();
    const patch =
      pending.kind === "skip"
        ? { focusSkip: false }
        : { pinnedTo: "day" as const };
    // Snapshot the row's current pre-undo values so we can revert if the
    // request fails. Without this, a failed undo leaves the UI showing the
    // restored row even though the server still has the skip stamped — the
    // next refetch would silently flip it back and look like a regression.
    const current = todos.find((t) => t.id === pending.id);
    const originalSkipStamp = current?.lastFocusSkippedAt ?? null;
    const originalPin = current?.pinnedTo ?? null;
    setTodos((prev) =>
      prev.map((t) =>
        t.id === pending.id
          ? pending.kind === "skip"
            ? { ...t, lastFocusSkippedAt: null }
            : { ...t, pinnedTo: "day" }
          : t
      )
    );
    const { data, error } = await repo.update(pending.id, patch);
    if (error) {
      setTodos((prev) =>
        prev.map((t) =>
          t.id === pending.id
            ? pending.kind === "skip"
              ? { ...t, lastFocusSkippedAt: originalSkipStamp }
              : { ...t, pinnedTo: originalPin }
            : t
        )
      );
      return;
    }
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
    }
  }

  // Today: daily-recurring "do" rows + anything pinned to the day + scheduled
  // rows whose current occurrence is open (e.g. an "every Wednesday" todo on
  // a Wednesday it hasn't been completed yet). Across both scopes. Pinned-
  // to-week takes precedence on legacy rows so a recurring row pinned to the
  // week stays out of focus.
  const topLevelToday = sortTodos(
    todos.filter(
      (t) =>
        t.parentId === null &&
        t.kind === "do" &&
        !t.completed &&
        t.pinnedTo !== "week" &&
        !isFocusSkippedToday(t, nowMs) &&
        (t.recurrence === "daily" ||
          t.pinnedTo === "day" ||
          (isScheduledRecurrence(t.recurrence) &&
            isScheduledOccurrenceOpen(t, nowMs)))
    )
  );
  const subtasksToday = sortSubtasks(
    todos.filter(
      (t) =>
        t.parentId !== null &&
        !t.completed &&
        t.pinnedTo === "day" &&
        !isFocusSkippedToday(t, nowMs)
    )
  );

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const total = topLevelToday.length + subtasksToday.length;
  const parentTitleById = new Map(todos.map((t) => [t.id, t.title]));

  // Tier inputs: count both routine (daily + scheduled-on-today) and extras
  // (manually-pinned-to-today) regardless of completion state, so progress can
  // be expressed as done / eligible. lastCompletedAt is the source of truth
  // for "completed today" — guards against a row whose midnight reset hasn't
  // run yet on first load.
  // Mirrors the Focus visible filter's `pinnedTo !== "week"` exclusion so the
  // tier doesn't claim routine work remaining for a legacy daily-pinned-to-
  // week row that Focus itself isn't surfacing.
  const dailyEligible = todos.filter(
    (t) =>
      t.parentId === null &&
      t.kind === "do" &&
      t.pinnedTo !== "week" &&
      !isFocusSkippedToday(t, nowMs) &&
      isOnTodaysRoutine(t, nowMs)
  );
  const dailyDone = dailyEligible.filter((t) => isCompletedToday(t, nowMs))
    .length;
  const dailyAllDone =
    dailyEligible.length === 0 || dailyDone === dailyEligible.length;

  const extrasEligible = todos.filter(
    (t) =>
      isExtraOnToday(t) &&
      (t.parentId !== null || t.kind === "do") &&
      !isFocusSkippedToday(t, nowMs)
  );
  const extrasDone = extrasEligible.filter((t) =>
    isCompletedToday(t, nowMs)
  ).length;

  const totalDone = dailyDone + extrasDone;
  const totalEligible = dailyEligible.length + extrasEligible.length;

  let subtitle: string;
  if (totalEligible === 0 && totalDone === 0) {
    subtitle = "All clear for today";
  } else if (totalDone === 0) {
    subtitle = "Let's get started";
  } else if (!dailyAllDone) {
    subtitle = "Keep it up";
  } else if (total > 0) {
    subtitle = "Daily's done — keep going";
  } else if (extrasDone >= 3) {
    subtitle = "Crushing it — kick back";
  } else {
    subtitle = "Nice work — all caught up";
  }

  // Empty-state branches when there's nothing left in focus today:
  //   default     — nothing was ever on today's plate, or no progress at all
  //   lookingAhead — wins logged today, still room for more (extrasDone <= 2):
  //                  surface up to 3 weekly suggestions to pin
  //   kickBack    — already 3+ extras done; no suggestions, just acknowledge
  const showLookingAhead = total === 0 && totalDone > 0 && extrasDone < 3;
  const showKickBack = total === 0 && totalDone > 0 && extrasDone >= 3;

  const suggestions = showLookingAhead
    ? sortTodos(
        todos.filter(
          (t) =>
            t.parentId === null &&
            t.kind === "do" &&
            !t.completed &&
            !dismissedIds.has(t.id) &&
            ((t.recurrence === "weekly" && t.pinnedTo !== "day") ||
              (t.recurrence === null && t.pinnedTo === "week"))
        )
      ).slice(0, 3)
    : [];

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-6 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-text">Focus</h2>
          <p className="text-sm text-text-muted">
            {total > 0
              ? `${total} todo${total === 1 ? "" : "s"} for today · ${subtitle}`
              : subtitle}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/todos"
            className="rounded-lg border border-border-on-surface px-3 py-1.5 text-sm text-on-surface/70 hover:bg-surface-hover hover:text-on-surface"
          >
            Manage
          </Link>
          <button
            type="button"
            onClick={() => {
              setQuickAddOpen((open) => {
                const next = !open;
                if (next) {
                  window.setTimeout(() => quickAddInputRef.current?.focus(), 0);
                }
                return next;
              });
            }}
            aria-label="Add a task to focus"
            aria-expanded={quickAddOpen}
            aria-controls="focus-quick-add-form"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-on-surface text-on-surface/70 hover:bg-surface-hover hover:text-on-surface focus:outline-none focus:ring-2 focus:ring-focus"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M10 4a1 1 0 011 1v4h4a1 1 0 110 2h-4v4a1 1 0 11-2 0v-4H5a1 1 0 110-2h4V5a1 1 0 011-1z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>

      {quickAddOpen && (
        <form
          id="focus-quick-add-form"
          onSubmit={handleQuickAdd}
          className="mb-4 flex gap-2"
        >
          <label htmlFor="focus-quick-add-input" className="sr-only">
            Task title
          </label>
          <input
            id="focus-quick-add-input"
            ref={quickAddInputRef}
            type="text"
            value={quickAddTitle}
            onChange={(e) => setQuickAddTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuickAddOpen(false);
                setQuickAddTitle("");
              }
            }}
            placeholder="Add a task to focus..."
            maxLength={500}
            className="flex-1 rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-input-placeholder focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
          />
          <button
            type="submit"
            disabled={!quickAddTitle.trim() || quickAddSubmitting}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add
          </button>
        </form>
      )}

      {total > 0 ? (
        <div className="space-y-2">
          {topLevelToday.map((todo) => (
            <FocusRow
              key={todo.id}
              todo={todo}
              onToggle={() => handleToggle(todo)}
              onSkip={() => handleSkip(todo)}
            />
          ))}
          {subtasksToday.map((s) => (
            <FocusRow
              key={s.id}
              todo={s}
              parentTitle={
                s.parentId !== null
                  ? parentTitleById.get(s.parentId) ?? null
                  : null
              }
              onToggle={() => handleToggle(s)}
              onSkip={() => handleSkip(s)}
            />
          ))}
        </div>
      ) : showKickBack ? (
        <div className="rounded-lg border border-dashed border-border-on-surface px-4 py-12 text-center text-sm text-text-muted">
          You&rsquo;ve done plenty for today. Take a breather.
        </div>
      ) : showLookingAhead && suggestions.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-text-muted">
            Looking to get ahead? Pin one of these to today.
          </p>
          <div className="space-y-2">
            {suggestions.map((s) => (
              <SuggestionRow
                key={s.id}
                todo={s}
                onPin={() => handlePinSuggestion(s)}
                onDismiss={() => handleDismissSuggestion(s)}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border-on-surface px-4 py-12 text-center text-sm text-text-muted">
          Nothing pinned to today. Add a daily todo or pin one to the day from{" "}
          <Link href="/todos" className="underline hover:text-on-surface">
            Manage
          </Link>
          .
        </div>
      )}

      {pendingSkipUndo && (
        <SkipUndoToast
          title={pendingSkipUndo.title}
          kind={pendingSkipUndo.kind}
          onUndo={handleUndoSkip}
          onDismiss={dismissSkipUndo}
        />
      )}
    </div>
  );
}

function SkipUndoToast({
  title,
  kind,
  onUndo,
  onDismiss,
}: {
  title: string;
  kind: "skip" | "unpin";
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const message =
    kind === "skip" ? `Skipped ${title} for today` : `Unpinned ${title}`;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-4 z-40 mx-auto flex max-w-sm items-center gap-3 rounded-lg border border-border-on-surface bg-surface px-4 py-3 shadow-lg shadow-black/40"
      style={{ marginBottom: "env(safe-area-inset-bottom)" }}
    >
      <span className="min-w-0 flex-1 truncate text-sm text-on-surface">
        {message}
      </span>
      <button
        type="button"
        onClick={onUndo}
        className="shrink-0 rounded px-2 py-1 text-sm font-medium text-primary hover:bg-primary/10 focus:outline-none focus:ring-2 focus:ring-primary"
      >
        Undo
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-on-surface/60 hover:text-on-surface focus:outline-none focus:ring-2 focus:ring-focus"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}

function SuggestionRow({
  todo,
  onPin,
  onDismiss,
}: {
  todo: Todo;
  onPin: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border-on-surface bg-surface px-4 py-3">
      <span className="flex-1 min-w-0 break-words text-on-surface">
        {todo.title}
      </span>
      <button
        onClick={onPin}
        className="shrink-0 rounded-md border border-border-on-surface px-2.5 py-1 text-xs text-on-surface/80 hover:bg-surface-hover hover:text-on-surface focus:outline-none focus:ring-2 focus:ring-focus"
      >
        Pin
      </button>
      <button
        onClick={onDismiss}
        className="shrink-0 rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-on-surface focus:outline-none focus:ring-2 focus:ring-focus"
        aria-label={`Dismiss ${todo.title}`}
      >
        Dismiss
      </button>
    </div>
  );
}

function FocusRow({
  todo,
  parentTitle,
  onToggle,
  onSkip,
}: {
  todo: Todo;
  parentTitle?: string | null;
  onToggle: () => void;
  onSkip: () => void;
}) {
  const done = todo.completed;
  // Recurring rows skip (defer to tomorrow); non-recurring rows just unpin.
  // Surface the wording so the user knows which one this tap will do.
  const skipLabel = todo.recurrence !== null ? "Skip" : "Unpin";
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border-on-surface bg-surface px-4 py-3">
      <button
        onClick={onToggle}
        className={
          done
            ? "flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 border-success bg-success/20 hover:bg-success/10 focus:outline-none focus:ring-2 focus:ring-success"
            : "h-5 w-5 shrink-0 rounded border-2 border-border hover:border-focus focus:outline-none focus:ring-2 focus:ring-focus"
        }
        aria-label={done ? "Uncomplete todo" : "Complete todo"}
      >
        {done && (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-3 w-3 text-success"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <span
          className={`block break-words ${done ? "text-on-surface/50 line-through" : "text-on-surface"}`}
        >
          {todo.title}
        </span>
        {parentTitle && (
          <span className="block text-xs text-text-muted">in {parentTitle}</span>
        )}
      </div>
      {!done && (
        <button
          type="button"
          onClick={onSkip}
          className="shrink-0 rounded-md border border-border-on-surface px-2.5 py-1 text-xs text-on-surface/70 hover:bg-surface-hover hover:text-on-surface focus:outline-none focus:ring-2 focus:ring-focus"
          aria-label={`${skipLabel} ${todo.title}`}
        >
          {skipLabel}
        </button>
      )}
    </div>
  );
}
