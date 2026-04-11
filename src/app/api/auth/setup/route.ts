import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { generateTotpSecret } from "@/lib/totp";
import { env } from "@/lib/env";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { sql } from "drizzle-orm";
import QRCode from "qrcode";

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";

  // Rate limit
  const rateCheck = checkRateLimit(`setup:${ip}`, RATE_LIMITS.setup.maxRequests, RATE_LIMITS.setup.windowMs);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  // Check if user already exists - setup is one-time only
  const userCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.users);

  if ((userCount[0]?.count ?? 0) > 0) {
    return NextResponse.json(
      { error: "Setup already completed" },
      { status: 400 }
    );
  }

  // Generate TOTP secret
  const username = env.appUsername;
  const { secret, uri, encryptedSecret, encryptionIv } = generateTotpSecret(username);

  // Generate QR code as data URL
  const qrCodeUrl = await QRCode.toDataURL(uri, {
    width: 256,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });

  // Store the pending setup in a temporary way - we'll finalize on verify
  // Using a server-side approach: store encrypted secret now, verify before creating user
  const setupToken = crypto.randomUUID();

  // Store in DB as a pending setup (we'll use the totp_secrets table with a placeholder user)
  // Actually, store in the response and have the client send it back during verify
  // This is safe because the secret is encrypted and the client can't decrypt it

  return NextResponse.json({
    qrCodeUrl,
    manualEntryKey: secret,
    setupToken,
    encryptedSecret,
    encryptionIv,
  });
}
