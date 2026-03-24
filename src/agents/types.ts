import type { AppError } from "../types/errors.ts";
import type { Result } from "../types/result.ts";

export type AgentType =
  | { readonly kind: "claude" }
  | { readonly kind: "codex" }
  | { readonly kind: "gemini" };

export interface AgentConfig {
  readonly agent: AgentType;
  readonly workDir: string;
  readonly prompt: string;
  readonly sessionId?: string | undefined;
  readonly systemPrompt: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface AgentResult {
  readonly exitCode: number;
  readonly sessionId: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface AgentProcess {
  readonly pid: number;
  readonly result: Promise<Result<AgentResult, AppError>>;
  readonly kill: () => void | Promise<void>;
}

export interface AgentCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface SpawnedAgentHandle {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(): void;
}

export interface AgentAdapter {
  buildCommand(config: AgentConfig): AgentCommand;
  parseSessionId(output: string): string | null;
}
