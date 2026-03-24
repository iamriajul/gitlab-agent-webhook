import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "../db/database.ts";
import { jobs } from "../db/schema.ts";
import { type JobId, jobId } from "../types/branded.ts";
import { queueError } from "../types/errors.ts";
import { err, fromThrowable, ok, type Result } from "../types/result.ts";
import type { Job, JobPayload, JobStatus } from "./types.ts";

const agentKindSchema = z.enum(["claude", "codex", "gemini"]);

const jobPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("review_mr"),
    project: z.string(),
    mrIid: z.number().int(),
  }),
  z.object({
    kind: z.literal("handle_mention"),
    project: z.string(),
    noteId: z.number().int(),
    issueIid: z.number().int(),
    prompt: z.string(),
    agentType: agentKindSchema,
  }),
  z.object({
    kind: z.literal("handle_mr_mention"),
    project: z.string(),
    noteId: z.number().int(),
    mrIid: z.number().int(),
    prompt: z.string(),
    agentType: agentKindSchema,
  }),
]);

const jobStatusSchema = z.enum(["pending", "processing", "completed", "failed"]);

export interface EnqueueJobInput {
  readonly payload: JobPayload;
  readonly idempotencyKey: string;
}

export interface JobQueue {
  enqueue(input: EnqueueJobInput): Result<Job, ReturnType<typeof queueError>>;
  listPending(): Result<readonly Job[], ReturnType<typeof queueError>>;
  claimPending(id: JobId): Result<Job | null, ReturnType<typeof queueError>>;
  claimNext(): Result<Job | null, ReturnType<typeof queueError>>;
  complete(id: JobId): Result<Job, ReturnType<typeof queueError>>;
  fail(id: JobId, message: string): Result<Job, ReturnType<typeof queueError>>;
  findByIdempotencyKey(idempotencyKey: string): Result<Job | null, ReturnType<typeof queueError>>;
}

let lastTimestampMs = 0;

function nextTimestamp(): string {
  const nowMs = Date.now();
  lastTimestampMs = nowMs > lastTimestampMs ? nowMs : lastTimestampMs + 1;
  return new Date(lastTimestampMs).toISOString();
}

function formatUnknownError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }

  return String(cause);
}

function runDatabaseOperation<T>(operation: () => T): Result<T, ReturnType<typeof queueError>> {
  return fromThrowable(operation, (cause) => queueError(formatUnknownError(cause)))();
}

function parseJobStatus(value: string): Result<JobStatus, ReturnType<typeof queueError>> {
  const parsedStatus = jobStatusSchema.safeParse(value);
  if (!parsedStatus.success) {
    return err(queueError(`Invalid job status: ${value}`));
  }

  return ok(parsedStatus.data);
}

function parseJobPayload(value: string): Result<JobPayload, ReturnType<typeof queueError>> {
  return runDatabaseOperation(() => JSON.parse(value)).andThen((parsedValue) => {
    const parsedPayload = jobPayloadSchema.safeParse(parsedValue);

    if (!parsedPayload.success) {
      return err(queueError("Invalid stored job payload"));
    }

    return ok(parsedPayload.data);
  });
}

function parseOptionalDate(
  value: string | null,
): Result<Date | null, ReturnType<typeof queueError>> {
  if (value === null) {
    return ok(null);
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    return err(queueError(`Invalid stored date: ${value}`));
  }

  return ok(parsedDate);
}

function parseRequiredDate(value: string): Result<Date, ReturnType<typeof queueError>> {
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    return err(queueError(`Invalid stored date: ${value}`));
  }

  return ok(parsedDate);
}

type JobRow = typeof jobs.$inferSelect;

function mapJob(row: JobRow): Result<Job, ReturnType<typeof queueError>> {
  return parseJobPayload(row.payload).andThen((payload) =>
    parseJobStatus(row.status).andThen((status) =>
      parseRequiredDate(row.createdAt).andThen((createdAt) =>
        parseOptionalDate(row.startedAt).andThen((startedAt) =>
          parseOptionalDate(row.completedAt).map((completedAt) => ({
            id: jobId(row.id),
            payload,
            status,
            createdAt,
            startedAt,
            completedAt,
            error: row.error,
            idempotencyKey: row.idempotencyKey,
            retryCount: row.retryCount,
          })),
        ),
      ),
    ),
  );
}

function requireJob(
  row: JobRow | undefined,
  id: JobId,
): Result<JobRow, ReturnType<typeof queueError>> {
  if (row === undefined) {
    return err(queueError(`Job not found: ${id}`));
  }

  return ok(row);
}

export function createJobQueue(database: AppDatabase): JobQueue {
  return {
    enqueue(input) {
      return runDatabaseOperation(() =>
        database.transaction((tx) => {
          const existingJob = tx
            .select()
            .from(jobs)
            .where(eq(jobs.idempotencyKey, input.idempotencyKey))
            .get();

          if (existingJob !== undefined) {
            return existingJob;
          }

          const createdAt = nextTimestamp();
          const id = crypto.randomUUID();

          tx.insert(jobs)
            .values({
              id,
              payload: JSON.stringify(input.payload),
              status: "pending",
              idempotencyKey: input.idempotencyKey,
              createdAt,
              startedAt: null,
              completedAt: null,
              error: null,
              retryCount: 0,
            })
            .run();

          return tx.select().from(jobs).where(eq(jobs.id, id)).get();
        }),
      ).andThen((row) => requireJob(row, jobId("pending-enqueue")).andThen(mapJob));
    },

    listPending() {
      return runDatabaseOperation(() =>
        database
          .select()
          .from(jobs)
          .where(eq(jobs.status, "pending"))
          .orderBy(asc(jobs.createdAt), asc(jobs.id))
          .all(),
      ).andThen((rows) => {
        const pendingJobs: Job[] = [];

        for (const row of rows) {
          const jobResult = mapJob(row);
          if (jobResult.isErr()) {
            return err(jobResult.error);
          }

          pendingJobs.push(jobResult.value);
        }

        return ok(pendingJobs);
      });
    },

    claimPending(id) {
      return runDatabaseOperation(() =>
        database.transaction((tx) => {
          const pendingJob = tx
            .select()
            .from(jobs)
            .where(and(eq(jobs.id, id), eq(jobs.status, "pending")))
            .get();

          if (pendingJob === undefined) {
            return null;
          }

          const startedAt = nextTimestamp();
          const updateResult = tx
            .update(jobs)
            .set({
              status: "processing",
              startedAt,
              completedAt: null,
              error: null,
            })
            .where(and(eq(jobs.id, pendingJob.id), eq(jobs.status, "pending")))
            .run();
          if (updateResult.changes === 0) {
            return null;
          }

          return tx.select().from(jobs).where(eq(jobs.id, pendingJob.id)).get() ?? null;
        }),
      ).andThen((row) => {
        if (row === null) {
          return ok(null);
        }

        return mapJob(row);
      });
    },

    claimNext() {
      return runDatabaseOperation(() =>
        database.transaction((tx) => {
          const pendingJob = tx
            .select()
            .from(jobs)
            .where(eq(jobs.status, "pending"))
            .orderBy(asc(jobs.createdAt), asc(jobs.id))
            .get();

          if (pendingJob === undefined) {
            return null;
          }

          const startedAt = nextTimestamp();

          tx.update(jobs)
            .set({
              status: "processing",
              startedAt,
              completedAt: null,
              error: null,
            })
            .where(and(eq(jobs.id, pendingJob.id), eq(jobs.status, "pending")))
            .run();

          return tx.select().from(jobs).where(eq(jobs.id, pendingJob.id)).get() ?? null;
        }),
      ).andThen((row) => {
        if (row === null) {
          return ok(null);
        }

        return mapJob(row);
      });
    },

    complete(id) {
      return runDatabaseOperation(() =>
        database.transaction((tx) => {
          const existingJob = tx.select().from(jobs).where(eq(jobs.id, id)).get();
          if (existingJob === undefined) {
            return undefined;
          }

          tx.update(jobs)
            .set({
              status: "completed",
              completedAt: nextTimestamp(),
              error: null,
            })
            .where(eq(jobs.id, id))
            .run();

          return tx.select().from(jobs).where(eq(jobs.id, id)).get();
        }),
      ).andThen((row) => requireJob(row, id).andThen(mapJob));
    },

    fail(id, message) {
      return runDatabaseOperation(() =>
        database.transaction((tx) => {
          const existingJob = tx.select().from(jobs).where(eq(jobs.id, id)).get();
          if (existingJob === undefined) {
            return undefined;
          }

          tx.update(jobs)
            .set({
              status: "failed",
              completedAt: nextTimestamp(),
              error: message,
              retryCount: existingJob.retryCount + 1,
            })
            .where(eq(jobs.id, id))
            .run();

          return tx.select().from(jobs).where(eq(jobs.id, id)).get();
        }),
      ).andThen((row) => requireJob(row, id).andThen(mapJob));
    },

    findByIdempotencyKey(idempotencyKey) {
      return runDatabaseOperation(() =>
        database.select().from(jobs).where(eq(jobs.idempotencyKey, idempotencyKey)).get(),
      ).andThen((row) => {
        if (row === undefined) {
          return ok(null);
        }

        return mapJob(row);
      });
    },
  };
}
