"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api, type TodoDTO, type Recurrence } from "@/lib/api-client";
import { isRecurringResetDue } from "@/lib/recurrence";

type Todo = TodoDTO;

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
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Todo | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("joined");
  const resettingRef = useRef<Set<string>>(new Set());

  // Compare lastCompletedAt against now and uncomplete any recurring todos
  // whose rolling 24h (daily) or 7d (weekly) window has elapsed.
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
      due.map((t) => api.todos.update(t.id, { completed: false }))
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
  }, []);

  const loadTodos = useCallback(async () => {
    const { data } = await api.todos.list();
    if (data) {
      setTodos(data);
      setLoading(false);
      resetDueRecurring(data);
      return;
    }
    setLoading(false);
  }, [resetDueRecurring]);

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

    const { data } = await api.todos.create({
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

  async function handleToggle(todo: Todo) {
    const { data } = await api.todos.update(todo.id, {
      completed: !todo.completed,
    });
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
    }
  }

  async function handleDelete(id: string) {
    const { data } = await api.todos.delete(id);
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

    const { error } = await api.todos.reorder(newIds);
    if (error) {
      setTodos(prev);
    }
  }

  async function handleEditSave(
    id: string,
    patch: { title: string; description: string | null; recurrence: Recurrence }
  ) {
    const { data } = await api.todos.update(id, patch);
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
      setEditing(null);
    }
  }

  const visibleTodos = todos.filter((t) =>
    activeTab === "personal" ? t.isPersonal : !t.isPersonal
  );
  const regularActive = visibleTodos.filter((t) => !t.completed && t.recurrence === null);
  const dailyTodos = visibleTodos.filter((t) => !t.completed && t.recurrence === "daily");
  const weeklyTodos = visibleTodos.filter((t) => !t.completed && t.recurrence === "weekly");
  const completedTodos = visibleTodos.filter((t) => t.completed);

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
        className="mb-4 flex gap-1 rounded-lg border border-border bg-surface p-1"
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
                  : "font-medium text-background/60 hover:bg-surface-hover hover:text-background"
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
          className="flex-1 rounded-lg border border-border bg-white px-3 py-2 text-text placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
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

      {/* Daily section */}
      {dailyTodos.length > 0 && (
        <Section title="Daily" hint="Resets 24 hours after completion">
          <DraggableTodoList
            todos={dailyTodos}
            onReorder={handleReorder}
            onToggle={handleToggle}
            onOpen={(t) => setEditing(t)}
          />
        </Section>
      )}

      {/* Weekly section */}
      {weeklyTodos.length > 0 && (
        <Section title="Weekly" hint="Resets 7 days after completion">
          <DraggableTodoList
            todos={weeklyTodos}
            onReorder={handleReorder}
            onToggle={handleToggle}
            onOpen={(t) => setEditing(t)}
          />
        </Section>
      )}

      {/* General (active regular) todos */}
      {regularActive.length > 0 && (
        <Section title="General">
          <DraggableTodoList
            todos={regularActive}
            onReorder={handleReorder}
            onToggle={handleToggle}
            onOpen={(t) => setEditing(t)}
          />
        </Section>
      )}

      {/* Complete todos (any recurrence) */}
      {completedTodos.length > 0 && (
        <Section title="Complete">
          <div className="space-y-2">
            {completedTodos.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                done
                onToggle={() => handleToggle(todo)}
                onOpen={() => setEditing(todo)}
              />
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

      {editing && (
        <EditTodoModal
          todo={editing}
          onCancel={() => setEditing(null)}
          onDelete={() => handleDelete(editing.id)}
          onSave={(patch) => handleEditSave(editing.id, patch)}
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

function DraggableTodoList({
  todos,
  onReorder,
  onToggle,
  onOpen,
}: {
  todos: Todo[];
  onReorder: (ids: string[]) => void | Promise<void>;
  onToggle: (todo: Todo) => void;
  onOpen: (todo: Todo) => void;
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
      const startIndex = todos.findIndex((t) => t.id === id);
      if (startIndex < 0) return;
      const heights: number[] = [];
      const tops: number[] = [];
      for (const t of todos) {
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
    [todos]
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
          const ids = todos.map((t) => t.id);
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
  }, [drag, todos, onReorder]);

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
      {todos.map((todo, index) => {
        const isDragging = drag?.id === todo.id;
        const transform = transformFor(index);
        return (
          <div
            key={todo.id}
            ref={(el) => {
              if (el) itemRefs.current.set(todo.id, el);
              else itemRefs.current.delete(todo.id);
            }}
            onPointerDown={(e) => handlePointerDown(e, todo.id)}
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
            <TodoRow
              todo={todo}
              done={todo.completed}
              lifted={isDragging}
              onToggle={() => onToggle(todo)}
              onOpen={() => onOpen(todo)}
            />
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
  onToggle,
  onOpen,
}: {
  todo: Todo;
  done?: boolean;
  lifted?: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${
        lifted
          ? "border-primary bg-surface-hover ring-2 ring-primary/40"
          : done
            ? "border-border bg-surface-hover"
            : "border-border bg-surface"
      }`}
    >
      <button
        onClick={onToggle}
        className={
          done
            ? "flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 border-success bg-success/20 hover:bg-success/10 focus:outline-none focus:ring-2 focus:ring-success"
            : "h-5 w-5 shrink-0 rounded border-2 border-border hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
        }
        aria-label={done ? "Uncomplete todo" : "Complete todo"}
      >
        {done && (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-success" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        )}
      </button>

      <div className="flex-1 min-w-0">
        <span className={`block break-words ${done ? "text-background/50 line-through" : "text-background"}`}>
          {todo.title}
        </span>
        {todo.description && (
          <span className={`mt-0.5 block break-words text-xs ${done ? "text-background/40" : "text-background/60"}`}>
            {todo.description}
          </span>
        )}
        <span className={`text-xs ${done ? "text-background/40" : "text-background/60"}`}>
          {todo.createdBy} &middot; {formatRelativeDate(todo.createdAt)}
        </span>
      </div>

      <button
        onClick={onOpen}
        className="shrink-0 rounded p-1 text-background/60 hover:text-background focus:outline-none focus:ring-2 focus:ring-primary"
        aria-label="Todo settings"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
        </svg>
      </button>
    </div>
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
  onSave: (patch: { title: string; description: string | null; recurrence: Recurrence }) => void | Promise<void>;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(todo.title);
  const [description, setDescription] = useState(todo.description ?? "");
  const [recurrence, setRecurrence] = useState<Recurrence>(todo.recurrence);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    await onSave({
      title: title.trim(),
      description: description.trim() ? description.trim() : null,
      recurrence,
    });
    setSaving(false);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit todo"
      className="fixed inset-0 z-50 bg-surface"
    >
      <form onSubmit={handleSubmit} className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-1 text-sm text-background/60 hover:bg-surface-hover hover:text-background focus:outline-none focus:ring-2 focus:ring-primary"
          >
            Cancel
          </button>
          <h3 className="text-base font-semibold text-background">Edit todo</h3>
          <button
            type="submit"
            disabled={saving || !title.trim()}
            className="rounded px-2 py-1 text-sm font-medium text-primary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="mx-auto max-w-2xl">
            <label className="mb-4 block">
              <span className="mb-1 block text-sm text-background/60">Title</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={500}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-text placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>

            <label className="mb-4 block">
              <span className="mb-1 block text-sm text-background/60">Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={5000}
                rows={5}
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-text placeholder-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </label>

            <label className="mb-4 block">
              <span className="mb-1 block text-sm text-background/60">Repeats</span>
              <select
                value={recurrence ?? ""}
                onChange={(e) => setRecurrence((e.target.value || null) as Recurrence)}
                className="w-full rounded-lg border border-border bg-select px-3 py-2 text-text focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="">No repeat</option>
                <option value="daily">Daily — resets 24 hours after completion</option>
                <option value="weekly">Weekly — resets 7 days after completion</option>
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
