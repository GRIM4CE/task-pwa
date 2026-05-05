import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
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
    pinnedTo?: "day" | "week" | null;
    parentId?: string | null;
    autoReset?: boolean;
    kind?: "do" | "avoid";
    limitCount?: number | null;
    limitPeriod?: "week" | "month" | null;
    oncePerDay?: boolean;
    recordSlip?: boolean;
    undoLastSlip?: boolean;
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

  // Pin + recurrence rules: the only legal combo is weekly + Today (surfaces
  // a once-a-week task in the daily Today section). Daily + any pin is
  // redundant; weekly + week is redundant. Only reject when the patch is
  // actively asserting an invalid combination — explicitly setting a
  // recurrence on a pinned row, or explicitly pinning a recurring row.
  // Unrelated patches (title, completion, sort order) on a legacy
  // recurring+pinned row pass through so the data isn't stranded; the user
  // can clear the pin from the edit modal or via the row's pin control.
  const effectivePinned =
    body.pinnedTo !== undefined ? body.pinnedTo : existing[0].pinnedTo;
  const settingRecurring =
    body.recurrence !== undefined && body.recurrence !== null;
  // Only count the patch as "actively pinning" when it's changing the pin to
  // a non-null value. A no-op (body.pinnedTo equals the persisted value) lets
  // unrelated edits on a legacy recurring+pinned row save without tripping the
  // guard — the modal always includes `pinnedTo` in its payload.
  const settingPin =
    body.pinnedTo !== undefined &&
    body.pinnedTo !== null &&
    body.pinnedTo !== existing[0].pinnedTo;
  const isAllowedRecurrencePinCombo =
    effectiveRecurrence === null ||
    effectivePinned === null ||
    (effectiveRecurrence === "weekly" && effectivePinned === "day");
  if (
    !isAllowedRecurrencePinCombo &&
    ((settingRecurring && effectivePinned !== null) ||
      (settingPin && effectiveRecurrence !== null))
  ) {
    return NextResponse.json(
      { error: "Only weekly recurring todos can be pinned to Today" },
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
  if (effectiveKind === "avoid" && effectivePinned !== null) {
    return NextResponse.json(
      { error: "Avoid todos cannot be pinned" },
      { status: 400 }
    );
  }
  // Slip operations require BOTH the persisted row and the post-patch shape
  // to be avoid. The persisted check rules out `{ kind: "avoid",
  // recordSlip: true }` on a do row (slip insert is gated on `current.kind`,
  // would silently no-op). The post-patch check rules out `{ kind: "do",
  // recordSlip: true }` on an avoid row (slip would be inserted while the
  // row's kind is being flipped to do, leaving an orphaned event).
  if (
    (body.recordSlip === true || body.undoLastSlip === true) &&
    (existing[0].kind !== "avoid" || effectiveKind !== "avoid")
  ) {
    return NextResponse.json(
      { error: "Slip operations only apply to avoid todos" },
      { status: 400 }
    );
  }
  // limit + once-per-day fields are only meaningful for avoid todos. If the
  // patch sets them on a non-avoid row (or a row being switched to "do" in
  // the same patch), reject rather than silently dropping them.
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
    if (body.oncePerDay === true) {
      return NextResponse.json(
        { error: "Once-per-day only applies to avoid todos" },
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
  if (body.pinnedTo !== undefined) updateData.pinnedTo = body.pinnedTo;
  if (body.kind !== undefined) updateData.kind = body.kind;
  if (body.limitCount !== undefined) updateData.limitCount = body.limitCount;
  if (body.limitPeriod !== undefined) updateData.limitPeriod = body.limitPeriod;
  if (body.oncePerDay !== undefined) updateData.oncePerDay = body.oncePerDay;
  // Switching kind away from avoid drops any stale avoid-only fields so they
  // don't linger as dead config on a non-avoid row.
  if (body.kind === "do") {
    updateData.limitCount = null;
    updateData.limitPeriod = null;
    updateData.oncePerDay = false;
  }
  if (body.completed !== undefined) {
    updateData.completed = body.completed;
    updateData.lastCompletedAt = body.completed ? now : null;
    // Pinning is meant for "open work this period"; clear it on completion so
    // unchecking later doesn't resurrect the pin. Recurring rows are an
    // exception — their completion is a per-period tick, not a final close,
    // and clearing the pin would force the user to re-pin after every reset.
    if (body.completed && existing[0].recurrence === null) {
      updateData.pinnedTo = null;
    }
  }
  // Server-side oncePerDay enforcement: when the row carries oncePerDay, a
  // recordSlip is suppressed if any slip exists in the prior 24h. The client's
  // disabled button uses local-calendar-day boundaries; we use a 24h rolling
  // window here because the server doesn't know the user's timezone. That's
  // strictly stricter — the only edge case is multi-device usage near a daily
  // boundary, where a legitimate slip on a new calendar day might land within
  // 24h of the previous one and get suppressed. Acceptable for a single-user
  // app. The check happens before the transaction; any race with a concurrent
  // insert is bounded to one extra slip, which the client can still undo.
  let suppressSlipForOncePerDay = false;
  if (
    body.recordSlip === true &&
    existing[0].kind === "avoid" &&
    existing[0].oncePerDay
  ) {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentSlip = await db
      .select({ id: schema.todoCompletions.id })
      .from(schema.todoCompletions)
      .where(
        and(
          eq(schema.todoCompletions.todoId, id),
          eq(schema.todoCompletions.userId, session.user.id),
          gte(schema.todoCompletions.completedAt, oneDayAgo)
        )
      )
      .limit(1);
    if (recentSlip.length > 0) suppressSlipForOncePerDay = true;
  }

  // recordSlip touches lastCompletedAt for "days since last slip" but doesn't
  // flip `completed` — avoid-todos stay in the active list so the next slip
  // can be logged. Skip the bump when oncePerDay suppresses the slip so the
  // row's state stays in sync with the (unwritten) completion log.
  if (body.recordSlip === true && !suppressSlipForOncePerDay) {
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
          pinnedTo: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.todos.parentId, id),
            eq(schema.todos.completed, false)
          )
        );
    }

    // Avoid todos: each slip is recorded as a completion event so analytics
    // can compute calendar-window slip counts and streak gaps. The row's
    // `completed` flag stays false — it's not a "done" event, just a tally.
    // Suppressed for oncePerDay rows that already slipped in the last 24h,
    // see the pre-transaction comment above.
    if (
      body.recordSlip === true &&
      current.kind === "avoid" &&
      !suppressSlipForOncePerDay
    ) {
      await tx.insert(schema.todoCompletions).values({
        todoId: row.id,
        userId: session.user.id,
        completedAt: now,
      });
    }

    // Undo the most recent slip: drop the latest event for this todo+user
    // and rebase lastCompletedAt onto whatever the new latest event is (or
    // null if none remain). The lastCompletedAt rebase is what makes the
    // days-since badge return to the prior streak after an undo.
    if (body.undoLastSlip === true && current.kind === "avoid") {
      const latest = await tx
        .select({
          id: schema.todoCompletions.id,
          completedAt: schema.todoCompletions.completedAt,
        })
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
        const [nextLatest] = await tx
          .select({ completedAt: schema.todoCompletions.completedAt })
          .from(schema.todoCompletions)
          .where(
            and(
              eq(schema.todoCompletions.todoId, row.id),
              eq(schema.todoCompletions.userId, session.user.id)
            )
          )
          .orderBy(desc(schema.todoCompletions.completedAt))
          .limit(1);
        const nextLastCompletedAt = nextLatest?.completedAt ?? null;
        await tx
          .update(schema.todos)
          .set({
            lastCompletedAt: nextLastCompletedAt,
            updatedAt: now,
          })
          .where(eq(schema.todos.id, row.id));
        // Reflect in the row we return so the response and the recentSlips
        // refetch below both see the post-undo state.
        row.lastCompletedAt = nextLastCompletedAt;
      }
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

  // Refetch the 35-day slip window so the client can recompute the card's
  // calendar-window warning state without a separate /api/todos round-trip
  // after a slip is logged/undone (or after kind/limit fields change).
  let recentSlips: number[] = [];
  if (updated.kind === "avoid") {
    const slipCutoff = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    const slips = await db
      .select({ completedAt: schema.todoCompletions.completedAt })
      .from(schema.todoCompletions)
      .where(
        and(
          eq(schema.todoCompletions.todoId, updated.id),
          eq(schema.todoCompletions.userId, session.user.id),
          gte(schema.todoCompletions.completedAt, slipCutoff)
        )
      )
      // Match the GET /api/todos ordering so clients see a consistent shape:
      // ascending by completedAt, latest at the end of the array.
      .orderBy(asc(schema.todoCompletions.completedAt));
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
    pinnedTo: updated.pinnedTo,
    kind: updated.kind,
    limitCount: updated.limitCount,
    limitPeriod: updated.limitPeriod,
    oncePerDay: updated.oncePerDay,
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
