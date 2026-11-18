// The Oke Night league: one monthly table across every bar on the site (okenight.com/league).
//
// GET /api/league?month=YYYY-MM -> {month, months, venues: [{slug, name, host}], plays: [[venue, night, singer, played_at, crowd, hype]]}
// Scoring happens on the page (league.html) so names can be merged the same way as everywhere else (fun.js).
// crowd = applause score 0-10 for that song (crowd_api.js), hype = how many phones sent a hype reaction.
import { VENUES, venueConfig } from "./venues.js";
import { withCacheControl } from "./net.js";
import { erasedSingers, relabel } from "./privacy_api.js";

const MONTH_RE = /^\d{4}-\d{2}$/;
const HYPE = ["fire", "micdrop", "encore", "chills", "dance", "keychange"]; // same as OkeAwards.HYPE

export async function handleLeague(req, env, ctx, url) {
  const cache = caches.default;
  const asked = url.searchParams.get("month");
  // No month = the latest one, cached under its own key so the page's first load doesn't scan every play either.
  const firstKey = new Request(url.origin + "/api/league?month=" + (asked && MONTH_RE.test(asked) ? asked : "latest"));
  const first = await cache.match(firstKey).catch(() => null);
  if (first) return withCacheControl(first, "public, max-age=120");
  const months = (await env.DB.prepare("SELECT DISTINCT substr(night, 1, 7) AS m FROM plays WHERE night IS NOT NULL ORDER BY m DESC").all()).results.map((r) => r.m);
  const want = url.searchParams.get("month");
  const month = want && MONTH_RE.test(want) ? want : months[0] || new Date().toISOString().slice(0, 7);
  const key = new Request(url.origin + "/api/league?month=" + month);
  let res = await cache.match(key);
  if (res) return withCacheControl(res, "public, max-age=120");
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results).catch(() => []);
  const [plays, crowd, hype] = await Promise.all([
    q("SELECT uuid, venue, night, singer, played_at FROM plays WHERE night >= ?1 AND night < ?2 ORDER BY played_at", month + "-01", month + "-32"),
    q("SELECT s.uuid, s.over FROM crowd_scores s JOIN plays p ON p.uuid = s.uuid WHERE s.over IS NOT NULL AND p.night >= ?1 AND p.night < ?2", month + "-01", month + "-32"),
    q("SELECT play_uuid AS uuid, count(DISTINCT device_id) AS n FROM reactions WHERE night >= ?1 AND night < ?2 AND reaction IN (" + HYPE.map(() => "?").join(",") + ") GROUP BY play_uuid", month + "-01", month + "-32", ...HYPE),
  ]);
  const cBy = new Map(crowd.map((c) => [c.uuid, Math.round(Math.max(0, Math.min(10, Number(c.over) / 2.5)) * 10) / 10]));
  const hBy = new Map(hype.map((h) => [h.uuid, Number(h.n) || 0]));
  // Singers who asked to be removed show as their label here too, per bar (privacy_api.js).
  const erasedBy = new Map(await Promise.all(VENUES.map(async (v) => [v.slug, await erasedSingers(env, v).catch(() => [])])));
  const shown = (p) => { const l = erasedBy.get(p.venue || VENUES[0].slug) || []; return l.length ? relabel(l, p.singer) : p.singer; };
  const venues = await Promise.all(VENUES.map(async (v) => {
    const cfg = await venueConfig(env, v).catch(() => ({}));
    return { slug: v.slug, name: v.name, neighborhood: v.neighborhood, host: cfg.host_name === undefined ? v.host_default || "" : cfg.host_name };
  }));
  const body = { month, months: months.length ? months : [month], venues,
    plays: plays.filter((p) => p.singer).map((p) => [p.venue || VENUES[0].slug, p.night, shown(p), Number(p.played_at), cBy.get(p.uuid) ?? null, hBy.get(p.uuid) || 0]) };
  res = new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=120" } });
  ctx.waitUntil(cache.put(key, res.clone()));
  if (firstKey.url !== key.url) ctx.waitUntil(cache.put(firstKey, res.clone()));
  return res;
}
