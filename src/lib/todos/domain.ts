import type { TodoDTO } from "@/lib/api-client";
import type { UpdateTodoPatch } from "./repository";

const DAY_MS = 24 * 60 * 60 * 1000;

export function sortTodos(list: TodoDTO[]): TodoDTO[] {
  return [...list].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return b.createdAt - a.createdAt;
  });
}

export function nextSortOrder(list: TodoDTO[]): number {
  if (list.length === 0) return 0;
  return Math.max(...list.map((t) => t.sortOrder)) + 1;
}

// Mirrors the SQL filter in /api/todos GET: hide non-recurring completed todos
// once 24h have passed since completion. Recurring todos always remain visible.
export function filterMainList(list: TodoDTO[], now: number = Date.now()): TodoDTO[] {
  const cutoff = now - DAY_MS;
  return list.filter((t) => {
    if (!t.completed) return true;
    if (t.recurrence !== null) return true;
    return t.lastCompletedAt !== null && t.lastCompletedAt >= cutoff;
  });
}

// Mirrors /api/todos/archive GET: completed, non-recurring todos.
export function filterArchive(list: TodoDTO[]): TodoDTO[] {
  return list
    .filter((t) => t.completed && t.recurrence === null)
    .sort((a, b) => (b.lastCompletedAt ?? 0) - (a.lastCompletedAt ?? 0));
}

// Mirrors the PATCH handler's update mapping: completed transitions also flip
// lastCompletedAt, and updatedAt always advances.
export function applyUpdate(
  todo: TodoDTO,
  patch: UpdateTodoPatch,
  now: number = Date.now()
): TodoDTO {
  const next: TodoDTO = { ...todo, updatedAt: now };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.sortOrder !== undefined) next.sortOrder = patch.sortOrder;
  if (patch.recurrence !== undefined) next.recurrence = patch.recurrence;
  if (patch.completed !== undefined) {
    next.completed = patch.completed;
    next.lastCompletedAt = patch.completed ? now : null;
  }
  return next;
}

// Mirrors the reorder handler: take the existing sortOrder values of the
// targeted ids (sorted ascending) and reassign them in payload order. Other
// todos keep their positions.
export function applyReorder(list: TodoDTO[], ids: string[], now: number = Date.now()): TodoDTO[] {
  const idSet = new Set(ids);
  const sortedValues = list
    .filter((t) => idSet.has(t.id))
    .map((t) => t.sortOrder)
    .sort((a, b) => a - b);
  const assigned: Record<string, number> = {};
  ids.forEach((id, i) => {
    assigned[id] = sortedValues[i];
  });
  return list.map((t) =>
    assigned[t.id] !== undefined
      ? { ...t, sortOrder: assigned[t.id], updatedAt: now }
      : t
  );
}
