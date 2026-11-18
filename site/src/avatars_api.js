// Singer photos: a singer who tapped "That's me" on their phone can put a photo in place of the colored
// letter circle. It shows on this bar's phone pages and on the TV.
//
// There are no accounts (no email or password). The first phone that adds a photo for a singer name gets a
// random photo key, kept on that phone (localStorage). Only the hash of that key is stored here, and only that
// phone can change or remove the photo. Someone else trying the same name is told to ask the host.
// The host (/host) sees every photo and can remove one; "Remove and block" also stops new photos for that name.
//
// The phone crops and shrinks the photo itself (a square, PHOTO_PX wide, re-encoded as JPEG), which also drops
// the camera's hidden data such as the location. The Worker only checks it is a small square JPEG.
// Photos are stored in D1 (a few tens of KB each) and served with a version number in the link, so phones and
// the edge cache can keep them for a year and a new photo gets a new link (the version never repeats for a name).
//
// POST /<slug>/api/avatar {action: "upload", name, key, image: base64 JPEG}  -> {ok, k, v}
// POST /<slug>/api/avatar {action: "delete", name, key}                      -> {ok}
// GET  /<slug>/api/avatar?k=<match key>&v=<version>                          -> the JPEG
// avatarMap(env, venue) -> {avatars: {match key: version}}, sent with /api/plays.
// Host actions (via /api/host): photo_remove {k, block}, photo_unblock {k}, photo_approve {k},
// photo_dismiss {k} (clear reports), photo_approval {on}; hostPhotos() lists them.
//
// Safety (Apple 1.2 / Google Play user content):
// - Host approval: while it is on (the default), a new photo shows only on the phone that sent it until the
//   host approves it on /host. The host gets a push when one is waiting.
// - Terms: the phone must send agree: true (a tick box next to the Terms link in the photo dialog).
// - Reports: anyone can report a photo or a name (action "report" {name, kind: photo|name, reason}). The host
//   gets a push and sees it on /host. A photo reported from REPORTS_TO_HIDE different networks is hidden at
//   once (pending again) until the host looks.
// - Hiding a singer's photo on one phone is done on the phone itself (index.html "Hide photo").
import { matchKey, erasedSingers } from "./privacy_api.js";
import { networkHash } from "./net.js";
import { hostPush } from "./push_api.js";
import { cfgKey } from "./venues.js";
import { objectionable } from "./wordfilter.js";
import { okOrigin } from "./origins.js";

export const PHOTO_PX = 320;
const MAX_BYTES = 120 * 1024; // a 320 px JPEG from the phone is usually 15-40 KB
const UPLOADS_PER_NET_DAY = 20, UPLOADS_PER_VENUE_HOUR = 120;
const REPORTS_PER_NET_DAY = 10, REPORTS_TO_HIDE = 2;
export const REPORT_REASONS = { not_them: "Not them / used someone else’s name", offensive: "Offensive or inappropriate", underage: "Looks under 21", other: "Something else" };

const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const now = () => Math.floor(Date.now() / 1000);
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);

let ready = null;
function ensure(env) {
  if (!ready) ready = env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS avatars (venue text not null, k text not null, name text not null, img blob, ver integer not null default 0, owner text, blocked integer not null default 0, updated_at integer not null, PRIMARY KEY (venue, k))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS avatar_log (venue text not null, net text, at integer not null)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS avatar_log_at ON avatar_log (venue, at)"),
    // One row per report: what (a photo or a name), why, and from which network (hashed) so one person can't
    // count twice towards hiding a photo.
    env.DB.prepare("CREATE TABLE IF NOT EXISTS content_reports (venue text not null, kind text not null, k text not null, name text not null, reason text not null, net text not null, at integer not null, PRIMARY KEY (venue, kind, k, net))"),
  ]).then(async () => {
    // Added later: 1 = waiting for the host (new photo, or hidden after reports). Older tables get the column here.
    await env.DB.prepare("ALTER TABLE avatars ADD COLUMN pending integer not null default 0").run().catch(() => {});
  }).catch((e) => { ready = null; throw e; });
  return ready;
}

async function approvalOn(env, venue) {
  const r = await env.DB.prepare("SELECT v FROM host_config WHERE k = ?").bind(cfgKey(venue, "photo_approval")).first().catch(() => null);
  return !r || r.v !== "off";
}

// A push to the host's phone (same ntfy topic as secret songs and requests). Best effort.
async function tellHost(env, venue, title, body) {
  await hostPush(env, venue, title, body);
  const t = await env.DB.prepare("SELECT v FROM host_config WHERE k = ?").bind(cfgKey(venue, "ntfy_topic")).first().catch(() => null);
  if (!t || !t.v) return;
  await fetch("https://ntfy.sh/" + t.v, { method: "POST", body: body + "\nSee okenight.com/" + venue.slug + "/host",
    headers: { Title: title, Tags: "camera_flash", Click: "https://okenight.com/" + venue.slug + "/host" } }).catch(() => {});
}

async function sha256(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// A real JPEG, square, no bigger than PHOTO_PX * 2 on a side. Reads the frame header (SOF) for the size.
export function jpegSize(b) {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    }
    if (m === 0xda) return null; // image data before any frame header
    i += 2 + len;
  }
  return null;
}

function decodeImage(s) {
  s = String(s || "").replace(/^data:image\/jpeg;base64,/, "");
  if (!s || s.length > Math.ceil(MAX_BYTES * 4 / 3) + 8 || /[^A-Za-z0-9+/=]/.test(s)) return null;
  try { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; } catch (e) { return null; }
}

// Is this a singer on this bar's site? The name must match a sung name (or the name in brackets of a costume
// name like "Vincent Vega (Amy)", or one half of a duet) and not be a removed singer.
async function knownSinger(env, venue, k) {
  const { results } = await env.DB.prepare("SELECT DISTINCT singer FROM plays WHERE venue = ? AND singer IS NOT NULL").bind(venue.slug).all();
  for (const r of results) {
    const s = String(r.singer);
    const keys = [s, s.replace(/\([^)]*\)/g, " "), ...(s.match(/\(([^)]+)\)/g) || []).map((x) => x.slice(1, -1)), ...s.split(/\s*(?:,|&|\/|\band\b|\bn\b|\+)\s*/i)];
    if (keys.some((x) => matchKey(x) === k)) return true;
  }
  return false;
}

async function tooMany(env, venue, req) {
  const t = now(), net = await networkHash(env, req, "avatar", new Date().toISOString().slice(0, 10));
  const r = await env.DB.prepare("SELECT sum(at > ?2) AS v, sum(net = ?3) AS n FROM avatar_log WHERE venue = ?1 AND at > ?4")
    .bind(venue.slug, t - 3600, net, t - 86400).first().catch(() => null);
  return { net, limited: !!r && ((r.n || 0) >= UPLOADS_PER_NET_DAY || (r.v || 0) >= UPLOADS_PER_VENUE_HOUR) };
}

export async function handleAvatar(req, env, ctx, venue, url) {
  await ensure(env);
  if (req.method === "GET" || req.method === "HEAD") return servePhoto(req, env, ctx, venue, url);
  if (req.method !== "POST") return new Response("GET or POST", { status: 405 });
  // Only this site and the app may post (stops other sites making their visitors' browsers report photos,
  // which hides a photo once REPORTS_TO_HIDE networks have reported it).
  if (!okOrigin(req, url)) return json({ error: "Wrong site" }, 403);
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const name = cleanName(body.name), k = matchKey(name);
  if (body.action === "report") return reportContent(req, env, ctx, venue, body, name, k);
  const key = String(body.key || "");
  if (!k) return json({ error: "Pick your singer name first." }, 400);
  if (!/^[a-f0-9]{32,64}$/.test(key)) return json({ error: "This phone’s photo key is missing. Reload the page and try again." }, 400);
  const owner = await sha256("avatar:" + venue.slug + ":" + key);
  const row = await env.DB.prepare("SELECT owner, blocked, ver FROM avatars WHERE venue = ? AND k = ?").bind(venue.slug, k).first();

  if (body.action === "delete") {
    if (!row || !row.owner) return json({ ok: true });
    if (row.owner !== owner) return json({ error: "Only the phone that added this photo can remove it. Ask the host." }, 403);
    await env.DB.prepare("DELETE FROM avatars WHERE venue = ? AND k = ?").bind(venue.slug, k).run();
    return json({ ok: true });
  }
  if (body.action !== "upload") return json({ error: "unknown action" }, 400);

  if (row && row.blocked) return json({ error: "The host has turned off photos for this name." }, 403);
  if (row && row.owner && row.owner !== owner) return json({ error: "Another phone already added a photo for this name. If that’s not you, ask the host to remove it." }, 403);
  if ((await erasedSingers(env, venue)).some((x) => x.k === k)) return json({ error: "That name isn’t on the site." }, 404);
  if (!(await knownSinger(env, venue, k))) return json({ error: "Sing a song first, then add your photo." }, 404);
  if (objectionable(name)) return json({ error: "Photos can’t be added for that name. Ask the host." }, 403);
  if (body.agree !== true) return json({ error: "Tick the box to agree to the Terms first." }, 400);
  const img = decodeImage(body.image);
  const size = img && img.length <= MAX_BYTES ? jpegSize(img) : null;
  if (!size || size.w !== size.h || size.w < 64 || size.w > PHOTO_PX * 2) return json({ error: "That photo didn’t come through. Try another one." }, 400);
  const lim = await tooMany(env, venue, req);
  if (lim.limited) return json({ error: "Too many photo changes. Try again tomorrow." }, 429);

  // The version goes in the photo's link, which phones and the edge cache keep for a year. It must never
  // repeat for a name, even after the photo was removed (the row is deleted then, so the old version is
  // gone). Seconds alone could repeat (remove and re-add within the same second), so it is the time in
  // milliseconds times 1000 plus a random 0-999: still a whole number well under 2^53, and never one an
  // earlier photo of this name had.
  const t = now(), ver = Math.max(((row && row.ver) || 0) + 1, Date.now() * 1000 + Math.floor(Math.random() * 1000));
  // The owner and block checks above are repeated inside the write, so two phones claiming the same name
  // at once can't both win: the second one's update matches no row and is turned away.
  const pending = (await approvalOn(env, venue)) ? 1 : 0;
  const put = await env.DB.prepare("INSERT INTO avatars (venue, k, name, img, ver, owner, blocked, updated_at, pending) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8) " +
    "ON CONFLICT (venue, k) DO UPDATE SET name = ?3, img = ?4, ver = ?5, owner = ?6, updated_at = ?7, pending = ?8 " +
    "WHERE avatars.blocked = 0 AND (avatars.owner IS NULL OR avatars.owner = ?6)").bind(venue.slug, k, name, img, ver, owner, t, pending).run();
  if (!put.meta || !put.meta.changes) return json({ error: "Another phone already added a photo for this name. If that’s not you, ask the host to remove it." }, 403);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO avatar_log (venue, net, at) VALUES (?, ?, ?)").bind(venue.slug, lim.net, t),
    env.DB.prepare("DELETE FROM avatar_log WHERE at < ?").bind(t - 2 * 86400),
    // Reports were about the old photo.
    env.DB.prepare("DELETE FROM content_reports WHERE venue = ? AND kind = 'photo' AND k = ?").bind(venue.slug, k),
  ]);
  if (pending) ctx.waitUntil(tellHost(env, venue, "New singer photo to check", name + " added a photo. It shows once you approve it."));
  return json({ ok: true, k, v: ver, pending: !!pending });
}

// POST {action: "report", name, kind: "photo" | "name", reason}: anyone, no photo key needed.
async function reportContent(req, env, ctx, venue, body, name, k) {
  const kind = body.kind === "name" ? "name" : "photo", reason = REPORT_REASONS[body.reason] ? body.reason : "other";
  if (!k) return json({ error: "Which singer?" }, 400);
  const t = now(), net = await networkHash(env, req, "report", new Date().toISOString().slice(0, 10));
  const used = await env.DB.prepare("SELECT count(*) AS n FROM content_reports WHERE venue = ? AND net = ? AND at > ?").bind(venue.slug, net, t - 86400).first().catch(() => null);
  if (used && used.n >= REPORTS_PER_NET_DAY) return json({ error: "That’s a lot of reports. Tell the host, or email info@synthwaveweb.com." }, 429);
  if (kind === "photo") {
    const row = await env.DB.prepare("SELECT 1 FROM avatars WHERE venue = ? AND k = ? AND img IS NOT NULL").bind(venue.slug, k).first();
    if (!row) return json({ ok: true }); // already gone
  } else if (!(await knownSinger(env, venue, k))) return json({ error: "That name isn’t on the site." }, 404);
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO content_reports (venue, kind, k, name, reason, net, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(venue.slug, kind, k, name, reason, net, t).run();
  if (!ins.meta || !ins.meta.changes) return json({ ok: true, already: true });
  let hidden = false;
  if (kind === "photo") {
    const c = await env.DB.prepare("SELECT count(*) AS n FROM content_reports WHERE venue = ? AND kind = 'photo' AND k = ?").bind(venue.slug, k).first();
    if (c && c.n >= REPORTS_TO_HIDE) {
      await env.DB.prepare("UPDATE avatars SET pending = 1 WHERE venue = ? AND k = ?").bind(venue.slug, k).run();
      hidden = true;
    }
  }
  ctx.waitUntil(tellHost(env, venue, "Report: " + (kind === "photo" ? "a singer photo" : "a singer name"),
    name + " — " + REPORT_REASONS[reason] + (hidden ? "\nThe photo is hidden until you look at it." : "")));
  return json({ ok: true, hidden });
}

async function servePhoto(req, env, ctx, venue, url) {
  const k = String(url.searchParams.get("k") || ""), v = Number(url.searchParams.get("v")) || 0;
  if (!/^[a-z0-9]{1,80}$/.test(k)) return new Response("Not found", { status: 404 });
  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/" + venue.slug + "/api/avatar?k=" + k + "&v=" + v);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const row = await env.DB.prepare("SELECT img, ver, pending FROM avatars WHERE venue = ? AND k = ? AND img IS NOT NULL AND blocked = 0").bind(venue.slug, k).first();
  if (!row || !row.img) return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=60" } });
  // A photo waiting for the host is only served to whoever has its exact link (the phone that sent it, and
  // /host), and never cached, so a rejected photo isn't left in any cache.
  if (row.pending) {
    if (row.ver !== v) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(new Uint8Array(row.img), { headers: { "content-type": "image/jpeg", "x-content-type-options": "nosniff", "cache-control": "private, no-store" } });
  }
  // The asked-for version can be kept for a year; any other version (an old link) only briefly.
  const exact = row.ver === v;
  const res = new Response(new Uint8Array(row.img), { headers: {
    "content-type": "image/jpeg", "x-content-type-options": "nosniff",
    "cache-control": exact ? "public, max-age=31536000, immutable" : "public, max-age=60" } });
  if (exact) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// {avatars: {k: version}} for the phones and the TV, without removed singers.
export async function avatarMap(env, venue) {
  try {
    await ensure(env);
    const [{ results }, erased] = await Promise.all([
      env.DB.prepare("SELECT k, ver FROM avatars WHERE venue = ? AND img IS NOT NULL AND blocked = 0 AND pending = 0").bind(venue.slug).all(),
      erasedSingers(env, venue)]);
    const gone = new Set(erased.map((x) => x.k));
    const out = {};
    for (const r of results) if (!gone.has(r.k)) out[r.k] = r.ver;
    return { avatars: out };
  } catch (e) { return { avatars: {} }; }
}

// /host: every photo and blocked name, newest first.
export async function hostPhotos(env, venue) {
  try {
    await ensure(env);
    const [{ results }, reps, appr] = await Promise.all([
      env.DB.prepare("SELECT k, name, ver, blocked, pending, updated_at, img IS NOT NULL AS has_img FROM avatars WHERE venue = ? ORDER BY pending DESC, updated_at DESC LIMIT 300").bind(venue.slug).all(),
      env.DB.prepare("SELECT kind, k, max(name) AS name, count(*) AS n, group_concat(DISTINCT reason) AS reasons, max(at) AS at FROM content_reports WHERE venue = ? GROUP BY kind, k ORDER BY max(at) DESC LIMIT 100").bind(venue.slug).all(),
      approvalOn(env, venue)]);
    const why = (r) => String(r || "").split(",").map((x) => REPORT_REASONS[x] || x).join("; ");
    return {
      photos: results.map((r) => ({ k: r.k, name: r.name, v: r.ver, blocked: !!r.blocked, pending: !!r.pending, has_img: !!r.has_img, at: r.updated_at })),
      reports: reps.results.map((r) => ({ kind: r.kind, k: r.k, name: r.name, n: r.n, why: why(r.reasons), at: r.at })),
      photo_approval: appr,
    };
  } catch (e) { return { photos: [], reports: [], photo_approval: true }; }
}

// photo_remove {k, block}: the photo goes, and the name is free for any phone again (unless blocked).
// photo_unblock {k}: photos allowed again for that name.
export async function hostPhotoAction(env, body, venue) {
  await ensure(env);
  if (body.action === "photo_approval") {
    await env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES (?, ?)").bind(cfgKey(venue, "photo_approval"), body.on === false ? "off" : "on").run();
    return { ok: true };
  }
  const k = matchKey(body.k);
  if (!k) return { error: "Which photo?" };
  if (body.action === "photo_remove") {
    if (body.block) {
      await env.DB.prepare("INSERT INTO avatars (venue, k, name, img, ver, owner, blocked, updated_at) VALUES (?1, ?2, ?3, NULL, 0, NULL, 1, ?4) " +
        "ON CONFLICT (venue, k) DO UPDATE SET img = NULL, owner = NULL, blocked = 1, updated_at = ?4").bind(venue.slug, k, cleanName(body.name) || k, now()).run();
    } else {
      await env.DB.prepare("DELETE FROM avatars WHERE venue = ? AND k = ?").bind(venue.slug, k).run();
    }
    await env.DB.prepare("DELETE FROM content_reports WHERE venue = ? AND kind = 'photo' AND k = ?").bind(venue.slug, k).run();
    return { ok: true };
  }
  if (body.action === "photo_approve") {
    await env.DB.prepare("UPDATE avatars SET pending = 0 WHERE venue = ? AND k = ?").bind(venue.slug, k).run();
    await env.DB.prepare("DELETE FROM content_reports WHERE venue = ? AND kind = 'photo' AND k = ?").bind(venue.slug, k).run();
    return { ok: true };
  }
  if (body.action === "photo_dismiss") { // reports looked at, nothing wrong (a name report, or a photo the host keeps)
    const kind = body.kind === "name" ? "name" : "photo";
    await env.DB.prepare("DELETE FROM content_reports WHERE venue = ? AND kind = ? AND k = ?").bind(venue.slug, kind, k).run();
    if (kind === "photo") await env.DB.prepare("UPDATE avatars SET pending = 0 WHERE venue = ? AND k = ?").bind(venue.slug, k).run();
    return { ok: true };
  }
  if (body.action === "photo_unblock") {
    await env.DB.prepare("DELETE FROM avatars WHERE venue = ? AND k = ? AND img IS NULL").bind(venue.slug, k).run();
    await env.DB.prepare("UPDATE avatars SET blocked = 0 WHERE venue = ? AND k = ?").bind(venue.slug, k).run();
    return { ok: true };
  }
  return { error: "unknown action" };
}

// privacy_api.js eraseSinger: a removed singer's photo goes too.
export async function erasePhoto(env, venue, k) {
  await ensure(env);
  await env.DB.prepare("DELETE FROM avatars WHERE venue = ? AND k = ?").bind(venue.slug, k).run();
}
