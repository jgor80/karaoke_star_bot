// Crowd draft: anyone can draft a singer to sing a song, and the crowd seconds the picks it wants most.
// The site can't touch KaraFun's queue, so a draft is a public request. The host or the singer makes it happen,
// and once the drafted singer sings that song it shows as delivered (worked out on the page from plays).
//
// POST /api/draft {action: "pick", singer, song, dev, name}  -> {ok, draft_id, board}  (song = KaraFun song id)
// POST /api/draft {action: "vote" | "unvote", id, dev}       -> {ok, board}
// draftBoard(env, venue)                                     -> {draft_night, drafts} folded into /api/plays
// hostDraftAction(env, body, venue)                          -> remove a pick / block a name (from /api/host, host key checked there)
//
// Rules that keep it friendly:
// - Only people who have sung here before can be drafted (no typing a stranger's name), and the host can
//   block a name from being drafted at all.
// - The song comes from KaraFun's catalog (or songs sung here) by id, so nobody types free text into a pick.
// - Limits per phone, per network and per singer (see LIMITS). Device ids and IP hashes are only used for limits.
import { scheduleStatus, SCHEDULE } from "./schedule.js";
import { cleanName } from "./reactions_api.js";
import { DEFAULT_VENUE, cfgKey, ensureVenueColumn } from "./venues.js";

export const LIMITS = {
  picksPerPhone: 3,     // drafts one phone can make per night
  picksPerIp: 40,       // per network per night (the bar wifi is shared)
  perSinger: 6,         // open drafts on one singer per night, so nobody gets buried
  votesPerIp: 400,      // seconds per network per night
  boardSize: 60,
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS drafts (
    id integer primary key autoincrement,
    night text not null, singer text not null, singer_key text not null,
    song_id integer, title text not null, artist text,
    by_name text not null, device_id text not null, ip_hash text,
    created_at integer not null, removed_at integer, venue text not null default 'wbl')`,
  "CREATE INDEX IF NOT EXISTS drafts_night on drafts(night)",
  `CREATE TABLE IF NOT EXISTS draft_votes (
    draft_id integer not null, device_id text not null, ip_hash text, night text not null, created_at integer not null,
    primary key (draft_id, device_id))`,
  "CREATE INDEX IF NOT EXISTS draft_votes_ip on draft_votes(ip_hash, night)",
];
let ready = null; // one CREATE ... IF NOT EXISTS per Worker instance, so no manual migration is needed
function ensure(env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).then(() => ensureVenueColumn(env, "drafts")).catch((e) => { ready = null; throw e; });
  return ready;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const nowS = () => Math.floor(Date.now() / 1000);
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Same matching as KaraokeFun's canonicalize on the page: lower case, letters and digits only.
export const singerKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Drafts belong to a karaoke night, named like plays.night (the Central date the session starts on).
// During a session (and its overtime) that's tonight; between sessions picks go toward the next one.
export function draftNight(ts = nowS(), sch = SCHEDULE) {
  const s = scheduleStatus(ts, sch);
  const at = s.status === "off" ? s.next_start : s.session_start;
  return new Intl.DateTimeFormat("en-CA", { timeZone: sch.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at * 1000));
}

async function blockedKeys(env, venue) {
  try {
    const r = await env.DB.prepare("SELECT v FROM host_config WHERE k = ?").bind(cfgKey(venue, "draft_blocked")).first();
    const v = r ? JSON.parse(r.v) : [];
    return new Set(Array.isArray(v) ? v : []);
  } catch (e) { return new Set(); }
}

// The board for one night: live picks with their seconds, most seconded first.
async function boardFor(env, venue, night) {
  const r = await env.DB.prepare(
    `SELECT d.id, d.singer, d.song_id, d.title, d.artist, d.by_name AS by, d.created_at,
            (SELECT count(*) FROM draft_votes v WHERE v.draft_id = d.id) AS votes
     FROM drafts d WHERE d.night = ?1 AND d.venue = ?3 AND d.removed_at IS NULL
     ORDER BY votes DESC, d.created_at LIMIT ?2`).bind(night, LIMITS.boardSize, venue.slug).all();
  return r.results.map((x) => ({ ...x, votes: Number(x.votes) || 0 }));
}

// For /api/plays (cached at the edge): the current draft night's board.
export async function draftBoard(env, venue = DEFAULT_VENUE) {
  const night = draftNight(nowS(), venue);
  try {
    await ensure(env);
    return { draft_night: night, drafts: await boardFor(env, venue, night) };
  } catch (e) {
    return { draft_night: night, drafts: [] };
  }
}

async function lookupSong(env, id) {
  // KaraFun's catalog first (rowid = KaraFun song id), then songs sung here in case the catalog isn't loaded.
  try {
    const c = await env.DB.prepare("SELECT rowid AS id, title, artist FROM catalog WHERE rowid = ?1").bind(id).first();
    if (c && c.title) return c;
  } catch (e) { /* no catalog table yet */ }
  const p = await env.DB.prepare("SELECT song_id AS id, title, artist FROM plays WHERE song_id = ?1 AND title IS NOT NULL LIMIT 1").bind(id).first();
  return p && p.title ? p : null;
}

async function knownSinger(env, venue, key) {
  // Every name ever typed into KaraFun, matched loosely, so "bleacher jeff" finds "Bleacher Jeff".
  const { results } = await env.DB.prepare("SELECT singer, count(*) AS n FROM plays WHERE singer IS NOT NULL AND venue = ?1 GROUP BY singer").bind(venue.slug).all();
  const hits = results.filter((r) => singerKey(r.singer) === key).sort((a, b) => b.n - a.n);
  return hits.length ? cleanName(hits[0].singer) : null;
}

export async function handleDraft(req, env, venue = DEFAULT_VENUE) {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) return json({ error: "Wrong site" }, 403);
  if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ error: "Send JSON" }, 415);
  let body;
  try { body = JSON.parse((await req.text()).slice(0, 2000)); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  const dev = String(body.dev || "").toLowerCase();
  if (!/^[a-f0-9]{16,64}$/.test(dev)) return json({ error: "Reload the page and try again." }, 400);

  await ensure(env);
  const now = nowS(), night = draftNight(now, venue);
  const ip = req.headers.get("cf-connecting-ip") || "";
  const ipHash = ip ? (await sha("oke-night|" + ip + "|" + new Date().toISOString().slice(0, 10))).slice(0, 24) : null;

  if (body.action === "vote" || body.action === "unvote") {
    const id = Number(body.id) || 0;
    const d = await env.DB.prepare("SELECT id, night FROM drafts WHERE id = ?1 AND venue = ?2 AND removed_at IS NULL").bind(id, venue.slug).first();
    if (!d || d.night !== night) return json({ error: "That pick is gone.", board: await boardFor(env, venue, night) }, 404);
    if (body.action === "unvote") {
      await env.DB.prepare("DELETE FROM draft_votes WHERE draft_id = ?1 AND device_id = ?2").bind(id, dev).run();
    } else {
      // The limit check and the insert are one statement, so a burst can't slip past the limit together.
      const ins = await env.DB.prepare(`INSERT OR IGNORE INTO draft_votes (draft_id, device_id, ip_hash, night, created_at)
          SELECT ?1, ?2, ?3, ?4, ?5
          WHERE (?3 IS NULL OR (SELECT count(*) FROM draft_votes WHERE ip_hash = ?3 AND night = ?4) < ?6)`)
        .bind(id, dev, ipHash, night, now, LIMITS.votesPerIp).run();
      if (!ins.meta.changes) {
        const had = await env.DB.prepare("SELECT 1 FROM draft_votes WHERE draft_id = ?1 AND device_id = ?2").bind(id, dev).first();
        if (!had) return json({ error: "Too many votes from this network tonight." }, 429);
      }
    }
    return json({ ok: true, board: await boardFor(env, venue, night) });
  }

  if (body.action !== "pick") return json({ error: "Unknown action" }, 400);
  const key = singerKey(body.singer);
  const songId = Number(body.song) || 0;
  if (!key || !songId) return json({ error: "Pick a singer and a song." }, 400);
  if ((await blockedKeys(env, venue)).has(key)) return json({ error: "That singer can’t be drafted. Pick someone else!" }, 403);
  const singer = await knownSinger(env, venue, key);
  if (!singer) return json({ error: "Only people who’ve sung here can be drafted." }, 400);
  const song = await lookupSong(env, songId);
  if (!song) return json({ error: "Couldn’t find that song." }, 400);

  // Already drafted? Then this counts as a second for it instead of a new pick.
  const dup = await env.DB.prepare("SELECT id FROM drafts WHERE night = ?1 AND singer_key = ?2 AND song_id = ?3 AND venue = ?4 AND removed_at IS NULL").bind(night, key, songId, venue.slug).first();
  if (dup) {
    await env.DB.prepare("INSERT OR IGNORE INTO draft_votes (draft_id, device_id, ip_hash, night, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(dup.id, dev, ipHash, night, now).run();
    return json({ ok: true, draft_id: dup.id, dup: true, board: await boardFor(env, venue, night) });
  }

  const by = cleanName(body.name) || "Anon " + (await sha(dev)).slice(0, 4).toUpperCase();
  const ins = await env.DB.prepare(`INSERT INTO drafts (night, singer, singer_key, song_id, title, artist, by_name, device_id, ip_hash, created_at, venue)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?14
      WHERE (SELECT count(*) FROM drafts WHERE night = ?1 AND venue = ?14 AND device_id = ?8) < ?11
        AND (?9 IS NULL OR (SELECT count(*) FROM drafts WHERE night = ?1 AND venue = ?14 AND ip_hash = ?9) < ?12)
        AND (SELECT count(*) FROM drafts WHERE night = ?1 AND venue = ?14 AND singer_key = ?3 AND removed_at IS NULL) < ?13`)
    .bind(night, singer, key, songId, String(song.title).slice(0, 200), song.artist ? String(song.artist).slice(0, 200) : null, by, dev, ipHash, now,
      LIMITS.picksPerPhone, LIMITS.picksPerIp, LIMITS.perSinger, venue.slug).run();
  if (!ins.meta.changes) {
    const c = await env.DB.prepare(`SELECT
        (SELECT count(*) FROM drafts WHERE night = ?1 AND venue = ?4 AND device_id = ?2) AS mine,
        (SELECT count(*) FROM drafts WHERE night = ?1 AND venue = ?4 AND singer_key = ?3 AND removed_at IS NULL) AS singer`).bind(night, dev, key, venue.slug).first();
    if (c.mine >= LIMITS.picksPerPhone) return json({ error: "You’ve used your " + LIMITS.picksPerPhone + " draft picks tonight. You can still second other picks!" }, 429);
    if (c.singer >= LIMITS.perSinger) return json({ error: singer + " already has " + LIMITS.perSinger + " picks waiting. Second one of those instead!" }, 429);
    return json({ error: "Too many picks from this network tonight." }, 429);
  }
  const id = ins.meta.last_row_id;
  // The drafter seconds their own pick, so it starts at 1.
  await env.DB.prepare("INSERT OR IGNORE INTO draft_votes (draft_id, device_id, ip_hash, night, created_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, dev, ipHash, night, now).run();
  return json({ ok: true, draft_id: id, board: await boardFor(env, venue, night) });
}

// Host tools, called from handleHost after the host key is checked.
//   draft_remove {id}         take a pick off the board
//   draft_block {singer}      remove their picks tonight and stop anyone drafting them
//   draft_unblock {singer}
export async function hostDraftAction(env, body, venue = DEFAULT_VENUE) {
  await ensure(env);
  const now = nowS();
  if (body.action === "draft_remove") {
    await env.DB.prepare("UPDATE drafts SET removed_at = ?1 WHERE id = ?2 AND venue = ?3").bind(now, Number(body.id) || 0, venue.slug).run();
    return { ok: true };
  }
  const key = singerKey(body.singer);
  if (!key) return { error: "Which singer?" };
  const set = await blockedKeys(env, venue);
  if (body.action === "draft_block") { set.add(key); await env.DB.prepare("UPDATE drafts SET removed_at = ?1 WHERE singer_key = ?2 AND night = ?3 AND venue = ?4 AND removed_at IS NULL").bind(now, key, draftNight(now, venue), venue.slug).run(); }
  else if (body.action === "draft_unblock") set.delete(key);
  else return { error: "unknown action" };
  await env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES (?, ?)").bind(cfgKey(venue, "draft_blocked"), JSON.stringify([...set].slice(0, 500))).run();
  return { ok: true };
}
