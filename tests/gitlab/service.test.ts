import { describe, expect, it } from "bun:test";
import { createLogger } from "../../src/config/logger.ts";
import { GitLabService } from "../../src/gitlab/service.ts";

describe("GitLabService", () => {
  it("only clears the bot's own matching reaction", async () => {
    const service = new GitLabService(
      "token",
      "https://gitlab.example.com",
      createLogger("fatal"),
      "agent",
    );
    const removeCalls: unknown[][] = [];

    Reflect.set(service, "api", {
      MergeRequestAwardEmojis: {
        all() {
          return Promise.resolve([
            { id: 1, name: "eyes", user: { username: "alice" } },
            { id: 2, name: "thumbsup", user: { username: "agent" } },
            { id: 3, name: "eyes", user: { username: "agent" } },
          ]);
        },
        remove(...args: unknown[]) {
          removeCalls.push(args);
          return Promise.resolve({});
        },
      },
    });

    let succeeded = false;
    await service.clearReaction({ kind: "mr", project: "team/project", mrIid: 7 }, "eyes").match(
      () => {
        succeeded = true;
      },
      () => {
        succeeded = false;
      },
    );

    expect(succeeded).toBe(true);
    expect(removeCalls).toEqual([["team/project", 7, 3]]);
  });
});
