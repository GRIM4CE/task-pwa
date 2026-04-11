import { NextRequest, NextResponse } from "next/server";
import { destroySession, validateSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const userAgent = request.headers.get("user-agent") ?? "unknown";

  const sessionResult = await validateSession();
  if (sessionResult) {
    await logAudit("logout", {
      userId: sessionResult.user.id,
      ipAddress: ip,
      userAgent,
    });
  }

  await destroySession();

  return NextResponse.json({ success: true });
}
