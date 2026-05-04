ALTER TABLE `todos` ADD `pinned_to` text;--> statement-breakpoint
UPDATE `todos` SET `pinned_to` = 'week' WHERE `pinned_to_week` = 1;--> statement-breakpoint
ALTER TABLE `todos` DROP COLUMN `pinned_to_week`;