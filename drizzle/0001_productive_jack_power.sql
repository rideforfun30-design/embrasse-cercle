CREATE TABLE `billing_accounts` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`mode` text NOT NULL,
	`customer_id` text,
	`setup_session_id` text,
	`setup_complete` integer DEFAULT 0 NOT NULL,
	`max_cents` integer NOT NULL,
	`consent_version` text NOT NULL,
	`accepted_at` text NOT NULL,
	`operation_started_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`, `mode`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_customer_unique` ON `billing_accounts` (`customer_id`);--> statement-breakpoint
CREATE TABLE `billing_allocations` (
	`cycle_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`subscription_name` text NOT NULL,
	`user_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	PRIMARY KEY(`cycle_id`, `subscription_id`, `user_id`),
	FOREIGN KEY (`cycle_id`) REFERENCES `billing_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `billing_cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`period` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`frozen_at` text NOT NULL,
	`lease_id` text,
	`lease_until` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_cycle_unique` ON `billing_cycles` (`workspace_id`,`period`,`mode`);--> statement-breakpoint
CREATE TABLE `billing_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`cycle_id` text NOT NULL,
	`user_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`customer_id` text,
	`status` text NOT NULL,
	`stripe_invoice_id` text,
	`stripe_payment_intent_id` text,
	`paid_cents` integer DEFAULT 0 NOT NULL,
	`refunded_cents` integer DEFAULT 0 NOT NULL,
	`operation_started_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`cycle_id`) REFERENCES `billing_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_member_cycle_unique` ON `billing_invoices` (`cycle_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_stripe_invoice_unique` ON `billing_invoices` (`stripe_invoice_id`);--> statement-breakpoint
CREATE INDEX `billing_payment_intent_index` ON `billing_invoices` (`stripe_payment_intent_id`);--> statement-breakpoint
CREATE TABLE `billing_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`received_at` text NOT NULL,
	`processed_at` text
);
