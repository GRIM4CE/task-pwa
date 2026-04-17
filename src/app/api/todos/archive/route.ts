import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, desc, or, isNull } from "drizzle-orm";
import { validateSession } from "@/lib/session";

export async function GET() {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const todoList = await db
    .select({
      id: schema.todos.id,
      title: schema.todos.title,
      description: schema.todos.description,
      completed: schema.todos.completed,
      isPersonal: schema.todos.isPersonal,
      sortOrder: schema.todos.sortOrder,
      recurrence: schema.todos.recurrence,
      lastCompletedAt: schema.todos.lastCompletedAt,
      createdAt: schema.todos.createdAt,
      updatedAt: schema.todos.updatedAt,
      createdBy: schema.users.username,
    })
    .from(schema.todos)
    .innerJoin(schema.users, eq(schema.todos.userId, schema.users.id))
    .where(
      and(
        eq(schema.todos.completed, true),
        isNull(schema.todos.recurrence),
        or(
          eq(schema.todos.isPersonal, false),
          and(eq(schema.todos.isPersonal, true), eq(schema.todos.userId, session.user.id))
        )
      )
    )
    .orderBy(desc(schema.todos.lastCompletedAt));

  return NextResponse.json(
    todoList.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      completed: t.completed,
      isPersonal: t.isPersonal,
      sortOrder: t.sortOrder,
      recurrence: t.recurrence,
      lastCompletedAt: t.lastCompletedAt ? t.lastCompletedAt.getTime() : null,
      createdAt: t.createdAt.getTime(),
      updatedAt: t.updatedAt.getTime(),
      createdBy: t.createdBy,
    }))
  );
}
