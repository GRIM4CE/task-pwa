import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, isNull } from "drizzle-orm";
import { verifyTotp } from "@/lib/totp";
import { createSession } from "@/lib/session";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { recordFailedAttempt, checkAccountLocked, clearFailedAttempts } from "@/lib/lockout";
import { loginSchema } from "@/lib/validation";

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

  // Check account lockout
  const lockout = await checkAccountLocked(ip);
  if (lockout.locked) {
    await logAudit("login_failed", {
      ipAddress: ip,
      userAgent,
      metadata: { reason: "account_locked" },
    });
    return NextResponse.json(
      { error: `Account temporarily locked. Try again in ${lockout.minutesRemaining} minutes.` },
      { status: 423 }
    );
  }

  // Parse request
  let body: { username: string; totpCode: string };
  try {
    const raw = await request.json();
    body = loginSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  // Find user
  const user = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, body.username))
    .limit(1);

  if (user.length === 0) {
    await recordFailedAttempt(ip, body.username);
    await logAudit("login_failed", {
      ipAddress: ip,
      userAgent,
      metadata: { reason: "user_not_found" },
    });
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  // Get TOTP secret
  const totpRecord = await db
    .select()
    .from(schema.totpSecrets)
    .where(eq(schema.totpSecrets.userId, user[0].id))
    .limit(1);

  if (totpRecord.length === 0) {
    await recordFailedAttempt(ip, body.username);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  // Verify TOTP code
  const { valid, timeStep } = verifyTotp(
    totpRecord[0].encryptedSecret,
    totpRecord[0].encryptionIv,
    body.totpCode
  );

  if (!valid) {
    await recordFailedAttempt(ip, body.username);
    await logAudit("login_failed", {
      userId: user[0].id,
      ipAddress: ip,
      userAgent,
      metadata: { reason: "invalid_totp" },
    });
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  // Check for replay attack (code already used in this time step)
  try {
    await db.insert(schema.totpUsedCodes).values({
      code: body.totpCode,
      timeStep,
    });
  } catch {
    // Unique constraint violation = replay attack
    await recordFailedAttempt(ip, body.username);
    await logAudit("login_failed", {
      userId: user[0].id,
      ipAddress: ip,
      userAgent,
      metadata: { reason: "totp_replay" },
    });
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  // Success - clear failed attempts and create session
  await clearFailedAttempts(ip);
  await createSession(user[0].id, ip, userAgent);

  await logAudit("login_success", {
    userId: user[0].id,
    ipAddress: ip,
    userAgent,
  });

  return NextResponse.json({
    success: true,
    user: {
      id: user[0].id,
      username: user[0].username,
    },
  });
}
