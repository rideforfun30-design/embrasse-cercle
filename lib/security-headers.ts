/** Keep platform embedding working while limiting clickjacking and unintended capabilities. */
export function withSecurityHeaders(response:Response,url:string):Response{
  if(response.status===101)return response;
  const headers=new Headers(response.headers);
  headers.set("X-Content-Type-Options","nosniff");
  headers.set("Referrer-Policy","strict-origin-when-cross-origin");
  headers.set("Permissions-Policy","camera=(), microphone=(), geolocation=()");
  headers.set("Content-Security-Policy","base-uri 'self'; object-src 'none'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com https://*.chatgpt.site; form-action 'self'");
  if(new URL(url).protocol==="https:")headers.set("Strict-Transport-Security","max-age=31536000");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
