import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { profiles } from "./schema";

// Better Auth's standard schema, isolated from application profiles and approvals.
export const authUsers = sqliteTable("auth_users", {
  id:text("id").primaryKey(), name:text("name").notNull(), email:text("email").notNull(),
  emailVerified:integer("email_verified",{mode:"boolean"}).notNull().default(false), image:text("image"),
  createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull(), updatedAt:integer("updated_at",{mode:"timestamp_ms"}).notNull(),
},t=>[uniqueIndex("auth_users_email_unique").on(t.email)]);
export const authSessions = sqliteTable("auth_sessions", {
  id:text("id").primaryKey(), expiresAt:integer("expires_at",{mode:"timestamp_ms"}).notNull(), token:text("token").notNull(),
  createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull(), updatedAt:integer("updated_at",{mode:"timestamp_ms"}).notNull(),
  ipAddress:text("ip_address"), userAgent:text("user_agent"), userId:text("user_id").notNull().references(()=>authUsers.id,{onDelete:"cascade"}),
},t=>[uniqueIndex("auth_sessions_token_unique").on(t.token),index("auth_sessions_user").on(t.userId)]);
export const authAccounts = sqliteTable("auth_accounts", {
  id:text("id").primaryKey(), accountId:text("account_id").notNull(), providerId:text("provider_id").notNull(),
  userId:text("user_id").notNull().references(()=>authUsers.id,{onDelete:"cascade"}), accessToken:text("access_token"), refreshToken:text("refresh_token"), idToken:text("id_token"),
  accessTokenExpiresAt:integer("access_token_expires_at",{mode:"timestamp_ms"}),refreshTokenExpiresAt:integer("refresh_token_expires_at",{mode:"timestamp_ms"}),scope:text("scope"),password:text("password"),
  createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull(),updatedAt:integer("updated_at",{mode:"timestamp_ms"}).notNull(),
},t=>[index("auth_accounts_user").on(t.userId),uniqueIndex("auth_accounts_provider_unique").on(t.providerId,t.accountId)]);
export const authVerifications = sqliteTable("auth_verifications", {
  id:text("id").primaryKey(),identifier:text("identifier").notNull(),value:text("value").notNull(),
  expiresAt:integer("expires_at",{mode:"timestamp_ms"}).notNull(),createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull(),updatedAt:integer("updated_at",{mode:"timestamp_ms"}).notNull(),
},t=>[index("auth_verifications_identifier").on(t.identifier)]);
export const authRateLimits = sqliteTable("auth_rate_limits", {
  id:text("id").primaryKey(),key:text("key").notNull(),count:integer("count").notNull(),lastRequest:integer("last_request").notNull(),
},t=>[uniqueIndex("auth_rate_limits_key_unique").on(t.key)]);
export const authProfileLinks = sqliteTable("auth_profile_links", {
  authUserId:text("auth_user_id").primaryKey().references(()=>authUsers.id,{onDelete:"cascade"}),
  profileId:text("profile_id").notNull().references(()=>profiles.id),createdAt:text("created_at").notNull(),
},t=>[uniqueIndex("auth_profile_links_profile_unique").on(t.profileId)]);
export const authEmailSendLimits = sqliteTable("auth_email_send_limits", {
  emailHash:text("email_hash").primaryKey(),lastSentAt:integer("last_sent_at").notNull(),
},t=>[index("auth_email_send_limits_updated").on(t.lastSentAt)]);
export const emailAuthSchema={user:authUsers,session:authSessions,account:authAccounts,verification:authVerifications,rateLimit:authRateLimits};
