CREATE TABLE `todo_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`todo_id` text NOT NULL,
	`user_id` text NOT NULL,
	`completed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_todo_completions_todo_completed` ON `todo_completions` (`todo_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `idx_todo_completions_user_completed` ON `todo_completions` (`user_id`,`completed_at`);