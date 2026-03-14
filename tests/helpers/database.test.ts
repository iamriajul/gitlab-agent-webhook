import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigratedDatabase } from "./database.ts";

function cleanupDatabase(path: string): void {
  const cleanupPaths = [path, `${path}-shm`, `${path}-wal`];

  for (const cleanupPath of cleanupPaths) {
    if (existsSync(cleanupPath)) {
      unlinkSync(cleanupPath);
    }
  }
}

describe("createMigratedDatabase", () => {
  it("tracks applied migrations using drizzle metadata", () => {
    const databasePath = join(
      tmpdir(),
      `glab-review-webhook-migrated-${crypto.randomUUID()}.sqlite`,
    );

    createMigratedDatabase(databasePath);

    const sqlite = new Database(databasePath, { readonly: true });
    const migrationTableRows = sqlite
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
      )
      .all();

    expect(migrationTableRows.length).toBe(1);

    sqlite.close();
    cleanupDatabase(databasePath);
  });
});
