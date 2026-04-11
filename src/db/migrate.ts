import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL ?? "file:./data/local.db",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const db = drizzle(client);

async function main() {
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");
  client.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
