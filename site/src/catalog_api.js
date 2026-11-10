// Search KaraFun's song catalog: GET /api/catalog?q=<words>&duo=1&page=<n>
//   -> {ready, songs: [{id, title, artist, year, duo, explicit, styles}], more, count, updated}
//
// The catalog is KaraFun's own published song list (CSV), loaded into the D1 full-text table
// `catalog` once a week by the Worker's cron (catalog_import.js). rowid is KaraFun's song id, the same id as
// plays.song_id. Results are ordered by KaraFun's popularity rank and cached at the edge, so a
// bar full of phones searching costs few D1 reads.
//
// Read only. The search words are turned into a quoted FTS prefix query, so visitors can't send
// FTS syntax, let alone SQL.

const PAGE = 40;
const MAX_PAGE = 10;

// "Don't Stop Believin'" -> ["dont", "stop", "believin"]. Apostrophes, dots and slashes are dropped, which
// matches the catalog's k column (see catalog_import.js); the rest splits like FTS5's unicode61 tokenizer.
export function toTokens(q) {
  return (String(q || "").slice(0, 80).toLowerCase().replace(/['\u2018\u2019`./]/g, "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .match(/[\p{L}\p{N}]+/gu) || []).slice(0, 6);
}

const json = (body, maxAge) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=" + maxAge },
  });

export async function handleCatalog(req, env, ctx) {
  const url = new URL(req.url);
  const tokens = toTokens(url.searchParams.get("q"));
  const duo = url.searchParams.get("duo") === "1";
  const page = Math.min(MAX_PAGE, Math.max(0, parseInt(url.searchParams.get("page"), 10) || 0));
  const key = new Request(url.origin + "/api/catalog?q=" + encodeURIComponent(tokens.join(" ")) + "&duo=" + (duo ? 1 : 0) + "&page=" + page);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;

  const where = [], params = [];
  if (tokens.length) { where.push("catalog MATCH ?"); params.push(tokens.map((t) => '"' + t + '"*').join(" ")); }
  if (duo) where.push("duo = 1");
  const sql = "SELECT rowid AS id, title, artist, year, duo, explicit, styles FROM catalog" +
    (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY pop LIMIT " + (PAGE + 1) + " OFFSET " + page * PAGE;
  let res;
  try {
    const [found, meta] = await env.DB.batch([
      env.DB.prepare(sql).bind(...params),
      env.DB.prepare("SELECT k, v FROM catalog_meta WHERE k IN ('count', 'updated')"),
    ]);
    const m = Object.fromEntries(meta.results.map((r) => [r.k, r.v]));
    const songs = found.results.slice(0, PAGE).map((r) => ({
      id: r.id, title: r.title, artist: r.artist, year: r.year ? Number(r.year) : null,
      duo: Number(r.duo) === 1, explicit: Number(r.explicit) === 1, styles: r.styles || "",
    }));
    const body = { ready: Number(m.count) > 0, songs, more: found.results.length > PAGE && page < MAX_PAGE, count: Number(m.count) || 0, updated: m.updated || null };
    // The list changes at most once a day, so searches can be cached for an hour (the default list longer).
    res = json(body, body.ready ? (tokens.length ? 3600 : 6 * 3600) : 60);
  } catch (e) {
    // No catalog table yet: the first import hasn't finished. The page falls back to songs sung here.
    res = json({ ready: false, songs: [], more: false, count: 0, updated: null }, 60);
  }
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
