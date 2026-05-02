import type {
  ArchiveDTO,
  LimitPeriod,
  Recurrence,
  StatsDTO,
  TodoDTO,
  TodoKind,
  VacationDTO,
} from "@/lib/api-client";

export type RepoResult<T> = { data: T; error: null } | { data: null; error: string };

export interface CreateTodoInput {
  title: string;
  description?: string;
  isPersonal?: boolean;
  recurrence?: Recurrence;
  pinnedToWeek?: boolean;
  parentId?: string | null;
  kind?: TodoKind;
  limitCount?: number | null;
  limitPeriod?: LimitPeriod;
  oncePerDay?: boolean;
}

export interface UpdateTodoPatch {
  title?: string;
  description?: string | null;
  completed?: boolean;
  sortOrder?: number;
  recurrence?: Recurrence;
  pinnedToWeek?: boolean;
  parentId?: string | null;
  autoReset?: boolean;
  kind?: TodoKind;
  limitCount?: number | null;
  limitPeriod?: LimitPeriod;
  oncePerDay?: boolean;
  recordSlip?: boolean;
  undoLastSlip?: boolean;
}

export interface TodoRepository {
  list(): Promise<RepoResult<TodoDTO[]>>;
  archive(): Promise<RepoResult<ArchiveDTO>>;
  stats(): Promise<RepoResult<StatsDTO>>;
  create(input: CreateTodoInput): Promise<RepoResult<TodoDTO>>;
  update(id: string, patch: UpdateTodoPatch): Promise<RepoResult<TodoDTO>>;
  delete(id: string): Promise<RepoResult<{ success: true }>>;
  reorder(ids: string[], parentId: string | null): Promise<RepoResult<{ success: true }>>;
  vacation(): Promise<RepoResult<VacationDTO>>;
  setVacation(action: "start" | "end"): Promise<RepoResult<VacationDTO>>;
}
