"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { type TodoDTO, type Recurrence } from "@/lib/api-client";
import { isCompletedTodoExpired, isRecurringResetDue } from "@/lib/recurrence";
import {
  cascadeCompleteChildren,
  cascadeUncompleteChildren,
  getRecurringParentIds,
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

type TabKey = "joined" | "personal";

export default function TodosPage() {
  const repo = useTodoRepository();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [newTitle, setNewTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Todo | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("joined");
  const [justCompletedIds, setJustCompletedIds] = useState<Set<string>>(() => new Set());
  const resettingRef = useRef<Set<string>>(new Set());
  const pendingToggleRef = useRef<Set<string>>(new Set());
  const expiringRef = useRef<Set<string>>(new Set());
  const completionTimersRef = useRef<Map<string, number>>(new Map());
  const recentlyToggledRef = useRef(false);

  // Delete completed non-recurring rows (top-level or nested) once the user's
  // local clock has crossed midnight after they were completed. Mirrors the
  // server cron's intent but honors the browser's IANA timezone, so a todo
  // completed at 11pm disappears at 00:00 local rather than 24h after the fact.
  const expireCompleted = useCallback(
    async (list: Todo[]) => {
      const now = Date.now();
      // Subtasks of recurring parents reset with the parent each cycle, so
      // they must not be expired by the local 24h cleanup.
      const recurringParentIds = getRecurringParentIds(list);
      const eligible = list.filter(
        (t) =>
          t.completed &&
          t.recurrence === null &&
          !(t.parentId !== null && recurringParentIds.has(t.parentId)) &&
          !expiringRef.current.has(t.id) &&
          isCompletedTodoExpired(t.lastCompletedAt, now)
      );
      // Skip subtasks whose parent is also expiring in this pass — both the
      // DB (ON DELETE CASCADE) and the local repo drop orphans for us, so an
      // explicit delete would race and return "Not found", leaving the row
      // stuck in client state until next load.
      const expiringParentIds = new Set(
        eligible.filter((t) => t.parentId === null).map((t) => t.id)
      );
      const toDelete = eligible.filter(
        (t) => t.parentId === null || !expiringParentIds.has(t.parentId)
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
        isRecurringResetDue(t.recurrence, t.lastCompletedAt, now)
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
      let next = [...prev];
      for (const { data } of results) {
        if (!data) continue;
        const i = next.findIndex((t) => t.id === data.id);
        if (i !== -1) next[i] = data;
        // Mirror the server-side cascade-uncomplete so subtasks of the
        // recurring parent reset with it. Without this, subtasks would stay
        // completed in client state until the next refetch.
        next = cascadeUncompleteChildren(next, data.id);
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

  // Refresh when the app comes back into focus (e.g. switching apps on iPhone)
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        loadTodos();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [loadTodos]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setAdding(true);

    const { data } = await repo.create({
      title: newTitle.trim(),
      isPersonal: activeTab === "personal",
      recurrence: null,
    });
    if (data) {
      setTodos((prev) => [...prev, data]);
      setNewTitle("");
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
      // And the symmetric reset for recurring parents: uncompleting a
      // recurring parent uncompletes its completed subtasks, mirroring the
      // server transaction so the next cycle starts clean.
      if (!next && todo.parentId === null && todo.recurrence !== null) {
        updated = cascadeUncompleteChildren(updated, todo.id);
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
    }
  }

  async function handleAddSubtask(parentId: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    const { data } = await repo.create({ parentId, title: trimmed });
    if (data) {
      setTodos((prev) => [...prev, data]);
    }
  }

  async function handleTogglePin(todo: Todo) {
    const next = !todo.pinnedToWeek;
    setTodos((prev) =>
      prev.map((t) => (t.id === todo.id ? { ...t, pinnedToWeek: next } : t))
    );
    const { data, error } = await repo.update(todo.id, { pinnedToWeek: next });
    if (error) {
      setTodos((prev) =>
        prev.map((t) => (t.id === todo.id ? { ...t, pinnedToWeek: !next } : t))
      );
      return;
    }
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
    }
  }

  async function handleEditSave(
    id: string,
    patch: { title: string; description: string | null; recurrence: Recurrence; pinnedToWeek: boolean }
  ) {
    const { data } = await repo.update(id, patch);
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
      setEditing(null);
    }
  }

  async function handleSubtaskEditSave(
    id: string,
    patch: { title: string; description: string | null; pinnedToWeek: boolean }
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

    const previous = todos;
    // Optimistic: move locally, the API will renormalize sortOrder.
    // pinnedToWeek is preserved on demote (subtasks still surface in This Week
    // when pinned).
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

  const visibleTodos = todos.filter((t) =>
    activeTab === "personal" ? t.isPersonal : !t.isPersonal
  );
  const topLevel = visibleTodos.filter((t) => t.parentId === null);
  // A todo that was just completed stays in its active section until the
  // animation finishes, so the user sees the confirmation where they tapped
  // before the row settles into Complete.
  const isActiveSlot = (t: Todo) => !t.completed || justCompletedIds.has(t.id);
  const thisWeekTodos = topLevel.filter(
    (t) => isActiveSlot(t) && (t.recurrence === "weekly" || t.pinnedToWeek)
  );
  const dailyTodos = topLevel.filter(
    (t) => isActiveSlot(t) && t.recurrence === "daily" && !t.pinnedToWeek
  );
  const regularActive = topLevel.filter(
    (t) => isActiveSlot(t) && t.recurrence === null && !t.pinnedToWeek
  );
  const completedTodos = topLevel.filter((t) => t.completed && !justCompletedIds.has(t.id));

  // Subtasks pinned to This Week. Subtasks inherit isPersonal from their parent
  // at create-time, so this filter mirrors the per-tab visibleTodos rule.
  const thisWeekSubtasks = sortSubtasks(
    visibleTodos.filter(
      (t) =>
        t.parentId !== null &&
        t.pinnedToWeek &&
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
            // Hide the pin control on recurring todos (daily are excluded from
            // This Week, weekly already live there), but keep it for a legacy
            // recurring+pinned row so the user can unpin it.
            todo.recurrence !== null && !todo.pinnedToWeek
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
      <div
        role="tablist"
        aria-label="Todo lists"
        className="mb-4 flex gap-1 rounded-lg border border-border-on-surface bg-surface p-1"
      >
        {(["joined", "personal"] as const).map((tab) => {
          const isActive = activeTab === tab;
          return (
            <button
              key={tab}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-surface ${
                isActive
                  ? "bg-primary font-semibold text-white shadow-md"
                  : "font-medium text-on-surface/60 hover:bg-surface-hover hover:text-on-surface"
              }`}
            >
              {tab === "joined" ? "Joined" : "Personal"}
            </button>
          );
        })}
      </div>

      <div className="mb-6">
        <h2 className="text-xl font-semibold text-text">
          {activeTab === "joined" ? "Joined Todos" : "Personal Todos"}
        </h2>
        <p className="text-sm text-text-muted">
          {thisWeekTodos.length + dailyTodos.length + regularActive.length + thisWeekSubtasks.length} remaining
          {completedTodos.length > 0 ? `, ${completedTodos.length} done` : ""}
        </p>
      </div>

      {/* Add todo form */}
      <form onSubmit={handleAdd} className="mb-6 flex gap-2">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add a new todo..."
          className="flex-1 rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-gray-400 focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
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

      {/* Daily section */}
      {dailyTodos.length > 0 && (
        <Section title="Daily" hint="Resets at local midnight">
          <DraggableLongPressList
            items={sortTodos(dailyTodos)}
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

      {/* Complete todos (any recurrence) */}
      {completedTodos.length > 0 && (
        <Section title="Complete">
          <div className="space-y-2">
            {completedTodos.map((todo) => (
              <div key={todo.id}>{renderTopLevelTodo(todo)}</div>
            ))}
          </div>
        </Section>
      )}

      {/* Empty state */}
      {visibleTodos.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-text-muted">
            {activeTab === "personal"
              ? "No personal todos yet. Add one above to get started."
              : "No todos yet. Add one above to get started."}
          </p>
        </div>
      )}

      {editing && editing.parentId === null && (
        <EditTodoModal
          todo={editing}
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
  const pinned = todo.pinnedToWeek;
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
        {todo.description && (
          <span className={`mt-0.5 block break-words text-xs ${done ? "text-on-surface/40" : "text-on-surface/60"}`}>
            {todo.description}
          </span>
        )}
        <span className={`text-xs ${done ? "text-on-surface/40" : "text-on-surface/60"}`}>
          {todo.createdBy} &middot; {formatRelativeDate(todo.createdAt)}
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
          aria-label={expanded ? "Collapse subtasks" : "Expand subtasks"}
          aria-expanded={expanded}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
          </svg>
        </button>
      )}

      {onTogglePin && !done && (
        <button
          onClick={onTogglePin}
          className={`shrink-0 rounded p-1 focus:outline-none focus:ring-2 focus:ring-primary ${
            pinned ? "text-primary" : "text-on-surface/60 hover:text-on-surface"
          }`}
          aria-label={pinned ? "Unpin from This Week" : "Pin to This Week"}
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
  const pinned = subtask.pinnedToWeek;
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
            pinned ? "text-primary" : "text-on-surface/60 hover:text-on-surface"
          }`}
          aria-label={pinned ? "Unpin from This Week" : "Pin to This Week"}
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
        className="flex-1 rounded-lg border border-border bg-input px-3 py-1.5 text-sm text-input-text placeholder-gray-400 focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
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

function EditTodoModal({
  todo,
  onCancel,
  onSave,
  onDelete,
}: {
  todo: Todo;
  onCancel: () => void;
  onSave: (patch: { title: string; description: string | null; recurrence: Recurrence; pinnedToWeek: boolean }) => void | Promise<void>;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(todo.title);
  const [description, setDescription] = useState(todo.description ?? "");
  const [recurrence, setRecurrence] = useState<Recurrence>(todo.recurrence);
  const [pinnedToWeek, setPinnedToWeek] = useState(todo.pinnedToWeek);
  const [saving, setSaving] = useState(false);

  // Recurring todos can't be pinned: daily are excluded from This Week, and
  // weekly already surface there. Force the pin off when the user picks any
  // recurrence; the API would reject the combination otherwise.
  const pinDisabled = recurrence !== null;
  const effectivePinned = pinDisabled ? false : pinnedToWeek;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    await onSave({
      title: title.trim(),
      description: description.trim() ? description.trim() : null,
      recurrence,
      pinnedToWeek: effectivePinned,
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
      <form onSubmit={handleSubmit} className="flex h-full flex-col">
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
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-gray-400 focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
              />
            </label>

            <label className="mb-4 block">
              <span className="mb-1 block text-sm text-text-muted">Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={5000}
                rows={5}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-gray-400 focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
              />
            </label>

            <label className="mb-4 block">
              <span className="mb-1 block text-sm text-text-muted">Repeats</span>
              <select
                value={recurrence ?? ""}
                onChange={(e) => setRecurrence((e.target.value || null) as Recurrence)}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
              >
                <option value="">No repeat</option>
                <option value="daily">Daily — resets at local midnight</option>
                <option value="weekly">Weekly — resets 7 days later at local midnight</option>
              </select>
            </label>

            <label className={`mb-4 flex items-center gap-2 ${pinDisabled ? "opacity-50" : ""}`}>
              <input
                type="checkbox"
                checked={effectivePinned}
                disabled={pinDisabled}
                onChange={(e) => setPinnedToWeek(e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-2 focus:ring-focus disabled:cursor-not-allowed"
              />
              <span className="text-sm text-text">Pin to This Week</span>
              {pinDisabled && (
                <span className="text-xs text-text-muted">
                  (not available for recurring todos)
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
  onSave: (patch: { title: string; description: string | null; pinnedToWeek: boolean }) => void | Promise<void>;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(subtask.title);
  const [description, setDescription] = useState(subtask.description ?? "");
  const [pinnedToWeek, setPinnedToWeek] = useState(subtask.pinnedToWeek);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    await onSave({
      title: title.trim(),
      description: description.trim() ? description.trim() : null,
      pinnedToWeek,
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
      <form onSubmit={handleSubmit} className="flex h-full flex-col">
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
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-gray-400 focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
              />
            </label>

            <label className="mb-4 block">
              <span className="mb-1 block text-sm text-text-muted">Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={5000}
                rows={5}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-gray-400 focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
              />
            </label>

            <label className="mb-4 flex items-center gap-2">
              <input
                type="checkbox"
                checked={pinnedToWeek}
                onChange={(e) => setPinnedToWeek(e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-2 focus:ring-focus"
              />
              <span className="text-sm text-text">Pin to This Week</span>
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
