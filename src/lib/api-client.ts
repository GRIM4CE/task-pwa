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

export interface TodoDTO {
  id: string;
  title: string;
  description: string | null;
  completed: boolean;
  isPersonal: boolean;
  sortOrder: number;
  recurrence: Recurrence;
  lastCompletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

export interface RecurringTodoStats {
  id: string;
  title: string;
  recurrence: "daily" | "weekly";
  isPersonal: boolean;
  createdAt: number;
  completions: number[];
}

export interface StatsDTO {
  todos: RecurringTodoStats[];
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
    archive: () => apiRequest<TodoDTO[]>("/api/todos/archive"),
    stats: () => apiRequest<StatsDTO>("/api/todos/stats"),
    create: (body: { title: string; description?: string; isPersonal?: boolean; recurrence?: Recurrence }) =>
      apiRequest<TodoDTO>("/api/todos", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: { title?: string; description?: string | null; completed?: boolean; sortOrder?: number; recurrence?: Recurrence }) =>
      apiRequest<TodoDTO>(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    reorder: (ids: string[]) =>
      apiRequest<{ success: boolean }>("/api/todos/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
    delete: (id: string) => apiRequest<{ success: boolean }>(`/api/todos/${id}`, { method: "DELETE" }),
  },
};
