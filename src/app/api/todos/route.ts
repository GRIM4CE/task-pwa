import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, desc, lt, or } from "drizzle-orm";
import { validateSession } from "@/lib/session";
import { createTodoSchema } from "@/lib/validation";
import { sql } from "drizzle-orm";

export async function GET() {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Lazily evict completed todos older than 24h so they disappear even
  // between cron runs.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await db
    .delete(schema.todos)
    .where(
      and(eq(schema.todos.completed, true), lt(schema.todos.updatedAt, cutoff))
    );

  // Joined todos are visible to everyone; personal todos are visible only to their owner.
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
      or(
        eq(schema.todos.isPersonal, false),
        and(eq(schema.todos.isPersonal, true), eq(schema.todos.userId, session.user.id))
      )
    )
    .orderBy(desc(schema.todos.createdAt));

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
  };
  try {
    const raw = await request.json();
    body = createTodoSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Get the next sort order
  const maxOrder = await db
    .select({ max: sql<number>`coalesce(max(sort_order), -1)` })
    .from(schema.todos);

  const [todo] = await db
    .insert(schema.todos)
    .values({
      userId: session.user.id,
      title: body.title,
      description: body.description ?? null,
      isPersonal: body.isPersonal ?? false,
      recurrence: body.recurrence ?? null,
      sortOrder: (maxOrder[0]?.max ?? -1) + 1,
    })
    .returning();

  return NextResponse.json(
    {
      id: todo.id,
      title: todo.title,
      description: todo.description,
      completed: todo.completed,
      isPersonal: todo.isPersonal,
      sortOrder: todo.sortOrder,
      recurrence: todo.recurrence,
      lastCompletedAt: todo.lastCompletedAt ? todo.lastCompletedAt.getTime() : null,
      createdAt: todo.createdAt.getTime(),
      updatedAt: todo.updatedAt.getTime(),
      createdBy: session.user.username,
    },
    { status: 201 }
  );
}
