import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, isNull } from "drizzle-orm";
import { hashRecoveryCode } from "@/lib/crypto";
import { createSession } from "@/lib/session";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { recordFailedAttempt, checkAccountLocked, clearFailedAttempts } from "@/lib/lockout";
import { recoveryLoginSchema } from "@/lib/validation";

const GENERIC_ERROR = "Invalid credentials";

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const userAgent = request.headers.get("user-agent") ?? "unknown";

  // Rate limit
  const rateCheck = checkRateLimit(`login:${ip}`, RATE_LIMITS.login.maxRequests, RATE_LIMITS.login.windowMs);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  // Parse request
  let body: { username: string; recoveryCode: string };
  try {
    const raw = await request.json();
    body = recoveryLoginSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  // Check lockout (scoped to this username — see lockout.ts)
  const lockout = await checkAccountLocked(ip, body.username);
  if (lockout.locked) {
    return NextResponse.json(
      { error: `Account temporarily locked. Try again in ${lockout.minutesRemaining} minutes.` },
      { status: 423 }
    );
  }

  // Find user
  const user = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, body.username))
    .limit(1);

  if (user.length === 0) {
    await recordFailedAttempt(ip, body.username);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  // Recovery codes are per-user: a code only redeems for the account it was
  // issued to. (Pre-migration installs got their codes duplicated across
  // accounts in db:migrate so each user retains access.)
  const codeHash = hashRecoveryCode(body.recoveryCode);
  const recoveryRecord = await db
    .select()
    .from(schema.recoveryCodes)
    .where(
      and(
        eq(schema.recoveryCodes.codeHash, codeHash),
        eq(schema.recoveryCodes.userId, user[0].id),
        isNull(schema.recoveryCodes.usedAt)
      )
    )
    .limit(1);

  if (recoveryRecord.length === 0) {
    await recordFailedAttempt(ip, body.username);
    await logAudit("login_failed", {
      userId: user[0].id,
      ipAddress: ip,
      userAgent,
      metadata: { reason: "invalid_recovery_code" },
    });
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  // Mark recovery code as used
  await db
    .update(schema.recoveryCodes)
    .set({ usedAt: new Date() })
    .where(eq(schema.recoveryCodes.id, recoveryRecord[0].id));

  // Clear failed attempts and create session
  await clearFailedAttempts(ip, body.username);
  await createSession(user[0].id, ip, userAgent);

  await logAudit("recovery_code_used", {
    userId: user[0].id,
    ipAddress: ip,
    userAgent,
  });

  const remaining = await db
    .select()
    .from(schema.recoveryCodes)
    .where(
      and(
        eq(schema.recoveryCodes.userId, user[0].id),
        isNull(schema.recoveryCodes.usedAt)
      )
    );

  return NextResponse.json({
    success: true,
    remainingRecoveryCodes: remaining.length,
    user: {
      id: user[0].id,
      username: user[0].username,
    },
  });
}
