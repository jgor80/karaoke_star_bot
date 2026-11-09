// Secret songs: the host hides songs; when one gets sung, the host is alerted and the crowd sees it.
//
// GET  /api/host                      (header x-host-key) -> {secrets, ntfy_topic}
// POST /api/host {action, ...}        (header x-host-key)  add {title, artist?, reward?} | remove {id} | reset {id}
// POST /api/host {action:"setup", code, key, host_name?}  sets or resets the host key; needs the HOST_SETUP_CODE Worker secret
// POST /api/host {action:"host_name", host_name}           (header x-host-key) the host's singer name ("" = nobody)
// checkSecrets(env)                   -> marks newly sung secrets found and sends the phone push (cron + /api/plays)
// publicSecrets(env)                  -> {secrets_found: [...], secrets_left: n, host} folded into /api/plays
//
// Unfound secrets (titles and rewards) are only ever returned to the host key.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS secret_songs (
    id integer primary key autoincrement,
    title text not null, artist text, reward text,
    created_at integer not null,     -- only songs sung after this count
    found_uuid text, found_at integer, notified_at integer)`,
  "CREATE TABLE IF NOT EXISTS host_config (k text primary key, v text not null)",
];
let ready = null;
function ensure(env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; });
  return ready;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const now = () => Math.floor(Date.now() / 1000);

// "Bohemian Rhapsody (Live Aid)" / "bohemian rhapsody!" -> "bohemianrhapsody"
export const normTitle = (s) => (s || "").toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\b(feat|ft)\b.*$/, "").replace(/&/g, "and").normalize("NFD").replace(/[^a-z0-9]/g, "");
const normArtist = (s) => (s || "").toLowerCase().replace(/\bthe\b/g, " ").normalize("NFD").replace(/[^a-z0-9]/g, "");
export function matches(secret, play) {
  if (!play.title || normTitle(play.title) !== normTitle(secret.title)) return false;
  if (!secret.artist) return true;
  const a = normArtist(play.artist), b = normArtist(secret.artist);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function config(env) {
  await ensure(env);
  const { results } = await env.DB.prepare("SELECT k, v FROM host_config").all();
  return Object.fromEntries(results.map((r) => [r.k, r.v]));
}
function randomId(n) {
  const a = "abcdefghjkmnpqrstuvwxyz23456789", b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => a[x % a.length]).join("");
}
// Timing-safe compare of two hex strings of equal length.
function same(a, b) { if (!a || !b || a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }

// Mark secrets found by the first matching song sung after they were hidden; push an alert once per secret.
export async function checkSecrets(env) {
  await ensure(env);
  const open = (await env.DB.prepare("SELECT id, title, artist, created_at FROM secret_songs WHERE found_uuid IS NULL").all()).results;
  if (open.length) {
    const since = Math.min(...open.map((s) => s.created_at));
    const plays = (await env.DB.prepare("SELECT uuid, played_at, title, artist FROM plays WHERE played_at >= ? ORDER BY played_at").bind(since).all()).results;
    const upd = [];
    open.forEach((s) => { const p = plays.find((p) => p.played_at >= s.created_at && matches(s, p));
      if (p) upd.push(env.DB.prepare("UPDATE secret_songs SET found_uuid = ?, found_at = ? WHERE id = ? AND found_uuid IS NULL").bind(p.uuid, p.played_at, s.id)); });
    if (upd.length) await env.DB.batch(upd);
  }
  // notified_at: NULL = not pushed yet, negative = a push in progress (claimed at -notified_at),
  // positive = pushed. A failed push goes back to NULL, so the every-minute cron retries it
  // for up to an hour after the find. A claim left behind by a crashed run is retried after 2 minutes.
  const t = now();
  const todo = (await env.DB.prepare(
    `SELECT s.id, s.title, s.artist, s.reward, s.notified_at, p.singer, p.title AS sung_title, p.artist AS sung_artist
     FROM secret_songs s LEFT JOIN plays p ON p.uuid = s.found_uuid
     WHERE s.found_uuid IS NOT NULL AND s.found_at > ?1
       AND (s.notified_at IS NULL OR (s.notified_at < 0 AND -s.notified_at < ?2))`).bind(t - 3600, t - 120).all()).results;
  if (!todo.length) return;
  const cfg = await config(env);
  for (const s of todo) {
    // Claim it first so two overlapping runs don't both push.
    const claim = await env.DB.prepare("UPDATE secret_songs SET notified_at = ?1 WHERE id = ?2 AND notified_at IS ?3")
      .bind(cfg.ntfy_topic ? -t : t, s.id, s.notified_at).run();
    if (!claim.meta.changes || !cfg.ntfy_topic) continue;
    const who = (s.singer || "Someone").trim();
    const body = who + " just sang “" + (s.sung_title || s.title) + "”" + (s.reward ? ". Reward: " + s.reward : "");
    let sent = false;
    try {
      const r = await fetch("https://ntfy.sh/" + cfg.ntfy_topic, { method: "POST", body,
        headers: { Title: "Secret song found!", Priority: "high", Tags: "shushing_face,microphone", Click: "https://okenight.com/host" } });
      sent = r.ok;
    } catch (e) { /* retried on the next run; the host page still alerts */ }
    await env.DB.prepare("UPDATE secret_songs SET notified_at = ?1 WHERE id = ?2 AND notified_at = ?3")
      .bind(sent ? now() : null, s.id, -t).run();
  }
}

// The host's singer name, shown with a host tag on the phone site and the TV. Set on /host.
export const DEFAULT_HOST = "Bleacher Jeff";
function cleanHostName(s) { return String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40); }
async function hostName(env) {
  const v = (await config(env)).host_name;
  return v === undefined ? DEFAULT_HOST : v;
}

// Found secrets (with who sang them) and how many are still hidden. Never includes unfound titles.
export async function publicSecrets(env) {
  try {
    await ensure(env);
    const [found, left] = await env.DB.batch([
      env.DB.prepare("SELECT s.id, s.title, s.artist, s.reward, s.found_uuid, s.found_at, p.singer, p.night FROM secret_songs s LEFT JOIN plays p ON p.uuid = s.found_uuid WHERE s.found_uuid IS NOT NULL ORDER BY s.found_at"),
      env.DB.prepare("SELECT count(*) AS n FROM secret_songs WHERE found_uuid IS NULL"),
    ]);
    return { secrets_found: found.results, secrets_left: left.results[0]?.n || 0, host: await hostName(env) };
  } catch (e) { return { secrets_found: [], secrets_left: 0, host: DEFAULT_HOST }; }
}

export async function handleHost(req, env) {
  const cfg = await config(env);
  const given = req.headers.get("x-host-key") || "";
  let body = {};
  if (req.method === "POST") { try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); } }

  if (body.action === "setup") {
    // Setting (or resetting) the host key needs the setup code, a Worker secret only the owner can set:
    //   npx wrangler secret put HOST_SETUP_CODE
    // So nobody who stumbles on /host can claim it, and a forgotten key can be replaced.
    if (!env.HOST_SETUP_CODE) return json({ error: "Setup is locked. Set the HOST_SETUP_CODE secret on the Worker first (see the README)." }, 403);
    const code = String(body.code || "");
    const codeOk = same(await sha256("code:" + code), await sha256("code:" + env.HOST_SETUP_CODE));
    if (!codeOk) { await new Promise((r) => setTimeout(r, 400)); return json({ error: "That setup code isn’t right.", needs_setup: true }, 403); }
    const key = String(body.key || "").trim();
    if (key.length < 6) return json({ error: "Use at least 6 characters.", needs_setup: true }, 400);
    const salt = randomId(16);
    const stmts = [
      env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES ('key_salt', ?)").bind(salt),
      env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES ('key_hash', ?)").bind(await sha256(salt + ":" + key)),
      // Keep the push topic across key resets so the host's phone stays subscribed.
      env.DB.prepare("INSERT OR IGNORE INTO host_config (k, v) VALUES ('ntfy_topic', ?)").bind("okenight-" + randomId(16)),
    ];
    const name = cleanHostName(body.host_name);
    if (name) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES ('host_name', ?)").bind(name));
    await env.DB.batch(stmts);
    return json({ ok: true });
  }
  if (!cfg.key_hash) return json({ error: "setup", needs_setup: true }, 401);
  if (!same(await sha256(cfg.key_salt + ":" + given.trim()), cfg.key_hash)) {
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing
    return json({ error: "Wrong host key." }, 403);
  }

  if (req.method === "POST") {
    const id = Number(body.id) || 0;
    const t = (s, n) => String(s || "").trim().slice(0, n);
    if (body.action === "add") {
      const title = t(body.title, 120); if (!title) return json({ error: "Song title is required." }, 400);
      await env.DB.prepare("INSERT INTO secret_songs (title, artist, reward, created_at) VALUES (?, ?, ?, ?)").bind(title, t(body.artist, 120) || null, t(body.reward, 160) || null, now()).run();
    } else if (body.action === "remove") {
      await env.DB.prepare("DELETE FROM secret_songs WHERE id = ?").bind(id).run();
    } else if (body.action === "reset") {
      // Hide it again: only songs sung from now on count.
      await env.DB.prepare("UPDATE secret_songs SET found_uuid = NULL, found_at = NULL, notified_at = NULL, created_at = ? WHERE id = ?").bind(now(), id).run();
    } else if (body.action === "host_name") {
      const name = cleanHostName(body.host_name);
      if (name) await env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES ('host_name', ?)").bind(name).run();
      else await env.DB.prepare("DELETE FROM host_config WHERE k = 'host_name'").run();
    } else if (body.action === "test") {
      if (cfg.ntfy_topic) await fetch("https://ntfy.sh/" + cfg.ntfy_topic, { method: "POST", body: "Test alert from Oke Night. Secret song alerts will look like this.", headers: { Title: "Secret song found!", Tags: "shushing_face" } }).catch(() => {});
      return json({ ok: true });
    } else return json({ error: "unknown action" }, 400);
  }
  await checkSecrets(env);
  const { results } = await env.DB.prepare(
    "SELECT s.id, s.title, s.artist, s.reward, s.created_at, s.found_uuid, s.found_at, p.singer, p.title AS sung_title FROM secret_songs s LEFT JOIN plays p ON p.uuid = s.found_uuid ORDER BY s.found_at IS NULL DESC, s.found_at DESC, s.id DESC").all();
  const name = (await config(env)).host_name;
  return json({ secrets: results, ntfy_topic: cfg.ntfy_topic || null, host_name: name === undefined ? DEFAULT_HOST : name, now: now() });
}
