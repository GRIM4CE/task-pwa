import { sqliteTable, text, integer, uniqueIndex, index, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ============================================
// Auth tables
// ============================================

export const users = sqliteTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  username: text("username").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const totpSecrets = sqliteTable("totp_secrets", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  encryptedSecret: text("encrypted_secret").notNull(),
  encryptionIv: text("encryption_iv").notNull(),
  algorithm: text("algorithm").notNull().default("SHA1"),
  digits: integer("digits").notNull().default(6),
  period: integer("period").notNull().default(30),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const recoveryCodes = sqliteTable("recovery_codes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_sessions_token_hash").on(table.tokenHash),
    index("idx_sessions_expires").on(table.expiresAt),
  ]
);

export const totpUsedCodes = sqliteTable(
  "totp_used_codes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    code: text("code").notNull(),
    timeStep: integer("time_step").notNull(),
    usedAt: integer("used_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("idx_totp_used_codes_unique").on(table.code, table.timeStep),
  ]
);

export const failedLoginAttempts = sqliteTable(
  "failed_login_attempts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ipAddress: text("ip_address").notNull(),
    attemptedAt: integer("attempted_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    usernameAttempted: text("username_attempted"),
  },
  (table) => [
    index("idx_failed_logins_ip").on(table.ipAddress, table.attemptedAt),
  ]
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").references(() => users.id),
    action: text("action").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("idx_audit_log_created").on(table.createdAt)]
);

// ============================================
// Feature: Todos
// ============================================

export const todos = sqliteTable(
  "todos",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Self-FK: when set, this todo is a subtask of parentId. NULL means top-level.
    // Recurrence is meaningless for subtasks and is dropped on demote.
    parentId: text("parent_id").references((): AnySQLiteColumn => todos.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    completed: integer("completed", { mode: "boolean" }).notNull().default(false),
    isPersonal: integer("is_personal", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    recurrence: text("recurrence", { enum: ["daily", "weekly"] }),
    pinnedToWeek: integer("pinned_to_week", { mode: "boolean" }).notNull().default(false),
    // "do" = normal todo (default). "avoid" = bad-habit tracker: each tap
    // logs a slip into todoCompletions instead of flipping completed, and the
    // row never archives — it stays visible so future slips can be logged.
    kind: text("kind", { enum: ["do", "avoid"] }).notNull().default("do"),
    // Optional warning threshold for avoid-todos. limitCount slips within
    // limitPeriod (rolling) trips an at/over-limit warning on the card.
    limitCount: integer("limit_count"),
    limitPeriod: text("limit_period", { enum: ["week", "month"] }),
    lastCompletedAt: integer("last_completed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_todos_user").on(table.userId, table.completed, table.sortOrder),
    index("idx_todos_parent").on(table.parentId, table.sortOrder),
  ]
);

// Vacation periods. While a row's [startsAt, endsAt) interval covers a
// given day, recurring "do" misses and avoid slips on that day count as
// neutral in analytics rather than as failures. endsAt is null while a
// vacation is currently active. Only days *after* a vacation row's
// startsAt are affected — toggling on does not retroactively neutralize
// prior misses.
export const vacations = sqliteTable(
  "vacations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startsAt: integer("starts_at", { mode: "timestamp" }).notNull(),
    endsAt: integer("ends_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_vacations_user").on(table.userId, table.startsAt),
  ]
);

// One row per completion event for a recurring todo. Lets analytics
// reconstruct history that would otherwise be lost when a recurring reset
// overwrites lastCompletedAt. Non-recurring completions are not recorded.
export const todoCompletions = sqliteTable(
  "todo_completions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    todoId: text("todo_id")
      .notNull()
      .references(() => todos.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    completedAt: integer("completed_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_todo_completions_todo_completed").on(
      table.todoId,
      table.completedAt
    ),
    index("idx_todo_completions_user_completed").on(
      table.userId,
      table.completedAt
    ),
  ]
);

