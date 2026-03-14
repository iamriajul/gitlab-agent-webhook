import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";

const bootstrapSql = `
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY NOT NULL,
  payload text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  idempotency_key text NOT NULL,
  created_at text NOT NULL,
  started_at text,
  completed_at text,
  error text,
  retry_count integer DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_key_unique ON jobs (idempotency_key);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY NOT NULL,
  agent_type text NOT NULL,
  agent_session_id text,
  context_kind text NOT NULL,
  context_project text NOT NULL,
  context_iid integer NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  created_at text NOT NULL,
  last_activity_at text NOT NULL
);
`;

export function createDatabase(path: string) {
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(bootstrapSql);
  return drizzle(sqlite, { schema });
}

export type AppDatabase = ReturnType<typeof createDatabase>;
