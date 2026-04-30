import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNotNull,
  not,
  or,
} from "drizzle-orm";
import { sql } from "drizzle-orm";
import { validateSession } from "@/lib/session";
import { createSubtaskSchema } from "@/lib/validation";

export async function GET() {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Subtasks are non-recurring — match the main todos list's 24h grace window
  // for completed items so they don't disappear immediately.
  const recentCompletedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Visibility flows through the parent: joined parents are visible to all,
  // personal parents only to their owner. Joining subtasks → todos in SQL
  // avoids preloading every parent id into a bound-parameter `IN (...)`,
  // which can blow past SQLite's ~999-parameter limit for heavy users.
  const rows = await db
    .select({
      id: schema.subtasks.id,
      parentId: schema.subtasks.parentId,
      title: schema.subtasks.title,
      description: schema.subtasks.description,
      completed: schema.subtasks.completed,
      isPersonal: schema.subtasks.isPersonal,
      sortOrder: schema.subtasks.sortOrder,
      pinnedToWeek: schema.subtasks.pinnedToWeek,
      lastCompletedAt: schema.subtasks.lastCompletedAt,
      createdAt: schema.subtasks.createdAt,
      updatedAt: schema.subtasks.updatedAt,
      createdBy: schema.users.username,
    })
    .from(schema.subtasks)
    .innerJoin(schema.todos, eq(schema.subtasks.parentId, schema.todos.id))
    .innerJoin(schema.users, eq(schema.subtasks.userId, schema.users.id))
    .where(
      and(
        or(
          eq(schema.todos.isPersonal, false),
          and(
            eq(schema.todos.isPersonal, true),
            eq(schema.todos.userId, session.user.id)
          )
        ),
        or(
          not(eq(schema.subtasks.completed, true)),
          and(
            eq(schema.subtasks.completed, true),
            isNotNull(schema.subtasks.lastCompletedAt),
            gte(schema.subtasks.lastCompletedAt, recentCompletedCutoff)
          )
        )
      )
    )
    .orderBy(asc(schema.subtasks.sortOrder), desc(schema.subtasks.createdAt));

  return NextResponse.json(
    rows.map((s) => ({
      id: s.id,
      parentId: s.parentId,
      title: s.title,
      description: s.description,
      completed: s.completed,
      isPersonal: s.isPersonal,
      sortOrder: s.sortOrder,
      pinnedToWeek: s.pinnedToWeek,
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

  // Personal parents are private to their owner — surface a 404 for everyone
  // else to avoid leaking existence.
  if (parent[0].isPersonal && parent[0].userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const maxOrder = await db
    .select({ max: sql<number>`coalesce(max(sort_order), -1)` })
    .from(schema.subtasks)
    .where(eq(schema.subtasks.parentId, body.parentId));

  const [created] = await db
    .insert(schema.subtasks)
    .values({
      parentId: body.parentId,
      // Subtasks are attributed to the actor, but inherit visibility from the
      // parent so they share scope (personal stays personal, joined stays joined).
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
      id: created.id,
      parentId: created.parentId,
      title: created.title,
      description: created.description,
      completed: created.completed,
      isPersonal: created.isPersonal,
      sortOrder: created.sortOrder,
      pinnedToWeek: created.pinnedToWeek,
      lastCompletedAt: created.lastCompletedAt ? created.lastCompletedAt.getTime() : null,
      createdAt: created.createdAt.getTime(),
      updatedAt: created.updatedAt.getTime(),
      createdBy: session.user.username,
    },
    { status: 201 }
  );
}
