// okenight.com: the intro page (/), the venue list (/api/venues), and for each venue in venues.js its phone
// page (/<slug>/), TV screen (/<slug>/tv), host page (/<slug>/host) and API (/<slug>/api/...): read-only stats
// JSON, song catalog search (catalog_api.js) and live emoji reactions.
// Old single-bar links (/tv, /host, /sunday.ics) redirect to the first venue, and /api/... without a venue
// still means the first venue, so pages already open on phones keep working.
// All SQL is fixed statements with bound values: visitors can't send queries. The only thing they can
// write is a reaction to the song on the mic, which is rate limited (see reactions_api.js), and crowd
// draft picks and seconds, also rate limited (see drafts_api.js).
// The host's phone can also send crowd noise levels for the applause meter (crowd_api.js, host key only).
// The host (with the host key) can also hide secret songs (see secrets_api.js and /host).
import PAGE from "./index.html";
import HOME from "./home.html";
import { VENUES, DEFAULT_VENUE, venueBySlug, publicVenue, ensureVenueColumns } from "./venues.js";
import { handleLead } from "./leads_api.js";
import BINGO from "./bingo.js"; // imported as text, see [[rules]] in wrangler.toml
import FUN from "./fun.js";
import { scheduleStatus, localStampToUnix } from "./schedule.js";
import AWARDS from "./awards.js";
import TV from "./tv.html";
import { handleReact, handleCounts, reactionTotals } from "./reactions_api.js";
import { handleHost, checkSecrets, publicSecrets } from "./secrets_api.js";
import HOST from "./host.html";
import SONGS from "./songs.js";
import { handleCatalog } from "./catalog_api.js";
import { handleArt, handleListen } from "./art_api.js";
import ART from "./art.js";
import { maybeImportCatalog } from "./catalog_import.js";
import { updateVoices } from "./voice_import.js";
import { handleRequest } from "./requests_api.js";
import { handleCrowd, scoreCrowd, publicCrowd } from "./crowd_api.js";
import { handleDraft, draftBoard } from "./drafts_api.js";
import DRAFTS from "./drafts.js";
import { reminderLinks, sundayIcs, sendCrowdReminder } from "./reminders.js";

const PLAYS_SQL =
  "SELECT uuid, night, played_at, singer, song_id, artist, title, release_year, length_s FROM plays WHERE venue = ?1 ORDER BY played_at";
const SYNC_SQL = "SELECT max(ran_at) AS last FROM sync_runs WHERE venue = ?1";
// The karaoke app's song queue, one row per venue replaced by that bar's laptop sync each time it changes
// (sync/karaoke_sync.py). items is a JSON list of {id: song id, singer, len: seconds or null}, the song on the
// mic first once it starts. The first venue's row is id 1 (written before venues existed).
const QUEUE_TABLE =
  "CREATE TABLE IF NOT EXISTS live_queue (id integer primary key, updated_at integer not null, items text not null)";
const QUEUE_SQL = "SELECT updated_at, items FROM live_queue WHERE venue = ?1 ORDER BY updated_at DESC LIMIT 1";
let queueReady = null; // one CREATE ... IF NOT EXISTS per Worker instance, so no manual migration is needed
async function liveQueue(env, venue) {
  try {
    if (!queueReady) queueReady = env.DB.prepare(QUEUE_TABLE).run().then(() => ensureVenueColumns(env, ["live_queue"])).catch((e) => { queueReady = null; throw e; });
    await queueReady;
    const row = await env.DB.prepare(QUEUE_SQL).bind(venue.slug).first();
    if (!row) return { queue: null };
    const items = JSON.parse(row.items);
    return { queue: { updated_at: row.updated_at, items: Array.isArray(items) ? items : [] } };
  } catch (e) {
    return { queue: null }; // the stats still load if the queue can't be read
  }
}

// Tables the laptop sync writes, made before venues existed: give them the venue column (default = first venue).
const ensureCore = (env) => ensureVenueColumns(env, ["plays", "sync_runs"]);

const html = (body, cache = "public, max-age=60", extra = {}) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache, ...extra } });
const js = (body) => new Response(body, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
const STATIC_JS = { "/bingo.js": BINGO, "/fun.js": FUN, "/songs.js": SONGS, "/drafts.js": DRAFTS, "/art.js": ART, "/awards.js": AWARDS };

// Each venue page gets its venue as a global, so the page can say where it is before /api/plays loads.
const withVenue = (page, venue) =>
  page.replace("<head>", "<head>\n<script>window.OKE_VENUE = " + JSON.stringify(publicVenue(venue)).replace(/</g, "\\u003c") + ";</script>");

// The venue list for the intro page's picker and the app, with whether each one is on tonight.
function venueList() {
  const now = Math.floor(Date.now() / 1000);
  return VENUES.map((v) => { const s = scheduleStatus(now, v); return { ...publicVenue(v), status: s.status, next_start: s.next_start, next_label: s.next_label }; });
}

// /<slug>/api/<name> and the old /api/<name> (= first venue).
async function handleApi(name, req, env, ctx, venue, url) {
  if (name === "react") {
    if (req.method !== "POST") return new Response("POST only", { status: 405 });
    await ensureCore(env);
    return handleReact(req, env, venue);
  }
  if (name === "draft") {
    if (req.method !== "POST") return new Response("POST only", { status: 405 });
    await ensureCore(env);
    return handleDraft(req, env, venue);
  }
  if (name === "host") { await ensureCore(env); return handleHost(req, env, venue); }
  if (name === "crowd") { await ensureCore(env); return handleCrowd(req, env, venue); } // the /host phone's crowd meter (host key only)
  if (name === "request") return handleRequest(req, env, ctx, venue); // song requests for the host, see requests_api.js
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Read only", { status: 405 });
  if (name === "reactions") return handleCounts(req, env, ctx);
  if (name === "catalog") return handleCatalog(req, env, ctx, venue); // the venue picks its songbook (songbook_api.js)
  if (name === "art") return handleArt(req, env, ctx); // album covers, see art_api.js
  if (name === "listen") return handleListen(req, env); // tap a cover: the song at its source
  if (name === "plays") {
    // Cached briefly at the edge so a full bar refreshing costs a few D1 reads a minute.
    // During the scheduled session the cache is shorter so new songs show up fast.
    const now = Math.floor(Date.now() / 1000);
    const schedule = { ...scheduleStatus(now, venue), reminder: reminderLinks(now, venue) };
    const maxAge = schedule.status === "off" ? 15 : 5;
    const cache = caches.default;
    const key = new Request(url.origin + "/" + venue.slug + "/api/plays");
    let res = await cache.match(key);
    if (!res) {
      await ensureCore(env);
      await checkSecrets(env, venue).catch(() => {}); // a new song may have found a secret: mark it before reading
      const [[plays, sync], reax, secrets, queue, drafts, crowd] = await Promise.all([
        env.DB.batch([env.DB.prepare(PLAYS_SQL).bind(venue.slug), env.DB.prepare(SYNC_SQL).bind(venue.slug)]),
        reactionTotals(env, venue), publicSecrets(env, venue), liveQueue(env, venue), draftBoard(env, venue), publicCrowd(env, venue)]);
      res = new Response(
        JSON.stringify({ venue: publicVenue(venue), plays: plays.results, last_sync: sync.results[0]?.last || null, last_sync_ts: localStampToUnix(sync.results[0]?.last, venue), served_at: now, schedule, ...reax, ...secrets, ...queue, ...drafts, ...crowd }),
        { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=" + maxAge } }
      );
      ctx.waitUntil(cache.put(key, res.clone()));
    }
    return res;
  }
  return new Response("Not found", { status: 404 });
}

// Pages and files under /<slug>/.
function handleVenue(rest, req, env, ctx, venue, url) {
  if (rest === "" || rest === "index.html") return html(withVenue(PAGE, venue));
  if (rest === "tv" || rest === "tv/") return html(withVenue(TV, venue));
  if (rest === "host" || rest === "host/") return html(withVenue(HOST, venue), "no-store", { "x-robots-tag": "noindex" });
  if (rest === "sunday.ics" || rest === "calendar.ics") {
    return new Response(sundayIcs(Math.floor(Date.now() / 1000), venue), {
      headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="oke-night-' + venue.slug + '.ics"', "cache-control": "public, max-age=3600" },
    });
  }
  if (rest.startsWith("api/")) return handleApi(rest.slice(4), req, env, ctx, venue, url);
  if (STATIC_JS["/" + rest]) return js(STATIC_JS["/" + rest]); // a script asked for relative to the venue page
  return new Response("Not found", { status: 404 });
}

const LEGACY = { "/tv": "tv", "/tv/": "tv", "/host": "host", "/host/": "host", "/index.html": "" };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/") return html(HOME.replace("/*VENUES*/[]", JSON.stringify(venueList()).replace(/</g, "\\u003c")), "public, max-age=300");
    if (path === "/api/venues") {
      return new Response(JSON.stringify({ venues: venueList() }), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
      });
    }
    if (path === "/api/lead") return handleLead(req, env, ctx); // "bring Oke Night to your bar" form on the intro page
    if (path.startsWith("/api/")) return handleApi(path.slice(5), req, env, ctx, DEFAULT_VENUE, url); // old links = first venue
    if (STATIC_JS[path]) return js(STATIC_JS[path]);
    // Calendar apps that subscribed to the old link poll it; serve it instead of redirecting.
    if (path === "/sunday.ics") return handleVenue("sunday.ics", req, env, ctx, DEFAULT_VENUE, url);
    if (path in LEGACY) return Response.redirect(url.origin + "/" + DEFAULT_VENUE.slug + "/" + LEGACY[path] + url.search + url.hash, 301);

    const m = /^\/([a-z0-9-]+)(\/(.*))?$/.exec(path);
    const venue = m && venueBySlug(m[1]);
    if (venue) {
      if (m[2] === undefined) return Response.redirect(url.origin + "/" + venue.slug + "/" + url.search, 301); // /wbl -> /wbl/
      return handleVenue(m[3], req, env, ctx, venue, url);
    }
    return new Response("Not found", { status: 404 });
  },
  // Every minute, for every venue: catch secret songs even when no phone or TV is open, so the host still
  // gets the push; score the applause after songs that just ended; and send the "karaoke tonight" heads-up.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureCore(env);
      for (const v of VENUES) {
        await checkSecrets(env, v).catch(() => {});
        await scoreCrowd(env, v).catch(() => {}); // crowd meter
        await sendCrowdReminder(env, undefined, v).catch(() => {}); // heads-up to the venue's ntfy topic
      }
    })().catch(() => {}));
    // Weekly: refresh the song catalog for the Songbook (no-op unless due, see catalog_import.js).
    ctx.waitUntil(maybeImportCatalog(env).catch(() => {}));
    // Songbook voice filters: look up a few more singers on MusicBrainz (see voice_import.js).
    ctx.waitUntil(updateVoices(env).catch(() => {}));
  },
};
