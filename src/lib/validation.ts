import { z } from "zod";

const usernameField = z
  .string()
  .min(1, "Username is required")
  .max(64, "Username too long")
  .transform((v) => v.trim().toLowerCase());

export const loginSchema = z.object({
  username: usernameField,
  totpCode: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});

export const verifyTotpSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});

export const recoveryLoginSchema = z.object({
  username: usernameField,
  recoveryCode: z.string().min(8, "Invalid recovery code").max(8, "Invalid recovery code"),
});

export const recurrenceSchema = z
  .enum(["daily", "weekly", "weekday", "monthly_day", "monthly_weekday"])
  .nullable();
export const recurrenceOrdinalSchema = z
  .enum(["first", "second", "third", "fourth", "last"])
  .nullable();
export const todoKindSchema = z.enum(["do", "avoid"]);
export const limitPeriodSchema = z.enum(["week", "month"]).nullable();
export const pinnedToSchema = z.enum(["day", "week"]).nullable();
const limitCountSchema = z.number().int().min(1).max(999).nullable();
const recurrenceWeekdaySchema = z.number().int().min(0).max(6).nullable();
const recurrenceDayOfMonthSchema = z.number().int().min(1).max(31).nullable();

// Each "scheduled" recurrence requires its own anchor columns and forbids the
// others. Centralized so create + update share the same rules.
const isScheduledRecurrenceShape = (v: {
  recurrence?: "daily" | "weekly" | "weekday" | "monthly_day" | "monthly_weekday" | null;
  recurrenceWeekday?: number | null;
  recurrenceDayOfMonth?: number | null;
  recurrenceOrdinal?: "first" | "second" | "third" | "fourth" | "last" | null;
}): boolean => {
  const r = v.recurrence;
  const wd = v.recurrenceWeekday ?? null;
  const dom = v.recurrenceDayOfMonth ?? null;
  const ord = v.recurrenceOrdinal ?? null;
  if (r === "weekday") return wd !== null && dom === null && ord === null;
  if (r === "monthly_day") return dom !== null && wd === null && ord === null;
  if (r === "monthly_weekday") return wd !== null && ord !== null && dom === null;
  // daily / weekly / null: no anchor fields permitted.
  return wd === null && dom === null && ord === null;
};

// The only legal recurrence + pin combo is weekly + Today: it surfaces a
// once-a-week task in the daily Today section without losing its weekly
// reset. Daily + any pin is redundant (already in Today). Weekly + week is
// redundant (already in This Week). Scheduled recurrences (weekday /
// monthly_day / monthly_weekday) self-place in Today on their occurrence
// date — pin is redundant for them too.
const isAllowedRecurrencePinCombo = (
  recurrence:
    | "daily"
    | "weekly"
    | "weekday"
    | "monthly_day"
    | "monthly_weekday"
    | null
    | undefined,
  pinnedTo: "day" | "week" | null | undefined
) =>
  recurrence == null ||
  pinnedTo == null ||
  (recurrence === "weekly" && pinnedTo === "day");

export const createTodoSchema = z
  .object({
    title: z.string().min(1, "Title is required").max(500, "Title too long"),
    description: z.string().max(5000, "Description too long").optional(),
    isPersonal: z.boolean().optional(),
    recurrence: recurrenceSchema.optional(),
    recurrenceWeekday: recurrenceWeekdaySchema.optional(),
    recurrenceDayOfMonth: recurrenceDayOfMonthSchema.optional(),
    recurrenceOrdinal: recurrenceOrdinalSchema.optional(),
    pinnedTo: pinnedToSchema.optional(),
    parentId: z.string().min(1).nullable().optional(),
    kind: todoKindSchema.optional(),
    limitCount: limitCountSchema.optional(),
    limitPeriod: limitPeriodSchema.optional(),
    oncePerDay: z.boolean().optional(),
  })
  .refine((v) => isAllowedRecurrencePinCombo(v.recurrence, v.pinnedTo), {
    message: "Only weekly recurring todos can be pinned to Today",
    path: ["pinnedTo"],
  })
  .refine(isScheduledRecurrenceShape, {
    message: "Recurrence anchor fields don't match the recurrence type",
    path: ["recurrence"],
  })
  .refine((v) => !(v.recurrence != null && v.parentId != null), {
    message: "Recurring todos cannot be subtasks",
    path: ["parentId"],
  })
  .refine((v) => !(v.kind === "avoid" && v.parentId != null), {
    message: "Avoid todos cannot be subtasks",
    path: ["parentId"],
  })
  .refine((v) => !(v.kind === "avoid" && v.recurrence != null), {
    message: "Avoid todos cannot be recurring",
    path: ["recurrence"],
  })
  .refine((v) => !(v.kind === "avoid" && v.pinnedTo != null), {
    message: "Avoid todos cannot be pinned",
    path: ["pinnedTo"],
  })
  .refine(
    (v) =>
      !(
        v.kind !== "avoid" &&
        ((v.limitCount != null && v.limitCount !== undefined) ||
          (v.limitPeriod != null && v.limitPeriod !== undefined))
      ),
    {
      message: "Limits only apply to avoid todos",
      path: ["limitCount"],
    }
  )
  .refine((v) => !(v.kind !== "avoid" && v.oncePerDay === true), {
    message: "Once-per-day only applies to avoid todos",
    path: ["oncePerDay"],
  })
  .refine((v) => (v.limitCount == null) === (v.limitPeriod == null), {
    message: "Set both limit count and period, or neither",
    path: ["limitCount"],
  });

export const updateTodoSchema = z
  .object({
    title: z.string().min(1, "Title is required").max(500, "Title too long").optional(),
    description: z.string().max(5000, "Description too long").nullable().optional(),
    completed: z.boolean().optional(),
    isPersonal: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    recurrence: recurrenceSchema.optional(),
    recurrenceWeekday: recurrenceWeekdaySchema.optional(),
    recurrenceDayOfMonth: recurrenceDayOfMonthSchema.optional(),
    recurrenceOrdinal: recurrenceOrdinalSchema.optional(),
    pinnedTo: pinnedToSchema.optional(),
    // null promotes a subtask to top-level; a string demotes a top-level todo to
    // a subtask of that parent.
    parentId: z.string().min(1).nullable().optional(),
    // Marks the un-complete as an automatic recurrence reset (next period
    // crossed midnight) rather than a user-initiated undo. The server keeps
    // the prior period's completion event intact so analytics retain history.
    autoReset: z.boolean().optional(),
    kind: todoKindSchema.optional(),
    limitCount: limitCountSchema.optional(),
    limitPeriod: limitPeriodSchema.optional(),
    oncePerDay: z.boolean().optional(),
    // For avoid todos: log a slip into todoCompletions without flipping
    // `completed`. Mutually exclusive with `completed` in the same patch.
    recordSlip: z.boolean().optional(),
    // For avoid todos: delete the most recent slip event for this todo
    // (and reset lastCompletedAt to the new latest, or null). Powers the
    // post-slip Undo toast. Mutually exclusive with recordSlip and completed.
    undoLastSlip: z.boolean().optional(),
  })
  // The recurrence/pin combo check lives in the PATCH route, not here:
  // the modal always sends both fields, so a no-op patch on a legacy
  // row (e.g. an existing weekly+week from before this rule existed)
  // would otherwise be rejected at the schema layer before the route's
  // persisted-state-aware logic could let the unchanged values through.
  .refine((v) => !(v.recurrence != null && v.parentId != null), {
    message: "Recurring todos cannot be subtasks",
    path: ["parentId"],
  })
  .refine(
    (v) => {
      // Anchor columns are tightly coupled to recurrence: if the patch
      // doesn't touch recurrence, it can't touch anchors either (mirrored on
      // the server when applying the update). When recurrence is in the
      // patch, the shape must match the new recurrence type.
      if (v.recurrence === undefined) {
        return (
          v.recurrenceWeekday === undefined &&
          v.recurrenceDayOfMonth === undefined &&
          v.recurrenceOrdinal === undefined
        );
      }
      return isScheduledRecurrenceShape(v);
    },
    {
      message: "Recurrence anchor fields don't match the recurrence type",
      path: ["recurrence"],
    }
  )
  .refine((v) => !(v.kind === "avoid" && v.pinnedTo != null), {
    message: "Avoid todos cannot be pinned",
    path: ["pinnedTo"],
  })
  .refine((v) => !(v.recordSlip === true && v.completed !== undefined), {
    message: "Cannot record slip and toggle completion in the same request",
    path: ["recordSlip"],
  })
  .refine((v) => !(v.undoLastSlip === true && v.recordSlip === true), {
    message: "Cannot record and undo a slip in the same request",
    path: ["undoLastSlip"],
  })
  .refine((v) => !(v.undoLastSlip === true && v.completed !== undefined), {
    message: "Cannot undo slip and toggle completion in the same request",
    path: ["undoLastSlip"],
  })
  .refine((v) => (v.limitCount == null) === (v.limitPeriod == null), {
    message: "Set both limit count and period, or neither",
    path: ["limitCount"],
  });

export const reorderTodosSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "At least one id required"),
  // Optional scope: null = top-level reorder; a string = reorder within a parent.
  parentId: z.string().min(1).nullable().optional(),
});
