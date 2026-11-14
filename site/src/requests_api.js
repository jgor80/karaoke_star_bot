// Song requests: a song someone wants to sing that isn't in the song list.
//
// POST /api/request {title, artist, name?, dev}  -> {ok, id, merged}   (merged: someone already asked, this counts as +1)
// GET  /api/request?ids=1,2,3                    -> {requests: [{id, status}]}  so a phone can show "added" on its own asks
// hostRequests(env, venue)                            -> open + recently handled requests, for /api/host
// hostRequestAction(env, body, venue)                 -> {action: "request_done", id, status: "added"|"unavailable"|"open"} | {action: "request_remove", id}
//
// Requests only go to the host (the /host page and a push to the host's ntfy topic). Nothing typed here is
// shown to the crowd, so there's nothing to moderate in public. Limits per phone and per network keep it sane.
import { cleanName } from "./reactions_api.js";
import { DEFAULT_VENUE, cfgKey, ensureVenueColumn } from "./venues.js";
import { networkHash } from "./net.js";

export const REQ_LIMITS = { perPhone: 5, perIp: 40 }; // per day
const STATUSES = ["open", "added", "unavailable"];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS song_requests (
    id integer primary key autoincrement, title text not null, artist text, k text not null,
    names text, votes integer not null default 1, status text not null default 'open',
    created_at integer not null, updated_at integer not null, venue text not null default 'wbl')`,
  "CREATE INDEX IF NOT EXISTS song_requests_k ON song_requests (k, status)",
  `CREATE TABLE IF NOT EXISTS song_request_asks (
    request_id integer not null, device_id text not null, ip_hash text, day text not null, created_at integer not null,
    primary key (request_id, device_id))`,
  "CREATE INDEX IF NOT EXISTS song_request_asks_dev ON song_request_asks (device_id, day)",
  "CREATE INDEX IF NOT EXISTS song_request_asks_ip ON song_request_asks (ip_hash, day)",
];
let ready = null;
function ensure(env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).then(() => ensureVenueColumn(env, "song_requests")).catch((e) => { ready = null; throw e; });
  return ready;
}

const PUSHES_PER_HOUR = 20;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const nowS = () => Math.floor(Date.now() / 1000);
export function cleanText(s, n) {
  return String(s || "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n).trim();
}
// "Don't Stop Me Now" / "Queen" -> "dontstopmenow|queen", so the same ask typed twice counts as one request.
export const requestKey = (title, artist) => [title, artist].map((s) =>
  String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/^the\s+/, "").replace(/[^\p{L}\p{N}]+/gu, "")).join("|");

export async function handleRequest(req, env, ctx, venue = DEFAULT_VENUE) {
  await ensure(env);
  const url = new URL(req.url);
  if (req.method === "GET") {
    const ids = (url.searchParams.get("ids") || "").split(",").map(Number).filter((n) => n > 0).slice(0, 30);
    if (!ids.length) return json({ requests: [] });
    const { results } = await env.DB.prepare("SELECT id, status FROM song_requests WHERE venue = ? AND id IN (" + ids.map(() => "?").join(",") + ")").bind(venue.slug, ...ids).all();
    return json({ requests: results });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  // Same as reactions, picks and leads: only this site's own pages may post (stops other sites making
  // their visitors' browsers send requests).
  const origin = req.headers.get("origin");
  if (origin && origin !== "null" && new URL(origin).host !== url.host) return json({ error: "Wrong site" }, 403);
  if (origin === "null") return json({ error: "Wrong site" }, 403);
  let b;
  try { b = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const title = cleanText(b.title, 100), artist = cleanText(b.artist, 80), name = cleanName(b.name);
  const dev = String(b.dev || "");
  if (title.length < 2) return json({ error: "Type the song’s title." }, 400);
  if (!/^[a-f0-9]{32}$/.test(dev)) return json({ error: "bad device" }, 400);
  const day = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10); // close enough to a Central "night"
  const ipHash = await networkHash(env, req, "request", day);
  const now = nowS();

  // Create-or-merge and the limit checks run as one batch (D1 runs a batch as a single transaction), so
  // phones asking at the same moment can't each slip past the limits or each start a duplicate request.
  //   1. a new request, only if there's no open one for this song and this phone/network is under its limits
  //   2. this phone's ask on the open request (new or existing), under the same limits
  //   3. votes = the number of asks, so the count can't drift
  const k = requestKey(title, artist);
  const underLimits = "(SELECT count(*) FROM song_request_asks WHERE device_id = ?2 AND day = ?4) < ?5" +
    " AND (?3 IS NULL OR (SELECT count(*) FROM song_request_asks WHERE ip_hash = ?3 AND day = ?4) < ?6)";
  const openReq = "SELECT id FROM song_requests WHERE k = ?1 AND venue = ?7 AND status = 'open' ORDER BY id LIMIT 1";
  const lims = [k, dev, ipHash, day, REQ_LIMITS.perPhone, REQ_LIMITS.perIp, venue.slug];
  const [created, asked] = await env.DB.batch([
    env.DB.prepare("INSERT INTO song_requests (title, artist, k, names, created_at, updated_at, venue)" +
      " SELECT ?8, ?9, ?1, ?10, ?11, ?11, ?7 WHERE NOT EXISTS (" + openReq + ") AND " + underLimits)
      .bind(...lims, title, artist || null, name || null, now),
    env.DB.prepare("INSERT OR IGNORE INTO song_request_asks (request_id, device_id, ip_hash, day, created_at)" +
      " SELECT id, ?2, ?3, ?4, ?8 FROM (" + openReq + ") WHERE " + underLimits).bind(...lims, now),
    env.DB.prepare("UPDATE song_requests SET votes = (SELECT count(*) FROM song_request_asks WHERE request_id = song_requests.id)," +
      " updated_at = ?2 WHERE id = (SELECT id FROM song_requests WHERE k = ?1 AND venue = ?3 AND status = 'open' ORDER BY id LIMIT 1)")
      .bind(k, now, venue.slug),
  ]);
  const open = await env.DB.prepare("SELECT id FROM song_requests WHERE k = ?1 AND venue = ?2 AND status = 'open' ORDER BY id LIMIT 1").bind(k, venue.slug).first();
  if (!open) return json({ error: "That’s plenty of requests for today. Try again next time!" }, 429);
  if (!created.meta.changes) {
    if (!asked.meta.changes) {
      const had = await env.DB.prepare("SELECT 1 FROM song_request_asks WHERE request_id = ? AND device_id = ?").bind(open.id, dev).first();
      if (!had) return json({ error: "That’s plenty of requests for today. Try again next time!" }, 429);
    } else if (name) {
      // Add the name in SQL, so two asks at once don't overwrite each other's name.
      await env.DB.prepare("UPDATE song_requests SET names = substr(CASE WHEN names IS NULL OR names = '' THEN ?1" +
        " WHEN instr(', ' || names || ', ', ', ' || ?1 || ', ') > 0 THEN names ELSE names || ', ' || ?1 END, 1, 300) WHERE id = ?2")
        .bind(name, open.id).run();
    }
    return json({ ok: true, id: open.id, merged: true });
  }
  const r = open;
  // Push it to the host's phone (same ntfy topic as the secret song alerts).
  ctx.waitUntil((async () => {
    const t = await env.DB.prepare("SELECT v FROM host_config WHERE k = ?").bind(cfgKey(venue, "ntfy_topic")).first().catch(() => null);
    if (!t || !t.v) return;
    // At most PUSHES_PER_HOUR request alerts an hour, so a flood of requests can't flood the host's phone.
    const recent = await env.DB.prepare("SELECT count(*) AS n FROM song_requests WHERE venue = ? AND created_at > ?").bind(venue.slug, now - 3600).first();
    if (recent && recent.n > PUSHES_PER_HOUR) return;
    await fetch("https://ntfy.sh/" + t.v, { method: "POST", body: "“" + title + "”" + (artist ? " by " + artist : "") + (name ? "\nFrom " + name : "") + "\nSee okenight.com/" + venue.slug + "/host",
      headers: { Title: "Song request", Tags: "musical_note" } });
  })().catch(() => {}));
  return json({ ok: true, id: r.id, merged: false });
}

// For /api/host: every open request (most asked first) and the last 20 handled ones.
export async function hostRequests(env, venue = DEFAULT_VENUE) {
  await ensure(env);
  const [open, done] = await env.DB.batch([
    env.DB.prepare("SELECT id, title, artist, names, votes, status, created_at, updated_at FROM song_requests WHERE status = 'open' AND venue = ?1 ORDER BY votes DESC, updated_at DESC LIMIT 200").bind(venue.slug),
    env.DB.prepare("SELECT id, title, artist, names, votes, status, created_at, updated_at FROM song_requests WHERE status != 'open' AND venue = ?1 ORDER BY updated_at DESC LIMIT 20").bind(venue.slug),
  ]);
  return { requests: open.results, requests_done: done.results };
}

export async function hostRequestAction(env, body, venue = DEFAULT_VENUE) {
  await ensure(env);
  const id = Number(body.id) || 0;
  if (body.action === "request_done") {
    if (!STATUSES.includes(body.status)) return { error: "bad status" };
    await env.DB.prepare("UPDATE song_requests SET status = ?, updated_at = ? WHERE id = ? AND venue = ?").bind(body.status, nowS(), id, venue.slug).run();
  } else if (body.action === "request_remove") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM song_request_asks WHERE request_id = (SELECT id FROM song_requests WHERE id = ? AND venue = ?)").bind(id, venue.slug),
      env.DB.prepare("DELETE FROM song_requests WHERE id = ? AND venue = ?").bind(id, venue.slug),
    ]);
  } else return { error: "unknown action" };
  return { ok: true };
}
