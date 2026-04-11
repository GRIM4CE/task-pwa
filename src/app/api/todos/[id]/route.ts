import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { validateSession } from "@/lib/session";
import { updateTodoSchema } from "@/lib/validation";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: { title?: string; description?: string | null; completed?: boolean; sortOrder?: number };
  try {
    const raw = await request.json();
    body = updateTodoSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const existing = await db
    .select()
    .from(schema.todos)
    .where(and(eq(schema.todos.id, id), eq(schema.todos.userId, session.user.id)))
    .limit(1);

  if (existing.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (body.title !== undefined) updateData.title = body.title;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.completed !== undefined) updateData.completed = body.completed;
  if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;

  const [updated] = await db
    .update(schema.todos)
    .set(updateData)
    .where(and(eq(schema.todos.id, id), eq(schema.todos.userId, session.user.id)))
    .returning();

  return NextResponse.json({
    id: updated.id,
    title: updated.title,
    description: updated.description,
    completed: updated.completed,
    sortOrder: updated.sortOrder,
    createdAt: updated.createdAt.getTime(),
    updatedAt: updated.updatedAt.getTime(),
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existing = await db
    .select()
    .from(schema.todos)
    .where(and(eq(schema.todos.id, id), eq(schema.todos.userId, session.user.id)))
    .limit(1);

  if (existing.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db
    .delete(schema.todos)
    .where(and(eq(schema.todos.id, id), eq(schema.todos.userId, session.user.id)));

  return NextResponse.json({ success: true });
}
