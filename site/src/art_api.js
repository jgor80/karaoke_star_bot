// Album covers for songs:
//   GET /api/art?id=<KaraFun song id>&t=<title>[&s=big]  -> 302 to a cover image, or 404 when there's none
//
// KaraFun's catalog has no artwork, so covers come from free music search APIs: Deezer first, then
// Apple's iTunes Search API. Each song is looked up once, the first time a phone shows it, and the
// answer (including "no cover") is saved in D1 table song_art. Repeat requests are answered from the
// edge cache or D1, so a bar full of phones never hits Deezer or Apple for the same song twice.
//
// Visitors only send a song id and a title; the artist and title we search for come from our own
// catalog/plays tables, so the endpoint can't be used to make arbitrary lookups. t is there because
// KaraFun community songs share the id space with catalog songs: it picks the right one.

const TABLE =
  "CREATE TABLE IF NOT EXISTS song_art (id integer not null, tk text not null, url text, src text," +
  " checked integer not null, primary key (id, tk))";
const NO_COVER_RETRY_S = 30 * 86400; // try songs without a cover again after a month

let ready = null;
function ensureTable(env) {
  if (!ready) ready = env.DB.prepare(TABLE).run().catch((e) => { ready = null; throw e; });
  return ready;
}

// "Don't Stop Believin'" -> "dontstopbelievin". Same as normTitle in art.js, so URLs match and cache well.
export const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 60);

// Drop "(Live)", "[Remastered]", "- Radio Edit" and featured artists so the search finds the original.
const plainTitle = (t) => String(t || "").replace(/\s*[([].*?[)\]]/g, "").replace(/\s+-\s+.*$/, "").trim() || String(t || "");
const mainArtist = (a) => String(a || "").split(/\s+(?:feat\.?|ft\.?|featuring|vs\.?)\s+|\s*[,&/;]\s*|\s+and\s+/i)[0].trim() || String(a || "");

// Loose artist check so we don't show a stranger's cover: one name contains the other once normalized.
function sameArtist(ours, theirs) {
  const a = norm(mainArtist(ours)).replace(/^the/, ""), b = norm(theirs).replace(/^the/, "");
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, cf: { cacheTtl: 86400 } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// -> cover URL (~250-300px), null when the service has no match. Throws when the service is down or rate limited.
async function fromDeezer(artist, title) {
  const tries = [
    'artist:"' + String(artist).replace(/"/g, "") + '" track:"' + plainTitle(title).replace(/"/g, "") + '"',
    mainArtist(artist) + " " + plainTitle(title),
  ];
  for (const q of tries) {
    const d = await getJson("https://api.deezer.com/search?limit=10&q=" + encodeURIComponent(q));
    if (d && d.error) throw new Error("deezer " + (d.error.code || d.error.type));
    const hit = (d.data || []).find((x) => x.album && x.album.cover_medium && x.artist && sameArtist(artist, x.artist.name));
    if (hit) return hit.album.cover_medium;
  }
  return null;
}
async function fromItunes(artist, title) {
  const term = mainArtist(artist) + " " + plainTitle(title);
  const d = await getJson("https://itunes.apple.com/search?media=music&entity=song&limit=10&term=" + encodeURIComponent(term));
  const hit = (d.results || []).find((x) => x.artworkUrl100 && sameArtist(artist, x.artistName));
  return hit ? hit.artworkUrl100.replace(/\/\d+x\d+bb\./, "/300x300bb.") : null;
}

// Deezer and Apple both serve any size from the same path.
function sized(url, big) {
  if (!big) return url;
  return url.replace(/\/250x250-/, "/500x500-").replace(/\/300x300bb\./, "/600x600bb.");
}

// The song's real title and artist from our tables, matching the title the page showed.
async function findSong(env, id, tk) {
  const cat = await env.DB.prepare("SELECT title, artist FROM catalog WHERE rowid = ?").bind(id).first().catch(() => null);
  if (cat && (!tk || norm(cat.title) === tk)) return cat;
  const { results } = await env.DB.prepare("SELECT title, artist FROM plays WHERE song_id = ? AND title IS NOT NULL LIMIT 20").bind(id).all();
  return results.find((p) => !tk || norm(p.title) === tk) || null;
}

const redirect = (to, maxAge) => new Response(null, { status: 302, headers: { location: to, "cache-control": "public, max-age=" + maxAge } });
const none = (status, maxAge) => new Response(null, { status, headers: { "cache-control": "public, max-age=" + maxAge } });

export async function handleArt(req, env, ctx) {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  const tk = norm(url.searchParams.get("t"));
  const big = url.searchParams.get("s") === "big";
  if (!Number.isInteger(id) || id <= 0 || id > 2e9) return none(404, 86400);

  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/api/art?id=" + id + "&t=" + encodeURIComponent(tk) + (big ? "&s=big" : ""));
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let res;
  try {
    await ensureTable(env);
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare("SELECT url, checked FROM song_art WHERE id = ? AND tk = ?").bind(id, tk).first();
    if (row && row.url) res = redirect(sized(row.url, big), 7 * 86400);
    else if (row && now - row.checked < NO_COVER_RETRY_S) res = none(404, 86400);
    else {
      const song = await findSong(env, id, tk);
      if (!song || !song.title) return none(404, 3600); // not a song we know: nothing saved, nothing looked up
      let cover = null, src = null, failed = 0;
      for (const [name, fn] of [["deezer", fromDeezer], ["itunes", fromItunes]]) {
        try { cover = await fn(song.artist || "", song.title); } catch (e) { failed++; continue; }
        if (cover) { src = name; break; }
      }
      if (!cover && failed === 2) return none(503, 60); // both services down or rate limited: try again later, save nothing
      await env.DB.prepare("INSERT OR REPLACE INTO song_art (id, tk, url, src, checked) VALUES (?, ?, ?, ?, ?)").bind(id, tk, cover, src, now).run();
      res = cover ? redirect(sized(cover, big), 7 * 86400) : none(404, 86400);
    }
  } catch (e) {
    return none(503, 60);
  }
  ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  return res;
}
