import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync,readdirSync } from "node:fs";
import { handleEmailAuthRequest,resolveSiteUser,mapVerifiedAuthUser,emailAuthConfigured,type EmailAuthEnv } from "../lib/email-auth";
import { chosenPasswordStrength } from "../lib/password-strength";
import { handleBureauRequest,type BureauDatabase,type SqlStatement } from "../lib/bureau-api";

class LocalD1 implements BureauDatabase {
 sqlite=new DatabaseSync(":memory:");private queue:Promise<void>=Promise.resolve();
 constructor(){this.sqlite.exec("PRAGMA foreign_keys=ON");for(const f of readdirSync(new URL("../drizzle",import.meta.url)).filter(x=>x.endsWith(".sql")).sort())this.sqlite.exec(readFileSync(new URL(`../drizzle/${f}`,import.meta.url),"utf8"));}
 prepare(sql:string):SqlStatement{
  const db=this.sqlite;let values:unknown[]=[];
  const statement:SqlStatement&{raw():Promise<unknown[][]>}={
   bind(...v){values=v;return statement;},
   async first<T>(){return (db.prepare(sql).get(...values as any[])??null) as T|null;},
   async all<T>(){return {results:db.prepare(sql).all(...values as any[]) as T[]};},
   async run(){const result=db.prepare(sql).run(...values as any[]);return {meta:{changes:Number(result.changes)}};},
   async raw(){return db.prepare(sql).all(...values as any[]).map(row=>Object.values(row));},
  };return statement;
 }
 async batch(statements:SqlStatement[]){const previous=this.queue;let release!:()=>void;this.queue=new Promise<void>(r=>release=r);await previous;this.sqlite.exec("BEGIN");try{const result=[];for(const s of statements)result.push(await s.run());this.sqlite.exec("COMMIT");return result;}catch(e){this.sqlite.exec("ROLLBACK");throw e;}finally{release();}}
}
const origin="https://abonnement.embrasse.tv";
const env:EmailAuthEnv={AUTH_EMAIL_ENABLED:"true",BETTER_AUTH_SECRET:"local-test-secret-at-least-thirty-two-characters",BETTER_AUTH_URL:origin,ACCESS_CONTROL_ENABLED:"true",ACCESS_ADMIN_USER_IDS:"native-owner",ADMIN_NOTIFICATION_EMAIL:"admin@example.test",NOTIFICATIONS_DELIVERY_ENABLED:"true",NOTIFICATIONS_GOOGLE_AUDIENCE:"local-test-google-audience",NOTIFICATIONS_GOOGLE_EMAIL:"sender@example.test"};
const password="Orbite-sureau-nuage-7284!";
let ipCounter=1;
async function api(db:LocalD1,path:string,data?:unknown,options:{cookie?:string;config?:EmailAuthEnv;origin?:string;ip?:string;method?:string}={}){
 const method=options.method??(path==="get-session"?"GET":"POST"),headers:Record<string,string>={Origin:options.origin??origin,"Content-Type":"application/json","cf-connecting-ip":options.ip??`192.0.2.${ipCounter++}`};if(options.cookie)headers.Cookie=options.cookie;
 const request=new Request(`${origin}/api/auth/${path}`,{method,headers,...(method==="GET"?{}:{body:JSON.stringify(data??{})})});
 const response=await handleEmailAuthRequest(request,db,options.config??env);const body=await response.json() as any;
 return {status:response.status,data:body,headers:response.headers};
}
function otp(db:LocalD1,email:string){const row=db.sqlite.prepare("SELECT body_text FROM notification_outbox WHERE event_key LIKE 'auth-otp:%' AND recipient_email=? AND status='pending' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(email) as any;const code=row?.body_text.match(/: (\d{6})\n/)?.[1];assert.ok(code,"A verification code must be queued without printing its value");return code as string;}
function cookie(headers:Headers){const match=headers.get("set-cookie")?.match(/((?:__Secure-)?embrasse\.session_token=[^;,\s]+)/);assert.ok(match,"A session cookie must be set");return match[1];}
async function signup(db:LocalD1,email="alice@example.test"){const result=await api(db,"sign-up/email",{email,password,name:"Créatif"});assert.equal(result.status,200,`signup error code ${result.data.code??"unknown"}`);return result;}
async function verified(db:LocalD1,email="alice@example.test"){await signup(db,email);const result=await api(db,"email-otp/verify-email",{email,otp:otp(db,email)});assert.equal(result.status,200,`verify error code ${result.data.code??"unknown"}`);assert.equal(result.headers.get("set-cookie"),null);return result;}
async function signin(db:LocalD1,email="alice@example.test",chosen=password){return api(db,"sign-in/email",{email,password:chosen});}

 test("email auth remains explicitly unavailable until Google delivery and auth configuration exist",async()=>{
  const db=new LocalD1();assert.equal(emailAuthConfigured(env),true);
  for(const config of [{...env,NOTIFICATIONS_DELIVERY_ENABLED:"false"},{...env,BETTER_AUTH_SECRET:"short"},{...env,NOTIFICATIONS_GOOGLE_EMAIL:undefined},{...env,AUTH_EMAIL_ENABLED:"false"}]){
   assert.equal(emailAuthConfigured(config),false);const result=await api(db,"sign-up/email",{email:"a@example.test",password,name:"A"},{config});assert.equal(result.status,503);assert.equal(result.data.code,"AUTH_EMAIL_UNAVAILABLE");
  }
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_users").get() as any).n,0);assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get() as any).n,0);
 });
 test("chosen password signup verifies the email before login and stores only a password hash",async()=>{
  const db=new LocalD1();await signup(db);
  const account=db.sqlite.prepare("SELECT password FROM auth_accounts").get() as any;assert.ok(typeof account.password==="string"&&account.password!==password);assert.ok(!account.password.includes(password));
  const verification=db.sqlite.prepare("SELECT value FROM auth_verifications").get() as any;assert.ok(!verification.value.includes(otp(db,"alice@example.test")));
  const outbox=db.sqlite.prepare("SELECT expires_at,status,sent_at FROM notification_outbox").get() as any;assert.equal(outbox.status,"pending");assert.equal(outbox.sent_at,null);assert.ok(Date.parse(outbox.expires_at)>Date.now());assert.ok(Date.parse(outbox.expires_at)<=Date.now()+600_000);
  const early=await signin(db);assert.equal(early.status,403);assert.equal(early.data.code,"EMAIL_NOT_VERIFIED");
  const verifiedResult=await api(db,"email-otp/verify-email",{email:"alice@example.test",otp:otp(db,"alice@example.test")});assert.equal(verifiedResult.status,200);assert.equal(verifiedResult.headers.get("set-cookie"),null);assert.ok(!("token" in verifiedResult.data));
  const logged=await signin(db);assert.equal(logged.status,200);assert.ok(!("token" in logged.data));const sessionCookie=cookie(logged.headers);const flags=logged.headers.get("set-cookie")!;assert.match(flags,/HttpOnly/i);assert.match(flags,/Secure/i);assert.match(flags,/SameSite=Lax/i);
  const identity=await resolveSiteUser(new Request(origin,{headers:{Cookie:sessionCookie}}),db,env);assert.equal(identity?.email,"alice@example.test");
  const state=await handleBureauRequest(new Request(origin+"/api/state"),db,env,identity);const body=await state.json() as any;assert.equal(body.access.status,"unrequested");assert.deepEqual(body.subscriptions,[]);
  const session=await api(db,"get-session",undefined,{cookie:sessionCookie});assert.equal(session.status,200);assert.ok(!("token" in session.data.session));
  await api(db,"sign-out",{},{cookie:sessionCookie});assert.equal(await resolveSiteUser(new Request(origin,{headers:{Cookie:sessionCookie}}),db,env),null);
 });
 test("local strength checking rejects obvious strings and accepts long passphrases without external checks",async()=>{
  for(const weak of ["aaaaaaaaaaaa","123456789012","motdepasse123","bonjourbonjour"]){assert.equal((await chosenPasswordStrength(weak)).ok,false);}
  assert.equal((await chosenPasswordStrength(password)).ok,true);assert.equal((await chosenPasswordStrength("Sureau galets orbite mangue parapluie")).ok,true);
  const db=new LocalD1(),weak=await api(db,"sign-up/email",{email:"weak@example.test",password:"aaaaaaaaaaaa",name:"Weak"});assert.equal(weak.status,400);assert.equal(weak.data.code,"WEAK_PASSWORD");assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_users").get() as any).n,0);
 });
 test("same origin protection and disabled alternate authentication prevent shortcuts",async()=>{
  const db=new LocalD1();assert.equal((await api(db,"sign-up/email",{email:"a@example.test",password,name:"A"},{origin:"https://evil.test"})).status,403);
  assert.equal((await api(db,"sign-in/email-otp",{email:"a@example.test",otp:"000000"})).status,404);
  assert.equal((await api(db,"email-otp/send-verification-otp",{email:"a@example.test",type:"sign-in"})).status,400);
  const spoofed=new Request(origin,{headers:{"oai-authenticated-user-id":"member","oai-authenticated-user-email":"member@example.test"}});assert.equal(await resolveSiteUser(spoofed,db,env),null);
  const rescue=new Request(origin,{headers:{"oai-authenticated-user-id":"native-owner","oai-authenticated-user-email":"owner@example.test"}});assert.equal((await resolveSiteUser(rescue,db,env))?.id,"native-owner");
 });
 test("resends are limited per email across IPs, with five verification attempts per code",async()=>{
  const db=new LocalD1();await signup(db);
  const repeat=await api(db,"email-otp/send-verification-otp",{email:"alice@example.test",type:"email-verification"});assert.equal(repeat.status,429);assert.equal(repeat.data.code,"OTP_RESEND_TOO_SOON");
  const valid=otp(db,"alice@example.test"),wrong=valid==="000000"?"111111":"000000";
  for(let i=0;i<5;i++)assert.equal((await api(db,"email-otp/verify-email",{email:"alice@example.test",otp:wrong})).status,400);
  const blocked=await api(db,"email-otp/verify-email",{email:"alice@example.test",otp:valid});assert.equal(blocked.status,403);assert.equal(blocked.data.code,"TOO_MANY_ATTEMPTS");
  assert.equal((db.sqlite.prepare("SELECT email_verified FROM auth_users").get() as any).email_verified,0);
 });
 test("verified identity maps uniquely to a prior profile and preserves owner access",async()=>{
  const db=new LocalD1();db.sqlite.prepare("INSERT INTO profiles (id,name,email,created_at) VALUES ('native-owner','Tom','ALICE@example.test',?)").run(new Date().toISOString());
  await verified(db);const login=await signin(db);assert.equal(login.status,200);assert.equal(login.data.user.id,"native-owner");
  const identity=await resolveSiteUser(new Request(origin,{headers:{Cookie:cookie(login.headers)}}),db,env);assert.equal(identity?.id,"native-owner");
  const link=db.sqlite.prepare("SELECT profile_id FROM auth_profile_links").get() as any;assert.equal(link.profile_id,"native-owner");assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM profiles").get() as any).n,1);
 });
 test("ambiguous legacy emails never silently merge accounts or retain the new session",async()=>{
  const db=new LocalD1();for(const id of ["legacy-one","legacy-two"])db.sqlite.prepare("INSERT INTO profiles (id,name,email,created_at) VALUES (?,?,?,?)").run(id,id,"alice@example.test",new Date().toISOString());
  await verified(db);const login=await signin(db);assert.equal(login.status,409);assert.equal(login.data.code,"AUTH_IDENTITY_AMBIGUOUS");assert.equal(login.headers.get("set-cookie"),null);assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get() as any).n,0);
  await assert.rejects(()=>mapVerifiedAuthUser(db,{id:"fake",email:"alice@example.test",emailVerified:true}),/vérifiée/);
 });
 test("OTP password recovery revokes the old session and requires the new chosen password",async()=>{
  const db=new LocalD1();await verified(db);const login=await signin(db);assert.equal(login.status,200);const oldCookie=cookie(login.headers);
  db.sqlite.prepare("UPDATE auth_email_send_limits SET last_sent_at=?").run(Date.now()-61_000);
  const recovery=await api(db,"email-otp/request-password-reset",{email:"alice@example.test"});assert.equal(recovery.status,200);
  const newPassword="Comète-rivage-ardoise-9163!";
  const reset=await api(db,"email-otp/reset-password",{email:"alice@example.test",otp:otp(db,"alice@example.test"),password:newPassword});assert.equal(reset.status,200);assert.equal(reset.headers.get("set-cookie"),null);
  assert.equal(await resolveSiteUser(new Request(origin,{headers:{Cookie:oldCookie}}),db,env),null);
  assert.equal((await signin(db,"alice@example.test",password)).status,401);assert.equal((await signin(db,"alice@example.test",newPassword)).status,200);
 });
 test("login throttling persists per email across client IPs",async()=>{
  const db=new LocalD1();await verified(db);
  for(let i=0;i<10;i++)assert.equal((await signin(db,"alice@example.test","Wrong-but-long-password-7381")).status,401);
  const blocked=await signin(db);assert.equal(blocked.status,429);assert.equal(blocked.data.code,"TOO_MANY_LOGIN_ATTEMPTS");
 });
 test("expired verification codes and expired sessions cannot be reused",async()=>{
  const db=new LocalD1();await signup(db);const code=otp(db,"alice@example.test");
  db.sqlite.prepare("UPDATE auth_verifications SET expires_at=?").run(Date.now()-1);
  const expired=await api(db,"email-otp/verify-email",{email:"alice@example.test",otp:code});assert.equal(expired.status,400);
  assert.equal((db.sqlite.prepare("SELECT email_verified FROM auth_users").get() as any).email_verified,0);
  db.sqlite.prepare("UPDATE auth_email_send_limits SET last_sent_at=?").run(Date.now()-61_000);
  await api(db,"email-otp/send-verification-otp",{email:"alice@example.test",type:"email-verification"});
  const fresh=otp(db,"alice@example.test");assert.equal((await api(db,"email-otp/verify-email",{email:"alice@example.test",otp:fresh})).status,200);
  assert.equal((await api(db,"email-otp/verify-email",{email:"alice@example.test",otp:fresh})).status,400);
  const login=await signin(db);assert.equal(login.status,200);const oldCookie=cookie(login.headers);
  db.sqlite.prepare("UPDATE auth_sessions SET expires_at=?").run(Date.now()-1);assert.equal(await resolveSiteUser(new Request(origin,{headers:{Cookie:oldCookie}}),db,env),null);
 });
