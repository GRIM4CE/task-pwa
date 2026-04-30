import { api } from "@/lib/api-client";
import type {
  CreateSubtaskInput,
  CreateTodoInput,
  TodoRepository,
  UpdateSubtaskPatch,
  UpdateTodoPatch,
} from "./repository";

export const apiTodoRepository: TodoRepository = {
  list: () => api.todos.list(),
  archive: () => api.todos.archive(),
  stats: () => api.todos.stats(),
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
  listSubtasks: () => api.subtasks.list(),
  createSubtask: (input: CreateSubtaskInput) => api.subtasks.create(input),
  updateSubtask: (id: string, patch: UpdateSubtaskPatch) => api.subtasks.update(id, patch),
  deleteSubtask: async (id: string) => {
    const { data, error } = await api.subtasks.delete(id);
    if (error) return { data: null, error };
    if (!data?.success) return { data: null, error: "Delete failed" };
    return { data: { success: true as const }, error: null };
  },
  reorderSubtasks: async (parentId: string, ids: string[]) => {
    const { data, error } = await api.subtasks.reorder(parentId, ids);
    if (error) return { data: null, error };
    if (!data?.success) return { data: null, error: "Reorder failed" };
    return { data: { success: true as const }, error: null };
  },
};
