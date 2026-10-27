CREATE TABLE `billing_bank_receipts` (
	`invoice_id` text PRIMARY KEY NOT NULL,
	`bank_provider` text NOT NULL,
	`bank_account_id` text NOT NULL,
	`bank_entry_reference` text NOT NULL,
	`booked_amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`booked_at` text NOT NULL,
	`verified_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `billing_invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_bank_entry_unique` ON `billing_bank_receipts` (`bank_provider`,`bank_account_id`,`bank_entry_reference`);