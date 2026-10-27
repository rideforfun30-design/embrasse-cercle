import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { handleBureauRequest, type BureauDatabase, type SqlStatement } from "../lib/bureau-api";
import { notificationsConfigured, requireApprovedSiteAccess, type AccessEnv } from "../lib/access";
import { MEMBERSHIP_POLICY_VERSION } from "../lib/membership-policy";

class LocalD1 implements BureauDatabase {
 sqlite=new DatabaseSync(":memory:");private batchQueue:Promise<void>=Promise.resolve();
 constructor(){this.sqlite.exec("PRAGMA foreign_keys=ON");for(const file of readdirSync(new URL("../drizzle",import.meta.url)).filter(p=>p.endsWith(".sql")).sort())this.sqlite.exec(readFileSync(new URL(`../drizzle/${file}`,import.meta.url),"utf8"));}
 prepare(sql:string):SqlStatement{const db=this.sqlite;let values:unknown[]=[];const statement:SqlStatement={bind(...v){values=v;return statement;},async first<T>(){return (db.prepare(sql).get(...values as (string|number|null)[])??null) as T|null;},async all<T>(){return {results:db.prepare(sql).all(...values as (string|number|null)[]) as T[]};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values as (string|number|null)[]).changes)}};}};return statement;}
 async batch(statements:SqlStatement[]){const previous=this.batchQueue;let release!:()=>void;this.batchQueue=new Promise<void>(r=>{release=r;});await previous;this.sqlite.exec("BEGIN");try{const r=[];for(const s of statements)r.push(await s.run());this.sqlite.exec("COMMIT");return r;}catch(e){this.sqlite.exec("ROLLBACK");throw e;}finally{release();}}
}
const origin="https://abonnement.embrasse.tv";
const env:AccessEnv={ACCESS_CONTROL_ENABLED:"true",ACCESS_ADMIN_USER_IDS:"owner",ADMIN_NOTIFICATION_EMAIL:"admin@example.test"};
const policy={policyAccepted:true,policyVersion:MEMBERSHIP_POLICY_VERSION};
async function api(db:LocalD1,user:string|null,path:string,method="GET",data?:unknown,config:AccessEnv=env){const headers:Record<string,string>={Origin:origin,"Content-Type":"application/json"};if(user){headers["oai-authenticated-user-id"]=user;headers["oai-authenticated-user-email"]=`${user}@example.test`;}const response=await handleBureauRequest(new Request(`${origin}/api/${path}`,{method,headers,...(data===undefined?{}:{body:JSON.stringify(data)})}),db,config);return {status:response.status,data:await response.json() as any,headers:response.headers};}
async function requestAccess(db:LocalD1,user:string,optIn=true){return api(db,user,"access/request","POST",{name:user,reason:"Le bureau",notificationOptIn:optIn,email:"forged@example.test"});}
async function admit(db:LocalD1,user:string,optIn=true){assert.equal((await requestAccess(db,user,optIn)).status,201);assert.equal((await api(db,"owner",`access/${user}/approve`,"POST",{})).status,200);}
async function workspace(db:LocalD1){const created=await api(db,"owner","workspaces","POST",{name:"Private bureau"});assert.equal(created.status,201);return created.data;}

test("site access requires explicit approval before private data or any bureau mutations",async()=>{
 const db=new LocalD1(),w=await workspace(db);
 const anonymous=await api(db,null,"state");assert.equal(anonymous.data.access.status,"anonymous");assert.deepEqual(anonymous.data.workspaces,[]);
 const unrequested=await api(db,"alice",`state?workspace=${w.workspaceId}`);assert.equal(unrequested.status,200);assert.equal(unrequested.data.access.status,"unrequested");assert.deepEqual(unrequested.data.members,[]);assert.equal(unrequested.headers.get("cache-control"),"no-store");
 assert.equal((await api(db,"alice","workspaces","POST",{name:"Bypass"})).status,403);
 assert.equal((await api(db,"alice","workspaces/join","POST",{code:w.inviteCode})).status,403);
 assert.equal((await api(db,"alice","profile","POST",{name:"Alice"})).status,200);
 const requested=await requestAccess(db,"alice");assert.equal(requested.data.access.status,"pending");
 assert.equal((await api(db,"alice","workspaces/join","POST",{code:w.inviteCode})).status,403);
 assert.equal((await api(db,"alice","access/requests")).status,403);
 assert.equal((await api(db,"alice","access/alice/approve","POST",{})).status,403);
 assert.equal((await api(db,"owner","access/alice/approve","POST",{})).status,200);
 assert.equal((await api(db,"alice","workspaces/join","POST",{code:w.inviteCode})).status,200);
 const approved=await api(db,"alice","state");assert.equal(approved.data.access.status,"approved");assert.equal(approved.data.workspaces.length,1);
 assert.ok(!approved.data.members.some((p:any)=>"email" in p));
 await assert.rejects(()=>requireApprovedSiteAccess(db,{id:"bob",name:"Bob",email:"bob@example.test"},env),/approuvé/);
});

test("verified email is used, pending requests are idempotent, rejected request may resubmit",async()=>{
 const db=new LocalD1();await requestAccess(db,"alice");await requestAccess(db,"alice");
 const list=await api(db,"owner","access/requests");assert.equal(list.data.requests.length,1);assert.equal(list.data.requests[0].email,"alice@example.test");
 const count=()=>Number((db.sqlite.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE event_key LIKE 'access-request:%'").get() as any).n);
 assert.equal(count(),1);
 const mail=db.sqlite.prepare("SELECT * FROM notification_outbox").get() as any;assert.equal(mail.recipient_email,"admin@example.test");assert.equal(mail.status,"pending");assert.equal(mail.sent_at,null);assert.ok(mail.body_text.includes("alice@example.test"));assert.ok(!mail.body_text.includes("forged@example.test"));
 assert.equal((await api(db,"owner","access/alice/reject","POST",{})).status,200);assert.equal((await api(db,"alice","state")).data.access.status,"rejected");
 assert.equal((await api(db,"owner","access/alice/approve","POST",{})).status,409);
 await requestAccess(db,"alice");assert.equal(count(),2);assert.equal((await api(db,"alice","state")).data.access.status,"pending");
 await api(db,"owner","access/alice/approve","POST",{});await requestAccess(db,"alice");assert.equal(count(),2);assert.equal((await api(db,"alice","state")).data.access.status,"approved");
});

test("missing administrator configuration never opens private data and missing mail transport never claims sent",async()=>{
 const db=new LocalD1();const noAdmin:AccessEnv={ACCESS_CONTROL_ENABLED:"true"};
 const state=await api(db,"owner","state","GET",undefined,noAdmin);assert.equal(state.data.access.isAdmin,false);assert.equal(state.data.access.status,"unrequested");
 assert.equal((await api(db,"owner","workspaces","POST",{name:"No bootstrap"},noAdmin)).status,403);
 const req=await api(db,"alice","access/request","POST",{name:"Alice",notificationOptIn:true},noAdmin);assert.equal(req.data.notification.status,"unconfigured");
 assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get() as any).n,0);
 await requestAccess(db,"alice");assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM notification_outbox").get() as any).n,1);
});

test("accepted subscription member queues exact updated shares only to opted in current participants once",async()=>{
 const db=new LocalD1(),w=await workspace(db);
 await api(db,"owner","profile/notifications","POST",{enabled:true});
 for(const [u,opt] of [["alice",true],["bob",false],["outsider",true]] as const){await admit(db,u,opt);await api(db,u,"workspaces/join","POST",{code:w.inviteCode});}
 const created=await api(db,"owner","subscriptions","POST",{workspaceId:w.workspaceId,name:"Outil",category:"Vidéo",totalCents:1001,maxSeats:3,nextDueDate:"2026-11-01"});const sub=created.data.subscriptionId;
 const mails=()=>db.sqlite.prepare("SELECT * FROM notification_outbox WHERE event_key LIKE 'subscription-joined:%' ORDER BY recipient_user_id").all() as any[];
 await api(db,"alice",`subscriptions/${sub}/request`,"POST",policy);assert.equal(mails().length,0);
 const approvals=await Promise.all([1,2].map(()=>api(db,"owner",`subscriptions/${sub}/approve`,"POST",{userId:"alice"})));assert.deepEqual(approvals.map(r=>r.status).sort(),[200,409]);
 assert.equal(mails().length,2);assert.deepEqual(mails().map(m=>m.recipient_user_id),["alice","owner"]);
 assert.ok(mails()[0].body_text.includes("5.01 EUR"));assert.ok(mails()[1].body_text.includes("5.00 EUR"));assert.ok(mails().every(m=>m.status==="pending"&&m.attempts===0&&m.sent_at===null));
 await api(db,"bob",`subscriptions/${sub}/request`,"POST",policy);await api(db,"owner",`subscriptions/${sub}/approve`,"POST",{userId:"bob"});
 assert.equal(mails().length,4);const last=mails().filter(m=>m.body_text.includes("bob a été accepté"));assert.equal(last.length,2);assert.ok(last.find(m=>m.recipient_user_id==="alice").body_text.includes("3.34 EUR"));assert.ok(last.find(m=>m.recipient_user_id==="owner").body_text.includes("3.33 EUR"));
 assert.ok(!mails().some(m=>m.recipient_user_id==="outsider"||m.recipient_user_id==="bob"));
});

test("notification opt out and expired participants are respected on membership approval",async()=>{
 const db=new LocalD1(),w=await workspace(db);await api(db,"owner","profile/notifications","POST",{enabled:true});
 for(const u of ["alice","bob"]){await admit(db,u);await api(db,u,"workspaces/join","POST",{code:w.inviteCode});}
 const created=await api(db,"owner","subscriptions","POST",{workspaceId:w.workspaceId,name:"Outil",category:"Autre",totalCents:1000,maxSeats:3,nextDueDate:"2026-11-01"});const sub=created.data.subscriptionId;
 await api(db,"alice",`subscriptions/${sub}/request`,"POST",policy);await api(db,"owner",`subscriptions/${sub}/approve`,"POST",{userId:"alice"});
 db.sqlite.prepare("UPDATE subscription_members SET cancellation_effective_at='2020-01-01T00:00:00.000Z' WHERE user_id='alice'").run();
 await api(db,"owner","profile/notifications","POST",{enabled:false});await api(db,"bob",`subscriptions/${sub}/request`,"POST",policy);await api(db,"owner",`subscriptions/${sub}/approve`,"POST",{userId:"bob"});
 const mails=db.sqlite.prepare("SELECT * FROM notification_outbox WHERE body_text LIKE 'bob a été accepté%' ").all() as any[];assert.equal(mails.length,1);assert.equal(mails[0].recipient_user_id,"bob");assert.ok(mails[0].body_text.includes("5.00 EUR"));
 const before=(await api(db,"bob","state")).data.notificationPreferences;assert.equal(before.email,"bob@example.test");assert.equal(before.enabled,true);
 assert.equal((await api(db,"bob","profile/notifications","POST",{enabled:"yes"})).status,400);
});


test("legacy pending participation cannot bypass the newly enabled site approval gate",async()=>{
 const db=new LocalD1(),w=await workspace(db);
 const off:AccessEnv={};
 await api(db,"legacy","workspaces/join","POST",{code:w.inviteCode},off);
 const created=await api(db,"owner","subscriptions","POST",{workspaceId:w.workspaceId,name:"Outil",category:"Autre",totalCents:1000,maxSeats:2,nextDueDate:"2026-11-01"});const sub=created.data.subscriptionId;
 await api(db,"legacy",`subscriptions/${sub}/request`,"POST",policy,off);
 assert.equal((await api(db,"owner",`subscriptions/${sub}/approve`,"POST",{userId:"legacy"})).status,403);
 await admit(db,"legacy");
 assert.equal((await api(db,"owner",`subscriptions/${sub}/approve`,"POST",{userId:"legacy"})).status,200);
});

test("outbox failure rolls back membership approval instead of dropping its notification",async()=>{
 const db=new LocalD1(),w=await workspace(db);await admit(db,"alice");await api(db,"alice","workspaces/join","POST",{code:w.inviteCode});
 const created=await api(db,"owner","subscriptions","POST",{workspaceId:w.workspaceId,name:"Outil",category:"Autre",totalCents:1000,maxSeats:2,nextDueDate:"2026-11-01"});const sub=created.data.subscriptionId;
 await api(db,"alice",`subscriptions/${sub}/request`,"POST",policy);
 db.sqlite.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON notification_outbox WHEN NEW.event_key LIKE 'subscription-joined:%' BEGIN SELECT RAISE(ABORT,'queue unavailable'); END;");
 assert.equal((await api(db,"owner",`subscriptions/${sub}/approve`,"POST",{userId:"alice"})).status,500);
 const member=db.sqlite.prepare("SELECT status,approval_event_id FROM subscription_members WHERE subscription_id=? AND user_id='alice'").get(sub) as any;assert.equal(member.status,"pending");assert.equal(member.approval_event_id,null);
 db.sqlite.exec("DROP TRIGGER fail_queue");assert.equal((await api(db,"owner",`subscriptions/${sub}/approve`,"POST",{userId:"alice"})).status,200);
 const mails=db.sqlite.prepare("SELECT * FROM notification_outbox WHERE event_key LIKE 'subscription-joined:%'").all();assert.equal(mails.length,1);
});


test("email availability requires explicit activation and the configured Google identity",()=>{
 assert.equal(notificationsConfigured(env),false);
 assert.equal(notificationsConfigured({...env,NOTIFICATIONS_GOOGLE_AUDIENCE:"google-client"}),false);
 assert.equal(notificationsConfigured({...env,NOTIFICATIONS_DELIVERY_ENABLED:"true",NOTIFICATIONS_GOOGLE_AUDIENCE:"google-client"}),false);
 assert.equal(notificationsConfigured({...env,NOTIFICATIONS_DELIVERY_ENABLED:"true",NOTIFICATIONS_GOOGLE_AUDIENCE:"google-client",NOTIFICATIONS_GOOGLE_EMAIL:"sender@example.test"}),true);
 assert.equal(notificationsConfigured({...env,NOTIFICATIONS_DELIVERY_ENABLED:"true",NOTIFICATIONS_WORKER_SECRET:"worker-secret"}),false);
 assert.equal(notificationsConfigured({...env,NOTIFICATIONS_DELIVERY_ENABLED:"true",NOTIFICATIONS_GOOGLE_AUDIENCE:"  "}),false);
 assert.equal(notificationsConfigured({...env,ADMIN_NOTIFICATION_EMAIL:"bad",NOTIFICATIONS_DELIVERY_ENABLED:"true",NOTIFICATIONS_GOOGLE_AUDIENCE:"google-client"}),false);
});


test("account decisions notify verified applicants once even with optional member emails disabled",async()=>{
 const db=new LocalD1();await requestAccess(db,"alice",false);
 const approved=await Promise.all([1,2].map(()=>api(db,"owner","access/alice/approve","POST",{})));
 assert.deepEqual(approved.map(r=>r.status).sort(),[200,409]);
 const decisions=()=>db.sqlite.prepare("SELECT * FROM notification_outbox WHERE event_key LIKE 'access-decision:%' ORDER BY created_at,id").all() as any[];
 assert.equal(decisions().length,1);assert.equal(decisions()[0].recipient_user_id,"alice");assert.equal(decisions()[0].recipient_email,"alice@example.test");assert.equal(decisions()[0].status,"pending");assert.equal(decisions()[0].sent_at,null);assert.ok(decisions()[0].body_text.includes("approuvée"));
 await requestAccess(db,"bob",false);await api(db,"owner","access/bob/reject","POST",{});assert.equal(decisions().length,2);assert.ok(decisions().find(m=>m.recipient_user_id==="bob").body_text.includes("n’a pas été approuvée"));
 await requestAccess(db,"bob",false);await api(db,"owner","access/bob/approve","POST",{});assert.equal(decisions().length,3);
});

test("approved account automatically joins only the configured existing bureau and keeps existing roles",async()=>{
 const db=new LocalD1(),w=await workspace(db),config={...env,ACCESS_DEFAULT_WORKSPACE_ID:w.workspaceId};
 await requestAccess(db,"alice");
 const approval=await api(db,"owner","access/alice/approve","POST",{},config);assert.equal(approval.status,200);assert.equal(approval.data.joinedWorkspaceId,w.workspaceId);
 const state=(await api(db,"alice","state","GET",undefined,config)).data;assert.equal(state.workspace.id,w.workspaceId);assert.equal(state.workspace.role,"member");
 await requestAccess(db,"bob");db.sqlite.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) VALUES (?,'bob','admin',?)").run(w.workspaceId,new Date().toISOString());
 await api(db,"owner","access/bob/approve","POST",{},config);assert.equal((await api(db,"bob","state","GET",undefined,config)).data.workspace.role,"admin");
 await requestAccess(db,"outsider");await api(db,"owner","access/outsider/reject","POST",{},config);assert.deepEqual((await api(db,"outsider","state","GET",undefined,config)).data.workspaces,[]);
});

test("invalid or full default bureau does not grant unintended workspace membership",async()=>{
 const db=new LocalD1(),w=await workspace(db);
 await requestAccess(db,"alice");const invalid=await api(db,"owner","access/alice/approve","POST",{},{...env,ACCESS_DEFAULT_WORKSPACE_ID:"missing"});assert.equal(invalid.status,200);assert.equal(invalid.data.joinedWorkspaceId,null);assert.deepEqual((await api(db,"alice","state")).data.workspaces,[]);
 const now=new Date().toISOString();for(let i=0;i<199;i++){
  db.sqlite.prepare("INSERT INTO profiles (id,name,email,created_at) VALUES (?,?,?,?)").run(`full-${i}`,`Member ${i}`,`full-${i}@example.test`,now);
  db.sqlite.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) VALUES (?,?,'member',?)").run(w.workspaceId,`full-${i}`,now);
 }
 await requestAccess(db,"bob");const full=await api(db,"owner","access/bob/approve","POST",{},{...env,ACCESS_DEFAULT_WORKSPACE_ID:w.workspaceId});assert.equal(full.status,200);assert.equal(full.data.joinedWorkspaceId,null);
 assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=?").get(w.workspaceId) as any).n,200);
 assert.equal((await api(db,"bob",`state?workspace=${w.workspaceId}`)).status,403);
});

test("account approval, its notification and automatic admission roll back together",async()=>{
 const db=new LocalD1(),w=await workspace(db);await requestAccess(db,"alice");
 const config={...env,ACCESS_DEFAULT_WORKSPACE_ID:w.workspaceId};
 db.sqlite.exec("CREATE TRIGGER fail_admission BEFORE INSERT ON workspace_members WHEN NEW.user_id='alice' BEGIN SELECT RAISE(ABORT,'admission unavailable'); END;");
 assert.equal((await api(db,"owner","access/alice/approve","POST",{},config)).status,500);
 assert.equal((await api(db,"alice","state")).data.access.status,"pending");
 assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE event_key LIKE 'access-decision:%'").get() as any).n,0);
 assert.equal(db.sqlite.prepare("SELECT user_id FROM workspace_members WHERE user_id='alice'").get(),undefined);
 db.sqlite.exec("DROP TRIGGER fail_admission");assert.equal((await api(db,"owner","access/alice/approve","POST",{},config)).status,200);
 assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE event_key LIKE 'access-decision:%'").get() as any).n,1);
});

test("a legacy member may request their own exit before global access approval without reading private data",async()=>{
 const db=new LocalD1(),w=await workspace(db),off:AccessEnv={};
 await api(db,"legacy","workspaces/join","POST",{code:w.inviteCode},off);
 const created=await api(db,"owner","subscriptions","POST",{workspaceId:w.workspaceId,name:"Outil",category:"Autre",totalCents:1000,maxSeats:2,nextDueDate:"2026-11-01"});const sub=created.data.subscriptionId;
 await api(db,"legacy",`subscriptions/${sub}/request`,"POST",policy,off);await api(db,"owner",`subscriptions/${sub}/approve`,"POST",{userId:"legacy"},off);
 const hidden=await api(db,"legacy",`state?workspace=${w.workspaceId}`);assert.deepEqual(hidden.data.subscriptions,[]);assert.equal(hidden.data.access.status,"unrequested");
 const leave=await api(db,"legacy",`subscriptions/${sub}/leave`,"POST",{});assert.equal(leave.status,200);assert.ok(leave.data.cancellationEffectiveAt);
 assert.equal((await api(db,"legacy",`subscriptions/${sub}/cancel-leave`,"POST",{})).status,403);
});

test("explicit null resolved identity cannot fall back to trusted native headers",async()=>{
 const db=new LocalD1();const request=new Request(origin+"/api/state",{headers:{"oai-authenticated-user-id":"owner","oai-authenticated-user-email":"owner@example.test"}});
 const response=await handleBureauRequest(request,db,env,null);assert.equal((await response.json() as any).user,null);
});

test('only an approved workspace administrator can rename its circle',async()=>{
 const db=new LocalD1(),w=await workspace(db);
 await admit(db,'alice');await api(db,'alice','workspaces/join','POST',{code:w.inviteCode});
 assert.equal((await api(db,'alice',`workspaces/${w.workspaceId}`,'PATCH',{name:'Un autre nom'})).status,403);
 assert.equal((await api(db,'outsider',`workspaces/${w.workspaceId}`,'PATCH',{name:'Un autre nom'})).status,403);
 assert.equal((await api(db,'owner',`workspaces/${w.workspaceId}`,'PATCH',{name:'Le cercle créatif'})).status,200);
 assert.equal((await api(db,'owner','state')).data.workspace.name,'Le cercle créatif');
});
