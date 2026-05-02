import type { TodoDTO } from "@/lib/api-client";
import type { UpdateTodoPatch } from "./repository";

const DAY_MS = 24 * 60 * 60 * 1000;

export function sortTodos(list: TodoDTO[]): TodoDTO[] {
  return [...list].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return b.createdAt - a.createdAt;
  });
}

// For subtasks: oldest-first stable order so newly added subtasks appear at the
// bottom rather than jumping above older siblings (matches the server's
// `ORDER BY sort_order ASC, created_at DESC` for top-level, but inverted on
// the createdAt tiebreak because subtasks don't get the same desc fallback).
export function sortSubtasks(list: TodoDTO[]): TodoDTO[] {
  return [...list].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.createdAt - b.createdAt;
  });
}

export function nextSortOrder(
  list: TodoDTO[],
  parentId: string | null
): number {
  const scope = list.filter((t) => (t.parentId ?? null) === parentId);
  if (scope.length === 0) return 0;
  return Math.max(...scope.map((t) => t.sortOrder)) + 1;
}

// Subtasks of recurring parents ride the parent's reset cycle, so visibility,
// archive, and expire filters all need to look up "which top-level todos are
// recurring." Centralized so all three stay in sync.
export function getRecurringParentIds(list: TodoDTO[]): Set<string> {
  return new Set(
    list
      .filter((t) => t.parentId === null && t.recurrence !== null)
      .map((t) => t.id)
  );
}

// Mirrors the SQL filter in /api/todos GET: hide non-recurring completed todos
// once 24h have passed since completion. Recurring todos always remain visible,
// and so do subtasks of recurring parents — those ride the parent's reset
// cycle and need to stay visible across it.
export function filterMainList(list: TodoDTO[], now: number = Date.now()): TodoDTO[] {
  const cutoff = now - DAY_MS;
  const recurringParentIds = getRecurringParentIds(list);
  return list.filter((t) => {
    if (!t.completed) return true;
    if (t.recurrence !== null) return true;
    if (t.parentId !== null && recurringParentIds.has(t.parentId)) return true;
    return t.lastCompletedAt !== null && t.lastCompletedAt >= cutoff;
  });
}

// Mirrors /api/todos/archive GET: completed, non-recurring rows, excluding
// subtasks of recurring parents (those reset with the parent rather than
// archiving).
export function filterArchive(list: TodoDTO[]): TodoDTO[] {
  const recurringParentIds = getRecurringParentIds(list);
  return list
    .filter(
      (t) =>
        t.completed &&
        t.recurrence === null &&
        !(t.parentId !== null && recurringParentIds.has(t.parentId))
    )
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
  if (patch.pinnedToWeek !== undefined) next.pinnedToWeek = patch.pinnedToWeek;
  if (patch.parentId !== undefined) {
    next.parentId = patch.parentId;
    if (patch.parentId !== null) next.recurrence = null;
  }
  if (patch.completed !== undefined) {
    next.completed = patch.completed;
    next.lastCompletedAt = patch.completed ? now : null;
    if (patch.completed) next.pinnedToWeek = false;
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

// Cascade-complete every open child of a parent. Mirrors the server-side
// transaction performed when a parent todo is checked complete.
export function cascadeCompleteChildren(
  list: TodoDTO[],
  parentId: string,
  now: number = Date.now()
): TodoDTO[] {
  return list.map((t) =>
    t.parentId === parentId && !t.completed
      ? {
          ...t,
          completed: true,
          lastCompletedAt: now,
          pinnedToWeek: false,
          updatedAt: now,
        }
      : t
  );
}

// Cascade-uncomplete every closed child of a parent. Mirrors the server-side
// transaction performed when a recurring parent is uncompleted (manual undo
// or the client-driven midnight reset).
export function cascadeUncompleteChildren(
  list: TodoDTO[],
  parentId: string,
  now: number = Date.now()
): TodoDTO[] {
  return list.map((t) =>
    t.parentId === parentId && t.completed
      ? {
          ...t,
          completed: false,
          lastCompletedAt: null,
          updatedAt: now,
        }
      : t
  );
}
