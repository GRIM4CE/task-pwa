import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { validateSession } from "@/lib/session";

export async function GET() {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Top-level recurring todos reset rather than archive, so they're excluded.
  // Subtasks always archive (regardless of parent recurrence) so the user can
  // uncomplete them from the Completed view — they ride the parent's reset
  // cycle but the cleanup cron won't delete them, so showing them here is the
  // only way to undo an accidental check.
  const rows = await db
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
        eq(schema.todos.completed, true),
        or(
          isNull(schema.todos.recurrence),
          isNotNull(schema.todos.parentId)
        ),
        or(
          eq(schema.todos.isPersonal, false),
          and(
            eq(schema.todos.isPersonal, true),
            eq(schema.todos.userId, session.user.id)
          )
        )
      )
    );

  // Look up parent titles in a single follow-up query so we can attach
  // "↳ under {parent}" context to archived subtasks. Two short queries are
  // simpler than a self-join here.
  const parentIds = Array.from(
    new Set(rows.map((r) => r.parentId).filter((id): id is string => id !== null))
  );
  const parentTitles = new Map<string, string>();
  if (parentIds.length > 0) {
    const parents = await db
      .select({ id: schema.todos.id, title: schema.todos.title })
      .from(schema.todos)
      .where(inArray(schema.todos.id, parentIds));
    for (const p of parents) parentTitles.set(p.id, p.title);
  }

  const items = rows
    .map((t) => ({
      todo: {
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
      },
      parentTitle: t.parentId ? parentTitles.get(t.parentId) ?? null : null,
    }))
    .sort(
      (a, b) => (b.todo.lastCompletedAt ?? 0) - (a.todo.lastCompletedAt ?? 0)
    );

  return NextResponse.json({ items });
}
