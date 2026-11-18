// Which pages may call the API. The site's own pages, plus the Oke Night phone app, which runs the same
// singer page from files inside the app (Capacitor serves them from these origins) and calls
// https://okenight.com/<bar>/api/... directly. Other sites are turned away, so they can't make their
// visitors' browsers post reactions, requests or photos.
export const APP_ORIGINS = new Set(["capacitor://localhost", "ionic://localhost", "https://localhost", "http://localhost"]);

// The singer-page calls the app makes. Host, crowd meter, bar buttons, owner report and the bar-lead form
// stay site-only: they aren't in the app.
export const APP_APIS = new Set(["plays", "react", "reactions", "catalog", "art", "listen", "avatar", "request", "draft", "duet", "venues", "league"]);

// true when the request has no Origin (a plain page load or a server), comes from this site, or from the app.
export function okOrigin(req, url) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  if (origin === "null") return false;
  if (APP_ORIGINS.has(origin)) return true;
  try { return new URL(origin).host === url.host; } catch (e) { return false; }
}

// The API name for /api/<name> or /<slug>/api/<name>, else "".
export function apiName(path) { const m = /^(?:\/[a-z0-9-]+)?\/api\/([a-z-]+)$/.exec(path); return m ? m[1] : ""; }

// CORS for the app: answers its preflight and adds the allow headers to its responses. null = not an app call.
export function appPreflight(req, url) {
  const origin = req.headers.get("origin");
  if (req.method !== "OPTIONS" || !APP_ORIGINS.has(origin) || !APP_APIS.has(apiName(url.pathname))) return null;
  return new Response(null, { status: 204, headers: { ...corsFor(origin), "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } });
}
export function withAppCors(req, url, res) {
  const origin = req.headers.get("origin");
  if (!APP_ORIGINS.has(origin) || !APP_APIS.has(apiName(url.pathname))) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsFor(origin))) out.headers.set(k, v);
  out.headers.append("vary", "Origin");
  return out;
}
const corsFor = (origin) => ({ "access-control-allow-origin": origin });
