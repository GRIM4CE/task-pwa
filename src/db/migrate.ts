import { mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import { assertTursoConfiguredInHostedBuild } from "./build-env";

assertTursoConfiguredInHostedBuild();

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

// Belt-and-suspenders for drizzle-orm's libsql migrator: it decides what's
// pending by comparing each folder migration's `when` against the latest
// `created_at` row in `__drizzle_migrations`, which means a migration whose
// `when` happens to be ≤ the latest applied row (e.g., because an earlier
// migration was committed with a future-dated `when`) is silently skipped
// — no error, no warning, and prod stays on the prior schema. This is
// exactly how migration 0011 hid from Turso for a release cycle.
//
// After migrate() returns, walk every migration in the folder and confirm
// its hash is in `__drizzle_migrations`. Any miss is a silent skip; abort
// the build with the offending tags so the issue can't reach prod.
async function assertAllMigrationsApplied() {
  const expected = readMigrationFiles({ migrationsFolder: "./drizzle" });
  const applied = await db.all<{ hash: string }>(
    sql`SELECT hash FROM __drizzle_migrations`
  );
  const appliedHashes = new Set(applied.map((r) => r.hash));
  const missing = expected.filter((m) => !appliedHashes.has(m.hash));
  if (missing.length === 0) return;

  // The MigrationMeta returned by readMigrationFiles doesn't include the tag
  // (e.g. `0011_glamorous_terrax`). Read the journal directly so the error
  // points at the file the user has to edit, not just an opaque hash.
  let tagByWhen = new Map<number, string>();
  try {
    const journal = JSON.parse(
      readFileSync("./drizzle/meta/_journal.json", "utf8")
    ) as { entries: Array<{ when: number; tag: string }> };
    tagByWhen = new Map(journal.entries.map((e) => [e.when, e.tag]));
  } catch {
    // Best-effort: if the journal can't be read for some reason, fall back to
    // hash-only output below.
  }

  console.error(
    "Some folder migrations are NOT recorded in __drizzle_migrations on " +
      "the target DB. drizzle-orm's libsql migrator silently skips a " +
      "migration whose 'when' is ≤ the latest applied 'created_at', so " +
      "this usually means a journal timestamp is out of order. Bump the " +
      "offending migration's 'when' in drizzle/meta/_journal.json above " +
      "the max already-applied 'created_at', then redeploy."
  );
  for (const m of missing) {
    const tag = tagByWhen.get(m.folderMillis) ?? "(unknown tag)";
    console.error(
      `  - ${tag} (when=${m.folderMillis} / ` +
        `${new Date(m.folderMillis).toISOString()}, hash=${m.hash})`
    );
  }
  // Throw rather than process.exit(1) so the existing main().catch handler
  // runs after the await chain settles and the libsql client is closed in
  // the finally block — process.exit can truncate stderr buffering and
  // skip cleanup.
  throw new Error(
    `${missing.length} folder migration(s) not recorded on the target DB`
  );
}

async function main() {
  try {
    // Tag the log with the target DB so a silent fall-back to
    // file:./data/local.db (i.e. TURSO_DATABASE_URL not exposed to this
    // subprocess) is obvious in the build output instead of looking like a
    // successful Turso migration.
    const target = url.startsWith("file:") ? `local file (${url})` : "Turso";
    console.log(`Running migrations against ${target}...`);
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("Migrations complete.");
    // Sanity check: print the final applied-migration tag from
    // __drizzle_migrations so we can verify which migration the target DB is
    // actually on, independent of the migrations folder.
    try {
      const last = await db.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1`
      );
      if (last[0]) {
        console.log(
          `Latest applied migration hash on target: ${last[0].hash} ` +
          `(at ${new Date(Number(last[0].created_at)).toISOString()})`
        );
      }
    } catch (err) {
      console.warn("Could not read __drizzle_migrations:", err);
    }
    await assertAllMigrationsApplied();
    await backfillRecoveryCodes();
  } finally {
    // Close the client even if the assertion above threw, so the libsql
    // socket is released before the process exits.
    client.close();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
