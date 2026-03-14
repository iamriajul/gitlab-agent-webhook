import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AppDatabase, createDatabase } from "../../src/db/database.ts";

const migrationSqlPath = join(
  process.cwd(),
  "src",
  "db",
  "migrations",
  "0000_colorful_yellowjacket.sql",
);

export function createMigratedDatabase(path: string): AppDatabase {
  const sqlite = new Database(path);
  const migrationSql = readFileSync(migrationSqlPath, "utf8");
  sqlite.exec(migrationSql);
  sqlite.close();

  return createDatabase(path);
}
