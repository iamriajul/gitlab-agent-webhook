export type AppError =
  | { readonly kind: "parse_error"; readonly message: string; readonly field?: string | undefined }
  | { readonly kind: "auth_error"; readonly message: string }
  | {
      readonly kind: "gitlab_error";
      readonly message: string;
      readonly statusCode?: number | undefined;
    }
  | {
      readonly kind: "agent_error";
      readonly message: string;
      readonly agent: string;
      readonly exitCode: number;
    }
  | { readonly kind: "queue_error"; readonly message: string }
  | { readonly kind: "session_error"; readonly message: string }
  | { readonly kind: "config_error"; readonly message: string };

export function parseError(message: string, field?: string): AppError {
  return { kind: "parse_error", message, field };
}

export function authError(message: string): AppError {
  return { kind: "auth_error", message };
}

export function gitlabError(message: string, statusCode?: number): AppError {
  return { kind: "gitlab_error", message, statusCode };
}

export function agentError(message: string, agent: string, exitCode: number): AppError {
  return { kind: "agent_error", message, agent, exitCode };
}

export function queueError(message: string): AppError {
  return { kind: "queue_error", message };
}

export function sessionError(message: string): AppError {
  return { kind: "session_error", message };
}

export function configError(message: string): AppError {
  return { kind: "config_error", message };
}
