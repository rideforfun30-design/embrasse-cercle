import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { profiles, workspaces } from "./schema";

export const billingAccounts = sqliteTable("billing_accounts", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  userId: text("user_id").notNull().references(() => profiles.id),
  mode: text("mode").notNull(),
  customerId: text("customer_id"),
  setupSessionId: text("setup_session_id"),
  setupComplete: integer("setup_complete").notNull().default(0),
  maxCents: integer("max_cents").notNull(),
  consentVersion: text("consent_version").notNull(),
  acceptedAt: text("accepted_at").notNull(),
  operationStartedAt: text("operation_started_at").notNull(),
}, t => [primaryKey({ columns: [t.workspaceId, t.userId, t.mode] }), uniqueIndex("billing_customer_unique").on(t.customerId)]);

export const billingCycles = sqliteTable("billing_cycles", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  period: text("period").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  frozenAt: text("frozen_at").notNull(),
  leaseId: text("lease_id"),
  leaseUntil: integer("lease_until"),
}, t => [uniqueIndex("billing_cycle_unique").on(t.workspaceId, t.period, t.mode)]);

export const billingAllocations = sqliteTable("billing_allocations", {
  cycleId: text("cycle_id").notNull().references(() => billingCycles.id),
  subscriptionId: text("subscription_id").notNull(),
  subscriptionName: text("subscription_name").notNull(),
  userId: text("user_id").notNull().references(() => profiles.id),
  amountCents: integer("amount_cents").notNull(),
}, t => [primaryKey({ columns: [t.cycleId, t.subscriptionId, t.userId] })]);

export const billingInvoices = sqliteTable("billing_invoices", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull().references(() => billingCycles.id),
  userId: text("user_id").notNull().references(() => profiles.id),
  amountCents: integer("amount_cents").notNull(),
  customerId: text("customer_id"),
  status: text("status").notNull(),
  stripeInvoiceId: text("stripe_invoice_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  paidCents: integer("paid_cents").notNull().default(0),
  refundedCents: integer("refunded_cents").notNull().default(0),
  operationStartedAt: text("operation_started_at"),
  updatedAt: text("updated_at").notNull(),
}, t => [uniqueIndex("billing_member_cycle_unique").on(t.cycleId, t.userId), uniqueIndex("billing_stripe_invoice_unique").on(t.stripeInvoiceId), index("billing_payment_intent_index").on(t.stripePaymentIntentId)]);

export const billingWebhookEvents = sqliteTable("billing_webhook_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  receivedAt: text("received_at").notNull(),
  processedAt: text("processed_at"),
});
