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
// Host actions (via /api/host): photo_remove {k, block}, photo_unblock {k}; hostPhotos() lists them.
import { matchKey, erasedSingers } from "./privacy_api.js";
import { networkHash } from "./net.js";

export const PHOTO_PX = 320;
const MAX_BYTES = 120 * 1024; // a 320 px JPEG from the phone is usually 15-40 KB
const UPLOADS_PER_NET_DAY = 20, UPLOADS_PER_VENUE_HOUR = 120;

const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const now = () => Math.floor(Date.now() / 1000);
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);

let ready = null;
function ensure(env) {
  if (!ready) ready = env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS avatars (venue text not null, k text not null, name text not null, img blob, ver integer not null default 0, owner text, blocked integer not null default 0, updated_at integer not null, PRIMARY KEY (venue, k))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS avatar_log (venue text not null, net text, at integer not null)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS avatar_log_at ON avatar_log (venue, at)"),
  ]).catch((e) => { ready = null; throw e; });
  return ready;
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
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const name = cleanName(body.name), k = matchKey(name);
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
  const img = decodeImage(body.image);
  const size = img && img.length <= MAX_BYTES ? jpegSize(img) : null;
  if (!size || size.w !== size.h || size.w < 64 || size.w > PHOTO_PX * 2) return json({ error: "That photo didn’t come through. Try another one." }, 400);
  const lim = await tooMany(env, venue, req);
  if (lim.limited) return json({ error: "Too many photo changes. Try again tomorrow." }, 429);

  // The version goes in the photo's link, which phones and the edge cache keep for a year. It must never
  // repeat for a name, even after the photo was removed (the row is deleted then), so it is at least the
  // current time in seconds: a new photo always gets a link no one has cached.
  const t = now(), ver = Math.max(((row && row.ver) || 0) + 1, t);
  // The owner and block checks above are repeated inside the write, so two phones claiming the same name
  // at once can't both win: the second one's update matches no row and is turned away.
  const put = await env.DB.prepare("INSERT INTO avatars (venue, k, name, img, ver, owner, blocked, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7) " +
    "ON CONFLICT (venue, k) DO UPDATE SET name = ?3, img = ?4, ver = ?5, owner = ?6, updated_at = ?7 " +
    "WHERE avatars.blocked = 0 AND (avatars.owner IS NULL OR avatars.owner = ?6)").bind(venue.slug, k, name, img, ver, owner, t).run();
  if (!put.meta || !put.meta.changes) return json({ error: "Another phone already added a photo for this name. If that’s not you, ask the host to remove it." }, 403);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO avatar_log (venue, net, at) VALUES (?, ?, ?)").bind(venue.slug, lim.net, t),
    env.DB.prepare("DELETE FROM avatar_log WHERE at < ?").bind(t - 2 * 86400),
  ]);
  return json({ ok: true, k, v: ver });
}

async function servePhoto(req, env, ctx, venue, url) {
  const k = String(url.searchParams.get("k") || ""), v = Number(url.searchParams.get("v")) || 0;
  if (!/^[a-z0-9]{1,80}$/.test(k)) return new Response("Not found", { status: 404 });
  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/" + venue.slug + "/api/avatar?k=" + k + "&v=" + v);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const row = await env.DB.prepare("SELECT img, ver FROM avatars WHERE venue = ? AND k = ? AND img IS NOT NULL AND blocked = 0").bind(venue.slug, k).first();
  if (!row || !row.img) return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=60" } });
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
      env.DB.prepare("SELECT k, ver FROM avatars WHERE venue = ? AND img IS NOT NULL AND blocked = 0").bind(venue.slug).all(),
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
    const { results } = await env.DB.prepare("SELECT k, name, ver, blocked, updated_at, img IS NOT NULL AS has_img FROM avatars WHERE venue = ? ORDER BY updated_at DESC LIMIT 300").bind(venue.slug).all();
    return { photos: results.map((r) => ({ k: r.k, name: r.name, v: r.ver, blocked: !!r.blocked, has_img: !!r.has_img, at: r.updated_at })) };
  } catch (e) { return { photos: [] }; }
}

// photo_remove {k, block}: the photo goes, and the name is free for any phone again (unless blocked).
// photo_unblock {k}: photos allowed again for that name.
export async function hostPhotoAction(env, body, venue) {
  await ensure(env);
  const k = matchKey(body.k);
  if (!k) return { error: "Which photo?" };
  if (body.action === "photo_remove") {
    if (body.block) {
      await env.DB.prepare("INSERT INTO avatars (venue, k, name, img, ver, owner, blocked, updated_at) VALUES (?1, ?2, ?3, NULL, 0, NULL, 1, ?4) " +
        "ON CONFLICT (venue, k) DO UPDATE SET img = NULL, owner = NULL, blocked = 1, updated_at = ?4").bind(venue.slug, k, cleanName(body.name) || k, now()).run();
    } else {
      await env.DB.prepare("DELETE FROM avatars WHERE venue = ? AND k = ?").bind(venue.slug, k).run();
    }
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
