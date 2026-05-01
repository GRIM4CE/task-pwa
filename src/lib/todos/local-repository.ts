import type { ArchiveDTO, StatsDTO, TodoDTO } from "@/lib/api-client";
import {
  createTodoSchema,
  reorderTodosSchema,
  updateTodoSchema,
} from "@/lib/validation";
import {
  applyReorder,
  applyUpdate,
  cascadeCompleteChildren,
  filterArchive,
  filterMainList,
  nextSortOrder,
  sortTodos,
} from "./domain";
import type {
  CreateTodoInput,
  RepoResult,
  TodoRepository,
  UpdateTodoPatch,
} from "./repository";

const STORAGE_KEY = "todo-pwa:guest:todos";
const LEGACY_SUBTASKS_KEY = "todo-pwa:guest:subtasks";
const COMPLETIONS_KEY = "todo-pwa:guest:completions";
const COMPLETIONS_RETENTION_MS = 120 * 24 * 60 * 60 * 1000;
export const GUEST_USERNAME = "Guest";

type CompletionEvent = { todoId: string; completedAt: number };

function ok<T>(data: T): RepoResult<T> {
  return { data, error: null };
}

function err<T>(error: string): RepoResult<T> {
  return { data: null, error };
}

function readAll(): TodoDTO[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(STORAGE_KEY);
  let todos: TodoDTO[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        todos = (parsed as TodoDTO[]).map((t) => ({
          ...t,
          pinnedToWeek: t.pinnedToWeek ?? false,
          parentId: t.parentId ?? null,
        }));
      }
    } catch {
      todos = [];
    }
  }

  // One-time migration: fold legacy subtask localStorage into the unified list,
  // then remove the legacy key. New writes always use STORAGE_KEY only.
  const legacy = window.localStorage.getItem(LEGACY_SUBTASKS_KEY);
  if (legacy !== null) {
    try {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed)) {
        const migrated = (parsed as Array<TodoDTO & { parentId: string }>)
          .filter((s) => todos.some((t) => t.id === s.parentId))
          .map<TodoDTO>((s) => ({
            ...s,
            recurrence: null,
            parentId: s.parentId,
            pinnedToWeek: s.pinnedToWeek ?? false,
          }));
        if (migrated.length > 0) {
          todos = [...todos, ...migrated];
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
        }
      }
    } catch {
      // ignore — legacy data was malformed
    }
    window.localStorage.removeItem(LEGACY_SUBTASKS_KEY);
  }

  return todos;
}

function writeAll(list: TodoDTO[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function readCompletions(): CompletionEvent[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(COMPLETIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CompletionEvent[]) : [];
  } catch {
    return [];
  }
}

function writeCompletions(events: CompletionEvent[]): void {
  if (typeof window === "undefined") return;
  // Prune on write so localStorage doesn't grow unbounded over time.
  const cutoff = Date.now() - COMPLETIONS_RETENTION_MS;
  const pruned = events.filter((e) => e.completedAt >= cutoff);
  window.localStorage.setItem(COMPLETIONS_KEY, JSON.stringify(pruned));
}

export const localTodoRepository: TodoRepository = {
  async list() {
    const all = readAll();
    return ok(sortTodos(filterMainList(all)));
  },

  async archive() {
    const all = readAll();
    const titlesById = new Map(all.map((t) => [t.id, t.title]));
    const items = filterArchive(all).map((t) => ({
      todo: t,
      parentTitle: t.parentId ? titlesById.get(t.parentId) ?? null : null,
    }));
    return ok({ items } satisfies ArchiveDTO);
  },

  async stats() {
    const all = readAll();
    const cutoff = Date.now() - COMPLETIONS_RETENTION_MS;
    const events = readCompletions().filter((e) => e.completedAt >= cutoff);
    const byTodo = new Map<string, number[]>();
    for (const e of events) {
      const list = byTodo.get(e.todoId) ?? [];
      list.push(e.completedAt);
      byTodo.set(e.todoId, list);
    }
    const todos: StatsDTO["todos"] = all
      .filter((t) => t.recurrence !== null && t.parentId === null)
      .map((t) => ({
        id: t.id,
        title: t.title,
        recurrence: t.recurrence as "daily" | "weekly",
        isPersonal: t.isPersonal,
        createdAt: t.createdAt,
        completions: (byTodo.get(t.id) ?? []).sort((a, b) => a - b),
      }));
    return ok({ todos });
  },

  async create(input: CreateTodoInput) {
    const parsed = createTodoSchema.safeParse(input);
    if (!parsed.success) return err("Invalid request");

    const all = readAll();
    const parentId = parsed.data.parentId ?? null;

    // Subtasks inherit isPersonal from the parent and can't have recurrence.
    let isPersonal = parsed.data.isPersonal ?? false;
    let recurrence = parsed.data.recurrence ?? null;
    if (parentId !== null) {
      const parent = all.find((t) => t.id === parentId);
      if (!parent) return err("Not found");
      if (parent.parentId !== null) return err("Parent must be top-level");
      isPersonal = parent.isPersonal;
      recurrence = null;
    }

    const now = Date.now();
    const todo: TodoDTO = {
      id: crypto.randomUUID(),
      parentId,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      completed: false,
      isPersonal,
      sortOrder: nextSortOrder(all, parentId),
      recurrence,
      pinnedToWeek: parsed.data.pinnedToWeek ?? false,
      lastCompletedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: GUEST_USERNAME,
    };
    writeAll([...all, todo]);
    return ok(todo);
  },

  async update(id: string, patch: UpdateTodoPatch) {
    const parsed = updateTodoSchema.safeParse(patch);
    if (!parsed.success) return err("Invalid request");

    const all = readAll();
    const index = all.findIndex((t) => t.id === id);
    if (index === -1) return err("Not found");

    const previous = all[index];
    let effectivePatch: UpdateTodoPatch = parsed.data;

    // Reparenting: validate one-deep hierarchy + matching personal scope, and
    // place the moved row at the end of its new sibling group.
    if (
      parsed.data.parentId !== undefined &&
      parsed.data.parentId !== previous.parentId
    ) {
      if (parsed.data.parentId !== null) {
        if (parsed.data.parentId === id) return err("Cannot parent to self");
        const hasChildren = all.some((t) => t.parentId === id);
        if (hasChildren) {
          return err("A todo with subtasks cannot itself become a subtask");
        }
        const parent = all.find((t) => t.id === parsed.data.parentId);
        if (!parent) return err("Not found");
        if (parent.parentId !== null) return err("Parent must be top-level");
        if (parent.isPersonal !== previous.isPersonal) {
          return err("Cannot mix personal and joined");
        }
      }
      effectivePatch = {
        ...parsed.data,
        sortOrder: nextSortOrder(all, parsed.data.parentId),
      };
    }

    const updated = applyUpdate(previous, effectivePatch);
    let next = [...all];
    next[index] = updated;

    // Mirror the server-side cascade: completing a parent completes its open subtasks.
    if (
      parsed.data.completed === true &&
      previous.completed === false
    ) {
      next = cascadeCompleteChildren(next, id);
    }
    writeAll(next);

    if (
      parsed.data.completed === true &&
      previous.completed === false &&
      previous.recurrence !== null
    ) {
      writeCompletions([
        ...readCompletions(),
        { todoId: id, completedAt: updated.lastCompletedAt ?? Date.now() },
      ]);
    }
    return ok(updated);
  },

  async delete(id: string) {
    const all = readAll();
    if (!all.some((t) => t.id === id)) return err("Not found");
    // Cascade-delete children to mirror ON DELETE CASCADE in SQLite.
    writeAll(all.filter((t) => t.id !== id && t.parentId !== id));
    return ok({ success: true as const });
  },

  async reorder(ids: string[], parentId: string | null) {
    const parsed = reorderTodosSchema.safeParse({ ids, parentId });
    if (!parsed.success) return err("Invalid request");
    const unique = Array.from(new Set(parsed.data.ids));
    if (unique.length !== parsed.data.ids.length) return err("Invalid request");

    const all = readAll();
    const scope = parsed.data.parentId ?? null;
    if (
      !unique.every((id) =>
        all.some((t) => t.id === id && (t.parentId ?? null) === scope)
      )
    ) {
      return err("Not found");
    }

    writeAll(applyReorder(all, unique));
    return ok({ success: true as const });
  },
};

export function clearGuestTodos(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_SUBTASKS_KEY);
  window.localStorage.removeItem(COMPLETIONS_KEY);
}
