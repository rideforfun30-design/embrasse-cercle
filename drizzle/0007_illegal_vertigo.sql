CREATE TABLE `auth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_accounts_user` ON `auth_accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_provider_unique` ON `auth_accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `auth_email_send_limits` (
	`email_hash` text PRIMARY KEY NOT NULL,
	`last_sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_email_send_limits_updated` ON `auth_email_send_limits` (`last_sent_at`);--> statement-breakpoint
CREATE TABLE `auth_profile_links` (
	`auth_user_id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`auth_user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_profile_links_profile_unique` ON `auth_profile_links` (`profile_id`);--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_rate_limits_key_unique` ON `auth_rate_limits` (`key`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_unique` ON `auth_sessions` (`token`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_users_email_unique` ON `auth_users` (`email`);--> statement-breakpoint
CREATE TABLE `auth_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_verifications_identifier` ON `auth_verifications` (`identifier`);--> statement-breakpoint
ALTER TABLE `notification_outbox` ADD `expires_at` text;