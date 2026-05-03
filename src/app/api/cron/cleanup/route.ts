import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, lt, isNull } from "drizzle-orm";

export async function GET(request: NextRequest) {
  // Verify the caller (e.g. EventBridge Scheduler) presents the shared secret
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Delete completed top-level non-recurring todos that were completed more
  // than 24 hours ago. Their subtasks ride along via ON DELETE CASCADE.
  // Subtasks themselves are intentionally not archived — a completed subtask
  // stays under its parent as a record of progress until the parent is
  // archived (or the user uncompletes/removes it). Recurring top-level todos
  // reset rather than archive, so they're excluded too.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const deleted = await db
    .delete(schema.todos)
    .where(
      and(
        eq(schema.todos.completed, true),
        isNull(schema.todos.parentId),
        isNull(schema.todos.recurrence),
        lt(schema.todos.updatedAt, cutoff)
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
