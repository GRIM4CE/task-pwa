import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, asc, eq, gte, isNotNull, or } from "drizzle-orm";
import { validateSession } from "@/lib/session";

// Raw completion timestamps per recurring todo. The client computes
// week/month aggregates locally so the user's timezone (and locale week
// boundary) stays authoritative — same approach as the recurrence reset.
export async function GET() {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Pull at most ~120 days of history; weekly stats only need the current
  // calendar month, daily stats only the current week.
  const cutoff = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);

  const recurringTodos = await db
    .select({
      id: schema.todos.id,
      title: schema.todos.title,
      recurrence: schema.todos.recurrence,
      isPersonal: schema.todos.isPersonal,
      createdAt: schema.todos.createdAt,
    })
    .from(schema.todos)
    .where(
      and(
        isNotNull(schema.todos.recurrence),
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

  return NextResponse.json({
    todos: recurringTodos.map((t) => ({
      id: t.id,
      title: t.title,
      recurrence: t.recurrence as "daily" | "weekly",
      isPersonal: t.isPersonal,
      createdAt: t.createdAt.getTime(),
      completions: byTodo.get(t.id) ?? [],
    })),
  });
}
