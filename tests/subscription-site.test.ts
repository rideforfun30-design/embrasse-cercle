import { test } from "node:test";
import assert from "node:assert/strict";
import { subscriptionSite } from "../lib/subscription-site";

test("a service link proposes its name and a fixed-origin icon without tracking parameters",()=>{
 const site=subscriptionSite("  www.Adobe.com.:443/fr/creativecloud.html?token=private#team  ");
 assert.ok(site);
 assert.equal(site.name,"Adobe");
 assert.equal(site.websiteUrl,"https://www.adobe.com/fr/creativecloud.html");
 assert.equal(site.hostname,"www.adobe.com");
 const icon=new URL(site.iconUrl);
 assert.equal(icon.origin,"https://www.google.com");
 assert.equal(icon.pathname,"/s2/favicons");
 assert.equal(icon.searchParams.get("domain"),"www.adobe.com");
 assert.equal(icon.searchParams.get("sz"),"128");
 assert.ok(!site.iconUrl.includes("private"));
 assert.ok(!site.websiteUrl.includes("private"));
});

test("service names handle recognized subdomains and unknown services without overwriting user data",()=>{
 assert.equal(subscriptionSite("https://app.frame.io/projects")?.name,"Frame.io");
 assert.equal(subscriptionSite("https://chatgpt.com")?.name,"ChatGPT");
 assert.equal(subscriptionSite("https://account.creative-tools.co.uk/pricing")?.name,"Creative Tools");
 assert.equal(subscriptionSite("http://example.com:80/plans")?.websiteUrl,"http://example.com/plans");
 assert.equal(subscriptionSite("example.com:443/plans")?.websiteUrl,"https://example.com/plans");
});

test("active URLs, credentials, IP aliases, local names, malformed authorities and ports are rejected",()=>{
 const unsafe=[
  "javascript://example.com/alert(1)","data:text/html,<p>x</p>","file:///etc/passwd","blob:https://example.com/id","ftp://example.com/file",
  "https://name:password@example.com/","https://name%40example.com@adobe.com","https://localhost/","https://studio.local/","https://office.lan/","https://metadata.google.internal/",
  "http://127.0.0.1/","http://10.0.0.1/","http://2130706433/","http://0x7f000001/","http://0177.0.0.1/","https://[::1]/","https://[::ffff:127.0.0.1]/",
  "https://example.com:8443/","http://example.com:443/","//example.com","https:///example.com","https://example.com\\@evil.com","https://example.com/\nprivate","https://example..com","https://-bad.example.com","/relative/path","example","https://example.123/",
 ];
 for(const value of unsafe)assert.equal(subscriptionSite(value),null,value);
});

test("missing, non-text and oversized service links never yield an icon request",()=>{
 for(const value of [undefined,null,false,42,[],{},"","   ",`https://example.com/${"x".repeat(2048)}`])assert.equal(subscriptionSite(value),null);
});

test("accepted Unicode links round-trip and oversized normalized URLs are rejected",()=>{
 const accepted=subscriptionSite(`https://example.com/${"é".repeat(200)}?tracking=private#team`);
 assert.ok(accepted);
 assert.deepEqual(subscriptionSite(accepted.websiteUrl),accepted);
 assert.equal(subscriptionSite(`https://example.com/${"é".repeat(500)}`),null);
});
