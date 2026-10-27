import { env } from "cloudflare:workers";
import { handleBillingRequest, type BillingEnv } from "@/lib/billing";
import { resolveSiteUser, type EmailAuthEnv } from "@/lib/email-auth";
import { AccessError } from "@/lib/access";
export const dynamic = "force-dynamic";
async function route(request:Request){
  if(!env.DB)return Response.json({error:"Le stockage du bureau est en cours de préparation."},{status:503,headers:{"Cache-Control":"no-store"}});
  const config=env as Cloudflare.Env&BillingEnv&EmailAuthEnv;
  const action=new URL(request.url).pathname.split("/").pop();
  if(action==="webhook"||action==="run")return handleBillingRequest(request,env.DB,config,null);
  try{return await handleBillingRequest(request,env.DB,config,await resolveSiteUser(request,env.DB,config));}
  catch(error){return Response.json({error:error instanceof AccessError?error.message:"La connexion au paiement est momentanément indisponible."},{status:error instanceof AccessError?error.status:503,headers:{"Cache-Control":"no-store"}});}
}
export {route as GET,route as POST};
