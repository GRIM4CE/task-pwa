import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, asc, desc, eq, gte, isNull, not, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { validateSession } from "@/lib/session";
import { createSubtaskSchema } from "@/lib/validation";

export async function GET() {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const recentCompletedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const list = await db
    .select({
      id: schema.subtasks.id,
      parentId: schema.subtasks.parentId,
      title: schema.subtasks.title,
      description: schema.subtasks.description,
      completed: schema.subtasks.completed,
      isPersonal: schema.subtasks.isPersonal,
      pinnedToWeek: schema.subtasks.pinnedToWeek,
      sortOrder: schema.subtasks.sortOrder,
      lastCompletedAt: schema.subtasks.lastCompletedAt,
      createdAt: schema.subtasks.createdAt,
      updatedAt: schema.subtasks.updatedAt,
      createdBy: schema.users.username,
    })
    .from(schema.subtasks)
    .innerJoin(schema.users, eq(schema.subtasks.userId, schema.users.id))
    .innerJoin(schema.todos, eq(schema.subtasks.parentId, schema.todos.id))
    .where(
      and(
        // Privacy filter mirrors /api/todos GET — driven by the parent's flag.
        or(
          eq(schema.todos.isPersonal, false),
          and(
            eq(schema.todos.isPersonal, true),
            eq(schema.todos.userId, session.user.id)
          )
        ),
        or(
          not(eq(schema.subtasks.completed, true)),
          gte(schema.subtasks.lastCompletedAt, recentCompletedCutoff),
          // Defensive: if a completed subtask somehow has a null timestamp,
          // surface it; the cleanup cron will sweep it.
          isNull(schema.subtasks.lastCompletedAt)
        )
      )
    )
    .orderBy(asc(schema.subtasks.sortOrder), desc(schema.subtasks.createdAt));

  return NextResponse.json(
    list.map((s) => ({
      id: s.id,
      parentId: s.parentId,
      title: s.title,
      description: s.description,
      completed: s.completed,
      isPersonal: s.isPersonal,
      pinnedToWeek: s.pinnedToWeek,
      sortOrder: s.sortOrder,
      lastCompletedAt: s.lastCompletedAt ? s.lastCompletedAt.getTime() : null,
      createdAt: s.createdAt.getTime(),
      updatedAt: s.updatedAt.getTime(),
      createdBy: s.createdBy,
    }))
  );
}

export async function POST(request: NextRequest) {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    parentId: string;
    title: string;
    description?: string;
    pinnedToWeek?: boolean;
  };
  try {
    const raw = await request.json();
    body = createSubtaskSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const parent = await db
    .select()
    .from(schema.todos)
    .where(eq(schema.todos.id, body.parentId))
    .limit(1);

  if (parent.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Personal todos are hidden from non-owners; surface a 404 to match.
  if (parent[0].isPersonal && parent[0].userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const maxOrder = await db
    .select({ max: sql<number>`coalesce(max(sort_order), -1)` })
    .from(schema.subtasks)
    .where(eq(schema.subtasks.parentId, body.parentId));

  const [subtask] = await db
    .insert(schema.subtasks)
    .values({
      parentId: body.parentId,
      userId: session.user.id,
      title: body.title,
      description: body.description ?? null,
      isPersonal: parent[0].isPersonal,
      pinnedToWeek: body.pinnedToWeek ?? false,
      sortOrder: (maxOrder[0]?.max ?? -1) + 1,
    })
    .returning();

  return NextResponse.json(
    {
      id: subtask.id,
      parentId: subtask.parentId,
      title: subtask.title,
      description: subtask.description,
      completed: subtask.completed,
      isPersonal: subtask.isPersonal,
      pinnedToWeek: subtask.pinnedToWeek,
      sortOrder: subtask.sortOrder,
      lastCompletedAt: subtask.lastCompletedAt
        ? subtask.lastCompletedAt.getTime()
        : null,
      createdAt: subtask.createdAt.getTime(),
      updatedAt: subtask.updatedAt.getTime(),
      createdBy: session.user.username,
    },
    { status: 201 }
  );
}
