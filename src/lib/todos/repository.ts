import type { ArchiveDTO, Recurrence, StatsDTO, SubtaskDTO, TodoDTO } from "@/lib/api-client";

export type RepoResult<T> = { data: T; error: null } | { data: null; error: string };

export interface CreateTodoInput {
  title: string;
  description?: string;
  isPersonal?: boolean;
  recurrence?: Recurrence;
  pinnedToWeek?: boolean;
}

export interface UpdateTodoPatch {
  title?: string;
  description?: string | null;
  completed?: boolean;
  sortOrder?: number;
  recurrence?: Recurrence;
  pinnedToWeek?: boolean;
}

export interface CreateSubtaskInput {
  parentId: string;
  title: string;
  description?: string;
  pinnedToWeek?: boolean;
}

export interface UpdateSubtaskPatch {
  title?: string;
  description?: string | null;
  completed?: boolean;
  sortOrder?: number;
  pinnedToWeek?: boolean;
}

export interface TodoRepository {
  list(): Promise<RepoResult<TodoDTO[]>>;
  archive(): Promise<RepoResult<ArchiveDTO>>;
  stats(): Promise<RepoResult<StatsDTO>>;
  create(input: CreateTodoInput): Promise<RepoResult<TodoDTO>>;
  update(id: string, patch: UpdateTodoPatch): Promise<RepoResult<TodoDTO>>;
  delete(id: string): Promise<RepoResult<{ success: true }>>;
  reorder(ids: string[]): Promise<RepoResult<{ success: true }>>;
  listSubtasks(): Promise<RepoResult<SubtaskDTO[]>>;
  createSubtask(input: CreateSubtaskInput): Promise<RepoResult<SubtaskDTO>>;
  updateSubtask(id: string, patch: UpdateSubtaskPatch): Promise<RepoResult<SubtaskDTO>>;
  deleteSubtask(id: string): Promise<RepoResult<{ success: true }>>;
  reorderSubtasks(parentId: string, ids: string[]): Promise<RepoResult<{ success: true }>>;
}
