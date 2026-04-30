CREATE TABLE `subtasks` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`completed` integer DEFAULT false NOT NULL,
	`is_personal` integer DEFAULT false NOT NULL,
	`pinned_to_week` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`last_completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_subtasks_parent` ON `subtasks` (`parent_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_subtasks_user` ON `subtasks` (`user_id`,`completed`);--> statement-breakpoint
ALTER TABLE `todos` ADD `pinned_to_week` integer DEFAULT false NOT NULL;