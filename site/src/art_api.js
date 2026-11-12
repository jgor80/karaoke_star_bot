import { listSongById } from "./songbook_api.js";
// Album covers for songs:
//   GET /api/art?id=<KaraFun song id>&t=<title>[&s=big]  -> the cover image, or 404 when there's none
//
// The song catalog has no artwork, so covers come from Apple's iTunes Search API (ART_SOURCES in
// wrangler.toml; the Deezer and Cover Art Archive lookups below are switched off). Each song is looked up
// once and the answer (including "no cover") is saved in D1 table song_art. The image itself is served
// from okenight.com out of Cloudflare's cache for a few days (refetched after that), so phones never talk
// to Apple directly, and every cover links back to Apple Music (see handleListen).
// Only the cover's address is stored permanently, not the image: a cache is the low-risk way to reuse
// cover art we don't own a license for.
//
// Visitors only send a song id and a title; the artist and title we search for come from our own
// catalog/plays tables, so the endpoint can't be used to make arbitrary lookups. t is there because
// KaraFun community songs share the id space with catalog songs: it picks the right one.

const TABLE =
  "CREATE TABLE IF NOT EXISTS song_art (id integer not null, tk text not null, url text, src text," +
  " checked integer not null, link text, primary key (id, tk))";
// link: the song's page at the source (Apple Music, Deezer or MusicBrainz). Added after the table existed.
const ADD_LINK = "ALTER TABLE song_art ADD COLUMN link text";
const NO_COVER_RETRY_S = 30 * 86400; // try songs without a cover again after a month
// "No cover" answers saved before this time are retried right away (bump it after adding a source).
const MISSES_BEFORE = Date.UTC(2026, 10, 10, 23) / 1000;

let ready = null;
function ensureTable(env) {
  if (!ready) ready = env.DB.prepare(TABLE).run()
    .then(() => env.DB.prepare(ADD_LINK).run().catch(() => {})) // fails harmlessly once the column exists
    // Forget covers saved from sources that are switched off (e.g. Deezer before Apple-only); they get looked up again.
    .then(() => env.DB.prepare("DELETE FROM song_art WHERE url IS NOT NULL AND src NOT IN (SELECT value FROM json_each(?))").bind(JSON.stringify(artSources(env))).run().catch(() => {}))
    .catch((e) => { ready = null; throw e; });
  return ready;
}

// "Don't Stop Believin'" -> "dontstopbelievin". Same as normTitle in art.js, so URLs match and cache well.
export const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 60);

// Drop "(Live)", "[Remastered]", "- Radio Edit" and featured artists so the search finds the original.
const plainTitle = (t) => String(t || "").replace(/\s*[([].*?[)\]]/g, "").replace(/\s+-\s+.*$/, "").trim() || String(t || "");
// KaraFun credits soundtrack songs like "A Star is Born (2018 film) (Lady Gaga & Bradley Cooper)":
// the singers are in the last brackets, so search for them.
const searchArtist = (a) => { const m = String(a || "").match(/\(([^()]+)\)\s*$/); return m && !/\b(film|movie|musical|soundtrack|tv|series|version)\b/i.test(m[1]) ? m[1] : String(a || "").replace(/\s*\(.*?\)/g, "").trim() || String(a || ""); };
const mainArtist = (a) => String(searchArtist(a)).split(/\s+(?:feat\.?|ft\.?|featuring|vs\.?)\s+|\s*[,&/;]\s*|\s+and\s+/i)[0].trim() || String(a || "");

// Loose artist check so we don't show a stranger's cover: one name contains the other once normalized.
function sameArtist(ours, theirs) {
  const a = norm(mainArtist(ours)).replace(/^the/, ""), b = norm(theirs).replace(/^the/, "");
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

// Names the app to the services we call. MusicBrainz asks for this; requests without one are also the
// usual reason Apple's search API turns a server away.
const UA = "OkeNight/1.0 ( https://okenight.com )";
async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, cf: { cacheTtl: 86400 } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// -> {url: cover (~250-300px), link: the song's page there}, null when the service has no match. Throws when the service is down or rate limited.
async function fromDeezer(artist, title) {
  const tries = [
    'artist:"' + searchArtist(artist).replace(/"/g, "") + '" track:"' + plainTitle(title).replace(/"/g, "") + '"',
    mainArtist(artist) + " " + plainTitle(title),
  ];
  for (const q of tries) {
    const d = await getJson("https://api.deezer.com/search?limit=10&q=" + encodeURIComponent(q));
    if (d && d.error) throw new Error("deezer " + (d.error.code || d.error.type));
    const hit = (d.data || []).find((x) => x.album && x.album.cover_medium && x.artist && sameArtist(artist, x.artist.name));
    if (hit) return { url: hit.album.cover_medium, link: hit.link || null };
  }
  return null;
}
async function fromItunes(artist, title) {
  const term = mainArtist(artist) + " " + plainTitle(title);
  const d = await getJson("https://itunes.apple.com/search?media=music&entity=song&limit=10&term=" + encodeURIComponent(term));
  const hit = (d.results || []).find((x) => x.artworkUrl100 && sameArtist(artist, x.artistName));
  return hit ? { url: hit.artworkUrl100.replace(/\/\d+x\d+bb\./, "/300x300bb."), link: hit.trackViewUrl || hit.collectionViewUrl || null } : null;
}

// MusicBrainz asks API users for a User-Agent naming the app, and for at most about one request a second.
// It's the last resort, so it only sees songs Deezer and Apple don't have.
const MB_UA = UA;
async function mbSearch(kind, query) {
  const r = await fetch("https://musicbrainz.org/ws/2/" + kind + "?fmt=json&limit=10&query=" + encodeURIComponent(query),
    { headers: { accept: "application/json", "user-agent": MB_UA }, cf: { cacheTtl: 86400 } });
  if (!r.ok) throw new Error("musicbrainz HTTP " + r.status);
  return r.json();
}
const creditedTo = (artist, credits) => (credits || []).some((c) => sameArtist(artist, c.name || (c.artist && c.artist.name)));
async function fromCoverArtArchive(artist, title) {
  const t = plainTitle(title).replace(/"/g, ""), a = mainArtist(artist).replace(/"/g, "");
  // The artist's own single or album named after the song is the best cover ("Wuthering Heights" single).
  const rg = await mbSearch("release-group", 'releasegroup:"' + t + '" AND artist:"' + a + '"');
  let groups = (rg["release-groups"] || []).filter((g) => creditedTo(artist, g["artist-credit"]) && norm(g.title).startsWith(norm(t)));
  // Otherwise any official release of the artist's own that has the song (skips "Various Artists" compilations and bootlegs).
  if (!groups.length) {
    const rec = await mbSearch("recording", 'recording:"' + t + '" AND artist:"' + a + '"');
    (rec.recordings || []).filter((x) => creditedTo(artist, x["artist-credit"])).forEach((x) => (x.releases || []).forEach((rel) => {
      const g = rel["release-group"];
      if (g && g.id && rel.status === "Official" && (!rel["artist-credit"] || creditedTo(artist, rel["artist-credit"])) && !groups.some((y) => y.id === g.id)) groups.push(g);
    }));
  }
  const rank = (g) => (g["primary-type"] === "Single" ? 0 : g["primary-type"] === "Album" ? 1 : 2) + ((g["secondary-types"] || []).length ? 3 : 0);
  for (const g of groups.sort((x, y) => rank(x) - rank(y)).slice(0, 3)) {
    const url = "https://coverartarchive.org/release-group/" + g.id + "/front-250";
    const c = await fetch(url, { method: "HEAD", redirect: "manual", headers: { "user-agent": MB_UA } });
    if (c.status >= 300 && c.status < 400) return { url, link: "https://musicbrainz.org/release-group/" + g.id }; // redirects to the image when there is one, 404 when not
  }
  return null;
}

// Deezer, Apple and the Cover Art Archive all serve a bigger size from a similar URL.
function sized(url, big) {
  if (!big) return url;
  return url.replace(/\/250x250-/, "/500x500-").replace(/\/300x300bb\./, "/600x600bb.").replace(/\/front-250$/, "/front-500");
}

// The song's real title and artist from our tables, matching the title the page showed.
async function findSong(env, id, tk) {
  const cat = await listSongById(env, id); // the full song list, or the host's own songbook
  if (cat && (!tk || norm(cat.title) === tk)) return cat;
  const { results } = await env.DB.prepare("SELECT title, artist FROM plays WHERE song_id = ? AND title IS NOT NULL LIMIT 20").bind(id).all();
  return results.find((p) => !tk || norm(p.title) === tk) || null;
}

// Where covers may come from, in order. Set ART_SOURCES in wrangler.toml [vars] (comma separated).
// Apple's artwork may be shown to promote the music when it links back to Apple Music, which every
// cover does (see handleListen). Deezer and the Cover Art Archive don't license their images for
// commercial use, so keep them off before the site makes money. A licensed provider such as
// Gracenote would be one more entry here.
const SOURCES = { itunes: fromItunes, deezer: fromDeezer, coverart: fromCoverArtArchive };
function artSources(env) {
  const list = String((env && env.ART_SOURCES) || "itunes").split(",").map((x) => x.trim()).filter((x) => SOURCES[x]);
  return list.length ? list : ["itunes"];
}

// Covers are a short-lived cache, never an archive: Cloudflare keeps a copy up to 3 days, phones up to 1 day,
// and both check back with Apple after that.
const IMAGE_TTL_S = 3 * 86400;
const BROWSER_TTL_S = 86400;
const MAX_IMAGE_BYTES = 1024 * 1024;
const redirect = (to, maxAge) => new Response(null, { status: 302, headers: { location: to, "cache-control": "public, max-age=" + maxAge } });
const none = (status, maxAge) => new Response(null, { status, headers: { "cache-control": "public, max-age=" + maxAge } });

// Fetch the cover once and hand it out from our own domain. If the image host is down or sends
// something that isn't an image, fall back to pointing the phone at it for an hour.
async function image(to) {
  try {
    const r = await fetch(to, { headers: { accept: "image/*" }, cf: { cacheTtl: IMAGE_TTL_S, cacheEverything: true } });
    const type = r.headers.get("content-type") || "";
    if (r.ok && /^image\//.test(type)) {
      const body = await r.arrayBuffer();
      if (body.byteLength > 0 && body.byteLength <= MAX_IMAGE_BYTES) {
        return new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=" + BROWSER_TTL_S, "x-content-type-options": "nosniff" } });
      }
    }
  } catch (e) {}
  return redirect(to, 3600);
}

export async function handleArt(req, env, ctx) {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  const tk = norm(url.searchParams.get("t"));
  const big = url.searchParams.get("s") === "big";
  if (!Number.isInteger(id) || id <= 0 || id > 2e9) return none(404, 86400);

  const cache = caches.default;
  // v=2: images, not redirects (older cached redirects are simply left to expire)
  const sources = artSources(env);
  const cacheKey = new Request(url.origin + "/api/art?v=2&src=" + sources.join(",") + "&id=" + id + "&t=" + encodeURIComponent(tk) + (big ? "&s=big" : ""));
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let res;
  try {
    await ensureTable(env);
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare("SELECT url, src, checked FROM song_art WHERE id = ? AND tk = ?").bind(id, tk).first();
    // A saved cover from a source that has since been switched off is looked up again.
    if (row && row.url && sources.includes(row.src)) res = await image(sized(row.url, big));
    else if (row && !row.url && now - row.checked < NO_COVER_RETRY_S && row.checked >= MISSES_BEFORE) res = none(404, 86400);
    else {
      const song = await findSong(env, id, tk);
      if (!song || !song.title) return none(404, 3600); // not a song we know: nothing saved, nothing looked up
      let cover = null, src = null, link = null; const failed = [];
      for (const name of sources) {
        const fn = SOURCES[name];
        let got;
        try { got = await fn(song.artist || "", song.title); } catch (e) { failed.push(name); console.log("album art: " + name + " failed: " + e.message); continue; }
        if (got) { cover = got.url; link = got.link; src = name; break; }
      }
      // Only remember "no cover" when every source answered. If one was down or rate limited, the next view tries again.
      if (!cover && failed.length === sources.length) return none(503, 60);
      if (!cover && failed.length) return none(404, 3600);
      await env.DB.prepare("INSERT OR REPLACE INTO song_art (id, tk, url, src, checked, link) VALUES (?, ?, ?, ?, ?, ?)").bind(id, tk, cover, src, now, link).run();
      res = cover ? await image(sized(cover, big)) : none(404, 86400);
    }
  } catch (e) {
    return none(503, 60);
  }
  ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  return res;
}

// Tapping a cover: GET /api/listen?id=<song id>&t=<title> -> the song's page where the cover came from
// (Apple Music, Deezer or MusicBrainz), or an Apple Music search when we have no link.
export async function handleListen(req, env) {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  const tk = norm(url.searchParams.get("t"));
  if (!Number.isInteger(id) || id <= 0 || id > 2e9) return none(404, 86400);
  try {
    await ensureTable(env);
    const row = await env.DB.prepare("SELECT link, src FROM song_art WHERE id = ? AND tk = ?").bind(id, tk).first();
    if (row && row.link && artSources(env).includes(row.src) && /^https:\/\/[a-z0-9.-]*(apple\.com|deezer\.com|musicbrainz\.org)\//.test(row.link)) return redirect(row.link, 86400);
    const song = await findSong(env, id, tk);
    if (!song) return none(404, 3600);
    return redirect("https://music.apple.com/us/search?term=" + encodeURIComponent(mainArtist(song.artist || "") + " " + plainTitle(song.title)), 3600);
  } catch (e) {
    return none(503, 60);
  }
}
