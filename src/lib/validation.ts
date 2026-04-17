import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().min(1, "Username is required").max(64, "Username too long"),
  totpCode: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});

export const verifyTotpSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});

export const recoveryLoginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  recoveryCode: z.string().min(8, "Invalid recovery code").max(8, "Invalid recovery code"),
});

export const createTodoSchema = z.object({
  title: z.string().min(1, "Title is required").max(500, "Title too long"),
  description: z.string().max(5000, "Description too long").optional(),
  isPersonal: z.boolean().optional(),
});

export const updateTodoSchema = z.object({
  title: z.string().min(1, "Title is required").max(500, "Title too long").optional(),
  description: z.string().max(5000, "Description too long").nullable().optional(),
  completed: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const reorderTodosSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "At least one id required"),
});
