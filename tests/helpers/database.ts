import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { type AppDatabase, createDatabase } from "../../src/db/database.ts";

const migrationsFolder = join(process.cwd(), "src", "db", "migrations");

export function createMigratedDatabase(path: string): AppDatabase {
  const database = createDatabase(path);
  migrate(database, { migrationsFolder });

  return database;
}
