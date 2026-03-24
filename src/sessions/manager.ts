import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "../db/database.ts";
import { sessions } from "../db/schema.ts";
import { type SessionId, sessionId } from "../types/branded.ts";
import { sessionError } from "../types/errors.ts";
import type { AgentKind } from "../types/events.ts";
import { err, fromThrowable, ok, type Result } from "../types/result.ts";

export type SessionContext =
  | { readonly kind: "issue"; readonly project: string; readonly issueIid: number }
  | { readonly kind: "mr"; readonly project: string; readonly mrIid: number }
  | { readonly kind: "mr_review"; readonly project: string; readonly mrIid: number };

export interface AgentSession {
  readonly id: SessionId;
  readonly agentType: AgentKind;
  readonly agentSessionId: string;
  readonly context: SessionContext;
  readonly status: "active" | "completed" | "failed";
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
}

const agentKindSchema = z.enum(["claude", "codex", "gemini"]);
const sessionStatusSchema = z.enum(["active", "completed", "failed"]);

const sessionContextSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("issue"),
    project: z.string(),
    issueIid: z.number().int(),
  }),
  z.object({
    kind: z.literal("mr"),
    project: z.string(),
    mrIid: z.number().int(),
  }),
  z.object({
    kind: z.literal("mr_review"),
    project: z.string(),
    mrIid: z.number().int(),
  }),
]);

export interface CreateSessionInput {
  readonly agentType: AgentKind;
  readonly agentSessionId: string;
  readonly context: SessionContext;
}

export interface SessionManager {
  create(input: CreateSessionInput): Result<AgentSession, ReturnType<typeof sessionError>>;
  findByContext(
    context: SessionContext,
    agentType?: AgentKind,
  ): Result<AgentSession | null, ReturnType<typeof sessionError>>;
  updateActivity(
    id: SessionId,
    agentSessionId?: string,
  ): Result<AgentSession, ReturnType<typeof sessionError>>;
  markFinalStatus(
    id: SessionId,
    status: "completed" | "failed",
  ): Result<AgentSession, ReturnType<typeof sessionError>>;
}

function formatUnknownError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }

  return String(cause);
}

function runDatabaseOperation<T>(operation: () => T): Result<T, ReturnType<typeof sessionError>> {
  return fromThrowable(operation, (cause) => sessionError(formatUnknownError(cause)))();
}

function contextIid(context: SessionContext): number {
  switch (context.kind) {
    case "issue":
      return context.issueIid;
    case "mr":
      return context.mrIid;
    case "mr_review":
      return context.mrIid;
  }
}

function parseSessionContext(
  kind: string,
  project: string,
  iid: number,
): Result<SessionContext, ReturnType<typeof sessionError>> {
  const parsedContext = sessionContextSchema.safeParse(
    kind === "issue" ? { kind, project, issueIid: iid } : { kind, project, mrIid: iid },
  );

  if (!parsedContext.success) {
    return err(sessionError(`Invalid stored session context: ${kind}`));
  }

  return ok(parsedContext.data);
}

function parseRequiredDate(value: string): Result<Date, ReturnType<typeof sessionError>> {
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    return err(sessionError(`Invalid stored date: ${value}`));
  }

  return ok(parsedDate);
}

type SessionRow = typeof sessions.$inferSelect;

function mapSession(row: SessionRow): Result<AgentSession, ReturnType<typeof sessionError>> {
  const parsedAgentKind = agentKindSchema.safeParse(row.agentType);
  if (!parsedAgentKind.success) {
    return err(sessionError(`Invalid stored agent kind: ${row.agentType}`));
  }

  const parsedStatus = sessionStatusSchema.safeParse(row.status);
  if (!parsedStatus.success) {
    return err(sessionError(`Invalid stored session status: ${row.status}`));
  }

  return parseSessionContext(row.contextKind, row.contextProject, row.contextIid).andThen(
    (context) =>
      parseRequiredDate(row.createdAt).andThen((createdAt) =>
        parseRequiredDate(row.lastActivityAt).map((lastActivityAt) => ({
          id: sessionId(row.id),
          agentType: parsedAgentKind.data,
          agentSessionId: row.agentSessionId ?? "",
          context,
          status: parsedStatus.data,
          createdAt,
          lastActivityAt,
        })),
      ),
  );
}

function requireSession(
  row: SessionRow | undefined,
  id: SessionId,
): Result<SessionRow, ReturnType<typeof sessionError>> {
  if (row === undefined) {
    return err(sessionError(`Session not found: ${id}`));
  }

  return ok(row);
}

export function createSessionManager(database: AppDatabase): SessionManager {
  return {
    create(input) {
      return runDatabaseOperation(() => {
        const timestamp = new Date().toISOString();
        const id = crypto.randomUUID();

        database
          .insert(sessions)
          .values({
            id,
            agentType: input.agentType,
            agentSessionId: input.agentSessionId,
            contextKind: input.context.kind,
            contextProject: input.context.project,
            contextIid: contextIid(input.context),
            status: "active",
            createdAt: timestamp,
            lastActivityAt: timestamp,
          })
          .run();

        return database.select().from(sessions).where(eq(sessions.id, id)).get();
      }).andThen((row) => requireSession(row, sessionId("pending-session")).andThen(mapSession));
    },

    findByContext(context, agentType) {
      const baseCondition = and(
        eq(sessions.contextKind, context.kind),
        eq(sessions.contextProject, context.project),
        eq(sessions.contextIid, contextIid(context)),
        eq(sessions.status, "active"),
      );

      const whereCondition =
        agentType === undefined
          ? baseCondition
          : and(baseCondition, eq(sessions.agentType, agentType));

      return runDatabaseOperation(() =>
        database
          .select()
          .from(sessions)
          .where(whereCondition)
          .orderBy(desc(sessions.lastActivityAt), desc(sessions.createdAt))
          .get(),
      ).andThen((row) => {
        if (row === undefined) {
          return ok(null);
        }

        return mapSession(row);
      });
    },

    updateActivity(id, agentSessionIdValue) {
      return runDatabaseOperation(() =>
        database.transaction((tx) => {
          const existingSession = tx.select().from(sessions).where(eq(sessions.id, id)).get();
          if (existingSession === undefined) {
            return undefined;
          }

          tx.update(sessions)
            .set({
              agentSessionId:
                agentSessionIdValue === undefined
                  ? existingSession.agentSessionId
                  : agentSessionIdValue,
              lastActivityAt: new Date().toISOString(),
            })
            .where(eq(sessions.id, id))
            .run();

          return tx.select().from(sessions).where(eq(sessions.id, id)).get();
        }),
      ).andThen((row) => requireSession(row, id).andThen(mapSession));
    },

    markFinalStatus(id, status) {
      return runDatabaseOperation(() =>
        database.transaction((tx) => {
          const existingSession = tx.select().from(sessions).where(eq(sessions.id, id)).get();
          if (existingSession === undefined) {
            return undefined;
          }

          tx.update(sessions)
            .set({
              status,
              lastActivityAt: new Date().toISOString(),
            })
            .where(eq(sessions.id, id))
            .run();

          return tx.select().from(sessions).where(eq(sessions.id, id)).get();
        }),
      ).andThen((row) => requireSession(row, id).andThen(mapSession));
    },
  };
}
