import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,readdirSync} from "node:fs";
import type {BureauDatabase,SqlStatement} from "../lib/bureau-api";
import {verifyGoogleMailWorker,handleNotificationDelivery} from "../lib/notification-delivery";
class LocalD1 implements BureauDatabase {
 sqlite=new DatabaseSync(":memory:");private batchQueue:Promise<void>=Promise.resolve();
 constructor(){this.sqlite.exec("PRAGMA foreign_keys=ON");for(const file of readdirSync(new URL("../drizzle",import.meta.url)).filter(p=>p.endsWith(".sql")).sort())this.sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),"utf8"));}
 prepare(sql:string):SqlStatement{const db=this.sqlite;let values:unknown[]=[];const statement:SqlStatement={bind(...v){values=v;return statement;},async first<T>(){return (db.prepare(sql).get(...values as (string|number|null)[])??null) as T|null;},async all<T>(){return {results:db.prepare(sql).all(...values as (string|number|null)[]) as T[]};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values as (string|number|null)[]).changes)}};}};return statement;}
 async batch(statements:SqlStatement[]){const previous=this.batchQueue;let release!:()=>void;this.batchQueue=new Promise<void>(r=>{release=r;});await previous;this.sqlite.exec("BEGIN");try{const r=[];for(const s of statements)r.push(await s.run());this.sqlite.exec("COMMIT");return r;}catch(e){this.sqlite.exec("ROLLBACK");throw e;}finally{release();}}
}

const env={NOTIFICATIONS_GOOGLE_AUDIENCE:'test-audience',NOTIFICATIONS_GOOGLE_EMAIL:'mailer@example.test',NOTIFICATIONS_DELIVERY_ENABLED:'true'};
const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',keys.publicKey),kid:'fixture-key'};
const encode=(v:unknown)=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url');
async function token(extra:Record<string,unknown>={}){const stamp=Math.floor(Date.now()/1000);const body=encode({alg:'RS256',kid:jwk.kid})+'.'+encode({iss:'https://accounts.google.com',aud:env.NOTIFICATIONS_GOOGLE_AUDIENCE,email:env.NOTIFICATIONS_GOOGLE_EMAIL,email_verified:true,sub:'fixture-user',iat:stamp,exp:stamp+3600,...extra});return body+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(body))).toString('base64url');}
function req(action:string,auth:string,data:unknown={}){return new Request('https://abonnement.embrasse.tv/api/notifications/'+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth},body:JSON.stringify(data)});}
function seed(){const db=new LocalD1();db.sqlite.exec("INSERT INTO profiles(id,name,email,created_at,notifications_enabled) VALUES('alice','Alice','alice@example.test','2026-01-01',1)");return db;}
function queue(db:LocalD1,id:string,key='subscription-joined:',recipient:string|null='alice',expires:string|null=null){db.sqlite.prepare("INSERT INTO notification_outbox(id,event_key,recipient_user_id,recipient_email,subject,body_text,status,attempts,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,'pending',0,'2026-01-01','2026-01-01',?)").run(id,key+id,recipient,recipient?'alice@example.test':'admin@example.test','Notification','Détail du message',expires);}
async function withGoogle<T>(fn:()=>Promise<T>){const original=globalThis.fetch;globalThis.fetch=async input=>{assert.equal(String(input),'https://www.googleapis.com/oauth2/v3/certs');return Response.json({keys:[jwk]});};try{return await fn();}finally{globalThis.fetch=original;}}
test('mailworker validates Google signature, audience, sender, expiry and verified email',async()=>{
 await verifyGoogleMailWorker(await token(),env,async()=>[jwk]);
 for(const change of [{aud:'other-app'},{email:'outsider@example.test'},{email_verified:false},{exp:1},{iss:'https://evil.test'}])await assert.rejects(()=>token(change).then(t=>verifyGoogleMailWorker(t,env,async()=>[jwk])));
 const valid=await token();await assert.rejects(()=>verifyGoogleMailWorker(valid.slice(0,-5)+'AAAAA',env,async()=>[jwk]));
 await assert.rejects(()=>verifyGoogleMailWorker(valid,{...env,NOTIFICATIONS_GOOGLE_AUDIENCE:''},async()=>[jwk]));
});
test('only authorized worker leases one mail, confirms it once and keeps responses private',async()=>withGoogle(async()=>{
 const db=seed();queue(db,'one');queue(db,'two');const auth=await token();
 assert.equal((await handleNotificationDelivery(req('jobs','forged'),db,env)).status,401);
 const response=await handleNotificationDelivery(req('jobs',auth),db,env);assert.equal(response.headers.get('cache-control'),'no-store');const jobs=(await response.json()as any).jobs;assert.equal(jobs.length,1);
 const j=jobs[0];assert.equal((await handleNotificationDelivery(req('ack',auth,{id:j.id,leaseToken:'wrong',outcome:'sent'}),db,env)).status,409);
 assert.equal((await handleNotificationDelivery(req('ack',auth,{id:j.id,leaseToken:j.leaseToken,outcome:'sent'}),db,env)).status,200);
 assert.equal((await handleNotificationDelivery(req('ack',auth,{id:j.id,leaseToken:j.leaseToken,outcome:'sent'}),db,env)).status,409);
 assert.equal(db.sqlite.prepare('SELECT status FROM notification_outbox WHERE id=?').get(j.id)?.status,'sent');
}));
test('opting out after enqueue cancels group messages but preserves account decisions',async()=>withGoogle(async()=>{
 const db=seed();queue(db,'group');queue(db,'account','access-decision:');db.sqlite.exec("UPDATE profiles SET notifications_enabled=0 WHERE id='alice'");const auth=await token();
 const jobs=(await(await handleNotificationDelivery(req('jobs',auth),db,env)).json()as any).jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].id,'account');assert.equal(db.sqlite.prepare("SELECT status FROM notification_outbox WHERE id='group'").get()?.status,'cancelled');
}));
test('expired codes are erased and never sent; expired sending leases are never auto-retried',async()=>withGoogle(async()=>{
 const db=seed();queue(db,'expired','auth-otp:',null,'2026-01-01');queue(db,'ambiguous');db.sqlite.exec("UPDATE notification_outbox SET status='sending',lease_until='2026-01-01',attempts=1 WHERE id='ambiguous'");const auth=await token();
 assert.deepEqual((await(await handleNotificationDelivery(req('jobs',auth),db,env)).json()as any).jobs,[]);
 assert.equal(db.sqlite.prepare("SELECT body_text FROM notification_outbox WHERE id='expired'").get()?.body_text,'');assert.equal(db.sqlite.prepare("SELECT status FROM notification_outbox WHERE id='ambiguous'").get()?.status,'uncertain');
}));
test('pausing new sends still allows acknowledgement of an existing attempt and removes sent code',async()=>withGoogle(async()=>{
 const db=seed();queue(db,'otp','auth-otp:',null,new Date(Date.now()+600000).toISOString());const auth=await token();const j=(await(await handleNotificationDelivery(req('jobs',auth),db,env)).json()as any).jobs[0];const paused={...env,NOTIFICATIONS_DELIVERY_ENABLED:'false'};
 assert.equal((await handleNotificationDelivery(req('jobs',auth),db,paused)).status,503);
 assert.equal((await handleNotificationDelivery(req('ack',auth,{id:j.id,leaseToken:j.leaseToken,outcome:'sent'}),db,paused)).status,200);assert.equal(db.sqlite.prepare("SELECT body_text FROM notification_outbox WHERE id='otp'").get()?.body_text,'');
}));
