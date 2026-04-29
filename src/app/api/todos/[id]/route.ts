import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
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

  let body: {
    title?: string;
    description?: string | null;
    completed?: boolean;
    sortOrder?: number;
    recurrence?: "daily" | "weekly" | null;
  };
  try {
    const raw = await request.json();
    body = updateTodoSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const existing = await db
    .select()
    .from(schema.todos)
    .where(eq(schema.todos.id, id))
    .limit(1);

  if (existing.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Personal todos are only modifiable by their owner; they're also hidden from
  // non-owners, so surface a 404 rather than a 403 to avoid leaking existence.
  if (existing[0].isPersonal && existing[0].userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const now = new Date();
  const updateData: Record<string, unknown> = { updatedAt: now };
  if (body.title !== undefined) updateData.title = body.title;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;
  if (body.recurrence !== undefined) updateData.recurrence = body.recurrence;
  if (body.completed !== undefined) {
    updateData.completed = body.completed;
    updateData.lastCompletedAt = body.completed ? now : null;
  }

  const [updated] = await db
    .update(schema.todos)
    .set(updateData)
    .where(eq(schema.todos.id, id))
    .returning();

  // Record an immutable completion event so analytics can reconstruct history
  // even after a recurring todo resets and overwrites lastCompletedAt.
  if (body.completed === true && existing[0].completed === false) {
    await db.insert(schema.todoCompletions).values({
      todoId: updated.id,
      userId: updated.userId,
      completedAt: now,
    });
  }

  const creator = await db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, updated.userId))
    .limit(1);

  return NextResponse.json({
    id: updated.id,
    title: updated.title,
    description: updated.description,
    completed: updated.completed,
    isPersonal: updated.isPersonal,
    sortOrder: updated.sortOrder,
    recurrence: updated.recurrence,
    lastCompletedAt: updated.lastCompletedAt ? updated.lastCompletedAt.getTime() : null,
    createdAt: updated.createdAt.getTime(),
    updatedAt: updated.updatedAt.getTime(),
    createdBy: creator[0]?.username ?? "unknown",
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
    .where(eq(schema.todos.id, id))
    .limit(1);

  if (existing.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (existing[0].isPersonal && existing[0].userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.delete(schema.todos).where(eq(schema.todos.id, id));

  return NextResponse.json({ success: true });
}
