import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, lt, isNull, isNotNull, or, notInArray } from "drizzle-orm";

export async function GET(request: NextRequest) {
  // Verify the caller (e.g. EventBridge Scheduler) presents the shared secret
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Delete completed todos and subtasks (rows with parent_id) that were
  // completed more than 24 hours ago. Top-level recurring todos reset rather
  // than archive. Subtasks of recurring parents ride the parent's reset
  // cycle, so they're excluded too — otherwise they'd get nuked between
  // cycles and the recurring task would lose its subtasks.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recurringParentIds = db
    .select({ id: schema.todos.id })
    .from(schema.todos)
    .where(and(isNull(schema.todos.parentId), isNotNull(schema.todos.recurrence)));

  const deleted = await db
    .delete(schema.todos)
    .where(
      and(
        eq(schema.todos.completed, true),
        or(isNull(schema.todos.recurrence), isNotNull(schema.todos.parentId)),
        lt(schema.todos.updatedAt, cutoff),
        or(
          isNull(schema.todos.parentId),
          notInArray(schema.todos.parentId, recurringParentIds)
        )
      )
    )
    .returning({ id: schema.todos.id });

  // Also clean up old TOTP used codes (older than 5 minutes)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  await db
    .delete(schema.totpUsedCodes)
    .where(lt(schema.totpUsedCodes.usedAt, fiveMinAgo));

  // Clean up old failed login attempts (older than 24 hours)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await db
    .delete(schema.failedLoginAttempts)
    .where(lt(schema.failedLoginAttempts.attemptedAt, oneDayAgo));

  return NextResponse.json({
    success: true,
    deletedTodos: deleted.length,
    timestamp: new Date().toISOString(),
  });
}
