import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { validateSession } from "@/lib/session";
import { reorderTodosSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { ids: string[] };
  try {
    const raw = await request.json();
    body = reorderTodosSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const ids = Array.from(new Set(body.ids));
  if (ids.length !== body.ids.length) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const existing = await db
    .select()
    .from(schema.todos)
    .where(inArray(schema.todos.id, ids));

  if (existing.length !== ids.length) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Personal todos are only modifiable by their owner.
  for (const todo of existing) {
    if (todo.isPersonal && todo.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  // Reassign the existing sortOrder values (sorted ascending) onto the
  // provided ids in payload order. This preserves the positions of other
  // todos that weren't part of the reorder.
  const sortedValues = existing.map((t) => t.sortOrder).sort((a, b) => a - b);
  const now = new Date();

  for (let i = 0; i < ids.length; i++) {
    await db
      .update(schema.todos)
      .set({ sortOrder: sortedValues[i], updatedAt: now })
      .where(eq(schema.todos.id, ids[i]));
  }

  return NextResponse.json({ success: true });
}
