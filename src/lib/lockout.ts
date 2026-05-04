import { db, schema } from "@/db";
import { and, gt, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

const LOCKOUT_THRESHOLDS = [
  { attempts: 5, lockoutMinutes: 15 },
  { attempts: 10, lockoutMinutes: 60 },
  { attempts: 20, lockoutMinutes: 1440 }, // 24 hours
];

export async function recordFailedAttempt(
  ipAddress: string,
  username?: string
): Promise<void> {
  await db.insert(schema.failedLoginAttempts).values({
    ipAddress,
    usernameAttempted: username ?? null,
  });
}

// Lockout is scoped to (ip, username) so one account's typos can't lock out
// another account on the same network. Attempts against unknown usernames
// still get logged but only count toward that exact username's bucket.
export async function checkAccountLocked(
  ipAddress: string,
  username: string
): Promise<{
  locked: boolean;
  minutesRemaining: number;
}> {
  const scope = and(
    eq(schema.failedLoginAttempts.ipAddress, ipAddress),
    eq(schema.failedLoginAttempts.usernameAttempted, username)
  );

  // Check attempts in the last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.failedLoginAttempts)
    .where(and(scope, gt(schema.failedLoginAttempts.attemptedAt, oneDayAgo)));

  const attemptCount = result[0]?.count ?? 0;

  // Find the applicable lockout threshold (highest matching)
  let applicableLockout: (typeof LOCKOUT_THRESHOLDS)[number] | null = null;
  for (const threshold of LOCKOUT_THRESHOLDS) {
    if (attemptCount >= threshold.attempts) {
      applicableLockout = threshold;
    }
  }

  if (!applicableLockout) {
    return { locked: false, minutesRemaining: 0 };
  }

  // Check if the most recent attempt was within the lockout period
  const lockoutMs = applicableLockout.lockoutMinutes * 60 * 1000;
  const lockoutStart = new Date(Date.now() - lockoutMs);

  const recentAttempts = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.failedLoginAttempts)
    .where(and(scope, gt(schema.failedLoginAttempts.attemptedAt, lockoutStart)));

  if ((recentAttempts[0]?.count ?? 0) >= applicableLockout.attempts) {
    return {
      locked: true,
      minutesRemaining: applicableLockout.lockoutMinutes,
    };
  }

  return { locked: false, minutesRemaining: 0 };
}

export async function clearFailedAttempts(
  ipAddress: string,
  username: string
): Promise<void> {
  await db
    .delete(schema.failedLoginAttempts)
    .where(
      and(
        eq(schema.failedLoginAttempts.ipAddress, ipAddress),
        eq(schema.failedLoginAttempts.usernameAttempted, username)
      )
    );
}
