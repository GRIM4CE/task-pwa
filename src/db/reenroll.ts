// Emergency re-enrollment for a locked-out user, triggered as part of an
// Amplify build by setting REENROLL_USERNAME on the deployment's env vars.
// Writes only that user's totp_secrets, recovery_codes, totp_used_codes,
// and failed_login_attempts — leaves the user row, todos, and other users
// untouched. Prints a fresh otpauth URI plus 8 new recovery codes to the
// build log, then deliberately fails the build so leaving REENROLL_USERNAME
// set doesn't silently re-rotate the secret on every subsequent deploy.
//
// Recovery flow:
//   1. Set REENROLL_USERNAME=<username> in Amplify env vars and redeploy.
//   2. Read otpauth URI + recovery codes from the build log; build fails.
//   3. Unset REENROLL_USERNAME and redeploy. Normal build resumes.
//
// The DB writes are committed before the deliberate failure, so the previous
// deployment stays live and starts accepting the new authenticator immediately.

import { mkdirSync } from "fs";
import { dirname } from "path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { generateTotpSecret } from "../lib/totp";
import { decrypt, generateRecoveryCode, hashRecoveryCode } from "../lib/crypto";
import { env } from "../lib/env";
import { assertTursoConfiguredInHostedBuild } from "./build-env";

const rawUsername = process.env.REENROLL_USERNAME;
if (!rawUsername) {
  // No env var set: normal deploy. Exit cleanly so the build chain continues.
  process.exit(0);
}
const username = rawUsername.trim().toLowerCase();

// Run after the no-op exit above so a normal hosted deploy (REENROLL_USERNAME
// unset) doesn't fail this script just because Turso config is missing —
// migrate.ts already enforces that on the next build step. We only need to
// surface the guard here when the script is about to do Turso work.
assertTursoConfiguredInHostedBuild();

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
    client.close();
    process.exit(1);
  }

  // Probe APP_SECRET against the user's existing row before touching anything.
  // If APP_SECRET drifted from what the running app uses, encrypting a new
  // secret with it would persist bytes the app can't decrypt later — bricking
  // the account harder. Aborting here keeps the existing (possibly broken)
  // state recoverable.
  const [existingTotp] = await db
    .select()
    .from(schema.totpSecrets)
    .where(eq(schema.totpSecrets.userId, user.id))
    .limit(1);

  if (existingTotp) {
    try {
      decrypt(existingTotp.encryptedSecret, existingTotp.encryptionIv, env.appSecret);
    } catch {
      // decrypt() throws for two distinguishable-only-to-the-operator reasons:
      // (a) APP_SECRET drifted from what wrote the row, or (b) the ciphertext
      // itself is malformed. Default behavior is abort — overwriting on (a)
      // would brick the account further. Operators who have separately
      // confirmed APP_SECRET is correct can set REENROLL_FORCE=1 to overwrite
      // anyway, e.g. when recovering from row corruption.
      if (process.env.REENROLL_FORCE !== "1") {
        console.error(
          "Could not decrypt the existing TOTP row with the current APP_SECRET. " +
          "Possible causes: APP_SECRET drifted from the value the row was encrypted with, " +
          "or the ciphertext is corrupted. Aborting before any writes.\n" +
          "If you have confirmed APP_SECRET is correct (e.g. other accounts still log in), " +
          "set REENROLL_FORCE=1 to overwrite the row anyway and retry."
        );
        client.close();
        process.exit(1);
      }
      console.warn(
        "WARNING: existing TOTP row failed APP_SECRET probe; REENROLL_FORCE=1 set, proceeding."
      );
    }
  }

  const { secret, uri, encryptedSecret, encryptionIv } = generateTotpSecret(
    user.username
  );

  const recoveryCodes: string[] = [];
  await db.transaction(async (tx) => {
    if (existingTotp) {
      await tx
        .update(schema.totpSecrets)
        .set({ encryptedSecret, encryptionIv })
        .where(eq(schema.totpSecrets.userId, user.id));
    } else {
      await tx.insert(schema.totpSecrets).values({
        userId: user.id,
        encryptedSecret,
        encryptionIv,
      });
    }

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

    await tx.insert(schema.auditLog).values({
      userId: user.id,
      action: "totp_reset",
      ipAddress: "build-hook",
      metadata: JSON.stringify({ source: "reenroll-build-hook" }),
    });
  });

  console.log(`\nRe-enrolled '${user.username}'.\n`);
  console.log(`otpauth URI (paste into a QR generator, or use manual entry):`);
  console.log(`  ${uri}\n`);
  console.log(`Manual entry key: ${secret}\n`);
  console.log(`Recovery codes (each can be used once — save them now):`);
  for (const code of recoveryCodes) console.log(`  ${code}`);
  console.log();

  client.close();

  // Deliberate failure. The DB writes above are already committed; failing
  // here just stops `next build` from running so a stale REENROLL_USERNAME
  // can't silently re-trigger this on the next deploy.
  console.error(
    "\n*** Build intentionally aborted after re-enrollment. ***\n" +
    "*** Remove REENROLL_USERNAME from Amplify env vars and redeploy. ***\n" +
    "*** SECURITY: this build log now contains the new TOTP secret + recovery codes ***\n" +
    "*** in plaintext. Once you've copied them, delete this build run from the ***\n" +
    "*** Amplify console (Hosting → Deployments → ⋮ → Delete) so the second factor ***\n" +
    "*** isn't retained in long-lived log storage. ***\n"
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("Re-enroll failed:", err);
  process.exit(1);
});
