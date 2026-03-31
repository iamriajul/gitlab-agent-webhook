#!/usr/bin/env bun
/**
 * Configure GitLab webhooks across all accessible projects.
 *
 * Usage:
 *   bun scripts/setup-webhooks.ts <public-url>
 *   bun scripts/setup-webhooks.ts https://webhook.example.com/webhook --dry-run
 *   bun scripts/setup-webhooks.ts https://webhook.example.com/webhook --remove
 */

const WEBHOOK_NAME = "glab-review-webhook";

interface GitLabProject {
  readonly id: number;
  readonly path_with_namespace: string;
}

interface GitLabHook {
  readonly id: number;
  readonly url: string;
  readonly name: string;
  readonly note_events: boolean;
  readonly issues_events: boolean;
  readonly merge_requests_events: boolean;
}

function getEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return value;
}

async function glabApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const host = getEnv("GITLAB_HOST");
  const token = getEnv("GITLAB_TOKEN");
  const url = `${host}/api/v4/${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitLab API ${response.status}: ${body}`);
  }
  return response.json() as Promise<T>;
}

async function listProjects(): Promise<readonly GitLabProject[]> {
  const projects: GitLabProject[] = [];
  let page = 1;
  while (true) {
    const batch = await glabApi<GitLabProject[]>(
      `projects?membership=true&per_page=100&page=${page}&min_access_level=30`,
    );
    projects.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return projects;
}

async function listHooks(projectId: number): Promise<readonly GitLabHook[]> {
  return glabApi<GitLabHook[]>(`projects/${projectId}/hooks`);
}

function webhookBody(webhookUrl: string, secret: string): string {
  return JSON.stringify({
    name: WEBHOOK_NAME,
    url: webhookUrl,
    token: secret,
    push_events: false,
    tag_push_events: false,
    note_events: true,
    issues_events: true,
    confidential_issues_events: false,
    merge_requests_events: true,
    pipeline_events: false,
    wiki_page_events: false,
    deployment_events: false,
    job_events: false,
    releases_events: false,
    enable_ssl_verification: true,
  });
}

async function createHook(projectId: number, webhookUrl: string, secret: string): Promise<void> {
  await glabApi(`projects/${projectId}/hooks`, {
    method: "POST",
    body: webhookBody(webhookUrl, secret),
  });
}

async function updateHook(
  projectId: number,
  hookId: number,
  webhookUrl: string,
  secret: string,
): Promise<void> {
  await glabApi(`projects/${projectId}/hooks/${hookId}`, {
    method: "PUT",
    body: webhookBody(webhookUrl, secret),
  });
}

async function removeHook(projectId: number, hookId: number): Promise<void> {
  await glabApi(`projects/${projectId}/hooks/${hookId}`, { method: "DELETE" });
}

function extractProjectPath(repoUrl: string): string {
  try {
    const parsed = new URL(repoUrl);
    return parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
  } catch {
    return repoUrl;
  }
}

async function getProjectByPath(path: string): Promise<GitLabProject> {
  return glabApi<GitLabProject>(`projects/${encodeURIComponent(path)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const remove = args.includes("--remove");
  const nonFlags = args.filter((a) => !a.startsWith("--"));
  let webhookUrl: string | undefined;
  let repoFilter: string | undefined;

  for (const arg of nonFlags) {
    if (webhookUrl === undefined && arg.startsWith("http")) {
      webhookUrl = arg;
    } else if (repoFilter === undefined) {
      repoFilter = arg;
    }
  }

  if (!remove && webhookUrl === undefined) {
    console.error(
      "Usage: bun scripts/setup-webhooks.ts <public-url> [repo-url-or-path] [--dry-run] [--remove]",
    );
    console.error("");
    console.error("Examples:");
    console.error("  bun scripts/setup-webhooks.ts https://webhook.example.com/webhook");
    console.error(
      "  bun scripts/setup-webhooks.ts https://webhook.example.com/webhook https://gitlab.com/org/repo",
    );
    console.error(
      "  bun scripts/setup-webhooks.ts https://webhook.example.com/webhook org/repo",
    );
    console.error("  bun scripts/setup-webhooks.ts --remove org/repo");
    process.exit(1);
  }

  const secret = getEnv("GITLAB_WEBHOOK_SECRET");

  let projects: readonly GitLabProject[];
  if (repoFilter !== undefined) {
    const projectPath = extractProjectPath(repoFilter);
    console.log(`Fetching project ${projectPath}...`);
    try {
      const project = await getProjectByPath(projectPath);
      projects = [project];
    } catch (error) {
      console.error(`Failed to find project: ${projectPath}`);
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else {
    console.log("Fetching accessible projects...");
    projects = await listProjects();
  }
  console.log(`Found ${projects.length} project(s).\n`);

  let created = 0;
  let updated = 0;
  let removed = 0;
  let skipped = 0;

  for (const project of projects) {
    const hooks = await listHooks(project.id);
    const existing = hooks.find((h) => h.name === WEBHOOK_NAME);

    if (remove) {
      if (existing === undefined) {
        skipped++;
        continue;
      }
      if (dryRun) {
        console.log(`[dry-run] Would remove webhook from ${project.path_with_namespace}`);
      } else {
        await removeHook(project.id, existing.id);
        console.log(`Removed webhook from ${project.path_with_namespace}`);
      }
      removed++;
      continue;
    }

    if (existing !== undefined) {
      if (existing.url === webhookUrl && existing.note_events && existing.issues_events && existing.merge_requests_events) {
        skipped++;
        continue;
      }
      if (dryRun) {
        console.log(`[dry-run] Would update webhook on ${project.path_with_namespace}`);
      } else {
        await updateHook(project.id, existing.id, webhookUrl!, secret);
        console.log(`Updated webhook on ${project.path_with_namespace}`);
      }
      updated++;
    } else {
      if (dryRun) {
        console.log(`[dry-run] Would create webhook on ${project.path_with_namespace}`);
      } else {
        await createHook(project.id, webhookUrl!, secret);
        console.log(`Created webhook on ${project.path_with_namespace}`);
      }
      created++;
    }
  }

  console.log(`\nDone.${dryRun ? " (dry run)" : ""}`);
  if (created > 0) console.log(`  Created: ${created}`);
  if (updated > 0) console.log(`  Updated: ${updated}`);
  if (removed > 0) console.log(`  Removed: ${removed}`);
  if (skipped > 0) console.log(`  Skipped (unchanged): ${skipped}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
