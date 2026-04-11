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

export async function checkAccountLocked(ipAddress: string): Promise<{
  locked: boolean;
  minutesRemaining: number;
}> {
  // Check attempts in the last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.failedLoginAttempts)
    .where(
      and(
        eq(schema.failedLoginAttempts.ipAddress, ipAddress),
        gt(schema.failedLoginAttempts.attemptedAt, oneDayAgo)
      )
    );

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
    .where(
      and(
        eq(schema.failedLoginAttempts.ipAddress, ipAddress),
        gt(schema.failedLoginAttempts.attemptedAt, lockoutStart)
      )
    );

  if ((recentAttempts[0]?.count ?? 0) >= applicableLockout.attempts) {
    return {
      locked: true,
      minutesRemaining: applicableLockout.lockoutMinutes,
    };
  }

  return { locked: false, minutesRemaining: 0 };
}

export async function clearFailedAttempts(ipAddress: string): Promise<void> {
  await db
    .delete(schema.failedLoginAttempts)
    .where(eq(schema.failedLoginAttempts.ipAddress, ipAddress));
}
