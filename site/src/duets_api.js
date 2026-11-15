// Duet finder: "I want to sing this duet, who's in?" Someone posts a song, someone else taps "I'm in",
// and both see the match on their phones (and the TV) so they can go sign up together at the booth.
//
// POST /api/duet {action: "post", song, name, dev}   -> {ok, id, duets}   (song = a song id from the catalog or songs sung here)
// POST /api/duet {action: "join", id, name, dev}     -> {ok, duets}
// POST /api/duet {action: "cancel", id, dev}         -> {ok, duets}       (the poster, or the partner backing out)
// duetBoard(env, venue)                              -> {duets} folded into /api/plays
// hostDuetAction(env, body, venue)                   -> duet_remove {id} from /host (host key checked there)
//
// Names are typed by people on their phones, so they go through cleanName and the host can remove a post.
// Device ids and IP hashes are only used for the limits below, and are cleared after 90 days (privacy_api.js).
import { cleanName } from "./reactions_api.js";
import { listSongById } from "./songbook_api.js";
import { draftNight } from "./drafts_api.js";
import { DEFAULT_VENUE } from "./venues.js";
import { networkHash } from "./net.js";

export const DUET_LIMITS = { postsPerPhone: 2, postsPerIp: 30, open: 40 };
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS duets (
    id integer primary key autoincrement, venue text not null default 'wbl', night text not null,
    song_id integer, title text not null, artist text,
    by_name text not null, device_id text not null, ip_hash text, created_at integer not null,
    partner text, partner_device text, matched_at integer, removed_at integer)`,
  "CREATE INDEX IF NOT EXISTS duets_night ON duets (venue, night)",
];
let ready = null;
const ensure = (env) => (ready ||= env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; }));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const nowS = () => Math.floor(Date.now() / 1000);

async function boardFor(env, venue, night) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, artist, song_id, by_name AS by, partner, created_at, matched_at FROM duets
     WHERE venue = ?1 AND night = ?2 AND removed_at IS NULL ORDER BY matched_at IS NOT NULL, created_at DESC LIMIT ?3`).bind(venue.slug, night, DUET_LIMITS.open).all();
  return results;
}
export async function duetBoard(env, venue = DEFAULT_VENUE) {
  try { await ensure(env); return { duets: await boardFor(env, venue, draftNight(nowS(), venue)) }; } catch (e) { return { duets: [] }; }
}

async function lookupSong(env, id) {
  const c = await listSongById(env, id).catch(() => null);
  if (c) return c;
  const p = await env.DB.prepare("SELECT song_id AS id, title, artist FROM plays WHERE song_id = ?1 AND title IS NOT NULL LIMIT 1").bind(id).first();
  return p && p.title ? p : null;
}

export async function handleDuet(req, env, venue = DEFAULT_VENUE) {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const url = new URL(req.url), origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) return json({ error: "Wrong site" }, 403);
  let body; try { body = JSON.parse((await req.text()).slice(0, 2000)); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  const dev = String(body.dev || "").toLowerCase();
  if (!/^[a-f0-9]{16,64}$/.test(dev)) return json({ error: "Reload the page and try again." }, 400);
  await ensure(env);
  const now = nowS(), night = draftNight(now, venue);
  // Same salted, /64-aware network hash as reactions and draft picks (net.js), so an IPv6 phone can't
  // dodge the per-network limit by switching addresses.
  const ipHash = await networkHash(env, req, "duet", new Date().toISOString().slice(0, 10));
  const name = cleanName(body.name);
  const board = () => boardFor(env, venue, night);

  if (body.action === "post") {
    if (!name) return json({ error: "Add your name so your partner can find you." }, 400);
    const song = await lookupSong(env, Number(body.song) || 0);
    if (!song) return json({ error: "Pick a song from the list." }, 400);
    const ins = await env.DB.prepare(`INSERT INTO duets (venue, night, song_id, title, artist, by_name, device_id, ip_hash, created_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
        WHERE (SELECT count(*) FROM duets WHERE venue = ?1 AND night = ?2 AND device_id = ?7 AND removed_at IS NULL) < ?10
          AND (?8 IS NULL OR (SELECT count(*) FROM duets WHERE venue = ?1 AND night = ?2 AND ip_hash = ?8) < ?11)`)
      .bind(venue.slug, night, Number(song.id) || null, String(song.title).slice(0, 200), song.artist ? String(song.artist).slice(0, 200) : null, name, dev, ipHash, now,
        DUET_LIMITS.postsPerPhone, DUET_LIMITS.postsPerIp).run();
    if (!ins.meta.changes) return json({ error: "You already have " + DUET_LIMITS.postsPerPhone + " duets posted tonight. Cancel one first.", duets: await board() }, 429);
    return json({ ok: true, id: ins.meta.last_row_id, duets: await board() });
  }
  const id = Number(body.id) || 0;
  if (body.action === "join") {
    if (!name) return json({ error: "Add your name so your partner can find you." }, 400);
    const r = await env.DB.prepare(`UPDATE duets SET partner = ?1, partner_device = ?2, matched_at = ?3
        WHERE id = ?4 AND venue = ?5 AND night = ?6 AND removed_at IS NULL AND partner IS NULL AND device_id <> ?2`).bind(name, dev, now, id, venue.slug, night).run();
    if (!r.meta.changes) return json({ error: "Someone beat you to it, or it’s your own post.", duets: await board() }, 409);
    return json({ ok: true, duets: await board() });
  }
  if (body.action === "cancel") {
    // The poster takes it down; a partner backing out opens it up again.
    const own = await env.DB.prepare("UPDATE duets SET removed_at = ?1 WHERE id = ?2 AND venue = ?3 AND device_id = ?4 AND removed_at IS NULL").bind(now, id, venue.slug, dev).run();
    if (!own.meta.changes) await env.DB.prepare("UPDATE duets SET partner = NULL, partner_device = NULL, matched_at = NULL WHERE id = ?1 AND venue = ?2 AND partner_device = ?3").bind(id, venue.slug, dev).run();
    return json({ ok: true, duets: await board() });
  }
  return json({ error: "Unknown action" }, 400);
}

export async function hostDuetAction(env, body, venue = DEFAULT_VENUE) {
  await ensure(env);
  if (body.action !== "duet_remove") return { error: "unknown action" };
  await env.DB.prepare("UPDATE duets SET removed_at = ?1 WHERE id = ?2 AND venue = ?3").bind(nowS(), Number(body.id) || 0, venue.slug).run();
  return { ok: true };
}
