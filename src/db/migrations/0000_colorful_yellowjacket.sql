CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`error` text,
	`retry_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_key_unique` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_type` text NOT NULL,
	`agent_session_id` text,
	`context_kind` text NOT NULL,
	`context_project` text NOT NULL,
	`context_iid` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`last_activity_at` text NOT NULL
);
