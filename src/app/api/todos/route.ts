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

  // Non-recurring completed todos are kept in the DB so the archive can show
  // them, but are hidden from the main list 24h after completion. Subtasks of
  // recurring parents are exempt from that cutoff because they ride the
  // parent's reset cycle and need to remain visible across it.
  const recentCompletedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recurringParentIds = db
    .select({ id: schema.todos.id })
    .from(schema.todos)
    .where(and(isNull(schema.todos.parentId), isNotNull(schema.todos.recurrence)));

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
      pinnedToWeek: schema.todos.pinnedToWeek,
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
          inArray(schema.todos.parentId, recurringParentIds)
        )
      )
    )
    .orderBy(asc(schema.todos.sortOrder), desc(schema.todos.createdAt));

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
      pinnedToWeek: t.pinnedToWeek,
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
    pinnedToWeek?: boolean;
    parentId?: string | null;
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

  const [todo] = await db
    .insert(schema.todos)
    .values({
      userId: session.user.id,
      parentId: parentRow?.id ?? null,
      title: body.title,
      description: body.description ?? null,
      isPersonal: parentRow ? parentRow.isPersonal : (body.isPersonal ?? false),
      recurrence: parentRow ? null : (body.recurrence ?? null),
      pinnedToWeek: body.pinnedToWeek ?? false,
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
      pinnedToWeek: todo.pinnedToWeek,
      lastCompletedAt: todo.lastCompletedAt ? todo.lastCompletedAt.getTime() : null,
      createdAt: todo.createdAt.getTime(),
      updatedAt: todo.updatedAt.getTime(),
      createdBy: session.user.username,
    },
    { status: 201 }
  );
}
