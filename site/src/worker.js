// Serves the phone page, the TV screen (/tv), the read-only stats JSON and live emoji reactions.
// All SQL is fixed statements with bound values: visitors can't send queries. The only thing they can
// write is a reaction to the song on the mic, which is rate limited (see reactions_api.js).
import PAGE from "./index.html";
import BINGO from "./bingo.js"; // imported as text, see [[rules]] in wrangler.toml
import FUN from "./fun.js";
import { scheduleStatus, localStampToUnix } from "./schedule.js";
import AWARDS from "./awards.js";
import TV from "./tv.html";
import { handleReact, handleCounts, reactionTotals } from "./reactions_api.js";

const PLAYS_SQL =
  "SELECT uuid, night, played_at, singer, artist, title, release_year, length_s FROM plays ORDER BY played_at";
const SYNC_SQL = "SELECT max(ran_at) AS last FROM sync_runs";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/react") {
      if (req.method !== "POST") return new Response("POST only", { status: 405 });
      return handleReact(req, env);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Read only", { status: 405 });
    if (url.pathname === "/api/reactions") return handleCounts(req, env, ctx);

    if (url.pathname === "/api/plays") {
      // Cached briefly at the edge so a full bar refreshing costs a few D1 reads a minute.
      // During the scheduled session the cache is shorter so new songs show up fast.
      const schedule = scheduleStatus(Math.floor(Date.now() / 1000));
      const maxAge = schedule.status === "off" ? 15 : 5;
      const cache = caches.default;
      const key = new Request(url.origin + "/api/plays");
      let res = await cache.match(key);
      if (!res) {
        const [[plays, sync], reax] = await Promise.all([env.DB.batch([env.DB.prepare(PLAYS_SQL), env.DB.prepare(SYNC_SQL)]), reactionTotals(env)]);
        res = new Response(
          JSON.stringify({ plays: plays.results, last_sync: sync.results[0]?.last || null, last_sync_ts: localStampToUnix(sync.results[0]?.last), served_at: Math.floor(Date.now() / 1000), schedule, ...reax }),
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
    if (url.pathname === "/awards.js") {
      return new Response(AWARDS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
    }
    return new Response("Not found", { status: 404 });
  },
};
