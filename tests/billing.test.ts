import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync,readdirSync } from "node:fs";
import { billingConfig,allocateMonthly,invoiceReadiness,monthlyPeriod,freezeCycle,handleBillingRequest,CONSENT_VERSION,reconciledInvoiceStatus,billingMandate,type BillingEnv } from "../lib/billing";
import type { BureauDatabase,SqlStatement } from "../lib/bureau-api";
class LocalD1 implements BureauDatabase {
 sqlite=new DatabaseSync(":memory:");
 constructor(){this.sqlite.exec("PRAGMA foreign_keys=ON");for(const file of readdirSync(new URL("../drizzle",import.meta.url)).filter(f=>f.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),"utf8"));}
 prepare(sql:string):SqlStatement{let values:unknown[]=[];const sqlite=this.sqlite;const s:SqlStatement={bind(...v){values=v;return s;},async first<T>(){return(sqlite.prepare(sql).get(...values as (string|number|null)[])??null)as T|null;},async all<T>(){return{results:sqlite.prepare(sql).all(...values as (string|number|null)[])as T[]};},async run(){const r=sqlite.prepare(sql).run(...values as (string|number|null)[]);return{meta:{changes:Number(r.changes)}};}};return s;}
 async batch(statements:SqlStatement[]){this.sqlite.exec("BEGIN");try{const a=[];for(const s of statements)a.push(await s.run());this.sqlite.exec("COMMIT");return a;}catch(e){this.sqlite.exec("ROLLBACK");throw e;}}
}
const env:BillingEnv={STRIPE_SECRET_KEY:"rk_test_fake_for_unit_tests",STRIPE_WEBHOOK_SECRET:"whsec_fake",BILLING_RUN_SECRET:"not-a-real-job-secret",BILLING_WORKSPACE_ID:"w",BILLING_MODE:"test",BILLING_SCHEDULER_ENABLED:"true",BILLING_COLLECTOR_NAME:"Collecteur de test",BILLING_COLLECTOR_VERIFIED:"true",BILLING_RECOVERY_CONFIGURED:"true"};
function seed(){const db=new LocalD1();db.sqlite.exec(`INSERT INTO profiles (id,name,email,created_at) VALUES ('owner','Owner','owner@example.test','2026-01-01'),('alice','Alice','alice@example.test','2026-01-01'),('bob','Bob','bob@example.test','2026-01-01'),('outsider','Other','other@example.test','2026-01-01');INSERT INTO workspaces VALUES ('w','Le bureau','owner','invitation-secret','2026-01-01');INSERT INTO workspace_members VALUES ('w','owner','admin','2026-01-01'),('w','alice','member','2026-01-01'),('w','bob','member','2026-01-01');INSERT INTO subscriptions (id,workspace_id,owner_id,name,category,description,total_cents,max_seats,next_due_date,archived,created_at) VALUES ('s','w','owner','Outil studio','Vidéo','',1001,3,'2026-11-20',0,'2026-01-01');INSERT INTO subscription_members (subscription_id,user_id,status,joined_at) VALUES ('s','owner','active','2026-01-01'),('s','alice','active','2026-01-01'),('s','bob','pending','2026-01-01');`);return db;}
function req(user:string|null,path:string,method='GET',data?:unknown,origin='https://abonnement.embrasse.tv'){const h:Record<string,string>={Origin:origin,'Content-Type':'application/json'};if(user){h['oai-authenticated-user-id']=user;h['oai-authenticated-user-email']=`${user}@example.test`;}return new Request(`https://abonnement.embrasse.tv/api/billing/${path}`,{method,headers:h,...(data===undefined?{}:{body:JSON.stringify(data)})});}
const account={customer_id:'cus_test',setup_complete:1,max_cents:5000,consent_version:CONSENT_VERSION};
test('billing fails closed without credentials, scheduler, approved live mode, or mode-matching keys',()=>{
 assert.equal(billingConfig({}).configured,false);assert.equal(billingConfig(env).mode,'test');
 for(const change of [{BILLING_SCHEDULER_ENABLED:'false'},{STRIPE_SECRET_KEY:'sk_live_x'},{BILLING_MODE:'live'},{BILLING_WORKSPACE_ID:''},{STRIPE_WEBHOOK_SECRET:''},{BILLING_RUN_SECRET:''},{BILLING_COLLECTOR_NAME:''},{BILLING_COLLECTOR_VERIFIED:'false'},{BILLING_RECOVERY_CONFIGURED:'false'}])assert.equal(billingConfig({...env,...change}).configured,false);
 assert.equal(billingConfig({...env,BILLING_MODE:'live',STRIPE_SECRET_KEY:'rk_live_x',BILLING_LIVE_APPROVED:'true'}).mode,'live');
});
test('all cents are conserved and empty groups produce no allocations',()=>{
 const lines=allocateMonthly([{id:'a',name:'Film',totalCents:1000,memberIds:['c','b','a']},{id:'b',name:'Audio',totalCents:2399,memberIds:['c','a']},{id:'empty',name:'Empty',totalCents:500,memberIds:[]}]);
 assert.equal(lines.reduce((s,l)=>s+l.amountCents,0),3399);assert.deepEqual(lines.filter(x=>x.subscriptionId==='a').map(x=>x.amountCents),[334,333,333]);assert.equal(lines.some(x=>x.subscriptionId==='empty'),false);
});
test('mandate, cap, and minimum prevent unauthorized or impossible collection',()=>{
 assert.equal(invoiceReadiness(1000,null),'blocked_setup');assert.equal(invoiceReadiness(1000,{...account,setup_complete:0}),'blocked_setup');assert.equal(invoiceReadiness(1000,{...account,consent_version:'old'}),'blocked_setup');assert.equal(invoiceReadiness(1000,{...account,max_cents:999}),'blocked_cap');assert.equal(invoiceReadiness(1000,account),'ready');assert.equal(invoiceReadiness(49,account),'blocked_minimum');assert.equal(invoiceReadiness(0,null),'no_charge');
});
test('monthly due date uses Paris timezone at UTC month boundary',()=>{
 assert.deepEqual(monthlyPeriod(new Date('2026-10-31T23:30:00Z')),{period:'2026-11',firstDay:true});assert.deepEqual(monthlyPeriod(new Date('2026-10-31T22:30:00Z')),{period:'2026-10',firstDay:false});assert.deepEqual(monthlyPeriod(new Date('2026-06-30T22:30:00Z')),{period:'2026-07',firstDay:true});
});
test('cycle snapshots are immutable and pending members never alter existing allocations',async()=>{
 const db=seed();const cycle=await freezeCycle(db,'w','test','2026-11',new Date('2026-11-01T09:00:00Z'));
 const lines=db.sqlite.prepare('SELECT user_id,amount_cents FROM billing_allocations WHERE cycle_id=? ORDER BY user_id').all(cycle);assert.deepEqual(lines.map(x=>[x.user_id,x.amount_cents]),[['alice',501],['owner',500]]);
 const invoices=db.sqlite.prepare('SELECT status FROM billing_invoices WHERE cycle_id=?').all(cycle);assert.equal(invoices.length,2);assert.ok(invoices.every(x=>x.status==='blocked_setup'));
 db.sqlite.exec("UPDATE subscriptions SET total_cents=9000;UPDATE subscription_members SET status='active' WHERE user_id='bob'");
 await freezeCycle(db,'w','test','2026-11',new Date('2026-11-01T10:00:00Z'));assert.deepEqual(db.sqlite.prepare('SELECT user_id,amount_cents FROM billing_allocations WHERE cycle_id=? ORDER BY user_id').all(cycle),lines);
 const next=await freezeCycle(db,'w','test','2026-12',new Date('2026-12-01T10:00:00Z'));assert.equal(db.sqlite.prepare('SELECT SUM(amount_cents) AS total FROM billing_allocations WHERE cycle_id=?').get(next)?.total,9000);assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM billing_allocations WHERE cycle_id=?').get(next)?.n,3);
});
test('test and live snapshots never collide and consent ceiling is frozen correctly',async()=>{
 const db=seed();db.sqlite.exec(`INSERT INTO billing_accounts (workspace_id,user_id,mode,customer_id,setup_complete,max_cents,consent_version,accepted_at,operation_started_at)VALUES('w','alice','test','cus_alice',1,500,'${CONSENT_VERSION}','2026-01-01','2026-01-01'),('w','owner','test','cus_owner',1,500,'${CONSENT_VERSION}','2026-01-01','2026-01-01')`);
 const cycle=await freezeCycle(db,'w','test','2026-11',new Date('2026-11-01T09:00:00Z'));assert.deepEqual(db.sqlite.prepare('SELECT user_id,status FROM billing_invoices WHERE cycle_id=? ORDER BY user_id').all(cycle).map(x=>[x.user_id,x.status]),[['alice','blocked_cap'],['owner','ready']]);
 await freezeCycle(db,'w','live','2026-11',new Date('2026-11-01T09:00:00Z'));assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM billing_cycles').get()?.n,2);
});
test('payment state is private, setup fails when disabled, and writes reject cross origin',async()=>{
 const db=seed();assert.equal((await handleBillingRequest(req(null,'state?workspace=w'),db,{})).status,401);assert.equal((await handleBillingRequest(req('outsider','state?workspace=w'),db,env)).status,403);
 const disabled=await handleBillingRequest(req('owner','state?workspace=w'),db,{});const state=await disabled.json()as any;assert.equal(state.configured,false);assert.equal(state.mode,'disabled');assert.deepEqual(state.totals,{collectedCents:0,pendingCents:0});assert.equal(disabled.headers.get('Cache-Control'),'no-store');
 assert.equal((await handleBillingRequest(req('owner','setup','POST',{workspaceId:'w',maxCents:5000,consent:true,consentVersion:CONSENT_VERSION}),db,{})).status,503);
 assert.equal((await handleBillingRequest(req('owner','setup','POST',{},'https://evil.test'),db,env)).status,403);
 assert.equal((await handleBillingRequest(req(null,'run','POST',{}),db,env)).status,401);
 assert.equal((await handleBillingRequest(req(null,'webhook','POST',{}),db,env)).status,400);
});
test('ordinary members see only their own invoice and no Stripe customer identifiers',async()=>{
 const db=seed();await freezeCycle(db,'w','test','2026-11',new Date('2026-11-01T09:00:00Z'));
 const alice=await(await handleBillingRequest(req('alice','state?workspace=w'),db,env)).json()as any;assert.equal(alice.payments.length,1);assert.equal(alice.payments[0].userId,'alice');assert.equal('customerId'in alice.payments[0],false);assert.equal('stripeInvoiceId'in alice.payments[0],false);
 const owner=await(await handleBillingRequest(req('owner','state?workspace=w'),db,env)).json()as any;assert.equal(owner.payments.length,2);
});
test('revoking consent blocks future collection and invalidates old setup session references',async()=>{
 const db=seed();db.sqlite.exec(`INSERT INTO billing_accounts (workspace_id,user_id,mode,customer_id,setup_session_id,setup_complete,max_cents,consent_version,accepted_at,operation_started_at)VALUES('w','alice','test','cus_alice','cs_old',1,5000,'${CONSENT_VERSION}','2026-01-01','2026-01-01')`);
 const response=await handleBillingRequest(req('alice','revoke','POST',{workspaceId:'w'}),db,env);assert.equal(response.status,200);assert.deepEqual(db.sqlite.prepare('SELECT setup_complete,setup_session_id FROM billing_accounts WHERE user_id=?').get('alice'),Object.assign(Object.create(null),{setup_complete:0,setup_session_id:null}));
});


test('scheduled leavers remain allocated through notice and are excluded exactly at the Paris exit boundary',async()=>{
 const db=seed();
 db.sqlite.exec("UPDATE subscription_members SET cancellation_requested_at='2026-10-27T10:00:00.000Z',cancellation_effective_at='2026-11-30T23:00:00.000Z' WHERE user_id='alice'");
 const november=await freezeCycle(db,'w','test','2026-11',new Date('2026-11-01T09:00:00Z'));
 assert.deepEqual(db.sqlite.prepare('SELECT user_id,amount_cents FROM billing_allocations WHERE cycle_id=? ORDER BY user_id').all(november).map(x=>[x.user_id,x.amount_cents]),[['alice',501],['owner',500]]);
 const december=await freezeCycle(db,'w','test','2026-12',new Date('2026-12-01T09:00:00Z'));
 assert.deepEqual(db.sqlite.prepare('SELECT user_id,amount_cents FROM billing_allocations WHERE cycle_id=? ORDER BY user_id').all(december).map(x=>[x.user_id,x.amount_cents]),[['owner',1001]]);
 assert.equal(db.sqlite.prepare('SELECT SUM(amount_cents) AS total FROM billing_allocations WHERE cycle_id=?').get(december)?.total,1001);
});
test('failed collection is visible but cannot override money already confirmed, refunded or disputed',()=>{
 assert.equal(reconciledInvoiceStatus({status:'open',attempted:true},0,0,false,1000),'payment_failed');
 assert.equal(reconciledInvoiceStatus({status:'open',attempted:false},0,0,false,1000),'open');
 assert.equal(reconciledInvoiceStatus({status:'open',attempted:true},1000,0,false,1000),'paid');
 assert.equal(reconciledInvoiceStatus({status:'paid',attempted:true},0,0,false,1000),'manual_review');
 assert.equal(reconciledInvoiceStatus({status:'paid',attempted:true},1000,1000,false,1000),'refunded');
 assert.equal(reconciledInvoiceStatus({status:'paid',attempted:true},1000,0,true,1000),'disputed');
 assert.match(billingMandate('Collecteur de test'),/J’autorise Collecteur de test/);
 assert.doesNotMatch(billingMandate('Collecteur de test'),/J’autorise EMBRASSE/);
});
test('inactive collection exposes no mandate under an assumed entity and promises no recovery or bank reserve',async()=>{
 const db=seed();const state=await(await handleBillingRequest(req('owner','state?workspace=w'),db,{})).json()as any;
 assert.equal(state.collectorName,null);assert.equal(state.mandateText,null);
 assert.deepEqual(state.recovery,{automaticRetries:false,externalCollectionEnabled:false,reserveCollectionEnabled:false,prepaidAccessEnforced:false});
 assert.ok(state.reasons.some((reason:string)=>reason.includes('collecteur')));
});

test('pausing collection never prevents revocation of existing provider retries or signed reconciliation',async()=>{
 const db=seed();
 db.sqlite.exec(`INSERT INTO billing_accounts (workspace_id,user_id,mode,customer_id,setup_complete,max_cents,consent_version,accepted_at,operation_started_at)VALUES('w','alice','test','cus_alice',1,5000,'${CONSENT_VERSION}','2026-01-01','2026-01-01')`);
 const cycle=await freezeCycle(db,'w','test','2026-11',new Date('2026-11-01T09:00:00Z'));
 db.sqlite.prepare("UPDATE billing_invoices SET stripe_invoice_id='in_fixture',status='payment_failed' WHERE cycle_id=? AND user_id='alice'").run(cycle);
 const paused={...env,BILLING_SCHEDULER_ENABLED:'false',BILLING_COLLECTOR_VERIFIED:'false',BILLING_RECOVERY_CONFIGURED:'false'};
 assert.equal(billingConfig(paused).configured,false);
 const originalFetch=globalThis.fetch;const writes:string[]=[];
 globalThis.fetch=async(input,init)=>{
   const url=String(input);
   assert.ok(url.startsWith('https://api.stripe.com/v1/'));
   if(init?.method==='POST')writes.push(String(init.body));
   return Response.json(url.includes('/invoice_payments')?{object:'list',data:[],has_more:false}:{id:'in_fixture',object:'invoice',status:'open',attempted:true,livemode:false,total:501});
 };
 try{
  const revoked=await handleBillingRequest(req('alice','revoke','POST',{workspaceId:'w'}),db,paused);
  assert.equal(revoked.status,200);assert.ok(writes.some(value=>value.includes('auto_advance=false')));
  assert.equal(db.sqlite.prepare("SELECT setup_complete FROM billing_accounts WHERE user_id='alice'").get()?.setup_complete,0);
  assert.equal((await handleBillingRequest(req(null,'webhook','POST',{}),db,paused)).status,400,'paused mode still validates provider signatures');
 }finally{globalThis.fetch=originalFetch;}
});
test('revocation invalidates local authorizations even when the environment mode was removed',async()=>{
 const db=seed();db.sqlite.exec(`INSERT INTO billing_accounts (workspace_id,user_id,mode,customer_id,setup_session_id,setup_complete,max_cents,consent_version,accepted_at,operation_started_at)VALUES('w','alice','test','cus_alice','cs_old',1,5000,'${CONSENT_VERSION}','2026-01-01','2026-01-01')`);
 assert.equal((await handleBillingRequest(req('alice','revoke','POST',{workspaceId:'w'}),db,{})).status,200);
 assert.equal(db.sqlite.prepare("SELECT setup_complete FROM billing_accounts WHERE user_id='alice'").get()?.setup_complete,0);
});

test('an invoice from the other environment cannot prevent stopping current provider retries',async()=>{
 const db=seed();
 const live=await freezeCycle(db,'w','live','2026-11',new Date('2026-11-01T09:00:00Z'));
 const sandbox=await freezeCycle(db,'w','test','2026-11',new Date('2026-11-01T09:00:00Z'));
 db.sqlite.prepare("UPDATE billing_invoices SET stripe_invoice_id='in_other_environment',status='open' WHERE cycle_id=? AND user_id='alice'").run(live);
 db.sqlite.prepare("UPDATE billing_invoices SET stripe_invoice_id='in_current_environment',status='open' WHERE cycle_id=? AND user_id='alice'").run(sandbox);
 const originalFetch=globalThis.fetch;let stopped=false;
 globalThis.fetch=async(input,init)=>{
  const url=String(input);assert.ok(!url.includes('in_other_environment'));
  if(init?.method==='POST'&&url.includes('in_current_environment')&&String(init.body).includes('auto_advance=false'))stopped=true;
  return Response.json(url.includes('/invoice_payments')?{object:'list',data:[],has_more:false}:{id:'in_current_environment',object:'invoice',status:'open',attempted:true,livemode:false,total:501});
 };
 try{
  const response=await handleBillingRequest(req('alice','revoke','POST',{workspaceId:'w'}),db,env);
  assert.equal(response.status,503);assert.equal(stopped,true);assert.match((await response.json()as any).error,/raccordé sont arrêtées/);
 }finally{globalThis.fetch=originalFetch;}
});

test('site approval gates new payment access but never prevents an existing member revoking authorization',async()=>{
 const db=seed(),restricted={...env,ACCESS_CONTROL_ENABLED:'true',ACCESS_ADMIN_USER_IDS:'owner'};
 assert.equal((await handleBillingRequest(req('alice','state?workspace=w'),db,restricted)).status,403);
 assert.equal((await handleBillingRequest(req('alice','setup','POST',{workspaceId:'w',maxCents:5000,consent:true,consentVersion:CONSENT_VERSION}),db,restricted)).status,403);
 assert.equal((await handleBillingRequest(req('alice','revoke','POST',{workspaceId:'w'}),db,restricted)).status,200);
 assert.equal((await handleBillingRequest(req('owner','state?workspace=w'),db,restricted,null)).status,401,'resolved anonymous identity must override incoming legacy headers');
});
