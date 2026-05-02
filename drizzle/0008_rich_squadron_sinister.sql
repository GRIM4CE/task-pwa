CREATE TABLE `vacations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_vacations_user` ON `vacations` (`user_id`,`starts_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vacations_one_open_per_user` ON `vacations` (`user_id`) WHERE ends_at IS NULL;