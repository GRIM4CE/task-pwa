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

export const recurrenceSchema = z.enum(["daily", "weekly"]).nullable();
export const todoKindSchema = z.enum(["do", "avoid"]);
export const limitPeriodSchema = z.enum(["week", "month"]).nullable();
export const pinnedToSchema = z.enum(["day", "week"]).nullable();
const limitCountSchema = z.number().int().min(1).max(999).nullable();

export const createTodoSchema = z
  .object({
    title: z.string().min(1, "Title is required").max(500, "Title too long"),
    description: z.string().max(5000, "Description too long").optional(),
    isPersonal: z.boolean().optional(),
    recurrence: recurrenceSchema.optional(),
    pinnedTo: pinnedToSchema.optional(),
    parentId: z.string().min(1).nullable().optional(),
    kind: todoKindSchema.optional(),
    limitCount: limitCountSchema.optional(),
    limitPeriod: limitPeriodSchema.optional(),
    oncePerDay: z.boolean().optional(),
  })
  .refine((v) => !(v.recurrence != null && v.pinnedTo != null), {
    message: "Recurring todos cannot be pinned",
    path: ["pinnedTo"],
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
    sortOrder: z.number().int().optional(),
    recurrence: recurrenceSchema.optional(),
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
  // These refinements catch cases where both fields are in the same patch.
  // Cases involving the existing row state are checked in the PATCH handler.
  .refine((v) => !(v.recurrence != null && v.pinnedTo != null), {
    message: "Recurring todos cannot be pinned",
    path: ["pinnedTo"],
  })
  .refine((v) => !(v.recurrence != null && v.parentId != null), {
    message: "Recurring todos cannot be subtasks",
    path: ["parentId"],
  })
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
