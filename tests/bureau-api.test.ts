import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
// @ts-ignore Node's test runner strips TypeScript in this source import.
import { handleBureauRequest, splitCents, type BureauDatabase, type SqlStatement } from "../lib/bureau-api.ts";

class LocalD1 implements BureauDatabase {
  sqlite = new DatabaseSync(":memory:");
  constructor(beforeMigration?: string) {
    this.sqlite.exec("PRAGMA foreign_keys=ON");
    for (const file of readdirSync(new URL("../drizzle",import.meta.url)).filter(p=>p.endsWith(".sql")&&(!beforeMigration||p<beforeMigration)).sort()) {
      this.sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),"utf8"));
    }
  }
  prepare(sql: string): SqlStatement {
    const sqlite=this.sqlite;
    let values:unknown[]=[];
    const statement:SqlStatement={
      bind(...args:unknown[]){values=args;return statement;},
      async first<T>(){return (sqlite.prepare(sql).get(...values as (string|number|null)[])??null) as T|null;},
      async all<T>(){return {results:sqlite.prepare(sql).all(...values as (string|number|null)[]) as T[]};},
      async run(){const r=sqlite.prepare(sql).run(...values as (string|number|null)[]);return {meta:{changes:Number(r.changes)}};},
    };
    return statement;
  }
  private batchQueue:Promise<void>=Promise.resolve();
  async batch(statements:SqlStatement[]){
    const previous=this.batchQueue;let release!:()=>void;this.batchQueue=new Promise<void>(resolve=>{release=resolve;});await previous;
    this.sqlite.exec("BEGIN");
    try{const results=[];for(const s of statements)results.push(await s.run());this.sqlite.exec("COMMIT");return results;}
    catch(e){this.sqlite.exec("ROLLBACK");throw e;}finally{release();}
  }
}
import { MEMBERSHIP_POLICY_VERSION, cancellationEffectiveAt } from "../lib/membership-policy";
const policy={policyAccepted:true,policyVersion:MEMBERSHIP_POLICY_VERSION};
const origin="https://abonnement.embrasse.tv";
async function api(db:LocalD1,user:string|null,path:string,method="GET",data?:unknown,customOrigin=origin){
 const headers:Record<string,string>={"Content-Type":"application/json",Origin:customOrigin};
 if(user){headers["oai-authenticated-user-id"]=user;headers["oai-authenticated-user-email"]=`${user}@example.test`;}
 const request=new Request(origin+"/api/"+path,{method,headers,...(data===undefined?{}:{body:JSON.stringify(data)})});
 const response=await handleBureauRequest(request,db);
 return {status:response.status,data:await response.json() as any,headers:response.headers};
}
async function setup(){
 const db=new LocalD1();
 const created=await api(db,"owner","workspaces","POST",{name:"Le bureau"});assert.equal(created.status,201);
 const {workspaceId,inviteCode}=created.data;
 const sub=await api(db,"owner","subscriptions","POST",{workspaceId,name:"Outil vidéo",category:"Vidéo",totalCents:1000,maxSeats:2,nextDueDate:"2026-11-01"});assert.equal(sub.status,201);
 return {db,workspaceId,inviteCode,subscriptionId:sub.data.subscriptionId};
}
test("exact split conserves every cent and deterministic allocation",()=>{
 for(let amount=1;amount<=1007;amount+=7)for(let n=1;n<=20;n++){
  const members=Array.from({length:n},(_,i)=>`member-${i}`);
  const split=splitCents(amount,members);
  assert.equal(Object.values(split).reduce((a,b)=>a+b,0),amount);
  assert.ok(Math.max(...Object.values(split))-Math.min(...Object.values(split))<=1);
  assert.deepEqual(split,splitCents(amount,[...members].reverse()));
 }
 assert.throws(()=>splitCents(100,[]));
 assert.throws(()=>splitCents(100,["a","a"]));
});
test("anonymous and other bureau members cannot read or mutate a private bureau",async()=>{
 const {db,workspaceId,subscriptionId}=await setup();
 const anonymous=await api(db,null,"state");assert.equal(anonymous.status,200);assert.equal(anonymous.data.user,null);assert.deepEqual(anonymous.data.subscriptions,[]);
 assert.equal((await api(db,"outsider",`state?workspace=${workspaceId}`)).status,403);
 assert.equal((await api(db,"outsider",`subscriptions/${subscriptionId}/request`,"POST",policy)).status,403);
 assert.equal((await api(db,null,"subscriptions","POST",{})).status,401);
 assert.equal((await api(db,"owner","profile","POST",{name:"x"},"https://evil.test")).status,403);
 const state=await api(db,"owner","state");assert.equal(state.headers.get("cache-control"),"no-store");assert.equal(state.data.subscriptions.length,1);
});
test("invite-only membership and capacity remain correct under competing approvals",async()=>{
 const {db,workspaceId,inviteCode,subscriptionId}=await setup();
 for(const user of ["alice","bob"]){
  assert.equal((await api(db,user,"workspaces/join","POST",{code:inviteCode})).status,200);
  assert.equal((await api(db,user,`subscriptions/${subscriptionId}/request`,"POST",policy)).status,201);
 }
 assert.equal((await api(db,"alice",`subscriptions/${subscriptionId}/approve`,"POST",{userId:"bob"})).status,403);
 const attempts=await Promise.all(["alice","bob"].map(userId=>api(db,"owner",`subscriptions/${subscriptionId}/approve`,"POST",{userId})));
 assert.deepEqual(attempts.map(a=>a.status).sort(),[200,409]);
 const state=await api(db,"owner",`state?workspace=${workspaceId}`);
 assert.equal(state.data.subscriptions[0].activeCount,2);
 assert.equal(state.data.subscriptions[0].shareCents,500);
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}`,"PATCH",{maxSeats:1})).status,409);
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}/leave`,"POST",{})).status,409);
 const active=state.data.subscriptions[0].memberIds.find((u:string)=>u!=="owner");
 assert.equal((await api(db,active,`subscriptions/${subscriptionId}/leave`,"POST",{})).status,200);
 assert.equal((await api(db,"owner","state")).data.subscriptions[0].shareCents,500);
 const leaving=(await api(db,active,"state")).data.subscriptions[0];
 assert.equal(leaving.myStatus,"active");assert.ok(leaving.myCancellationEffectiveAt);
});
test("subscription validation rejects invalid prices, capacity, and calendar dates",async()=>{
 const {db,workspaceId}=await setup();
 const values={workspaceId,name:"Musique",category:"Musique",totalCents:1100,maxSeats:5,nextDueDate:"2026-11-01"};
 for(const bad of [{totalCents:1.5},{totalCents:0},{maxSeats:0},{maxSeats:101},{nextDueDate:"2026-02-30"},{category:"Unknown"}]){
  assert.equal((await api(db,"owner","subscriptions","POST",{...values,...bad})).status,400);
 }
});
test("service links persist through create and edit without replacing a chosen subscription name",async()=>{
 const {db,workspaceId}=await setup();
 const created=await api(db,"owner","subscriptions","POST",{workspaceId,name:"Creative Cloud équipe",category:"Design",totalCents:5500,maxSeats:4,nextDueDate:"2026-11-01",websiteUrl:"www.adobe.com/fr/creativecloud.html?tracking=private#plans"});
 assert.equal(created.status,201);
 const subscriptionId=created.data.subscriptionId;
 const read=async()=> (await api(db,"owner",`state?workspace=${workspaceId}`)).data.subscriptions.find((s:any)=>s.id===subscriptionId);
 assert.equal((await read()).websiteUrl,"https://www.adobe.com/fr/creativecloud.html");
 assert.equal((await read()).name,"Creative Cloud équipe");
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}`,"PATCH",{name:"Adobe collectif"})).status,200);
 assert.equal((await read()).websiteUrl,"https://www.adobe.com/fr/creativecloud.html");
 assert.equal((await read()).name,"Adobe collectif");
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}`,"PATCH",{websiteUrl:"https://figma.com/pricing?token=do-not-store#team"})).status,200);
 assert.equal((await read()).websiteUrl,"https://figma.com/pricing");
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}`,"PATCH",{websiteUrl:""})).status,200);
 assert.equal((await read()).websiteUrl,null);
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}`,"PATCH",{websiteUrl:"artlist.io"})).status,200);
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}`,"PATCH",{websiteUrl:null})).status,200);
 assert.equal((await read()).websiteUrl,null);
});
test("subscriptions without service links remain readable and editable",async()=>{
 const {db,subscriptionId}=await setup();
 const state=(await api(db,"owner","state")).data;
 assert.equal(state.subscriptions[0].websiteUrl,null);
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}`,"PATCH",{description:"Un ancien abonnement"})).status,200);
 assert.equal((await api(db,"owner","state")).data.subscriptions[0].websiteUrl,null);
});
test("the additive service-link migration preserves existing subscription rows",async()=>{
 const db=new LocalD1("0008"),now=new Date().toISOString();
 db.sqlite.prepare("INSERT INTO profiles (id,name,email,created_at) VALUES ('owner','Owner','owner@example.test',?)").run(now);
 db.sqlite.prepare("INSERT INTO workspaces (id,name,owner_id,invite_code,created_at) VALUES ('legacy','Legacy','owner','legacy-invitation-code',?)").run(now);
 db.sqlite.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) VALUES ('legacy','owner','admin',?)").run(now);
 db.sqlite.prepare("INSERT INTO subscriptions (id,workspace_id,owner_id,name,category,description,total_cents,max_seats,next_due_date,archived,created_at) VALUES ('legacy-tool','legacy','owner','Ancien outil','Design','Préservé',2345,5,'2026-11-01',0,?)").run(now);
 db.sqlite.exec(readFileSync(new URL("../drizzle/0008_chief_dracula.sql",import.meta.url),"utf8"));
 const migrated=(await api(db,"owner","state")).data.subscriptions[0];
 assert.equal(migrated.name,"Ancien outil");assert.equal(migrated.totalCents,2345);assert.equal(migrated.websiteUrl,null);
 assert.equal((await api(db,"owner","subscriptions/legacy-tool","PATCH",{websiteUrl:"figma.com"})).status,200);
 assert.equal((await api(db,"owner","state")).data.subscriptions[0].websiteUrl,"https://figma.com/");
});
test("service links reject unsafe and malformed inputs before any subscription write",async()=>{
 const {db,workspaceId,subscriptionId}=await setup();
 const values={workspaceId,name:"Site",category:"Autre",totalCents:1000,maxSeats:2,nextDueDate:"2026-11-01"};
 for(const websiteUrl of [false,42,[],{},"javascript:alert(1)","data:text/html,hello","ftp://adobe.com/file","https://name:password@adobe.com","https://localhost","http://127.0.0.1","http://0x7f000001","https://[::1]","https://metadata.google.internal","https://adobe.com:8443","https://adobe.com/\nsecret","https://bad host.com"]){
  assert.equal((await api(db,"owner","subscriptions","POST",{...values,websiteUrl})).status,400,JSON.stringify(websiteUrl));
  assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}`,"PATCH",{websiteUrl})).status,400,JSON.stringify(websiteUrl));
 }
 assert.equal((await api(db,"owner","state")).data.subscriptions.length,1);
});
test("service links do not permit cross-circle writes or editing another member's subscription",async()=>{
 const {db,workspaceId,inviteCode,subscriptionId}=await setup();
 await api(db,"member","workspaces/join","POST",{code:inviteCode});
 await api(db,"outsider","workspaces","POST",{name:"Un autre cercle"});
 assert.equal((await api(db,"member",`subscriptions/${subscriptionId}`,"PATCH",{websiteUrl:"figma.com"})).status,403);
 assert.equal((await api(db,"outsider",`subscriptions/${subscriptionId}`,"PATCH",{websiteUrl:"figma.com"})).status,403);
 assert.equal((await api(db,"outsider","subscriptions","POST",{workspaceId,name:"Intrusion",category:"Autre",totalCents:100,maxSeats:1,nextDueDate:"2026-11-01",websiteUrl:"figma.com"})).status,403);
 assert.equal((await api(db,"owner","state")).data.subscriptions[0].websiteUrl,null);
});
test("pending requests are only visible to their responsible people",async()=>{
 const {db,inviteCode,subscriptionId}=await setup();
 for(const user of ["alice","bob"])await api(db,user,"workspaces/join","POST",{code:inviteCode});
 await api(db,"alice",`subscriptions/${subscriptionId}/request`,"POST",policy);
 const alice=await api(db,"alice","state");assert.deepEqual(alice.data.requests,[]);assert.equal(alice.data.subscriptions[0].myStatus,"pending");assert.ok(!("inviteCode" in alice.data.workspace));
 assert.equal((await api(db,"owner","state")).data.requests[0].userName,"alice");
 assert.equal((await api(db,"bob",`subscriptions/${subscriptionId}`,"DELETE")).status,403);
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}`,"DELETE")).status,200);
 assert.deepEqual((await api(db,"owner","state")).data.subscriptions,[]);
});

test("durable write budget blocks excess mutations without blocking reads",async()=>{
 const {db}=await setup();
 for(let i=0;i<98;i++) assert.equal((await api(db,"owner","profile","POST",{name:`Owner ${i}`})).status,200);
 assert.equal((await api(db,"owner","profile","POST",{name:"Over budget"})).status,429);
 assert.equal((await api(db,"owner","state")).status,200);
 const other=await api(db,"other","workspaces","POST",{name:"Another bureau"});assert.equal(other.status,201);
});
test("rotated invitation stops the previous link and only admin can rotate",async()=>{
 const {db,workspaceId,inviteCode}=await setup();
 await api(db,"alice","workspaces/join","POST",{code:inviteCode});
 assert.equal((await api(db,"alice",`workspaces/${workspaceId}/rotate-invite`,"POST",{})).status,403);
 const rotated=await api(db,"owner",`workspaces/${workspaceId}/rotate-invite`,"POST",{});
 assert.equal(rotated.status,200);assert.notEqual(rotated.data.inviteCode,inviteCode);
 assert.equal((await api(db,"outsider","workspaces/join","POST",{code:inviteCode})).status,404);
 assert.equal((await api(db,"outsider","workspaces/join","POST",{code:rotated.data.inviteCode})).status,200);
});
test("admin cannot bypass an active participant notice when removing a member",async()=>{
 const {db,workspaceId,inviteCode,subscriptionId}=await setup();
 await api(db,"alice","workspaces/join","POST",{code:inviteCode});
 await api(db,"alice",`subscriptions/${subscriptionId}/request`,"POST",policy);
 await api(db,"owner",`subscriptions/${subscriptionId}/approve`,"POST",{userId:"alice"});
 assert.equal((await api(db,"alice",`workspaces/${workspaceId}/remove-member`,"POST",{userId:"owner"})).status,403);
 assert.equal((await api(db,"owner",`workspaces/${workspaceId}/remove-member`,"POST",{userId:"owner"})).status,409);
 const owned=await api(db,"alice","subscriptions","POST",{workspaceId,name:"Own tool",category:"Autre",totalCents:500,maxSeats:1,nextDueDate:"2026-11-01"});
 assert.equal((await api(db,"owner",`workspaces/${workspaceId}/remove-member`,"POST",{userId:"alice"})).status,409);
 await api(db,"alice",`subscriptions/${owned.data.subscriptionId}`,"DELETE");
 assert.equal((await api(db,"owner",`workspaces/${workspaceId}/remove-member`,"POST",{userId:"alice"})).status,409);
 await api(db,"alice",`subscriptions/${subscriptionId}/leave`,"POST",{});
 assert.equal((await api(db,"owner",`workspaces/${workspaceId}/remove-member`,"POST",{userId:"alice"})).status,409);
 db.sqlite.prepare("UPDATE subscription_members SET cancellation_effective_at='2020-01-01T00:00:00.000Z' WHERE subscription_id=? AND user_id='alice'").run(subscriptionId);
 assert.equal((await api(db,"owner",`workspaces/${workspaceId}/remove-member`,"POST",{userId:"alice"})).status,200);
 const state=await api(db,"owner","state");assert.equal(state.data.subscriptions[0].activeCount,1);assert.ok(!state.data.members.some((m:any)=>m.id==="alice"));
 assert.equal((await api(db,"alice",`state?workspace=${workspaceId}`)).status,403);
});
test("subscription and workspace counts are bounded even after archiving and joining",async()=>{
 const {db,workspaceId,inviteCode}=await setup();
 const now=new Date().toISOString();
 const insertSub=db.sqlite.prepare("INSERT INTO subscriptions (id,workspace_id,owner_id,name,category,description,total_cents,max_seats,next_due_date,archived,created_at) VALUES (?,?,?,'Archived','Autre','',100,1,'2026-11-01',1,?)");
 for(let i=0;i<199;i++)insertSub.run(`archive-${i}`,workspaceId,"owner",now);
 assert.equal((await api(db,"owner","subscriptions","POST",{workspaceId,name:"Too many",category:"Autre",totalCents:100,maxSeats:1,nextDueDate:"2026-11-01"})).status,409);
 await api(db,"target","profile","POST",{name:"Target"});
 for(let i=0;i<20;i++){
  db.sqlite.prepare("INSERT INTO workspaces (id,name,owner_id,invite_code,created_at) VALUES (?,?,'owner',?,?)").run(`other-${i}`,`Bureau ${i}`,`code-other-${i}-long-enough`,now);
  db.sqlite.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) VALUES (?,'target','member',?)").run(`other-${i}`,now);
 }
 assert.equal((await api(db,"target","workspaces/join","POST",{code:inviteCode})).status,409);
 assert.equal((await api(db,"target","workspaces","POST",{name:"Too many"})).status,409);
});


test("new participation needs explicit current policy acceptance",async()=>{
 const {db,inviteCode,subscriptionId}=await setup();
 await api(db,"alice","workspaces/join","POST",{code:inviteCode});
 for(const consent of [{},{policyAccepted:false,policyVersion:MEMBERSHIP_POLICY_VERSION},{policyAccepted:true,policyVersion:"old"}]){
  assert.equal((await api(db,"alice",`subscriptions/${subscriptionId}/request`,"POST",consent)).status,400);
 }
 assert.equal((await api(db,"alice",`subscriptions/${subscriptionId}/request`,"POST",policy)).status,201);
 const row=db.sqlite.prepare("SELECT policy_version,policy_accepted_at FROM subscription_members WHERE subscription_id=? AND user_id='alice'").get(subscriptionId) as any;
 assert.equal(row.policy_version,MEMBERSHIP_POLICY_VERSION);assert.ok(row.policy_accepted_at);
 assert.equal((await api(db,"alice",`subscriptions/${subscriptionId}/leave`,"POST",{})).status,200);
 assert.equal((await api(db,"alice","state")).data.subscriptions[0].myStatus,"none");
});

test("notice preserves shares and capacity, can be revoked, and expires without a cleanup job",async()=>{
 const {db,workspaceId,inviteCode,subscriptionId}=await setup();
 for(const user of ["alice","bob"])await api(db,user,"workspaces/join","POST",{code:inviteCode});
 await api(db,"alice",`subscriptions/${subscriptionId}/request`,"POST",policy);
 await api(db,"owner",`subscriptions/${subscriptionId}/approve`,"POST",{userId:"alice"});
 const leave=await api(db,"alice",`subscriptions/${subscriptionId}/leave`,"POST",{});
 assert.equal(leave.status,200);assert.equal(leave.data.cancellationEffectiveAt,cancellationEffectiveAt(leave.data.cancellationRequestedAt));
 const repeated=await api(db,"alice",`subscriptions/${subscriptionId}/leave`,"POST",{});
 assert.equal(repeated.data.cancellationRequestedAt,leave.data.cancellationRequestedAt);assert.equal(repeated.data.cancellationEffectiveAt,leave.data.cancellationEffectiveAt);
 const state=(await api(db,"alice",`state?workspace=${workspaceId}`)).data.subscriptions[0];
 assert.equal(state.myStatus,"active");assert.equal(state.shareCents,500);assert.equal(state.activeCount,2);assert.equal(state.myCancellationEffectiveAt,leave.data.cancellationEffectiveAt);
 assert.equal((await api(db,"bob",`subscriptions/${subscriptionId}/request`,"POST",policy)).status,409);
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}`,"PATCH",{maxSeats:1})).status,409);
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}/approve`,"POST",{userId:"alice"})).status,409);
 assert.equal((await api(db,"bob",`subscriptions/${subscriptionId}/cancel-leave`,"POST",{})).status,409);
 assert.equal((await api(db,"alice",`subscriptions/${subscriptionId}/cancel-leave`,"POST",{})).status,200);
 assert.equal((await api(db,"alice","state")).data.subscriptions[0].myCancellationEffectiveAt,null);
 await api(db,"alice",`subscriptions/${subscriptionId}/leave`,"POST",{});
 db.sqlite.prepare("UPDATE subscription_members SET cancellation_effective_at='2020-01-01T00:00:00.000Z' WHERE subscription_id=? AND user_id='alice'").run(subscriptionId);
 const after=(await api(db,"alice","state")).data.subscriptions[0];assert.equal(after.myStatus,"none");assert.equal(after.activeCount,1);assert.equal(after.myCancellationEffectiveAt,null);
 assert.equal((await api(db,"owner","state")).data.subscriptions[0].shareCents,1000);
 assert.equal((await api(db,"alice",`subscriptions/${subscriptionId}/cancel-leave`,"POST",{})).status,409);
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}/approve`,"POST",{userId:"alice"})).status,409);
 assert.equal((await api(db,"bob",`subscriptions/${subscriptionId}/request`,"POST",policy)).status,201);
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}/approve`,"POST",{userId:"bob"})).status,200);
 assert.equal((await api(db,"owner","state")).data.subscriptions[0].activeCount,2);
});

test("expired participation must request and accept again, rather than silently resuming",async()=>{
 const {db,inviteCode,subscriptionId}=await setup();
 await api(db,"alice","workspaces/join","POST",{code:inviteCode});
 await api(db,"alice",`subscriptions/${subscriptionId}/request`,"POST",policy);
 await api(db,"owner",`subscriptions/${subscriptionId}/approve`,"POST",{userId:"alice"});
 db.sqlite.prepare("UPDATE subscription_members SET cancellation_requested_at='2020-01-01T00:00:00.000Z',cancellation_effective_at='2020-02-01T00:00:00.000Z' WHERE subscription_id=? AND user_id='alice'").run(subscriptionId);
 assert.equal((await api(db,"alice",`subscriptions/${subscriptionId}/request`,"POST",{})).status,400);
 assert.equal((await api(db,"alice",`subscriptions/${subscriptionId}/request`,"POST",policy)).status,201);
 const state=(await api(db,"alice","state")).data.subscriptions[0];assert.equal(state.myStatus,"pending");assert.equal(state.myCancellationEffectiveAt,null);assert.equal(state.myPolicyVersion,MEMBERSHIP_POLICY_VERSION);
 assert.equal((await api(db,"owner",`subscriptions/${subscriptionId}/approve`,"POST",{userId:"alice"})).status,200);
});

test("legacy members do not acquire notice without accepting and only self can accept",async()=>{
 const {db,inviteCode,subscriptionId}=await setup();
 await api(db,"legacy","workspaces/join","POST",{code:inviteCode});
 const insert=()=>db.sqlite.prepare("INSERT INTO subscription_members (subscription_id,user_id,status,joined_at) VALUES (?,'legacy','active',?)").run(subscriptionId,new Date().toISOString());insert();
 const legacy=(await api(db,"legacy","state")).data.subscriptions[0];assert.equal(legacy.myPolicyVersion,null);
 assert.equal((await api(db,"legacy",`subscriptions/${subscriptionId}/leave`,"POST",{})).data.cancellationEffectiveAt,null);
 assert.equal((await api(db,"legacy","state")).data.subscriptions[0].myStatus,"none");
 insert();
 assert.equal((await api(db,"legacy",`subscriptions/${subscriptionId}/accept-policy`,"POST",{})).status,400);
 assert.equal((await api(db,"outsider",`subscriptions/${subscriptionId}/accept-policy`,"POST",policy)).status,403);
 assert.equal((await api(db,"legacy",`subscriptions/${subscriptionId}/accept-policy`,"POST",policy)).status,200);
 const accepted=(await api(db,"legacy","state")).data.subscriptions[0];assert.equal(accepted.myPolicyVersion,MEMBERSHIP_POLICY_VERSION);assert.ok(accepted.myPolicyAcceptedAt);
 const leave=await api(db,"legacy",`subscriptions/${subscriptionId}/leave`,"POST",{});assert.ok(leave.data.cancellationEffectiveAt);
});
