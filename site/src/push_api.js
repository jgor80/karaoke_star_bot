// Push notifications to the Oke Night phone app (iPhone and Android), sent through Firebase Cloud Messaging.
//
// POST /<slug>/api/push {token, platform, dev?, on?, host_key?}  -> {ok, host}
//   The app registers its Firebase token for this bar (on:false removes it). With the bar's host key the
//   phone also gets the host alerts. A wrong key is refused and counts toward the host page's lockout.
// sendPush(env, venue, {to, kind, title, body, path})              -> number of phones it reached
//   to: "crowd" (every phone registered for the bar), "host" (host phones only) or {devices: [device ids]}.
// hostPush(env, venue, title, body, path?)                         -> the host alerts (ntfy stays as a backup)
// pushLive(env, venue)                                             -> cron: "karaoke is live" once a night
//
// Needs the Worker secret FCM_SERVICE_ACCOUNT: the Firebase service account JSON (Project settings >
// Service accounts > Generate new private key). Without it nothing is sent and nothing breaks.
// Tokens are only an address for this app on one phone. No name or contact details are stored with them.
import { DEFAULT_VENUE, cfgKey } from "./venues.js";
import { okOrigin } from "./origins.js";
import { isHost } from "./secrets_api.js";
import { scheduleStatus } from "./schedule.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS push_devices (
    token text primary key, venue text not null, platform text not null, device_id text,
    host integer not null default 0, created_at integer not null, updated_at integer not null)`,
  "CREATE INDEX IF NOT EXISTS push_devices_venue ON push_devices (venue, host)",
  "CREATE INDEX IF NOT EXISTS push_devices_dev ON push_devices (device_id)",
];
let ready = null;
export function ensurePush(env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; });
  return ready;
}

const nowS = () => Math.floor(Date.now() / 1000);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const TOKEN = /^[A-Za-z0-9_:.\-]{20,4096}$/;
const DEV = /^[a-f0-9]{32}$/;
const MAX_PER_SEND = 2000;   // phones per notification (Workers subrequest budget)
const PARALLEL = 25;
const STALE_S = 120 * 86400; // tokens not refreshed for 120 days are dropped (the app refreshes on every open)

export async function handlePush(req, env, venue = DEFAULT_VENUE) {
  const url = new URL(req.url);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!okOrigin(req, url)) return json({ error: "Wrong site" }, 403);
  let b;
  try { b = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const token = String((b && b.token) || "");
  if (!TOKEN.test(token)) return json({ error: "bad token" }, 400);
  await ensurePush(env);
  if (b.on === false) {
    await env.DB.prepare("DELETE FROM push_devices WHERE token = ?").bind(token).run();
    return json({ ok: true, host: false });
  }
  const platform = b.platform === "ios" || b.platform === "android" ? b.platform : null;
  if (!platform) return json({ error: "bad platform" }, 400);
  const dev = DEV.test(String(b.dev || "")) ? String(b.dev) : null;
  let host = 0;
  if (b.host_key) {
    if (!(await isHost(env, b.host_key, venue, req))) return json({ error: "That host key isn’t right." }, 401);
    host = 1;
  } else if (b.host === "keep") {
    // App reopened: keep the host flag this token already has for this bar.
    const r = await env.DB.prepare("SELECT host FROM push_devices WHERE token = ? AND venue = ?").bind(token, venue.slug).first();
    host = r && r.host ? 1 : 0;
  }
  const t = nowS();
  const stmts = [
    env.DB.prepare(`INSERT INTO push_devices (token, venue, platform, device_id, host, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
      ON CONFLICT(token) DO UPDATE SET venue = ?2, platform = ?3, device_id = ?4, host = ?5, updated_at = ?6`).bind(token, venue.slug, platform, dev, host, t),
  ];
  // A phone's token changes now and then: keep only its newest one, so it doesn't get every push twice.
  if (dev) stmts.push(env.DB.prepare("DELETE FROM push_devices WHERE device_id = ? AND token != ?").bind(dev, token));
  stmts.push(env.DB.prepare("DELETE FROM push_devices WHERE updated_at < ?").bind(t - STALE_S));
  await env.DB.batch(stmts);
  return json({ ok: true, host: !!host });
}

// ---------- Firebase ----------
let cachedAuth = null; // { token, exp, email }

function serviceAccount(env) {
  try {
    const sa = typeof env.FCM_SERVICE_ACCOUNT === "string" ? JSON.parse(env.FCM_SERVICE_ACCOUNT) : env.FCM_SERVICE_ACCOUNT;
    return sa && sa.client_email && sa.private_key && sa.project_id ? sa : null;
  } catch (e) { return null; }
}
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => b64url(new TextEncoder().encode(s));

async function accessToken(env, sa) {
  if (cachedAuth && cachedAuth.email === sa.client_email && cachedAuth.exp > nowS() + 120) return cachedAuth.token;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = nowS(), aud = sa.token_uri || "https://oauth2.googleapis.com/token";
  const unsigned = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64urlText(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud, iat, exp: iat + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const r = await fetch(aud, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + unsigned + "." + b64url(sig) });
  if (!r.ok) throw new Error("google auth " + r.status);
  const j = await r.json();
  cachedAuth = { token: j.access_token, exp: iat + (Number(j.expires_in) || 3600), email: sa.client_email };
  return cachedAuth.token;
}

// The message for one phone. path is where tapping it opens (a page of this bar, e.g. "" or "host").
export function fcmMessage(token, { kind, title, body, path, venue }) {
  return {
    message: {
      token,
      notification: { title: String(title).slice(0, 120), body: String(body).slice(0, 400) },
      data: { kind: String(kind || ""), venue: venue.slug, path: String(path || "") },
      android: { priority: "high", notification: { icon: "ic_stat_okenight", color: "#ff4fa0", channel_id: kind === "host" ? "host" : "default" } },
      apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
    },
  };
}

// Send to the chosen phones. Tokens Firebase says are gone are removed. Returns how many it reached.
export async function sendPush(env, venue, { to = "crowd", kind = "", title, body, path = "" }) {
  const sa = serviceAccount(env);
  if (!sa) return 0;
  await ensurePush(env);
  let q;
  if (to === "host") q = env.DB.prepare("SELECT token FROM push_devices WHERE venue = ? AND host = 1").bind(venue.slug);
  else if (to === "crowd") q = env.DB.prepare("SELECT token FROM push_devices WHERE venue = ? LIMIT " + MAX_PER_SEND).bind(venue.slug);
  else {
    const devs = ((to && to.devices) || []).filter((d) => DEV.test(String(d))).slice(0, 100);
    if (!devs.length) return 0;
    q = env.DB.prepare("SELECT token FROM push_devices WHERE venue = ? AND device_id IN (" + devs.map(() => "?").join(",") + ")").bind(venue.slug, ...devs);
  }
  const tokens = ((await q.all()).results || []).map((r) => r.token);
  if (!tokens.length) return 0;
  const auth = await accessToken(env, sa);
  const endpoint = "https://fcm.googleapis.com/v1/projects/" + encodeURIComponent(sa.project_id) + "/messages:send";
  let sent = 0;
  const gone = [];
  for (let i = 0; i < tokens.length; i += PARALLEL) {
    await Promise.all(tokens.slice(i, i + PARALLEL).map(async (token) => {
      try {
        const r = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer " + auth, "content-type": "application/json" },
          body: JSON.stringify(fcmMessage(token, { kind: to === "host" ? "host" : kind, title, body, path, venue })) });
        if (r.ok) { sent++; return; }
        const t = await r.text().catch(() => "");
        if (r.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(t) || (r.status === 400 && /token/i.test(t))) gone.push(token);
      } catch (e) {}
    }));
  }
  if (gone.length) await env.DB.batch(gone.map((t) => env.DB.prepare("DELETE FROM push_devices WHERE token = ?").bind(t))).catch(() => {});
  return sent;
}

// Host alerts on the host's phones (the ntfy topic keeps getting them too, as a backup). Never throws.
export async function hostPush(env, venue, title, body, path = "host") {
  try { return (await sendPush(env, venue, { to: "host", title, body, path })) > 0; } catch (e) { return false; }
}

// Cron: the first song of a night tells the crowd karaoke is live. Once per night (host_config push_live).
export async function pushLive(env, venue, nowTs = nowS()) {
  if (!serviceAccount(env)) return;
  const st = scheduleStatus(nowTs, venue);
  if (st.status === "off") return;
  const start = st.session_start;
  const p = await env.DB.prepare("SELECT count(*) AS n FROM plays WHERE venue = ?1 AND played_at >= ?2").bind(venue.slug, start - 1800).first();
  if (!p || !Number(p.n)) return;
  const key = cfgKey(venue, "push_live");
  const claim = await env.DB.prepare("INSERT INTO host_config (k, v) VALUES (?2, ?1) ON CONFLICT(k) DO UPDATE SET v = ?1 WHERE CAST(v AS integer) < ?1")
    .bind(String(start), key).run();
  if (!claim.meta.changes) return;
  try {
    await sendPush(env, venue, { to: "crowd", kind: "live", title: "Karaoke is live 🎤", body: "The first song just started at " + venue.name + ". See who’s up and cheer them on.", path: "" });
  } catch (e) {
    await env.DB.prepare("DELETE FROM host_config WHERE k = ? AND v = ?").bind(key, String(start)).run(); // retry next minute
  }
}
