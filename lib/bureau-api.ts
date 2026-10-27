import { cancellationEffectiveAt, membershipIsActive, MEMBERSHIP_POLICY_VERSION } from "./membership-policy";
import { AccessError, adminNotificationEmail, notificationsConfigured, getSiteAccess, requireApprovedSiteAccess, requireSiteAccessAdmin, type AccessEnv } from "./access";
import { accessRequestNotification, accessDecisionNotification, joinedSubscriptionNotifications } from "./notifications";

export type BureauUser = { id: string; name: string; email: string };
export type SqlStatement = {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
};
export type BureauDatabase = {
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<unknown[]>;
};

type Workspace = { id: string; name: string; owner_id: string; invite_code: string; created_at: string };
type Membership = { role: "admin" | "member" };
type SubscriptionMember = { subscription_id: string; user_id: string; status: string; cancellation_requested_at: string | null; cancellation_effective_at: string | null; policy_version: string | null; policy_accepted_at: string | null };
type Subscription = {
  id: string; workspace_id: string; owner_id: string; name: string; category: string;
  description: string; total_cents: number; max_seats: number; next_due_date: string;
  archived: number; created_at: string;
};
class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const CATEGORIES = ["Vidéo", "Photo", "Musique", "Design", "IA", "Stockage", "Productivité", "Autre"];
const iso = () => new Date().toISOString();
const id = () => crypto.randomUUID();
function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" } });
}
function text(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "string") throw new ApiError(400, `${label} invalide.`);
  const clean = value.trim();
  if (clean.length < min || clean.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clean)) throw new ApiError(400, `${label} : ${min} à ${max} caractères.`);
  return clean;
}
function integer(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new ApiError(400, `${label} invalide.`);
  return value;
}
function calendarDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "2020-01-01" || value > "2100-12-31") throw new ApiError(400, "Date de renouvellement invalide.");
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ApiError(400, "Date de renouvellement invalide.");
  return value;
}
function subscriptionInput(data: Record<string, unknown>) {
  const category = text(data.category ?? "Autre", "Catégorie", 1, 50);
  if (!CATEGORIES.includes(category)) throw new ApiError(400, "Catégorie inconnue.");
  return {
    name: text(data.name, "Nom", 1, 100), category,
    description: text(data.description ?? "", "Description", 0, 2000),
    totalCents: integer(data.totalCents, "Prix mensuel", 1, 10_000_000),
    maxSeats: integer(data.maxSeats, "Nombre de places", 1, 100),
    nextDueDate: calendarDate(data.nextDueDate),
  };
}
export function splitCents(totalCents: number, memberIds: string[]): Record<string, number> {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0 || !memberIds.length || new Set(memberIds).size !== memberIds.length) throw new Error("Répartition invalide");
  const ordered = [...memberIds].sort();
  const base = Math.floor(totalCents / ordered.length), remainder = totalCents % ordered.length;
  return Object.fromEntries(ordered.map((userId, i) => [userId, base + (i < remainder ? 1 : 0)]));
}
export function requestUser(request: Request): BureauUser | null {
  const userId = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email");
  if (!userId || !email) return null;
  let name = request.headers.get("oai-authenticated-user-full-name") || "";
  if (request.headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
    try { name = decodeURIComponent(name); } catch { name = ""; }
  }
  return { id: userId, email, name: name.trim().slice(0, 80) || email.split("@")[0].slice(0, 80) || "Membre" };
}
async function ensureProfile(db: BureauDatabase, user: BureauUser) {
  const profile = await db.prepare("SELECT name,email FROM profiles WHERE id=?").bind(user.id).first<{name:string;email:string}>();
  if (profile) {
    user.name = profile.name;
    if (profile.email !== user.email) await db.prepare("UPDATE profiles SET email=? WHERE id=?").bind(user.email,user.id).run();
    return;
  }
  await db.prepare("INSERT INTO profiles (id,name,email,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(user.id,user.name,user.email,iso()).run();
}
async function consumeWriteBudget(db: BureauDatabase, userId: string) {
  const bucket = Math.floor(Date.now() / 3_600_000);
  const result = await db.prepare("INSERT INTO api_write_budgets (user_id,bucket,count) VALUES (?,?,1) ON CONFLICT(user_id,bucket) DO UPDATE SET count=count+1 WHERE count<100").bind(userId,bucket).run();
  if (!result.meta.changes) throw new ApiError(429,"Trop de modifications en une heure. Réessayez un peu plus tard.");
  await db.prepare("DELETE FROM api_write_budgets WHERE bucket<?").bind(bucket-48).run();
}
async function requireWorkspace(db: BureauDatabase, workspaceId: string, userId: string) {
  const membership = await db.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(workspaceId,userId).first<Membership>();
  if (!membership) throw new ApiError(403, "Ce cercle est privé.");
  return membership;
}
async function requireSubscription(db: BureauDatabase, subscriptionId: string, userId: string) {
  const sub = await db.prepare("SELECT * FROM subscriptions WHERE id=? AND archived=0").bind(subscriptionId).first<Subscription>();
  if (!sub) throw new ApiError(404, "Abonnement introuvable.");
  const membership = await requireWorkspace(db, sub.workspace_id, userId);
  return { sub, membership, canManage: membership.role === "admin" || sub.owner_id === userId };
}
async function state(db: BureauDatabase, user: BureauUser | null, workspaceId: string | null, env: AccessEnv) {
  if(user) await ensureProfile(db,user);
  const access=await getSiteAccess(db,user,env);
  const preference=user?await db.prepare("SELECT notifications_enabled FROM profiles WHERE id=?").bind(user.id).first<{notifications_enabled:number}>():null;
  const notificationPreferences={enabled:!!preference?.notifications_enabled,email:user?.email??null};
  const empty = { access,notificationPreferences,user, workspaces: [], workspace: null, members: [], subscriptions: [], requests: [], billing: {configured:false,mode:"disabled"}, payments: [] };
  if (!user || access.status!=="approved") return json(empty);
  const { results: workspaces } = await db.prepare("SELECT w.id,w.name,m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at,w.id LIMIT 100").bind(user.id).all<{id:string;name:string;role:string}>();
  if (!workspaces.length) {
    if (workspaceId) throw new ApiError(403,"Ce cercle est privé.");
    return json({...empty,user,workspaces});
  }
  const selected = workspaceId ? workspaces.find(w=>w.id===workspaceId) : workspaces[0];
  if (!selected) throw new ApiError(403,"Ce cercle est privé.");
  const workspace = await db.prepare("SELECT * FROM workspaces WHERE id=?").bind(selected.id).first<Workspace>();
  if (!workspace) throw new ApiError(404,"Bureau introuvable.");
  const {results: members} = await db.prepare("SELECT p.id,p.name,m.role,m.joined_at AS joinedAt FROM workspace_members m JOIN profiles p ON p.id=m.user_id WHERE m.workspace_id=? ORDER BY m.joined_at,p.id").bind(workspace.id).all<{id:string;name:string;role:string;joinedAt:string}>();
  const {results: subs} = await db.prepare("SELECT s.*,p.name AS owner_name FROM subscriptions s JOIN profiles p ON p.id=s.owner_id WHERE s.workspace_id=? AND s.archived=0 ORDER BY s.created_at DESC,s.id").bind(workspace.id).all<Subscription&{owner_name:string}>();
  const {results: allMembers} = await db.prepare("SELECT sm.subscription_id,sm.user_id,sm.status,sm.cancellation_requested_at,sm.cancellation_effective_at,sm.policy_version,sm.policy_accepted_at FROM subscription_members sm JOIN subscriptions s ON s.id=sm.subscription_id WHERE s.workspace_id=? AND s.archived=0 ORDER BY sm.user_id").bind(workspace.id).all<SubscriptionMember>();
  const now=iso();
  const subscriptions = subs.map(s=>{
    const active = allMembers.filter(m=>m.subscription_id===s.id&&membershipIsActive(m.status,m.cancellation_effective_at,now)).map(m=>m.user_id);
    const mine=allMembers.find(m=>m.subscription_id===s.id&&m.user_id===user.id);
    const shares=active.length?splitCents(s.total_cents,active):{};
    const prospective=active.includes(user.id)?shares[user.id]:splitCents(s.total_cents,[...active,user.id])[user.id];
    return {id:s.id,name:s.name,category:s.category,description:s.description,totalCents:s.total_cents,maxSeats:s.max_seats,activeCount:active.length,ownerId:s.owner_id,ownerName:s.owner_name,memberIds:active,myStatus:s.owner_id===user.id?"owner":mine?.status==="active"&&!membershipIsActive(mine.status,mine.cancellation_effective_at,now)?"none":mine?.status??"none",myCancellationRequestedAt:mine&&membershipIsActive(mine.status,mine.cancellation_effective_at,now)?mine.cancellation_requested_at:null,myCancellationEffectiveAt:mine&&membershipIsActive(mine.status,mine.cancellation_effective_at,now)?mine.cancellation_effective_at:null,myPolicyVersion:mine?.policy_version??null,myPolicyAcceptedAt:mine?.policy_accepted_at??null,shareCents:shares[user.id]??Math.ceil(s.total_cents/Math.max(1,active.length)),prospectiveShareCents:prospective,fullShareCents:Math.ceil(s.total_cents/s.max_seats),nextDueDate:s.next_due_date,createdAt:s.created_at};
  });
  const {results:requests} = await db.prepare("SELECT sm.subscription_id AS subscriptionId,s.name AS subscriptionName,sm.user_id AS userId,p.name AS userName,sm.joined_at AS createdAt FROM subscription_members sm JOIN subscriptions s ON s.id=sm.subscription_id JOIN profiles p ON p.id=sm.user_id WHERE s.workspace_id=? AND s.archived=0 AND sm.status='pending' AND (?='admin' OR s.owner_id=?) ORDER BY sm.joined_at").bind(workspace.id,selected.role,user.id).all();
  return json({access,notificationPreferences,user,workspaces,workspace:{id:workspace.id,name:workspace.name,role:selected.role,...(selected.role==="admin"?{inviteCode:workspace.invite_code}:{})},members,subscriptions,requests,billing:{configured:false,mode:"disabled"},payments:[]});
}
export async function handleBureauRequest(request: Request, db: BureauDatabase, env: AccessEnv = {}, resolvedUser?: BureauUser | null): Promise<Response> {
  try {
    const url=new URL(request.url), parts=url.pathname.replace(/^\/api\/?/,"").split("/").filter(Boolean);
    const user=resolvedUser===undefined?requestUser(request):resolvedUser;
    if(request.method==="GET" && parts[0]==="state" && parts.length===1) return await state(db,user,url.searchParams.get("workspace"),env);
    if(!user) throw new ApiError(401,"Connectez-vous pour continuer.");
    if(request.method==="GET"&&parts[0]==="access"&&parts[1]==="requests"&&parts.length===2){
      requireSiteAccessAdmin(user,env);
      const {results:requests}=await db.prepare("SELECT user_id AS userId,name,email,reason,status,created_at AS createdAt,updated_at AS updatedAt FROM site_access_requests ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,updated_at DESC,user_id LIMIT 200").all();
      return json({requests,notificationEmailConfigured:notificationsConfigured(env)});
    }
    if(request.headers.get("Origin")!==url.origin) throw new ApiError(403,"Origine de la requête non autorisée.");
    if(!["POST","PATCH","DELETE"].includes(request.method)) throw new ApiError(405,"Méthode non autorisée.");
    let data:Record<string,unknown>={};
    if(request.method!=="DELETE") {
      if(!request.headers.get("Content-Type")?.startsWith("application/json")) throw new ApiError(415,"Format JSON requis.");
      if(Number(request.headers.get("Content-Length"))>16384) throw new ApiError(413,"Requête trop volumineuse.");
      const raw=await request.text();if(raw.length>16384)throw new ApiError(413,"Requête trop volumineuse.");
      try{data=JSON.parse(raw);}catch{throw new ApiError(400,"JSON invalide.");}
      if(!data||Array.isArray(data)||typeof data!=="object")throw new ApiError(400,"Données invalides.");
    }
    await consumeWriteBudget(db,user.id);
    await ensureProfile(db,user);
    if(parts[0]==="profile"&&parts.length===1&&request.method==="POST") {
      const name=text(data.name,"Prénom ou nom",1,80);
      await db.prepare("UPDATE profiles SET name=? WHERE id=?").bind(name,user.id).run();return json({ok:true,user:{...user,name}});
    }
    if(parts[0]==="profile"&&parts[1]==="notifications"&&parts.length===2&&request.method==="POST") {
      if(typeof data.enabled!=="boolean")throw new ApiError(400,"Préférence de notification invalide.");
      await db.prepare("UPDATE profiles SET notifications_enabled=? WHERE id=?").bind(data.enabled?1:0,user.id).run();
      return json({ok:true,notificationPreferences:{enabled:data.enabled,email:user.email}});
    }
    if(parts[0]==="access"&&parts[1]==="request"&&parts.length===2&&request.method==="POST") {
      const current=await getSiteAccess(db,user,env);
      if(current.status==="approved")return json({ok:true,access:current,notification:{status:"not-needed"}});
      const name=text(data.name,"Prénom ou nom",1,80),reason=text(data.reason??"","Votre message",0,1000),now=iso();
      if(typeof data.notificationOptIn!=="boolean")throw new ApiError(400,"Choisissez votre préférence de notification.");
      const existing=await db.prepare("SELECT status,request_event_id FROM site_access_requests WHERE user_id=?").bind(user.id).first<{status:string;request_event_id:string}>();
      const eventId=existing?.status==="pending"?existing.request_event_id:id(),recipient=adminNotificationEmail(env);
      const statements=[
        db.prepare("UPDATE profiles SET name=?,notifications_enabled=? WHERE id=?").bind(name,data.notificationOptIn?1:0,user.id),
        db.prepare("INSERT INTO site_access_requests (user_id,name,email,reason,status,request_event_id,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,email=excluded.email,reason=excluded.reason,status='pending',request_event_id=CASE WHEN site_access_requests.status='pending' THEN site_access_requests.request_event_id ELSE excluded.request_event_id END,created_at=CASE WHEN site_access_requests.status='pending' THEN site_access_requests.created_at ELSE excluded.created_at END,updated_at=excluded.updated_at,decided_by=NULL WHERE site_access_requests.status<>'approved'").bind(user.id,name,user.email,reason,eventId,now,now),
      ];
      if(recipient)statements.push(accessRequestNotification(db,user.id,eventId,recipient,now));
      await db.batch(statements);
      user.name=name;
      const queued=recipient?await db.prepare("SELECT id FROM notification_outbox WHERE event_key=?").bind(`access-request:${eventId}`).first():null;
      return json({ok:true,access:await getSiteAccess(db,user,env),notification:{status:queued?"queued":recipient?"not-needed":"unconfigured"}},201);
    }
    if(parts[0]==="access"&&parts.length===3&&request.method==="POST"&&(parts[2]==="approve"||parts[2]==="reject")) {
      requireSiteAccessAdmin(user,env);
      const target=text(parts[1],"Membre",1,200),status=parts[2]==="approve"?"approved":"rejected";
      if(target===user.id)throw new ApiError(409,"Le responsable conserve son accès administrateur.");
      const now=iso(),defaultWorkspaceId=env.ACCESS_DEFAULT_WORKSPACE_ID?.trim()??"";
      const statements=[
        db.prepare("UPDATE site_access_requests SET status=?,updated_at=?,decided_by=? WHERE user_id=? AND status='pending'").bind(status,now,user.id,target),
        accessDecisionNotification(db,target,status,user.id,now),
      ];
      // The outbox INSERT follows the conditional UPDATE; changes() links admission to this decision.
      if(status==="approved"&&defaultWorkspaceId)statements.push(db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) SELECT w.id,r.user_id,'member',? FROM workspaces w JOIN site_access_requests r ON r.user_id=? WHERE w.id=? AND r.status='approved' AND r.updated_at=? AND r.decided_by=? AND changes()=1 AND (SELECT COUNT(*) FROM workspace_members WHERE workspace_id=w.id)<200 AND (SELECT COUNT(*) FROM workspace_members WHERE user_id=r.user_id)<20 ON CONFLICT(workspace_id,user_id) DO NOTHING").bind(now,target,defaultWorkspaceId,now,user.id));
      const results=await db.batch(statements);
      if(!(results[0] as {meta:{changes?:number}}).meta.changes)throw new ApiError(409,"Cette demande a déjà été traitée ou n’existe pas.");
      const joined=status==="approved"&&defaultWorkspaceId?await db.prepare("SELECT workspace_id FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(defaultWorkspaceId,target).first():null;
      return json({ok:true,status,joinedWorkspaceId:joined?defaultWorkspaceId:null});
    }
    if(!(parts[0]==="subscriptions"&&parts.length===3&&parts[2]==="leave"&&request.method==="POST"))await requireApprovedSiteAccess(db,user,env);
    if(parts[0]==="workspaces"&&parts.length===2&&request.method==="PATCH") {
      const workspaceId=parts[1],membership=await requireWorkspace(db,workspaceId,user.id);
      if(membership.role!=="admin")throw new ApiError(403,"Seul le responsable peut renommer ce cercle.");
      const name=text(data.name,"Nom du cercle",1,100);
      await db.prepare("UPDATE workspaces SET name=? WHERE id=?").bind(name,workspaceId).run();
      return json({ok:true,workspaceId});
    }
    if(parts[0]==="workspaces"&&parts.length===1&&request.method==="POST") {
      const count=await db.prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE user_id=?").bind(user.id).first<{count:number}>();
      if((count?.count??0)>=20)throw new ApiError(409,"Vous avez déjà 20 cercles.");
      const name=text(data.name,"Nom du cercle",1,100),workspaceId=id(),code=id().replaceAll("-","")+id().replaceAll("-","").slice(0,8),now=iso();
      await db.batch([db.prepare("INSERT INTO workspaces (id,name,owner_id,invite_code,created_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM workspace_members WHERE user_id=?)<20").bind(workspaceId,name,user.id,code,now,user.id),db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) SELECT ?,?,'admin',? WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=?)").bind(workspaceId,user.id,now,workspaceId)]);
      const created = await db.prepare("SELECT id FROM workspaces WHERE id=?").bind(workspaceId).first();
      if (!created) throw new ApiError(409,"Vous avez déjà 20 cercles.");
      return json({ok:true,workspaceId,inviteCode:code},201);
    }
    if(parts[0]==="workspaces"&&parts[1]==="join"&&parts.length===2&&request.method==="POST") {
      const code=text(data.code,"Code d’invitation",20,100);
      const workspace=await db.prepare("SELECT * FROM workspaces WHERE invite_code=?").bind(code).first<Workspace>();
      if(!workspace)throw new ApiError(404,"Invitation introuvable.");
      const existing=await db.prepare("SELECT user_id FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(workspace.id,user.id).first();
      if(!existing){
        const joined=await db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) SELECT ?,?,'member',? WHERE (SELECT COUNT(*) FROM workspace_members WHERE workspace_id=?)<200 AND (SELECT COUNT(*) FROM workspace_members WHERE user_id=?)<20 ON CONFLICT(workspace_id,user_id) DO NOTHING").bind(workspace.id,user.id,iso(),workspace.id,user.id).run();
        if(!joined.meta.changes)throw new ApiError(409,"Le cercle est complet ou vous avez atteint la limite de 20 cercles.");
      }
      return json({ok:true,workspaceId:workspace.id});
    }
    if(parts[0]==="workspaces"&&parts.length===3&&request.method==="POST") {
      const workspaceId=parts[1],membership=await requireWorkspace(db,workspaceId,user.id);
      if(membership.role!=="admin")throw new ApiError(403,"Seul le responsable du cercle peut réaliser cette action.");
      if(parts[2]==="rotate-invite") {
        const code=id().replaceAll("-","")+id().replaceAll("-","").slice(0,8);
        await db.prepare("UPDATE workspaces SET invite_code=? WHERE id=?").bind(code,workspaceId).run();
        return json({ok:true,inviteCode:code});
      }
      if(parts[2]==="remove-member") {
        const target=text(data.userId,"Membre",1,200);
        const workspace=await db.prepare("SELECT owner_id FROM workspaces WHERE id=?").bind(workspaceId).first<{owner_id:string}>();
        if(!workspace)throw new ApiError(404,"Bureau introuvable.");
        if(workspace.owner_id===target)throw new ApiError(409,"Le responsable du cercle ne peut pas être retiré.");
        const owned=await db.prepare("SELECT id FROM subscriptions WHERE workspace_id=? AND owner_id=? AND archived=0 LIMIT 1").bind(workspaceId,target).first();
        if(owned)throw new ApiError(409,"Ce membre doit d’abord archiver ses abonnements dont il est responsable.");
        const now=iso();
        const active=await db.prepare("SELECT 1 FROM subscription_members sm JOIN subscriptions s ON s.id=sm.subscription_id WHERE s.workspace_id=? AND s.archived=0 AND sm.user_id=? AND sm.status='active' AND (sm.cancellation_effective_at IS NULL OR sm.cancellation_effective_at>?) LIMIT 1").bind(workspaceId,target,now).first();
        if(active)throw new ApiError(409,"Ce membre participe encore à un abonnement. Son préavis doit être terminé avant de le retirer du cercle.");
        const guard="NOT EXISTS(SELECT 1 FROM subscriptions WHERE workspace_id=? AND owner_id=? AND archived=0) AND NOT EXISTS(SELECT 1 FROM subscription_members sm JOIN subscriptions s ON s.id=sm.subscription_id WHERE s.workspace_id=? AND s.archived=0 AND sm.user_id=? AND sm.status='active' AND (sm.cancellation_effective_at IS NULL OR sm.cancellation_effective_at>?))";
        await db.batch([
          db.prepare(`DELETE FROM workspace_members WHERE workspace_id=? AND user_id=? AND ${guard}`).bind(workspaceId,target,workspaceId,target,workspaceId,target,now),
          db.prepare("DELETE FROM subscription_members WHERE user_id=? AND subscription_id IN (SELECT id FROM subscriptions WHERE workspace_id=?) AND NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?)").bind(target,workspaceId,workspaceId,target),
        ]);
        const remaining=await db.prepare("SELECT user_id FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(workspaceId,target).first();
        if(remaining)throw new ApiError(409,"Ce membre participe encore à un abonnement actif. Réessayez après la fin de son préavis ou son archivage.");
        return json({ok:true});
      }
    }
    if(parts[0]==="subscriptions"&&parts.length===1&&request.method==="POST") {
      const workspaceId=text(data.workspaceId,"Bureau",1,100);await requireWorkspace(db,workspaceId,user.id);
      const s=subscriptionInput(data),subscriptionId=id(),now=iso();
      await db.batch([db.prepare("INSERT INTO subscriptions (id,workspace_id,owner_id,name,category,description,total_cents,max_seats,next_due_date,archived,created_at) SELECT ?,?,?,?,?,?,?,?,?,0,? WHERE (SELECT COUNT(*) FROM subscriptions WHERE workspace_id=?)<200 AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?)").bind(subscriptionId,workspaceId,user.id,s.name,s.category,s.description,s.totalCents,s.maxSeats,s.nextDueDate,now,workspaceId,workspaceId,user.id),db.prepare("INSERT INTO subscription_members (subscription_id,user_id,status,joined_at) SELECT ?,?,'active',? WHERE EXISTS(SELECT 1 FROM subscriptions WHERE id=?)").bind(subscriptionId,user.id,now,subscriptionId)]);
      const created = await db.prepare("SELECT id FROM subscriptions WHERE id=?").bind(subscriptionId).first();
      if(!created)throw new ApiError(409,"Ce cercle a atteint la limite de 200 abonnements, archives comprises.");
      return json({ok:true,subscriptionId},201);
    }
    if(parts[0]==="subscriptions"&&parts[1]&&parts.length<=3) {
      const {sub,canManage}=await requireSubscription(db,parts[1],user.id),action=parts[2],now=iso();
      if(parts.length===2&&request.method==="PATCH") {
        if(!canManage)throw new ApiError(403,"Seul le responsable peut modifier cet abonnement.");
        const s=subscriptionInput({...{name:sub.name,category:sub.category,description:sub.description,totalCents:sub.total_cents,maxSeats:sub.max_seats,nextDueDate:sub.next_due_date},...data});
        const result=await db.prepare("UPDATE subscriptions SET name=?,category=?,description=?,total_cents=?,max_seats=?,next_due_date=? WHERE id=? AND archived=0 AND (SELECT COUNT(*) FROM subscription_members WHERE subscription_id=? AND status='active' AND (cancellation_effective_at IS NULL OR cancellation_effective_at>?))<=?").bind(s.name,s.category,s.description,s.totalCents,s.maxSeats,s.nextDueDate,sub.id,sub.id,now,s.maxSeats).run();
        if(!result.meta.changes)throw new ApiError(409,"Le nombre de places est inférieur au nombre de participants.");return json({ok:true});
      }
      if(parts.length===2&&request.method==="DELETE") {
        if(!canManage)throw new ApiError(403,"Seul le responsable peut archiver cet abonnement.");
        await db.prepare("UPDATE subscriptions SET archived=1 WHERE id=?").bind(sub.id).run();return json({ok:true});
      }
      if(request.method!=="POST")throw new ApiError(405,"Méthode non autorisée.");
      if(action==="request") {
        const existing=await db.prepare("SELECT * FROM subscription_members WHERE subscription_id=? AND user_id=?").bind(sub.id,user.id).first<SubscriptionMember>();
        if(existing&&(existing.status==="pending"||membershipIsActive(existing.status,existing.cancellation_effective_at,now)))return json({ok:true,status:existing.status});
        if(data.policyAccepted!==true||data.policyVersion!==MEMBERSHIP_POLICY_VERSION)throw new ApiError(400,"Acceptez le fonctionnement mensuel et le préavis avant de demander une place.");
        const result=await db.prepare("INSERT INTO subscription_members (subscription_id,user_id,status,joined_at,policy_version,policy_accepted_at) SELECT ?,?,'pending',?,?,? WHERE EXISTS(SELECT 1 FROM subscriptions WHERE id=? AND archived=0 AND (SELECT COUNT(*) FROM subscription_members WHERE subscription_id=? AND status='active' AND (cancellation_effective_at IS NULL OR cancellation_effective_at>?))<max_seats) AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?) ON CONFLICT(subscription_id,user_id) DO UPDATE SET status='pending',joined_at=excluded.joined_at,cancellation_requested_at=NULL,cancellation_effective_at=NULL,policy_version=excluded.policy_version,policy_accepted_at=excluded.policy_accepted_at WHERE subscription_members.status='active' AND subscription_members.cancellation_effective_at<=?").bind(sub.id,user.id,now,MEMBERSHIP_POLICY_VERSION,now,sub.id,sub.id,now,sub.workspace_id,user.id,now).run();
        if(!result.meta.changes)throw new ApiError(409,"Cet abonnement est complet ou une demande existe déjà.");return json({ok:true,status:"pending"},201);
      }
      if(action==="leave") {
        if(sub.owner_id===user.id)throw new ApiError(409,"Vous êtes responsable de cet abonnement. Archivez-le pour le fermer.");
        await db.prepare("DELETE FROM subscription_members WHERE subscription_id=? AND user_id=? AND (status='pending' OR (status='active' AND (policy_version IS NULL OR policy_version<>? OR policy_accepted_at IS NULL)))").bind(sub.id,user.id,MEMBERSHIP_POLICY_VERSION).run();
        await db.prepare("UPDATE subscription_members SET cancellation_requested_at=COALESCE(cancellation_requested_at,?),cancellation_effective_at=COALESCE(cancellation_effective_at,?) WHERE subscription_id=? AND user_id=? AND status='active' AND (cancellation_effective_at IS NULL OR cancellation_effective_at>?)").bind(now,cancellationEffectiveAt(now),sub.id,user.id,now).run();
        const member=await db.prepare("SELECT * FROM subscription_members WHERE subscription_id=? AND user_id=?").bind(sub.id,user.id).first<SubscriptionMember>();
        const active=member&&membershipIsActive(member.status,member.cancellation_effective_at,now);
        return json({ok:true,cancellationRequestedAt:active?member.cancellation_requested_at:null,cancellationEffectiveAt:active?member.cancellation_effective_at:null});
      }
      if(action==="cancel-leave") {
        const result=await db.prepare("UPDATE subscription_members SET cancellation_requested_at=NULL,cancellation_effective_at=NULL WHERE subscription_id=? AND user_id=? AND status='active' AND cancellation_effective_at>?").bind(sub.id,user.id,now).run();
        if(!result.meta.changes)throw new ApiError(409,"Aucun préavis en cours. Une nouvelle demande est nécessaire après la date de sortie.");
        return json({ok:true});
      }
      if(action==="accept-policy") {
        if(data.policyAccepted!==true||data.policyVersion!==MEMBERSHIP_POLICY_VERSION)throw new ApiError(400,"Acceptez le fonctionnement mensuel et le préavis pour continuer.");
        const result=await db.prepare("UPDATE subscription_members SET policy_version=?,policy_accepted_at=CASE WHEN policy_version=? AND policy_accepted_at IS NOT NULL THEN policy_accepted_at ELSE ? END WHERE subscription_id=? AND user_id=? AND (status='pending' OR (status='active' AND (cancellation_effective_at IS NULL OR cancellation_effective_at>?)))").bind(MEMBERSHIP_POLICY_VERSION,MEMBERSHIP_POLICY_VERSION,now,sub.id,user.id,now).run();
        if(!result.meta.changes)throw new ApiError(409,"Aucune participation en cours pour cet abonnement.");return json({ok:true});
      }
      if(action==="approve"||action==="reject") {
        if(!canManage)throw new ApiError(403,"Seul le responsable peut gérer les demandes.");
        const target=text(data.userId,"Participant",1,200);
        if(action==="reject") {
          await db.prepare("DELETE FROM subscription_members WHERE subscription_id=? AND user_id=? AND status='pending'").bind(sub.id,target).run();return json({ok:true});
        }
        const targetAccess=await getSiteAccess(db,{id:target,name:"",email:""},env);
        if(targetAccess.status!=="approved")throw new ApiError(403,"L’accès de ce participant doit d’abord être approuvé par le responsable du site.");
        const eventId=id();
        const results=await db.batch([
          db.prepare("UPDATE subscription_members SET status='active',cancellation_requested_at=NULL,cancellation_effective_at=NULL,approval_event_id=? WHERE subscription_id=? AND user_id=? AND status='pending' AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.id=? AND s.archived=0 AND (SELECT COUNT(*) FROM subscription_members WHERE subscription_id=s.id AND status='active' AND (cancellation_effective_at IS NULL OR cancellation_effective_at>?))<s.max_seats) AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?)").bind(eventId,sub.id,target,sub.id,now,sub.workspace_id,target),
          joinedSubscriptionNotifications(db,sub.id,target,eventId,now),
        ]);
        if(!(results[0] as {meta:{changes?:number}}).meta.changes)throw new ApiError(409,"Plus de place disponible ou demande déjà traitée.");return json({ok:true});
      }
    }
    throw new ApiError(404,"Page introuvable.");
  }catch(error){
    if(error instanceof ApiError||error instanceof AccessError)return json({error:error.message},error.status);
    console.error("bureau_api_error",error instanceof Error?error.message:"unknown");return json({error:"Une erreur est survenue. Réessayez dans un instant."},500);
  }
}
