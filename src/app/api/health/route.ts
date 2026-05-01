import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    // Round-trips to the DB so a connection failure surfaces as 503.
    await db.select({ ok: sql<number>`1` }).from(schema.users).limit(0);
    return NextResponse.json({ status: "ok", timestamp: Date.now() });
  } catch {
    return NextResponse.json(
      { status: "error", message: "Database unreachable" },
      { status: 503 }
    );
  }
}
