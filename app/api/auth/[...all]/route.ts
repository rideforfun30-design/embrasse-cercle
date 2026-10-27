import { env } from "cloudflare:workers";
import { handleEmailAuthRequest, type EmailAuthEnv } from "@/lib/email-auth";
export const dynamic="force-dynamic";
async function route(request:Request){
  if(!env.DB)return Response.json({error:"La connexion est en cours de préparation.",code:"AUTH_EMAIL_UNAVAILABLE"},{status:503,headers:{"Cache-Control":"no-store"}});
  return handleEmailAuthRequest(request,env.DB,env as EmailAuthEnv);
}
export {route as GET,route as POST};
