import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  agentType: text("agent_type").notNull(),
  agentSessionId: text("agent_session_id"),
  contextKind: text("context_kind").notNull(),
  contextProject: text("context_project").notNull(),
  contextIid: integer("context_iid").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  lastActivityAt: text("last_activity_at").notNull(),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
  status: text("status").notNull().default("pending"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  error: text("error"),
  retryCount: integer("retry_count").notNull().default(0),
});
