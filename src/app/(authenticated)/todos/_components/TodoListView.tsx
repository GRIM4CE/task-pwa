"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  api,
  type LimitPeriod,
  type PinnedTo,
  type Recurrence,
  type RecurrenceOrdinal,
  type TodoDTO,
  type TodoKind,
} from "@/lib/api-client";
import {
  avoidStatusForTodo,
  hasSlipToday,
  type AvoidStatus,
} from "@/lib/analytics";
import {
  isCompletedTodoExpired,
  isRecurringResetDue,
  isScheduledOccurrenceOpen,
  isScheduledRecurrence,
} from "@/lib/recurrence";
import { notifyStatsMayHaveChanged } from "@/lib/stats-events";
import {
  cascadeCompleteChildren,
  sortSubtasks,
  sortTodos,
} from "@/lib/todos/domain";
import { useTodoRepository } from "@/lib/todos/use-todo-repository";

type Todo = TodoDTO;

const LONG_PRESS_MS = 400;
const MOVE_CANCEL_PX = 10;
// Pointer must be inside the middle ~50% of a row (vertically) to count as a
// "drop into" target rather than a "drop between" reorder. Tuned to make the
// nesting gesture intentional without forcing pixel precision.
const NEST_BAND_RATIO = 0.5;
// Pixels above the top / below the bottom of the subtask container that
// trigger "promote out" feedback. Small enough to feel responsive, large
// enough to absorb finger jitter.
const PROMOTE_MARGIN_PX = 20;

function formatRelativeDate(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);

  // Compare dates ignoring time
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((todayStart.getTime() - dateStart.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays === 2) return "2 days ago";
  if (diffDays === 3) return "3 days ago";

  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

export default function TodoListView() {
  const repo = useTodoRepository();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [newTitle, setNewTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Todo | null>(null);
  // The visibility selector in the edit modal needs to know if the current
  // user created the todo — only the creator can flip joined ↔ personal,
  // matching the API guard.
  const [currentUsername, setCurrentUsername] = useState<string | null>(null);
  const [justCompletedIds, setJustCompletedIds] = useState<Set<string>>(() => new Set());
  // Tracks "now" for visibility filters that depend on local-midnight boundaries
  // (currently: hiding completed weekly tasks past their next-midnight cutoff).
  // Bumped by an interval and on visibilitychange so the UI re-evaluates without
  // requiring a manual refresh, even with the app left open through midnight.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // After a slip is logged successfully, surface a transient undo toast so a
  // mis-tap can be reverted without diving into the edit modal. A single
  // pending undo at a time is enough — a follow-up slip on a different todo
  // dismisses the previous toast.
  const [pendingUndo, setPendingUndo] = useState<{ id: string; title: string } | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  const resettingRef = useRef<Set<string>>(new Set());
  const pendingToggleRef = useRef<Set<string>>(new Set());
  const expiringRef = useRef<Set<string>>(new Set());
  const completionTimersRef = useRef<Map<string, number>>(new Map());
  const recentlyToggledRef = useRef(false);

  // Delete completed top-level non-recurring rows once the user's local clock
  // has crossed midnight after they were completed. Mirrors the server cron's
  // intent but honors the browser's IANA timezone, so a todo completed at
  // 11pm disappears at 00:00 local rather than 24h after the fact. Subtasks
  // are intentionally excluded — they linger under their parent as a record
  // of progress and only get removed when the parent itself is archived
  // (FK ON DELETE CASCADE handles the cleanup).
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
        // Also drop any rows whose parent we just deleted — the DB cascaded
        // them server-side, so keeping them in client state would show orphans.
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

  // Uncomplete any recurring todos whose next local-midnight reset boundary
  // has passed since they were last completed (in the user's browser timezone).
  const resetDueRecurring = useCallback(async (list: Todo[]) => {
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
      // autoReset signals the server to keep the prior period's completion
      // event in todoCompletions. A manual undo would drop the event so the
      // stats page mirrors the user's intent; an auto-reset is real history.
      due.map((t) =>
        repo.update(t.id, { completed: false, autoReset: true })
      )
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
  }, [repo]);

  const loadTodos = useCallback(async () => {
    const { data } = await repo.list();
    if (data) {
      setTodos(data);
      resetDueRecurring(data);
      expireCompleted(data);
    }
    setLoading(false);
  }, [repo, resetDueRecurring, expireCompleted]);

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    // loadTodos is async — setState only runs after the awaited fetch resolves,
    // so the cascading-render concern this rule guards against doesn't apply.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTodos();
  }, [loadTodos]);

  useEffect(() => {
    // Fetched once at mount: username doesn't change for the lifetime of a
    // session and the auth status endpoint is already cached by the layout.
    let cancelled = false;
    api.auth.status().then(({ data }) => {
      if (cancelled) return;
      const u = (data?.user as { username?: string } | null)?.username;
      if (u) setCurrentUsername(u);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh when the app comes back into focus (e.g. switching apps on iPhone)
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        setNowMs(Date.now());
        loadTodos();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [loadTodos]);

  // Tick "now" once a minute so visibility filters tied to local midnight
  // (weekly completions hiding from the list) flip without a refresh, even
  // when the app stays open across the boundary.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setAdding(true);

    // New tasks default to joined; the modal opens immediately so the user
    // can flip to personal, set recurrence, etc. before the task settles
    // into the list.
    const { data } = await repo.create({
      title: newTitle.trim(),
      isPersonal: false,
      recurrence: null,
    });
    if (data) {
      setTodos((prev) => [...prev, data]);
      setNewTitle("");
      setEditing(data);
    }
    setAdding(false);
  }

  // Drives the row-completion animation: keep the just-tapped row in its
  // active section for ~500ms before it settles into Complete. Each completion
  // replaces any in-flight timer for this id so a fast
  // complete -> uncomplete -> complete sequence still animates in full.
  function markJustCompleted(id: string, completing: boolean) {
    const existingTimer = completionTimersRef.current.get(id);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      completionTimersRef.current.delete(id);
    }
    if (completing) {
      setJustCompletedIds((prev) => {
        const s = new Set(prev);
        s.add(id);
        return s;
      });
      const timerId = window.setTimeout(() => {
        completionTimersRef.current.delete(id);
        setJustCompletedIds((prev) => {
          if (!prev.has(id)) return prev;
          const s = new Set(prev);
          s.delete(id);
          return s;
        });
      }, 500);
      completionTimersRef.current.set(id, timerId);
    } else {
      setJustCompletedIds((prev) => {
        if (!prev.has(id)) return prev;
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
    }
  }

  async function handleToggle(todo: Todo) {
    // Drop toggles that arrive within ~300ms of the previous one. iOS in
    // standalone-PWA mode can fire a follow-up synthesized "ghost click" after
    // a legitimate tap; combined with finger drift near a row's edge that
    // second click lands on the next row's checkbox and completes a task the
    // user never intended to. `pendingToggleRef` only guards the same id, so
    // we need a cross-row guard for this case.
    if (recentlyToggledRef.current) return;
    recentlyToggledRef.current = true;
    window.setTimeout(() => {
      recentlyToggledRef.current = false;
    }, 300);

    if (pendingToggleRef.current.has(todo.id)) return;
    pendingToggleRef.current.add(todo.id);

    const next = !todo.completed;
    const previousTodos = todos;

    setTodos((prev) => {
      let updated = prev.map((t) =>
        t.id === todo.id
          ? { ...t, completed: next, lastCompletedAt: next ? Date.now() : null }
          : t
      );
      // Mirror the server-side cascade: completing a parent completes its open children.
      if (next && todo.parentId === null) {
        updated = cascadeCompleteChildren(updated, todo.id);
      }
      return updated;
    });

    markJustCompleted(todo.id, next);

    const { data, error } = await repo.update(todo.id, { completed: next });
    pendingToggleRef.current.delete(todo.id);

    if (error) {
      setTodos(previousTodos);
      return;
    }

    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
      // Recurring toggles change the completion log, which feeds /stats. We
      // can't rely on `visibilitychange` to refresh a stats page reached via
      // intra-app nav — the document never goes hidden — so signal explicitly
      // here, after the server's response, so any mounted stats page refetches
      // post-commit instead of trusting its mount-race snapshot. Read the
      // recurrence/parent fields off the committed row rather than the
      // pre-request `todo` so a stale optimistic snapshot can't suppress a
      // notify the server actually warranted.
      if (data.recurrence !== null && data.parentId === null) {
        notifyStatsMayHaveChanged();
      }
    }
  }

  function clearUndoTimer() {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  }

  function showUndo(id: string, title: string) {
    clearUndoTimer();
    setPendingUndo({ id, title });
    undoTimerRef.current = window.setTimeout(() => {
      undoTimerRef.current = null;
      setPendingUndo((prev) => (prev?.id === id ? null : prev));
    }, 5000);
  }

  function dismissUndo() {
    clearUndoTimer();
    setPendingUndo(null);
  }

  async function handleRecordSlip(todo: Todo) {
    if (todo.kind !== "avoid") return;
    if (pendingToggleRef.current.has(todo.id)) return;
    pendingToggleRef.current.add(todo.id);

    const previousTodos = todos;
    setTodos((prev) =>
      prev.map((t) => {
        if (t.id !== todo.id) return t;
        const now = Date.now();
        return {
          ...t,
          recentSlips: [...t.recentSlips, now],
          lastCompletedAt: now,
        };
      })
    );

    const { data, error } = await repo.update(todo.id, { recordSlip: true });
    pendingToggleRef.current.delete(todo.id);
    if (error) {
      setTodos(previousTodos);
      return;
    }
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
      showUndo(data.id, data.title);
      // The slip touches the completion log, which feeds /stats. Notify so a
      // mounted stats page picks it up without needing a visibility change.
      notifyStatsMayHaveChanged();
    }
  }

  async function handleUndoSlip(id: string) {
    const target = todos.find((t) => t.id === id);
    if (!target || target.kind !== "avoid") return;
    dismissUndo();
    if (pendingToggleRef.current.has(id)) return;
    pendingToggleRef.current.add(id);

    const previousTodos = todos;
    setTodos((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        // Optimistically drop the most recent slip by max-timestamp rather
        // than array position so the result is correct regardless of how
        // recentSlips happens to be ordered. Rebase lastCompletedAt onto
        // the new latest (or null); the server confirms the authoritative
        // state below.
        if (t.recentSlips.length === 0) {
          return { ...t, lastCompletedAt: null };
        }
        let maxIdx = 0;
        for (let i = 1; i < t.recentSlips.length; i++) {
          if (t.recentSlips[i] > t.recentSlips[maxIdx]) maxIdx = i;
        }
        const remaining = [
          ...t.recentSlips.slice(0, maxIdx),
          ...t.recentSlips.slice(maxIdx + 1),
        ];
        const nextLast =
          remaining.length === 0 ? null : Math.max(...remaining);
        return {
          ...t,
          recentSlips: remaining,
          lastCompletedAt: nextLast,
        };
      })
    );

    const { data, error } = await repo.update(id, { undoLastSlip: true });
    pendingToggleRef.current.delete(id);
    if (error) {
      setTodos(previousTodos);
      return;
    }
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
      notifyStatsMayHaveChanged();
    }
  }

  // Stop the undo timer on unmount so it can't fire after navigation.
  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) {
        window.clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
    };
  }, []);

  async function handleAddSubtask(parentId: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    const { data } = await repo.create({ parentId, title: trimmed });
    if (data) {
      setTodos((prev) => [...prev, data]);
    }
  }

  // Cycle the pin via the inline button. The modal exposes all states
  // explicitly for users who want to pick directly.
  // - Non-recurring "do": unpinned → This Week → Today → unpinned.
  // - Weekly recurring: unpinned ↔ Today. (Pin to This Week would be
  //   redundant — recurrence already places it there.)
  // - Daily recurring: only path is "clear" so a legacy pinned row can be
  //   unpinned. The button is hidden when there's nothing to clear.
  async function handleTogglePin(todo: Todo) {
    let next: PinnedTo;
    if (todo.recurrence === "weekly") {
      next = todo.pinnedTo === "day" ? null : "day";
    } else if (todo.recurrence === "daily" || isScheduledRecurrence(todo.recurrence)) {
      // Daily and scheduled rows already self-place in Today on their
      // active dates — pin is redundant. Only path is "clear" so a legacy
      // pinned row can be unpinned.
      next = null;
    } else if (todo.pinnedTo === null) {
      next = "week";
    } else if (todo.pinnedTo === "week") {
      next = "day";
    } else {
      next = null;
    }
    const previous = todo.pinnedTo;
    setTodos((prev) =>
      prev.map((t) => (t.id === todo.id ? { ...t, pinnedTo: next } : t))
    );
    const { data, error } = await repo.update(todo.id, { pinnedTo: next });
    if (error) {
      setTodos((prev) =>
        prev.map((t) => (t.id === todo.id ? { ...t, pinnedTo: previous } : t))
      );
      return;
    }
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
    }
  }

  async function handleEditSave(
    id: string,
    patch: {
      title: string;
      description: string | null;
      isPersonal: boolean;
      recurrence: Recurrence;
      recurrenceWeekday: number | null;
      recurrenceDayOfMonth: number | null;
      recurrenceOrdinal: RecurrenceOrdinal;
      pinnedTo: PinnedTo;
      kind: TodoKind;
      limitCount: number | null;
      limitPeriod: LimitPeriod;
      oncePerDay: boolean;
    }
  ) {
    const { data } = await repo.update(id, patch);
    if (data) {
      setTodos((prev) =>
        prev.map((t) => {
          if (t.id === data.id) return data;
          // Mirror the server's cascade: subtasks of a flipped parent inherit
          // the new isPersonal value so the local list matches the persisted
          // shape without a refetch.
          if (t.parentId === data.id && t.isPersonal !== data.isPersonal) {
            return { ...t, isPersonal: data.isPersonal };
          }
          return t;
        })
      );
      setEditing(null);
    }
  }

  async function handleSubtaskEditSave(
    id: string,
    patch: { title: string; description: string | null; pinnedTo: PinnedTo }
  ) {
    const { data } = await repo.update(id, patch);
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
      setEditing(null);
    }
  }

  async function handleDelete(id: string) {
    const { data } = await repo.delete(id);
    if (data?.success) {
      // Cascade-delete children locally to mirror ON DELETE CASCADE.
      setTodos((prev) => prev.filter((t) => t.id !== id && t.parentId !== id));
      if (editing?.id === id) setEditing(null);
    }
  }

  async function handleReorder(parentId: string | null, newIds: string[]) {
    // Mirror the server's reassignment locally so the order updates without a
    // refetch. The server takes the existing sortOrder values of the targeted
    // ids (sorted ascending) and reassigns them in payload order.
    const prev = todos;
    setTodos((current) => {
      const inSet = new Set(newIds);
      const values = current
        .filter((t) => inSet.has(t.id))
        .map((t) => t.sortOrder)
        .sort((a, b) => a - b);
      const assigned: Record<string, number> = {};
      newIds.forEach((id, i) => {
        assigned[id] = values[i];
      });
      return current.map((t) =>
        assigned[t.id] !== undefined ? { ...t, sortOrder: assigned[t.id] } : t
      );
    });

    const { error } = await repo.reorder(newIds, parentId);
    if (error) {
      setTodos(prev);
    }
  }

  async function handleNestUnder(draggedId: string, targetParentId: string) {
    const dragged = todos.find((t) => t.id === draggedId);
    const target = todos.find((t) => t.id === targetParentId);
    if (!dragged || !target) return;
    // Guard: only nest a top-level todo under another top-level todo. Same
    // isPersonal scope. No self-nesting. No nesting a parent (with kids) under
    // someone else. Recurring todos can't become subtasks.
    if (dragged.parentId !== null || target.parentId !== null) return;
    if (dragged.id === target.id) return;
    if (dragged.isPersonal !== target.isPersonal) return;
    if (todos.some((t) => t.parentId === dragged.id)) return;
    if (dragged.recurrence !== null) return;
    // Avoid todos can't be subtasks — they need their own card UI for the
    // slip button and warning state.
    if (dragged.kind === "avoid" || target.kind === "avoid") return;

    const previous = todos;
    // Optimistic: move locally, the API will renormalize sortOrder.
    // pinnedTo is preserved on demote (subtasks still surface in Today /
    // This Week when pinned).
    setTodos((prev) =>
      prev.map((t) =>
        t.id === draggedId ? { ...t, parentId: targetParentId } : t
      )
    );
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.add(targetParentId);
      return next;
    });
    const { data, error } = await repo.update(draggedId, {
      parentId: targetParentId,
    });
    if (error) {
      setTodos(previous);
      return;
    }
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
    }
  }

  async function handlePromoteOut(subtaskId: string) {
    const sub = todos.find((t) => t.id === subtaskId);
    if (!sub || sub.parentId === null) return;
    const previous = todos;
    setTodos((prev) =>
      prev.map((t) => (t.id === subtaskId ? { ...t, parentId: null } : t))
    );
    const { data, error } = await repo.update(subtaskId, { parentId: null });
    if (error) {
      setTodos(previous);
      return;
    }
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
    }
  }

  // The API already scopes the response to what this user is allowed to see
  // (joined todos + their own personal todos), so the client just renders
  // whatever it receives.
  const visibleTodos = todos;
  const topLevel = visibleTodos.filter((t) => t.parentId === null);
  // A todo that was just completed stays in its active section until the
  // animation finishes, so the user sees the confirmation where they tapped
  // before the row settles into Complete.
  const isActiveSlot = (t: Todo) => !t.completed || justCompletedIds.has(t.id);
  // Scheduled recurrences (every Wednesday / monthly on the 15th / last
  // Friday of the month) only surface on their occurrence date — hidden the
  // rest of the time, and hidden again once completed until the next
  // occurrence rolls around. Apply this filter at the top-level slice so
  // every section (Today / This Week / General / Complete) sees the same
  // pruned list.
  const topLevelVisible = topLevel.filter((t) => {
    if (!isScheduledRecurrence(t.recurrence)) return true;
    if (justCompletedIds.has(t.id)) return true;
    if (t.completed) return false;
    return isScheduledOccurrenceOpen(t, nowMs);
  });
  // Avoid todos live in their own section and never appear in This Week /
  // Daily / General — the slip button is conceptually different from a
  // checkbox, and mixing them muddies the visual language.
  const isDoTodo = (t: Todo) => t.kind === "do";
  const avoidTodos = topLevelVisible.filter((t) => t.kind === "avoid");
  // "Today" gathers daily-recurring rows plus anything pinned to the day,
  // including weekly-recurring rows pinned to Today (the only legal way to
  // surface a once-a-week task in the daily view) and scheduled rows whose
  // current occurrence is open. Pinned-to-week takes precedence over a daily
  // recurrence on legacy rows so the pin can still be cleared from This Week.
  // Weekly+day rows are excluded from This Week so they don't appear in both
  // sections at once.
  const thisWeekTodos = topLevelVisible.filter(
    (t) =>
      isDoTodo(t) &&
      isActiveSlot(t) &&
      t.pinnedTo !== "day" &&
      (t.recurrence === "weekly" || t.pinnedTo === "week")
  );
  const todayTodos = topLevelVisible.filter(
    (t) =>
      isDoTodo(t) &&
      isActiveSlot(t) &&
      t.pinnedTo !== "week" &&
      (t.recurrence === "daily" ||
        t.pinnedTo === "day" ||
        isScheduledRecurrence(t.recurrence))
  );
  const regularActive = topLevelVisible.filter(
    (t) =>
      isDoTodo(t) &&
      isActiveSlot(t) &&
      t.recurrence === null &&
      t.pinnedTo === null
  );
  // Weekly recurring tasks reset to incomplete at the Sunday→Monday boundary
  // (see isRecurringResetDue), but the completed checkmark should disappear
  // from the list at the next local midnight — same visibility window as
  // non-recurring cleanup. The row stays completed in storage so the streak
  // event isn't lost; we just hide it from the UI until the weekly reset
  // surfaces it again in "This Week" as open. Scheduled rows are already
  // hidden once completed by the topLevelVisible filter above.
  const completedTodos = topLevelVisible.filter(
    (t) =>
      isDoTodo(t) &&
      t.completed &&
      !justCompletedIds.has(t.id) &&
      !(t.recurrence === "weekly" && isCompletedTodoExpired(t.lastCompletedAt, nowMs))
  );
  // Subtasks completed today surface in the Complete section so a same-day
  // subtask check is visible at a glance, then drop out at local midnight
  // (next-day) — they remain marked complete under their parent indefinitely.
  // Skip subtasks whose parent is itself completed (including parents still
  // in the just-completed animation window, which haven't moved to
  // completedTodos yet) so cascade-completed children don't dump into the
  // list as noise alongside the parent that already represents the action.
  const completedTopLevelIds = new Set(
    topLevel.filter((t) => t.completed).map((t) => t.id)
  );
  const completedSubtasksToday = sortSubtasks(
    visibleTodos.filter(
      (t) =>
        t.parentId !== null &&
        t.completed &&
        t.lastCompletedAt !== null &&
        !justCompletedIds.has(t.id) &&
        !completedTopLevelIds.has(t.parentId) &&
        !isCompletedTodoExpired(t.lastCompletedAt, nowMs)
    )
  );

  // Subtasks pinned to This Week / Today. Subtasks inherit isPersonal from
  // their parent at create-time, so these filters mirror the per-tab
  // visibleTodos rule.
  const thisWeekSubtasks = sortSubtasks(
    visibleTodos.filter(
      (t) =>
        t.parentId !== null &&
        t.pinnedTo === "week" &&
        (!t.completed || justCompletedIds.has(t.id))
    )
  );
  const todaySubtasks = sortSubtasks(
    visibleTodos.filter(
      (t) =>
        t.parentId !== null &&
        t.pinnedTo === "day" &&
        (!t.completed || justCompletedIds.has(t.id))
    )
  );

  function renderTopLevelTodo(todo: Todo, isDragging?: boolean, isNestTarget?: boolean) {
    const done = todo.completed;
    const childSubtasks = visibleTodos.filter((s) => s.parentId === todo.id);
    const subtaskTotal = childSubtasks.length;
    const subtaskDone = childSubtasks.filter((s) => s.completed).length;
    const expanded = expandedIds.has(todo.id);
    const activeSubtasks = sortSubtasks(
      childSubtasks.filter((s) => !s.completed || justCompletedIds.has(s.id))
    );
    // Completed subtasks linger under the parent so an accidental check can
    // be undone without leaving the todos page. The just-completed window
    // keeps the row in the active list briefly so the completion animation
    // plays before it settles into the done group.
    const completedSubtasks = sortSubtasks(
      childSubtasks.filter((s) => s.completed && !justCompletedIds.has(s.id))
    );

    return (
      <>
        <TodoRow
          todo={todo}
          done={done}
          lifted={isDragging}
          nestTarget={isNestTarget}
          justCompleted={justCompletedIds.has(todo.id)}
          expanded={done ? undefined : expanded}
          subtaskTotal={subtaskTotal}
          subtaskDone={subtaskDone}
          onToggle={() => handleToggle(todo)}
          onTogglePin={
            // Hide the pin control on daily-recurring and scheduled todos
            // when there's nothing to clear — recurrence already places them
            // in Today on their active dates, so a pin would be redundant.
            // Weekly-recurring rows always show the control so the user can
            // pin them to Today.
            (todo.recurrence === "daily" ||
              isScheduledRecurrence(todo.recurrence)) &&
            todo.pinnedTo === null
              ? undefined
              : () => handleTogglePin(todo)
          }
          onToggleExpand={done ? undefined : () => toggleExpanded(todo.id)}
          onOpen={() => setEditing(todo)}
        />
        {!done && expanded && (
          // Stop pointerdown from bubbling so a long-press inside an expanded
          // subtask doesn't also start a drag of the parent row.
          <div
            className="mt-2 ml-7"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {activeSubtasks.length > 0 && (
              <DraggableLongPressList
                items={activeSubtasks}
                onReorder={(ids) => handleReorder(todo.id, ids)}
                onPromoteOut={handlePromoteOut}
                renderItem={(s, isSubDragging, willPromote) => (
                  <SubtaskRow
                    subtask={s}
                    lifted={isSubDragging}
                    promoting={willPromote}
                    justCompleted={justCompletedIds.has(s.id)}
                    onToggle={() => handleToggle(s)}
                    onTogglePin={() => handleTogglePin(s)}
                    onOpen={() => setEditing(s)}
                  />
                )}
              />
            )}
            {completedSubtasks.length > 0 && (
              <div
                className={`space-y-2${activeSubtasks.length > 0 ? " mt-2" : ""}`}
              >
                {completedSubtasks.map((s) => (
                  <SubtaskRow
                    key={s.id}
                    subtask={s}
                    onToggle={() => handleToggle(s)}
                    onTogglePin={() => handleTogglePin(s)}
                    onOpen={() => setEditing(s)}
                  />
                ))}
              </div>
            )}
            <AddSubtaskForm onAdd={(title) => handleAddSubtask(todo.id, title)} />
          </div>
        )}
      </>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  // For drag-to-nest validation: a todo with children can't be nested under
  // another. We pass the predicate down so highlights only show for legal drops.
  const hasChildren = (id: string) => visibleTodos.some((t) => t.parentId === id);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-text">Todos</h2>
        <p className="text-sm text-text-muted">
          {(() => {
            const todoToday = todayTodos.length + todaySubtasks.length;
            const todoThisWeek = thisWeekTodos.length + thisWeekSubtasks.length;
            const completeToday =
              completedTodos.length + completedSubtasksToday.length;
            const parts: string[] = [];
            if (todoToday > 0) parts.push(`${todoToday} todo today`);
            if (todoThisWeek > 0) parts.push(`${todoThisWeek} todo this week`);
            if (completeToday > 0) parts.push(`${completeToday} complete today`);
            return parts.length > 0 ? parts.join(", ") : "All caught up";
          })()}
        </p>
      </div>

      {/* Add todo form */}
      <form onSubmit={handleAdd} className="mb-6 flex gap-2">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add a new todo..."
          className="flex-1 rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-input-placeholder focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
          maxLength={500}
        />
        <button
          type="submit"
          disabled={adding || !newTitle.trim()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {adding ? "..." : "Add"}
        </button>
      </form>

      {/* Today: daily-recurring rows + anything pinned to the day, plus pinned subtasks */}
      {(todayTodos.length > 0 || todaySubtasks.length > 0) && (
        <Section title="Today" hint="Resets at local midnight">
          {todayTodos.length > 0 && (
            <DraggableLongPressList
              items={sortTodos(todayTodos)}
              onReorder={(ids) => handleReorder(null, ids)}
              onNestUnder={handleNestUnder}
              canNestUnder={(draggedId, targetId) =>
                draggedId !== targetId && !hasChildren(draggedId)
              }
              renderItem={(todo, isDragging, _willPromote, isNestTarget) =>
                renderTopLevelTodo(todo, isDragging, isNestTarget)
              }
            />
          )}
          {todaySubtasks.length > 0 && (
            <div className={`space-y-2${todayTodos.length > 0 ? " mt-2" : ""}`}>
              {todaySubtasks.map((s) => {
                const parent = todos.find((t) => t.id === s.parentId);
                return (
                  <SubtaskRow
                    key={s.id}
                    subtask={s}
                    parentTitle={parent?.title ?? "—"}
                    justCompleted={justCompletedIds.has(s.id)}
                    onToggle={() => handleToggle(s)}
                    onTogglePin={() => handleTogglePin(s)}
                    onOpen={() => setEditing(s)}
                  />
                );
              })}
            </div>
          )}
        </Section>
      )}

      {/* This Week (weekly recurrence + pinned todos + pinned subtasks, no DnD) */}
      {(thisWeekTodos.length > 0 || thisWeekSubtasks.length > 0) && (
        <Section title="This Week">
          <div className="space-y-2">
            {thisWeekTodos.map((todo) => (
              <div key={todo.id}>{renderTopLevelTodo(todo)}</div>
            ))}
            {thisWeekSubtasks.map((s) => {
              const parent = todos.find((t) => t.id === s.parentId);
              return (
                <SubtaskRow
                  key={s.id}
                  subtask={s}
                  parentTitle={parent?.title ?? "—"}
                  justCompleted={justCompletedIds.has(s.id)}
                  onToggle={() => handleToggle(s)}
                  onTogglePin={() => handleTogglePin(s)}
                  onOpen={() => setEditing(s)}
                />
              );
            })}
          </div>
        </Section>
      )}

      {/* General (active regular) todos */}
      {regularActive.length > 0 && (
        <Section title="General">
          <DraggableLongPressList
            items={sortTodos(regularActive)}
            onReorder={(ids) => handleReorder(null, ids)}
            onNestUnder={handleNestUnder}
            canNestUnder={(draggedId, targetId) =>
              draggedId !== targetId && !hasChildren(draggedId)
            }
            renderItem={(todo, isDragging, _willPromote, isNestTarget) =>
              renderTopLevelTodo(todo, isDragging, isNestTarget)
            }
          />
        </Section>
      )}

      {/* Avoid (bad-habit trackers) */}
      {avoidTodos.length > 0 && (
        <Section title="Avoid" hint="Tap +1 to log a slip">
          <div className="space-y-2">
            {sortTodos(avoidTodos).map((todo) => (
              <AvoidRow
                key={todo.id}
                todo={todo}
                onSlip={() => handleRecordSlip(todo)}
                onOpen={() => setEditing(todo)}
              />
            ))}
          </div>
        </Section>
      )}

      {pendingUndo && (
        <UndoSlipToast
          title={pendingUndo.title}
          onUndo={() => handleUndoSlip(pendingUndo.id)}
          onDismiss={dismissUndo}
        />
      )}

      {/* Complete todos (any recurrence) + subtasks completed today */}
      {(completedTodos.length > 0 || completedSubtasksToday.length > 0) && (
        <Section title="Complete">
          <div className="space-y-2">
            {completedTodos.map((todo) => (
              <div key={todo.id}>{renderTopLevelTodo(todo)}</div>
            ))}
            {completedSubtasksToday.map((s) => {
              const parent = todos.find((t) => t.id === s.parentId);
              return (
                <SubtaskRow
                  key={s.id}
                  subtask={s}
                  parentTitle={parent?.title ?? "—"}
                  onToggle={() => handleToggle(s)}
                  onTogglePin={() => handleTogglePin(s)}
                  onOpen={() => setEditing(s)}
                />
              );
            })}
          </div>
        </Section>
      )}

      {/* Empty state */}
      {visibleTodos.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-text-muted">
            No todos yet. Add one above to get started.
          </p>
        </div>
      )}

      {editing && editing.parentId === null && (
        <EditTodoModal
          todo={editing}
          canEditVisibility={
            currentUsername === null
              ? false
              : editing.createdBy === currentUsername
          }
          onCancel={() => setEditing(null)}
          onDelete={() => handleDelete(editing.id)}
          onSave={(patch) => handleEditSave(editing.id, patch)}
        />
      )}

      {editing && editing.parentId !== null && (
        <EditSubtaskModal
          subtask={editing}
          onCancel={() => setEditing(null)}
          onDelete={() => handleDelete(editing.id)}
          onSave={(patch) => handleSubtaskEditSave(editing.id, patch)}
        />
      )}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-text-muted">{title}</h3>
        {hint && <span className="text-xs text-text-muted/70">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

type DragState = {
  id: string;
  pointerId: number;
  startIndex: number;
  currentIndex: number;
  deltaY: number;
  startPointerY: number;
  heights: number[];
  tops: number[];
  // For drag-to-nest in top-level lists: id of the row currently in
  // "drop into" range, or null when the gesture would just reorder.
  nestTargetId: string | null;
  // For drag-to-promote in subtask lists: pointer is outside the container
  // by enough to trigger a promote-out on release.
  willPromote: boolean;
};

function DraggableLongPressList<T extends { id: string }>({
  items,
  onReorder,
  onNestUnder,
  canNestUnder,
  onPromoteOut,
  renderItem,
}: {
  items: T[];
  onReorder: (ids: string[]) => void | Promise<void>;
  onNestUnder?: (draggedId: string, targetId: string) => void | Promise<void>;
  canNestUnder?: (draggedId: string, targetId: string) => boolean;
  onPromoteOut?: (id: string) => void | Promise<void>;
  renderItem: (
    item: T,
    isDragging: boolean,
    willPromote: boolean,
    isNestTarget: boolean
  ) => React.ReactNode;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    timer: number;
    element: HTMLElement;
  } | null>(null);
  const suppressNextClickRef = useRef(false);

  const cancelPending = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRef.current = null;
  }, []);

  const beginDrag = useCallback(
    (id: string, pointerId: number, startPointerY: number, element: HTMLElement) => {
      const startIndex = items.findIndex((t) => t.id === id);
      if (startIndex < 0) return;
      const heights: number[] = [];
      const tops: number[] = [];
      for (const t of items) {
        const el = itemRefs.current.get(t.id);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        heights.push(rect.height);
        tops.push(rect.top);
      }
      try {
        element.setPointerCapture(pointerId);
      } catch {
        // ignore
      }
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate?.(10);
      }
      setDrag({
        id,
        pointerId,
        startIndex,
        currentIndex: startIndex,
        deltaY: 0,
        startPointerY,
        heights,
        tops,
        nestTargetId: null,
        willPromote: false,
      });
    },
    [items]
  );

  // Pending long-press: cancel on movement or early release.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const p = pendingRef.current;
      if (!p || p.pointerId !== e.pointerId) return;
      if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > MOVE_CANCEL_PX) {
        cancelPending();
      }
    }
    function onEnd(e: PointerEvent) {
      const p = pendingRef.current;
      if (!p || p.pointerId !== e.pointerId) return;
      cancelPending();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [cancelPending]);

  // Active drag: track pointer, compute target index + nest/promote intent,
  // commit on release.
  useEffect(() => {
    if (!drag) return;
    const current = drag;

    function computeIndex(pointerY: number): number {
      const draggedCenter =
        current.tops[current.startIndex] +
        current.heights[current.startIndex] / 2 +
        (pointerY - current.startPointerY);
      let next = current.startIndex;
      for (let i = 0; i < current.tops.length; i++) {
        if (i === current.startIndex) continue;
        const center = current.tops[i] + current.heights[i] / 2;
        if (i < current.startIndex && draggedCenter < center) {
          next = Math.min(next, i);
        } else if (i > current.startIndex && draggedCenter > center) {
          next = Math.max(next, i);
        }
      }
      return next;
    }

    function computeNestTarget(pointerY: number): string | null {
      if (!onNestUnder) return null;
      const dragged = items[current.startIndex];
      if (!dragged) return null;
      // Only highlight the row directly under the pointer, and only when the
      // pointer is in the row's middle band — the edges still mean "reorder".
      for (let i = 0; i < current.tops.length; i++) {
        if (i === current.startIndex) continue;
        const top = current.tops[i];
        const height = current.heights[i];
        const bandHalf = (height * NEST_BAND_RATIO) / 2;
        const centerY = top + height / 2;
        if (pointerY >= centerY - bandHalf && pointerY <= centerY + bandHalf) {
          const targetId = items[i].id;
          if (canNestUnder && !canNestUnder(dragged.id, targetId)) return null;
          return targetId;
        }
      }
      return null;
    }

    function computeWillPromote(pointerY: number): boolean {
      if (!onPromoteOut || !containerRef.current) return false;
      const rect = containerRef.current.getBoundingClientRect();
      return (
        pointerY < rect.top - PROMOTE_MARGIN_PX ||
        pointerY > rect.bottom + PROMOTE_MARGIN_PX
      );
    }

    function onMove(e: PointerEvent) {
      if (e.pointerId !== current.pointerId) return;
      e.preventDefault();
      const deltaY = e.clientY - current.startPointerY;
      const willPromote = computeWillPromote(e.clientY);
      // Promote takes precedence over nest/reorder — once the user has dragged
      // outside the container they're committing to "out", not to a new slot.
      const nestTargetId = willPromote ? null : computeNestTarget(e.clientY);
      const nextIndex =
        willPromote || nestTargetId !== null
          ? current.startIndex
          : computeIndex(e.clientY);
      setDrag((prev) =>
        prev
          ? {
              ...prev,
              deltaY,
              currentIndex: nextIndex,
              nestTargetId,
              willPromote,
            }
          : prev
      );
    }

    function onEnd(e: PointerEvent) {
      if (e.pointerId !== current.pointerId) return;
      setDrag((prev) => {
        if (!prev) return prev;
        const dragged = items[prev.startIndex];
        if (prev.willPromote && onPromoteOut && dragged) {
          onPromoteOut(dragged.id);
        } else if (prev.nestTargetId && onNestUnder && dragged) {
          onNestUnder(dragged.id, prev.nestTargetId);
        } else if (prev.startIndex !== prev.currentIndex) {
          const ids = items.map((t) => t.id);
          const [moved] = ids.splice(prev.startIndex, 1);
          ids.splice(prev.currentIndex, 0, moved);
          onReorder(ids);
        }
        return null;
      });
      // Suppress the synthetic click that follows a touch/mouse release.
      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 350);
    }

    // Block the browser's native touch scrolling while a drag is in progress.
    // pointermove.preventDefault is unreliable for this on iOS Safari, so we
    // also intercept the underlying touchmove with a non-passive listener.
    function onTouchMove(e: TouchEvent) {
      e.preventDefault();
    }

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("touchmove", onTouchMove);
    };
  }, [drag, items, onReorder, onNestUnder, canNestUnder, onPromoteOut]);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>, id: string) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (drag) return;
    cancelPending();
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const element = e.currentTarget;
    const timer = window.setTimeout(() => {
      const p = pendingRef.current;
      if (!p || p.pointerId !== pointerId) return;
      pendingRef.current = null;
      beginDrag(id, pointerId, startY, element);
    }, LONG_PRESS_MS);
    pendingRef.current = { id, pointerId, startX, startY, timer, element };
  }

  function handleClickCapture(e: React.MouseEvent) {
    if (suppressNextClickRef.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressNextClickRef.current = false;
    }
  }

  function transformFor(index: number): string | undefined {
    if (!drag) return undefined;
    if (index === drag.startIndex) {
      return `translate3d(0, ${drag.deltaY}px, 0)`;
    }
    // While the pointer is inside a nest band or beyond the promote threshold,
    // freeze siblings in place — there's no reorder pending.
    if (drag.nestTargetId !== null || drag.willPromote) return undefined;
    if (drag.currentIndex > drag.startIndex) {
      if (index > drag.startIndex && index <= drag.currentIndex) {
        return `translate3d(0, ${-drag.heights[drag.startIndex] - 8}px, 0)`;
      }
    } else if (drag.currentIndex < drag.startIndex) {
      if (index >= drag.currentIndex && index < drag.startIndex) {
        return `translate3d(0, ${drag.heights[drag.startIndex] + 8}px, 0)`;
      }
    }
    return undefined;
  }

  return (
    <div
      ref={containerRef}
      className={`space-y-2 ${drag ? "select-none touch-none" : ""}`}
      onClickCapture={handleClickCapture}
    >
      {items.map((item, index) => {
        const isDragging = drag?.id === item.id;
        const isNestTarget = drag?.nestTargetId === item.id;
        const willPromote = !!(drag && isDragging && drag.willPromote);
        const transform = transformFor(index);
        return (
          <div
            key={item.id}
            ref={(el) => {
              if (el) itemRefs.current.set(item.id, el);
              else itemRefs.current.delete(item.id);
            }}
            onPointerDown={(e) => handlePointerDown(e, item.id)}
            style={{
              transform,
              transition: drag && !isDragging ? "transform 150ms ease" : undefined,
              zIndex: isDragging ? 20 : undefined,
              position: "relative",
              touchAction: drag ? "none" : "pan-y",
              WebkitTouchCallout: "none",
              WebkitUserSelect: "none",
              userSelect: "none",
            }}
            className={isDragging ? "shadow-lg shadow-black/40" : ""}
          >
            {renderItem(item, isDragging, willPromote, isNestTarget)}
          </div>
        );
      })}
    </div>
  );
}

function PinIcon({ filled }: { filled: boolean }) {
  const path = "M8 2h4v2h1v1l1 4h-3v8l-1 1-1-1V9H6l1-4V4h1z";
  return filled ? (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  ) : (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}

// Aria copy for the pin button. The "next" action depends on current state
// and on whether the row is recurring (which collapses the cycle).
function pinAriaLabel(pinnedTo: PinnedTo, recurrence: Recurrence): string {
  if (recurrence === "weekly") {
    return pinnedTo === "day"
      ? "Pinned to Today — tap to unpin"
      : "Pin to Today";
  }
  if (recurrence === "daily" || isScheduledRecurrence(recurrence)) {
    // Daily and scheduled recurrences already place the row in Today on
    // their active dates; the only inline action is to clear a legacy pin.
    return pinnedTo === null
      ? "Pin to This Week"
      : "Pinned — tap to unpin";
  }
  if (pinnedTo === null) return "Pin to This Week";
  if (pinnedTo === "week") return "Pinned to This Week — tap to pin to Today";
  return "Pinned to Today — tap to unpin";
}

function VisibilityBadge({
  isPersonal,
  dim,
}: {
  isPersonal: boolean;
  dim?: boolean;
}) {
  // A small inline pill that surfaces whether a top-level todo is shared with
  // the other user (Joined) or locked to the creator (Personal). Kept compact
  // so it sits comfortably alongside the createdBy/timestamp meta line.
  const tone = isPersonal
    ? dim
      ? "border-warning/30 bg-warning/5 text-warning/60"
      : "border-warning/40 bg-warning/10 text-warning"
    : dim
      ? "border-primary/30 bg-primary/5 text-primary/60"
      : "border-primary/40 bg-primary/10 text-primary";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${tone}`}
      aria-label={isPersonal ? "Personal todo" : "Joined todo"}
    >
      {isPersonal ? "Personal" : "Joined"}
    </span>
  );
}

function TodoRow({
  todo,
  done,
  lifted,
  nestTarget,
  justCompleted,
  expanded,
  subtaskTotal,
  subtaskDone,
  onToggle,
  onTogglePin,
  onToggleExpand,
  onOpen,
}: {
  todo: Todo;
  done?: boolean;
  lifted?: boolean;
  nestTarget?: boolean;
  justCompleted?: boolean;
  expanded?: boolean;
  subtaskTotal?: number;
  subtaskDone?: number;
  onToggle: () => void;
  onTogglePin?: () => void;
  onToggleExpand?: () => void;
  onOpen: () => void;
}) {
  const pinnedTo = todo.pinnedTo;
  const pinned = pinnedTo !== null;
  const showBadge = (subtaskTotal ?? 0) > 0;
  const checkboxBase = done
    ? "flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 border-success bg-success/20 hover:bg-success/10 focus:outline-none focus:ring-2 focus:ring-success"
    : "h-5 w-5 shrink-0 rounded border-2 border-border hover:border-focus focus:outline-none focus:ring-2 focus:ring-focus";
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${
        nestTarget
          ? "border-primary bg-primary/15 ring-2 ring-primary/60"
          : lifted
            ? "border-focus bg-surface-hover ring-2 ring-focus/40"
            : done
              ? "border-border-on-surface bg-surface-hover"
              : "border-border-on-surface bg-surface"
      }${justCompleted ? " animate-complete-row" : ""}`}
    >
      <button
        onClick={onToggle}
        className={`${checkboxBase}${justCompleted ? " animate-complete-pop" : ""}`}
        aria-label={done ? "Uncomplete todo" : "Complete todo"}
      >
        {done && (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-success" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        )}
      </button>

      <div className="flex-1 min-w-0">
        <span className={`block break-words ${done ? "text-on-surface/50 line-through" : "text-on-surface"}`}>
          {todo.title}
          {showBadge && (
            <span
              className={`ml-2 inline-block rounded px-1.5 py-0.5 align-middle text-[10px] font-medium ${
                done
                  ? "bg-surface text-on-surface/40"
                  : "bg-surface text-on-surface/60"
              }`}
              aria-label={`${subtaskDone} of ${subtaskTotal} subtasks done`}
            >
              {subtaskDone}/{subtaskTotal}
            </span>
          )}
        </span>
        {showBadge && (
          <div
            className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-hover"
            role="progressbar"
            aria-valuenow={subtaskDone ?? 0}
            aria-valuemin={0}
            aria-valuemax={subtaskTotal ?? 0}
            aria-label={`Subtask completion: ${subtaskDone} of ${subtaskTotal}`}
          >
            <div
              className={`h-full transition-[width] duration-300 ease-out ${
                done
                  ? "bg-on-surface/25"
                  : (subtaskDone ?? 0) >= (subtaskTotal ?? 0)
                    ? "bg-success"
                    : "bg-primary"
              }`}
              style={{
                width: `${
                  (subtaskTotal ?? 0) > 0
                    ? Math.round(((subtaskDone ?? 0) / (subtaskTotal ?? 1)) * 100)
                    : 0
                }%`,
              }}
            />
          </div>
        )}
        {todo.description && (
          <span className={`mt-0.5 block break-words text-xs ${done ? "text-on-surface/40" : "text-on-surface/60"}`}>
            {todo.description}
          </span>
        )}
        <span className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs ${done ? "text-on-surface/40" : "text-on-surface/60"}`}>
          <VisibilityBadge isPersonal={todo.isPersonal} dim={done} />
          <span>
            {todo.createdBy} &middot; {formatRelativeDate(todo.createdAt)}
          </span>
        </span>
        {nestTarget && (
          <span className="mt-0.5 block text-xs font-medium text-primary">
            Release to nest as subtask
          </span>
        )}
      </div>

      {onToggleExpand && (
        <button
          onClick={onToggleExpand}
          className="shrink-0 rounded p-1 text-on-surface/60 hover:text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
          aria-label={
            showBadge
              ? expanded
                ? "Collapse subtasks"
                : "Expand subtasks"
              : expanded
                ? "Hide add subtask"
                : "Add subtask"
          }
          aria-expanded={expanded}
        >
          {showBadge ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path fillRule="evenodd" d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" clipRule="evenodd" />
            </svg>
          )}
        </button>
      )}

      {onTogglePin && !done && (
        <button
          onClick={onTogglePin}
          className={`shrink-0 rounded p-1 focus:outline-none focus:ring-2 focus:ring-primary ${
            pinnedTo === "day"
              ? "text-warning"
              : pinnedTo === "week"
                ? "text-primary"
                : "text-on-surface/60 hover:text-on-surface"
          }`}
          aria-label={pinAriaLabel(pinnedTo, todo.recurrence)}
          aria-pressed={pinned}
        >
          <PinIcon filled={pinned} />
        </button>
      )}

      <button
        onClick={onOpen}
        className="shrink-0 rounded p-1 text-on-surface/60 hover:text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
        aria-label="Todo settings"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
        </svg>
      </button>
    </div>
  );
}

function SubtaskRow({
  subtask,
  parentTitle,
  lifted,
  promoting,
  justCompleted,
  onToggle,
  onTogglePin,
  onOpen,
}: {
  subtask: Todo;
  parentTitle?: string;
  lifted?: boolean;
  promoting?: boolean;
  justCompleted?: boolean;
  onToggle: () => void;
  onTogglePin: () => void;
  onOpen: () => void;
}) {
  const done = subtask.completed;
  const pinnedTo = subtask.pinnedTo;
  const pinned = pinnedTo !== null;
  const checkboxBase = done
    ? "flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 border-success bg-success/20 hover:bg-success/10 focus:outline-none focus:ring-2 focus:ring-success"
    : "h-4 w-4 shrink-0 rounded border-2 border-border hover:border-focus focus:outline-none focus:ring-2 focus:ring-focus";
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
        promoting
          ? "border-focus bg-focus/15 ring-2 ring-focus/60"
          : lifted
            ? "border-focus bg-surface-hover ring-2 ring-focus/40"
            : done
              ? "border-border-on-surface bg-surface-hover"
              : "border-border-on-surface bg-surface"
      }${justCompleted ? " animate-complete-row" : ""}`}
    >
      <button
        onClick={onToggle}
        className={`${checkboxBase}${justCompleted ? " animate-complete-pop" : ""}`}
        aria-label={done ? "Uncomplete subtask" : "Complete subtask"}
      >
        {done && (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-2.5 w-2.5 text-success" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <span className={`block break-words text-sm ${done ? "text-on-surface/50 line-through" : "text-on-surface"}`}>
          {subtask.title}
        </span>
        {subtask.description && (
          <span className={`mt-0.5 block break-words text-xs ${done ? "text-on-surface/40" : "text-on-surface/60"}`}>
            {subtask.description}
          </span>
        )}
        {parentTitle && (
          <span className={`mt-0.5 block break-words text-xs ${done ? "text-on-surface/40" : "text-on-surface/60"}`}>
            ↳ under {parentTitle}
          </span>
        )}
        {promoting && (
          <span className="mt-0.5 block text-xs font-medium text-focus">
            Release to promote to top-level
          </span>
        )}
      </div>

      {!done && (
        <button
          onClick={onTogglePin}
          className={`shrink-0 rounded p-1 focus:outline-none focus:ring-2 focus:ring-primary ${
            pinnedTo === "day"
              ? "text-warning"
              : pinnedTo === "week"
                ? "text-primary"
                : "text-on-surface/60 hover:text-on-surface"
          }`}
          aria-label={pinAriaLabel(pinnedTo, subtask.recurrence)}
          aria-pressed={pinned}
        >
          <PinIcon filled={pinned} />
        </button>
      )}

      <button
        onClick={onOpen}
        className="shrink-0 rounded p-1 text-on-surface/60 hover:text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
        aria-label="Subtask settings"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
        </svg>
      </button>
    </div>
  );
}

function AvoidRow({
  todo,
  onSlip,
  onOpen,
}: {
  todo: Todo;
  onSlip: () => void;
  onOpen: () => void;
}) {
  const { count, status, windowDays } = avoidStatusForTodo(
    todo.recentSlips,
    todo.limitCount,
    todo.limitPeriod
  );
  // Once-per-day mode: a slip already logged today disables the +1 button
  // until midnight. Multi-tap mode (the default) leaves it always enabled.
  const slippedToday = todo.oncePerDay && hasSlipToday(todo.recentSlips);
  const buttonDisabled = slippedToday;
  // Days since the last slip — null when there's never been one. Anchored to
  // `lastCompletedAt` (which has no retention cap) rather than `recentSlips`
  // (35-day window) so a 36+ day streak still renders the badge.
  const daysSinceLastSlip = (() => {
    if (todo.lastCompletedAt === null) return null;
    const lastDay = new Date(todo.lastCompletedAt);
    const today = new Date();
    const lastStart = new Date(
      lastDay.getFullYear(),
      lastDay.getMonth(),
      lastDay.getDate()
    ).getTime();
    const todayStart = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    ).getTime();
    return Math.max(
      0,
      Math.round((todayStart - lastStart) / (24 * 60 * 60 * 1000))
    );
  })();
  const periodLabel =
    todo.limitPeriod === "week"
      ? "this week"
      : todo.limitPeriod === "month"
        ? "this month"
        : `last ${windowDays}d`;
  // Severe tier: doubled the allowance or more. Used to upgrade the "Over
  // limit" copy so the messaging escalates instead of staying flat.
  const wayOverLimit =
    todo.limitCount !== null && count >= todo.limitCount * 2;

  // Days-since-last-slip badge. Stays silent when the user is still under
  // their limit so a slip in moderation doesn't read as guilt; surfaces
  // "Slipped today" only once they've crossed the cap.
  let sinceLabel: string | null = null;
  if (daysSinceLastSlip !== null) {
    if (daysSinceLastSlip === 0 && status === "over") {
      sinceLabel = "Slipped today";
    } else if (daysSinceLastSlip > 0 && status !== "over") {
      sinceLabel =
        daysSinceLastSlip === 1
          ? "1 day since"
          : `${daysSinceLastSlip} days since`;
    }
  }

  const tone = avoidToneClasses(status);

  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${tone.row}`}
    >
      <button
        onClick={onSlip}
        disabled={buttonDisabled}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-focus disabled:cursor-not-allowed disabled:opacity-50 ${tone.button}`}
        aria-label={slippedToday ? "Already logged today" : "Record a slip"}
      >
        {slippedToday ? "✓" : "+1"}
      </button>
      <div className="min-w-0 flex-1">
        <span className="block break-words text-on-surface">{todo.title}</span>
        {todo.description && (
          <span className="mt-0.5 block break-words text-xs text-on-surface/60">
            {todo.description}
          </span>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
          <VisibilityBadge isPersonal={todo.isPersonal} />
          {todo.limitCount !== null ? (
            <span className={tone.count}>
              {count} / {todo.limitCount} {periodLabel}
            </span>
          ) : (
            <span className="text-on-surface/60">
              {count} slip{count === 1 ? "" : "s"} {periodLabel}
            </span>
          )}
          {sinceLabel && (
            <span className="text-on-surface/60">{sinceLabel}</span>
          )}
          {todo.oncePerDay && (
            <span className="text-on-surface/50">Once per day</span>
          )}
          {status === "warn" && (
            <span className="font-medium text-warning">Close to limit</span>
          )}
          {status === "over" && (
            <span className="font-medium text-danger">
              {wayOverLimit ? "Careful here" : "Over limit"}
            </span>
          )}
        </div>
      </div>
      <button
        onClick={onOpen}
        className="shrink-0 rounded p-1 text-on-surface/60 hover:text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
        aria-label="Avoid todo settings"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
        </svg>
      </button>
    </div>
  );
}

function UndoSlipToast({
  title,
  onUndo,
  onDismiss,
}: {
  title: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-4 z-40 mx-auto flex max-w-sm items-center gap-3 rounded-lg border border-border-on-surface bg-surface px-4 py-3 shadow-lg shadow-black/40"
      style={{ marginBottom: "env(safe-area-inset-bottom)" }}
    >
      <span className="min-w-0 flex-1 truncate text-sm text-on-surface">
        Slip logged for {title}
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
          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>
    </div>
  );
}

function avoidToneClasses(status: AvoidStatus): {
  row: string;
  button: string;
  count: string;
} {
  if (status === "over") {
    return {
      row: "border-danger/50 bg-danger/5",
      button: "border-2 border-danger bg-danger/10 text-danger hover:bg-danger/20",
      count: "font-medium text-danger",
    };
  }
  if (status === "warn") {
    return {
      row: "border-warning/50 bg-warning/5",
      button: "border-2 border-warning bg-warning/10 text-warning hover:bg-warning/20",
      count: "font-medium text-warning",
    };
  }
  return {
    row: "border-border-on-surface bg-surface",
    button:
      "border-2 border-border text-on-surface/70 hover:border-focus hover:text-on-surface",
    count: "text-on-surface/70",
  };
}

function AddSubtaskForm({ onAdd }: { onAdd: (title: string) => void | Promise<void> }) {
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setAdding(true);
        await onAdd(title);
        setTitle("");
        setAdding(false);
      }}
      className="mt-2 flex gap-2"
    >
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a subtask..."
        className="flex-1 rounded-lg border border-border bg-input px-3 py-1.5 text-sm text-input-text placeholder-input-placeholder focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
        maxLength={500}
      />
      <button
        type="submit"
        disabled={adding || !title.trim()}
        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {adding ? "..." : "Add"}
      </button>
    </form>
  );
}

const WEEKDAY_LABELS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

const ORDINAL_LABELS: ReadonlyArray<{ value: Exclude<RecurrenceOrdinal, null>; label: string }> = [
  { value: "first", label: "First" },
  { value: "second", label: "Second" },
  { value: "third", label: "Third" },
  { value: "fourth", label: "Fourth" },
  { value: "last", label: "Last" },
];

function EditTodoModal({
  todo,
  canEditVisibility,
  onCancel,
  onSave,
  onDelete,
}: {
  todo: Todo;
  canEditVisibility: boolean;
  onCancel: () => void;
  onSave: (patch: {
    title: string;
    description: string | null;
    isPersonal: boolean;
    recurrence: Recurrence;
    recurrenceWeekday: number | null;
    recurrenceDayOfMonth: number | null;
    recurrenceOrdinal: RecurrenceOrdinal;
    pinnedTo: PinnedTo;
    kind: TodoKind;
    limitCount: number | null;
    limitPeriod: LimitPeriod;
    oncePerDay: boolean;
  }) => void | Promise<void>;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(todo.title);
  const [description, setDescription] = useState(todo.description ?? "");
  const [isPersonal, setIsPersonal] = useState(todo.isPersonal);
  const [recurrence, setRecurrence] = useState<Recurrence>(todo.recurrence);
  // Anchor inputs default to sensible values when the user picks a scheduled
  // recurrence on a row that doesn't have anchors yet (creation-style flow).
  // Today's weekday/date give a "today is the day" default the user can adjust.
  const todayDate = new Date();
  const [weekdayInput, setWeekdayInput] = useState<number>(
    todo.recurrenceWeekday ?? todayDate.getDay()
  );
  const [dayOfMonthInput, setDayOfMonthInput] = useState<number>(
    todo.recurrenceDayOfMonth ?? todayDate.getDate()
  );
  const [ordinalInput, setOrdinalInput] = useState<Exclude<RecurrenceOrdinal, null>>(
    todo.recurrenceOrdinal ?? "first"
  );
  const [pinnedTo, setPinnedTo] = useState<PinnedTo>(todo.pinnedTo);
  const [kind, setKind] = useState<TodoKind>(todo.kind);
  const [limitCountInput, setLimitCountInput] = useState<string>(
    todo.limitCount !== null ? String(todo.limitCount) : ""
  );
  const [limitPeriod, setLimitPeriod] = useState<LimitPeriod>(
    todo.limitPeriod ?? "week"
  );
  const [oncePerDay, setOncePerDay] = useState(todo.oncePerDay);
  const [saving, setSaving] = useState(false);

  const isAvoid = kind === "avoid";
  const isScheduled =
    recurrence === "weekday" ||
    recurrence === "monthly_day" ||
    recurrence === "monthly_weekday";
  // Pinning rules:
  // - Avoid todos: never pinnable.
  // - Daily recurring: pin is redundant (already in Today).
  // - Weekly recurring: only pin to Today is meaningful (surfaces it in
  //   the daily section). Pin to This Week would be redundant.
  // - Scheduled recurring: pin is redundant (auto-place on the scheduled day).
  // - Non-recurring "do": both pin options allowed.
  const pinDisabled = recurrence === "daily" || isScheduled || isAvoid;
  const allowPinDay = !isAvoid && recurrence !== "daily" && !isScheduled;
  const allowPinWeek = !isAvoid && recurrence === null;
  const recurrenceDisabled = isAvoid;
  // For pinDisabled rows we still surface the persisted pin value so a legacy
  // recurring+pinned (or avoid+pinned) row isn't stranded — the user can
  // explicitly clear it via "No pin". The select itself is only fully disabled
  // when there's nothing to clear.
  const effectivePinned: PinnedTo = pinnedTo;
  const pinSelectDisabled = pinDisabled && effectivePinned === null;
  const effectiveRecurrence: Recurrence = recurrenceDisabled ? null : recurrence;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    // Empty input means "no limit" — both fields drop together so the
    // server-side refinement (count⇔period) is satisfied.
    const trimmedLimit = limitCountInput.trim();
    const parsedLimit = trimmedLimit === "" ? null : Number(trimmedLimit);
    if (
      isAvoid &&
      parsedLimit !== null &&
      (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 999)
    ) {
      return;
    }
    setSaving(true);
    // Only emit the anchor field that matches the chosen recurrence; the
    // others go null so the server doesn't keep stale anchors after a type
    // switch (e.g., monthly_day → daily). Mirrors the server PATCH handler's
    // anchor-clearing logic.
    const isWeekday = effectiveRecurrence === "weekday";
    const isMonthlyDay = effectiveRecurrence === "monthly_day";
    const isMonthlyWeekday = effectiveRecurrence === "monthly_weekday";
    await onSave({
      title: title.trim(),
      description: description.trim() ? description.trim() : null,
      isPersonal,
      recurrence: effectiveRecurrence,
      recurrenceWeekday:
        isWeekday || isMonthlyWeekday ? weekdayInput : null,
      recurrenceDayOfMonth: isMonthlyDay ? dayOfMonthInput : null,
      recurrenceOrdinal: isMonthlyWeekday ? ordinalInput : null,
      pinnedTo: effectivePinned,
      kind,
      limitCount: isAvoid ? parsedLimit : null,
      limitPeriod: isAvoid && parsedLimit !== null ? limitPeriod : null,
      oncePerDay: isAvoid ? oncePerDay : false,
    });
    setSaving(false);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit todo"
      className="fixed inset-0 z-50 bg-background"
    >
      <form
        onSubmit={handleSubmit}
        className="flex h-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-1 text-sm text-text-muted hover:text-text focus:outline-none focus:ring-2 focus:ring-focus"
          >
            Cancel
          </button>
          <h3 className="text-base font-semibold text-text">Edit todo</h3>
          <button
            type="submit"
            disabled={saving || !title.trim()}
            className="rounded px-2 py-1 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="mx-auto max-w-2xl">
            <label className="mb-4 block">
              <span className="mb-1 block text-sm text-text-muted">Title</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={500}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-input-placeholder focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
              />
            </label>

            <label className="mb-4 block">
              <span className="mb-1 block text-sm text-text-muted">Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={5000}
                rows={5}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-input-placeholder focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
              />
            </label>

            <fieldset className={`mb-4 ${canEditVisibility ? "" : "opacity-60"}`}>
              <legend className="mb-1 block text-sm text-text-muted">
                Visibility
              </legend>
              <div className="grid grid-cols-2 gap-2">
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    !isPersonal
                      ? "border-focus bg-surface-hover text-text"
                      : "border-border bg-input text-text-muted"
                  } ${canEditVisibility ? "" : "cursor-not-allowed"}`}
                >
                  <input
                    type="radio"
                    name="visibility"
                    value="joined"
                    checked={!isPersonal}
                    disabled={!canEditVisibility}
                    onChange={() => setIsPersonal(false)}
                    className="sr-only"
                  />
                  <span>Joined</span>
                </label>
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    isPersonal
                      ? "border-focus bg-surface-hover text-text"
                      : "border-border bg-input text-text-muted"
                  } ${canEditVisibility ? "" : "cursor-not-allowed"}`}
                >
                  <input
                    type="radio"
                    name="visibility"
                    value="personal"
                    checked={isPersonal}
                    disabled={!canEditVisibility}
                    onChange={() => setIsPersonal(true)}
                    className="sr-only"
                  />
                  <span>Personal</span>
                </label>
              </div>
              <p className="mt-1 text-xs text-text-muted">
                {canEditVisibility
                  ? isPersonal
                    ? "Only you can see and edit this todo. Subtasks inherit this setting."
                    : "Both users can see and edit this todo. Subtasks inherit this setting."
                  : "Only the original creator can change visibility."}
              </p>
            </fieldset>

            <fieldset className="mb-4">
              <legend className="mb-1 block text-sm text-text-muted">
                Track type
              </legend>
              <div className="grid grid-cols-2 gap-2">
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    kind === "do"
                      ? "border-focus bg-surface-hover text-text"
                      : "border-border bg-input text-text-muted"
                  }`}
                >
                  <input
                    type="radio"
                    name="kind"
                    value="do"
                    checked={kind === "do"}
                    onChange={() => setKind("do")}
                    className="sr-only"
                  />
                  <span>Do this</span>
                </label>
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    kind === "avoid"
                      ? "border-warning bg-surface-hover text-text"
                      : "border-border bg-input text-text-muted"
                  }`}
                >
                  <input
                    type="radio"
                    name="kind"
                    value="avoid"
                    checked={kind === "avoid"}
                    onChange={() => setKind("avoid")}
                    className="sr-only"
                  />
                  <span>Avoid this</span>
                </label>
              </div>
              <p className="mt-1 text-xs text-text-muted">
                {isAvoid
                  ? "Tap +1 to log a slip; analytics tracks slip count and time since last slip."
                  : "Standard checkbox todo."}
              </p>
            </fieldset>

            <label className={`mb-4 block ${recurrenceDisabled ? "opacity-50" : ""}`}>
              <span className="mb-1 block text-sm text-text-muted">Repeats</span>
              <select
                value={effectiveRecurrence ?? ""}
                onChange={(e) => setRecurrence((e.target.value || null) as Recurrence)}
                disabled={recurrenceDisabled}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus disabled:cursor-not-allowed"
              >
                <option value="">No repeat</option>
                <option value="daily">Daily — resets at local midnight</option>
                <option value="weekly">Weekly — tracked weekly, resets at local midnight</option>
                <option value="weekday">
                  Weekly on a specific day — only appears that day
                </option>
                <option value="monthly_day">
                  Monthly on a specific date — only appears that date
                </option>
                <option value="monthly_weekday">
                  Monthly on a specific weekday — e.g. last Friday
                </option>
              </select>
              {recurrenceDisabled && (
                <span className="mt-1 block text-xs text-text-muted">
                  Avoid todos don&apos;t use recurrence — they always stay visible
                  so you can log slips.
                </span>
              )}
              {effectiveRecurrence === "weekday" && (
                <span className="mt-1 block text-xs text-text-muted">
                  Hidden until that weekday rolls around. Persists from then on
                  until you complete it.
                </span>
              )}
              {(effectiveRecurrence === "monthly_day" ||
                effectiveRecurrence === "monthly_weekday") && (
                <span className="mt-1 block text-xs text-text-muted">
                  Hidden until that date arrives. Persists from then on until
                  you complete it.
                </span>
              )}
            </label>

            {effectiveRecurrence === "weekday" && (
              <label className="mb-4 block">
                <span className="mb-1 block text-sm text-text-muted">
                  Day of the week
                </span>
                <select
                  value={String(weekdayInput)}
                  onChange={(e) => setWeekdayInput(Number(e.target.value))}
                  className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
                >
                  {WEEKDAY_LABELS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {effectiveRecurrence === "monthly_day" && (
              <label className="mb-4 block">
                <span className="mb-1 block text-sm text-text-muted">
                  Day of the month
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={31}
                  value={String(dayOfMonthInput)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n) && n >= 1 && n <= 31) {
                      setDayOfMonthInput(n);
                    } else if (e.target.value === "") {
                      setDayOfMonthInput(1);
                    }
                  }}
                  className="w-24 rounded-lg border border-border bg-input px-3 py-2 text-input-text focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
                />
                <span className="mt-1 block text-xs text-text-muted">
                  In months with fewer days (e.g. February for the 30th), the
                  occurrence falls on the last day of that month instead.
                </span>
              </label>
            )}

            {effectiveRecurrence === "monthly_weekday" && (
              <div className="mb-4 grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-sm text-text-muted">Which</span>
                  <select
                    value={ordinalInput}
                    onChange={(e) =>
                      setOrdinalInput(
                        e.target.value as Exclude<RecurrenceOrdinal, null>
                      )
                    }
                    className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
                  >
                    {ORDINAL_LABELS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm text-text-muted">Weekday</span>
                  <select
                    value={String(weekdayInput)}
                    onChange={(e) => setWeekdayInput(Number(e.target.value))}
                    className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
                  >
                    {WEEKDAY_LABELS.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {isAvoid && (
              <fieldset className="mb-4">
                <legend className="mb-1 block text-sm text-text-muted">
                  Warn me if I slip more than
                </legend>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={999}
                    value={limitCountInput}
                    onChange={(e) => setLimitCountInput(e.target.value)}
                    placeholder="No limit"
                    className="w-24 rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-input-placeholder focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
                  />
                  <span className="text-sm text-text-muted">times per</span>
                  <select
                    value={limitPeriod ?? "week"}
                    onChange={(e) =>
                      setLimitPeriod(e.target.value as "week" | "month")
                    }
                    className="rounded-lg border border-border bg-input px-3 py-2 text-input-text focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
                  >
                    <option value="week">week (Mon–Sun)</option>
                    <option value="month">calendar month</option>
                  </select>
                </div>
                <p className="mt-1 text-xs text-text-muted">
                  Leave blank to track without a limit. Counter resets at the
                  start of each calendar period.
                </p>
              </fieldset>
            )}

            {isAvoid && (
              <label className="mb-4 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={oncePerDay}
                  onChange={(e) => setOncePerDay(e.target.checked)}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-2 focus:ring-focus"
                />
                <span className="text-sm text-text">Limit to once per day</span>
                <span className="text-xs text-text-muted">
                  (button disables until midnight after each slip)
                </span>
              </label>
            )}

            <label className={`mb-4 block ${pinSelectDisabled ? "opacity-50" : ""}`}>
              <span className="mb-1 block text-sm text-text-muted">Pin to</span>
              <select
                value={effectivePinned ?? ""}
                disabled={pinSelectDisabled}
                onChange={(e) =>
                  setPinnedTo((e.target.value || null) as PinnedTo)
                }
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus disabled:cursor-not-allowed"
              >
                <option value="">No pin</option>
                {/* Only offer pin states the server will accept for the
                    current recurrence/kind. Legacy rows keep their
                    currently-set option so the user can re-select it
                    or clear it via "No pin". */}
                {(allowPinDay || effectivePinned === "day") && (
                  <option value="day">Today</option>
                )}
                {(allowPinWeek || effectivePinned === "week") && (
                  <option value="week">This Week</option>
                )}
              </select>
              {pinDisabled && effectivePinned !== null && (
                <span className="mt-1 block text-xs text-text-muted">
                  {isAvoid
                    ? "Avoid todos can't be pinned — clear it to keep this row as Avoid."
                    : "Daily recurring todos already live in Today — clear the pin or change recurrence."}
                </span>
              )}
              {pinSelectDisabled && (
                <span className="mt-1 block text-xs text-text-muted">
                  {isAvoid
                    ? "Not available for avoid todos."
                    : "Daily recurring todos already live in Today."}
                </span>
              )}
              {recurrence === "weekly" && effectivePinned === "week" && (
                <span className="mt-1 block text-xs text-text-muted">
                  Weekly recurring todos already live in This Week — clear the
                  pin or pin to Today instead.
                </span>
              )}
            </label>
          </div>
        </div>

        <div className="border-t border-border px-4 py-3">
          <div className="mx-auto flex max-w-2xl justify-start">
            <button
              type="button"
              onClick={onDelete}
              className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-sm font-medium text-danger hover:bg-danger hover:text-white focus:outline-none focus:ring-2 focus:ring-danger"
            >
              Delete
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function EditSubtaskModal({
  subtask,
  onCancel,
  onSave,
  onDelete,
}: {
  subtask: Todo;
  onCancel: () => void;
  onSave: (patch: { title: string; description: string | null; pinnedTo: PinnedTo }) => void | Promise<void>;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(subtask.title);
  const [description, setDescription] = useState(subtask.description ?? "");
  const [pinnedTo, setPinnedTo] = useState<PinnedTo>(subtask.pinnedTo);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    await onSave({
      title: title.trim(),
      description: description.trim() ? description.trim() : null,
      pinnedTo,
    });
    setSaving(false);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit subtask"
      className="fixed inset-0 z-50 bg-background"
    >
      <form
        onSubmit={handleSubmit}
        className="flex h-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-1 text-sm text-text-muted hover:text-text focus:outline-none focus:ring-2 focus:ring-focus"
          >
            Cancel
          </button>
          <h3 className="text-base font-semibold text-text">Edit subtask</h3>
          <button
            type="submit"
            disabled={saving || !title.trim()}
            className="rounded px-2 py-1 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="mx-auto max-w-2xl">
            <label className="mb-4 block">
              <span className="mb-1 block text-sm text-text-muted">Title</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={500}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-input-placeholder focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
              />
            </label>

            <label className="mb-4 block">
              <span className="mb-1 block text-sm text-text-muted">Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={5000}
                rows={5}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-input-placeholder focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
              />
            </label>

            <label className="mb-4 block">
              <span className="mb-1 block text-sm text-text-muted">Pin to</span>
              <select
                value={pinnedTo ?? ""}
                onChange={(e) =>
                  setPinnedTo((e.target.value || null) as PinnedTo)
                }
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
              >
                <option value="">No pin</option>
                <option value="day">Today</option>
                <option value="week">This Week</option>
              </select>
            </label>
          </div>
        </div>

        <div className="border-t border-border px-4 py-3">
          <div className="mx-auto flex max-w-2xl justify-start">
            <button
              type="button"
              onClick={onDelete}
              className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-sm font-medium text-danger hover:bg-danger hover:text-white focus:outline-none focus:ring-2 focus:ring-danger"
            >
              Delete
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
