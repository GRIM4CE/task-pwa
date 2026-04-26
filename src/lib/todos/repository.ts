import type { Recurrence, TodoDTO } from "@/lib/api-client";

export type RepoResult<T> = { data: T; error: null } | { data: null; error: string };

export interface CreateTodoInput {
  title: string;
  description?: string;
  isPersonal?: boolean;
  recurrence?: Recurrence;
}

export interface UpdateTodoPatch {
  title?: string;
  description?: string | null;
  completed?: boolean;
  sortOrder?: number;
  recurrence?: Recurrence;
}

export interface TodoRepository {
  list(): Promise<RepoResult<TodoDTO[]>>;
  archive(): Promise<RepoResult<TodoDTO[]>>;
  create(input: CreateTodoInput): Promise<RepoResult<TodoDTO>>;
  update(id: string, patch: UpdateTodoPatch): Promise<RepoResult<TodoDTO>>;
  delete(id: string): Promise<RepoResult<{ success: true }>>;
  reorder(ids: string[]): Promise<RepoResult<{ success: true }>>;
}
