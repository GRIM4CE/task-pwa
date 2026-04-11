import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { generateTotpSecret } from "@/lib/totp";
import { env } from "@/lib/env";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
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

  // Check if users already exist - setup is one-time only
  const userCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.users);

  if ((userCount[0]?.count ?? 0) > 0) {
    return NextResponse.json(
      { error: "Setup already completed" },
      { status: 400 }
    );
  }

  // Generate TOTP secret (shared across all users)
  const label = env.appUsernames.join(" & ");
  const { secret, uri, encryptedSecret, encryptionIv } = generateTotpSecret(label);

  // Generate QR code as data URL
  const qrCodeUrl = await QRCode.toDataURL(uri, {
    width: 256,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });

  return NextResponse.json({
    qrCodeUrl,
    manualEntryKey: secret,
    usernames: env.appUsernames,
    encryptedSecret,
    encryptionIv,
  });
}
