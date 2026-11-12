// Secret songs: the host hides songs; when one gets sung, the host is alerted and the crowd sees it.
//
// GET  /api/host                      (header x-host-key) -> {secrets, ntfy_topic}
// POST /api/host {action, ...}        (header x-host-key)  add {title, artist?, reward?} | remove {id} | reset {id}
// POST /api/host {action:"setup", code, key, host_name?}  sets or resets the host key; needs the HOST_SETUP_CODE Worker secret
// POST /api/host {action:"host_name", host_name}           (header x-host-key) the host's singer name ("" = nobody)
// POST /api/host {action:"tips", venmo, menu}              (header x-host-key) Venmo handle + tip menu (menu null = default)
// POST /api/host {action:"songbook_upload"|"songbook_source"|"songbook_clear", ...}  the host's own songbook (songbook_api.js)
// POST /api/host {action:"request_done", id, status} | {action:"request_remove", id}  song requests (requests_api.js)
// POST /api/host {action:"draft_remove", id} | {action:"draft_block"|"draft_unblock", singer}  crowd draft moderation (drafts_api.js)
// POST /api/host {action:"singer_erase", singer}  take a singer's name off the site (privacy_api.js)
// checkSecrets(env, venue)                 -> marks newly sung secrets found and sends the phone push (cron + /api/plays)
// publicSecrets(env, venue)                -> {secrets_found: [...], secrets_left: n, host, tips} folded into /api/plays
//
// Unfound secrets (titles and rewards) are only ever returned to the host key.

import { hostDraftAction, draftBoard } from "./drafts_api.js";
import { hostRequests, hostRequestAction } from "./requests_api.js";
import { hostLeads, hostLeadAction } from "./leads_api.js";
import { hostSongbookAction, songbookConfig } from "./songbook_api.js";
import { eraseSinger, erasedSingers } from "./privacy_api.js";
import { DEFAULT_VENUE, cfgKey, venueConfig, ensureVenueColumn } from "./venues.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS secret_songs (
    id integer primary key autoincrement,
    title text not null, artist text, reward text,
    created_at integer not null,     -- only songs sung after this count
    found_uuid text, found_at integer, notified_at integer, venue text not null default 'wbl')`,
  "CREATE TABLE IF NOT EXISTS host_config (k text primary key, v text not null)",
];
let ready = null;
function ensure(env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).then(() => ensureVenueColumn(env, "secret_songs")).catch((e) => { ready = null; throw e; });
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
async function config(env, venue) {
  await ensure(env);
  return venueConfig(env, venue);
}
function randomId(n) {
  const a = "abcdefghjkmnpqrstuvwxyz23456789", b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => a[x % a.length]).join("");
}
// Timing-safe compare of two hex strings of equal length.
function same(a, b) { if (!a || !b || a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }

// Mark secrets found by the first matching song sung after they were hidden; push an alert once per secret.
export async function checkSecrets(env, venue = DEFAULT_VENUE) {
  await ensure(env);
  const open = (await env.DB.prepare("SELECT id, title, artist, created_at FROM secret_songs WHERE found_uuid IS NULL AND venue = ?").bind(venue.slug).all()).results;
  if (open.length) {
    const since = Math.min(...open.map((s) => s.created_at));
    const plays = (await env.DB.prepare("SELECT uuid, played_at, title, artist FROM plays WHERE played_at >= ? AND venue = ? ORDER BY played_at").bind(since, venue.slug).all()).results;
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
     WHERE s.found_uuid IS NOT NULL AND s.found_at > ?1 AND s.venue = ?3
       AND (s.notified_at IS NULL OR (s.notified_at < 0 AND -s.notified_at < ?2))`).bind(t - 3600, t - 120, venue.slug).all()).results;
  if (!todo.length) return;
  const cfg = await config(env, venue);
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
        headers: { Title: "Secret song found!", Priority: "high", Tags: "shushing_face,microphone", Click: "https://okenight.com/" + venue.slug + "/host" } });
      sent = r.ok;
    } catch (e) { /* retried on the next run; the host page still alerts */ }
    await env.DB.prepare("UPDATE secret_songs SET notified_at = ?1 WHERE id = ?2 AND notified_at = ?3")
      .bind(sent ? now() : null, s.id, -t).run();
  }
}

// The host's singer name, shown with a host tag on the phone site and the TV. Set on /host.
export const DEFAULT_HOST = DEFAULT_VENUE.host_default;
const hostDefault = (venue) => venue.host_default || "";
function cleanHostName(s) { return String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40); }

// Tip menu: the host's Venmo handle and the menu shown behind the Tip button. Both set on /host.
// Perks ("skip the line" and so on) are on the honor system: the host sees the note in Venmo and does it.
export const DEFAULT_VENMO = ""; // no Tip button until the host adds a handle on /host
export const DEFAULT_TIPS = [
  { emoji: "🙌", label: "Thanks for hosting", amount: 5, note: "Keep the mics on" },
  { emoji: "🍻", label: "Buy the host a drink", amount: 8, note: "Cheers from the crowd" },
  { emoji: "🎲", label: "Host picks my next song", amount: 5, note: "No take-backs, you sing it" },
  { emoji: "⏩", label: "Bump me up the list", amount: 10, note: "Moves you up a few spots (host's call)" },
  { emoji: "🎤", label: "Make the host sing one", amount: 15, note: "You pick the song" },
  { emoji: "🥂", label: "Dedicate a song", amount: 5, note: "Host gives it a shout-out on the mic" },
];
function cleanVenmo(s) { return String(s || "").trim().replace(/^@/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30); }
function cleanTips(list) {
  if (!Array.isArray(list)) return null;
  const t = (s, n) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
  return list.slice(0, 10).map((x) => {
    const amt = Math.round(Number(x && x.amount) * 100) / 100;
    return { emoji: t(x && x.emoji, 8), label: t(x && x.label, 40), amount: amt > 0 && amt <= 1000 ? amt : null, note: t(x && x.note, 80) };
  }).filter((x) => x.label);
}
function tipsFrom(cfg) {
  let menu = null;
  try { menu = cfg.tip_menu ? cleanTips(JSON.parse(cfg.tip_menu)) : null; } catch (e) {}
  return { venmo: cfg.venmo === undefined ? DEFAULT_VENMO : cfg.venmo, menu: menu || DEFAULT_TIPS };
}

// Found secrets (with who sang them) and how many are still hidden. Never includes unfound titles.
export async function publicSecrets(env, venue = DEFAULT_VENUE) {
  try {
    await ensure(env);
    const [found, left] = await env.DB.batch([
      env.DB.prepare("SELECT s.id, s.title, s.artist, s.reward, s.found_uuid, s.found_at, p.singer, p.night FROM secret_songs s LEFT JOIN plays p ON p.uuid = s.found_uuid WHERE s.found_uuid IS NOT NULL AND s.venue = ?1 ORDER BY s.found_at").bind(venue.slug),
      env.DB.prepare("SELECT count(*) AS n FROM secret_songs WHERE found_uuid IS NULL AND venue = ?1").bind(venue.slug),
    ]);
    const cfg = await config(env, venue);
    return { secrets_found: found.results, secrets_left: left.results[0]?.n || 0, host: cfg.host_name === undefined ? hostDefault(venue) : cfg.host_name, tips: tipsFrom(cfg) };
  } catch (e) { return { secrets_found: [], secrets_left: 0, host: hostDefault(venue), tips: { venmo: DEFAULT_VENMO, menu: DEFAULT_TIPS } }; }
}

// True when `given` is the host key. Used by other host-only endpoints (the crowd meter's /api/crowd).
// Wrong host keys and setup codes are counted per network and per bar, so the key can't be guessed by
// sending many tries at once (the old 400 ms delay only slowed one try at a time).
const FAIL_PER_NET_HOUR = 10, FAIL_PER_VENUE_HOUR = 60;
let failsReady = null;
async function failNet(req) { return (await sha256("fail|" + (req && req.headers.get("cf-connecting-ip") || "") + "|" + new Date().toISOString().slice(0, 10))).slice(0, 24); }
async function lockedOut(env, venue, req) {
  if (!failsReady) failsReady = env.DB.prepare("CREATE TABLE IF NOT EXISTS host_fails (venue text not null, net text not null, at integer not null)").run()
    .then(() => env.DB.prepare("CREATE INDEX IF NOT EXISTS host_fails_venue ON host_fails (venue, at)").run()).catch((e) => { failsReady = null; throw e; });
  await failsReady;
  const since = Math.floor(Date.now() / 1000) - 3600, net = await failNet(req);
  const r = await env.DB.prepare("SELECT count(*) AS v, sum(net = ?3) AS n FROM host_fails WHERE venue = ?1 AND at > ?2").bind(venue.slug, since, net).first();
  return !!r && ((r.n || 0) >= FAIL_PER_NET_HOUR || (r.v || 0) >= FAIL_PER_VENUE_HOUR);
}
async function noteFail(env, venue, req) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO host_fails (venue, net, at) VALUES (?, ?, ?)").bind(venue.slug, await failNet(req), now),
    env.DB.prepare("DELETE FROM host_fails WHERE at < ?").bind(now - 86400),
  ]).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
}
const LOCKED = () => json({ error: "Too many wrong tries. Wait an hour and try again." }, 429);

export async function isHost(env, given, venue = DEFAULT_VENUE, req = null) {
  const cfg = await config(env, venue);
  if (req && (await lockedOut(env, venue, req))) return false;
  const ok = !!cfg.key_hash && same(await sha256(cfg.key_salt + ":" + String(given || "").trim()), cfg.key_hash);
  if (!ok && req) await noteFail(env, venue, req);
  return ok;
}

// This bar's own setup code (HOST_SETUP_CODE_<SLUG>, e.g. HOST_SETUP_CODE_WBL) when it has one, so a code
// handed to one bar's host can't reset another bar's key. HOST_SETUP_CODE is the site owner's code and works for every bar.
function setupCodes(env, venue) {
  const own = env["HOST_SETUP_CODE_" + venue.slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")];
  return [own, env.HOST_SETUP_CODE].filter(Boolean).map(String);
}

async function catalogCount(env) {
  const r = await env.DB.prepare("SELECT v FROM catalog_meta WHERE k = 'count'").first().catch(() => null);
  return r ? Number(r.v) || 0 : 0;
}

export async function handleHost(req, env, venue = DEFAULT_VENUE) {
  const cfg = await config(env, venue);
  const K = (k) => cfgKey(venue, k);
  const given = req.headers.get("x-host-key") || "";
  let body = {};
  if (req.method === "POST") { try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); } }

  if (body.action === "setup") {
    // Setting (or resetting) the host key needs the setup code, a Worker secret only the owner can set:
    //   npx wrangler secret put HOST_SETUP_CODE
    // So nobody who stumbles on /host can claim it, and a forgotten key can be replaced.
    //   (or HOST_SETUP_CODE_<SLUG> for just one bar, see setupCodes)
    const codes = setupCodes(env, venue);
    if (!codes.length) return json({ error: "Setup isn’t open yet. Ask the site owner for a setup code." }, 403);
    if (await lockedOut(env, venue, req)) return LOCKED();
    const code = String(body.code || "");
    let codeOk = false;
    for (const c of codes) if (same(await sha256("code:" + code), await sha256("code:" + c))) codeOk = true;
    if (!codeOk) { await noteFail(env, venue, req); return json({ error: "That setup code isn’t right.", needs_setup: true }, 403); }
    const key = String(body.key || "").trim();
    if (key.length < 10) return json({ error: "Use at least 10 characters.", needs_setup: true }, 400);
    const salt = randomId(16);
    const stmts = [
      env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES (?, ?)").bind(K("key_salt"), salt),
      env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES (?, ?)").bind(K("key_hash"), await sha256(salt + ":" + key)),
      // Keep the push topic across key resets so the host's phone stays subscribed.
      env.DB.prepare("INSERT OR IGNORE INTO host_config (k, v) VALUES (?, ?)").bind(K("ntfy_topic"), "okenight-" + randomId(16)),
    ];
    const name = cleanHostName(body.host_name);
    if (name) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES (?, ?)").bind(K("host_name"), name));
    await env.DB.batch(stmts);
    return json({ ok: true });
  }
  if (!cfg.key_hash) return json({ error: "setup", needs_setup: true }, 401);
  if (await lockedOut(env, venue, req)) return LOCKED();
  if (!same(await sha256(cfg.key_salt + ":" + given.trim()), cfg.key_hash)) {
    await noteFail(env, venue, req); // counts toward the lock-out and slows down guessing
    return json({ error: "Wrong host key." }, 403);
  }

  if (req.method === "POST") {
    const id = Number(body.id) || 0;
    const t = (s, n) => String(s || "").trim().slice(0, n);
    if (body.action === "add") {
      const title = t(body.title, 120); if (!title) return json({ error: "Song title is required." }, 400);
      await env.DB.prepare("INSERT INTO secret_songs (title, artist, reward, created_at, venue) VALUES (?, ?, ?, ?, ?)").bind(title, t(body.artist, 120) || null, t(body.reward, 160) || null, now(), venue.slug).run();
    } else if (body.action === "remove") {
      await env.DB.prepare("DELETE FROM secret_songs WHERE id = ? AND venue = ?").bind(id, venue.slug).run();
    } else if (body.action === "reset") {
      // Hide it again: only songs sung from now on count.
      await env.DB.prepare("UPDATE secret_songs SET found_uuid = NULL, found_at = NULL, notified_at = NULL, created_at = ? WHERE id = ? AND venue = ?").bind(now(), id, venue.slug).run();
    } else if (body.action === "host_name") {
      const name = cleanHostName(body.host_name);
      if (name) await env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES (?, ?)").bind(K("host_name"), name).run();
      else await env.DB.prepare("DELETE FROM host_config WHERE k = ?").bind(K("host_name")).run();
    } else if (body.action === "tips") {
      const menu = body.menu == null ? null : cleanTips(body.menu);
      if (body.menu != null && !menu) return json({ error: "Bad tip menu." }, 400);
      await env.DB.batch([
        env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES (?, ?)").bind(K("venmo"), cleanVenmo(body.venmo)),
        menu ? env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES (?, ?)").bind(K("tip_menu"), JSON.stringify(menu))
             : env.DB.prepare("DELETE FROM host_config WHERE k = ?").bind(K("tip_menu")),
      ]);
    } else if (String(body.action || "").startsWith("draft_")) {
      const r = await hostDraftAction(env, body, venue); // crowd draft: remove a pick, block or unblock a singer
      if (r.error) return json(r, 400);
    } else if (String(body.action || "").startsWith("songbook_")) {
      const r = await hostSongbookAction(env, body, venue); // the host's own songbook: upload, pick which list, clear
      if (r.error) return json(r, 400);
      if (body.action === "songbook_upload") return json(r);
    } else if (String(body.action || "").startsWith("request_")) {
      const r = await hostRequestAction(env, body, venue); // song requests: mark added / not available, or remove
      if (r.error) return json(r, 400);
    } else if (String(body.action || "").startsWith("lead_")) {
      if (venue.slug !== DEFAULT_VENUE.slug) return json({ error: "Leads are on the first venue's host page." }, 403);
      const r = await hostLeadAction(env, body); // "Bring Oke Night to your bar" leads: remove one once handled
      if (r.error) return json(r, 400);
    } else if (body.action === "singer_erase") {
      const r = await eraseSinger(env, body, venue); // privacy: a singer asked to be taken off the site
      if (r.error) return json(r, 400);
      return json(r);
    } else if (body.action === "test") {
      if (!cfg.ntfy_topic) return json({ error: "No alert topic yet." }, 400);
      const sent = await fetch("https://ntfy.sh/" + cfg.ntfy_topic, { method: "POST", body: "Test alert from Oke Night. Secret song alerts will look like this.", headers: { Title: "Secret song found!", Tags: "shushing_face" } })
        .then((r) => r.ok).catch(() => false);
      return sent ? json({ ok: true }) : json({ error: "ntfy didn’t take the test. Try again in a minute." }, 502);
    } else return json({ error: "unknown action" }, 400);
  }
  await checkSecrets(env, venue);
  const { results } = await env.DB.prepare(
    "SELECT s.id, s.title, s.artist, s.reward, s.created_at, s.found_uuid, s.found_at, p.singer, p.title AS sung_title FROM secret_songs s LEFT JOIN plays p ON p.uuid = s.found_uuid WHERE s.venue = ? ORDER BY s.found_at IS NULL DESC, s.found_at DESC, s.id DESC").bind(venue.slug).all();
  const fresh = await config(env, venue);
  const cfgBlocked = (() => { try { return JSON.parse(fresh.draft_blocked || "[]"); } catch (e) { return []; } })();
  const leads = venue.slug === DEFAULT_VENUE.slug ? await hostLeads(env) : {};
  return json({ ...(await draftBoard(env, venue)), ...(await hostRequests(env, venue)), ...leads, songbook: await songbookConfig(env, venue), catalog_count: await catalogCount(env), draft_blocked: cfgBlocked, erased_singers: (await erasedSingers(env, venue)).map((x) => ({ as: x.as, at: x.at })), secrets: results, ntfy_topic: cfg.ntfy_topic || null, host_name: fresh.host_name === undefined ? hostDefault(venue) : fresh.host_name, venue: { slug: venue.slug, name: venue.name }, tips: tipsFrom(fresh), default_tips: DEFAULT_TIPS, now: now() });
}
