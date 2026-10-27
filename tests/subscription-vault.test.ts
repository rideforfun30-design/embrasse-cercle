import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { handleSubscriptionVaultRequest, openServiceCredentials, sealServiceCredentials, subscriptionVaultConfigured, type SubscriptionVaultEnv } from "../lib/subscription-vault";
import { handleBureauRequest, type BureauDatabase, type BureauUser, type SqlStatement } from "../lib/bureau-api";

class LocalD1 implements BureauDatabase {
  sqlite = new DatabaseSync(":memory:");
  beforeRun: ((sql: string) => void) | null = null;
  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys=ON");
    for (const file of readdirSync(new URL("../drizzle", import.meta.url)).filter(p => p.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
    }
  }
  prepare(sql: string): SqlStatement {
    const owner = this, db = this.sqlite;
    let values: unknown[] = [];
    const statement: SqlStatement = {
      bind(...v) { values = v; return statement; },
      async first<T>() { return (db.prepare(sql).get(...values as (string | number | null)[]) ?? null) as T | null; },
      async all<T>() { return { results: db.prepare(sql).all(...values as (string | number | null)[]) as T[] }; },
      async run() { owner.beforeRun?.(sql); return { meta: { changes: Number(db.prepare(sql).run(...values as (string | number | null)[]).changes) } }; },
    };
    return statement;
  }
  async batch(statements: SqlStatement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
}
const NOW = new Date("2026-11-10T10:00:00.000Z");
const ORIGIN = "https://app.example.test";
const KEY = "a7".repeat(32); // Public fixture; never a production key.
const config: SubscriptionVaultEnv = { ACCESS_CONTROL_ENABLED: "false", VAULT_ENCRYPTION_KEY: KEY, VAULT_DEFAULT_LOGIN_EMAIL: "shared@example.test", VAULT_BANK_ACCOUNT_ID: "bank-fixture-expected" };
const credentials = { email: "service@example.test", password: "  Cactus-Velours-Papaye-3427!  " };
const person = (id: string): BureauUser => ({ id, name: id, email: `${id}@example.test` });
function seed(): LocalD1 {
  const db = new LocalD1();
  for (const id of ["owner", "manager", "alice", "bob", "outsider"]) db.sqlite.prepare("INSERT INTO profiles(id,name,email,created_at) VALUES(?,?,?,?)").run(id, id, `${id}@example.test`, NOW.toISOString());
  db.sqlite.exec("INSERT INTO workspaces(id,name,owner_id,invite_code,created_at) VALUES('w','Circle','owner','invite-w','2026-01-01'),('foreign','Other','outsider','invite-other','2026-01-01');");
  for (const [space, user, role] of [["w", "owner", "admin"], ["w", "manager", "admin"], ["w", "alice", "member"], ["w", "bob", "member"], ["foreign", "outsider", "admin"]]) db.sqlite.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,joined_at) VALUES(?,?,?,?)").run(space, user, role, NOW.toISOString());
  for (const [id, space, owner] of [["s", "w", "owner"], ["other-service", "foreign", "outsider"]]) db.sqlite.prepare("INSERT INTO subscriptions(id,workspace_id,owner_id,name,category,total_cents,max_seats,next_due_date,created_at) VALUES(?,?,?,'Test service','Autre',1000,4,'2026-12-01',?)").run(id, space, owner, NOW.toISOString());
  for (const [user, status] of [["owner", "active"], ["alice", "active"], ["bob", "pending"]]) db.sqlite.prepare("INSERT INTO subscription_members(subscription_id,user_id,status,joined_at) VALUES('s',?,?,?)").run(user, status, NOW.toISOString());
  return db;
}
function bankReceipt(db: LocalD1, invoiceId: string, changes: Record<string, string | number> = {}) {
  const row = { provider: "fixture_bank", account: "bank-fixture-expected", entry: `entry-${invoiceId}`, amount: 500, currency: "EUR", status: "booked", bookedAt: "2026-01-01T00:00:00.000Z", verifiedAt: "2026-01-01T00:00:00.000Z", ...changes };
  db.sqlite.prepare("INSERT INTO billing_bank_receipts(invoice_id,bank_provider,bank_account_id,bank_entry_reference,booked_amount_cents,currency,status,booked_at,verified_at) VALUES(?,?,?,?,?,?,?,?,?)").run(invoiceId, row.provider, row.account, row.entry, row.amount, row.currency, row.status, row.bookedAt, row.verifiedAt);
}
function paid(db: LocalD1, user = "alice", mode = "live", period = "2026-11", subscriptionId = "s", workspaceId = "w", withBankReceipt = true) {
  const cycleId = `${mode}-${period}-${workspaceId}`;
  db.sqlite.prepare("INSERT INTO billing_cycles(id,workspace_id,period,mode,status,frozen_at) VALUES(?,?,?,?,'complete',?) ON CONFLICT(id) DO NOTHING").run(cycleId, workspaceId, period, mode, NOW.toISOString());
  db.sqlite.prepare("INSERT INTO billing_allocations(cycle_id,subscription_id,subscription_name,user_id,amount_cents) VALUES(?,?,'Fixture',?,500)").run(cycleId, subscriptionId, user);
  db.sqlite.prepare("INSERT INTO billing_invoices(id,cycle_id,user_id,amount_cents,status,stripe_invoice_id,stripe_payment_intent_id,paid_cents,refunded_cents,updated_at) VALUES(?,?,?,500,'paid',?,?,500,0,?)").run(`invoice-${cycleId}-${user}`, cycleId, user, `in_fixture_${cycleId}_${user}`, `pi_fixture_${cycleId}_${user}`, NOW.toISOString());
  const invoiceId = `invoice-${cycleId}-${user}`;
  if (withBankReceipt) bankReceipt(db, invoiceId);
  return invoiceId;
}
async function api(db: LocalD1, id: string | null, path = "subscriptions/s", method = "GET", data?: unknown, env = config, getNow: () => Date = () => NOW, customHeaders: Record<string, string> = {}) {
  const request = new Request(`${ORIGIN}/api/vault/${path}`, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...customHeaders }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const response = await handleSubscriptionVaultRequest(request, db, env, id ? person(id) : null, getNow);
  const text = await response.text();
  return { status: response.status, data: JSON.parse(text), text, headers: response.headers };
}
const save = (db: LocalD1, data = credentials, actor = "owner", env = config) => api(db, actor, "subscriptions/s/credentials", "PUT", data, env);

test("vault seals credentials with a dedicated non-exportable AES key, unique IV and subscription-bound authentication", async () => {
  const one = await sealServiceCredentials("s", credentials, config), two = await sealServiceCredentials("s", credentials, config);
  assert.notEqual(one.iv, two.iv); assert.notEqual(one.ciphertext, two.ciphertext);
  assert.equal(one.encryptionVersion, 1);
  const stored = { encryption_version: 1, ...one };
  assert.deepEqual(await openServiceCredentials("s", stored, config), credentials);
  assert.doesNotMatch(JSON.stringify(one), /service@example|Cactus|Velours/);
  await assert.rejects(() => openServiceCredentials("other-service", stored, config), /momentanément indisponibles/);
  await assert.rejects(() => openServiceCredentials("s", stored, { ...config, VAULT_ENCRYPTION_KEY: "b8".repeat(32) }), /momentanément indisponibles/);
  await assert.rejects(() => openServiceCredentials("s", { ...stored, encryption_version: 2 }, config), /momentanément indisponibles/);
  const modified = Buffer.from(one.ciphertext, "base64"); modified[0] ^= 1;
  await assert.rejects(() => openServiceCredentials("s", { ...stored, ciphertext: modified.toString("base64") }, config), /momentanément indisponibles/);
});

test("missing or malformed vault key fails closed and is never substituted with the auth secret", async () => {
  for (const key of [undefined, "", "short", "f".repeat(63), Buffer.alloc(31).toString("base64"), "not-base64!"]) assert.equal(subscriptionVaultConfigured({ VAULT_ENCRYPTION_KEY: key }), false);
  assert.equal(subscriptionVaultConfigured({ VAULT_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString("base64") }), true);
  const db = seed(), missing: SubscriptionVaultEnv = { ACCESS_CONTROL_ENABLED: "false" };
  const metadata = await api(db, "owner", "subscriptions/s", "GET", undefined, missing);
  assert.equal(metadata.data.configured, false); assert.equal(metadata.data.canReveal, false); assert.equal(metadata.data.restriction, "unconfigured");
  assert.equal((await save(db, credentials, "owner", missing)).status, 503);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM subscription_credentials").get()?.n, 0);
});

test("only a subscription manager can store or replace credentials, and SQL stores no plaintext", async () => {
  const db = seed();
  assert.equal((await save(db, credentials, "alice")).status, 403);
  assert.equal((await save(db, credentials, "outsider")).status, 404);
  const created = await save(db); assert.equal(created.status, 200); assert.deepEqual(Object.keys(created.data).sort(), ["ok", "updatedAt"]);
  const stored = db.sqlite.prepare("SELECT * FROM subscription_credentials").get() as any;
  assert.equal(stored.revision, 1); assert.equal(stored.updated_by, "owner");
  assert.ok(!Object.keys(stored).includes("email") && !Object.keys(stored).includes("password"));
  assert.ok(!JSON.stringify(stored).includes(credentials.password)); assert.ok(!JSON.stringify(stored).includes(credentials.email));
  assert.equal((await api(db, "owner", "subscriptions/s/reveal", "POST", {})).data.password, credentials.password, "intentional spaces are preserved");
  const replacement = { email: " other@example.test ", password: "Nouvelle-Phrase-Longue-0000!" };
  assert.equal((await save(db, replacement, "manager")).status, 200);
  assert.equal(db.sqlite.prepare("SELECT revision FROM subscription_credentials").get()?.revision, 2);
  const read = await api(db, "manager", "subscriptions/s/reveal", "POST", {});
  assert.deepEqual(read.data, { email: "other@example.test", password: replacement.password, updatedAt: NOW.toISOString() });
});

test("metadata and general application state never contain credentials or encrypted envelopes", async () => {
  const db = seed(); await save(db); paid(db);
  for (const user of ["owner", "manager", "alice", "bob"]) {
    const metadata = await api(db, user);
    assert.equal(metadata.status, 200); assert.ok(metadata.data.hasCredentials);
    assert.equal("email" in metadata.data, false); assert.equal("password" in metadata.data, false); assert.equal("ciphertext" in metadata.data, false); assert.equal("iv" in metadata.data, false);
    assert.ok(!metadata.text.includes(credentials.email)); assert.ok(!metadata.text.includes(credentials.password));
    assert.equal(metadata.data.defaultEmail, ["owner", "manager"].includes(user) ? "shared@example.test" : null);
  }
  const general = await handleBureauRequest(new Request(`${ORIGIN}/api/state`), db, config, person("alice"));
  const generalText = await general.text();
  assert.ok(!generalText.includes(credentials.email)); assert.ok(!generalText.includes(credentials.password)); assert.ok(!generalText.includes("ciphertext"));
});

test("a participant must be active and have a fully reconciled live allocation for the current Paris period", async () => {
  const db = seed(); await save(db);
  const unpaid = await api(db, "alice"); assert.equal(unpaid.data.joined, true); assert.equal(unpaid.data.paymentRequired, true); assert.equal(unpaid.data.canReveal, false);
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {})).status, 403);
  paid(db, "alice", "test");
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {})).status, 403);
  paid(db, "alice", "live", "2026-10");
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {})).status, 403);
  paid(db);
  const eligible = await api(db, "alice"); assert.equal(eligible.data.canReveal, true); assert.equal(eligible.data.paymentRequired, false);
  const read = await api(db, "alice", "subscriptions/s/reveal", "POST", {}); assert.equal(read.status, 200); assert.equal(read.data.password, credentials.password);
  paid(db, "bob");
  assert.equal((await api(db, "bob", "subscriptions/s/reveal", "POST", {})).status, 403, "pending member cannot use a paid receipt");
  db.sqlite.exec("UPDATE subscription_members SET cancellation_effective_at='2026-11-10T09:59:59.999Z' WHERE user_id='alice'");
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {})).status, 403);
  db.sqlite.exec("UPDATE subscription_members SET cancellation_effective_at='2026-11-10T10:00:00.001Z' WHERE user_id='alice'");
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {})).status, 200, "notice stays active until its effective instant");
});

test("partial, refunded, disputed, manual-review or unproven invoices do not unlock a participant", async () => {
  const db = seed(); await save(db); paid(db);
  const invoice = "invoice-live-2026-11-w-alice";
  for (const values of [
    ["open", 500, 0, "in_fixture", "pi_fixture"], ["draft", 500, 0, "in_fixture", "pi_fixture"], ["manual_review", 500, 0, "in_fixture", "pi_fixture"],
    ["disputed", 500, 0, "in_fixture", "pi_fixture"], ["paid", 499, 0, "in_fixture", "pi_fixture"], ["paid", 500, 1, "in_fixture", "pi_fixture"],
    ["paid", 500, 0, null, "pi_fixture"], ["paid", 500, 0, "in_fixture", null],
  ]) {
    db.sqlite.prepare("UPDATE billing_invoices SET status=?,paid_cents=?,refunded_cents=?,stripe_invoice_id=?,stripe_payment_intent_id=? WHERE id=?").run(...values as (string | number | null)[], invoice);
    const result = await api(db, "alice", "subscriptions/s/reveal", "POST", {}); assert.equal(result.status, 403);
    assert.ok(!result.text.includes(credentials.password));
  }
});

test("a paid provider invoice alone never proves arrival on the configured bank account", async () => {
  const db = seed(); await save(db);
  const invoice = paid(db, "alice", "live", "2026-11", "s", "w", false);
  assert.equal((await api(db, "alice")).data.canReveal, false);
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {})).status, 403);
  bankReceipt(db, invoice);
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {})).status, 200);
  for (const account of [undefined, "", "   ", "different-bank-account"]) {
    const env = { ...config, VAULT_BANK_ACCOUNT_ID: account };
    assert.equal((await api(db, "alice", "subscriptions/s", "GET", undefined, env)).data.canReveal, false);
    assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {}, env)).status, 403);
  }
});

test("only a booked EUR bank receipt with a complete amount, reference and real past dates unlocks access", async () => {
  const invoiceId = "invoice-live-2026-11-w-alice";
  const future = new Date(NOW.getTime() + 1).toISOString();
  const invalidReceipts: Record<string, string | number>[] = [
    { account: "other-account" }, { account: "" }, { provider: "" }, { provider: "  \t\n" }, { entry: "" }, { entry: "   \n" },
    { amount: 499 }, { amount: 0 }, { amount: -500 }, { amount: "500x" }, { currency: "USD" },
    { status: "reversed" }, { status: "pending" }, { status: "unbooked" },
    { bookedAt: future }, { bookedAt: "" }, { bookedAt: "not-a-date" },
    { verifiedAt: future }, { verifiedAt: "" }, { verifiedAt: "not-a-date" },
  ];
  for (const receipt of invalidReceipts) {
    const db = seed(); await save(db); paid(db, "alice", "live", "2026-11", "s", "w", false); bankReceipt(db, invoiceId, receipt);
    const metadata = await api(db, "alice"); assert.equal(metadata.data.canReveal, false, JSON.stringify(receipt));
    const result = await api(db, "alice", "subscriptions/s/reveal", "POST", {}); assert.equal(result.status, 403, JSON.stringify(receipt)); assert.ok(!result.text.includes(credentials.password));
  }
});

test("one booked bank entry cannot settle two invoices, even for different participants", async () => {
  const db = seed(); const aliceInvoice = paid(db), bobInvoice = paid(db, "bob", "live", "2026-11", "s", "w", false);
  assert.throws(() => bankReceipt(db, bobInvoice, { entry: `entry-${aliceInvoice}` }), /UNIQUE constraint failed/);
  assert.throws(() => bankReceipt(db, aliceInvoice, { entry: "different-entry" }), /UNIQUE constraint failed/);
});

test("paid data cannot cross a circle or a subscription, and archived subscriptions deny every role", async () => {
  const db = seed(); await save(db); paid(db);
  assert.equal((await api(db, "outsider")).status, 404); assert.equal((await api(db, "outsider", "subscriptions/s/reveal", "POST", {})).status, 404);
  db.sqlite.prepare("UPDATE billing_allocations SET subscription_id='other-service'").run();
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {})).status, 403);
  db.sqlite.prepare("UPDATE billing_allocations SET subscription_id='s'").run();
  db.sqlite.prepare("UPDATE billing_cycles SET workspace_id='foreign'").run();
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {})).status, 403);
  db.sqlite.prepare("UPDATE subscriptions SET archived=1 WHERE id='s'").run();
  assert.equal((await api(db, "owner", "subscriptions/s/reveal", "POST", {})).status, 404);
  assert.equal((await save(db)).status, 404);
});

test("reveal rechecks membership, refunds and revision atomically after decryption", async () => {
  for (const mutation of [
    "DELETE FROM workspace_members WHERE user_id='alice'",
    "UPDATE subscription_members SET status='pending' WHERE user_id='alice'",
    "UPDATE subscription_members SET cancellation_effective_at='2026-11-10T10:00:00.000Z' WHERE user_id='alice'",
    "UPDATE billing_invoices SET refunded_cents=1 WHERE user_id='alice'",
    "UPDATE billing_bank_receipts SET status='reversed'",
    "DELETE FROM billing_bank_receipts",
    "UPDATE billing_bank_receipts SET bank_account_id='different-bank-account'",
    "UPDATE subscription_credentials SET revision=revision+1 WHERE subscription_id='s'",
  ]) {
    const db = seed(); await save(db); paid(db);
    db.beforeRun = sql => { if (sql.includes("'revealed'")) { db.beforeRun = null; db.sqlite.exec(mutation); } };
    const read = await api(db, "alice", "subscriptions/s/reveal", "POST", {});
    assert.equal(read.status, 403, mutation); assert.ok(!read.text.includes(credentials.password));
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM subscription_vault_events WHERE action='revealed'").get()?.n, 0);
  }
});

test("manager loss of role or manual site approval between decryption and response prevents disclosure", async () => {
  const db = seed(); await save(db);
  db.beforeRun = sql => { if (sql.includes("'revealed'")) { db.beforeRun = null; db.sqlite.exec("UPDATE workspace_members SET role='member' WHERE user_id='manager'"); } };
  assert.equal((await api(db, "manager", "subscriptions/s/reveal", "POST", {})).status, 403);
  paid(db);
  db.sqlite.prepare("INSERT INTO site_access_requests(user_id,name,email,reason,status,request_event_id,created_at,updated_at) VALUES('alice','Alice','alice@example.test','','approved','fixture-access',?,?)").run(NOW.toISOString(), NOW.toISOString());
  db.beforeRun = sql => { if (sql.includes("'revealed'")) { db.beforeRun = null; db.sqlite.exec("UPDATE site_access_requests SET status='rejected' WHERE user_id='alice'"); } };
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {}, { ...config, ACCESS_CONTROL_ENABLED: "true" })).status, 403);
});

test("deleting then recreating the same revision cannot reveal the earlier revoked secret", async () => {
  const db = seed(); await save(db); paid(db);
  const replacement = await sealServiceCredentials("s", { email: "new@example.test", password: "Remplacement-Securise-9876!" }, config);
  db.beforeRun = sql => {
    if (sql.includes("'revealed'")) {
      db.beforeRun = null;
      db.sqlite.exec("DELETE FROM subscription_credentials WHERE subscription_id='s'");
      db.sqlite.prepare("INSERT INTO subscription_credentials(subscription_id,encryption_version,iv,ciphertext,revision,updated_at,updated_by) VALUES('s',1,?,?,1,?,'owner')").run(replacement.iv, replacement.ciphertext, NOW.toISOString());
    }
  };
  const read = await api(db, "alice", "subscriptions/s/reveal", "POST", {});
  assert.equal(read.status, 403); assert.ok(!read.text.includes(credentials.password));
});

test("Paris month boundary during decryption revokes the previous period receipt", async () => {
  const db = seed(); await save(db); paid(db, "alice", "live", "2026-10");
  let ticks = 0;
  const changingClock = () => new Date(++ticks < 3 ? "2026-10-31T22:59:59.999Z" : "2026-10-31T23:00:00.000Z");
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {}, config, changingClock)).status, 403);
});

test("secret reads require explicit same-origin POST, fail on forged identity and cannot accept a client paid flag", async () => {
  const db = seed(); await save(db); paid(db);
  const anonymous = await api(db, null, "subscriptions/s/reveal", "POST", {}, config, () => NOW, { "oai-authenticated-user-id": "owner", "oai-authenticated-user-email": "owner@example.test" });
  assert.equal(anonymous.status, 401);
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "GET")).status, 405);
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", {}, config, () => NOW, { Origin: "https://foreign.example" })).status, 403);
  assert.equal((await api(db, "alice", "subscriptions/s/reveal", "POST", { paid: true })).status, 400);
  assert.equal((await api(db, "alice", "subscriptions/s/reveal?period=2026-10", "POST", {})).status, 404);
  const read = await api(db, "alice", "subscriptions/s/reveal", "POST", {});
  assert.equal(read.headers.get("Cache-Control"), "private, no-store"); assert.equal(read.headers.get("Vary"), "Cookie, Authorization"); assert.equal(read.headers.get("Referrer-Policy"), "no-referrer");
});

test("credential bodies are bounded and validated without echoing secrets or accepting card fields", async () => {
  const db = seed();
  for (const input of [{ ...credentials, email: "invalid" }, { ...credentials, password: "short" }, { ...credentials, password: "long\npassword\nwith\ncontrols" }, { ...credentials, cvv: "123" }]) {
    const result = await save(db, input); assert.equal(result.status, 400); assert.ok(!result.text.includes(String(input.password)));
  }
  const large = await save(db, { ...credentials, password: "x".repeat(9000) }); assert.equal(large.status, 413);
  assert.equal((await api(db, "owner", "subscriptions/s/credentials", "PUT", credentials, config, () => NOW, { "Content-Type": "application/json-unsafe" })).status, 415);
  const request = new Request(`${ORIGIN}/api/vault/subscriptions/s/credentials`, { method: "PUT", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{bad-json" });
  const result = await handleSubscriptionVaultRequest(request, db, config, person("owner"), () => NOW); assert.equal(result.status, 400);
});

test("rate limit covers secret reads and all error responses remain private", async () => {
  const db = seed(); await save(db); paid(db);
  const bucket = Math.floor(NOW.getTime() / 3_600_000);
  db.sqlite.prepare("INSERT INTO api_write_budgets(user_id,bucket,count) VALUES('alice',?,100)").run(bucket);
  const result = await api(db, "alice", "subscriptions/s/reveal", "POST", {});
  assert.equal(result.status, 429); assert.equal(result.headers.get("Cache-Control"), "private, no-store");
  assert.ok(!result.text.includes(credentials.password));
});

test("credential writes and their audit event roll back together; audit records have no secrets", async () => {
  const db = seed(); await save(db);
  const before = db.sqlite.prepare("SELECT * FROM subscription_credentials").get();
  db.sqlite.exec("CREATE TRIGGER fail_vault_audit BEFORE INSERT ON subscription_vault_events WHEN NEW.action='updated' BEGIN SELECT RAISE(ABORT,'fixture audit unavailable'); END;");
  assert.equal((await save(db, { email: "new@example.test", password: "Changed-Phrase-1234!" })).status, 503);
  assert.deepEqual(db.sqlite.prepare("SELECT * FROM subscription_credentials").get(), before);
  const events = db.sqlite.prepare("SELECT * FROM subscription_vault_events").all();
  assert.ok(!JSON.stringify(events).includes(credentials.password)); assert.ok(!JSON.stringify(events).includes(credentials.email)); assert.ok(!JSON.stringify(events).includes(KEY));
});

test("a manager can remove saved credentials even if the key is unavailable, without granting any member access", async () => {
  const db = seed(); await save(db); paid(db);
  assert.equal((await api(db, "alice", "subscriptions/s/credentials", "DELETE")).status, 403);
  const removed = await api(db, "owner", "subscriptions/s/credentials", "DELETE", undefined, { ACCESS_CONTROL_ENABLED: "false" });
  assert.equal(removed.status, 200); assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM subscription_credentials").get()?.n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM subscription_vault_events WHERE action='deleted'").get()?.n, 1);
  assert.equal((await api(db, "alice")).data.canReveal, false);
});
