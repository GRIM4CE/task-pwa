type ApiResponse<T> = { data: T; error: null } | { data: null; error: string };

async function apiRequest<T>(
  url: string,
  options?: RequestInit
): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
      ...options,
    });

    const data = await response.json();

    if (!response.ok) {
      return { data: null, error: data.error ?? `Request failed (${response.status})` };
    }

    return { data, error: null };
  } catch {
    return { data: null, error: "Network error. Please try again." };
  }
}

export type Recurrence = "daily" | "weekly" | null;
export type TodoKind = "do" | "avoid";
export type LimitPeriod = "week" | "month" | null;
export type PinnedTo = "day" | "week" | null;

export interface TodoDTO {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
  completed: boolean;
  isPersonal: boolean;
  sortOrder: number;
  recurrence: Recurrence;
  pinnedTo: PinnedTo;
  kind: TodoKind;
  limitCount: number | null;
  limitPeriod: LimitPeriod;
  oncePerDay: boolean;
  // For avoid-todos only: completion timestamps within the last 35 days
  // (long enough to cover a 31-day calendar month plus buffer). Lets the
  // card compute its own warning state without a second round-trip to
  // /api/todos/stats. Empty for non-avoid rows.
  recentSlips: number[];
  lastCompletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

export interface ArchiveDTO {
  items: Array<{ todo: TodoDTO; parentTitle: string | null }>;
}

export interface RecurringTodoStats {
  id: string;
  title: string;
  recurrence: "daily" | "weekly";
  isPersonal: boolean;
  createdAt: number;
  completions: number[];
}

export interface AvoidTodoStats {
  id: string;
  title: string;
  isPersonal: boolean;
  createdAt: number;
  limitCount: number | null;
  limitPeriod: LimitPeriod;
  oncePerDay: boolean;
  completions: number[];
}

// A vacation period: while [startsAt, endsAt) covers a given day, recurring
// misses and avoid slips on that day count as neutral in analytics. endsAt
// is null while the vacation is currently active.
export interface VacationPeriod {
  id: string;
  startsAt: number;
  endsAt: number | null;
}

export interface VacationDTO {
  periods: VacationPeriod[];
  active: VacationPeriod | null;
}

export interface StatsDTO {
  todos: RecurringTodoStats[];
  avoid: AvoidTodoStats[];
  vacations: VacationPeriod[];
}

export const api = {
  auth: {
    status: () => apiRequest<{ isAuthenticated: boolean; user: unknown; needsSetup: boolean; usernames?: string[] }>("/api/auth/status"),
    setup: () => apiRequest<{ qrCodeUrl: string; manualEntryKey: string; usernames: string[]; encryptedSecret: string; encryptionIv: string }>("/api/auth/setup", { method: "POST" }),
    verifySetup: (body: { totpCode: string; selectedUsername: string; encryptedSecret: string; encryptionIv: string }) =>
      apiRequest<{ success: boolean; recoveryCodes: string[]; user: unknown }>("/api/auth/setup/verify", { method: "POST", body: JSON.stringify(body) }),
    login: (body: { username: string; totpCode: string }) =>
      apiRequest<{ success: boolean; user: unknown }>("/api/auth/login", { method: "POST", body: JSON.stringify(body) }),
    logout: () => apiRequest<{ success: boolean }>("/api/auth/logout", { method: "POST" }),
    recovery: (body: { username: string; recoveryCode: string }) =>
      apiRequest<{ success: boolean; remainingRecoveryCodes: number; user: unknown }>("/api/auth/recovery", { method: "POST", body: JSON.stringify(body) }),
  },
  todos: {
    list: () => apiRequest<TodoDTO[]>("/api/todos"),
    archive: () => apiRequest<ArchiveDTO>("/api/todos/archive"),
    stats: () => apiRequest<StatsDTO>("/api/todos/stats"),
    create: (body: { title: string; description?: string; isPersonal?: boolean; recurrence?: Recurrence; pinnedTo?: PinnedTo; parentId?: string | null; kind?: TodoKind; limitCount?: number | null; limitPeriod?: LimitPeriod; oncePerDay?: boolean }) =>
      apiRequest<TodoDTO>("/api/todos", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: { title?: string; description?: string | null; completed?: boolean; sortOrder?: number; recurrence?: Recurrence; pinnedTo?: PinnedTo; parentId?: string | null; autoReset?: boolean; kind?: TodoKind; limitCount?: number | null; limitPeriod?: LimitPeriod; oncePerDay?: boolean; recordSlip?: boolean; undoLastSlip?: boolean }) =>
      apiRequest<TodoDTO>(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    reorder: (ids: string[], parentId?: string | null) =>
      apiRequest<{ success: boolean }>("/api/todos/reorder", { method: "POST", body: JSON.stringify({ ids, parentId: parentId ?? null }) }),
    delete: (id: string) => apiRequest<{ success: boolean }>(`/api/todos/${id}`, { method: "DELETE" }),
  },
  vacation: {
    get: () => apiRequest<VacationDTO>("/api/vacation"),
    set: (action: "start" | "end") =>
      apiRequest<VacationDTO>("/api/vacation", {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
  },
};
