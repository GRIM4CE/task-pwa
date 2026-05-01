"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { type TodoDTO, type Recurrence, type SubtaskDTO } from "@/lib/api-client";
import { isCompletedTodoExpired, isRecurringResetDue } from "@/lib/recurrence";
import { cascadeCompleteSubtasks, sortSubtasks } from "@/lib/todos/domain";
import { useTodoRepository } from "@/lib/todos/use-todo-repository";

type Todo = TodoDTO;
type Subtask = SubtaskDTO;

const LONG_PRESS_MS = 400;
const MOVE_CANCEL_PX = 10;

function sortTodos(list: Todo[]): Todo[] {
  return [...list].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return b.createdAt - a.createdAt;
  });
}

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
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [newTitle, setNewTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Todo | null>(null);
  const [editingSubtask, setEditingSubtask] = useState<Subtask | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("joined");
  const [justCompletedIds, setJustCompletedIds] = useState<Set<string>>(() => new Set());
  const resettingRef = useRef<Set<string>>(new Set());
  const pendingToggleRef = useRef<Set<string>>(new Set());
  const expiringRef = useRef<Set<string>>(new Set());
  const completionTimersRef = useRef<Map<string, number>>(new Map());

  // Delete completed non-recurring todos and completed subtasks once the user's
  // local clock has crossed midnight after they were completed. Mirrors the
  // server cron's intent but honors the browser's IANA timezone, so a todo
  // completed at 11pm disappears at 00:00 local rather than 24h after the fact.
  const expireCompleted = useCallback(
    async (todoList: Todo[], subtaskList: Subtask[]) => {
      const now = Date.now();
      const todosToDelete = todoList.filter(
        (t) =>
          t.completed &&
          t.recurrence === null &&
          !expiringRef.current.has(t.id) &&
          isCompletedTodoExpired(t.lastCompletedAt, now)
      );
      const expiringParentIds = new Set(todosToDelete.map((t) => t.id));
      // Skip subtasks whose parent is also being deleted in this pass — both
      // the DB (onDelete: cascade) and the local repository drop orphan
      // subtasks for us, so an explicit deleteSubtask would race and return
      // "Not found", leaving the row stuck in client state until next load.
      const subtasksToDelete = subtaskList.filter(
        (s) =>
          s.completed &&
          !expiringRef.current.has(s.id) &&
          !expiringParentIds.has(s.parentId) &&
          isCompletedTodoExpired(s.lastCompletedAt, now)
      );
      if (todosToDelete.length === 0 && subtasksToDelete.length === 0) return;

      todosToDelete.forEach((t) => expiringRef.current.add(t.id));
      subtasksToDelete.forEach((s) => expiringRef.current.add(s.id));

      const todoResults = await Promise.all(
        todosToDelete.map((t) =>
          repo.delete(t.id).then((r) => ({ id: t.id, ok: r.data?.success === true }))
        )
      );
      const subtaskResults = await Promise.all(
        subtasksToDelete.map((s) =>
          repo
            .deleteSubtask(s.id)
            .then((r) => ({ id: s.id, ok: r.data?.success === true }))
        )
      );

      const deletedTodoIds = new Set(
        todoResults.filter((r) => r.ok).map((r) => r.id)
      );
      const deletedSubtaskIds = new Set(
        subtaskResults.filter((r) => r.ok).map((r) => r.id)
      );

      if (deletedTodoIds.size > 0) {
        setTodos((prev) => prev.filter((t) => !deletedTodoIds.has(t.id)));
        // Drop any subtasks whose parent we just deleted — they were cascaded
        // server-side, so keeping them in client state would show orphans.
        setSubtasks((prev) => prev.filter((s) => !deletedTodoIds.has(s.parentId)));
      }
      if (deletedSubtaskIds.size > 0) {
        setSubtasks((prev) => prev.filter((s) => !deletedSubtaskIds.has(s.id)));
      }

      todosToDelete.forEach((t) => expiringRef.current.delete(t.id));
      subtasksToDelete.forEach((s) => expiringRef.current.delete(s.id));
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
      due.map((t) => repo.update(t.id, { completed: false }))
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
    const [todosResult, subtasksResult] = await Promise.all([
      repo.list(),
      repo.listSubtasks(),
    ]);
    if (todosResult.data) {
      setTodos(todosResult.data);
      resetDueRecurring(todosResult.data);
    }
    if (subtasksResult.data) {
      setSubtasks(subtasksResult.data);
    }
    if (todosResult.data || subtasksResult.data) {
      expireCompleted(todosResult.data ?? [], subtasksResult.data ?? []);
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
    if (pendingToggleRef.current.has(todo.id)) return;
    pendingToggleRef.current.add(todo.id);

    const next = !todo.completed;
    const previous = {
      completed: todo.completed,
      lastCompletedAt: todo.lastCompletedAt,
    };
    const previousSubtasks = subtasks;

    setTodos((prev) =>
      prev.map((t) =>
        t.id === todo.id
          ? { ...t, completed: next, lastCompletedAt: next ? Date.now() : null }
          : t
      )
    );

    // Mirror the server-side cascade-complete transaction locally so subtasks
    // disappear from the active view immediately. Cascaded subtasks settle
    // without animation — only the directly-tapped row animates.
    if (next) {
      setSubtasks((prev) => cascadeCompleteSubtasks(prev, todo.id));
    }

    markJustCompleted(todo.id, next);

    const { data, error } = await repo.update(todo.id, { completed: next });
    pendingToggleRef.current.delete(todo.id);

    if (error) {
      setTodos((prev) =>
        prev.map((t) => (t.id === todo.id ? { ...t, ...previous } : t))
      );
      if (next) setSubtasks(previousSubtasks);
      return;
    }

    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
    }
  }

  async function handleToggleSubtask(subtask: Subtask) {
    if (pendingToggleRef.current.has(subtask.id)) return;
    pendingToggleRef.current.add(subtask.id);

    const next = !subtask.completed;
    const previous = {
      completed: subtask.completed,
      lastCompletedAt: subtask.lastCompletedAt,
    };

    setSubtasks((prev) =>
      prev.map((s) =>
        s.id === subtask.id
          ? { ...s, completed: next, lastCompletedAt: next ? Date.now() : null }
          : s
      )
    );

    markJustCompleted(subtask.id, next);

    const { data, error } = await repo.updateSubtask(subtask.id, { completed: next });
    pendingToggleRef.current.delete(subtask.id);

    if (error) {
      setSubtasks((prev) =>
        prev.map((s) => (s.id === subtask.id ? { ...s, ...previous } : s))
      );
      return;
    }

    if (data) {
      setSubtasks((prev) => prev.map((s) => (s.id === data.id ? data : s)));
    }
  }

  async function handleAddSubtask(parentId: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    const { data } = await repo.createSubtask({ parentId, title: trimmed });
    if (data) {
      setSubtasks((prev) => [...prev, data]);
    }
  }

  async function handleTogglePinSubtask(subtask: Subtask) {
    const next = !subtask.pinnedToWeek;
    setSubtasks((prev) =>
      prev.map((s) => (s.id === subtask.id ? { ...s, pinnedToWeek: next } : s))
    );
    const { data, error } = await repo.updateSubtask(subtask.id, { pinnedToWeek: next });
    if (error) {
      setSubtasks((prev) =>
        prev.map((s) => (s.id === subtask.id ? { ...s, pinnedToWeek: !next } : s))
      );
      return;
    }
    if (data) {
      setSubtasks((prev) => prev.map((s) => (s.id === data.id ? data : s)));
    }
  }

  async function handleEditSubtaskSave(
    id: string,
    patch: { title: string; description: string | null; pinnedToWeek: boolean }
  ) {
    const { data } = await repo.updateSubtask(id, patch);
    if (data) {
      setSubtasks((prev) => prev.map((s) => (s.id === data.id ? data : s)));
      setEditingSubtask(null);
    }
  }

  async function handleDeleteSubtask(id: string) {
    const { data } = await repo.deleteSubtask(id);
    if (data?.success) {
      setSubtasks((prev) => prev.filter((s) => s.id !== id));
      if (editingSubtask?.id === id) setEditingSubtask(null);
    }
  }

  async function handleSubtaskReorder(parentId: string, newIds: string[]) {
    const prev = subtasks;
    setSubtasks((current) => {
      const inSet = new Set(newIds);
      const values = current
        .filter((s) => s.parentId === parentId && inSet.has(s.id))
        .map((s) => s.sortOrder)
        .sort((a, b) => a - b);
      const assigned: Record<string, number> = {};
      newIds.forEach((id, i) => {
        assigned[id] = values[i];
      });
      return current.map((s) =>
        assigned[s.id] !== undefined ? { ...s, sortOrder: assigned[s.id] } : s
      );
    });

    const { error } = await repo.reorderSubtasks(parentId, newIds);
    if (error) {
      setSubtasks(prev);
    }
  }

  async function handleDelete(id: string) {
    const { data } = await repo.delete(id);
    if (data?.success) {
      setTodos((prev) => prev.filter((t) => t.id !== id));
      if (editing?.id === id) setEditing(null);
    }
  }

  async function handleReorder(newIds: string[]) {
    // Mirror the server's reassignment so the local order updates immediately
    // without a refetch. The server sorts the existing sortOrder values of
    // these ids ascending and reassigns them in payload order.
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
      return sortTodos(
        current.map((t) =>
          assigned[t.id] !== undefined ? { ...t, sortOrder: assigned[t.id] } : t
        )
      );
    });

    const { error } = await repo.reorder(newIds);
    if (error) {
      setTodos(prev);
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

  const visibleTodos = todos.filter((t) =>
    activeTab === "personal" ? t.isPersonal : !t.isPersonal
  );
  // A todo that was just completed stays in its active section until the
  // animation finishes, so the user sees the confirmation where they tapped
  // before the row settles into the Complete section.
  const isActiveSlot = (t: Todo) => !t.completed || justCompletedIds.has(t.id);
  const thisWeekTodos = visibleTodos.filter(
    (t) => isActiveSlot(t) && (t.recurrence === "weekly" || t.pinnedToWeek)
  );
  const dailyTodos = visibleTodos.filter(
    (t) => isActiveSlot(t) && t.recurrence === "daily" && !t.pinnedToWeek
  );
  const regularActive = visibleTodos.filter(
    (t) => isActiveSlot(t) && t.recurrence === null && !t.pinnedToWeek
  );
  const completedTodos = visibleTodos.filter((t) => t.completed && !justCompletedIds.has(t.id));

  // Subtasks pinned to This Week. Subtasks inherit isPersonal from their parent
  // at create-time, so this filter mirrors the per-tab visibleTodos rule.
  const thisWeekSubtasks = sortSubtasks(
    subtasks.filter(
      (s) =>
        s.pinnedToWeek &&
        (!s.completed || justCompletedIds.has(s.id)) &&
        s.isPersonal === (activeTab === "personal")
    )
  );

  function renderTopLevelTodo(todo: Todo, isDragging?: boolean) {
    const done = todo.completed;
    const childSubtasks = subtasks.filter((s) => s.parentId === todo.id);
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
          justCompleted={justCompletedIds.has(todo.id)}
          expanded={done ? undefined : expanded}
          subtaskTotal={subtaskTotal}
          subtaskDone={subtaskDone}
          onToggle={() => handleToggle(todo)}
          onTogglePin={() => handleTogglePin(todo)}
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
                onReorder={(ids) => handleSubtaskReorder(todo.id, ids)}
                renderItem={(s, isSubDragging) => (
                  <SubtaskRow
                    subtask={s}
                    lifted={isSubDragging}
                    justCompleted={justCompletedIds.has(s.id)}
                    onToggle={() => handleToggleSubtask(s)}
                    onTogglePin={() => handleTogglePinSubtask(s)}
                    onOpen={() => setEditingSubtask(s)}
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
          {regularActive.length} remaining
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
                  onToggle={() => handleToggleSubtask(s)}
                  onTogglePin={() => handleTogglePinSubtask(s)}
                  onOpen={() => setEditingSubtask(s)}
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
            items={dailyTodos}
            onReorder={handleReorder}
            renderItem={(todo, isDragging) => renderTopLevelTodo(todo, isDragging)}
          />
        </Section>
      )}

      {/* General (active regular) todos */}
      {regularActive.length > 0 && (
        <Section title="General">
          <DraggableLongPressList
            items={regularActive}
            onReorder={handleReorder}
            renderItem={(todo, isDragging) => renderTopLevelTodo(todo, isDragging)}
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
      {visibleTodos.length === 0 && thisWeekSubtasks.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-text-muted">
            {activeTab === "personal"
              ? "No personal todos yet. Add one above to get started."
              : "No todos yet. Add one above to get started."}
          </p>
        </div>
      )}

      {editing && (
        <EditTodoModal
          todo={editing}
          onCancel={() => setEditing(null)}
          onDelete={() => handleDelete(editing.id)}
          onSave={(patch) => handleEditSave(editing.id, patch)}
        />
      )}

      {editingSubtask && (
        <EditSubtaskModal
          subtask={editingSubtask}
          onCancel={() => setEditingSubtask(null)}
          onDelete={() => handleDeleteSubtask(editingSubtask.id)}
          onSave={(patch) => handleEditSubtaskSave(editingSubtask.id, patch)}
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
};

function DraggableLongPressList<T extends { id: string }>({
  items,
  onReorder,
  renderItem,
}: {
  items: T[];
  onReorder: (ids: string[]) => void | Promise<void>;
  renderItem: (item: T, isDragging: boolean) => React.ReactNode;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
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

  // Active drag: track pointer, compute target index, commit on release.
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

    function onMove(e: PointerEvent) {
      if (e.pointerId !== current.pointerId) return;
      e.preventDefault();
      const deltaY = e.clientY - current.startPointerY;
      const nextIndex = computeIndex(e.clientY);
      setDrag((prev) =>
        prev ? { ...prev, deltaY, currentIndex: nextIndex } : prev
      );
    }

    function onEnd(e: PointerEvent) {
      if (e.pointerId !== current.pointerId) return;
      setDrag((prev) => {
        if (!prev) return prev;
        if (prev.startIndex !== prev.currentIndex) {
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
  }, [drag, items, onReorder]);

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
      className={`space-y-2 ${drag ? "select-none touch-none" : ""}`}
      onClickCapture={handleClickCapture}
    >
      {items.map((item, index) => {
        const isDragging = drag?.id === item.id;
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
            {renderItem(item, isDragging)}
          </div>
        );
      })}
    </div>
  );
}

function TodoRow({
  todo,
  done,
  lifted,
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
        lifted
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
          className={`shrink-0 rounded p-1 text-base leading-none focus:outline-none focus:ring-2 focus:ring-primary ${
            pinned ? "opacity-100" : "opacity-40 hover:opacity-80"
          }`}
          aria-label={pinned ? "Unpin from This Week" : "Pin to This Week"}
          aria-pressed={pinned}
        >
          <span aria-hidden="true">📌</span>
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
  justCompleted,
  onToggle,
  onTogglePin,
  onOpen,
}: {
  subtask: Subtask;
  parentTitle?: string;
  lifted?: boolean;
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
        lifted
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
      </div>

      {!done && (
        <button
          onClick={onTogglePin}
          className={`shrink-0 rounded p-1 text-base leading-none focus:outline-none focus:ring-2 focus:ring-primary ${
            pinned ? "opacity-100" : "opacity-40 hover:opacity-80"
          }`}
          aria-label={pinned ? "Unpin from This Week" : "Pin to This Week"}
          aria-pressed={pinned}
        >
          <span aria-hidden="true">📌</span>
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    await onSave({
      title: title.trim(),
      description: description.trim() ? description.trim() : null,
      recurrence,
      pinnedToWeek,
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

function EditSubtaskModal({
  subtask,
  onCancel,
  onSave,
  onDelete,
}: {
  subtask: Subtask;
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
