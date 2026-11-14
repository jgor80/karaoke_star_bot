// Weekly import of KaraFun's song catalog into D1, for the Songbook (catalog_api.js serves it).
//
// KaraFun publishes its whole catalog as a CSV on https://www.karafun.com/karaoke-song-list.html
// (about 90,000 songs: Id;Title;Artist;Year;Duo;Explicit;Date Added;Styles;Languages, most popular
// first). The every-minute cron calls maybeImportCatalog(); it does nothing unless the catalog is
// missing or over a week old, and tries at most once an hour. Each song row keeps a hash (h) of
// what was sent, so a weekly refresh only writes the songs that changed.

const LIST_PAGE = "https://www.karafun.com/karaoke-song-list.html";
// The CSV link on that page, as of 2026-11. The page is checked first in case it changes.
const FALLBACK_CSV = "https://www.karafun.com/cl/3107312/0c8ccb4b46a410fe3c690a810796d814/";
const UA = "OkeNight/1.0 (weekly download of the public KaraFun song list; okenight.com)";
const REFRESH_MS = 7 * 86400 * 1000;
const RETRY_MS = 3600 * 1000;
const MAX_SQL_BYTES = 90000; // D1 allows 100 KB per SQL statement
const MIN_SONGS = 10000;     // a broken download must never wipe the catalog
const VERSION = "2";         // bump to retry right away after a deploy instead of waiting out RETRY_MS

const SCHEMA = [
  // rowid = KaraFun song id (same as plays.song_id). Only title, artist and k are searchable.
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

// Semicolon CSV with "quoted" fields and "" escapes -> array of rows (arrays of strings).
export function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ";") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); f = "";
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
    } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

// Ranks shift a little every week. Only re-send a song when its rank moves by about 10%.
const popBucket = (pop) => Math.round(Math.log2(pop) * 8);

function fnv(s) { // short, stable hash of a song's fields
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

export function songsFromCsv(text) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const head = rows.shift() || [];
  const col = (name) => head.indexOf(name);
  const I = { id: col("Id"), title: col("Title"), artist: col("Artist"), year: col("Year"), duo: col("Duo"),
    explicit: col("Explicit"), added: col("Date Added"), styles: col("Styles"), languages: col("Languages") };
  if (I.id < 0 || I.title < 0) throw new Error("catalog CSV has unexpected columns: " + head.join(";").slice(0, 120));
  const seen = new Set(), out = [];
  for (const r of rows) {
    const id = toInt(r[I.id]), title = (r[I.title] || "").trim();
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const s = { id, title, artist: (r[I.artist] || "").trim(), year: toInt(r[I.year]), duo: r[I.duo] === "1" ? 1 : 0,
      explicit: r[I.explicit] === "1" ? 1 : 0, styles: (r[I.styles] || "").trim(), languages: (r[I.languages] || "").trim(),
      added: (r[I.added] || "").trim(), pop: out.length + 1 };
    s.h = fnv(JSON.stringify([s.title, s.artist, s.year, s.duo, s.explicit, s.styles, s.languages, s.added, popBucket(s.pop)]));
    out.push(s);
  }
  return out;
}

// SQL literal. Values come from KaraFun's CSV; strings are quoted with '' escaping.
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

async function get(url) {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error("KaraFun said " + r.status + " for " + url);
  return r;
}

// The song list page links several downloads under /cl/ (PDF catalogs and the CSV), so try each
// link, the one next to "CSV" first, and keep the first that really is the CSV.
async function csvUrls() {
  const urls = [];
  try {
    const page = await (await get(LIST_PAGE)).text();
    const re = /<a[^>]+href="(https:\/\/www\.karafun\.com\/cl\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m; const csvFirst = [], rest = [];
    while ((m = re.exec(page))) (/csv/i.test(m[2]) ? csvFirst : rest).push(m[1]);
    urls.push(...csvFirst, ...rest);
  } catch (e) {}
  urls.push(FALLBACK_CSV);
  return [...new Set(urls)].slice(0, 8);
}

async function downloadCsv() {
  const tried = [];
  for (const url of await csvUrls()) {
    try {
      const r = await get(url);
      const type = r.headers.get("content-type") || "";
      if (!/csv|text\/plain/i.test(type)) { tried.push(url + " (" + type + ")"); await r.body?.cancel(); continue; }
      const text = await r.text();
      if (/^\uFEFF?Id;Title;/.test(text)) return text;
      tried.push(url + " (not the song CSV)");
    } catch (e) { tried.push(url + " (" + e.message + ")"); }
  }
  throw new Error("no catalog CSV found; tried " + tried.join(", "));
}

async function setMeta(env, pairs) {
  await env.DB.batch(Object.entries(pairs).map(([k, v]) => env.DB.prepare("INSERT OR REPLACE INTO catalog_meta (k, v) VALUES (?, ?)").bind(k, String(v))));
}

export async function importCatalog(env) {
  for (const s of SCHEMA) await env.DB.prepare(s).run();
  const songs = songsFromCsv(await downloadCsv());
  if (songs.length < MIN_SONGS) throw new Error("catalog download looks wrong (" + songs.length + " songs)");
  // What's in D1 now, paged by rowid so no single result gets huge.
  const have = new Map();
  for (let last = 0; ;) {
    const { results } = await env.DB.prepare("SELECT rowid AS id, h FROM catalog WHERE rowid > ? ORDER BY rowid LIMIT 20000").bind(last).all();
    results.forEach((r) => have.set(r.id, r.h));
    if (results.length < 20000) break;
    last = results[results.length - 1].id;
  }
  const todo = songs.filter((s) => have.get(s.id) !== s.h);
  const stmts = insertStatements(todo);
  for (let i = 0; i < stmts.length; i += 5) await env.DB.batch(stmts.slice(i, i + 5).map((s) => env.DB.prepare(s)));
  const ids = new Set(songs.map((s) => s.id)), gone = [...have.keys()].filter((id) => !ids.has(id));
  for (let i = 0; i < gone.length; i += 500) await env.DB.prepare("DELETE FROM catalog WHERE rowid IN (" + gone.slice(i, i + 500).join(",") + ")").run();
  if (todo.length || gone.length) await rebuildOrder(env);
  return { songs: songs.length, sent: todo.length, removed: gone.length };
}

// Called by the every-minute cron. Cheap unless an import is due.
export async function maybeImportCatalog(env, now = Date.now()) {
  let meta = {};
  try {
    const { results } = await env.DB.prepare("SELECT k, v FROM catalog_meta").all();
    meta = Object.fromEntries(results.map((r) => [r.k, r.v]));
  } catch (e) { /* first run: no table yet */ }
  const updated = Date.parse(meta.updated || "") || 0, tried = Number(meta.last_attempt) || 0;
  if (now - updated < REFRESH_MS || (now - tried < RETRY_MS && meta.version === VERSION)) {
    // The browse copy is missing or from an older layout (first run after a deploy): build it once.
    if (Number(meta.count) > 0 && meta.order_version !== ORDER_VERSION) await rebuildOrder(env);
    return null;
  }
  await env.DB.prepare(SCHEMA[1]).run();
  await setMeta(env, { last_attempt: now, version: VERSION });
  try {
    const r = await importCatalog(env);
    await setMeta(env, { count: r.songs, updated: new Date(now).toISOString(), last_result: JSON.stringify(r), last_error: "" });
    return r;
  } catch (e) {
    // Songs already sent stay sent; the next try (an hour later) only sends what's still missing.
    await setMeta(env, { last_error: String(e && e.message || e).slice(0, 300) }).catch(() => {});
    return { error: String(e) };
  }
}
