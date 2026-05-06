import type {
  ArchiveDTO,
  StatsDTO,
  TodoDTO,
  VacationDTO,
  VacationPeriod,
} from "@/lib/api-client";
import { hasSlipToday } from "@/lib/analytics";
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
const VACATIONS_KEY = "todo-pwa:guest:vacations";
const COMPLETIONS_RETENTION_MS = 120 * 24 * 60 * 60 * 1000;
export const GUEST_USERNAME = "Guest";

type CompletionEvent = { todoId: string; completedAt: number };

function ok<T>(data: T): RepoResult<T> {
  return { data, error: null };
}

function err<T>(error: string): RepoResult<T> {
  return { data: null, error };
}

const SLIP_WINDOW_MS = 35 * 24 * 60 * 60 * 1000;

// Filter the persisted completion log down to the last 35 days for a given
// todo (long enough to cover a 31-day calendar month plus buffer). Mirrors
// the avoid-todo `recentSlips` field the server returns on the
// list/POST/PATCH responses.
function recentSlipsFor(todoId: string, events: CompletionEvent[]): number[] {
  const cutoff = Date.now() - SLIP_WINDOW_MS;
  return events
    .filter((e) => e.todoId === todoId && e.completedAt >= cutoff)
    .map((e) => e.completedAt);
}

function withRecentSlips(todo: TodoDTO, events: CompletionEvent[]): TodoDTO {
  if (todo.kind !== "avoid") return { ...todo, recentSlips: [] };
  return { ...todo, recentSlips: recentSlipsFor(todo.id, events) };
}

function readAll(): TodoDTO[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(STORAGE_KEY);
  let todos: TodoDTO[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        todos = (parsed as Array<TodoDTO & { pinnedToWeek?: boolean }>).map((t) => ({
          ...t,
          // Migrate legacy guest data: the old boolean `pinnedToWeek` becomes
          // `pinnedTo: 'week'` when true, null otherwise.
          pinnedTo: t.pinnedTo ?? (t.pinnedToWeek ? "week" : null),
          parentId: t.parentId ?? null,
          // Backfill kind/limit fields for guest data written before the
          // avoid-habit feature shipped.
          kind: t.kind ?? "do",
          limitCount: t.limitCount ?? null,
          limitPeriod: t.limitPeriod ?? null,
          oncePerDay: t.oncePerDay ?? false,
          recentSlips: t.recentSlips ?? [],
          // Backfill anchor fields for guest data written before scheduled
          // recurrences shipped.
          recurrenceWeekday: t.recurrenceWeekday ?? null,
          recurrenceDayOfMonth: t.recurrenceDayOfMonth ?? null,
          recurrenceOrdinal: t.recurrenceOrdinal ?? null,
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
        const migrated = (parsed as Array<TodoDTO & { parentId: string; pinnedToWeek?: boolean }>)
          .filter((s) => todos.some((t) => t.id === s.parentId))
          .map<TodoDTO>((s) => ({
            ...s,
            recurrence: null,
            recurrenceWeekday: null,
            recurrenceDayOfMonth: null,
            recurrenceOrdinal: null,
            parentId: s.parentId,
            pinnedTo: s.pinnedTo ?? (s.pinnedToWeek ? "week" : null),
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

function readVacations(): VacationPeriod[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(VACATIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as VacationPeriod[]).filter((v) => {
      if (typeof v?.id !== "string") return false;
      if (typeof v.startsAt !== "number" || !Number.isFinite(v.startsAt)) {
        return false;
      }
      // endsAt is null while active, otherwise a finite epoch ms. Anything
      // else (NaN, Infinity, "yesterday") would silently misclassify
      // vacation overlap downstream.
      if (v.endsAt !== null && v.endsAt !== undefined) {
        if (typeof v.endsAt !== "number" || !Number.isFinite(v.endsAt)) {
          return false;
        }
      }
      return true;
    });
  } catch {
    return [];
  }
}

function writeVacations(periods: VacationPeriod[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(VACATIONS_KEY, JSON.stringify(periods));
}

export const localTodoRepository: TodoRepository = {
  async list() {
    const all = readAll();
    const events = readCompletions();
    return ok(
      sortTodos(filterMainList(all)).map((t) => withRecentSlips(t, events))
    );
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
        recurrence: t.recurrence as Exclude<typeof t.recurrence, null>,
        recurrenceWeekday: t.recurrenceWeekday,
        recurrenceDayOfMonth: t.recurrenceDayOfMonth,
        recurrenceOrdinal: t.recurrenceOrdinal,
        isPersonal: t.isPersonal,
        createdAt: t.createdAt,
        completions: (byTodo.get(t.id) ?? []).sort((a, b) => a - b),
      }));
    const avoid: StatsDTO["avoid"] = all
      .filter((t) => t.kind === "avoid" && t.parentId === null)
      .map((t) => ({
        id: t.id,
        title: t.title,
        isPersonal: t.isPersonal,
        createdAt: t.createdAt,
        limitCount: t.limitCount,
        limitPeriod: t.limitPeriod,
        oncePerDay: t.oncePerDay,
        completions: (byTodo.get(t.id) ?? []).sort((a, b) => a - b),
      }));
    const vacations = readVacations()
      .filter((v) => v.endsAt === null || v.endsAt >= cutoff)
      .sort((a, b) => a.startsAt - b.startsAt);
    return ok({ todos, avoid, vacations });
  },

  async create(input: CreateTodoInput) {
    const parsed = createTodoSchema.safeParse(input);
    if (!parsed.success) return err("Invalid request");

    const all = readAll();
    const parentId = parsed.data.parentId ?? null;

    // Subtasks inherit isPersonal from the parent and can't have recurrence
    // or be avoid-tracked (avoid-todos can't be subtasks at all).
    let isPersonal = parsed.data.isPersonal ?? false;
    let recurrence = parsed.data.recurrence ?? null;
    let kind = parsed.data.kind ?? "do";
    if (parentId !== null) {
      const parent = all.find((t) => t.id === parentId);
      if (!parent) return err("Not found");
      if (parent.parentId !== null) return err("Parent must be top-level");
      isPersonal = parent.isPersonal;
      recurrence = null;
      kind = "do";
    }
    // Anchor fields are only kept when the chosen recurrence type uses them;
    // mirrors the server's POST handler.
    const recurrenceWeekday =
      recurrence === "weekday" || recurrence === "monthly_weekday"
        ? parsed.data.recurrenceWeekday ?? null
        : null;
    const recurrenceDayOfMonth =
      recurrence === "monthly_day" ? parsed.data.recurrenceDayOfMonth ?? null : null;
    const recurrenceOrdinal =
      recurrence === "monthly_weekday" ? parsed.data.recurrenceOrdinal ?? null : null;

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
      recurrenceWeekday,
      recurrenceDayOfMonth,
      recurrenceOrdinal,
      pinnedTo: parsed.data.pinnedTo ?? null,
      kind,
      limitCount: kind === "avoid" ? parsed.data.limitCount ?? null : null,
      limitPeriod: kind === "avoid" ? parsed.data.limitPeriod ?? null : null,
      oncePerDay: kind === "avoid" ? parsed.data.oncePerDay ?? false : false,
      recentSlips: [],
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

    // Subtasks inherit isPersonal from their parent; the parent's cascade
    // below carries the change to children.
    if (parsed.data.isPersonal !== undefined && previous.parentId !== null) {
      return err("Subtask visibility follows the parent");
    }

    // Mirror the server invariant: a subtask can never carry a recurrence.
    // Setting one is only valid when the same patch promotes the row to
    // top-level (parentId: null).
    const willBeTopLevel =
      parsed.data.parentId === null ||
      (parsed.data.parentId === undefined && previous.parentId === null);
    if (
      parsed.data.recurrence !== undefined &&
      parsed.data.recurrence !== null &&
      !willBeTopLevel
    ) {
      return err("Subtasks cannot have recurrence");
    }

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

    // Cross-field invariants involving the persisted row state — schema-level
    // refinements only see the request body. Mirrors the server PATCH guards.
    const effectiveKind = parsed.data.kind ?? previous.kind;
    const effectiveParentId =
      parsed.data.parentId !== undefined
        ? parsed.data.parentId
        : previous.parentId;
    const effectiveRecurrenceForKind =
      parsed.data.recurrence !== undefined
        ? parsed.data.recurrence
        : previous.recurrence;
    if (effectiveKind === "avoid" && effectiveParentId !== null) {
      return err("Avoid todos cannot be subtasks");
    }
    if (effectiveKind === "avoid" && effectiveRecurrenceForKind !== null) {
      return err("Avoid todos cannot be recurring");
    }
    const effectivePinnedTo =
      parsed.data.pinnedTo !== undefined
        ? parsed.data.pinnedTo
        : previous.pinnedTo;
    if (effectiveKind === "avoid" && effectivePinnedTo !== null) {
      return err("Avoid todos cannot be pinned");
    }
    // Recurring + pin: only weekly + Today is legal. Mirrors the server PATCH
    // guard — only reject when the patch is *actively* asserting an invalid
    // combo (changing recurrence to a non-null value on a pinned row, or
    // changing the pin to a non-null value on a recurring row). Legacy rows
    // pass through unchanged so the modal can resave them and clear the pin.
    const settingRecurringNew =
      parsed.data.recurrence !== undefined &&
      parsed.data.recurrence !== null &&
      parsed.data.recurrence !== previous.recurrence;
    const settingPinNew =
      parsed.data.pinnedTo !== undefined &&
      parsed.data.pinnedTo !== null &&
      parsed.data.pinnedTo !== previous.pinnedTo;
    const isAllowedRecurrencePinCombo =
      effectiveRecurrenceForKind === null ||
      effectivePinnedTo === null ||
      (effectiveRecurrenceForKind === "weekly" && effectivePinnedTo === "day");
    if (
      !isAllowedRecurrencePinCombo &&
      ((settingRecurringNew && effectivePinnedTo !== null) ||
        (settingPinNew && effectiveRecurrenceForKind !== null))
    ) {
      return err(
        "Recurring todos can only be pinned to Today, and only when the recurrence is weekly"
      );
    }
    // Require the persisted row to already be avoid — see the matching guard
    // in /api/todos/[id]/route.ts for why a same-patch kind switch is rejected.
    if (
      (parsed.data.recordSlip === true || parsed.data.undoLastSlip === true) &&
      previous.kind !== "avoid"
    ) {
      return err("Slip operations only apply to avoid todos");
    }
    if (effectiveKind !== "avoid") {
      if (
        (parsed.data.limitCount !== undefined && parsed.data.limitCount !== null) ||
        (parsed.data.limitPeriod !== undefined && parsed.data.limitPeriod !== null)
      ) {
        return err("Limits only apply to avoid todos");
      }
      if (parsed.data.oncePerDay === true) {
        return err("Once-per-day only applies to avoid todos");
      }
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

    // Mirror the server-side cascade for visibility flips so subtasks keep
    // matching their parent's isPersonal value.
    if (
      parsed.data.isPersonal !== undefined &&
      parsed.data.isPersonal !== previous.isPersonal
    ) {
      const flippedTo = parsed.data.isPersonal;
      next = next.map((t) =>
        t.parentId === id ? { ...t, isPersonal: flippedTo, updatedAt: Date.now() } : t
      );
    }
    writeAll(next);

    // Avoid todos: each slip is logged as a completion event without
    // flipping `completed`. Mirror the server's recordSlip handling.
    if (parsed.data.recordSlip === true && previous.kind === "avoid") {
      // Local repo can use the precise local-calendar-day check (vs. the
      // server's 24h rolling fallback) since we have the user's timezone
      // available client-side. Idempotent: a duplicate slip on the same
      // local day is a no-op rather than an error so the optimistic UI
      // doesn't roll back.
      if (previous.oncePerDay) {
        const existingEvents = readCompletions();
        const todaySlip = existingEvents.some(
          (e) => e.todoId === id && hasSlipToday([e.completedAt])
        );
        if (todaySlip) {
          return ok(withRecentSlips(updated, existingEvents));
        }
      }
      const slipAt = Date.now();
      next[index] = { ...updated, lastCompletedAt: slipAt };
      writeAll(next);
      const events = [
        ...readCompletions(),
        { todoId: id, completedAt: slipAt },
      ];
      writeCompletions(events);
      return ok(withRecentSlips(next[index], events));
    }

    // Undo the most recent slip. Mirrors the server transaction: drop the
    // latest event and rebase lastCompletedAt onto the new latest (or null).
    if (parsed.data.undoLastSlip === true && previous.kind === "avoid") {
      const events = readCompletions();
      let latestIdx = -1;
      let latestAt = -Infinity;
      for (let i = 0; i < events.length; i++) {
        if (events[i].todoId === id && events[i].completedAt > latestAt) {
          latestAt = events[i].completedAt;
          latestIdx = i;
        }
      }
      if (latestIdx === -1) {
        // No slip to undo — return the row as-is.
        writeAll(next);
        return ok(withRecentSlips(updated, events));
      }
      const remaining = [
        ...events.slice(0, latestIdx),
        ...events.slice(latestIdx + 1),
      ];
      writeCompletions(remaining);
      let nextLastCompletedAt: number | null = null;
      for (const e of remaining) {
        if (
          e.todoId === id &&
          (nextLastCompletedAt === null || e.completedAt > nextLastCompletedAt)
        ) {
          nextLastCompletedAt = e.completedAt;
        }
      }
      next[index] = { ...updated, lastCompletedAt: nextLastCompletedAt };
      writeAll(next);
      return ok(withRecentSlips(next[index], remaining));
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
    } else if (
      parsed.data.completed === false &&
      previous.completed === true &&
      previous.recurrence !== null &&
      parsed.data.autoReset !== true
    ) {
      // Mirror the server: drop the most recent completion event for this todo
      // so analytics don't keep counting an undone toggle. Auto-resets at the
      // next period boundary skip this so the prior period's tick stays
      // recorded as real history.
      const events = readCompletions();
      let latestIdx = -1;
      let latestAt = -Infinity;
      for (let i = 0; i < events.length; i++) {
        if (events[i].todoId === id && events[i].completedAt > latestAt) {
          latestAt = events[i].completedAt;
          latestIdx = i;
        }
      }
      if (latestIdx !== -1) {
        writeCompletions([
          ...events.slice(0, latestIdx),
          ...events.slice(latestIdx + 1),
        ]);
      }
    }
    return ok(withRecentSlips(updated, readCompletions()));
  },

  async delete(id: string) {
    const all = readAll();
    if (!all.some((t) => t.id === id)) return err("Not found");
    // Cascade-delete children to mirror ON DELETE CASCADE in SQLite.
    writeAll(all.filter((t) => t.id !== id && t.parentId !== id));
    return ok({ success: true as const });
  },

  async vacation() {
    const periods = readVacations().sort((a, b) => a.startsAt - b.startsAt);
    const active = periods.find((p) => p.endsAt === null) ?? null;
    return ok<VacationDTO>({ periods, active });
  },

  async setVacation(action: "start" | "end") {
    const now = Date.now();
    const periods = readVacations();
    const open = periods.find((p) => p.endsAt === null) ?? null;
    let next = periods;
    if (action === "start") {
      if (!open) {
        next = [
          ...periods,
          { id: crypto.randomUUID(), startsAt: now, endsAt: null },
        ];
      }
    } else {
      // Defensive: close *every* open row, mirroring the server's UPDATE
      // and protecting against historical data that predates this guard.
      next = periods.map((p) =>
        p.endsAt === null ? { ...p, endsAt: now } : p
      );
    }
    const sorted = [...next].sort((a, b) => a.startsAt - b.startsAt);
    writeVacations(sorted);
    const active = sorted.find((p) => p.endsAt === null) ?? null;
    return ok<VacationDTO>({ periods: sorted, active });
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
  window.localStorage.removeItem(VACATIONS_KEY);
}
