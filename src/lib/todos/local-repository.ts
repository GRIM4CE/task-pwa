import type { TodoDTO } from "@/lib/api-client";
import {
  createTodoSchema,
  reorderTodosSchema,
  updateTodoSchema,
} from "@/lib/validation";
import {
  applyReorder,
  applyUpdate,
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
export const GUEST_USERNAME = "Guest";

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
    return Array.isArray(parsed) ? (parsed as TodoDTO[]) : [];
  } catch {
    return [];
  }
}

function writeAll(list: TodoDTO[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export const localTodoRepository: TodoRepository = {
  async list() {
    const all = readAll();
    return ok(sortTodos(filterMainList(all)));
  },

  async archive() {
    const all = readAll();
    return ok(filterArchive(all));
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

    const updated = applyUpdate(all[index], parsed.data);
    const next = [...all];
    next[index] = updated;
    writeAll(next);
    return ok(updated);
  },

  async delete(id: string) {
    const all = readAll();
    if (!all.some((t) => t.id === id)) return err("Not found");
    writeAll(all.filter((t) => t.id !== id));
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
};

export function clearGuestTodos(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}
