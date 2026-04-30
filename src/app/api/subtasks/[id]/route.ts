import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { validateSession } from "@/lib/session";
import { updateSubtaskSchema } from "@/lib/validation";

async function loadSubtaskWithParent(id: string) {
  const rows = await db
    .select({
      subtask: schema.subtasks,
      parent: schema.todos,
    })
    .from(schema.subtasks)
    .innerJoin(schema.todos, eq(schema.subtasks.parentId, schema.todos.id))
    .where(eq(schema.subtasks.id, id))
    .limit(1);
  return rows[0] ?? null;
}

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
    pinnedToWeek?: boolean;
  };
  try {
    const raw = await request.json();
    body = updateSubtaskSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const existing = await loadSubtaskWithParent(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Personal-parent subtasks are visible only to the parent's owner.
  if (
    existing.parent.isPersonal &&
    existing.parent.userId !== session.user.id
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const now = new Date();
  const updateData: Record<string, unknown> = { updatedAt: now };
  if (body.title !== undefined) updateData.title = body.title;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;
  if (body.pinnedToWeek !== undefined) updateData.pinnedToWeek = body.pinnedToWeek;
  if (body.completed !== undefined) {
    updateData.completed = body.completed;
    updateData.lastCompletedAt = body.completed ? now : null;
    if (body.completed) updateData.pinnedToWeek = false;
  }

  const [updated] = await db
    .update(schema.subtasks)
    .set(updateData)
    .where(eq(schema.subtasks.id, id))
    .returning();

  const creator = await db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, updated.userId))
    .limit(1);

  return NextResponse.json({
    id: updated.id,
    parentId: updated.parentId,
    title: updated.title,
    description: updated.description,
    completed: updated.completed,
    isPersonal: updated.isPersonal,
    pinnedToWeek: updated.pinnedToWeek,
    sortOrder: updated.sortOrder,
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

  const existing = await loadSubtaskWithParent(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (
    existing.parent.isPersonal &&
    existing.parent.userId !== session.user.id
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.delete(schema.subtasks).where(eq(schema.subtasks.id, id));

  return NextResponse.json({ success: true });
}
