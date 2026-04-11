import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { verifyTotp } from "@/lib/totp";
import { env } from "@/lib/env";
import { generateRecoveryCode, hashRecoveryCode } from "@/lib/crypto";
import { createSession } from "@/lib/session";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { sql } from "drizzle-orm";
import { z } from "zod";

const verifySetupSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
  encryptedSecret: z.string().min(1),
  encryptionIv: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const userAgent = request.headers.get("user-agent") ?? "unknown";

  // Rate limit
  const rateCheck = checkRateLimit(`setup:${ip}`, RATE_LIMITS.setup.maxRequests, RATE_LIMITS.setup.windowMs);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  // Check if user already exists
  const userCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.users);

  if ((userCount[0]?.count ?? 0) > 0) {
    return NextResponse.json(
      { error: "Setup already completed" },
      { status: 400 }
    );
  }

  // Parse and validate request body
  let body: z.infer<typeof verifySetupSchema>;
  try {
    const raw = await request.json();
    body = verifySetupSchema.parse(raw);
  } catch {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400 }
    );
  }

  // Verify the TOTP code against the encrypted secret
  const { valid } = verifyTotp(body.encryptedSecret, body.encryptionIv, body.totpCode);
  if (!valid) {
    return NextResponse.json(
      { error: "Invalid code. Please try again." },
      { status: 400 }
    );
  }

  // Create the user
  const username = env.appUsername;
  const [user] = await db.insert(schema.users).values({ username }).returning();

  // Store the TOTP secret
  await db.insert(schema.totpSecrets).values({
    userId: user.id,
    encryptedSecret: body.encryptedSecret,
    encryptionIv: body.encryptionIv,
  });

  // Generate recovery codes
  const recoveryCodes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const code = generateRecoveryCode();
    recoveryCodes.push(code);
    await db.insert(schema.recoveryCodes).values({
      userId: user.id,
      codeHash: hashRecoveryCode(code),
    });
  }

  // Create session
  await createSession(user.id, ip, userAgent);

  // Audit log
  await logAudit("totp_setup", { userId: user.id, ipAddress: ip, userAgent });

  return NextResponse.json({
    success: true,
    recoveryCodes,
    user: {
      id: user.id,
      username: user.username,
    },
  });
}
