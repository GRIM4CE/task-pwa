import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { existsSync, mkdirSync } from "fs";
import path from "path";

// In production (Fly.io), use /data (persistent volume). Locally, use ./data.
const DB_PATH =
  process.env.NODE_ENV === "production"
    ? "/data/app.db"
    : path.join(process.cwd(), "data", "app.db");

// Lazy-init: avoid opening the DB at module import time during next build
// (Next.js spawns multiple workers that would all try to lock the DB file)
let _db: BetterSQLite3Database<typeof schema> | null = null;

function getDb(): BetterSQLite3Database<typeof schema> {
  if (!_db) {
    const dataDir = path.dirname(DB_PATH);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const sqlite = new Database(DB_PATH);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");

    _db = drizzle(sqlite, { schema });
  }
  return _db;
}

// Proxy that lazily initializes on first property access
export const db: BetterSQLite3Database<typeof schema> = new Proxy(
  {} as BetterSQLite3Database<typeof schema>,
  {
    get(_target, prop, receiver) {
      const realDb = getDb();
      const value = Reflect.get(realDb, prop, receiver);
      if (typeof value === "function") {
        return value.bind(realDb);
      }
      return value;
    },
  }
);

export { schema };
