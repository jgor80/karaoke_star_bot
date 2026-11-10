// Live emoji reactions: the only thing visitors can write.
// POST /api/react   {play, r, dev, name}  -> {ok, counts}   (rate limited, see LIMITS)
// GET  /api/reactions?play=<uuid>        -> {play, counts}  (counts for one song, cached 2s)
// reactionTotals(env, venue)              -> totals folded into /api/plays for awards, badges and /tv
//
// Device ids and IP hashes are only used for rate limiting. They are never sent back to anyone.

// Keep in sync with REACTIONS in awards.js (the page's buttons).
export const REACTION_KEYS = ["fire", "micdrop", "encore", "chills", "dance", "keychange", "cringe", "offkey", "tomato", "snooze"];
const KEYS = new Set(REACTION_KEYS);
import { DEFAULT_VENUE, ensureVenueColumn } from "./venues.js";

export const LIMITS = {
  burst: 8, burstWindowS: 10,     // one phone: at most 8 taps in 10 seconds
  perSong: 40,                    // one phone: at most 40 reactions on one song
  ipPerMin: 240,                  // one IP (the bar wifi is shared, so this is loose): 240 a minute
  graceS: 180,                    // a song takes reactions until 3 minutes after it should have ended
  defaultLenS: 300,
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reactions (
    id integer primary key autoincrement,
    play_uuid text not null, night text, singer text,
    reaction text not null, who text not null,
    device_id text not null, ip_hash text,
    created_at integer not null, venue text not null default 'wbl')`,
  "CREATE INDEX IF NOT EXISTS reactions_play on reactions(play_uuid)",
  "CREATE INDEX IF NOT EXISTS reactions_device on reactions(device_id, created_at)",
  "CREATE INDEX IF NOT EXISTS reactions_ip on reactions(ip_hash, created_at)",
  "CREATE INDEX IF NOT EXISTS reactions_night on reactions(night)",
];

let ready = null; // one CREATE ... IF NOT EXISTS per Worker instance, so no manual migration is needed
export function ensureTable(env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).then(() => ensureVenueColumn(env, "reactions")).catch((e) => { ready = null; throw e; });
  return ready;
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Display names are typed by anyone, so: printable text only, single spaces, 24 characters at most.
export function cleanName(s) {
  return String(s || "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 24).trim();
}

async function countsFor(env, play) {
  const r = await env.DB.prepare("SELECT reaction, count(*) AS n FROM reactions WHERE play_uuid = ?1 GROUP BY reaction").bind(play).all();
  const out = {}; r.results.forEach((x) => { out[x.reaction] = x.n; }); return out;
}

export async function handleReact(req, env, venue = DEFAULT_VENUE) {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) return json({ error: "Wrong site" }, 403);
  if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ error: "Send JSON" }, 415);
  let body;
  try { body = JSON.parse((await req.text()).slice(0, 2000)); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  const play = typeof body.play === "string" ? body.play.slice(0, 80) : "";
  const r = String(body.r || "");
  const dev = String(body.dev || "").toLowerCase();
  if (!play || !KEYS.has(r) || !/^[a-f0-9]{16,64}$/.test(dev)) return json({ error: "Bad reaction" }, 400);

  await ensureTable(env);
  const now = Math.floor(Date.now() / 1000);
  const ip = req.headers.get("cf-connecting-ip") || "";
  const ipHash = ip ? (await sha("oke-night|" + ip + "|" + new Date().toISOString().slice(0, 10))).slice(0, 24) : null;
  const pl = await env.DB.prepare("SELECT uuid, night, singer, played_at, length_s FROM plays WHERE uuid = ?1 AND venue = ?2").bind(play, venue.slug).all();
  const p = pl.results[0];
  if (!p) return json({ error: "Unknown song" }, 404);
  const age = now - Number(p.played_at), len = Number(p.length_s) || LIMITS.defaultLenS;
  if (age < -120 || age > len + LIMITS.graceS) return json({ error: "That song is over", closed: true }, 409);

  // The limit check and the insert are one statement, so taps sent at the same moment can't
  // all read the same counts and slip past the limits together.
  const who = cleanName(body.name) || "Anon " + (await sha(dev)).slice(0, 4).toUpperCase();
  const ins = await env.DB.prepare(`INSERT INTO reactions (play_uuid, night, singer, reaction, who, device_id, ip_hash, created_at, venue)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?14
      WHERE (SELECT count(*) FROM reactions WHERE device_id = ?6 AND created_at > ?9) < ?10
        AND (SELECT count(*) FROM reactions WHERE device_id = ?6 AND play_uuid = ?1) < ?11
        AND (?7 IS NULL OR (SELECT count(*) FROM reactions WHERE ip_hash = ?7 AND created_at > ?12) < ?13)`)
    .bind(p.uuid, p.night, p.singer, r, who, dev, ipHash, now,
      now - LIMITS.burstWindowS, LIMITS.burst, LIMITS.perSong, now - 60, LIMITS.ipPerMin, venue.slug).run();
  const lim = await env.DB.prepare(`SELECT
      (SELECT count(*) FROM reactions WHERE device_id = ?1 AND created_at > ?2) AS burst,
      (SELECT count(*) FROM reactions WHERE device_id = ?1 AND play_uuid = ?3) AS song,
      (SELECT count(*) FROM reactions WHERE ip_hash = ?4 AND created_at > ?5) AS ip`)
    .bind(dev, now - LIMITS.burstWindowS, p.uuid, ipHash, now - 60).all();
  const l = lim.results[0] || {};
  if (!ins.meta || !ins.meta.changes) {
    if (l.song >= LIMITS.perSong) return json({ error: "You’ve maxed out reactions for this song.", maxed: true }, 429);
    if (l.burst >= LIMITS.burst) return json({ error: "Easy there! Give it a second.", slow: true }, 429, { "retry-after": String(LIMITS.burstWindowS) });
    return json({ error: "Too many reactions from this network. Try again in a minute.", slow: true }, 429, { "retry-after": "60" });
  }
  return json({ ok: true, who, counts: await countsFor(env, p.uuid), left: Math.max(0, LIMITS.perSong - l.song) });
}

export async function handleCounts(req, env, ctx) {
  const url = new URL(req.url);
  const play = (url.searchParams.get("play") || "").slice(0, 80);
  if (!play) return json({ error: "Which song?" }, 400);
  const cache = caches.default;
  const key = new Request(url.origin + "/api/reactions?play=" + encodeURIComponent(play));
  let res = await cache.match(key);
  if (!res) {
    let counts = {};
    try { counts = await countsFor(env, play); } catch (e) { /* table not made yet: no reactions */ }
    res = json({ play, counts }, 200, { "cache-control": "public, max-age=2" });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return res;
}

// For /api/plays: counts per song and emoji (distinct phones), and per reactor name and night (no device ids or IPs).
export async function reactionTotals(env, venue = DEFAULT_VENUE) {
  try {
    const [bySong, byWho] = await env.DB.batch([
      // n = how many different phones sent that emoji on that song, so one phone tapping
      // ten times counts once toward crowd awards and badges. taps = the raw number of taps.
      env.DB.prepare("SELECT play_uuid AS play, reaction AS r, count(DISTINCT device_id) AS n, count(*) AS taps FROM reactions WHERE venue = ?1 GROUP BY play_uuid, reaction").bind(venue.slug),
      env.DB.prepare("SELECT night, who, reaction AS r, count(*) AS n FROM reactions WHERE venue = ?1 GROUP BY night, who, reaction").bind(venue.slug),
    ]);
    return { reactions: bySong.results, reactors: byWho.results };
  } catch (e) {
    return { reactions: [], reactors: [] }; // no reactions table yet
  }
}
