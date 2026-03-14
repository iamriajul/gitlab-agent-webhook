export const MENTION_REGEX = /@([\w.-]+)/g;

export const REACTION_SEEN = "eyes" as const;
export const REACTION_DONE = "white_check_mark" as const;
export const REACTION_FAILED = "warning" as const;

export const WEBHOOK_HEADER_EVENT = "x-gitlab-event" as const;
export const WEBHOOK_HEADER_TOKEN = "x-gitlab-token" as const;
export const WEBHOOK_HEADER_UUID = "x-gitlab-webhook-uuid" as const;
export const WEBHOOK_HEADER_IDEMPOTENCY = "idempotency-key" as const;
