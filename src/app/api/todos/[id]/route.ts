import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
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
    pinnedToWeek?: boolean;
    parentId?: string | null;
    autoReset?: boolean;
    kind?: "do" | "avoid";
    limitCount?: number | null;
    limitPeriod?: "week" | "month" | null;
    recordSlip?: boolean;
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

  // Reparenting requires extra validation: the only legal hierarchy is exactly
  // one level deep. So a row with children can't itself become a subtask, and a
  // new parent must be top-level. We also rebase isPersonal/sortOrder/recurrence.
  let reparentTo: typeof schema.todos.$inferSelect | null | undefined = undefined;
  if (body.parentId !== undefined && body.parentId !== existing[0].parentId) {
    if (body.parentId === null) {
      reparentTo = null;
    } else {
      if (body.parentId === id) {
        return NextResponse.json({ error: "Cannot parent to self" }, { status: 400 });
      }
      const childCount = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.todos)
        .where(eq(schema.todos.parentId, id));
      if ((childCount[0]?.n ?? 0) > 0) {
        return NextResponse.json(
          { error: "A todo with subtasks cannot itself become a subtask" },
          { status: 400 }
        );
      }
      const parentRows = await db
        .select()
        .from(schema.todos)
        .where(eq(schema.todos.id, body.parentId))
        .limit(1);
      if (parentRows.length === 0) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const parent = parentRows[0];
      if (parent.parentId !== null) {
        return NextResponse.json(
          { error: "Parent must be a top-level todo" },
          { status: 400 }
        );
      }
      if (parent.isPersonal && parent.userId !== session.user.id) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      if (parent.isPersonal !== existing[0].isPersonal) {
        return NextResponse.json(
          { error: "Cannot mix personal and joined" },
          { status: 400 }
        );
      }
      reparentTo = parent;
    }
  }

  // The "subtasks always have recurrence = null" invariant has to hold for
  // any patch — not just the demote path. Reject attempts to set a recurrence
  // on a row that's currently a subtask and isn't being promoted to top-level
  // in the same request.
  const willBeTopLevel =
    reparentTo === null ||
    (reparentTo === undefined && existing[0].parentId === null);
  if (
    body.recurrence !== undefined &&
    body.recurrence !== null &&
    !willBeTopLevel
  ) {
    return NextResponse.json(
      { error: "Subtasks cannot have recurrence" },
      { status: 400 }
    );
  }

  // Recurring todos can't be subtasks. Block demoting a row whose effective
  // recurrence (after this patch) is non-null. This used to silently wipe
  // recurrence on demote; now it's an explicit rejection.
  const effectiveRecurrence =
    body.recurrence !== undefined ? body.recurrence : existing[0].recurrence;
  if (reparentTo && effectiveRecurrence !== null) {
    return NextResponse.json(
      { error: "Recurring todos cannot be subtasks" },
      { status: 400 }
    );
  }

  // Recurring todos can't be pinned: daily ones are excluded from This Week,
  // and weekly ones already surface there by virtue of recurrence. Only reject
  // when the patch is actively asserting the invalid combination — explicitly
  // setting a recurrence on a pinned row, or explicitly pinning a recurring
  // row. Unrelated patches (title, completion, sort order) on a legacy
  // recurring+pinned row pass through so the data isn't stranded; the user can
  // clear the pin from the edit modal or via the row's pin control.
  const effectivePinned =
    body.pinnedToWeek !== undefined
      ? body.pinnedToWeek
      : existing[0].pinnedToWeek;
  const settingRecurring =
    body.recurrence !== undefined && body.recurrence !== null;
  const settingPin = body.pinnedToWeek === true;
  if (
    (settingRecurring && effectivePinned) ||
    (settingPin && effectiveRecurrence !== null)
  ) {
    return NextResponse.json(
      { error: "Recurring todos cannot be pinned" },
      { status: 400 }
    );
  }

  // Cross-field invariants involving the existing row state. The schema-level
  // refinements only see the request body — these need the persisted row to
  // know whether the patch's effective shape is legal.
  const effectiveKind: "do" | "avoid" =
    body.kind !== undefined ? body.kind : existing[0].kind;
  const effectiveParentId =
    reparentTo === undefined
      ? existing[0].parentId
      : reparentTo === null
        ? null
        : reparentTo.id;
  if (effectiveKind === "avoid" && effectiveParentId !== null) {
    return NextResponse.json(
      { error: "Avoid todos cannot be subtasks" },
      { status: 400 }
    );
  }
  if (effectiveKind === "avoid" && effectiveRecurrence !== null) {
    return NextResponse.json(
      { error: "Avoid todos cannot be recurring" },
      { status: 400 }
    );
  }
  // Require the persisted row to already be "avoid" — not just the post-patch
  // shape. Otherwise `{ kind: "avoid", recordSlip: true }` on a "do" row would
  // pass the effectiveKind check but the slip insert below (gated on
  // `current.kind`) would silently no-op, leaving lastCompletedAt advanced
  // without a logged event.
  if (body.recordSlip === true && existing[0].kind !== "avoid") {
    return NextResponse.json(
      { error: "Slips can only be recorded on avoid todos" },
      { status: 400 }
    );
  }
  // limit fields are only meaningful for avoid todos. If the patch sets them
  // on a non-avoid row (or a row being switched to "do" in the same patch),
  // reject rather than silently dropping them.
  if (effectiveKind !== "avoid") {
    if (
      (body.limitCount !== undefined && body.limitCount !== null) ||
      (body.limitPeriod !== undefined && body.limitPeriod !== null)
    ) {
      return NextResponse.json(
        { error: "Limits only apply to avoid todos" },
        { status: 400 }
      );
    }
  }

  const now = new Date();
  const updateData: Record<string, unknown> = { updatedAt: now };
  if (body.title !== undefined) updateData.title = body.title;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;
  if (body.recurrence !== undefined) updateData.recurrence = body.recurrence;
  if (body.pinnedToWeek !== undefined) updateData.pinnedToWeek = body.pinnedToWeek;
  if (body.kind !== undefined) updateData.kind = body.kind;
  if (body.limitCount !== undefined) updateData.limitCount = body.limitCount;
  if (body.limitPeriod !== undefined) updateData.limitPeriod = body.limitPeriod;
  // Switching kind away from avoid drops any stale limit fields so they don't
  // linger as dead config on a non-avoid row.
  if (body.kind === "do") {
    updateData.limitCount = null;
    updateData.limitPeriod = null;
  }
  if (body.completed !== undefined) {
    updateData.completed = body.completed;
    updateData.lastCompletedAt = body.completed ? now : null;
    // Pinning is meant for "this week's open work"; clear it on completion so
    // unchecking later doesn't resurrect the pin.
    if (body.completed) updateData.pinnedToWeek = false;
  }
  // recordSlip touches lastCompletedAt for "days since last slip" but doesn't
  // flip `completed` — avoid-todos stay in the active list so the next slip
  // can be logged.
  if (body.recordSlip === true) {
    updateData.lastCompletedAt = now;
  }

  if (reparentTo !== undefined) {
    updateData.parentId = reparentTo === null ? null : reparentTo.id;
    // Place the moved row at the end of its new sibling group.
    const maxOrderRow = await db
      .select({ max: sql<number>`coalesce(max(sort_order), -1)` })
      .from(schema.todos)
      .where(
        reparentTo === null
          ? isNull(schema.todos.parentId)
          : eq(schema.todos.parentId, reparentTo.id)
      );
    updateData.sortOrder = (maxOrderRow[0]?.max ?? -1) + 1;
  }

  // Wrap the parent update, subtask cascade, and analytics adjustment in a
  // single transaction so a crash between writes can't leave the row, its
  // subtasks, and the completion log out of sync. The completion read inside
  // the transaction is what makes the analytics adjustment race-safe: under
  // libSQL's serialized write transactions, two concurrent toggle requests
  // observe each other's committed state when deciding whether the completion
  // actually transitioned, so we never double-insert or double-delete events.
  const updated = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        completed: schema.todos.completed,
        recurrence: schema.todos.recurrence,
        kind: schema.todos.kind,
      })
      .from(schema.todos)
      .where(eq(schema.todos.id, id))
      .limit(1);

    if (!current) return null;

    const [row] = await tx
      .update(schema.todos)
      .set(updateData)
      .where(eq(schema.todos.id, id))
      .returning();

    const completedTransition = current.completed === false;
    const uncompletedTransition = current.completed === true;

    if (body.completed === true && completedTransition) {
      await tx
        .update(schema.todos)
        .set({
          completed: true,
          lastCompletedAt: now,
          pinnedToWeek: false,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.todos.parentId, id),
            eq(schema.todos.completed, false)
          )
        );
    }

    // Recurring parents: when the parent resets (manual uncomplete or the
    // client-driven midnight reset sending completed:false), the subtasks ride
    // along. Without this, completed subtasks would either linger past the
    // parent's reset or get nuked by the cleanup cron, leaving the recurring
    // task without its subtasks on the next cycle.
    if (
      body.completed === false &&
      uncompletedTransition &&
      current.recurrence !== null
    ) {
      await tx
        .update(schema.todos)
        .set({
          completed: false,
          lastCompletedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.todos.parentId, id),
            eq(schema.todos.completed, true)
          )
        );
    }

    // Avoid todos: each slip is recorded as a completion event so analytics
    // can compute rolling-window slip counts and streak gaps. The row's
    // `completed` flag stays false — it's not a "done" event, just a tally.
    if (body.recordSlip === true && current.kind === "avoid") {
      await tx.insert(schema.todoCompletions).values({
        todoId: row.id,
        userId: session.user.id,
        completedAt: now,
      });
    }

    // Only recurring todos surface in stats, so non-recurring completions
    // aren't logged. Attribution is to the actor (session user) — joined
    // todos are editable by anyone, and stats are per-user.
    if (
      body.completed === true &&
      completedTransition &&
      current.recurrence !== null
    ) {
      await tx.insert(schema.todoCompletions).values({
        todoId: row.id,
        userId: session.user.id,
        completedAt: now,
      });
    } else if (
      body.completed === false &&
      uncompletedTransition &&
      current.recurrence !== null &&
      body.autoReset !== true
    ) {
      // User-initiated undo of a same-period completion: drop the most recent
      // event so analytics don't keep counting the toggle. Auto-resets at the
      // next period boundary skip this so the prior period's tick stays
      // recorded as real history.
      const latest = await tx
        .select({ id: schema.todoCompletions.id })
        .from(schema.todoCompletions)
        .where(
          and(
            eq(schema.todoCompletions.todoId, row.id),
            eq(schema.todoCompletions.userId, session.user.id)
          )
        )
        .orderBy(desc(schema.todoCompletions.completedAt))
        .limit(1);
      if (latest[0]) {
        await tx
          .delete(schema.todoCompletions)
          .where(eq(schema.todoCompletions.id, latest[0].id));
      }
    }

    return row;
  });

  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const creator = await db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, updated.userId))
    .limit(1);

  // Refetch the 30-day slip window so the client can recompute the card's
  // warning state without a separate /api/todos round-trip after a slip is
  // logged (or after kind/limit fields change).
  let recentSlips: number[] = [];
  if (updated.kind === "avoid") {
    const slipCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const slips = await db
      .select({ completedAt: schema.todoCompletions.completedAt })
      .from(schema.todoCompletions)
      .where(
        and(
          eq(schema.todoCompletions.todoId, updated.id),
          eq(schema.todoCompletions.userId, session.user.id),
          gte(schema.todoCompletions.completedAt, slipCutoff)
        )
      );
    recentSlips = slips.map((s) => s.completedAt.getTime());
  }

  return NextResponse.json({
    id: updated.id,
    parentId: updated.parentId,
    title: updated.title,
    description: updated.description,
    completed: updated.completed,
    isPersonal: updated.isPersonal,
    sortOrder: updated.sortOrder,
    recurrence: updated.recurrence,
    pinnedToWeek: updated.pinnedToWeek,
    kind: updated.kind,
    limitCount: updated.limitCount,
    limitPeriod: updated.limitPeriod,
    recentSlips,
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
