import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { validateSession } from "@/lib/session";
import { sql } from "drizzle-orm";

export async function GET() {
  // Check if any user exists (needs setup?)
  const userCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.users);

  const needsSetup = (userCount[0]?.count ?? 0) === 0;

  if (needsSetup) {
    return NextResponse.json({
      isAuthenticated: false,
      user: null,
      needsSetup: true,
    });
  }

  // Check current session
  const result = await validateSession();
  if (!result) {
    return NextResponse.json({
      isAuthenticated: false,
      user: null,
      needsSetup: false,
    });
  }

  return NextResponse.json({
    isAuthenticated: true,
    user: {
      id: result.user.id,
      username: result.user.username,
      createdAt: result.user.createdAt.getTime(),
      updatedAt: result.user.updatedAt.getTime(),
    },
    needsSetup: false,
  });
}
