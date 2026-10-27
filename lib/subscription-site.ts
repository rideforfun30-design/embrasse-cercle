export type SubscriptionSite = {
  websiteUrl: string;
  hostname: string;
  name: string;
  iconUrl: string;
};

const serviceNames: Record<string, string> = {
  "adobe.com": "Adobe", "artlist.io": "Artlist", "canva.com": "Canva",
  "chatgpt.com": "ChatGPT", "dropbox.com": "Dropbox", "epidemicsound.com": "Epidemic Sound",
  "figma.com": "Figma", "frame.io": "Frame.io", "google.com": "Google",
  "midjourney.com": "Midjourney", "notion.com": "Notion", "notion.so": "Notion",
  "openai.com": "OpenAI", "runwayml.com": "Runway", "soundstripe.com": "Soundstripe",
  "spotify.com": "Spotify", "vimeo.com": "Vimeo", "youtube.com": "YouTube",
};
const privateSuffixes = ["localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "corp", "test", "invalid", "example", "onion", "arpa"];
const compoundSuffixes = new Set(["co.uk", "org.uk", "com.au", "co.nz", "co.jp", "co.kr", "co.in", "co.za", "com.br", "com.mx", "com.sg", "com.tr", "com.cn", "com.tw", "com.hk"]);

function nameFromHostname(hostname: string): string {
  const domain = hostname.replace(/^www\./, "");
  for (const [site, name] of Object.entries(serviceNames)) {
    if (domain === site || domain.endsWith(`.${site}`)) return name;
  }
  const labels = domain.split(".");
  const suffixLength = compoundSuffixes.has(labels.slice(-2).join(".")) ? 2 : 1;
  const label = labels.at(-suffixLength - 1) || labels[0];
  return label.split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/** Derive a public service preview locally; never fetch an arbitrary pasted URL. */
export function subscriptionSite(value: unknown): SubscriptionSite | null {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const input = value.trim();
  if (!input || /\s/.test(input) || input.startsWith("//")) return null;
  const hasHttpScheme = /^https?:\/\//i.test(input);
  if (hasHttpScheme && /^https?:\/\/[/?#]/i.test(input)) return null;
  // A bare hostname may carry its default HTTPS port. Other explicit schemes are rejected.
  if (!hasHttpScheme && /^[a-z][a-z\d+.-]*:/i.test(input) && !/^[^/:?#]+\.[^/:?#]+:443(?:\/|$)/i.test(input)) return null;
  try {
    const url = new URL(hasHttpScheme ? input : `https://${input}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const labels = hostname.split(".");
    if (hostname.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) return null;
    const suffix = labels.at(-1)!;
    if (!/^(?:[a-z]{2,63}|xn--[a-z\d-]{2,59})$/.test(suffix) || privateSuffixes.includes(suffix)) return null;
    // WHATWG URL canonicalizes unusual IPv4 notations; the alphabetic suffix check also rejects them.
    url.hostname = hostname;
    url.search = "";
    url.hash = "";
    const websiteUrl = url.href;
    if (websiteUrl.length > 2048) return null;
    const icon = new URL("https://www.google.com/s2/favicons");
    icon.searchParams.set("domain", hostname);
    icon.searchParams.set("sz", "128");
    return { websiteUrl, hostname, name: nameFromHostname(hostname), iconUrl: icon.href };
  } catch {
    return null;
  }
}
