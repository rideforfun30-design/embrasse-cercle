import { env } from "cloudflare:workers";
import { resolveSiteUser, type EmailAuthEnv } from "@/lib/email-auth";
import { AccessError } from "@/lib/access";
import { handleSubscriptionVaultRequest, type SubscriptionVaultEnv } from "@/lib/subscription-vault";

export const dynamic = "force-dynamic";
async function route(request: Request) {
  if (!env.DB) return Response.json({ error: "Le coffre est momentanément indisponible.", code: "VAULT_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  const config = env as Cloudflare.Env & EmailAuthEnv & SubscriptionVaultEnv;
  try {
    return await handleSubscriptionVaultRequest(request, env.DB, config, await resolveSiteUser(request, env.DB, config));
  } catch (error) {
    return Response.json({ error: error instanceof AccessError ? error.message : "La connexion au coffre est momentanément indisponible.", code: "VAULT_UNAVAILABLE" }, { status: error instanceof AccessError ? error.status : 503, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" } });
  }
}
export { route as GET, route as POST, route as PUT, route as DELETE };
