DROP INDEX `idx_totp_used_codes_unique`;--> statement-breakpoint
ALTER TABLE `totp_used_codes` ADD `user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_totp_used_codes_user_unique` ON `totp_used_codes` (`user_id`,`code`,`time_step`);