import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { alias } from "drizzle-orm/sqlite-core";
import { and, eq, desc, or, isNull } from "drizzle-orm";
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

  // Pull subtasks + parent title in a single join. Subtasks inherit visibility
  // from their parent (joined → public, personal → owner-only); applying the
  // predicate against `todos` directly avoids preloading every visible parent
  // id into a bound-parameter list, which would blow past SQLite's ~999 cap
  // for heavy users.
  const parentTodos = alias(schema.todos, "parent_todos");
  const subtaskRows = await db
    .select({
      id: schema.subtasks.id,
      parentId: schema.subtasks.parentId,
      parentTitle: parentTodos.title,
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
    .innerJoin(parentTodos, eq(schema.subtasks.parentId, parentTodos.id))
    .innerJoin(schema.users, eq(schema.subtasks.userId, schema.users.id))
    .where(
      and(
        eq(schema.subtasks.completed, true),
        or(
          eq(parentTodos.isPersonal, false),
          and(
            eq(parentTodos.isPersonal, true),
            eq(parentTodos.userId, session.user.id)
          )
        )
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
      parentTitle: s.parentTitle,
    })),
  ].sort((a, b) => {
    const aTime = a.kind === "todo" ? a.todo.lastCompletedAt ?? 0 : a.subtask.lastCompletedAt ?? 0;
    const bTime = b.kind === "todo" ? b.todo.lastCompletedAt ?? 0 : b.subtask.lastCompletedAt ?? 0;
    return bTime - aTime;
  });

  return NextResponse.json({ items });
}
