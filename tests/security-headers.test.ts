import{test}from"node:test";
import assert from"node:assert/strict";
import{withSecurityHeaders}from"../lib/security-headers";
test("security headers preserve private caching and session cookies while restricting embedding and capabilities",async()=>{
 const source=new Response("private",{headers:{"Cache-Control":"no-store"}});source.headers.append("Set-Cookie","session=one; HttpOnly; Secure; SameSite=Lax");source.headers.append("Set-Cookie","csrf=two; HttpOnly; Secure; SameSite=Lax");
 const secured=withSecurityHeaders(source,"https://abonnement.embrasse.tv/");
 assert.equal(secured.headers.get("Cache-Control"),"no-store");assert.equal(secured.headers.getSetCookie().length,2);assert.equal(secured.headers.get("X-Content-Type-Options"),"nosniff");assert.match(secured.headers.get("Content-Security-Policy")??"",/frame-ancestors 'self'/);assert.equal(secured.headers.get("Strict-Transport-Security"),"max-age=31536000");assert.equal(await secured.text(),"private");
 assert.equal(withSecurityHeaders(new Response("local"),"http://127.0.0.1:5178/").headers.has("Strict-Transport-Security"),false);
});
