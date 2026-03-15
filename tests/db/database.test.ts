import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/db/database.ts";

function cleanupDatabase(path: string): void {
  const cleanupPaths = [path, `${path}-shm`, `${path}-wal`];

  for (const cleanupPath of cleanupPaths) {
    if (existsSync(cleanupPath)) {
      unlinkSync(cleanupPath);
    }
  }
}

describe("createDatabase", () => {
  it("does not create application tables before migrations run", () => {
    const databasePath = join(tmpdir(), `glab-review-webhook-db-${crypto.randomUUID()}.sqlite`);

    createDatabase(databasePath);

    const sqlite = new Database(databasePath, { readonly: true });
    const tableRows = sqlite
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('jobs', 'sessions') ORDER BY name",
      )
      .all();

    expect(tableRows).toEqual([]);

    sqlite.close();
    cleanupDatabase(databasePath);
  });
});
