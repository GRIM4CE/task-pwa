import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, asc, eq, gte, isNotNull, isNull, or } from "drizzle-orm";
import { validateSession } from "@/lib/session";

// Raw completion timestamps per tracked todo (recurring + avoid). The client
// computes week/month/rolling-window aggregates locally so the user's timezone
// stays authoritative — same approach as the recurrence reset.
export async function GET() {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Pull at most ~120 days of history; weekly stats only need the current
  // calendar month, daily stats only the current week, monthly avoid windows
  // need the last 30 days.
  const cutoff = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);

  const trackedTodos = await db
    .select({
      id: schema.todos.id,
      title: schema.todos.title,
      recurrence: schema.todos.recurrence,
      kind: schema.todos.kind,
      limitCount: schema.todos.limitCount,
      limitPeriod: schema.todos.limitPeriod,
      oncePerDay: schema.todos.oncePerDay,
      isPersonal: schema.todos.isPersonal,
      createdAt: schema.todos.createdAt,
    })
    .from(schema.todos)
    .where(
      and(
        // Top-level only — current validation rejects avoid/recurring on
        // subtasks, but legacy rows could still slip through and pollute stats.
        isNull(schema.todos.parentId),
        or(
          isNotNull(schema.todos.recurrence),
          eq(schema.todos.kind, "avoid")
        ),
        or(
          eq(schema.todos.isPersonal, false),
          and(
            eq(schema.todos.isPersonal, true),
            eq(schema.todos.userId, session.user.id)
          )
        )
      )
    );

  // Stats are per-user: a joined todo can be completed by anyone, but each
  // user only sees their own completion history.
  const completions = await db
    .select({
      todoId: schema.todoCompletions.todoId,
      completedAt: schema.todoCompletions.completedAt,
    })
    .from(schema.todoCompletions)
    .where(
      and(
        eq(schema.todoCompletions.userId, session.user.id),
        gte(schema.todoCompletions.completedAt, cutoff)
      )
    )
    .orderBy(asc(schema.todoCompletions.completedAt));

  const byTodo = new Map<string, number[]>();
  for (const c of completions) {
    const list = byTodo.get(c.todoId) ?? [];
    list.push(c.completedAt.getTime());
    byTodo.set(c.todoId, list);
  }

  const recurring = trackedTodos.filter((t) => t.recurrence !== null);
  const avoid = trackedTodos.filter((t) => t.kind === "avoid");

  return NextResponse.json({
    todos: recurring.map((t) => ({
      id: t.id,
      title: t.title,
      recurrence: t.recurrence as "daily" | "weekly",
      isPersonal: t.isPersonal,
      createdAt: t.createdAt.getTime(),
      completions: byTodo.get(t.id) ?? [],
    })),
    avoid: avoid.map((t) => ({
      id: t.id,
      title: t.title,
      isPersonal: t.isPersonal,
      createdAt: t.createdAt.getTime(),
      limitCount: t.limitCount,
      limitPeriod: t.limitPeriod,
      oncePerDay: t.oncePerDay,
      completions: byTodo.get(t.id) ?? [],
    })),
  });
}
