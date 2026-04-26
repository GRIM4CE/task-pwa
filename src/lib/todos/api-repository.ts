import { api } from "@/lib/api-client";
import type {
  CreateTodoInput,
  TodoRepository,
  UpdateTodoPatch,
} from "./repository";

export const apiTodoRepository: TodoRepository = {
  list: () => api.todos.list(),
  archive: () => api.todos.archive(),
  create: (input: CreateTodoInput) => api.todos.create(input),
  update: (id: string, patch: UpdateTodoPatch) => api.todos.update(id, patch),
  delete: async (id: string) => {
    const { data, error } = await api.todos.delete(id);
    if (error) return { data: null, error };
    if (!data?.success) return { data: null, error: "Delete failed" };
    return { data: { success: true as const }, error: null };
  },
  reorder: async (ids: string[]) => {
    const { data, error } = await api.todos.reorder(ids);
    if (error) return { data: null, error };
    if (!data?.success) return { data: null, error: "Reorder failed" };
    return { data: { success: true as const }, error: null };
  },
};
