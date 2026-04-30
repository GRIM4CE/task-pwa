import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { validateSession } from "@/lib/session";
import type { ArchiveItem } from "@/lib/api-client";

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
          and(
            eq(schema.todos.isPersonal, true),
            eq(schema.todos.userId, session.user.id)
          )
        )
      )
    );

  const subtaskList = await db
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
      parentTitle: schema.todos.title,
    })
    .from(schema.subtasks)
    .innerJoin(schema.users, eq(schema.subtasks.userId, schema.users.id))
    .innerJoin(schema.todos, eq(schema.subtasks.parentId, schema.todos.id))
    .where(
      and(
        eq(schema.subtasks.completed, true),
        // Privacy is enforced in SQL (not in JS) so the DB doesn't return rows
        // belonging to other users' personal todos in the first place.
        or(
          eq(schema.todos.isPersonal, false),
          and(
            eq(schema.todos.isPersonal, true),
            eq(schema.todos.userId, session.user.id)
          )
        )
      )
    );

  const items: ArchiveItem[] = [
    ...todoList.map<ArchiveItem>((t) => ({
      kind: "todo",
      data: {
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
    ...subtaskList.map<ArchiveItem>((s) => ({
      kind: "subtask",
      parentTitle: s.parentTitle,
      data: {
        id: s.id,
        parentId: s.parentId,
        title: s.title,
        description: s.description,
        completed: s.completed,
        isPersonal: s.isPersonal,
        pinnedToWeek: s.pinnedToWeek,
        sortOrder: s.sortOrder,
        lastCompletedAt: s.lastCompletedAt
          ? s.lastCompletedAt.getTime()
          : null,
        createdAt: s.createdAt.getTime(),
        updatedAt: s.updatedAt.getTime(),
        createdBy: s.createdBy,
      },
    })),
  ].sort(
    (a, b) => (b.data.lastCompletedAt ?? 0) - (a.data.lastCompletedAt ?? 0)
  );

  return NextResponse.json({ items });
}
