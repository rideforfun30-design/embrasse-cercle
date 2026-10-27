import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  notificationsEnabled: integer("notifications_enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull().references(() => profiles.id),
  inviteCode: text("invite_code").notNull(),
  createdAt: text("created_at").notNull(),
}, t => [uniqueIndex("workspaces_invite_unique").on(t.inviteCode)]);

export const workspaceMembers = sqliteTable("workspace_members", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => profiles.id),
  role: text("role", { enum: ["admin", "member"] }).notNull(),
  joinedAt: text("joined_at").notNull(),
}, t => [primaryKey({ columns: [t.workspaceId, t.userId] }), index("workspace_members_user").on(t.userId)]);

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => profiles.id),
  name: text("name").notNull(),
  category: text("category").notNull(),
  websiteUrl: text("website_url"),
  description: text("description").notNull().default(""),
  totalCents: integer("total_cents").notNull(),
  maxSeats: integer("max_seats").notNull(),
  nextDueDate: text("next_due_date").notNull(),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
}, t => [index("subscriptions_workspace").on(t.workspaceId)]);

export const subscriptionMembers = sqliteTable("subscription_members", {
  subscriptionId: text("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => profiles.id),
  status: text("status", { enum: ["pending", "active"] }).notNull(),
  joinedAt: text("joined_at").notNull(),
  cancellationRequestedAt: text("cancellation_requested_at"),
  cancellationEffectiveAt: text("cancellation_effective_at"),
  policyVersion: text("policy_version"),
  policyAcceptedAt: text("policy_accepted_at"),
  approvalEventId: text("approval_event_id"),
}, t => [primaryKey({ columns: [t.subscriptionId, t.userId] }), index("subscription_members_user").on(t.userId)]);

export const apiWriteBudgets = sqliteTable("api_write_budgets", {
  userId: text("user_id").notNull(),
  bucket: integer("bucket").notNull(),
  count: integer("count").notNull(),
}, t => [primaryKey({ columns: [t.userId, t.bucket] }), index("api_write_budgets_bucket").on(t.bucket)]);


export const siteAccessRequests = sqliteTable("site_access_requests", {
  userId: text("user_id").primaryKey().references(() => profiles.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  reason: text("reason").notNull().default(""),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull(),
  requestEventId: text("request_event_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  decidedBy: text("decided_by"),
}, t => [index("site_access_requests_status").on(t.status,t.createdAt)]);

export const notificationOutbox = sqliteTable("notification_outbox", {
  id: text("id").primaryKey(),
  eventKey: text("event_key").notNull(),
  recipientUserId: text("recipient_user_id").references(() => profiles.id),
  recipientEmail: text("recipient_email").notNull(),
  subject: text("subject").notNull(),
  bodyText: text("body_text").notNull(),
  status: text("status", { enum: ["pending", "sending", "sent", "failed", "uncertain", "cancelled"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastError: text("last_error"),
  sentAt: text("sent_at"),
  leaseToken: text("lease_token"),
  leaseUntil: text("lease_until"),
  attemptStartedAt: text("attempt_started_at"),
  expiresAt: text("expires_at"),
}, t => [uniqueIndex("notification_outbox_event_unique").on(t.eventKey),index("notification_outbox_status").on(t.status,t.createdAt)]);

export const subscriptionCredentials = sqliteTable("subscription_credentials", {
  subscriptionId: text("subscription_id").primaryKey().references(() => subscriptions.id, { onDelete: "cascade" }),
  encryptionVersion: integer("encryption_version").notNull(),
  iv: text("iv").notNull(),
  ciphertext: text("ciphertext").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull().references(() => profiles.id),
});

export const subscriptionVaultEvents = sqliteTable("subscription_vault_events", {
  id: text("id").primaryKey(),
  subscriptionId: text("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull().references(() => profiles.id),
  action: text("action", { enum: ["updated", "revealed", "deleted"] }).notNull(),
  createdAt: text("created_at").notNull(),
}, t => [index("subscription_vault_events_subscription").on(t.subscriptionId, t.createdAt)]);
