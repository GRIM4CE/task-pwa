import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, asc, desc } from "drizzle-orm";
import { validateSession } from "@/lib/session";
import { createTodoSchema } from "@/lib/validation";
import { sql } from "drizzle-orm";

export async function GET() {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const todoList = await db
    .select()
    .from(schema.todos)
    .where(eq(schema.todos.userId, session.user.id))
    .orderBy(asc(schema.todos.sortOrder), desc(schema.todos.createdAt));

  return NextResponse.json(
    todoList.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      completed: t.completed,
      sortOrder: t.sortOrder,
      createdAt: t.createdAt.getTime(),
      updatedAt: t.updatedAt.getTime(),
    }))
  );
}

export async function POST(request: NextRequest) {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { title: string; description?: string };
  try {
    const raw = await request.json();
    body = createTodoSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Get the next sort order
  const maxOrder = await db
    .select({ max: sql<number>`coalesce(max(sort_order), -1)` })
    .from(schema.todos)
    .where(eq(schema.todos.userId, session.user.id));

  const [todo] = await db
    .insert(schema.todos)
    .values({
      userId: session.user.id,
      title: body.title,
      description: body.description ?? null,
      sortOrder: (maxOrder[0]?.max ?? -1) + 1,
    })
    .returning();

  return NextResponse.json(
    {
      id: todo.id,
      title: todo.title,
      description: todo.description,
      completed: todo.completed,
      sortOrder: todo.sortOrder,
      createdAt: todo.createdAt.getTime(),
      updatedAt: todo.updatedAt.getTime(),
    },
    { status: 201 }
  );
}
