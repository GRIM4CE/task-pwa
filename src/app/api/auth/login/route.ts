import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
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

  // Parse request
  let body: { username: string; totpCode: string };
  try {
    const raw = await request.json();
    body = loginSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  // Check account lockout (scoped to this username so one account's failures
  // can't lock another account on the same network)
  const lockout = await checkAccountLocked(ip, body.username);
  if (lockout.locked) {
    await logAudit("login_failed", {
      ipAddress: ip,
      userAgent,
      metadata: { reason: "account_locked", username: body.username },
    });
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
    await logAudit("login_failed", {
      ipAddress: ip,
      userAgent,
      metadata: { reason: "user_not_found" },
    });
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  const totpRecord = await db
    .select()
    .from(schema.totpSecrets)
    .where(eq(schema.totpSecrets.userId, user[0].id))
    .limit(1);

  if (totpRecord.length === 0) {
    await recordFailedAttempt(ip, body.username);
    await logAudit("login_failed", {
      userId: user[0].id,
      ipAddress: ip,
      userAgent,
      metadata: { reason: "no_totp_secret" },
    });
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

  // Replay protection is per-user: each account independently burns a code
  // for its 30s window. Two accounts that happen to share a secret today can
  // both still log in within the same window.
  try {
    await db.insert(schema.totpUsedCodes).values({
      userId: user[0].id,
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
  await clearFailedAttempts(ip, body.username);
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
