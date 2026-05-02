import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { validateSession } from "@/lib/session";

// Returns the user's vacation history plus a flag for whether they're
// currently on vacation. The stats endpoint serves the same periods for
// analytics; this endpoint is the lighter-weight read used by the settings
// toggle and the optional /todos banner.
export async function GET() {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select({
      id: schema.vacations.id,
      startsAt: schema.vacations.startsAt,
      endsAt: schema.vacations.endsAt,
    })
    .from(schema.vacations)
    .where(eq(schema.vacations.userId, session.user.id))
    .orderBy(asc(schema.vacations.startsAt));

  const periods = rows.map((r) => ({
    id: r.id,
    startsAt: r.startsAt.getTime(),
    endsAt: r.endsAt ? r.endsAt.getTime() : null,
  }));
  const active = periods.find((p) => p.endsAt === null) ?? null;

  return NextResponse.json({ periods, active });
}

// Toggle the user's vacation state. Body: { action: "start" | "end" }.
// "start" inserts a new open-ended row (no-op if one already exists);
// "end" closes any currently-open row.
export async function POST(request: Request) {
  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let action: "start" | "end";
  try {
    const body = (await request.json()) as { action?: unknown };
    if (body.action !== "start" && body.action !== "end") {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    action = body.action;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const now = new Date();
  if (action === "start") {
    // The schema's partial unique index ensures at most one open row per
    // user, so two concurrent starts can race safely: the loser's insert
    // hits the constraint and we treat it as a no-op (the user is already
    // on vacation).
    try {
      await db.insert(schema.vacations).values({
        userId: session.user.id,
        startsAt: now,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!/UNIQUE|constraint/i.test(message)) throw e;
    }
  } else {
    // Close every open row in a single statement. Defensive against
    // historical data that predates the partial unique index.
    await db
      .update(schema.vacations)
      .set({ endsAt: now })
      .where(
        and(
          eq(schema.vacations.userId, session.user.id),
          isNull(schema.vacations.endsAt)
        )
      );
  }

  const rows = await db
    .select({
      id: schema.vacations.id,
      startsAt: schema.vacations.startsAt,
      endsAt: schema.vacations.endsAt,
    })
    .from(schema.vacations)
    .where(eq(schema.vacations.userId, session.user.id))
    .orderBy(asc(schema.vacations.startsAt));

  const periods = rows.map((r) => ({
    id: r.id,
    startsAt: r.startsAt.getTime(),
    endsAt: r.endsAt ? r.endsAt.getTime() : null,
  }));
  const active = periods.find((p) => p.endsAt === null) ?? null;
  return NextResponse.json({ periods, active });
}
