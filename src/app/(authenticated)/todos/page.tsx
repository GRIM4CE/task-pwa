"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api-client";

interface Todo {
  id: string;
  title: string;
  description: string | null;
  completed: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
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

export default function TodosPage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const loadTodos = useCallback(async () => {
    const { data } = await api.todos.list();
    if (data) {
      setTodos(data);
    }
    setLoading(false);
  }, []);

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

    const { data } = await api.todos.create({ title: newTitle.trim() });
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
    }
  }

  function startEdit(todo: Todo) {
    setEditingId(todo.id);
    setEditTitle(todo.title);
  }

  async function handleEditSubmit(id: string) {
    if (!editTitle.trim()) return;
    const { data } = await api.todos.update(id, { title: editTitle.trim() });
    if (data) {
      setTodos((prev) => prev.map((t) => (t.id === data.id ? data : t)));
    }
    setEditingId(null);
    setEditTitle("");
  }

  const activeTodos = todos.filter((t) => !t.completed);
  const completedTodos = todos.filter((t) => t.completed);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-text">Tasks</h2>
        <p className="text-sm text-text-muted">
          {activeTodos.length} remaining{completedTodos.length > 0 ? `, ${completedTodos.length} done` : ""}
        </p>
      </div>

      {/* Add todo form */}
      <form onSubmit={handleAdd} className="mb-6 flex gap-2">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add a new task..."
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-text placeholder-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
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

      {/* Active todos */}
      <div className="space-y-2">
        {activeTodos.map((todo) => (
          <div
            key={todo.id}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 group"
          >
            <button
              onClick={() => handleToggle(todo)}
              className="h-5 w-5 shrink-0 rounded border-2 border-border hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
              aria-label="Complete task"
            />

            <div className="flex-1 min-w-0">
              {editingId === todo.id ? (
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => handleEditSubmit(todo.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleEditSubmit(todo.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="w-full rounded border border-primary bg-background px-2 py-1 text-text focus:outline-none"
                  autoFocus
                />
              ) : (
                <span
                  className="block text-text cursor-pointer"
                  onClick={() => startEdit(todo)}
                >
                  {todo.title}
                </span>
              )}
              <span className="text-xs text-text-muted">
                {todo.createdBy} &middot; {formatRelativeDate(todo.createdAt)}
              </span>
            </div>

            <button
              onClick={() => handleDelete(todo.id)}
              className="shrink-0 rounded p-1 text-text-muted opacity-0 hover:text-danger group-hover:opacity-100 focus:opacity-100 focus:outline-none"
              aria-label="Delete task"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {/* Completed todos (done list) */}
      {completedTodos.length > 0 && (
        <div className="mt-8">
          <h3 className="mb-3 text-sm font-medium text-text-muted">Done</h3>
          <div className="space-y-2">
            {completedTodos.map((todo) => (
              <div
                key={todo.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface/50 px-4 py-3 group"
              >
                <button
                  onClick={() => handleToggle(todo)}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 border-success bg-success/20 hover:bg-success/10 focus:outline-none focus:ring-2 focus:ring-success"
                  aria-label="Uncomplete task"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-success" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </button>
                <div className="flex-1 min-w-0">
                  <span className="block text-text-muted line-through">
                    {todo.title}
                  </span>
                  <span className="text-xs text-text-muted/60">
                    {todo.createdBy} &middot; {formatRelativeDate(todo.createdAt)}
                  </span>
                </div>
                <button
                  onClick={() => handleDelete(todo.id)}
                  className="shrink-0 rounded p-1 text-text-muted opacity-0 hover:text-danger group-hover:opacity-100 focus:opacity-100 focus:outline-none"
                  aria-label="Delete task"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {todos.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-text-muted">No tasks yet. Add one above to get started.</p>
        </div>
      )}
    </div>
  );
}
