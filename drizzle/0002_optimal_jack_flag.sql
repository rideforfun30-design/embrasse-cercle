CREATE TABLE `api_write_budgets` (
	`user_id` text NOT NULL,
	`bucket` integer NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`user_id`, `bucket`)
);
--> statement-breakpoint
CREATE INDEX `api_write_budgets_bucket` ON `api_write_budgets` (`bucket`);