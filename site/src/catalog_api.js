import { ensureVoiceTables } from "./voice_import.js";

// Search KaraFun's song catalog:
//   GET /api/catalog?q=<words>&duo=1&hits=1&genre=<style>&lang=<language>&decade=<1980>&voice=m|f|mix&sort=pop|new|recent|old&page=<n>
//   -> {ready, songs: [{id, title, artist, year, duo, explicit, styles}], more, count, updated[, voice: {done, total}]}
// voice filters on the singer (male / female / guy + girl duet), looked up on MusicBrainz by the cron
// (voice_import.js); voice.done/total says how many artists have been looked up so far.
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

// Filters. genre and lang must look like one of KaraFun's style or language names (they're bound
// as LIKE parameters, never put in the SQL). decade: 1950..2020, or 1900 for "before 1950".
const NAME_RE = /^[\p{L}0-9 &'\/-]{2,30}$/u;
const SORTS = {
  pop: "pop",
  new: "added DESC, pop",                                            // newest on KaraFun
  recent: "CAST(year AS INTEGER) DESC, pop",                        // newest songs
  old: "year IS NULL OR year = '', CAST(year AS INTEGER), pop",    // oldest songs
};

export function catalogQuery(params) {
  const tokens = toTokens(params.get("q"));
  const f = {
    duo: params.get("duo") === "1",
    hits: params.get("hits") === "1",
    genre: NAME_RE.test(params.get("genre") || "") ? params.get("genre") : "",
    lang: NAME_RE.test(params.get("lang") || "") ? params.get("lang") : "",
    decade: (() => { const d = parseInt(params.get("decade"), 10); return d === 1900 || (d >= 1950 && d <= 2020 && d % 10 === 0) ? d : 0; })(),
    voice: ["m", "f", "mix"].includes(params.get("voice")) ? params.get("voice") : "",
    sort: SORTS[params.get("sort")] ? params.get("sort") : "pop",
    page: Math.min(MAX_PAGE, Math.max(0, parseInt(params.get("page"), 10) || 0)),
  };
  const where = [], bind = [];
  if (tokens.length) { where.push("catalog MATCH ?"); bind.push(tokens.map((t) => '"' + t + '"*').join(" ")); }
  if (f.duo) where.push("duo = 1");
  if (f.hits) where.push("pop <= 1000");
  if (f.voice) { where.push("artist IN (SELECT artist FROM artist_voice WHERE voice = ?)"); bind.push(f.voice); }
  if (f.genre) { where.push("(',' || styles || ',') LIKE ?"); bind.push("%," + f.genre + ",%"); }
  if (f.lang) { where.push("(',' || languages || ',') LIKE ?"); bind.push("%," + f.lang + ",%"); }
  if (f.decade === 1900) where.push("CAST(year AS INTEGER) BETWEEN 1 AND 1949");
  else if (f.decade) { where.push("CAST(year AS INTEGER) BETWEEN ? AND ?"); bind.push(f.decade, f.decade + 9); }
  const sql = "SELECT rowid AS id, title, artist, year, duo, explicit, styles FROM catalog" +
    (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY " + SORTS[f.sort] + " LIMIT " + (PAGE + 1) + " OFFSET " + f.page * PAGE;
  const key = "q=" + encodeURIComponent(tokens.join(" ")) + "&duo=" + +f.duo + "&hits=" + +f.hits + "&genre=" + encodeURIComponent(f.genre) +
    "&lang=" + encodeURIComponent(f.lang) + "&decade=" + f.decade + "&voice=" + f.voice + "&sort=" + f.sort + "&page=" + f.page;
  return { sql, bind, key, page: f.page, voice: f.voice, filtered: tokens.length > 0 || where.length > 0 };
}

export async function handleCatalog(req, env, ctx) {
  const url = new URL(req.url);
  const cq = catalogQuery(url.searchParams);
  const key = new Request(url.origin + "/api/catalog?" + cq.key);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;

  let res;
  try {
    if (cq.voice) await ensureVoiceTables(env);
    const [found, meta, vc] = await env.DB.batch([
      env.DB.prepare(cq.sql).bind(...cq.bind),
      env.DB.prepare("SELECT k, v FROM catalog_meta WHERE k IN ('count', 'updated')"),
      ...(cq.voice ? [env.DB.prepare("SELECT count(*) AS total, count(voice) AS done FROM artist_voice")] : []),
    ]);
    const m = Object.fromEntries(meta.results.map((r) => [r.k, r.v]));
    const songs = found.results.slice(0, PAGE).map((r) => ({
      id: r.id, title: r.title, artist: r.artist, year: r.year ? Number(r.year) : null,
      duo: Number(r.duo) === 1, explicit: Number(r.explicit) === 1, styles: r.styles || "",
    }));
    const body = { ready: Number(m.count) > 0, songs, more: found.results.length > PAGE && cq.page < MAX_PAGE, count: Number(m.count) || 0, updated: m.updated || null };
    if (vc) body.voice = { done: Number(vc.results[0].done) || 0, total: Number(vc.results[0].total) || 0 };
    // The list changes at most once a week, so results can be cached for hours. Voice results grow
    // while the artists are still being looked up, so those are cached for 10 minutes until it's done.
    const voiceBusy = body.voice && body.voice.done < body.voice.total;
    res = json(body, !body.ready ? 60 : voiceBusy ? 600 : 6 * 3600);
  } catch (e) {
    // No catalog table yet: the first import hasn't finished. The page falls back to songs sung here.
    res = json({ ready: false, songs: [], more: false, count: 0, updated: null }, 60);
  }
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
