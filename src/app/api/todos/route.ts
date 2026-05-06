import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, asc, eq, desc, gte, or, isNull, isNotNull, inArray, not } from "drizzle-orm";
import { validateSession } from "@/lib/session";
import { createTodoSchema } from "@/lib/validation";
import { sql } from "drizzle-orm";

export async function GET() {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Non-recurring completed top-level todos are kept in the DB so the archive
  // can show them, but are hidden from the main list 24h after completion.
  // Subtasks (any parent) are always returned regardless of completion age so
  // they remain visible under the parent — only their position in the
  // "Complete" section is governed by a 24h cutoff, applied client-side.
  // Avoid todos never have completed=true (slips are logged separately) so
  // they pass through this filter naturally.
  const recentCompletedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Joined todos are visible to everyone; personal todos are visible only to their owner.
  const todoList = await db
    .select({
      id: schema.todos.id,
      parentId: schema.todos.parentId,
      title: schema.todos.title,
      description: schema.todos.description,
      completed: schema.todos.completed,
      isPersonal: schema.todos.isPersonal,
      sortOrder: schema.todos.sortOrder,
      recurrence: schema.todos.recurrence,
      pinnedTo: schema.todos.pinnedTo,
      kind: schema.todos.kind,
      limitCount: schema.todos.limitCount,
      limitPeriod: schema.todos.limitPeriod,
      oncePerDay: schema.todos.oncePerDay,
      lastCompletedAt: schema.todos.lastCompletedAt,
      createdAt: schema.todos.createdAt,
      updatedAt: schema.todos.updatedAt,
      createdBy: schema.users.username,
    })
    .from(schema.todos)
    .innerJoin(schema.users, eq(schema.todos.userId, schema.users.id))
    .where(
      and(
        or(
          eq(schema.todos.isPersonal, false),
          and(eq(schema.todos.isPersonal, true), eq(schema.todos.userId, session.user.id))
        ),
        or(
          not(eq(schema.todos.completed, true)),
          isNotNull(schema.todos.recurrence),
          and(
            isNull(schema.todos.recurrence),
            gte(schema.todos.lastCompletedAt, recentCompletedCutoff)
          ),
          isNotNull(schema.todos.parentId)
        )
      )
    )
    .orderBy(asc(schema.todos.sortOrder), desc(schema.todos.createdAt));

  // Avoid-todos need a 35-day slip history so the card can compute its
  // calendar-window warning state locally without a /stats round-trip — long
  // enough to cover a 31-day month plus a small buffer.
  const avoidIds = todoList
    .filter((t) => t.kind === "avoid")
    .map((t) => t.id);
  const slipsByTodo = new Map<string, number[]>();
  if (avoidIds.length > 0) {
    const slipCutoff = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    const slips = await db
      .select({
        todoId: schema.todoCompletions.todoId,
        completedAt: schema.todoCompletions.completedAt,
      })
      .from(schema.todoCompletions)
      .where(
        and(
          eq(schema.todoCompletions.userId, session.user.id),
          inArray(schema.todoCompletions.todoId, avoidIds),
          gte(schema.todoCompletions.completedAt, slipCutoff)
        )
      )
      // Ascending so the latest slip is always at the end of each todo's
      // array. Lets clients identify "the most recent" by index without
      // re-sorting on every render.
      .orderBy(asc(schema.todoCompletions.completedAt));
    for (const s of slips) {
      const list = slipsByTodo.get(s.todoId) ?? [];
      list.push(s.completedAt.getTime());
      slipsByTodo.set(s.todoId, list);
    }
  }

  return NextResponse.json(
    todoList.map((t) => ({
      id: t.id,
      parentId: t.parentId,
      title: t.title,
      description: t.description,
      completed: t.completed,
      isPersonal: t.isPersonal,
      sortOrder: t.sortOrder,
      recurrence: t.recurrence,
      pinnedTo: t.pinnedTo,
      kind: t.kind,
      limitCount: t.limitCount,
      limitPeriod: t.limitPeriod,
      oncePerDay: t.oncePerDay,
      recentSlips:
        t.kind === "avoid" ? slipsByTodo.get(t.id) ?? [] : [],
      lastCompletedAt: t.lastCompletedAt ? t.lastCompletedAt.getTime() : null,
      createdAt: t.createdAt.getTime(),
      updatedAt: t.updatedAt.getTime(),
      createdBy: t.createdBy,
    }))
  );
}

export async function POST(request: NextRequest) {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    title: string;
    description?: string;
    isPersonal?: boolean;
    recurrence?: "daily" | "weekly" | null;
    pinnedTo?: "day" | "week" | null;
    parentId?: string | null;
    kind?: "do" | "avoid";
    limitCount?: number | null;
    limitPeriod?: "week" | "month" | null;
    oncePerDay?: boolean;
  };
  try {
    const raw = await request.json();
    body = createTodoSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // If a parent is supplied, the new row is a subtask: it must be ≤1 level deep
  // (the parent itself must be top-level), inherits isPersonal from the parent,
  // and gets sort_order scoped to that parent.
  let parentRow: typeof schema.todos.$inferSelect | null = null;
  if (body.parentId) {
    const rows = await db
      .select()
      .from(schema.todos)
      .where(eq(schema.todos.id, body.parentId))
      .limit(1);
    if (rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    parentRow = rows[0];
    if (parentRow.parentId !== null) {
      return NextResponse.json({ error: "Parent must be a top-level todo" }, { status: 400 });
    }
    if (parentRow.isPersonal && parentRow.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  const maxOrderRow = await db
    .select({ max: sql<number>`coalesce(max(sort_order), -1)` })
    .from(schema.todos)
    .where(
      parentRow
        ? eq(schema.todos.parentId, parentRow.id)
        : isNull(schema.todos.parentId)
    );
  const nextSortOrder = (maxOrderRow[0]?.max ?? -1) + 1;

  // Subtasks inherit isPersonal/recurrence/kind from the parent context: kind
  // collapses to "do" because avoid-todos can't have subtasks (validation
  // rejects parentId on avoid). limit fields are stripped for non-avoid rows.
  const kind = parentRow ? "do" : (body.kind ?? "do");
  const limitCount = kind === "avoid" ? body.limitCount ?? null : null;
  const limitPeriod = kind === "avoid" ? body.limitPeriod ?? null : null;
  const oncePerDay = kind === "avoid" ? body.oncePerDay ?? false : false;

  const [todo] = await db
    .insert(schema.todos)
    .values({
      userId: session.user.id,
      parentId: parentRow?.id ?? null,
      title: body.title,
      description: body.description ?? null,
      isPersonal: parentRow ? parentRow.isPersonal : (body.isPersonal ?? false),
      recurrence: parentRow ? null : (body.recurrence ?? null),
      pinnedTo: body.pinnedTo ?? null,
      kind,
      limitCount,
      limitPeriod,
      oncePerDay,
      sortOrder: nextSortOrder,
    })
    .returning();

  return NextResponse.json(
    {
      id: todo.id,
      parentId: todo.parentId,
      title: todo.title,
      description: todo.description,
      completed: todo.completed,
      isPersonal: todo.isPersonal,
      sortOrder: todo.sortOrder,
      recurrence: todo.recurrence,
      pinnedTo: todo.pinnedTo,
      kind: todo.kind,
      limitCount: todo.limitCount,
      limitPeriod: todo.limitPeriod,
      oncePerDay: todo.oncePerDay,
      recentSlips: [],
      lastCompletedAt: todo.lastCompletedAt ? todo.lastCompletedAt.getTime() : null,
      createdAt: todo.createdAt.getTime(),
      updatedAt: todo.updatedAt.getTime(),
      createdBy: session.user.username,
    },
    { status: 201 }
  );
}
