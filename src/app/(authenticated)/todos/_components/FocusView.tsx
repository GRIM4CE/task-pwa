"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type TodoDTO } from "@/lib/api-client";
import { isCompletedTodoExpired, isRecurringResetDue } from "@/lib/recurrence";
import { notifyStatsMayHaveChanged } from "@/lib/stats-events";
import {
  cascadeCompleteChildren,
  sortSubtasks,
  sortTodos,
} from "@/lib/todos/domain";
import { useTodoRepository } from "@/lib/todos/use-todo-repository";

type Todo = TodoDTO;

export default function FocusView() {
  const repo = useTodoRepository();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const resettingRef = useRef<Set<string>>(new Set());
  const expiringRef = useRef<Set<string>>(new Set());
  const pendingToggleRef = useRef<Set<string>>(new Set());
  const recentlyToggledRef = useRef(false);

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
          isRecurringResetDue(t.recurrence, t.lastCompletedAt, now)
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
      if (document.visibilityState === "visible") loadTodos();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [loadTodos]);

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

  // Today: daily-recurring "do" rows + anything pinned to the day, across both
  // scopes. Pinned-to-week takes precedence on legacy rows so a recurring row
  // pinned to the week stays out of focus.
  const topLevelToday = sortTodos(
    todos.filter(
      (t) =>
        t.parentId === null &&
        t.kind === "do" &&
        !t.completed &&
        t.pinnedTo !== "week" &&
        (t.recurrence === "daily" || t.pinnedTo === "day")
    )
  );
  const subtasksToday = sortSubtasks(
    todos.filter(
      (t) =>
        t.parentId !== null &&
        !t.completed &&
        t.pinnedTo === "day"
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

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-6 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-text">Focus</h2>
          <p className="text-sm text-text-muted">
            {total > 0
              ? `${total} todo${total === 1 ? "" : "s"} for today`
              : "All clear for today"}
          </p>
        </div>
        <Link
          href="/todos/joined"
          className="shrink-0 rounded-lg border border-border-on-surface px-3 py-1.5 text-sm text-on-surface/70 hover:bg-surface-hover hover:text-on-surface"
        >
          Manage
        </Link>
      </div>

      {total > 0 ? (
        <div className="space-y-2">
          {topLevelToday.map((todo) => (
            <FocusRow key={todo.id} todo={todo} onToggle={() => handleToggle(todo)} />
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
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border-on-surface px-4 py-12 text-center text-sm text-text-muted">
          Nothing pinned to today. Add a daily todo or pin one to the day from{" "}
          <Link href="/todos/joined" className="underline hover:text-on-surface">
            Manage
          </Link>
          .
        </div>
      )}
    </div>
  );
}

function FocusRow({
  todo,
  parentTitle,
  onToggle,
}: {
  todo: Todo;
  parentTitle?: string | null;
  onToggle: () => void;
}) {
  const done = todo.completed;
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
    </div>
  );
}
