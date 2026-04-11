import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    // Verify DB connection works
    const result = db.select({ ok: sql<number>`1` }).from(schema.users).limit(0);
    return NextResponse.json({ status: "ok", timestamp: Date.now() });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: "Database unreachable" },
      { status: 503 }
    );
  }
}
