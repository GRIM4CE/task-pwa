-- Unify todos and subtasks into a single self-referencing tree on `todos`.
-- A row with parent_id IS NULL is top-level; otherwise it's a subtask. Subtasks
-- get recurrence = NULL on migration (subtasks never had a recurrence field).
ALTER TABLE `todos` ADD `parent_id` text REFERENCES todos(id) ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO `todos` (
  `id`,
  `user_id`,
  `parent_id`,
  `title`,
  `description`,
  `completed`,
  `is_personal`,
  `sort_order`,
  `recurrence`,
  `pinned_to_week`,
  `last_completed_at`,
  `created_at`,
  `updated_at`
)
SELECT
  `id`,
  `user_id`,
  `parent_id`,
  `title`,
  `description`,
  `completed`,
  `is_personal`,
  `sort_order`,
  NULL,
  `pinned_to_week`,
  `last_completed_at`,
  `created_at`,
  `updated_at`
FROM `subtasks`;--> statement-breakpoint
DROP TABLE `subtasks`;--> statement-breakpoint
CREATE INDEX `idx_todos_parent` ON `todos` (`parent_id`,`sort_order`);
