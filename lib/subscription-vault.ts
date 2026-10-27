import type { BureauDatabase, BureauUser } from "./bureau-api";
import { AccessError, isSiteAccessAdmin, requireApprovedSiteAccess, type AccessEnv } from "./access";
import { membershipIsActive } from "./membership-policy";

/** Server-side only: the encryption key is supplied by the hosted runtime. */
export type SubscriptionVaultEnv = AccessEnv & {
  VAULT_ENCRYPTION_KEY?: string;
  VAULT_DEFAULT_LOGIN_EMAIL?: string;
  VAULT_BANK_ACCOUNT_ID?: string;
};
export type ServiceCredentials = { email: string; password: string };
export type SealedCredentials = { encryptionVersion: 1; iv: string; ciphertext: string };
export type VaultState = {
  configured: boolean;
  canManage: boolean;
  canReveal: boolean;
  hasCredentials: boolean;
  paymentRequired: boolean;
  joined: boolean;
  defaultEmail: string | null;
  period: string;
  updatedAt: string | null;
  restriction: "unconfigured" | "membership" | "payment" | "missing_credentials" | null;
};
type SubscriptionContext = { id: string; workspace_id: string; owner_id: string; role: string; membership_status: string | null; cancellation_effective_at: string | null };
type CredentialRow = { subscription_id: string; encryption_version: number; iv: string; ciphertext: string; revision: number; updated_at: string };
type VaultClock = () => Date;
class VaultError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const VERSION = 1;
const BODY_LIMIT = 8192;
const encoder = new TextEncoder();
const clock: VaultClock = () => new Date();
const monthlyParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit" });

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: {
    "Cache-Control": "private, no-store", "Pragma": "no-cache", "Expires": "0",
    "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, noarchive",
  } });
}
function periodAt(at: Date): string {
  const parts = Object.fromEntries(monthlyParts.formatToParts(at).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}`;
}
function base64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
function unbase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid encoding");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (base64(bytes) !== value) throw new Error("Invalid encoding");
  return bytes;
}
function keyBytes(value: string | undefined): Uint8Array | null {
  try {
    const input = value?.trim();
    if (!input) return null;
    const bytes = /^[a-f\d]{64}$/i.test(input)
      ? Uint8Array.from(input.match(/../g)!, part => parseInt(part, 16))
      : unbase64(input);
    return bytes.length === 32 ? bytes : null;
  } catch { return null; }
}
export function subscriptionVaultConfigured(env: SubscriptionVaultEnv): boolean {
  return !!keyBytes(env.VAULT_ENCRYPTION_KEY) && !!globalThis.crypto?.subtle && typeof globalThis.crypto.getRandomValues === "function";
}
async function encryptionKey(env: SubscriptionVaultEnv): Promise<CryptoKey> {
  const bytes = keyBytes(env.VAULT_ENCRYPTION_KEY);
  if (!bytes || !globalThis.crypto?.subtle) throw new VaultError(503, "VAULT_UNAVAILABLE", "Le coffre des identifiants n’est pas encore raccordé.");
  return crypto.subtle.importKey("raw", bytes.buffer as ArrayBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
function aad(subscriptionId: string): ArrayBuffer {
  return encoder.encode(`embrasse:subscription-vault:v${VERSION}:${subscriptionId}`).buffer as ArrayBuffer;
}
function validEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  return email.length <= 254 && /^[^\s@<>\u0000-\u001f\u007f]+@[^\s@<>\u0000-\u001f\u007f]+\.[^\s@<>\u0000-\u001f\u007f]+$/.test(email) ? email : null;
}
function credentialsInput(data: Record<string, unknown>): ServiceCredentials {
  if (Object.keys(data).some(key => key !== "email" && key !== "password")) throw new VaultError(400, "INVALID_CREDENTIALS", "Indiquez uniquement l’e-mail et le mot de passe du service.");
  const email = validEmail(data.email);
  if (!email) throw new VaultError(400, "INVALID_EMAIL", "Indiquez une adresse e-mail valide pour le service.");
  if (typeof data.password !== "string" || data.password.length < 12 || data.password.length > 512 || /[\u0000-\u001f\u007f]/.test(data.password)) {
    throw new VaultError(400, "INVALID_PASSWORD", "Le mot de passe du service doit contenir de 12 à 512 caractères, sans retour à la ligne.");
  }
  return { email, password: data.password };
}

/** AES-GCM authenticates both the payload and the subscription/version binding. */
export async function sealServiceCredentials(subscriptionId: string, credentials: ServiceCredentials, env: SubscriptionVaultEnv): Promise<SealedCredentials> {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer, additionalData: aad(subscriptionId), tagLength: 128 }, key, plaintext.buffer as ArrayBuffer);
  return { encryptionVersion: VERSION, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}
export async function openServiceCredentials(subscriptionId: string, sealed: { encryption_version: number; iv: string; ciphertext: string }, env: SubscriptionVaultEnv): Promise<ServiceCredentials> {
  try {
    if (sealed.encryption_version !== VERSION || sealed.ciphertext.length > BODY_LIMIT) throw new Error("Invalid envelope");
    const iv = unbase64(sealed.iv), ciphertext = unbase64(sealed.ciphertext);
    if (iv.length !== 12 || ciphertext.length < 16) throw new Error("Invalid envelope");
    const key = await encryptionKey(env);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer, additionalData: aad(subscriptionId), tagLength: 128 }, key, ciphertext.buffer as ArrayBuffer);
    return credentialsInput(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as Record<string, unknown>);
  } catch {
    // Never forward cryptographic errors, ciphertext, keys or credential input.
    throw new VaultError(503, "VAULT_UNAVAILABLE", "Les identifiants sont momentanément indisponibles. Contactez le responsable du cercle.");
  }
}

async function context(db: BureauDatabase, subscriptionId: string, user: BureauUser): Promise<SubscriptionContext> {
  const row = await db.prepare("SELECT s.id,s.workspace_id,s.owner_id,wm.role,sm.status AS membership_status,sm.cancellation_effective_at FROM subscriptions s JOIN workspace_members wm ON wm.workspace_id=s.workspace_id AND wm.user_id=? LEFT JOIN subscription_members sm ON sm.subscription_id=s.id AND sm.user_id=? WHERE s.id=? AND s.archived=0")
    .bind(user.id, user.id, subscriptionId).first<SubscriptionContext>();
  if (!row) throw new VaultError(404, "VAULT_NOT_FOUND", "Cet abonnement est introuvable dans vos cercles.");
  return row;
}
const isManager = (row: SubscriptionContext, user: BureauUser) => row.owner_id === user.id || row.role === "admin";
function isJoined(row: SubscriptionContext, at: Date): boolean {
  return membershipIsActive(row.membership_status ?? "", row.cancellation_effective_at, at);
}

// A provider's paid invoice is insufficient: funds must also be booked in the
// expected bank account by a trusted server-side reconciliation service.
const paidAccessSql = `EXISTS (
 SELECT 1 FROM billing_cycles c
 JOIN billing_allocations a ON a.cycle_id=c.id AND a.subscription_id=s.id AND a.user_id=?
 JOIN billing_invoices i ON i.cycle_id=c.id AND i.user_id=a.user_id
 JOIN billing_bank_receipts r ON r.invoice_id=i.id
 WHERE c.workspace_id=s.workspace_id AND c.mode='live' AND c.period=?
 AND a.amount_cents>0 AND i.amount_cents>=a.amount_cents AND i.status='paid'
 AND i.paid_cents>=i.amount_cents AND i.refunded_cents=0
 AND i.stripe_invoice_id IS NOT NULL AND i.stripe_payment_intent_id IS NOT NULL
 AND length(trim(r.bank_account_id))>0 AND r.bank_account_id=?
 AND trim(r.bank_provider,char(9)||char(10)||char(11)||char(12)||char(13)||' ')<>''
 AND trim(r.bank_entry_reference,char(9)||char(10)||char(11)||char(12)||char(13)||' ')<>''
 AND r.currency='EUR' AND r.status='booked'
 AND typeof(r.booked_amount_cents)='integer' AND r.booked_amount_cents>=i.amount_cents
 AND julianday(r.booked_at)<=julianday(?) AND julianday(r.verified_at)<=julianday(?)
)`;
function paidAccessBindings(userId: string, period: string, env: SubscriptionVaultEnv, at: Date): unknown[] {
  const candidate = env.VAULT_BANK_ACCOUNT_ID?.trim() ?? "";
  const accountId = candidate.length <= 512 && !/[\u0000-\u001f\u007f]/.test(candidate) ? candidate : "";
  return [userId, period, accountId, at.toISOString(), at.toISOString()];
}
async function hasPaidAccess(db: BureauDatabase, subscriptionId: string, userId: string, period: string, env: SubscriptionVaultEnv, at: Date): Promise<boolean> {
  const paid = await db.prepare(`SELECT s.id FROM subscriptions s WHERE s.id=? AND ${paidAccessSql}`)
    .bind(subscriptionId, ...paidAccessBindings(userId, period, env, at)).first();
  return !!paid;
}
function accessGate(env: SubscriptionVaultEnv, user: BureauUser): [number, number, string] {
  return [env.ACCESS_CONTROL_ENABLED === "true" ? 1 : 0, isSiteAccessAdmin(user.id, env) ? 1 : 0, user.id];
}
const accessGateSql = "(?=0 OR ?=1 OR EXISTS(SELECT 1 FROM site_access_requests ar WHERE ar.user_id=? AND ar.status='approved'))";
const managerSql = "(s.owner_id=? OR wm.role='admin')";
function managerBindings(subscriptionId: string, user: BureauUser, env: SubscriptionVaultEnv): unknown[] {
  return [user.id, subscriptionId, user.id, ...accessGate(env, user)];
}
const managerSelect = `FROM subscriptions s JOIN workspace_members wm ON wm.workspace_id=s.workspace_id AND wm.user_id=? WHERE s.id=? AND s.archived=0 AND ${managerSql} AND ${accessGateSql}`;

async function state(db: BureauDatabase, subscriptionId: string, user: BureauUser, env: SubscriptionVaultEnv, at: Date): Promise<Response> {
  const row = await context(db, subscriptionId, user), canManage = isManager(row, user), joined = isJoined(row, at), period = periodAt(at);
  const stored = await db.prepare("SELECT updated_at FROM subscription_credentials WHERE subscription_id=?").bind(subscriptionId).first<{ updated_at: string }>();
  const paid = !canManage && joined ? await hasPaidAccess(db, subscriptionId, user.id, period, env, at) : false;
  const configured = subscriptionVaultConfigured(env), hasCredentials = !!stored;
  const eligible = canManage || (joined && paid);
  const result: VaultState = {
    configured, canManage, canReveal: configured && hasCredentials && eligible, hasCredentials,
    paymentRequired: !canManage && joined && !paid, joined,
    defaultEmail: canManage ? validEmail(env.VAULT_DEFAULT_LOGIN_EMAIL) : null,
    period, updatedAt: stored?.updated_at ?? null,
    restriction: !configured ? "unconfigured" : !canManage && !joined ? "membership" : !eligible ? "payment" : !hasCredentials ? "missing_credentials" : null,
  };
  return json(result);
}
async function consumeBudget(db: BureauDatabase, userId: string, at: Date): Promise<void> {
  const bucket = Math.floor(at.getTime() / 3_600_000);
  const result = await db.prepare("INSERT INTO api_write_budgets (user_id,bucket,count) VALUES (?,?,1) ON CONFLICT(user_id,bucket) DO UPDATE SET count=count+1 WHERE count<100").bind(userId, bucket).run();
  if (!result.meta.changes) throw new VaultError(429, "VAULT_RATE_LIMITED", "Trop de demandes en une heure. Réessayez un peu plus tard.");
  await db.prepare("DELETE FROM api_write_budgets WHERE bucket<?").bind(bucket - 48).run();
}
function requireOrigin(request: Request): void {
  if (request.headers.get("Origin") !== new URL(request.url).origin) throw new VaultError(403, "INVALID_ORIGIN", "Origine de la requête non autorisée.");
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new VaultError(415, "JSON_REQUIRED", "Format JSON requis.");
  if (Number(request.headers.get("Content-Length")) > BODY_LIMIT) throw new VaultError(413, "BODY_TOO_LARGE", "Requête trop volumineuse.");
  const reader = request.body?.getReader();
  let raw = "", size = 0;
  if (reader) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > BODY_LIMIT) { await reader.cancel(); throw new VaultError(413, "BODY_TOO_LARGE", "Requête trop volumineuse."); }
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(400, "INVALID_JSON", "Données invalides.");
    } finally { reader.releaseLock(); }
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid data");
    return data;
  } catch { throw new VaultError(400, "INVALID_JSON", "Données invalides."); }
}
function changed(result: unknown): boolean {
  return !!(result as { meta?: { changes?: number } } | undefined)?.meta?.changes;
}

async function save(db: BureauDatabase, subscriptionId: string, user: BureauUser, env: SubscriptionVaultEnv, data: Record<string, unknown>, getNow: VaultClock): Promise<Response> {
  const row = await context(db, subscriptionId, user);
  if (!isManager(row, user)) throw new VaultError(403, "VAULT_MANAGER_REQUIRED", "Seul le responsable peut modifier les identifiants de ce service.");
  if (!subscriptionVaultConfigured(env)) throw new VaultError(503, "VAULT_UNAVAILABLE", "Le coffre des identifiants n’est pas encore raccordé.");
  const sealed = await sealServiceCredentials(subscriptionId, credentialsInput(data), env), updatedAt = getNow().toISOString();
  const results = await db.batch([
    db.prepare(`INSERT INTO subscription_credentials (subscription_id,encryption_version,iv,ciphertext,revision,updated_at,updated_by) SELECT s.id,?,?,?,?,?,? ${managerSelect} ON CONFLICT(subscription_id) DO UPDATE SET encryption_version=excluded.encryption_version,iv=excluded.iv,ciphertext=excluded.ciphertext,revision=subscription_credentials.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(sealed.encryptionVersion, sealed.iv, sealed.ciphertext, 1, updatedAt, user.id, ...managerBindings(subscriptionId, user, env)),
    db.prepare("INSERT INTO subscription_vault_events (id,subscription_id,actor_id,action,created_at) SELECT ?,?,?,'updated',? WHERE changes()=1")
      .bind(crypto.randomUUID(), subscriptionId, user.id, updatedAt),
  ]);
  if (!changed(results[0])) throw new VaultError(403, "VAULT_ACCESS_CHANGED", "Vos droits sur cet abonnement ont changé. Rechargez le cercle.");
  return json({ ok: true, updatedAt });
}
async function reveal(db: BureauDatabase, subscriptionId: string, user: BureauUser, env: SubscriptionVaultEnv, getNow: VaultClock): Promise<Response> {
  const row = await context(db, subscriptionId, user), at = getNow(), manager = isManager(row, user);
  if (!manager && !isJoined(row, at)) throw new VaultError(403, "VAULT_MEMBERSHIP_REQUIRED", "Rejoignez cet abonnement avant de demander ses identifiants.");
  if (!manager && !await hasPaidAccess(db, subscriptionId, user.id, periodAt(at), env, at)) throw new VaultError(403, "VAULT_PAYMENT_REQUIRED", "La réception de votre cotisation sur le compte commun doit être confirmée avant l’accès aux identifiants.");
  if (!subscriptionVaultConfigured(env)) throw new VaultError(503, "VAULT_UNAVAILABLE", "Le coffre des identifiants n’est pas encore raccordé.");
  const stored = await db.prepare("SELECT subscription_id,encryption_version,iv,ciphertext,revision,updated_at FROM subscription_credentials WHERE subscription_id=?").bind(subscriptionId).first<CredentialRow>();
  if (!stored) throw new VaultError(404, "VAULT_EMPTY", "Le responsable n’a pas encore ajouté les identifiants du service.");
  const credentials = await openServiceCredentials(subscriptionId, stored, env);
  const finalAt = getNow(), timestamp = finalAt.toISOString();
  // This final atomic guard runs AFTER decryption: departing, losing a role, a
  // refund, the Paris month boundary or a credential rotation all revoke this read.
  const result = await db.prepare(`INSERT INTO subscription_vault_events (id,subscription_id,actor_id,action,created_at)
    SELECT ?,s.id,?,'revealed',? FROM subscriptions s
    JOIN workspace_members wm ON wm.workspace_id=s.workspace_id AND wm.user_id=?
    JOIN subscription_credentials v ON v.subscription_id=s.id
    WHERE s.id=? AND s.archived=0 AND v.revision=? AND v.iv=? AND v.ciphertext=? AND v.encryption_version=? AND ${accessGateSql}
    AND (${managerSql} OR (EXISTS(SELECT 1 FROM subscription_members sm WHERE sm.subscription_id=s.id AND sm.user_id=? AND sm.status='active' AND (sm.cancellation_effective_at IS NULL OR sm.cancellation_effective_at>?)) AND ${paidAccessSql}))`)
    .bind(crypto.randomUUID(), user.id, timestamp, user.id, subscriptionId, stored.revision, stored.iv, stored.ciphertext, stored.encryption_version, ...accessGate(env, user), user.id, user.id, timestamp, ...paidAccessBindings(user.id, periodAt(finalAt), env, finalAt)).run();
  if (!changed(result)) throw new VaultError(403, "VAULT_ACCESS_CHANGED", "Votre accès ou les identifiants ont changé. Rechargez le cercle avant de réessayer.");
  return json({ ...credentials, updatedAt: stored.updated_at });
}
async function remove(db: BureauDatabase, subscriptionId: string, user: BureauUser, env: SubscriptionVaultEnv, getNow: VaultClock): Promise<Response> {
  const row = await context(db, subscriptionId, user);
  if (!isManager(row, user)) throw new VaultError(403, "VAULT_MANAGER_REQUIRED", "Seul le responsable peut supprimer les identifiants de ce service.");
  const timestamp = getNow().toISOString();
  const results = await db.batch([
    db.prepare(`INSERT INTO subscription_vault_events (id,subscription_id,actor_id,action,created_at) SELECT ?,s.id,?,'deleted',? ${managerSelect}`)
      .bind(crypto.randomUUID(), user.id, timestamp, ...managerBindings(subscriptionId, user, env)),
    db.prepare("DELETE FROM subscription_credentials WHERE subscription_id=? AND changes()=1").bind(subscriptionId),
  ]);
  if (!changed(results[0])) throw new VaultError(403, "VAULT_ACCESS_CHANGED", "Vos droits sur cet abonnement ont changé. Rechargez le cercle.");
  return json({ ok: true });
}

/** Identity MUST be resolved by the authenticated route; request headers are never trusted here. */
export async function handleSubscriptionVaultRequest(request: Request, db: BureauDatabase, env: SubscriptionVaultEnv = {}, user: BureauUser | null = null, getNow: VaultClock = clock): Promise<Response> {
  try {
    if (!user) throw new VaultError(401, "AUTH_REQUIRED", "Connectez-vous pour continuer.");
    await requireApprovedSiteAccess(db, user, env);
    const url = new URL(request.url), parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "vault" || parts[2] !== "subscriptions" || parts.length > 5 || url.search) throw new VaultError(404, "VAULT_NOT_FOUND", "Cette page du coffre est introuvable.");
    let subscriptionId: string;
    try { subscriptionId = decodeURIComponent(parts[3]); } catch { throw new VaultError(400, "INVALID_SUBSCRIPTION", "Abonnement invalide."); }
    if (!/^[A-Za-z\d_-]{1,200}$/.test(subscriptionId)) throw new VaultError(400, "INVALID_SUBSCRIPTION", "Abonnement invalide.");
    if (request.method === "GET" && parts.length === 4) {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) throw new VaultError(403, "INVALID_ORIGIN", "Origine de la requête non autorisée.");
      return await state(db, subscriptionId, user, env, getNow());
    }
    requireOrigin(request);
    const action = parts[4];
    if (!((request.method === "POST" && action === "reveal") || (["PUT", "POST", "DELETE"].includes(request.method) && action === "credentials"))) throw new VaultError(405, "METHOD_NOT_ALLOWED", "Méthode non autorisée.");
    // Check the tenant before consuming budget or reading a credential body.
    await context(db, subscriptionId, user);
    await consumeBudget(db, user.id, getNow());
    if (request.method === "DELETE") return await remove(db, subscriptionId, user, env, getNow);
    const data = await body(request);
    if (action === "reveal") {
      if (Object.keys(data).length) throw new VaultError(400, "INVALID_REVEAL", "Cette demande ne doit pas contenir d’identifiants ni de statut de paiement.");
      return await reveal(db, subscriptionId, user, env, getNow);
    }
    return await save(db, subscriptionId, user, env, data, getNow);
  } catch (error) {
    if (error instanceof VaultError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof AccessError) return json({ error: error.message, code: "SITE_ACCESS_REQUIRED" }, error.status);
    return json({ error: "Le coffre est momentanément indisponible. Réessayez dans un instant.", code: "VAULT_REQUEST_FAILED" }, 503);
  }
}
