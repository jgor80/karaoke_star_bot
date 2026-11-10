// Serves the phone page, the TV screen (/tv), the read-only stats JSON, KaraFun catalog search
// (/api/catalog, see catalog_api.js) and live emoji reactions.
// All SQL is fixed statements with bound values: visitors can't send queries. The only thing they can
// write is a reaction to the song on the mic, which is rate limited (see reactions_api.js).
// The host's phone can also send crowd noise levels for the applause meter (crowd_api.js, host key only).
// The host (with the host key) can also hide secret songs (see secrets_api.js and /host).
import PAGE from "./index.html";
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
import { maybeImportCatalog } from "./catalog_import.js";
import { handleCrowd, scoreCrowd, publicCrowd } from "./crowd_api.js";
import { reminderLinks, sundayIcs, sendCrowdReminder } from "./reminders.js";

const PLAYS_SQL =
  "SELECT uuid, night, played_at, singer, song_id, artist, title, release_year, length_s FROM plays ORDER BY played_at";
const SYNC_SQL = "SELECT max(ran_at) AS last FROM sync_runs";
// KaraFun's song queue, one row replaced by the laptop's sync each time it changes (sync/karaoke_sync.py).
// items is a JSON list of {id: song id, singer, len: seconds or null}, the song on the mic first once it starts.
const QUEUE_TABLE =
  "CREATE TABLE IF NOT EXISTS live_queue (id integer primary key, updated_at integer not null, items text not null)";
const QUEUE_SQL = "SELECT updated_at, items FROM live_queue WHERE id = 1";
let queueReady = null; // one CREATE ... IF NOT EXISTS per Worker instance, so no manual migration is needed
async function liveQueue(env) {
  try {
    if (!queueReady) queueReady = env.DB.prepare(QUEUE_TABLE).run().catch((e) => { queueReady = null; throw e; });
    await queueReady;
    const row = await env.DB.prepare(QUEUE_SQL).first();
    if (!row) return { queue: null };
    const items = JSON.parse(row.items);
    return { queue: { updated_at: row.updated_at, items: Array.isArray(items) ? items : [] } };
  } catch (e) {
    return { queue: null }; // the stats still load if the queue can't be read
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/react") {
      if (req.method !== "POST") return new Response("POST only", { status: 405 });
      return handleReact(req, env);
    }
    if (url.pathname === "/api/host") return handleHost(req, env);
    if (url.pathname === "/api/crowd") return handleCrowd(req, env); // the /host phone's crowd meter (host key only)
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Read only", { status: 405 });
    if (url.pathname === "/api/reactions") return handleCounts(req, env, ctx);
    if (url.pathname === "/api/catalog") return handleCatalog(req, env, ctx);

    if (url.pathname === "/api/plays") {
      // Cached briefly at the edge so a full bar refreshing costs a few D1 reads a minute.
      // During the scheduled session the cache is shorter so new songs show up fast.
      const schedule = { ...scheduleStatus(Math.floor(Date.now() / 1000)), reminder: reminderLinks(Math.floor(Date.now() / 1000)) };
      const maxAge = schedule.status === "off" ? 15 : 5;
      const cache = caches.default;
      const key = new Request(url.origin + "/api/plays");
      let res = await cache.match(key);
      if (!res) {
        await checkSecrets(env).catch(() => {}); // a new song may have found a secret: mark it before reading
        const [[plays, sync], reax, secrets, queue, crowd] = await Promise.all([env.DB.batch([env.DB.prepare(PLAYS_SQL), env.DB.prepare(SYNC_SQL)]), reactionTotals(env), publicSecrets(env), liveQueue(env), publicCrowd(env)]);
        res = new Response(
          JSON.stringify({ plays: plays.results, last_sync: sync.results[0]?.last || null, last_sync_ts: localStampToUnix(sync.results[0]?.last), served_at: Math.floor(Date.now() / 1000), schedule, ...reax, ...secrets, ...queue, ...crowd }),
          { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=" + maxAge } }
        );
        ctx.waitUntil(cache.put(key, res.clone()));
      }
      return res;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    }
    if (url.pathname === "/sunday.ics") {
      return new Response(sundayIcs(Math.floor(Date.now() / 1000)), {
        headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="oke-night-sundays.ics"', "cache-control": "public, max-age=3600" },
      });
    }
    if (url.pathname === "/host" || url.pathname === "/host/") {
      return new Response(HOST, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
      });
    }
    if (url.pathname === "/tv" || url.pathname === "/tv/") {
      return new Response(TV, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    }
    if (url.pathname === "/bingo.js") {
      return new Response(BINGO, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
    }
    if (url.pathname === "/fun.js") {
      return new Response(FUN, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
    }
    if (url.pathname === "/songs.js") {
      return new Response(SONGS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
    }
    if (url.pathname === "/awards.js") {
      return new Response(AWARDS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
    }
    return new Response("Not found", { status: 404 });
  },
  // Every minute: catch secret songs even when no phone or TV is open, so the host still gets the push.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkSecrets(env));
    // Weekly: refresh KaraFun's song catalog for the Songbook (no-op unless due, see catalog_import.js).
    ctx.waitUntil(maybeImportCatalog(env).catch(() => {}));
    ctx.waitUntil(scoreCrowd(env).catch(() => {})); // crowd meter: score the applause after songs that just ended
    ctx.waitUntil(sendCrowdReminder(env).catch(() => {})); // Sunday heads-up to the crowd's ntfy topic
  },
};
