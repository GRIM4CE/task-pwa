"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api, type TodoDTO, type Recurrence } from "@/lib/api-client";
import { isRecurringResetDue } from "@/lib/recurrence";

type Todo = TodoDTO;

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
  const [newRecurrence, setNewRecurrence] = useState<Recurrence>(null);
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
      recurrence: newRecurrence,
    });
    if (data) {
      setTodos((prev) => [...prev, data]);
      setNewTitle("");
      setNewRecurrence(null);
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
  const regularDone = visibleTodos.filter((t) => t.completed && t.recurrence === null);
  const dailyTodos = visibleTodos.filter((t) => t.recurrence === "daily");
  const weeklyTodos = visibleTodos.filter((t) => t.recurrence === "weekly");

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
        aria-label="Task lists"
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
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
                isActive
                  ? "bg-primary text-white"
                  : "text-text-muted hover:bg-surface-hover hover:text-text"
              }`}
            >
              {tab === "joined" ? "Joined" : "Personal"}
            </button>
          );
        })}
      </div>

      <div className="mb-6">
        <h2 className="text-xl font-semibold text-text">
          {activeTab === "joined" ? "Joined Tasks" : "Personal Tasks"}
        </h2>
        <p className="text-sm text-text-muted">
          {regularActive.length} remaining
          {regularDone.length > 0 ? `, ${regularDone.length} done` : ""}
        </p>
      </div>

      {/* Add todo form */}
      <form onSubmit={handleAdd} className="mb-6 flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add a new task..."
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-text placeholder-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          maxLength={500}
        />
        <select
          value={newRecurrence ?? ""}
          onChange={(e) => setNewRecurrence((e.target.value || null) as Recurrence)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-text focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          aria-label="Repeats"
        >
          <option value="">No repeat</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
        <button
          type="submit"
          disabled={adding || !newTitle.trim()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {adding ? "..." : "Add"}
        </button>
      </form>

      {/* Active regular todos */}
      <div className="space-y-2">
        {regularActive.map((todo) => (
          <TodoRow
            key={todo.id}
            todo={todo}
            onToggle={() => handleToggle(todo)}
            onEdit={() => setEditing(todo)}
            onDelete={() => handleDelete(todo.id)}
          />
        ))}
      </div>

      {/* Daily section */}
      {dailyTodos.length > 0 && (
        <Section title="Daily" hint="Resets 24 hours after completion">
          {dailyTodos.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              done={todo.completed}
              onToggle={() => handleToggle(todo)}
              onEdit={() => setEditing(todo)}
              onDelete={() => handleDelete(todo.id)}
            />
          ))}
        </Section>
      )}

      {/* Weekly section */}
      {weeklyTodos.length > 0 && (
        <Section title="Weekly" hint="Resets 7 days after completion">
          {weeklyTodos.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              done={todo.completed}
              onToggle={() => handleToggle(todo)}
              onEdit={() => setEditing(todo)}
              onDelete={() => handleDelete(todo.id)}
            />
          ))}
        </Section>
      )}

      {/* Completed regular todos */}
      {regularDone.length > 0 && (
        <Section title="Done">
          {regularDone.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              done
              onToggle={() => handleToggle(todo)}
              onEdit={() => setEditing(todo)}
              onDelete={() => handleDelete(todo.id)}
            />
          ))}
        </Section>
      )}

      {/* Empty state */}
      {visibleTodos.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-text-muted">
            {activeTab === "personal"
              ? "No personal tasks yet. Add one above to get started."
              : "No tasks yet. Add one above to get started."}
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
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function TodoRow({
  todo,
  done,
  onToggle,
  onEdit,
  onDelete,
}: {
  todo: Todo;
  done?: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border border-border px-4 py-3 group ${
        done ? "bg-surface/50" : "bg-surface"
      }`}
    >
      <button
        onClick={onToggle}
        className={
          done
            ? "flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 border-success bg-success/20 hover:bg-success/10 focus:outline-none focus:ring-2 focus:ring-success"
            : "h-5 w-5 shrink-0 rounded border-2 border-border hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
        }
        aria-label={done ? "Uncomplete task" : "Complete task"}
      >
        {done && (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-success" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        )}
      </button>

      <button
        type="button"
        onClick={onEdit}
        className="flex-1 min-w-0 text-left"
      >
        <span className={`block truncate ${done ? "text-text-muted line-through" : "text-text"}`}>
          {todo.title}
        </span>
        {todo.description && (
          <span className={`mt-0.5 block truncate text-xs ${done ? "text-text-muted/60" : "text-text-muted"}`}>
            {todo.description}
          </span>
        )}
        <span className={`text-xs ${done ? "text-text-muted/60" : "text-text-muted"}`}>
          {todo.createdBy} &middot; {formatRelativeDate(todo.createdAt)}
        </span>
      </button>

      <button
        onClick={onDelete}
        className="shrink-0 rounded p-1 text-text-muted opacity-0 hover:text-danger group-hover:opacity-100 focus:opacity-100 focus:outline-none"
        aria-label="Delete task"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-lg"
      >
        <h3 className="mb-4 text-lg font-semibold text-text">Edit task</h3>

        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-text-muted">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={500}
            autoFocus
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-text focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-text-muted">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={5000}
            rows={3}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-text focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </label>

        <label className="mb-5 block">
          <span className="mb-1 block text-sm text-text-muted">Repeats</span>
          <select
            value={recurrence ?? ""}
            onChange={(e) => setRecurrence((e.target.value || null) as Recurrence)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-text focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">No repeat</option>
            <option value="daily">Daily — resets 24 hours after completion</option>
            <option value="weekly">Weekly — resets 7 days after completion</option>
          </select>
        </label>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg px-3 py-2 text-sm text-danger hover:bg-surface-hover"
          >
            Delete
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg px-3 py-2 text-sm text-text-muted hover:bg-surface-hover hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !title.trim()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
