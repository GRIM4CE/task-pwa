import type { ArchiveDTO, StatsDTO, SubtaskDTO, TodoDTO } from "@/lib/api-client";
import {
  createSubtaskSchema,
  createTodoSchema,
  reorderSubtasksSchema,
  reorderTodosSchema,
  updateSubtaskSchema,
  updateTodoSchema,
} from "@/lib/validation";
import {
  applyReorder,
  applySubtaskReorder,
  applySubtaskUpdate,
  applyUpdate,
  cascadeCompleteSubtasks,
  filterArchive,
  filterArchiveSubtasks,
  filterMainList,
  filterMainListSubtasks,
  nextSortOrder,
  nextSubtaskSortOrder,
  sortSubtasks,
  sortTodos,
} from "./domain";
import type {
  CreateSubtaskInput,
  CreateTodoInput,
  RepoResult,
  TodoRepository,
  UpdateSubtaskPatch,
  UpdateTodoPatch,
} from "./repository";

const STORAGE_KEY = "todo-pwa:guest:todos";
const SUBTASKS_KEY = "todo-pwa:guest:subtasks";
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
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Backfill pinnedToWeek for stored guest todos created before the field existed.
    return (parsed as TodoDTO[]).map((t) => ({
      ...t,
      pinnedToWeek: t.pinnedToWeek ?? false,
    }));
  } catch {
    return [];
  }
}

function writeAll(list: TodoDTO[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function readSubtasks(): SubtaskDTO[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(SUBTASKS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SubtaskDTO[]) : [];
  } catch {
    return [];
  }
}

function writeSubtasks(list: SubtaskDTO[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SUBTASKS_KEY, JSON.stringify(list));
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
    const todos = readAll();
    const subtasks = readSubtasks();
    const subtaskTitles = new Map(todos.map((t) => [t.id, t.title]));
    const items: ArchiveDTO["items"] = [
      ...filterArchive(todos).map((t) => ({ kind: "todo" as const, data: t })),
      ...filterArchiveSubtasks(subtasks).map((s) => ({
        kind: "subtask" as const,
        data: s,
        parentTitle: subtaskTitles.get(s.parentId) ?? null,
      })),
    ].sort((a, b) => (b.data.lastCompletedAt ?? 0) - (a.data.lastCompletedAt ?? 0));
    return ok({ items });
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
      .filter((t) => t.recurrence !== null)
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
    const now = Date.now();
    const todo: TodoDTO = {
      id: crypto.randomUUID(),
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      completed: false,
      isPersonal: parsed.data.isPersonal ?? false,
      sortOrder: nextSortOrder(all),
      recurrence: parsed.data.recurrence ?? null,
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
    const updated = applyUpdate(previous, parsed.data);
    const next = [...all];
    next[index] = updated;
    writeAll(next);

    // Mirror the server-side cascade: completing a parent completes its open subtasks.
    if (
      parsed.data.completed === true &&
      previous.completed === false
    ) {
      const subs = readSubtasks();
      writeSubtasks(cascadeCompleteSubtasks(subs, id));
    }

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
    writeAll(all.filter((t) => t.id !== id));
    // Cascade-delete subtasks attached to this todo (mirrors ON DELETE CASCADE).
    const subs = readSubtasks();
    writeSubtasks(subs.filter((s) => s.parentId !== id));
    return ok({ success: true as const });
  },

  async reorder(ids: string[]) {
    const parsed = reorderTodosSchema.safeParse({ ids });
    if (!parsed.success) return err("Invalid request");
    const unique = Array.from(new Set(parsed.data.ids));
    if (unique.length !== parsed.data.ids.length) return err("Invalid request");

    const all = readAll();
    if (!unique.every((id) => all.some((t) => t.id === id))) return err("Not found");

    writeAll(applyReorder(all, unique));
    return ok({ success: true as const });
  },

  async listSubtasks() {
    const subs = readSubtasks();
    return ok(sortSubtasks(filterMainListSubtasks(subs)));
  },

  async createSubtask(input: CreateSubtaskInput) {
    const parsed = createSubtaskSchema.safeParse(input);
    if (!parsed.success) return err("Invalid request");

    const todos = readAll();
    const parent = todos.find((t) => t.id === parsed.data.parentId);
    if (!parent) return err("Not found");

    const subs = readSubtasks();
    const now = Date.now();
    const subtask: SubtaskDTO = {
      id: crypto.randomUUID(),
      parentId: parsed.data.parentId,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      completed: false,
      isPersonal: parent.isPersonal,
      pinnedToWeek: parsed.data.pinnedToWeek ?? false,
      sortOrder: nextSubtaskSortOrder(subs, parsed.data.parentId),
      lastCompletedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: GUEST_USERNAME,
    };
    writeSubtasks([...subs, subtask]);
    return ok(subtask);
  },

  async updateSubtask(id: string, patch: UpdateSubtaskPatch) {
    const parsed = updateSubtaskSchema.safeParse(patch);
    if (!parsed.success) return err("Invalid request");

    const subs = readSubtasks();
    const index = subs.findIndex((s) => s.id === id);
    if (index === -1) return err("Not found");

    const updated = applySubtaskUpdate(subs[index], parsed.data);
    const next = [...subs];
    next[index] = updated;
    writeSubtasks(next);
    return ok(updated);
  },

  async deleteSubtask(id: string) {
    const subs = readSubtasks();
    if (!subs.some((s) => s.id === id)) return err("Not found");
    writeSubtasks(subs.filter((s) => s.id !== id));
    return ok({ success: true as const });
  },

  async reorderSubtasks(parentId: string, ids: string[]) {
    const parsed = reorderSubtasksSchema.safeParse({ parentId, ids });
    if (!parsed.success) return err("Invalid request");
    const unique = Array.from(new Set(parsed.data.ids));
    if (unique.length !== parsed.data.ids.length) return err("Invalid request");

    const subs = readSubtasks();
    if (!unique.every((id) => subs.some((s) => s.id === id && s.parentId === parentId))) {
      return err("Not found");
    }

    writeSubtasks(applySubtaskReorder(subs, parentId, unique));
    return ok({ success: true as const });
  },
};

export function clearGuestTodos(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(SUBTASKS_KEY);
  window.localStorage.removeItem(COMPLETIONS_KEY);
}
