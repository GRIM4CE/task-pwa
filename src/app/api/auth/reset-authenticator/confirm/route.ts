import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { validateSession } from "@/lib/session";
import { verifyTotp } from "@/lib/totp";
import { generateRecoveryCode, hashRecoveryCode } from "@/lib/crypto";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const confirmSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
  encryptedSecret: z.string().min(1),
  encryptionIv: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const userAgent = request.headers.get("user-agent") ?? "unknown";

  const rateCheck = checkRateLimit(
    `reset-auth:${ip}`,
    RATE_LIMITS.setup.maxRequests,
    RATE_LIMITS.setup.windowMs
  );
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  const session = await validateSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof confirmSchema>;
  try {
    const raw = await request.json();
    body = confirmSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { valid } = verifyTotp(
    body.encryptedSecret,
    body.encryptionIv,
    body.totpCode
  );
  if (!valid) {
    return NextResponse.json(
      { error: "Invalid code. Please try again." },
      { status: 400 }
    );
  }

  // The whole rotation runs in a single transaction so we never end up with
  // a new TOTP secret persisted but no fresh recovery codes (or vice versa).
  // Other users' rows are untouched. Audit log stays outside the transaction
  // since a missing audit entry is not as bad as half-applied auth state.
  const recoveryCodes = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ userId: schema.totpSecrets.userId })
      .from(schema.totpSecrets)
      .where(eq(schema.totpSecrets.userId, session.user.id))
      .limit(1);

    if (existing.length > 0) {
      await tx
        .update(schema.totpSecrets)
        .set({
          encryptedSecret: body.encryptedSecret,
          encryptionIv: body.encryptionIv,
        })
        .where(eq(schema.totpSecrets.userId, session.user.id));
    } else {
      await tx.insert(schema.totpSecrets).values({
        userId: session.user.id,
        encryptedSecret: body.encryptedSecret,
        encryptionIv: body.encryptionIv,
      });
    }

    await tx
      .delete(schema.recoveryCodes)
      .where(eq(schema.recoveryCodes.userId, session.user.id));

    const codes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const code = generateRecoveryCode();
      codes.push(code);
      await tx.insert(schema.recoveryCodes).values({
        userId: session.user.id,
        codeHash: hashRecoveryCode(code),
      });
    }
    return codes;
  });

  await logAudit("totp_reset", {
    userId: session.user.id,
    ipAddress: ip,
    userAgent,
  });

  return NextResponse.json({
    success: true,
    recoveryCodes,
  });
}
