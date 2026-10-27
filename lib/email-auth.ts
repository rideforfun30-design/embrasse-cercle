import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins/email-otp";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzle } from "drizzle-orm/d1";
import { emailAuthSchema } from "../db/email-auth-schema";
import { AccessError, isSiteAccessAdmin, notificationsConfigured, type AccessEnv } from "./access";
import { requestUser, type BureauDatabase, type BureauUser } from "./bureau-api";
import { chosenPasswordStrength } from "./password-strength";

export type EmailAuthEnv = AccessEnv & {
  AUTH_EMAIL_ENABLED?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
};
export class EmailAuthError extends AccessError {
  constructor(status:number,message:string,public code:string){super(status,message);}
}
const unavailableMessage="La connexion par e-mail est en cours d’activation. Réessayez lorsque l’envoi des e-mails sera raccordé.";
function baseConfig(env:EmailAuthEnv){
  const secret=env.BETTER_AUTH_SECRET?.trim()??"";
  if(secret.length<32)return null;
  try{
    const url=new URL(env.BETTER_AUTH_URL??"");
    const local=url.hostname==="localhost"||url.hostname==="127.0.0.1"||url.hostname==="[::1]";
    if(url.username||url.password||url.pathname!=="/"||url.search||url.hash||!(url.protocol==="https:"||(local&&url.protocol==="http:")))return null;
    return {secret,origin:url.origin,secure:url.protocol==="https:"};
  }catch{return null;}
}
export function emailAuthConfigured(env:EmailAuthEnv):boolean {
  return env.AUTH_EMAIL_ENABLED==="true"&&!!baseConfig(env)&&notificationsConfigured(env);
}
function json(data:unknown,status=200,extraHeaders?:HeadersInit){
  const headers=new Headers(extraHeaders);headers.set("Cache-Control","no-store");headers.set("Vary","Cookie, Authorization");headers.set("X-Content-Type-Options","nosniff");
  return Response.json(data,{status,headers});
}
function unavailable(){return json({error:unavailableMessage,message:unavailableMessage,code:"AUTH_EMAIL_UNAVAILABLE"},503);}
function canonicalEmail(value:unknown):string|null{
  if(typeof value!=="string")return null;
  const email=value.trim().toLowerCase();
  return email.length<=254&&/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(email)?email:null;
}
async function emailHash(email:string){
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(email));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
}
async function consumeEmailSendBudget(db:BureauDatabase,email:string){
  const now=Date.now(),key=await emailHash(email);
  const result=await db.prepare("INSERT INTO auth_email_send_limits (email_hash,last_sent_at) VALUES (?,?) ON CONFLICT(email_hash) DO UPDATE SET last_sent_at=excluded.last_sent_at WHERE auth_email_send_limits.last_sent_at<=?").bind(key,now,now-60_000).run();
  if(!result.meta.changes)throw new EmailAuthError(429,"Attendez une minute avant de demander un nouveau code.","OTP_RESEND_TOO_SOON");
  await db.prepare("DELETE FROM auth_email_send_limits WHERE last_sent_at<?").bind(now-86_400_000).run();
}
async function consumeEmailLoginBudget(db:BureauDatabase,email:string){
  const now=Date.now(),key=`email-login:${await emailHash(email)}`;
  const result=await db.prepare("INSERT INTO auth_rate_limits (id,key,count,last_request) VALUES (?,?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_rate_limits.last_request<=? THEN 1 ELSE auth_rate_limits.count+1 END,last_request=CASE WHEN auth_rate_limits.last_request<=? THEN excluded.last_request ELSE auth_rate_limits.last_request END WHERE auth_rate_limits.last_request<=? OR auth_rate_limits.count<10").bind(crypto.randomUUID(),key,now,now-600_000,now-600_000,now-600_000).run();
  if(!result.meta.changes)throw new EmailAuthError(429,"Trop de tentatives pour cette adresse. Réessayez dans dix minutes.","TOO_MANY_LOGIN_ATTEMPTS");
}
export function getEmailAuth(db:BureauDatabase,env:EmailAuthEnv){
  const config=baseConfig(env);
  if(!config)throw new EmailAuthError(503,unavailableMessage,"AUTH_EMAIL_UNAVAILABLE");
  return betterAuth({
    appName:"EMBRASSE — cercle créatif",baseURL:config.origin,basePath:"/api/auth",secret:config.secret,
    database:drizzleAdapter(drizzle(db as unknown as D1Database,{schema:emailAuthSchema}),{provider:"sqlite",schema:emailAuthSchema,transaction:false}),
    trustedOrigins:[config.origin],
    emailAndPassword:{enabled:true,requireEmailVerification:true,minPasswordLength:12,maxPasswordLength:128,autoSignIn:false,revokeSessionsOnPasswordReset:true},
    emailVerification:{sendOnSignUp:true,sendOnSignIn:false,autoSignInAfterVerification:false},
    session:{expiresIn:60*60*24*14,updateAge:60*60*24,cookieCache:{enabled:false}},
    advanced:{useSecureCookies:config.secure,cookiePrefix:"embrasse",defaultCookieAttributes:{httpOnly:true,secure:config.secure,sameSite:"lax"},crossSubDomainCookies:{enabled:false},ipAddress:{ipAddressHeaders:["cf-connecting-ip"]}},
    rateLimit:{enabled:true,storage:"database",modelName:"rateLimit",window:60,max:30,customRules:{"/sign-up/email":{window:60,max:10},"/sign-in/email":{window:600,max:30},"/email-otp/send-verification-otp":{window:60,max:10},"/email-otp/request-password-reset":{window:60,max:10},"/email-otp/verify-email":{window:60,max:10},"/email-otp/reset-password":{window:60,max:10}}},
    logger:{disabled:true},telemetry:{enabled:false},
    hooks:{before:createAuthMiddleware(async context=>{
      if(context.path==="/sign-up/email"||context.path==="/email-otp/reset-password"){
        const email=canonicalEmail(context.body?.email),strength=await chosenPasswordStrength(context.body?.password,email?[email,email.split("@")[0]]:[]);
        if(!strength.ok)throw new APIError("BAD_REQUEST",{message:strength.message!,code:strength.code!});
        if(context.path==="/sign-up/email"&&email){
          try{await consumeEmailSendBudget(db,email);}catch(error){if(error instanceof EmailAuthError)throw new APIError("TOO_MANY_REQUESTS",{message:error.message,code:error.code});throw error;}
        }
      }
    })},
    plugins:[emailOTP({otpLength:6,expiresIn:600,allowedAttempts:5,storeOTP:"hashed",resendStrategy:"rotate",overrideDefaultEmailVerification:true,changeEmail:{enabled:false},rateLimit:{window:60,max:10},
      async sendVerificationOTP({email,otp,type}){
        if(!emailAuthConfigured(env)||!(type==="email-verification"||type==="forget-password"))throw new APIError("SERVICE_UNAVAILABLE",{message:unavailableMessage,code:"AUTH_EMAIL_UNAVAILABLE"});
        const now=new Date().toISOString(),expiresAt=new Date(Date.now()+600_000).toISOString(),eventKey=`auth-otp:${crypto.randomUUID()}`;
        const purpose=type==="forget-password"?"réinitialiser votre mot de passe":"vérifier votre adresse e-mail";
        const body=`Votre code pour ${purpose} sur le cercle créatif EMBRASSE : ${otp}\n\nCe code est valable dix minutes et ne sert qu’une seule fois. Ne le communiquez à personne. Si vous n’avez pas fait cette demande, ignorez cet e-mail.`;
        try{
          await db.batch([
            db.prepare("UPDATE notification_outbox SET status='cancelled',body_text='',updated_at=?,lease_token=NULL,lease_until=NULL WHERE event_key LIKE 'auth-otp:%' AND recipient_email=? AND status IN ('pending','failed')").bind(now,email),
            db.prepare("INSERT INTO notification_outbox (id,event_key,recipient_user_id,recipient_email,subject,body_text,status,attempts,created_at,updated_at,expires_at) VALUES (?,?,NULL,?,? ,?,'pending',0,?,?,?)").bind(eventKey,eventKey,email,"Votre code de vérification EMBRASSE",body,now,now,expiresAt),
          ]);
        }catch{throw new APIError("SERVICE_UNAVAILABLE",{message:"Le code n’a pas pu être mis en attente d’envoi. Réessayez dans une minute.",code:"AUTH_EMAIL_UNAVAILABLE"});}
      },
    })],
  });
}

type VerifiedAuthUser={id:string;email:string;emailVerified:boolean;name?:string|null};
/** Link only after Better Auth has proved email ownership; never infer access approval. */
export async function mapVerifiedAuthUser(db:BureauDatabase,authUser:VerifiedAuthUser):Promise<BureauUser>{
  const email=canonicalEmail(authUser.email);
  if(!email||authUser.emailVerified!==true)throw new EmailAuthError(403,"Vérifiez votre adresse e-mail pour continuer.","EMAIL_NOT_VERIFIED");
  const stored=await db.prepare("SELECT email,email_verified FROM auth_users WHERE id=?").bind(authUser.id).first<{email:string;email_verified:number}>();
  if(!stored?.email_verified||canonicalEmail(stored.email)!==email)throw new EmailAuthError(403,"Cette connexion n’a pas pu être vérifiée.","AUTH_IDENTITY_UNVERIFIED");
  const matches=await db.prepare("SELECT id,name,email FROM profiles WHERE lower(email)=? LIMIT 2").bind(email).all<BureauUser>();
  if(matches.results.length>1)throw new EmailAuthError(409,"Cette adresse correspond à plusieurs anciens comptes. Contactez le responsable du cercle pour les rapprocher.","AUTH_IDENTITY_AMBIGUOUS");
  const linked=await db.prepare("SELECT profile_id FROM auth_profile_links WHERE auth_user_id=?").bind(authUser.id).first<{profile_id:string}>();
  if(linked){
    const found=matches.results[0];
    if(!found||found.id!==linked.profile_id)throw new EmailAuthError(409,"Cette adresse a changé depuis le rapprochement du compte. Contactez le responsable du cercle.","AUTH_IDENTITY_AMBIGUOUS");
    return {...found,email};
  }
  const name=authUser.name?.trim().slice(0,80)||"Créatif",now=new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO profiles (id,name,email,created_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM profiles WHERE lower(email)=?) ON CONFLICT(id) DO NOTHING").bind(authUser.id,name,email,now,email),
    db.prepare("INSERT INTO auth_profile_links (auth_user_id,profile_id,created_at) SELECT ?,p.id,? FROM profiles p WHERE lower(p.email)=? AND (SELECT COUNT(*) FROM profiles WHERE lower(email)=?)=1 AND NOT EXISTS(SELECT 1 FROM auth_profile_links WHERE profile_id=p.id AND auth_user_id<>?) ON CONFLICT(auth_user_id) DO NOTHING").bind(authUser.id,now,email,email,authUser.id),
  ]);
  const profile=await db.prepare("SELECT p.id,p.name,p.email FROM auth_profile_links l JOIN profiles p ON p.id=l.profile_id WHERE l.auth_user_id=? AND lower(p.email)=?").bind(authUser.id,email).first<BureauUser>();
  const finalCount=await db.prepare("SELECT COUNT(*) AS count FROM profiles WHERE lower(email)=?").bind(email).first<{count:number}>();
  if(!profile||finalCount?.count!==1)throw new EmailAuthError(409,"Le rapprochement du compte nécessite l’aide du responsable du cercle.","AUTH_IDENTITY_AMBIGUOUS");
  return {...profile,email};
}

export async function resolveSiteUser(request:Request,db:BureauDatabase,env:EmailAuthEnv):Promise<BureauUser|null>{
  if(baseConfig(env)&&request.headers.get("Cookie")){
    const session=await getEmailAuth(db,env).api.getSession({headers:request.headers});
    if(session?.user?.emailVerified)return mapVerifiedAuthUser(db,session.user);
  }
  const native=requestUser(request);
  return native&&isSiteAccessAdmin(native.id,env)?native:null;
}

export async function handleEmailAuthRequest(request:Request,db:BureauDatabase,env:EmailAuthEnv):Promise<Response>{
  try{
    const config=baseConfig(env),url=new URL(request.url),path=url.pathname.replace(/^\/api\/auth/,"");
    const allowed=new Set(["/sign-up/email","/sign-in/email","/email-otp/send-verification-otp","/email-otp/verify-email","/email-otp/request-password-reset","/email-otp/reset-password","/sign-out","/get-session"]);
    if(!allowed.has(path))return json({error:"Cette méthode de connexion n’est pas disponible."},404);
    if(!config)return unavailable();
    if((path==="/get-session"&&request.method!=="GET")||(path!=="/get-session"&&request.method!=="POST"))return json({error:"Méthode non autorisée."},405);
    let data:Record<string,unknown>={};
    if(request.method==="POST"){
      if(url.origin!==config.origin||request.headers.get("Origin")!==config.origin)return json({error:"Origine de la requête non autorisée."},403);
      if(!request.headers.get("Content-Type")?.startsWith("application/json"))return json({error:"Format JSON requis."},415);
      if(Number(request.headers.get("Content-Length"))>16_384)return json({error:"Requête trop volumineuse."},413);
      const raw=await request.clone().text();if(raw.length>16_384)return json({error:"Requête trop volumineuse."},413);
      try{const parsed=JSON.parse(raw);if(!parsed||Array.isArray(parsed)||typeof parsed!=="object")throw new Error();data=parsed;}catch{return json({error:"Données invalides."},400);}
    }
    if(!["/sign-out","/get-session"].includes(path)&&env.AUTH_EMAIL_ENABLED!=="true")return unavailable();
    const email=canonicalEmail(data.email);
    if(path==="/email-otp/send-verification-otp"&&data.type!=="email-verification")return json({error:"Seule la vérification de l’adresse e-mail est disponible ici."},400);
    if(["/sign-up/email","/email-otp/send-verification-otp","/email-otp/request-password-reset"].includes(path)){
      if(!emailAuthConfigured(env))return unavailable();
      if(!email)return json({error:"Adresse e-mail invalide.",code:"INVALID_EMAIL"},400);
      if(path!=="/sign-up/email")await consumeEmailSendBudget(db,email);
    }
    if(path==="/sign-in/email"){
      if(!email)return json({error:"Adresse e-mail invalide.",code:"INVALID_EMAIL"},400);
      if(!emailAuthConfigured(env)){
        const existing=await db.prepare("SELECT email_verified FROM auth_users WHERE email=?").bind(email).first<{email_verified:number}>();
        if(!existing?.email_verified)return unavailable();
      }
      await consumeEmailLoginBudget(db,email);
    }
    const auth=getEmailAuth(db,env),response=await auth.handler(request);
    const headers=new Headers(response.headers);headers.set("Cache-Control","no-store");headers.set("Vary","Cookie, Authorization");
    if(!response.ok)return new Response(response.body,{status:response.status,headers});
    if(!response.headers.get("Content-Type")?.includes("application/json"))return new Response(response.body,{status:response.status,headers});
    const result=await response.json() as Record<string,unknown>;
    if(path==="/sign-in/email"&&result.user){
      try{result.user=await mapVerifiedAuthUser(db,result.user as VerifiedAuthUser);}
      catch(error){if(typeof result.token==="string")await db.prepare("DELETE FROM auth_sessions WHERE token=?").bind(result.token).run();throw error;}
    }
    // The session is only carried by the HttpOnly cookie; never expose its bearer token in JSON.
    delete result.token;
    if(result.session&&typeof result.session==="object")delete (result.session as Record<string,unknown>).token;
    return json(result,response.status,headers);
  }catch(error){
    if(error instanceof EmailAuthError)return json({error:error.message,message:error.message,code:error.code},error.status,error.status===429?{"Retry-After":"60"}:undefined);
    return json({error:"La connexion n’a pas pu aboutir. Réessayez dans un instant.",code:"AUTH_REQUEST_FAILED"},500);
  }
}
