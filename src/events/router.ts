import type { Logger } from "../config/logger.ts";
import type { JobId } from "../types/branded.ts";
import type { AppError } from "../types/errors.ts";
import type { WebhookEvent } from "../types/events.ts";
import type { Result } from "../types/result.ts";
import { ok } from "../types/result.ts";

export function routeEvent(event: WebhookEvent, logger: Logger): Result<JobId | null, AppError> {
  switch (event.kind) {
    case "note_on_issue": {
      logger.info(
        { project: event.payload.project.path_with_namespace, issueIid: event.payload.issue.iid },
        "Received note on issue",
      );
      // TODO: implement handleNoteOnIssue
      return ok(null);
    }
    case "note_on_mr": {
      logger.info(
        {
          project: event.payload.project.path_with_namespace,
          mrIid: event.payload.merge_request.iid,
        },
        "Received note on MR",
      );
      // TODO: implement handleNoteOnMR
      return ok(null);
    }
    case "mr_opened": {
      logger.info(
        {
          project: event.payload.project.path_with_namespace,
          mrIid: event.payload.object_attributes.iid,
        },
        "MR opened",
      );
      // TODO: implement handleMROpened
      return ok(null);
    }
    case "mr_updated": {
      logger.info(
        {
          project: event.payload.project.path_with_namespace,
          mrIid: event.payload.object_attributes.iid,
        },
        "MR updated",
      );
      // TODO: implement handleMRUpdated
      return ok(null);
    }
    case "ignored": {
      logger.debug({ reason: event.reason }, "Event ignored");
      return ok(null);
    }
  }
}
