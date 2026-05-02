ALTER TABLE `todos` ADD `kind` text DEFAULT 'do' NOT NULL;--> statement-breakpoint
ALTER TABLE `todos` ADD `limit_count` integer;--> statement-breakpoint
ALTER TABLE `todos` ADD `limit_period` text;