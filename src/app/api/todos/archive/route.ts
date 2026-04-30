import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, desc, or, isNull, inArray } from "drizzle-orm";
import { validateSession } from "@/lib/session";
import type { ArchiveItem } from "@/lib/api-client";

export async function GET() {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const todoRows = await db
    .select({
      id: schema.todos.id,
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
        isNull(schema.todos.recurrence),
        or(
          eq(schema.todos.isPersonal, false),
          and(eq(schema.todos.isPersonal, true), eq(schema.todos.userId, session.user.id))
        )
      )
    )
    .orderBy(desc(schema.todos.lastCompletedAt));

  // Subtasks visible to the session user: parent is joined, or parent is
  // personal and owned by them. Subtasks inherit isPersonal from their parent
  // at creation time, so filtering on the subtask's own flag is enough.
  const visibleParents = await db
    .select({ id: schema.todos.id, title: schema.todos.title })
    .from(schema.todos)
    .where(
      or(
        eq(schema.todos.isPersonal, false),
        and(
          eq(schema.todos.isPersonal, true),
          eq(schema.todos.userId, session.user.id)
        )
      )
    );
  const parentIds = visibleParents.map((p) => p.id);
  const parentTitleById = new Map(visibleParents.map((p) => [p.id, p.title]));

  const subtaskRows =
    parentIds.length === 0
      ? []
      : await db
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
          .innerJoin(schema.users, eq(schema.subtasks.userId, schema.users.id))
          .where(
            and(
              eq(schema.subtasks.completed, true),
              inArray(schema.subtasks.parentId, parentIds)
            )
          )
          .orderBy(desc(schema.subtasks.lastCompletedAt));

  const items: ArchiveItem[] = [
    ...todoRows.map((t) => ({
      kind: "todo" as const,
      todo: {
        id: t.id,
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
    })),
    ...subtaskRows.map((s) => ({
      kind: "subtask" as const,
      subtask: {
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
      },
      parentTitle: parentTitleById.get(s.parentId) ?? "",
    })),
  ].sort((a, b) => {
    const aTime = a.kind === "todo" ? a.todo.lastCompletedAt ?? 0 : a.subtask.lastCompletedAt ?? 0;
    const bTime = b.kind === "todo" ? b.todo.lastCompletedAt ?? 0 : b.subtask.lastCompletedAt ?? 0;
    return bTime - aTime;
  });

  return NextResponse.json({ items });
}
