import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/lib/session";
import { generateTotpSecret } from "@/lib/totp";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import QRCode from "qrcode";

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";

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

  const { secret, uri, encryptedSecret, encryptionIv } = generateTotpSecret(
    session.user.username
  );

  const qrCodeUrl = await QRCode.toDataURL(uri, {
    width: 256,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });

  return NextResponse.json({
    qrCodeUrl,
    manualEntryKey: secret,
    encryptedSecret,
    encryptionIv,
  });
}
