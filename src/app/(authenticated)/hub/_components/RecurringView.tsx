"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type Recurrence,
  type RecurrenceOrdinal,
  type TodoDTO,
} from "@/lib/api-client";
import { nextScheduledDate } from "@/lib/recurrence";
import { useTodoRepository } from "@/lib/todos/use-todo-repository";

type EditableRecurrence = Exclude<Recurrence, null>;

type GroupKey = EditableRecurrence;

const GROUP_ORDER: ReadonlyArray<{ key: GroupKey; title: string; hint: string }> = [
  { key: "weekday", title: "Weekly on a specific day", hint: "Hidden until that weekday rolls around." },
  { key: "monthly_day", title: "Monthly on a specific date", hint: "Hidden until that date arrives." },
  { key: "monthly_weekday", title: "Monthly on a specific weekday", hint: "Hidden until the matching weekday arrives." },
  { key: "daily", title: "Daily", hint: "Resets at local midnight every day." },
  { key: "weekly", title: "Weekly", hint: "Resets at the Sunday→Monday boundary." },
];

const WEEKDAY_LABELS: ReadonlyArray<{ value: number; label: string; short: string }> = [
  { value: 1, label: "Monday", short: "Mon" },
  { value: 2, label: "Tuesday", short: "Tue" },
  { value: 3, label: "Wednesday", short: "Wed" },
  { value: 4, label: "Thursday", short: "Thu" },
  { value: 5, label: "Friday", short: "Fri" },
  { value: 6, label: "Saturday", short: "Sat" },
  { value: 0, label: "Sunday", short: "Sun" },
];

const ORDINAL_LABELS: ReadonlyArray<{ value: Exclude<RecurrenceOrdinal, null>; label: string }> = [
  { value: "first", label: "First" },
  { value: "second", label: "Second" },
  { value: "third", label: "Third" },
  { value: "fourth", label: "Fourth" },
  { value: "last", label: "Last" },
];

function weekdayLabel(value: number | null): string {
  if (value === null) return "—";
  return WEEKDAY_LABELS.find((w) => w.value === value)?.label ?? "—";
}

function ordinalLabel(value: RecurrenceOrdinal): string {
  if (value === null) return "—";
  return ORDINAL_LABELS.find((o) => o.value === value)?.label ?? "—";
}

function ordinalSuffix(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function cadenceSummary(todo: TodoDTO): string {
  switch (todo.recurrence) {
    case "daily":
      return "Every day";
    case "weekly":
      return "Every week";
    case "weekday":
      return `Every ${weekdayLabel(todo.recurrenceWeekday)}`;
    case "monthly_day": {
      const d = todo.recurrenceDayOfMonth;
      return d === null ? "Monthly" : `On the ${d}${ordinalSuffix(d)} of each month`;
    }
    case "monthly_weekday":
      return `${ordinalLabel(todo.recurrenceOrdinal)} ${weekdayLabel(todo.recurrenceWeekday)} of each month`;
    default:
      return "";
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function nextOccurrenceLabel(todo: TodoDTO): string | null {
  const next = nextScheduledDate(todo);
  return next ? formatDate(next) : null;
}

export default function RecurringView() {
  const repo = useTodoRepository();
  const [todos, setTodos] = useState<TodoDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    repo.list().then(({ data }) => {
      if (cancelled) return;
      if (data) setTodos(data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const grouped = useMemo(() => {
    const recurring = todos.filter(
      (t) => t.recurrence !== null && t.parentId === null
    );
    const byKey = new Map<GroupKey, TodoDTO[]>();
    for (const t of recurring) {
      const key = t.recurrence as GroupKey;
      const list = byKey.get(key) ?? [];
      list.push(t);
      byKey.set(key, list);
    }
    return GROUP_ORDER.map((g) => ({
      ...g,
      items: (byKey.get(g.key) ?? []).slice().sort((a, b) =>
        a.title.localeCompare(b.title)
      ),
    }));
  }, [todos]);

  const total = grouped.reduce((sum, g) => sum + g.items.length, 0);

  function handleSaved(updated: TodoDTO) {
    setTodos((prev) => {
      // If recurrence cleared, drop it from this view's source list so the
      // group disappears immediately without a refetch.
      if (updated.recurrence === null) {
        return prev.filter((t) => t.id !== updated.id);
      }
      return prev.map((t) => (t.id === updated.id ? updated : t));
    });
    setEditingId(null);
  }

  function handleDeleted(id: string) {
    setTodos((prev) => prev.filter((t) => t.id !== id));
    setEditingId(null);
  }

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-text">Recurring</h2>
        <p className="text-sm text-text-muted">
          {total === 0
            ? "No recurring todos yet"
            : `${total} recurring todo${total === 1 ? "" : "s"}. Scheduled rows are hidden from your lists between occurrences — manage their cadence here.`}
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : total === 0 ? (
        <div className="py-12 text-center">
          <p className="text-text-muted">
            Set a repeat on a todo to see it here.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((group) =>
            group.items.length === 0 ? null : (
              <section key={group.key}>
                <h3 className="mb-1 text-sm font-medium text-on-surface/60">
                  {group.title}
                </h3>
                <p className="mb-2 text-xs text-text-muted">{group.hint}</p>
                <ul className="space-y-2">
                  {group.items.map((todo) => {
                    const next = nextOccurrenceLabel(todo);
                    return (
                      <li key={todo.id}>
                        {editingId === todo.id ? (
                          <RecurringEditor
                            todo={todo}
                            onCancel={() => setEditingId(null)}
                            onSaved={handleSaved}
                            onDeleted={handleDeleted}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setEditingId(todo.id)}
                            className="flex w-full items-start justify-between gap-3 rounded-lg border border-border-on-surface bg-surface px-4 py-3 text-left hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-on-surface">
                                {todo.title}
                              </p>
                              <p className="mt-0.5 text-xs text-on-surface/60">
                                {cadenceSummary(todo)}
                                {todo.isPersonal ? " · Personal" : " · Joined"}
                              </p>
                              {next && (
                                <p className="mt-0.5 text-xs text-on-surface/50">
                                  Next: {next}
                                </p>
                              )}
                            </div>
                            <span className="shrink-0 text-xs text-on-surface/40">
                              Edit
                            </span>
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )
          )}
        </div>
      )}
    </>
  );
}

function RecurringEditor({
  todo,
  onCancel,
  onSaved,
  onDeleted,
}: {
  todo: TodoDTO;
  onCancel: () => void;
  onSaved: (updated: TodoDTO) => void;
  onDeleted: (id: string) => void;
}) {
  const repo = useTodoRepository();
  const today = new Date();
  const [title, setTitle] = useState(todo.title);
  const [description, setDescription] = useState(todo.description ?? "");
  const [recurrence, setRecurrence] = useState<EditableRecurrence>(
    todo.recurrence as EditableRecurrence
  );
  const [weekday, setWeekday] = useState<number>(
    todo.recurrenceWeekday ?? today.getDay()
  );
  const [dayOfMonth, setDayOfMonth] = useState<number>(
    todo.recurrenceDayOfMonth ?? today.getDate()
  );
  const [ordinal, setOrdinal] = useState<Exclude<RecurrenceOrdinal, null>>(
    todo.recurrenceOrdinal ?? "first"
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isWeekday = recurrence === "weekday";
  const isMonthlyDay = recurrence === "monthly_day";
  const isMonthlyWeekday = recurrence === "monthly_weekday";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    const { data, error } = await repo.update(todo.id, {
      title: title.trim(),
      description: description.trim() ? description.trim() : null,
      recurrence,
      recurrenceWeekday: isWeekday || isMonthlyWeekday ? weekday : null,
      recurrenceDayOfMonth: isMonthlyDay ? dayOfMonth : null,
      recurrenceOrdinal: isMonthlyWeekday ? ordinal : null,
    });
    setSaving(false);
    if (error || !data) {
      setError(error ?? "Could not save");
      return;
    }
    onSaved(data);
  }

  async function handleDelete() {
    if (!window.confirm(`Permanently delete "${todo.title}"?`)) return;
    setDeleting(true);
    setError(null);
    const { error } = await repo.delete(todo.id);
    setDeleting(false);
    if (error) {
      setError(error);
      return;
    }
    onDeleted(todo.id);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-focus bg-surface p-4"
    >
      <label className="mb-3 block">
        <span className="mb-1 block text-sm text-text-muted">Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={500}
          className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-input-placeholder focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-sm text-text-muted">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={5000}
          rows={3}
          className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text placeholder-input-placeholder focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-sm text-text-muted">Repeats</span>
        <select
          value={recurrence}
          onChange={(e) => setRecurrence(e.target.value as EditableRecurrence)}
          className="w-full rounded-lg border border-border bg-input px-3 py-2 text-input-text focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="weekday">Weekly on a specific day</option>
          <option value="monthly_day">Monthly on a specific date</option>
          <option value="monthly_weekday">Monthly on a specific weekday</option>
        </select>
      </label>

      {isWeekday && (
        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-text-muted">Day of the week</span>
          <select
            value={String(weekday)}
            onChange={(e) => setWeekday(Number(e.target.value))}
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

      {isMonthlyDay && (
        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-text-muted">Day of the month</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            value={String(dayOfMonth)}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 31) {
                setDayOfMonth(n);
              } else if (e.target.value === "") {
                setDayOfMonth(1);
              }
            }}
            className="w-24 rounded-lg border border-border bg-input px-3 py-2 text-input-text focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
          />
          <span className="mt-1 block text-xs text-text-muted">
            In months with fewer days, the occurrence falls on the last day of
            that month.
          </span>
        </label>
      )}

      {isMonthlyWeekday && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-sm text-text-muted">Which</span>
            <select
              value={ordinal}
              onChange={(e) =>
                setOrdinal(e.target.value as Exclude<RecurrenceOrdinal, null>)
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
              value={String(weekday)}
              onChange={(e) => setWeekday(Number(e.target.value))}
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

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={saving || deleting || !title.trim()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving || deleting}
          className="rounded-lg border border-border px-4 py-2 text-sm text-text-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={saving || deleting}
          className="ml-auto rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-sm font-medium text-danger hover:bg-danger hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>
    </form>
  );
}
