import { env } from "cloudflare:workers";
import { handleBureauRequest, requestUser } from "@/lib/bureau-api";
import { AccessError, type AccessEnv } from "@/lib/access";
import { resolveSiteUser, type EmailAuthEnv } from "@/lib/email-auth";
export const dynamic = "force-dynamic";
async function route(request: Request) {
  if (!env.DB && request.method === "GET" && new URL(request.url).pathname === "/api/state" && !requestUser(request)) {
    return Response.json({ user:null,workspaces:[],workspace:null,members:[],subscriptions:[],requests:[],billing:{configured:false,mode:"disabled"},payments:[] },{headers:{"Cache-Control":"no-store"}});
  }
  if (!env.DB) return Response.json({error:"Le stockage du bureau est en cours de préparation."},{status:503,headers:{"Cache-Control":"no-store"}});
  const config=env as Cloudflare.Env&AccessEnv&EmailAuthEnv;
  try{return await handleBureauRequest(request, env.DB, config, await resolveSiteUser(request,env.DB,config));}
  catch(error){return Response.json({error:error instanceof AccessError?error.message:"La connexion au cercle est momentanément indisponible."},{status:error instanceof AccessError?error.status:503,headers:{"Cache-Control":"no-store"}});}
}
export { route as GET, route as POST, route as PATCH, route as DELETE };
