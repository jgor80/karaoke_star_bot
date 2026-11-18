// Years and genres for the Songbook's era and genre filters, from free, open music data.
//
// The song list (Karaoke Version's affiliate file, see catalog_import.js) has only titles, artists and
// popularity. So the Worker's every-minute cron fills in the rest, a few songs at a time, most popular first:
//   - Year: MusicBrainz recording search (MusicBrainz core data is CC0, free for any use). The year is the
//     earliest release date of a matching recording.
//   - Genres: per artist, MusicBrainz artist search for the artist's MusicBrainz id, then Wikidata's
//     "genre" (P136) for that artist (Wikidata is CC0). Wikidata's genre names are mapped onto the
//     Songbook's genre pills (GENRE_RULES). MusicBrainz's own genre tags are NOT used: MusicBrainz licenses
//     tags for non-commercial use only.
//   - Language: per artist, Wikidata's "language of work" (P407), or the one language the artist is
//     listed as singing/speaking (P1412) when there is only one. Mapped onto the Songbook's languages.
//   - Length: the matched MusicBrainz recording's length, saved with the year.
//   - Christmas: from the song title.
// Nothing here comes from the karaoke app's own catalog.
//
// Tables (D1):
//   song_year(k, id, pop, year, checked, fails)        k = matchKey(title, artist); year 0 = looked up, not found
//   artist_genre(artist, pop, mbid, genres, langs, checked, fails)
//     mbid NULL = not looked up yet, '' = not found; genres NULL = Wikidata not asked yet, '' = none
//   song_extra(id, kv, preview, len)                   catalog rowid -> Karaoke Version ids (from the import)
//                                                      and the length in seconds (from here)
// Found values are written straight into catalog and catalog_order (so filters work right away) and are
// applied again by every weekly import (catalog_import.js loadDetails).
//
// MusicBrainz asks for about one request a second with a User-Agent naming the app. voice_import.js runs
// first in the same cron chain (worker.js), so the two never ask at the same time.

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS song_year (k text primary key, id integer, pop integer, year integer, checked integer, fails integer not null default 0)",
  "CREATE INDEX IF NOT EXISTS song_year_todo ON song_year (checked, fails, pop)",
  "CREATE TABLE IF NOT EXISTS artist_genre (artist text primary key, pop integer, mbid text, genres text, langs text, checked integer, fails integer not null default 0)",
  "CREATE TABLE IF NOT EXISTS song_extra (id integer primary key, kv integer, preview integer, len integer)",
  "CREATE INDEX IF NOT EXISTS artist_genre_todo ON artist_genre (mbid, fails, pop)",
  "CREATE INDEX IF NOT EXISTS artist_genre_wd ON artist_genre (genres, mbid)",
  "CREATE INDEX IF NOT EXISTS catalog_order_artist ON catalog_order (artist)",
];
const PER_RUN = 24;       // MusicBrainz requests per cron run (fewer while voice_import is still busy)
const ARTISTS_PER_RUN = 8;
const WIKIDATA_BATCH = 60;
const GAP_MS = 1100;
const MAX_SLOWDOWNS = 5;
const MAX_FAILS = 3;
const UA = "OkeNight/1.0 ( https://okenight.com )";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- keys and rules shared with catalog_import.js ----

// "The Beatles" / "Beatles", "Rock & Roll" / "Rock and Roll", "Song (Live)" / "Song", accents and
// punctuation: all match.
const norm = (x) => String(x || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\(.*?\)|\[.*?\]/g, "").replace(/^the /, "").replace(/&|\band\b/g, " ").replace(/[^\p{L}\p{N}]+/gu, "");
export const matchKey = (title, artist) => norm(artist) + "|" + norm(title);

const XMAS_RE = /\b(christmas|xmas|santa|navidad|noel|no[eë]l|rudolph|jingle bell|sleigh|mistletoe|feliz navidad|holly jolly|silent night|weihnacht)/i;
export const isChristmas = (title) => XMAS_RE.test(String(title || ""));

// Wikidata genre name -> Songbook genre pills. First match per rule; a genre can give several pills.
export const GENRE_RULES = [
  [/rock and roll|rock 'n' roll|rock & roll|rockabilly|doo-?wop/, "Rock 'n Roll"],
  [/heavy metal|metal/, "Metal"],
  [/punk|grunge|emo|hardcore/, "Punk/Grunge"],
  [/alternative|indie|post-punk|new wave/, "Alternative"],
  [/hard rock/, "Hard Rock"],
  [/soft rock|adult contemporary|yacht/, "Soft rock"],
  [/rock/, "Rock"],
  [/country|bluegrass|americana|honky|western swing|outlaw/, "Country"],
  [/latin|reggaeton|salsa|bachata|cumbia|bossa nova|mariachi|regional mexican|tejano|banda|ranchera|merengue|bolero|norte[nñ]o|sertanejo|tango/, "Latin Music"],
  [/r&b|rhythm and blues|new jack swing|neo soul|quiet storm/, "R&B"],
  [/hip hop|hip-hop|trap music|crunk|drill/, "Hip-Hop"],
  [/\brap\b|gangsta|horrorcore/, "Rap"],
  [/soul|motown/, "Soul"],
  [/funk/, "Funk"],
  [/gospel|christian|worship|spiritual/, "Gospel"],
  [/disco/, "Disco"],
  [/synth-?pop|electropop/, "Synthpop"],
  [/teen pop|bubblegum/, "Teen pop"],
  [/dance|eurodance|house music|\bhouse\b|edm|techno|trance|electronic dance/, "Dance"],
  [/electronic|electro|electronica/, "Electro"],
  [/\bpop\b|pop music|pop rock|dance-pop|power pop|j-pop|k-pop|europop/, "Pop"],
  [/chanson|french pop|vari[eé]t[eé] fran/, "French pop"],
  [/schlager/, "Schlager"],
  [/jazz|swing|big band|traditional pop|vocal jazz|crooner|lounge/, "Jazz"],
  [/blues/, "Blues"],
  [/folk/, "Folk"],
  [/reggae|dancehall/, "Reggae"],
  [/\bska\b/, "Ska"],
  [/zouk|soca|calypso|kompa/, "Zouk/Creole/Soca/Calypso"],
  [/musical theatre|musical theater|show tune|broadway|cabaret/, "Musical"],
  [/classical|opera|baroque/, "Classical"],
  [/comedy|novelty|parody/, "Humor"],
  [/children'?s music|kids/, "Kids"],
  [/soundtrack|film score/, "Soundtrack"],
];
const LANG_MAP = [["english", "English"], ["spanish", "Spanish"], ["french", "French"], ["portuguese", "Portuguese"], ["german", "German"],
  ["italian", "Italian"], ["dutch", "Dutch"], ["korean", "Korean"], ["japanese", "Japanese"]];
// Wikidata languages -> Songbook languages: "language of work" ones if any, else the artist's only language.
export function mapLangs(work, spoken) {
  const pick = (names) => [...new Set(names.map((n) => (LANG_MAP.find(([w]) => String(n).toLowerCase() === w) || [])[1]).filter(Boolean))];
  const w = pick(work || []);
  if (w.length) return w.slice(0, 2).join(",");
  const sp = pick(spoken || []);
  return sp.length === 1 && (spoken || []).length === 1 ? sp[0] : "";
}
export function mapGenres(names) {
  const out = new Set();
  for (const n of names) {
    const s = String(n || "").toLowerCase();
    for (const [re, pill] of GENRE_RULES) if (re.test(s)) out.add(pill);
  }
  return [...out].slice(0, 4).join(",");
}
// A song's styles: its artist's genres, plus Christmas from the title.
export const stylesFor = (artistGenres, title) => {
  const g = (artistGenres || "").split(",").filter(Boolean);
  if (isChristmas(title) && !g.includes("Christmas")) g.push("Christmas");
  return g.join(",");
};

let schemaDone = false;
export async function ensureDetailTables(env) {
  if (schemaDone) return;
  for (const s of SCHEMA) await env.DB.prepare(s).run();
  schemaDone = true;
}

// After a weekly import: queue every song and artist (new ones), and refresh ranks so popular ones go first.
export async function seedDetails(env, songs) {
  await ensureDetailTables(env);
  const enc = new TextEncoder(), lit = (v) => v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
  const head = "INSERT INTO song_year (k, id, pop) VALUES ", tail = " ON CONFLICT(k) DO UPDATE SET id = excluded.id, pop = excluded.pop";
  const stmts = []; let tuples = [], size = head.length + tail.length;
  for (const s of songs) {
    const t = "(" + [matchKey(s.title, s.artist), s.id, s.pop].map(lit).join(",") + ")", n = enc.encode(t).length + 1;
    if (tuples.length && size + n > 90000) { stmts.push(head + tuples.join(",") + tail); tuples = []; size = head.length + tail.length; }
    tuples.push(t); size += n;
  }
  if (tuples.length) stmts.push(head + tuples.join(",") + tail);
  for (let i = 0; i < stmts.length; i += 5) await env.DB.batch(stmts.slice(i, i + 5).map((q) => env.DB.prepare(q)));
  // Karaoke Version ids for each row (song id, and the preview file id for the "Hear it" button).
  const eh = "INSERT INTO song_extra (id, kv, preview) VALUES ", et = " ON CONFLICT(id) DO UPDATE SET kv = excluded.kv, preview = excluded.preview";
  const ex = []; let et2 = [];
  for (const s of songs) {
    et2.push("(" + [s.id, s.kv || null, s.preview || null].map(lit).join(",") + ")");
    if (et2.length >= 2000) { ex.push(eh + et2.join(",") + et); et2 = []; }
  }
  if (et2.length) ex.push(eh + et2.join(",") + et);
  for (let i = 0; i < ex.length; i += 5) await env.DB.batch(ex.slice(i, i + 5).map((q) => env.DB.prepare(q)));
  await env.DB.prepare("DELETE FROM song_extra WHERE id NOT IN (SELECT id FROM catalog_order)").run();
  await env.DB.prepare("INSERT INTO artist_genre (artist, pop) SELECT artist, min(pop) FROM catalog GROUP BY artist" +
    " ON CONFLICT(artist) DO UPDATE SET pop = excluded.pop").run();
}

// For the weekly import: what's known so far. years: Map(k -> year), genres / langs: Map(artist -> list).
export async function loadDetails(env) {
  const years = new Map(), genres = new Map(), langs = new Map();
  try {
    for (let last = ""; ;) {
      const { results } = await env.DB.prepare("SELECT k, year FROM song_year WHERE year > 0 AND k > ? ORDER BY k LIMIT 20000").bind(last).all();
      results.forEach((r) => years.set(r.k, Number(r.year)));
      if (results.length < 20000) break;
      last = results[results.length - 1].k;
    }
    const { results } = await env.DB.prepare("SELECT artist, genres, langs FROM artist_genre WHERE (genres IS NOT NULL AND genres != '') OR (langs IS NOT NULL AND langs != '')").all();
    results.forEach((r) => { if (r.genres) genres.set(r.artist, r.genres); if (r.langs) langs.set(r.artist, r.langs); });
  } catch (e) { /* tables not made yet */ }
  return { years, genres, langs };
}

// ---- lookups ----

async function mb(path) {
  const r = await fetch("https://musicbrainz.org/ws/2/" + path, { headers: { accept: "application/json", "user-agent": UA } });
  if (r.status === 503 || r.status === 429) return null;
  if (!r.ok) throw new Error("musicbrainz HTTP " + r.status);
  return r.json();
}
const q = (s) => '"' + String(s).replace(/["\\]/g, " ") + '"';

// Main artist of a credit: "A Star is Born (Lady Gaga & Bradley Cooper)" -> "Lady Gaga"; "Elton John & Kiki Dee" -> "Elton John".
export function mainArtist(artist) {
  const a = String(artist || "");
  const inner = a.match(/\(([^()]+)\)\s*$/);
  const base = inner && /\(.*\(/.test(a) ? inner[1] : a.replace(/\s*\(.*?\)/g, "");
  return base.split(/\s+(?:feat\.?|ft\.?|featuring|vs\.?|with|duet with|and)\s+|\s*(?:[,&/;+]|\s-\s)\s*/i)[0].trim() || a;
}

// Earliest year of a recording with this title by this artist, and that recording's length in seconds:
// {year, len} (0 = not found), or null when told to slow down.
export async function lookupYear(title, artist) {
  const d = await mb("recording?fmt=json&limit=15&query=" + encodeURIComponent("recording:" + q(title.replace(/\s*\(.*?\)/g, "")) + " AND artist:" + q(mainArtist(artist))));
  if (d === null) return null;
  const t = norm(title), a = norm(mainArtist(artist));
  let year = 0, len = 0;
  for (const r of d.recordings || []) {
    if ((r.score || 0) < 85 || norm(r.title) !== t) continue;
    const credits = (r["artist-credit"] || []).map((c) => norm(c.name || (c.artist && c.artist.name)));
    if (!credits.some((c) => c === a || c.includes(a) || a.includes(c))) continue;
    const l = Math.round((Number(r.length) || 0) / 1000);
    if (!len && l >= 30 && l <= 1800) len = l;
    const y = parseInt(String(r["first-release-date"] || "").slice(0, 4), 10);
    if (y > 1800 && y <= new Date().getFullYear() + 1 && (!year || y < year)) { year = y; if (l >= 30 && l <= 1800) len = l; }
  }
  return { year, len };
}

// MusicBrainz id for an artist name, '' if not found, null when told to slow down.
export async function lookupArtistId(artist) {
  const name = mainArtist(artist);
  const d = await mb("artist?fmt=json&limit=5&query=" + encodeURIComponent("artist:" + q(name)));
  if (d === null) return null;
  const want = norm(name);
  const hit = (d.artists || []).find((x) => (x.score || 0) >= 90 && (norm(x.name) === want || (x.aliases || []).some((al) => norm(al.name) === want)));
  return hit ? hit.id : "";
}

// Wikidata genres and languages (English labels) for MusicBrainz artist ids:
// Map(mbid -> {genres: [...], work: [...], spoken: [...]}).
export async function wikidataDetails(mbids) {
  const ids = mbids.filter((m) => /^[0-9a-f-]{36}$/.test(m));
  const out = new Map(ids.map((m) => [m, { genres: [], work: [], spoken: [] }]));
  if (!ids.length) return out;
  const sparql = "SELECT ?mbid ?p ?l WHERE { VALUES ?mbid { " + ids.map((m) => '"' + m + '"').join(" ") + " } ?a wdt:P434 ?mbid. " +
    "{ ?a wdt:P136 ?x. BIND(\"genres\" AS ?p) } UNION { ?a wdt:P407 ?x. BIND(\"work\" AS ?p) } UNION { ?a wdt:P1412 ?x. BIND(\"spoken\" AS ?p) } " +
    "?x rdfs:label ?l. FILTER(LANG(?l) = \"en\") }";
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql),
    { headers: { accept: "application/sparql-results+json", "user-agent": UA } });
  if (!r.ok) throw new Error("wikidata HTTP " + r.status);
  const d = await r.json();
  for (const b of (d.results && d.results.bindings) || []) {
    const m = b.mbid && b.mbid.value, p = b.p && b.p.value, l = b.l && b.l.value;
    if (out.has(m) && l && out.get(m)[p]) out.get(m)[p].push(l);
  }
  return out;
}

// Write found values into the catalog and its browse copy, so filters pick them up right away.
const XMAS_SQL = "(" + ["christmas", "xmas", "santa", "navidad", "noel", "rudolph", "jingle bell", "sleigh", "mistletoe", "silent night"]
  .map((w) => "lower(c.title) LIKE '%" + w + "%'").join(" OR ") + ")";
async function applyGenres(env, artist, genres, langs) {
  await env.DB.batch([
    env.DB.prepare("UPDATE catalog SET languages = ?1 WHERE rowid IN (SELECT id FROM catalog_order WHERE artist = ?2)").bind(langs, artist),
    env.DB.prepare("UPDATE catalog_order SET languages = ?1 WHERE artist = ?2").bind(langs, artist),
    env.DB.prepare("UPDATE catalog SET styles = ?1 || CASE WHEN " + XMAS_SQL.replace(/c\.title/g, "title") + " THEN (CASE WHEN ?1 = '' THEN '' ELSE ',' END) || 'Christmas' ELSE '' END" +
      " WHERE rowid IN (SELECT id FROM catalog_order WHERE artist = ?2)").bind(genres, artist),
    env.DB.prepare("UPDATE catalog_order SET styles = (SELECT c.styles FROM catalog c WHERE c.rowid = catalog_order.id) WHERE artist = ?").bind(artist),
  ]);
}
async function applyYear(env, id, year, len) {
  await env.DB.batch([
    ...(year ? [env.DB.prepare("UPDATE catalog SET year = ? WHERE rowid = ?").bind(year, id),
      env.DB.prepare("UPDATE catalog_order SET year = ? WHERE id = ?").bind(year, id)] : []),
    ...(len ? [env.DB.prepare("UPDATE song_extra SET len = ? WHERE id = ?").bind(len, id)] : []),
  ]);
}

// Which filters have enough data to show (catalog_api.js returns it as `facets`). Checked at most hourly.
const FACET_GENRES = ["Pop", "Rock", "Country", "Latin Music", "R&B", "Hip-Hop", "Rap", "Soul", "Dance", "Alternative", "Disco",
  "Soundtrack", "Musical", "Rock 'n Roll", "Metal", "Punk/Grunge", "Christmas", "Kids", "Jazz", "Folk", "Electro", "Soft rock",
  "Hard Rock", "Synthpop", "Blues", "Gospel", "Teen pop", "Funk", "Humor", "Reggae", "French pop", "Schlager",
  "Zouk/Creole/Soca/Calypso", "Ska", "Classical"];
export async function updateFacets(env, now = Date.now()) {
  const last = await env.DB.prepare("SELECT v FROM catalog_meta WHERE k = 'facets_at'").first().catch(() => null);
  if (last && now - Number(last.v) < 3600 * 1000) return null;
  const counts = await env.DB.batch(FACET_GENRES.map((g) =>
    env.DB.prepare("SELECT count(*) AS n FROM catalog_order WHERE (',' || styles || ',') LIKE ?").bind("%," + g + ",%")));
  const genres = FACET_GENRES.filter((g, i) => (counts[i].results[0] || {}).n >= 20);
  const y = await env.DB.prepare("SELECT count(*) AS n FROM catalog_order WHERE year > 0").first();
  const LANGS = LANG_MAP.map(([, l]) => l);
  const lc = await env.DB.batch(LANGS.map((l) => env.DB.prepare("SELECT count(*) AS n FROM catalog_order WHERE (',' || languages || ',') LIKE ?").bind("%," + l + ",%")));
  const ad = await env.DB.prepare("SELECT count(*) AS n FROM catalog_order WHERE added != ''").first();
  const facets = { genres, years: (y && y.n) >= 500, langs: LANGS.filter((l, i) => (lc[i].results[0] || {}).n >= 20), added: (ad && ad.n) >= 20 };
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO catalog_meta (k, v) VALUES ('facets', ?)").bind(JSON.stringify(facets)),
    env.DB.prepare("INSERT OR REPLACE INTO catalog_meta (k, v) VALUES ('facets_at', ?)").bind(String(now)),
  ]);
  return facets;
}

// Called by the every-minute cron after voice_import.js. A few lookups per run, most popular first.
export async function updateDetails(env, now = Date.now()) {
  const meta = await env.DB.prepare("SELECT v FROM catalog_meta WHERE k = 'source'").first().catch(() => null);
  if (!meta || meta.v !== "kv") return null; // only for the new song list (catalog_import.js)
  await ensureDetailTables(env);
  const stamp = Math.floor(now / 1000);
  let budget = PER_RUN, slowdowns = 0, first = true;
  // One MusicBrainz call, spaced out and retried on "slow down". undefined = stop this run.
  const call = async (fn) => {
    for (;;) {
      if (budget <= 0 || slowdowns >= MAX_SLOWDOWNS) return undefined;
      if (!first) await sleep(slowdowns ? 2500 : GAP_MS);
      first = false; budget--;
      let r;
      try { r = await fn(); } catch (e) { return /HTTP 4\d\d/.test(String(e && e.message)) ? "error" : undefined; }
      if (r !== null) return r;
      slowdowns++;
    }
  };
  let done = 0;

  // 1. Artists: MusicBrainz id.
  const { results: arts } = await env.DB.prepare("SELECT artist FROM artist_genre WHERE mbid IS NULL ORDER BY fails, pop LIMIT ?").bind(ARTISTS_PER_RUN).all();
  for (const { artist } of arts) {
    const id = await call(() => lookupArtistId(artist));
    if (id === undefined) break;
    if (id === "error") {
      await env.DB.prepare("UPDATE artist_genre SET fails = fails + 1, mbid = CASE WHEN fails + 1 >= ? THEN '' ELSE mbid END, checked = ? WHERE artist = ?").bind(MAX_FAILS, stamp, artist).run();
      continue;
    }
    // Not found: no genres to look up either.
    await env.DB.prepare("UPDATE artist_genre SET mbid = ?, genres = CASE WHEN ? = '' THEN '' ELSE genres END, checked = ? WHERE artist = ?").bind(id, id, stamp, artist).run();
    done++;
  }

  // 2. Artists: Wikidata genres, many at once (not MusicBrainz, so no budget).
  const { results: wd } = await env.DB.prepare("SELECT artist, mbid FROM artist_genre WHERE genres IS NULL AND mbid IS NOT NULL AND mbid != '' ORDER BY pop LIMIT ?").bind(WIKIDATA_BATCH).all();
  if (wd.length) {
    try {
      const found = await wikidataDetails([...new Set(wd.map((r) => r.mbid))]);
      for (const r of wd) {
        const f = found.get(r.mbid) || { genres: [], work: [], spoken: [] };
        const g = mapGenres(f.genres), l = mapLangs(f.work, f.spoken);
        await env.DB.prepare("UPDATE artist_genre SET genres = ?, langs = ?, checked = ? WHERE artist = ?").bind(g, l, stamp, r.artist).run();
        await applyGenres(env, r.artist, g, l);
      }
      done += wd.length;
    } catch (e) { /* Wikidata busy: next minute */ }
  }

  // 3. Songs: year.
  if (budget > 0) {
    const { results: songs } = await env.DB.prepare("SELECT s.k, s.id, c.title, c.artist FROM song_year s JOIN catalog_order o ON o.id = s.id" +
      " JOIN catalog c ON c.rowid = s.id WHERE s.checked IS NULL ORDER BY s.fails, s.pop LIMIT ?").bind(budget).all();
    for (const s of songs) {
      const y = await call(() => lookupYear(s.title, s.artist));
      if (y === undefined) break;
      if (y === "error") {
        await env.DB.prepare("UPDATE song_year SET fails = fails + 1, checked = CASE WHEN fails + 1 >= ? THEN ? ELSE NULL END, year = CASE WHEN fails + 1 >= ? THEN 0 ELSE year END WHERE k = ?")
          .bind(MAX_FAILS, stamp, MAX_FAILS, s.k).run();
        continue;
      }
      await env.DB.prepare("UPDATE song_year SET year = ?, checked = ? WHERE k = ?").bind(y.year, stamp, s.k).run();
      if (y.year || y.len) await applyYear(env, s.id, y.year, y.len);
      done++;
    }
  }
  await updateFacets(env, now).catch(() => {});
  return done;
}
