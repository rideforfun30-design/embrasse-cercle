import Stripe from "stripe";
import { requestUser, splitCents, type BureauDatabase, type BureauUser } from "./bureau-api";
import { monthlyPeriodStart } from "./membership-policy";
import { requireApprovedSiteAccess, AccessError, type AccessEnv } from "./access";

export const CONSENT_VERSION = "bureau-monthly-v2";
export function billingMandate(collectorName:string) {
  return `J’autorise ${collectorName} à enregistrer mon moyen de paiement et à prélever chaque mois mes participations aux abonnements de ce cercle, tant que ma participation continue. Chaque part correspond au prix mensuel de l’abonnement divisé entre ses participants, avec une répartition exacte des centimes. Le total ne dépassera jamais le plafond mensuel que j’accepte. Les changements de participants ou de prix s’appliquent au prochain cycle non figé. La résiliation de ma participation suit le préavis présenté et accepté séparément. Je peux retirer mon autorisation de paiement ; ce retrait ne vaut pas résiliation de la participation et n’efface pas les sommes effectivement dues. Les frais de paiement sont à la charge du collecteur.`;
}
export type BillingEnv = AccessEnv & {
  STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; BILLING_RUN_SECRET?: string;
  BILLING_WORKSPACE_ID?: string; BILLING_MODE?: string; BILLING_LIVE_APPROVED?: string;
  BILLING_SCHEDULER_ENABLED?: string;
  BILLING_COLLECTOR_NAME?: string; BILLING_COLLECTOR_VERIFIED?: string;
  BILLING_RECOVERY_CONFIGURED?: string;
};
type Mode = "test" | "live";
type Config = { configured: boolean; mode: "disabled" | Mode; workspaceId: string; reasons: string[] };
type Account = { workspace_id:string; user_id:string; mode:Mode; customer_id:string|null; setup_session_id:string|null; setup_complete:number; max_cents:number; consent_version:string; accepted_at:string; operation_started_at:string };
type InvoiceRow = { id:string; cycle_id:string; user_id:string; amount_cents:number; customer_id:string|null; status:string; stripe_invoice_id:string|null; stripe_payment_intent_id:string|null; paid_cents:number; refunded_cents:number; operation_started_at:string|null; updated_at:string };
type Allocation = { subscriptionId:string; subscriptionName:string; userId:string; amountCents:number };
class BillingError extends Error { constructor(public status:number,message:string){super(message);} }
const now = () => new Date().toISOString();
const json = (value:unknown,status=200) => Response.json(value,{status,headers:{"Cache-Control":"no-store","Vary":"Cookie, Authorization","X-Content-Type-Options":"nosniff"}});
const stringId=(value:unknown) => typeof value==="string"?value:typeof value==="object"&&value!==null&&"id" in value?String(value.id):null;

export function billingConfig(env:BillingEnv):Config {
  const reasons:string[]=[];
  const requested=env.BILLING_MODE;
  if(requested!=="test"&&requested!=="live")reasons.push("Le mode de paiement n’est pas activé.");
  if(!env.STRIPE_SECRET_KEY||!env.STRIPE_WEBHOOK_SECRET||!env.BILLING_RUN_SECRET||!env.BILLING_WORKSPACE_ID)reasons.push("Le compte de paiement du cercle n’est pas raccordé.");
  if(env.BILLING_SCHEDULER_ENABLED!=="true")reasons.push("La collecte mensuelle n’est pas programmée.");
  if(!env.BILLING_COLLECTOR_NAME?.trim()||env.BILLING_COLLECTOR_VERIFIED!=="true")reasons.push("Le collecteur doit être identifié et accepté par le service de paiement et sa banque.");
  if(env.BILLING_RECOVERY_CONFIGURED!=="true")reasons.push("Les notifications et les relances de paiement doivent être configurées et testées.");
  if(requested==="test"&&!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY??""))reasons.push("Une clé de test est requise.");
  if(requested==="live"&&(!/^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY??"")||env.BILLING_LIVE_APPROVED!=="true"))reasons.push("Les paiements réels n’ont pas été activés.");
  return {configured:reasons.length===0,mode:reasons.length===0?requested as Mode:"disabled",workspaceId:env.BILLING_WORKSPACE_ID??"",reasons};
}
function ready(env:BillingEnv,workspaceId?:string):Config & {mode:Mode} {
  const c=billingConfig(env);
  if(!c.configured)throw new BillingError(503,"Paiements non activés. Le responsable doit raccorder le service de paiement et la collecte mensuelle.");
  if(workspaceId&&workspaceId!==c.workspaceId)throw new BillingError(403,"La collecte n’est pas activée pour ce cercle.");
  return c as Config&{mode:Mode};
}
/** Stopping/reconciling existing payments must remain possible when new collection is paused. */
function providerForExistingPayments(env:BillingEnv,workspaceId?:string):Config & {mode:Mode} {
  const mode=env.BILLING_MODE;
  if((mode!=="test"&&mode!=="live")||!env.BILLING_WORKSPACE_ID||!new RegExp(`^(sk|rk)_${mode}_`).test(env.STRIPE_SECRET_KEY??""))throw new BillingError(503,"La liaison au prestataire doit être rétablie pour confirmer l’arrêt des tentatives déjà programmées.");
  if(workspaceId&&workspaceId!==env.BILLING_WORKSPACE_ID)throw new BillingError(403,"Ce compte de paiement appartient à un autre bureau.");
  return {configured:true,mode,workspaceId:env.BILLING_WORKSPACE_ID,reasons:[]};
}
function stripeClient(env:BillingEnv){return new Stripe(env.STRIPE_SECRET_KEY!,{apiVersion:"2026-08-26.dahlia",maxNetworkRetries:2,httpClient:Stripe.createFetchHttpClient()});}
async function member(db:BureauDatabase,workspaceId:string,userId:string){
  const m=await db.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(workspaceId,userId).first<{role:string}>();
  if(!m)throw new BillingError(403,"Ce cercle est privé.");return m;
}
function requireUser(request:Request,resolvedUser?:BureauUser|null){const u=resolvedUser===undefined?requestUser(request):resolvedUser;if(!u)throw new BillingError(401,"Connectez-vous pour continuer.");return u;}
async function body(request:Request){
  if(request.headers.get("Origin")!==new URL(request.url).origin)throw new BillingError(403,"Origine de la requête non autorisée.");
  if(!request.headers.get("content-type")?.startsWith("application/json"))throw new BillingError(415,"Format JSON requis.");
  const raw=await request.text();if(raw.length>16000)throw new BillingError(413,"Requête trop volumineuse.");
  let data:Record<string,unknown>;try{data=JSON.parse(raw);}catch{throw new BillingError(400,"Données invalides.");}
  if(!data||typeof data!=="object"||Array.isArray(data))throw new BillingError(400,"Données invalides.");return data;
}
function workspaceValue(value:unknown){if(typeof value!=="string"||!value||value.length>100)throw new BillingError(400,"Bureau invalide.");return value;}
export function monthlyPeriod(date:Date){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Paris",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return {period:`${p.year}-${p.month}`,firstDay:p.day==="01"};
}
export function allocateMonthly(subscriptions:{id:string;name:string;totalCents:number;memberIds:string[]}[]):Allocation[]{
  return subscriptions.flatMap(s=>s.memberIds.length?Object.entries(splitCents(s.totalCents,s.memberIds)).map(([userId,amountCents])=>({subscriptionId:s.id,subscriptionName:s.name,userId,amountCents})):[]);
}
export function invoiceReadiness(amountCents:number,account:Pick<Account,"customer_id"|"setup_complete"|"max_cents"|"consent_version">|null){
  if(amountCents===0)return "no_charge";
  if(amountCents<50)return "blocked_minimum";
  if(!account?.customer_id||account.setup_complete!==1||account.consent_version!==CONSENT_VERSION)return "blocked_setup";
  return amountCents>account.max_cents?"blocked_cap":"ready";
}
async function billingState(request:Request,db:BureauDatabase,env:BillingEnv,resolvedUser?:BureauUser|null){
  const user=requireUser(request,resolvedUser),workspaceId=workspaceValue(new URL(request.url).searchParams.get("workspace"));
  await requireApprovedSiteAccess(db,user,env);
  const m=await member(db,workspaceId,user.id),config=billingConfig(env),enabled=config.configured&&config.workspaceId===workspaceId;
  const mode=enabled?config.mode:"disabled";
  // Stopping collection must never erase the existing ledger from view.
  const ledgerMode=env.BILLING_MODE==="test"||env.BILLING_MODE==="live"?env.BILLING_MODE:null;
  const account=ledgerMode?await db.prepare("SELECT max_cents,setup_complete,consent_version,accepted_at FROM billing_accounts WHERE workspace_id=? AND user_id=? AND mode=?").bind(workspaceId,user.id,ledgerMode).first<{max_cents:number;setup_complete:number;consent_version:string;accepted_at:string}>():null;
  const {results:payments}=await db.prepare("SELECT i.id,c.period,c.mode,i.user_id AS userId,p.name AS userName,i.amount_cents AS amountCents,i.status,i.paid_cents AS paidCents,i.refunded_cents AS refundedCents,i.updated_at AS updatedAt FROM billing_invoices i JOIN billing_cycles c ON c.id=i.cycle_id JOIN profiles p ON p.id=i.user_id WHERE c.workspace_id=? AND c.mode=? AND (?='admin' OR i.user_id=?) ORDER BY c.period DESC,p.name LIMIT 200").bind(workspaceId,ledgerMode,m.role,user.id).all<{id:string;period:string;mode:string;userId:string;userName:string;amountCents:number;status:string;paidCents:number;refundedCents:number;updatedAt:string}>();
  // History is paginated for display; financial totals include every invoice.
  const totals=await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN i.status='disputed' THEN 0 ELSE MAX(0,i.paid_cents-i.refunded_cents) END),0) AS collectedCents,
    COALESCE(SUM(CASE WHEN i.status IN ('void','no_charge','refunded','uncollectible') THEN 0 ELSE MAX(0,i.amount_cents-i.paid_cents) END),0) AS pendingCents
    FROM billing_invoices i JOIN billing_cycles c ON c.id=i.cycle_id WHERE c.workspace_id=? AND c.mode=? AND (?='admin' OR i.user_id=?)`).bind(workspaceId,ledgerMode,m.role,user.id).first<{collectedCents:number;pendingCents:number}>();
  const collectedCents=totals?.collectedCents??0,pendingCents=totals?.pendingCents??0;
  const collectorName=env.BILLING_COLLECTOR_NAME?.trim()||null;
  return json({configured:enabled,mode,ledgerMode,autoCollectionEnabled:enabled,reasons:enabled?[]:config.workspaceId&&config.workspaceId!==workspaceId?["La collecte n’est pas activée pour ce cercle."]:config.reasons,collectorName,mandateText:collectorName?billingMandate(collectorName):null,consentVersion:CONSENT_VERSION,consent:account?{maxCents:account.max_cents,ready:account.setup_complete===1&&account.consent_version===CONSENT_VERSION,version:account.consent_version,acceptedAt:account.accepted_at}:null,payments,totals:{collectedCents,pendingCents},collectionDay:1,collectionTimezone:"Europe/Paris",fundsAvailability:"unverified",providerPayments:"manual",feesPaidBy:"organizer",recovery:{automaticRetries:enabled&&env.BILLING_RECOVERY_CONFIGURED==="true",externalCollectionEnabled:false,reserveCollectionEnabled:false,prepaidAccessEnforced:false}});
}
async function setup(request:Request,db:BureauDatabase,env:BillingEnv,resolvedUser?:BureauUser|null){
  const user=requireUser(request,resolvedUser),data=await body(request),workspaceId=workspaceValue(data.workspaceId);
  await requireApprovedSiteAccess(db,user,env);
  await member(db,workspaceId,user.id);const config=ready(env,workspaceId);
  if(data.consent!==true||data.consentVersion!==CONSENT_VERSION)throw new BillingError(400,"Acceptez l’autorisation de prélèvement présentée.");
  const maxCents=data.maxCents;if(typeof maxCents!=="number"||!Number.isSafeInteger(maxCents)||maxCents<50||maxCents>1_000_000)throw new BillingError(400,"Choisissez un plafond mensuel entre 0,50 € et 10 000 €.");
  const stripe=stripeClient(env),timestamp=now();
  let account=await db.prepare("SELECT * FROM billing_accounts WHERE workspace_id=? AND user_id=? AND mode=?").bind(workspaceId,user.id,config.mode).first<Account>();
  if(account?.setup_session_id){
    const existing=await stripe.checkout.sessions.retrieve(account.setup_session_id);
    if(existing.status==="open")await stripe.checkout.sessions.expire(existing.id);
  }
  if(!account){
    await db.prepare("INSERT INTO billing_accounts (workspace_id,user_id,mode,max_cents,consent_version,accepted_at,operation_started_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,user_id,mode) DO NOTHING").bind(workspaceId,user.id,config.mode,maxCents,CONSENT_VERSION,timestamp,timestamp).run();
    account=await db.prepare("SELECT * FROM billing_accounts WHERE workspace_id=? AND user_id=? AND mode=?").bind(workspaceId,user.id,config.mode).first<Account>();
  }
  if(!account)throw new BillingError(500,"Impossible de préparer le compte de paiement.");
  let customerId=account.customer_id;
  if(!customerId){
    // Metadata reconciliation survives Stripe v1's finite idempotency retention.
    const existing=await stripe.customers.search({query:`metadata['embrasse_account']:'${workspaceId}:${user.id}:${config.mode}'`,limit:10});
    if(existing.data.length>1)throw new BillingError(409,"Le compte de paiement doit être vérifié par le responsable.");
    const customer=existing.data[0]??await stripe.customers.create({name:user.name,email:user.email,metadata:{embrasse_account:`${workspaceId}:${user.id}:${config.mode}`}}, {idempotencyKey:`customer:${workspaceId}:${user.id}:${config.mode}`});
    if(customer.livemode!==(config.mode==="live"))throw new BillingError(503,"Le compte Stripe ne correspond pas au mode de paiement.");
    customerId=customer.id;
    await db.prepare("UPDATE billing_accounts SET customer_id=? WHERE workspace_id=? AND user_id=? AND mode=? AND customer_id IS NULL").bind(customerId,workspaceId,user.id,config.mode).run();
  }
  // Existing authorizations are suspended until the newly accepted setup completes.
  await db.prepare("UPDATE billing_accounts SET max_cents=?,consent_version=?,accepted_at=?,setup_complete=0,operation_started_at=? WHERE workspace_id=? AND user_id=? AND mode=?").bind(maxCents,CONSENT_VERSION,timestamp,timestamp,workspaceId,user.id,config.mode).run();
  const origin=new URL(request.url).origin;
  const token=crypto.randomUUID();
  const session=await stripe.checkout.sessions.create({mode:"setup",customer:customerId,success_url:`${origin}/?payment_setup=complete`,cancel_url:`${origin}/?payment_setup=cancelled`,integration_identifier:"embrasse_bureau_pmnqrxka",setup_intent_data:{metadata:{workspace_id:workspaceId,user_id:user.id,consent_version:CONSENT_VERSION}},metadata:{workspace_id:workspaceId,user_id:user.id,consent_version:CONSENT_VERSION,accepted_at:timestamp,max_cents:String(maxCents)},custom_text:{submit:{message:"Autorisation mensuelle variable, dans la limite du plafond accepté. Les services sont réglés par le responsable du cercle."}}},{idempotencyKey:`setup:${workspaceId}:${user.id}:${token}`});
  await db.prepare("UPDATE billing_accounts SET setup_session_id=? WHERE workspace_id=? AND user_id=? AND mode=? AND accepted_at=?").bind(session.id,workspaceId,user.id,config.mode,timestamp).run();
  if(!session.url)throw new BillingError(502,"La page de paiement n’est pas disponible.");
  return json({url:session.url,mode:config.mode});
}
async function revoke(request:Request,db:BureauDatabase,env:BillingEnv,resolvedUser?:BureauUser|null){
  const user=requireUser(request,resolvedUser),data=await body(request),workspaceId=workspaceValue(data.workspaceId);await member(db,workspaceId,user.id);
  await db.prepare("UPDATE billing_accounts SET setup_complete=0,setup_session_id=NULL WHERE workspace_id=? AND user_id=?").bind(workspaceId,user.id).run();
  const {results:outstanding}=await db.prepare("SELECT i.stripe_invoice_id,c.mode FROM billing_invoices i JOIN billing_cycles c ON c.id=i.cycle_id WHERE c.workspace_id=? AND i.user_id=? AND i.stripe_invoice_id IS NOT NULL AND i.status NOT IN ('paid','refunded','void','no_charge')").bind(workspaceId,user.id).all<{stripe_invoice_id:string;mode:Mode}>();
  if(outstanding.length){
    const config=providerForExistingPayments(env,workspaceId);const stripe=stripeClient(env);
    let otherEnvironment=false;
    for(const row of outstanding){
      if(row.mode!==config.mode){otherEnvironment=true;continue;}
      const invoice=await stripe.invoices.retrieve(row.stripe_invoice_id);
      if(invoice.status==='draft'||invoice.status==='open')await stripe.invoices.update(invoice.id,{auto_advance:false});
      await refreshInvoice(db,stripe,invoice.id,config.mode);
    }
    if(otherEnvironment)throw new BillingError(503,"L’autorisation est retirée sur le site. Les tentatives de l’environnement raccordé sont arrêtées ; le responsable doit vérifier les factures de l’autre environnement du prestataire.");
  }
  return json({ok:true,message:"Les prochaines tentatives automatiques sont arrêtées. Une opération bancaire déjà en cours peut encore se terminer."});
}

export async function freezeCycle(db:BureauDatabase,workspaceId:string,mode:Mode,period:string,date:Date){
  const cycleId=`${workspaceId}:${mode}:${period}`,stamp=date.toISOString(),cutoff=monthlyPeriodStart(period);
  await db.batch([
    db.prepare("INSERT INTO billing_cycles (id,workspace_id,period,mode,status,frozen_at) VALUES (?,?,?,?,'freezing',?) ON CONFLICT(workspace_id,period,mode) DO NOTHING").bind(cycleId,workspaceId,period,mode,stamp),
    db.prepare(`INSERT INTO billing_allocations (cycle_id,subscription_id,subscription_name,user_id,amount_cents)
      SELECT ?,id,name,user_id,CAST(total_cents/n AS INTEGER)+CASE WHEN rank<=total_cents%n THEN 1 ELSE 0 END FROM (
        SELECT s.id,s.name,s.total_cents,sm.user_id,COUNT(*) OVER(PARTITION BY s.id) AS n,ROW_NUMBER() OVER(PARTITION BY s.id ORDER BY sm.user_id) AS rank
        FROM subscriptions s JOIN subscription_members sm ON sm.subscription_id=s.id JOIN workspace_members wm ON wm.workspace_id=s.workspace_id AND wm.user_id=sm.user_id
        WHERE s.workspace_id=? AND s.archived=0 AND sm.status='active'
          AND (sm.cancellation_effective_at IS NULL OR sm.cancellation_effective_at>?)
      ) WHERE EXISTS(SELECT 1 FROM billing_cycles WHERE id=? AND status='freezing')`).bind(cycleId,workspaceId,cutoff,cycleId),
    db.prepare(`INSERT INTO billing_invoices (id,cycle_id,user_id,amount_cents,customer_id,status,paid_cents,refunded_cents,updated_at)
      SELECT ?||':'||a.user_id,?,a.user_id,SUM(a.amount_cents),b.customer_id,
      CASE WHEN SUM(a.amount_cents)=0 THEN 'no_charge' WHEN SUM(a.amount_cents)<50 THEN 'blocked_minimum' WHEN b.customer_id IS NULL OR b.setup_complete<>1 OR b.consent_version<>? THEN 'blocked_setup' WHEN SUM(a.amount_cents)>b.max_cents THEN 'blocked_cap' ELSE 'ready' END,0,0,?
      FROM billing_allocations a LEFT JOIN billing_accounts b ON b.user_id=a.user_id AND b.workspace_id=? AND b.mode=?
      WHERE a.cycle_id=? AND EXISTS(SELECT 1 FROM billing_cycles WHERE id=? AND status='freezing') GROUP BY a.user_id`).bind(cycleId,cycleId,CONSENT_VERSION,stamp,workspaceId,mode,cycleId,cycleId),
    db.prepare("UPDATE billing_cycles SET status='ready' WHERE id=? AND status='freezing'").bind(cycleId),
  ]);return cycleId;
}
async function processInvoice(db:BureauDatabase,stripe:Stripe,env:BillingEnv,config:Config&{mode:Mode},row:InvoiceRow){
  const account=await db.prepare("SELECT * FROM billing_accounts WHERE workspace_id=? AND user_id=? AND mode=?").bind(config.workspaceId,row.user_id,config.mode).first<Account>();
  const readiness=invoiceReadiness(row.amount_cents,account);
  if(!row.stripe_invoice_id&&readiness!=="ready"){
    await db.prepare("UPDATE billing_invoices SET status=?,updated_at=? WHERE id=?").bind(readiness,now(),row.id).run();return;
  }
  // A revoked authorization also blocks draft finalization; already finalized invoices remain debt/history.
  if(row.stripe_invoice_id&&["blocked_setup","blocked_cap"].includes(readiness)){
    const current=await stripe.invoices.retrieve(row.stripe_invoice_id);
    if(current.status==="draft")return;
  }
  let invoiceId=row.stripe_invoice_id;
  if(!invoiceId){
    if(!account?.customer_id)throw new Error("Missing billing customer");
    // Recover an ambiguous previous create before reusing an idempotency key older than 24 hours.
    if(row.operation_started_at&&Date.now()-new Date(row.operation_started_at).getTime()>23*60*60*1000){
      const matches:Stripe.Invoice[]=[];let inspected=0;
      for await(const candidate of stripe.invoices.list({customer:account.customer_id,limit:100})){
        if(candidate.metadata?.embrasse_invoice===row.id)matches.push(candidate);
        if(++inspected>=500)break;
      }
      if(matches.length===1)invoiceId=matches[0].id;
      else {await db.prepare("UPDATE billing_invoices SET status='manual_review',updated_at=? WHERE id=?").bind(now(),row.id).run();return;}
    }
    if(!invoiceId){
      await db.prepare("UPDATE billing_invoices SET status='creating',operation_started_at=COALESCE(operation_started_at,?),customer_id=?,updated_at=? WHERE id=?").bind(now(),account.customer_id,now(),row.id).run();
      const invoice=await stripe.invoices.create({customer:account.customer_id,collection_method:"charge_automatically",auto_advance:false,currency:"eur",pending_invoice_items_behavior:"exclude",metadata:{embrasse_invoice:row.id,embrasse_cycle:row.cycle_id,embrasse_workspace:config.workspaceId},description:"Participations mensuelles aux abonnements du cercle"},{idempotencyKey:`invoice:${row.id}`});invoiceId=invoice.id;
    }
    await db.prepare("UPDATE billing_invoices SET stripe_invoice_id=?,status='draft',updated_at=? WHERE id=?").bind(invoiceId,now(),row.id).run();
  }
  const invoice=await stripe.invoices.retrieve(invoiceId);
  if(invoice.status!=="draft"){await refreshInvoice(db,stripe,invoiceId,config.mode);return;}
  // No provider update, tax auto-calculation, or mutable price object: exact immutable line amounts.
  const {results:allocations}=await db.prepare("SELECT subscription_id,subscription_name,amount_cents FROM billing_allocations WHERE cycle_id=? AND user_id=? ORDER BY subscription_id").bind(row.cycle_id,row.user_id).all<{subscription_id:string;subscription_name:string;amount_cents:number}>();
  const existing=await stripe.invoices.listLineItems(invoiceId,{limit:100});
  if(existing.has_more){await db.prepare("UPDATE billing_invoices SET status='manual_review',updated_at=? WHERE id=?").bind(now(),row.id).run();return;}
  const known=new Set(existing.data.map(l=>l.metadata?.embrasse_allocation).filter(Boolean));
  for(const line of allocations){
    if(known.has(line.subscription_id)||line.amount_cents===0)continue;
    await stripe.invoiceItems.create({invoice:invoiceId,customer:account!.customer_id!,amount:line.amount_cents,currency:"eur",description:line.subscription_name,metadata:{embrasse_allocation:line.subscription_id,embrasse_invoice:row.id}},{idempotencyKey:`line:${row.id}:${line.subscription_id}`});
  }
  const complete=await stripe.invoices.retrieve(invoiceId);
  if(complete.total!==row.amount_cents){await db.prepare("UPDATE billing_invoices SET status='manual_review',updated_at=? WHERE id=?").bind(now(),row.id).run();return;}
  // Recheck authorization immediately before finalizing a collectible invoice.
  const freshAccount=await db.prepare("SELECT * FROM billing_accounts WHERE workspace_id=? AND user_id=? AND mode=?").bind(config.workspaceId,row.user_id,config.mode).first<Account>();
  if(invoiceReadiness(row.amount_cents,freshAccount)!=="ready")return;
  await stripe.invoices.finalizeInvoice(invoiceId,{auto_advance:true},{idempotencyKey:`finalize:${row.id}`});
  await refreshInvoice(db,stripe,invoiceId,config.mode);
}
async function run(request:Request,db:BureauDatabase,env:BillingEnv){
  // Bearer job access is independent from browser identity and CSRF.
  const secret=env.BILLING_RUN_SECRET;
  if(!secret||request.headers.get("Authorization")!==`Bearer ${secret}`)throw new BillingError(401,"Accès à la collecte refusé.");
  const config=ready(env),date=new Date(),calendar=monthlyPeriod(date),cycleId=`${config.workspaceId}:${config.mode}:${calendar.period}`;
  const existing=await db.prepare("SELECT id FROM billing_cycles WHERE id=?").bind(cycleId).first();
  if(!existing&&!calendar.firstDay)return json({ok:true,processed:0,message:"La prochaine collecte sera préparée le premier jour du mois."});
  if(!existing)await freezeCycle(db,config.workspaceId,config.mode,calendar.period,date);
  const lease=crypto.randomUUID(),until=Date.now()+10*60*1000;
  const acquired=await db.prepare("UPDATE billing_cycles SET lease_id=?,lease_until=? WHERE id=? AND (lease_until IS NULL OR lease_until<?)").bind(lease,until,cycleId,Date.now()).run();
  if(!acquired.meta.changes)return json({ok:true,processed:0,message:"Une collecte est déjà en cours."});
  let processed=0;const failures:string[]=[];
  try{
    const stripe=stripeClient(env);
    const {results:rows}=await db.prepare(`SELECT i.* FROM billing_invoices i WHERE i.cycle_id=? AND (
      i.status IN ('ready','creating','draft') OR (i.status IN ('blocked_setup','blocked_cap') AND EXISTS(
      SELECT 1 FROM billing_accounts b WHERE b.workspace_id=? AND b.mode=? AND b.user_id=i.user_id AND b.setup_complete=1 AND b.consent_version=? AND b.customer_id IS NOT NULL AND b.max_cents>=i.amount_cents)))
      ORDER BY CASE WHEN i.status='draft' THEN 0 WHEN i.status='creating' THEN 1 ELSE 2 END,i.id LIMIT 40`).bind(cycleId,config.workspaceId,config.mode,CONSENT_VERSION).all<InvoiceRow>();
    for(const row of rows){if(Date.now()>until-30_000)break;try{await processInvoice(db,stripe,env,config,row);processed++;}catch{failures.push(row.id);}}
  }finally{await db.prepare("UPDATE billing_cycles SET lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?").bind(cycleId,lease).run();}
  return json({ok:failures.length===0,cycle:calendar.period,mode:config.mode,processed,failed:failures.length},failures.length?502:200);
}
async function refreshInvoice(db:BureauDatabase,stripe:Stripe,invoiceId:string,mode:Mode){
  const local=await db.prepare("SELECT i.* FROM billing_invoices i JOIN billing_cycles c ON c.id=i.cycle_id WHERE i.stripe_invoice_id=? AND c.mode=?").bind(invoiceId,mode).first<InvoiceRow>();
  if(!local)return;
  const invoice=await stripe.invoices.retrieve(invoiceId);
  if(invoice.livemode!==(mode==="live"))throw new Error("Invoice mode mismatch");
  // Amounts count only successful Stripe-backed payments, never a manual mark-as-paid.
  const payments=await stripe.invoicePayments.list({invoice:invoiceId,limit:100});
  if(payments.has_more)throw new Error("Too many invoice payments to reconcile safely");
  let received=0,refunded=0,disputed=false,intentId:string|null=null;
  for(const p of payments.data){
    if(p.status!=="paid"||!p.amount_paid||p.payment.type==="payment_record")continue;
    let charge:Stripe.Charge|null=null;
    if(p.payment.type==="payment_intent"){
      const piId=stringId(p.payment.payment_intent);if(!piId)continue;
      intentId=piId;const pi=await stripe.paymentIntents.retrieve(piId,{expand:["latest_charge"]});
      if(pi.status!=="succeeded")continue;
      charge=typeof pi.latest_charge==="object"?pi.latest_charge:null;
      if(!charge&&pi.latest_charge)charge=await stripe.charges.retrieve(stringId(pi.latest_charge)!);
    }else if(p.payment.type==="charge"){
      const chargeId=stringId(p.payment.charge);if(chargeId)charge=await stripe.charges.retrieve(chargeId);
    }
    if(!charge?.paid)continue;
    received+=p.amount_paid;
    refunded+=Math.min(p.amount_paid,charge.amount_refunded);
    if(charge.disputed){
      const disputes=await stripe.disputes.list({charge:charge.id,limit:10});
      disputed=disputed||disputes.data.some(d=>d.status!=="won"&&d.status!=="warning_closed");
    }
  }
  received=Math.min(local.amount_cents,received);refunded=Math.min(received,refunded);
  const status=reconciledInvoiceStatus(invoice,received,refunded,disputed,local.amount_cents);
  await db.prepare("UPDATE billing_invoices SET status=?,paid_cents=MAX(paid_cents,?),refunded_cents=MAX(refunded_cents,?),stripe_payment_intent_id=COALESCE(?,stripe_payment_intent_id),updated_at=? WHERE id=?").bind(status,received,refunded,intentId,now(),local.id).run();
}
/** A failed event cannot override a later successful payment retrieved from the provider. */
export function reconciledInvoiceStatus(invoice:{status:string|null;attempted:boolean},received:number,refunded:number,disputed:boolean,total:number):string {
  if(disputed)return "disputed";
  if(received>0&&refunded>=received)return "refunded";
  if(received>=total&&total>0)return refunded>0?"partially_refunded":"paid";
  if(invoice.status==="void"||invoice.status==="uncollectible"||invoice.status==="draft")return invoice.status;
  if(invoice.status==="paid")return "manual_review";
  return invoice.status==="open"&&invoice.attempted?"payment_failed":"open";
}
async function setupCompleted(db:BureauDatabase,stripe:Stripe,session:Stripe.Checkout.Session,mode:Mode){
  if(session.mode!=="setup"||session.status!=="complete"||session.livemode!==(mode==="live"))return;
  const workspaceId=session.metadata?.workspace_id,userId=session.metadata?.user_id;
  if(!workspaceId||!userId)return;
  const account=await db.prepare("SELECT * FROM billing_accounts WHERE workspace_id=? AND user_id=? AND mode=?").bind(workspaceId,userId,mode).first<Account>();
  // A withdrawn/replaced mandate cannot be restored by a late webhook.
  if(!account||account.setup_session_id!==session.id||account.accepted_at!==session.metadata?.accepted_at||account.consent_version!==CONSENT_VERSION||account.customer_id!==stringId(session.customer))return;
  const setupId=stringId(session.setup_intent);if(!setupId)return;
  const intent=await stripe.setupIntents.retrieve(setupId);
  const methodId=stringId(intent.payment_method);
  if(intent.status!=="succeeded"||intent.usage!=="off_session"||stringId(intent.customer)!==account.customer_id||!methodId)return;
  await stripe.customers.update(account.customer_id!,{invoice_settings:{default_payment_method:methodId}},{idempotencyKey:`default-pm:${session.id}`});
  await db.prepare("UPDATE billing_accounts SET setup_complete=1 WHERE workspace_id=? AND user_id=? AND mode=? AND setup_session_id=? AND accepted_at=?").bind(workspaceId,userId,mode,session.id,account.accepted_at).run();
}
async function webhook(request:Request,db:BureauDatabase,env:BillingEnv){
  const config=providerForExistingPayments(env),signature=request.headers.get("stripe-signature");
  if(!signature)throw new BillingError(400,"Signature manquante.");
  if(!env.STRIPE_WEBHOOK_SECRET)throw new BillingError(503,"Le secret de vérification des paiements est absent.");
  const raw=await request.text();if(raw.length>1_000_000)throw new BillingError(413,"Événement trop volumineux.");
  const stripe=stripeClient(env);let event:Stripe.Event;
  try{event=await stripe.webhooks.constructEventAsync(raw,signature,env.STRIPE_WEBHOOK_SECRET!,300,Stripe.createSubtleCryptoProvider());}catch{throw new BillingError(400,"Signature invalide.");}
  if(event.livemode!==(config.mode==="live"))throw new BillingError(400,"Mode de paiement incorrect.");
  const prior=await db.prepare("SELECT status FROM billing_webhook_events WHERE id=?").bind(event.id).first<{status:string}>();if(prior?.status==="done")return json({received:true});
  await db.prepare("INSERT INTO billing_webhook_events (id,type,mode,status,received_at) VALUES (?,?,?,'processing',?) ON CONFLICT(id) DO NOTHING").bind(event.id,event.type,config.mode,now()).run();
  try{
    if(event.type==="checkout.session.completed"){
      const session=await stripe.checkout.sessions.retrieve((event.data.object as Stripe.Checkout.Session).id);
      if(session.metadata?.workspace_id===config.workspaceId)await setupCompleted(db,stripe,session,config.mode);
    }else if(event.type.startsWith("invoice.")){
      const invoiceId=(event.data.object as Stripe.Invoice).id;
      if(["invoice.paid","invoice.payment_succeeded","invoice.payment_failed","invoice.payment_action_required","invoice.voided","invoice.marked_uncollectible"].includes(event.type))await refreshInvoice(db,stripe,invoiceId,config.mode);
    }else if(event.type==="charge.refunded"||event.type.startsWith("charge.dispute.")){
      let charge:Stripe.Charge|null=null;
      if(event.type==="charge.refunded")charge=await stripe.charges.retrieve((event.data.object as Stripe.Charge).id);
      else{const d=event.data.object as Stripe.Dispute;const chargeId=stringId(d.charge);if(chargeId)charge=await stripe.charges.retrieve(chargeId);}
      const piId=stringId(charge?.payment_intent);
      if(piId){
        const invoicePayments=await stripe.invoicePayments.list({payment:{type:"payment_intent",payment_intent:piId},limit:100});
        if(invoicePayments.has_more)throw new Error("Too many related payments");
        for(const p of invoicePayments.data){const inv=stringId(p.invoice);if(inv)await refreshInvoice(db,stripe,inv,config.mode);}
      }
    }
    await db.prepare("UPDATE billing_webhook_events SET status='done',processed_at=? WHERE id=?").bind(now(),event.id).run();return json({received:true});
  }catch{
    // Leave receipt retryable; Stripe will redeliver. Never return a false success.
    throw new BillingError(500,"La mise à jour du paiement sera réessayée.");
  }
}
export async function handleBillingRequest(request:Request,db:BureauDatabase,env:BillingEnv,resolvedUser?:BureauUser|null):Promise<Response>{
  try{
    const action=new URL(request.url).pathname.replace(/^\/api\/billing\/?/,"");
    if(action==="state"&&request.method==="GET")return await billingState(request,db,env,resolvedUser);
    if(action==="setup"&&request.method==="POST")return await setup(request,db,env,resolvedUser);
    if(action==="revoke"&&request.method==="POST")return await revoke(request,db,env,resolvedUser);
    if(action==="webhook"&&request.method==="POST")return await webhook(request,db,env);
    if(action==="run"&&request.method==="POST")return await run(request,db,env);
    return json({error:"Page introuvable."},404);
  }catch(error){
    if(error instanceof BillingError||error instanceof AccessError)return json({error:error.message},error.status);
    console.error("billing_error",error instanceof Error?error.name:"unknown");return json({error:"Le service de paiement est momentanément indisponible."},502);
  }
}
