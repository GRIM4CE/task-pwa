import { mkdirSync } from "fs";
import { dirname } from "path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { sql } from "drizzle-orm";

const url = process.env.TURSO_DATABASE_URL ?? "file:./data/local.db";

if (url.startsWith("file:")) {
  mkdirSync(dirname(url.slice("file:".length)), { recursive: true });
}

const client = createClient({
  url,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const db = drizzle(client);

// Idempotent: pre-per-user-recovery-codes installs stored all 8 codes against
// the first APP_USERNAME entry. Recovery lookup is now user-scoped, so users
// without their own codes would lose recovery access. Copy the donor user's
// unused codes (with reset usedAt) for any user that has none.
async function backfillRecoveryCodes() {
  const users = await db.all<{ id: string; created_at: number }>(
    sql`SELECT id, created_at FROM users ORDER BY created_at ASC`
  );
  if (users.length < 2) return;

  const donorWithCodes = await db.all<{ id: string }>(sql`
    SELECT u.id FROM users u
    INNER JOIN recovery_codes rc ON rc.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at ASC
    LIMIT 1
  `);
  if (donorWithCodes.length === 0) return;
  const donorId = donorWithCodes[0].id;

  for (const user of users) {
    if (user.id === donorId) continue;
    const existing = await db.all<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id = ${user.id}`
    );
    if ((existing[0]?.count ?? 0) > 0) continue;

    const donorCodes = await db.all<{ code_hash: string }>(
      sql`SELECT code_hash FROM recovery_codes WHERE user_id = ${donorId} AND used_at IS NULL`
    );
    for (const row of donorCodes) {
      await db.run(sql`
        INSERT INTO recovery_codes (id, user_id, code_hash)
        VALUES (${crypto.randomUUID()}, ${user.id}, ${row.code_hash})
      `);
    }
    if (donorCodes.length > 0) {
      console.log(`Backfilled ${donorCodes.length} recovery codes for user ${user.id}`);
    }
  }
}

async function main() {
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");
  await backfillRecoveryCodes();
  client.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
