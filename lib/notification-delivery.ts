import type { BureauDatabase } from "./bureau-api";
import type { AccessEnv } from "./access";

type MailEnv=AccessEnv & {NOTIFICATIONS_GOOGLE_EMAIL?:string};
type PublicJwk=JsonWebKey & {kid?:string};
type Job={id:string;recipient_email:string;subject:string;body_text:string;lease_token:string};
const recipientAllowed="(recipient_user_id IS NULL OR EXISTS(SELECT 1 FROM profiles p WHERE p.id=notification_outbox.recipient_user_id AND p.email=notification_outbox.recipient_email AND (notification_outbox.event_key NOT LIKE 'subscription-joined:%' OR p.notifications_enabled=1)))";
let cachedKeys:{expires:number;keys:PublicJwk[]}|null=null;
class DeliveryError extends Error{constructor(public status:number,message:string){super(message);}}
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store","Vary":"Authorization","X-Content-Type-Options":"nosniff"}});
function decode(value:string){return Uint8Array.from(atob(value.replaceAll("-","+").replaceAll("_","/")),c=>c.charCodeAt(0));}

/** Only this Google script and its verified sender can read the transactional outbox. */
export async function verifyGoogleMailWorker(token:string,env:MailEnv,loadKeys?:()=>Promise<PublicJwk[]>):Promise<void>{
  if(!env.NOTIFICATIONS_GOOGLE_AUDIENCE?.trim()||!env.NOTIFICATIONS_GOOGLE_EMAIL?.trim())throw new DeliveryError(503,"L’envoi Google Workspace n’est pas raccordé.");
  try{
    if(token.length>12000)throw new Error();
    const [headerPart,payloadPart,signature,...extra]=token.split(".");
    if(!headerPart||!payloadPart||!signature||extra.length)throw new Error();
    const header=JSON.parse(new TextDecoder().decode(decode(headerPart)));
    const claims=JSON.parse(new TextDecoder().decode(decode(payloadPart)));
    const current=Math.floor(Date.now()/1000);
    if(header.alg!=="RS256"||typeof header.kid!=="string"||header.kid.length>100)throw new Error();
    if(!["https://accounts.google.com","accounts.google.com"].includes(claims.iss)||claims.aud!==env.NOTIFICATIONS_GOOGLE_AUDIENCE||claims.email!==env.NOTIFICATIONS_GOOGLE_EMAIL||claims.email_verified!==true||typeof claims.sub!=="string"||!claims.sub||!Number.isFinite(claims.exp)||claims.exp<=current||!Number.isFinite(claims.iat)||claims.iat>current+120)throw new Error();
    const keys=loadKeys?await loadKeys():await googleKeys();
    const jwk=keys.find(k=>k.kid===header.kid&&k.kty==="RSA");if(!jwk)throw new Error();
    const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
    if(!await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,decode(signature),new TextEncoder().encode(`${headerPart}.${payloadPart}`)))throw new Error();
  }catch(error){if(error instanceof DeliveryError)throw error;throw new DeliveryError(401,"Identité du service d’envoi non autorisée.");}
}
async function googleKeys():Promise<PublicJwk[]>{
  if(cachedKeys&&cachedKeys.expires>Date.now())return cachedKeys.keys;
  const response=await fetch("https://www.googleapis.com/oauth2/v3/certs",{signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new DeliveryError(503,"La vérification Google est momentanément indisponible.");
  const data=await response.json() as {keys?:PublicJwk[]};if(!Array.isArray(data.keys))throw new DeliveryError(503,"Clés Google indisponibles.");
  cachedKeys={keys:data.keys,expires:Date.now()+5*60_000};return data.keys;
}
async function lease(db:BureauDatabase){
  const stamp=new Date().toISOString(),retryBefore=new Date(Date.now()-5*60_000).toISOString();
  await db.prepare("UPDATE notification_outbox SET body_text='' WHERE event_key LIKE 'auth-otp:%' AND expires_at<=? AND body_text<>''").bind(stamp).run();
  await db.prepare(`UPDATE notification_outbox SET status='cancelled',body_text=CASE WHEN event_key LIKE 'auth-otp:%' THEN '' ELSE body_text END,last_error='Notification expirée ou préférence modifiée.',updated_at=? WHERE status IN ('pending','failed') AND ((expires_at IS NOT NULL AND expires_at<=?) OR NOT ${recipientAllowed})`).bind(stamp,stamp).run();
  // An expired attempt can already have reached Google. Never resend it automatically.
  await db.prepare("UPDATE notification_outbox SET status='uncertain',last_error='Envoi commencé sans confirmation ; vérifier avant de renvoyer.',updated_at=? WHERE status='sending' AND lease_until<=?").bind(stamp,stamp).run();
  const {results:pending}=await db.prepare(`SELECT id FROM notification_outbox WHERE (status='pending' OR (status='failed' AND attempts<5 AND updated_at<=?)) AND ${recipientAllowed} AND (expires_at IS NULL OR expires_at>?) ORDER BY CASE WHEN event_key LIKE 'auth-otp:%' THEN 0 ELSE 1 END,created_at,id LIMIT 1`).bind(retryBefore,stamp).all<{id:string}>();
  const jobs:Job[]=[];
  for(const row of pending){
    const token=crypto.randomUUID(),until=new Date(Date.now()+10*60_000).toISOString();
    const acquired=await db.prepare(`UPDATE notification_outbox SET status='sending',attempts=attempts+1,lease_token=?,lease_until=?,attempt_started_at=?,updated_at=? WHERE id=? AND (status='pending' OR (status='failed' AND attempts<5 AND updated_at<=?)) AND ${recipientAllowed} AND (expires_at IS NULL OR expires_at>?)`).bind(token,until,stamp,stamp,row.id,retryBefore,stamp).run();
    if(!acquired.meta.changes)continue;
    const job=await db.prepare("SELECT id,recipient_email,subject,body_text,lease_token FROM notification_outbox WHERE id=? AND lease_token=?").bind(row.id,token).first<Job>();
    if(job)jobs.push(job);
  }
  return json({jobs:jobs.map(j=>({id:j.id,to:j.recipient_email,subject:j.subject,text:j.body_text,leaseToken:j.lease_token}))});
}
async function acknowledge(request:Request,db:BureauDatabase){
  const raw=await request.text();if(raw.length>4000)throw new DeliveryError(413,"Requête trop volumineuse.");
  let data:Record<string,unknown>;try{data=JSON.parse(raw);}catch{throw new DeliveryError(400,"Données invalides.");}
  if(!data||typeof data.id!=="string"||data.id.length>300||typeof data.leaseToken!=="string"||data.leaseToken.length>100||!["sent","failed","uncertain"].includes(String(data.outcome)))throw new DeliveryError(400,"Confirmation invalide.");
  const stamp=new Date().toISOString(),outcome=String(data.outcome);
  const error=outcome==="failed"?"Le service n’a pas tenté l’envoi ; nouvelle tentative prévue.":outcome==="uncertain"?"Le résultat de l’envoi est incertain ; vérifier avant de renvoyer.":null;
  const changed=await db.prepare("UPDATE notification_outbox SET status=?,sent_at=?,last_error=?,updated_at=?,lease_token=NULL,lease_until=NULL,body_text=CASE WHEN event_key LIKE 'auth-otp:%' AND ?='sent' THEN '' ELSE body_text END WHERE id=? AND status='sending' AND lease_token=? AND lease_until>?").bind(outcome,outcome==="sent"?stamp:null,error,stamp,outcome,data.id,data.leaseToken,stamp).run();
  if(!changed.meta.changes)throw new DeliveryError(409,"Cette tentative est terminée ou son délai est dépassé.");
  return json({ok:true});
}
export async function handleNotificationDelivery(request:Request,db:BureauDatabase,env:MailEnv):Promise<Response>{
  try{
    if(request.method!=="POST")throw new DeliveryError(405,"Méthode non autorisée.");
    if(!request.headers.get("Content-Type")?.startsWith("application/json"))throw new DeliveryError(415,"Format JSON requis.");
    const bearer=request.headers.get("Authorization");if(!bearer?.startsWith("Bearer "))throw new DeliveryError(401,"Accès au service d’envoi refusé.");
    await verifyGoogleMailWorker(bearer.slice(7),env);
    const action=new URL(request.url).pathname.split("/").pop();
    if(action==="ack")return await acknowledge(request,db);
    if(action!=="jobs")throw new DeliveryError(404,"Page introuvable.");
    if(env.NOTIFICATIONS_DELIVERY_ENABLED!=="true")throw new DeliveryError(503,"Les notifications sont en attente d’activation.");
    return await lease(db);
  }catch(error){if(error instanceof DeliveryError)return json({error:error.message},error.status);console.error("mail_delivery_error");return json({error:"Le service d’envoi est momentanément indisponible."},503);}
}
