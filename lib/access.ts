import type { BureauDatabase, BureauUser } from "./bureau-api";

export type AccessEnv = {
  ACCESS_CONTROL_ENABLED?: string;
  ACCESS_ADMIN_USER_IDS?: string;
  ACCESS_DEFAULT_WORKSPACE_ID?: string;
  ADMIN_NOTIFICATION_EMAIL?: string;
  NOTIFICATIONS_DELIVERY_ENABLED?: string;
  NOTIFICATIONS_WORKER_SECRET?: string;
  NOTIFICATIONS_GOOGLE_AUDIENCE?: string;
  NOTIFICATIONS_GOOGLE_EMAIL?: string;
};
export type SiteAccess = {
  enabled: boolean;
  status: "anonymous" | "unrequested" | "pending" | "approved" | "rejected";
  isAdmin: boolean;
  requestedAt: string | null;
  updatedAt: string | null;
  reason: string | null;
  notificationEmailConfigured: boolean;
};
export class AccessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function isSiteAccessAdmin(userId: string, env: AccessEnv): boolean {
  return (env.ACCESS_ADMIN_USER_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean).includes(userId);
}
export function adminNotificationEmail(env: AccessEnv): string | null {
  const email = (env.ADMIN_NOTIFICATION_EMAIL ?? "").trim();
  return email.length <= 254 && /^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(email) ? email : null;
}
export function notificationsConfigured(env: AccessEnv): boolean {
  return !!adminNotificationEmail(env) && env.NOTIFICATIONS_DELIVERY_ENABLED === "true" && !!env.NOTIFICATIONS_GOOGLE_AUDIENCE?.trim() && !!adminNotificationEmail({ADMIN_NOTIFICATION_EMAIL:env.NOTIFICATIONS_GOOGLE_EMAIL});
}
export async function getSiteAccess(db: BureauDatabase, user: BureauUser | null, env: AccessEnv = {}): Promise<SiteAccess> {
  const base: SiteAccess = { enabled: env.ACCESS_CONTROL_ENABLED === "true", status: "anonymous", isAdmin: false, requestedAt: null, updatedAt: null, reason: null, notificationEmailConfigured: notificationsConfigured(env) };
  if (!user) return base;
  const isAdmin = isSiteAccessAdmin(user.id, env);
  if (isAdmin || !base.enabled) return { ...base, status: "approved", isAdmin };
  const row = await db.prepare("SELECT status,reason,created_at,updated_at FROM site_access_requests WHERE user_id=?").bind(user.id).first<{status:"pending"|"approved"|"rejected";reason:string;created_at:string;updated_at:string}>();
  return { ...base, status: row?.status ?? "unrequested", requestedAt: row?.created_at ?? null, updatedAt: row?.updated_at ?? null, reason: row?.reason ?? null };
}
export async function requireApprovedSiteAccess(db: BureauDatabase, user: BureauUser | null, env: AccessEnv = {}): Promise<SiteAccess> {
  if (!user) throw new AccessError(401, "Connectez-vous pour continuer.");
  const access = await getSiteAccess(db, user, env);
  if (access.status !== "approved") throw new AccessError(403, "Votre accès doit être approuvé avant de rejoindre le cercle.");
  return access;
}
export function requireSiteAccessAdmin(user: BureauUser | null, env: AccessEnv): void {
  if (!user) throw new AccessError(401, "Connectez-vous pour continuer.");
  if (!isSiteAccessAdmin(user.id, env)) throw new AccessError(403, "Seul le responsable des accès peut réaliser cette action.");
}
