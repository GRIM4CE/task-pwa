"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type TodoDTO } from "@/lib/api-client";

function formatCompletedDate(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((todayStart.getTime() - dateStart.getTime()) / (1000 * 60 * 60 * 24));

  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  if (diffDays === 0) return `Today at ${time}`;
  if (diffDays === 1) return `Yesterday at ${time}`;
  if (diffDays < 7) return `${diffDays} days ago at ${time}`;

  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

export default function ArchivePage() {
  const [todos, setTodos] = useState<TodoDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.todos.archive().then(({ data }) => {
      if (cancelled) return;
      if (data) setTodos(data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return todos;
    return todos.filter((t) => {
      const inTitle = t.title.toLowerCase().includes(q);
      const inDesc = t.description?.toLowerCase().includes(q) ?? false;
      return inTitle || inDesc;
    });
  }, [search, todos]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-text">Completed Todos</h2>
        <p className="text-sm text-text-muted">
          {todos.length === 0
            ? "No completed todos yet"
            : `${todos.length} completed todo${todos.length === 1 ? "" : "s"}`}
        </p>
      </div>

      <div className="mb-6">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search completed todos..."
          aria-label="Search completed todos"
          className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-gray-400 focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-text-muted">
            {todos.length === 0
              ? "Completed todos will appear here after a day."
              : "No todos match your search."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((todo) => (
            <li
              key={todo.id}
              className="flex items-start gap-3 rounded-lg border border-border-on-surface bg-surface px-4 py-3"
            >
              <div
                aria-hidden
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 border-success bg-success/20"
              >
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
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-on-surface/60 line-through">{todo.title}</p>
                {todo.description && (
                  <p className="mt-0.5 truncate text-xs text-on-surface/40">
                    {todo.description}
                  </p>
                )}
                <p className="mt-1 text-xs text-on-surface/50">
                  {todo.createdBy}
                  {todo.isPersonal ? " · Personal" : " · Joined"}
                  {todo.lastCompletedAt
                    ? ` · Completed ${formatCompletedDate(todo.lastCompletedAt)}`
                    : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
