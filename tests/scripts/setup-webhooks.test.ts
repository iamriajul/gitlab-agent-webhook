import { describe, expect, it } from "bun:test";
import { parseArgs, shouldSkip } from "../../scripts/setup-webhooks";

const BASE_HOOK = {
  id: 1,
  url: "https://webhook.example.com/webhook",
  note_events: true,
  issues_events: true,
  merge_requests_events: true,
};

describe("parseArgs", () => {
  it("parses --force flag", () => {
    const result = parseArgs(["https://webhook.example.com/webhook", "--force"]);
    expect(result.force).toBe(true);
  });

  it("force defaults to false", () => {
    const result = parseArgs(["https://webhook.example.com/webhook"]);
    expect(result.force).toBe(false);
  });

  it("parses --dry-run", () => {
    const result = parseArgs(["https://webhook.example.com/webhook", "--dry-run"]);
    expect(result.dryRun).toBe(true);
  });

  it("parses --remove", () => {
    const result = parseArgs(["--remove", "org/repo"]);
    expect(result.remove).toBe(true);
  });

  it("parses webhookUrl and repoFilter", () => {
    const result = parseArgs(["https://webhook.example.com/webhook", "org/repo"]);
    expect(result.webhookUrl).toBe("https://webhook.example.com/webhook");
    expect(result.repoFilter).toBe("org/repo");
  });
});

describe("shouldSkip", () => {
  it("skips when URL and events match and force is false", () => {
    expect(shouldSkip(BASE_HOOK, "https://webhook.example.com/webhook", false)).toBe(true);
  });

  it("does not skip when force is true even if URL and events match", () => {
    expect(shouldSkip(BASE_HOOK, "https://webhook.example.com/webhook", true)).toBe(false);
  });

  it("does not skip when URL differs", () => {
    expect(shouldSkip(BASE_HOOK, "https://other.example.com/webhook", false)).toBe(false);
  });

  it("does not skip when note_events is false", () => {
    expect(
      shouldSkip(
        { ...BASE_HOOK, note_events: false },
        "https://webhook.example.com/webhook",
        false,
      ),
    ).toBe(false);
  });

  it("does not skip when issues_events is false", () => {
    expect(
      shouldSkip(
        { ...BASE_HOOK, issues_events: false },
        "https://webhook.example.com/webhook",
        false,
      ),
    ).toBe(false);
  });

  it("does not skip when merge_requests_events is false", () => {
    expect(
      shouldSkip(
        { ...BASE_HOOK, merge_requests_events: false },
        "https://webhook.example.com/webhook",
        false,
      ),
    ).toBe(false);
  });
});
