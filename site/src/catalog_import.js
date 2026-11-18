// Weekly import of the Songbook's song list into D1 (catalog_api.js serves it).
//
// Source: Karaoke Version's affiliate song list (KV_ZIP below), a nightly XML file that Recisio publishes
// for its affiliates to "download regularly" and "import in your database"
// (https://affiliate.recisio.com/karaoke-version/xml.html). About 99,000 songs: artist, title, popularity
// rank and the files on sale for each. The host is a Recisio affiliate, so buy links carry the affiliate ID
// (see host.html KV_AFF).
//
// Only Karaoke Version's own data is used: title, artist, rank, and whether the song is on sale in the
// karaoke app's file format (KFN, i.e. the karaoke app can play it). Until 2026-11 the Songbook copied the
// karaoke app's own song list instead; the first import from this file replaces every row of it. The file
// has no years, genres or languages: details_import.js fills those in from open data (MusicBrainz,
// Wikidata) over the following days, and the duet flag is guessed from the artist ("A & B", "feat.").
// A song that was sung at one of our bars keeps its plays.song_id as its id (drafts and requests look songs
// up by it); every other song's id is KV_ID_BASE + Karaoke Version's song id.
//
// The every-minute cron calls maybeImportCatalog(); it does nothing unless the catalog is missing, over a
// week old or from the old source, and tries at most once an hour. Each song row keeps a hash (h) of what
// was sent, so a weekly refresh only writes the songs that changed.

import { matchKey, stylesFor, seedDetails, loadDetails } from "./details_import.js";

const KV_ZIP = "https://www.karaoke-version.com/misc/catalog/karaokeversion_catalog_en_USD.xml.zip";
const SOURCE = "kv";            // catalog_meta.source; a different value means the old list, so re-import now
export const KV_ID_BASE = 3e9;  // ids of songs that only come from the file (host songbook ids start at 1e9)
const UA = "OkeNight/1.0 (affiliate catalog import; okenight.com)";
const REFRESH_MS = 7 * 86400 * 1000;
const RETRY_MS = 3600 * 1000;
const MAX_SQL_BYTES = 90000; // D1 allows 100 KB per SQL statement
const MIN_SONGS = 10000;     // a broken download must never wipe the catalog
const VERSION = "4";         // bump to retry right away after a deploy instead of waiting out RETRY_MS

const SCHEMA = [
  // rowid = the app's song id (same as plays.song_id). Only title, artist and k are searchable.
  // k is title + artist without apostrophes, dots and slashes, so "dont stop" finds "Don't Stop
  // Believin'" and "acdc" finds AC/DC (catalog_api.js strips the same from searches).
  "CREATE VIRTUAL TABLE IF NOT EXISTS catalog USING fts5(title, artist, k, year UNINDEXED, duo UNINDEXED," +
    " explicit UNINDEXED, styles UNINDEXED, languages UNINDEXED, added UNINDEXED, pop UNINDEXED, h UNINDEXED," +
    " tokenize = 'unicode61 remove_diacritics 2')",
  "CREATE TABLE IF NOT EXISTS catalog_meta (k text primary key, v text)",
];

// catalog_order: a plain copy of the columns the Songbook filters and sorts on, with real indexes. The FTS
// table can only be searched by words or rowid, so browsing (no words typed) or a pill tap used to read and
// sort all ~90,000 songs; through these indexes it stops after the first page. Rebuilt after each import.
const ORDER_VERSION = "1";
const ORDER_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS catalog_order (id integer primary key, pop integer, added text, year integer, duo integer," +
    " styles text, languages text, artist text, k text)",
  "CREATE INDEX IF NOT EXISTS catalog_order_pop ON catalog_order (pop)",
  "CREATE INDEX IF NOT EXISTS catalog_order_added ON catalog_order (added, pop)",
  "CREATE INDEX IF NOT EXISTS catalog_order_year ON catalog_order (year, pop)",
  "CREATE INDEX IF NOT EXISTS catalog_order_k ON catalog_order (k)",
];
export async function rebuildOrder(env) {
  for (const s of ORDER_SCHEMA) await env.DB.prepare(s).run();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM catalog_order"),
    env.DB.prepare("INSERT INTO catalog_order (id, pop, added, year, duo, styles, languages, artist, k)" +
      " SELECT rowid, CAST(pop AS INTEGER), added, CAST(NULLIF(year, '') AS INTEGER), CAST(duo AS INTEGER), styles, languages, artist, k FROM catalog"),
    env.DB.prepare("INSERT OR REPLACE INTO catalog_meta (k, v) VALUES ('order_version', ?)").bind(ORDER_VERSION),
  ]);
}

export const searchKey = (title, artist) => (title + " " + artist).replace(/['‘’`./]/g, "").toLowerCase();

// Ranks shift a little every week. Only re-send a song when its rank moves by about 10%.
const popBucket = (pop) => Math.round(Math.log2(pop) * 8);

function fnv(s) { // short, stable hash of a song's fields
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// SQL literal. Values come from the downloaded song list; strings are quoted with '' escaping.
const lit = (v) => v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/\u0000/g, "").replace(/'/g, "''") + "'";
const COLS = ["rowid", "title", "artist", "k", "year", "duo", "explicit", "styles", "languages", "added", "pop", "h"];
const enc = new TextEncoder();

export function insertStatements(songs) {
  const head = "INSERT OR REPLACE INTO catalog (" + COLS.join(",") + ") VALUES ";
  const out = []; let tuples = [], size = head.length;
  for (const s of songs) {
    const t = "(" + [s.id, s.title, s.artist, searchKey(s.title, s.artist), s.year, s.duo, s.explicit, s.styles, s.languages, s.added, s.pop, s.h].map(lit).join(",") + ")";
    const n = enc.encode(t).length + 1;
    if (tuples.length && size + n > MAX_SQL_BYTES) { out.push(head + tuples.join(",")); tuples = []; size = head.length; }
    tuples.push(t); size += n;
  }
  if (tuples.length) out.push(head + tuples.join(","));
  return out;
}

// ---- Reading the file ----

// The download is a zip holding one XML file (~12 MB zipped, ~180 MB unzipped), too big to hold in a
// Worker's memory, so it is unzipped and read as it streams in. A zip entry is a 30-byte header, the file
// name and extra field, then the deflated data (method 8), whose length the header gives.
export function unzipFirstEntry(body) {
  const reader = body.getReader();
  let buf = new Uint8Array(0), left = -1;
  const deflated = new ReadableStream({
    async pull(ctrl) {
      for (;;) {
        if (left === 0) { ctrl.close(); reader.cancel().catch(() => {}); return; }
        const { done, value } = await reader.read();
        if (done) { if (left > 0 && left !== Infinity) ctrl.error(new Error("song list download was cut short")); else ctrl.close(); return; }
        if (left < 0) {
          const b = new Uint8Array(buf.length + value.length); b.set(buf); b.set(value, buf.length); buf = b;
          if (buf.length < 30) continue;
          const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          if (dv.getUint32(0, true) !== 0x04034b50) { ctrl.error(new Error("song list download is not a zip file")); return; }
          if (dv.getUint16(8, true) !== 8) { ctrl.error(new Error("song list zip uses an unknown compression")); return; }
          const flags = dv.getUint16(6, true), size = dv.getUint32(18, true);
          const start = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
          if (buf.length < start) continue;
          // Bit 3: sizes come after the data. Read to the end; the inflater stops at the end of the data.
          left = (flags & 8) && !size ? Infinity : size;
          const rest = buf.subarray(start); buf = null;
          if (rest.length) { const n = Math.min(rest.length, left); ctrl.enqueue(rest.subarray(0, n)); left -= n; }
          return;
        }
        const n = Math.min(value.length, left);
        ctrl.enqueue(n === value.length ? value : value.subarray(0, n)); left -= n;
        return;
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
  return deflated.pipeThrough(new DecompressionStream("deflate-raw")).pipeThrough(new TextDecoderStream());
}

const ENT = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">" };
export const unescapeXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m);

// One <artist>...</artist> block -> its songs: {kv, title, artist, rank, kfn, preview}. preview: the file id
// of the song's 30-second preview (https://www.karaoke-version.com/preview/<id>/). kfn: on sale in the
// karaoke app's own file format, i.e. a song the karaoke app can play.
export function songsFromArtist(block) {
  const name = /<name>([^<]*)<\/name>/.exec(block);
  if (!name) return [];
  const artist = unescapeXml(name[1]).trim(), out = [];
  const re = /<song id="(\d+)">([\s\S]*?)<\/song>/g; let m;
  while ((m = re.exec(block))) {
    const title = /<name>([^<]*)<\/name>/.exec(m[2]), rank = /<rank>(\d+)<\/rank>/.exec(m[2]);
    if (!title) continue;
    const prev = /<preview>https?:\/\/[^<]*\/preview\/(\d+)\/?<\/preview>/.exec(m[2]);
    out.push({ kv: Number(m[1]), title: unescapeXml(title[1]).trim(), artist, rank: rank ? Number(rank[1]) : 1e9,
      kfn: /format="KFN"[^>]*track_type="KAR"/.test(m[2]), preview: prev ? Number(prev[1]) : null });
  }
  return out;
}

// Text stream of the XML -> every song in it, one artist block at a time.
export async function songsFromXml(text) {
  const reader = text.getReader(), songs = [];
  let buf = "", sawEnd = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += value;
    let cut = buf.lastIndexOf("</artist>");
    if (cut >= 0) {
      cut += 9;
      const part = buf.slice(0, cut); buf = buf.slice(cut);
      const re = /<artist id="\d+">([\s\S]*?)<\/artist>/g; let m;
      while ((m = re.exec(part))) for (const s of songsFromArtist(m[1])) songs.push(s);
    }
    if (buf.includes("</artists>")) sawEnd = true;
    if (done) break;
  }
  if (!sawEnd) throw new Error("song list ended early (" + songs.length + " songs read)");
  return songs;
}

async function downloadSongs() {
  // A stuck download must end in an error we can see (catalog_meta.last_error), not a silent timeout.
  const r = await fetch(KV_ZIP, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(180000) });
  if (!r.ok || !r.body) throw new Error("song list download said " + r.status);
  return songsFromXml(unzipFirstEntry(r.body));
}

// ---- Building the rows ----

// Duet guess from the file's own artist and title, since the file has no duet flag:
// "Shania Twain & Bryan White", "Lady Gaga feat. Bradley Cooper", "Islands in the Stream (Duet)".
export const looksLikeDuet = (title, artist) =>
  /\s(&|and|with|feat\.?|featuring|ft\.?|x|duet with)\s/i.test(" " + artist + " ") || /\bduet\b/i.test(title) ? 1 : 0;

// Songs from the file -> the new catalog rows.
//   sung: Map(matchKey -> song_id) of songs sung at our bars (the plays table, from the host's own laptop).
//         A file song that matches one keeps that id, so the catalog's rowid stays equal to plays.song_id
//         (drafts and requests look songs up by it).
//   prev: Map(id -> {added}) of rows from earlier imports of this file, to keep their "added" date.
//   details: {years, genres, langs} found so far from open data (details_import.js loadDetails).
// Only songs on sale in the karaoke app's file format (kfn) are listed, plus any song sung here.
// Titles, artists and ranks come from the file; years, genres and languages only from open data.
export function buildCatalog(kvSongs, sung, prev, today, details = {}) {
  const years = details.years || new Map(), genres = details.genres || new Map(), langs = details.langs || new Map();
  const used = new Set(), out = [];
  for (const s of [...kvSongs].sort((a, b) => a.rank - b.rank)) {
    if (!s.title) continue;
    const key = matchKey(s.title, s.artist);
    let id = sung.get(key);
    if (id == null || used.has(id)) { if (!s.kfn) continue; id = KV_ID_BASE + s.kv; }
    if (used.has(id)) continue;
    used.add(id);
    const old = prev.get(id);
    const row = { id, title: s.title, artist: s.artist, year: years.get(key) || null, duo: looksLikeDuet(s.title, s.artist), explicit: 0,
      styles: stylesFor(genres.get(s.artist), s.title), languages: langs.get(s.artist) || "",
      added: old ? old.added || "" : today, pop: out.length + 1, kv: s.kv, preview: s.preview };
    row.h = fnv(JSON.stringify([row.title, row.artist, row.year, row.duo, row.explicit, row.styles, row.languages, row.added, popBucket(row.pop)]));
    out.push(row);
  }
  return out;
}

async function setMeta(env, pairs) {
  await env.DB.batch(Object.entries(pairs).map(([k, v]) => env.DB.prepare("INSERT OR REPLACE INTO catalog_meta (k, v) VALUES (?, ?)").bind(k, String(v))));
}

export async function importCatalog(env, now = Date.now(), firstImport = false) {
  for (const sql of SCHEMA) await env.DB.prepare(sql).run();
  // catalog_meta.stage: how far the last import got, so a run the platform cuts off still says where.
  const stage = (v) => setMeta(env, { stage: v + " " + new Date().toISOString() }).catch(() => {});
  await stage("downloading");
  const kvSongs = await downloadSongs();
  await stage("read " + kvSongs.length + " songs");
  // What's in D1 now, paged by rowid so no single result gets huge.
  const existing = [];
  for (let last = -1; ;) {
    const { results } = await env.DB.prepare("SELECT rowid AS id, added, h FROM catalog WHERE rowid > ? ORDER BY rowid LIMIT 20000").bind(last).all();
    existing.push(...results);
    if (results.length < 20000) break;
    last = results[results.length - 1].id;
  }
  // The first import from this file replaces the old list entirely, so no row's date carries over and
  // nothing is marked "just added" (it would mark all of them).
  const prev = new Map(firstImport ? [] : existing.map((r) => [Number(r.id), r]));
  const sung = new Map();
  try {
    const { results } = await env.DB.prepare("SELECT song_id AS id, title, artist FROM plays WHERE song_id IS NOT NULL AND song_id < ? AND title IS NOT NULL GROUP BY song_id").bind(1e9).all();
    for (const r of results) { const k = matchKey(r.title, r.artist); if (!sung.has(k)) sung.set(k, Number(r.id)); }
  } catch (e) { /* no plays yet */ }
  const songs = buildCatalog(kvSongs, sung, prev, firstImport ? "" : new Date(now).toISOString().slice(0, 10), await loadDetails(env));
  if (songs.length < MIN_SONGS) throw new Error("song list download looks wrong (" + songs.length + " songs from " + kvSongs.length + ")");
  const have = new Map(existing.map((r) => [Number(r.id), r.h]));
  const todo = songs.filter((s) => have.get(s.id) !== s.h);
  await stage("writing " + todo.length + " songs");
  const stmts = insertStatements(todo);
  for (let i = 0; i < stmts.length; i += 5) await env.DB.batch(stmts.slice(i, i + 5).map((sql) => env.DB.prepare(sql)));
  const ids = new Set(songs.map((s) => s.id)), gone = [...have.keys()].filter((id) => !ids.has(id));
  for (let i = 0; i < gone.length; i += 500) await env.DB.prepare("DELETE FROM catalog WHERE rowid IN (" + gone.slice(i, i + 500).join(",") + ")").run();
  await stage("indexing");
  if (todo.length || gone.length) await rebuildOrder(env);
  await stage("queueing details");
  await seedDetails(env, songs);
  await stage("done"); // queue years, genres and languages to look up (details_import.js)
  return { songs: songs.length, in_file: kvSongs.length, sung_here: songs.filter((s) => s.id < KV_ID_BASE).length, sent: todo.length, removed: gone.length };
}

// Called by the every-minute cron. Cheap unless an import is due.
export async function maybeImportCatalog(env, now = Date.now()) {
  let meta = {};
  try {
    const { results } = await env.DB.prepare("SELECT k, v FROM catalog_meta").all();
    meta = Object.fromEntries(results.map((r) => [r.k, r.v]));
  } catch (e) { /* first run: no table yet */ }
  const updated = Date.parse(meta.updated || "") || 0, tried = Number(meta.last_attempt) || 0;
  const due = now - updated >= REFRESH_MS || meta.source !== SOURCE;
  if (!due || (now - tried < RETRY_MS && meta.version === VERSION)) {
    // The browse copy is missing or from an older layout (first run after a deploy): build it once.
    if (Number(meta.count) > 0 && meta.order_version !== ORDER_VERSION) await rebuildOrder(env);
    return null;
  }
  await env.DB.prepare(SCHEMA[1]).run();
  await setMeta(env, { last_attempt: now, version: VERSION });
  try {
    const r = await importCatalog(env, now, meta.source !== SOURCE);
    await setMeta(env, { count: r.songs, updated: new Date(now).toISOString(), source: SOURCE, last_result: JSON.stringify(r), last_error: "" });
    return r;
  } catch (e) {
    // Songs already sent stay sent; the next try (an hour later) only sends what's still missing.
    await setMeta(env, { last_error: String(e && e.message || e).slice(0, 300) }).catch(() => {});
    return { error: String(e) };
  }
}
