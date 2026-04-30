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

export const createTodoSchema = z.object({
  title: z.string().min(1, "Title is required").max(500, "Title too long"),
  description: z.string().max(5000, "Description too long").optional(),
  isPersonal: z.boolean().optional(),
  recurrence: recurrenceSchema.optional(),
  pinnedToWeek: z.boolean().optional(),
});

export const updateTodoSchema = z.object({
  title: z.string().min(1, "Title is required").max(500, "Title too long").optional(),
  description: z.string().max(5000, "Description too long").nullable().optional(),
  completed: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  recurrence: recurrenceSchema.optional(),
  pinnedToWeek: z.boolean().optional(),
});

export const reorderTodosSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "At least one id required"),
});

export const createSubtaskSchema = z.object({
  parentId: z.string().min(1, "Parent id is required"),
  title: z.string().min(1, "Title is required").max(500, "Title too long"),
  description: z.string().max(5000, "Description too long").optional(),
  pinnedToWeek: z.boolean().optional(),
});

export const updateSubtaskSchema = z.object({
  title: z.string().min(1, "Title is required").max(500, "Title too long").optional(),
  description: z.string().max(5000, "Description too long").nullable().optional(),
  completed: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  pinnedToWeek: z.boolean().optional(),
});

export const reorderSubtasksSchema = z.object({
  parentId: z.string().min(1, "Parent id is required"),
  ids: z.array(z.string().min(1)).min(1, "At least one id required"),
});
