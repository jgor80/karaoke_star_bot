// Serves the phone page and one read-only JSON endpoint.
// The only SQL here is fixed SELECTs: visitors can't send queries or write anything.
import PAGE from "./index.html";
import BINGO from "./bingo.js"; // imported as text, see [[rules]] in wrangler.toml
import FUN from "./fun.js";
import { scheduleStatus } from "./schedule.js";

const PLAYS_SQL =
  "SELECT night, played_at, singer, artist, title, release_year, length_s FROM plays ORDER BY played_at";
const SYNC_SQL = "SELECT max(ran_at) AS last FROM sync_runs";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Read only", { status: 405 });

    if (url.pathname === "/api/plays") {
      // Cached briefly at the edge so a full bar refreshing costs a few D1 reads a minute.
      // During the scheduled session the cache is shorter so new songs show up fast.
      const schedule = scheduleStatus(Math.floor(Date.now() / 1000));
      const maxAge = schedule.status === "off" ? 15 : 5;
      const cache = caches.default;
      const key = new Request(url.origin + "/api/plays");
      let res = await cache.match(key);
      if (!res) {
        const [plays, sync] = await env.DB.batch([env.DB.prepare(PLAYS_SQL), env.DB.prepare(SYNC_SQL)]);
        res = new Response(
          JSON.stringify({ plays: plays.results, last_sync: sync.results[0]?.last || null, served_at: Math.floor(Date.now() / 1000), schedule }),
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
    if (url.pathname === "/bingo.js") {
      return new Response(BINGO, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
    }
    if (url.pathname === "/fun.js") {
      return new Response(FUN, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
    }
    return new Response("Not found", { status: 404 });
  },
};
