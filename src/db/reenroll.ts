// Emergency re-enrollment for a locked-out user. Wipes only that user's TOTP
// secret, recovery codes, used-code rows, and failed-attempt entries — leaves
// the user row, their todos, and other users untouched. Prints a fresh
// otpauth URI plus 8 new recovery codes.
//
// Usage:
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... APP_SECRET=... \
//     npm run auth:reenroll -- <username>

import { mkdirSync } from "fs";
import { dirname } from "path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { generateTotpSecret } from "../lib/totp";
import { generateRecoveryCode, hashRecoveryCode } from "../lib/crypto";

const rawUsername = process.argv[2];
if (!rawUsername) {
  console.error("Usage: npm run auth:reenroll -- <username>");
  process.exit(1);
}
const username = rawUsername.trim().toLowerCase();

const url = process.env.TURSO_DATABASE_URL ?? "file:./data/local.db";
if (url.startsWith("file:")) {
  mkdirSync(dirname(url.slice("file:".length)), { recursive: true });
}

const client = createClient({
  url,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const db = drizzle(client, { schema });

async function main() {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);

  if (!user) {
    console.error(`User '${username}' not found.`);
    process.exit(1);
  }

  const { secret, uri, encryptedSecret, encryptionIv } = generateTotpSecret(
    user.username
  );

  const recoveryCodes: string[] = [];
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.totpSecrets)
      .where(eq(schema.totpSecrets.userId, user.id));
    await tx.insert(schema.totpSecrets).values({
      userId: user.id,
      encryptedSecret,
      encryptionIv,
    });

    await tx
      .delete(schema.recoveryCodes)
      .where(eq(schema.recoveryCodes.userId, user.id));
    for (let i = 0; i < 8; i++) {
      const code = generateRecoveryCode();
      recoveryCodes.push(code);
      await tx.insert(schema.recoveryCodes).values({
        userId: user.id,
        codeHash: hashRecoveryCode(code),
      });
    }

    await tx
      .delete(schema.totpUsedCodes)
      .where(eq(schema.totpUsedCodes.userId, user.id));
    await tx
      .delete(schema.failedLoginAttempts)
      .where(eq(schema.failedLoginAttempts.usernameAttempted, user.username));
  });

  console.log(`\nRe-enrolled '${user.username}'.\n`);
  console.log(`otpauth URI (paste into a QR generator, or use manual entry):`);
  console.log(`  ${uri}\n`);
  console.log(`Manual entry key: ${secret}\n`);
  console.log(`Recovery codes (each can be used once — save them now):`);
  for (const code of recoveryCodes) console.log(`  ${code}`);
  console.log();

  client.close();
}

main().catch((err) => {
  console.error("Re-enroll failed:", err);
  process.exit(1);
});
