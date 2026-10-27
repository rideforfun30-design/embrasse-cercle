import { env } from "cloudflare:workers";
import { handleNotificationDelivery } from "@/lib/notification-delivery";
import type { AccessEnv } from "@/lib/access";
export const dynamic="force-dynamic";
export async function POST(request:Request){
  if(!env.DB)return Response.json({error:"Stockage indisponible."},{status:503,headers:{"Cache-Control":"no-store"}});
  return handleNotificationDelivery(request,env.DB,env as Cloudflare.Env&AccessEnv);
}
