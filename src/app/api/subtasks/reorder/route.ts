import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { validateSession } from "@/lib/session";
import { reorderSubtasksSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { parentId: string; ids: string[] };
  try {
    const raw = await request.json();
    body = reorderSubtasksSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const ids = Array.from(new Set(body.ids));
  if (ids.length !== body.ids.length) {
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

  if (parent[0].isPersonal && parent[0].userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const existing = await db
    .select()
    .from(schema.subtasks)
    .where(
      and(
        eq(schema.subtasks.parentId, body.parentId),
        inArray(schema.subtasks.id, ids)
      )
    );

  if (existing.length !== ids.length) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sortedValues = existing.map((s) => s.sortOrder).sort((a, b) => a - b);
  const now = new Date();

  for (let i = 0; i < ids.length; i++) {
    await db
      .update(schema.subtasks)
      .set({ sortOrder: sortedValues[i], updatedAt: now })
      .where(eq(schema.subtasks.id, ids[i]));
  }

  return NextResponse.json({ success: true });
}
