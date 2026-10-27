CREATE TABLE `notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event_key` text NOT NULL,
	`recipient_user_id` text,
	`recipient_email` text NOT NULL,
	`subject` text NOT NULL,
	`body_text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_error` text,
	`sent_at` text,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outbox_event_unique` ON `notification_outbox` (`event_key`);--> statement-breakpoint
CREATE INDEX `notification_outbox_status` ON `notification_outbox` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `site_access_requests` (
	`user_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`request_event_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`decided_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `site_access_requests_status` ON `site_access_requests` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `profiles` ADD `notifications_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `subscription_members` ADD `approval_event_id` text;