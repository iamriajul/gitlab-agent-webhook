import type { AppError } from "../types/errors.ts";
import { agentError } from "../types/errors.ts";
import type { Result } from "../types/result.ts";
import { err } from "../types/result.ts";
import type { AgentConfig, AgentProcess } from "./types.ts";

// TODO: Implement agent spawning with Bun.spawn
export function spawnAgent(_config: AgentConfig): Result<AgentProcess, AppError> {
  return err(agentError("Agent spawning not yet implemented", _config.agent.kind, -1));
}
