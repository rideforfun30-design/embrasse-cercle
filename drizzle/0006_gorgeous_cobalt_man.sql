ALTER TABLE `notification_outbox` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `notification_outbox` ADD `lease_until` text;--> statement-breakpoint
ALTER TABLE `notification_outbox` ADD `attempt_started_at` text;