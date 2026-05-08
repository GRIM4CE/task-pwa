CREATE TABLE `todo_skips` (
	`id` text PRIMARY KEY NOT NULL,
	`todo_id` text NOT NULL,
	`user_id` text NOT NULL,
	`skipped_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_todo_skips_todo_skipped` ON `todo_skips` (`todo_id`,`skipped_at`);--> statement-breakpoint
CREATE INDEX `idx_todo_skips_user_skipped` ON `todo_skips` (`user_id`,`skipped_at`);