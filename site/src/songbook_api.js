// The host's own songbook, for venues that use their own songs (or have extras on top of the full catalog).
//
// The host uploads a CSV/TXT songbook on /host. The page parses it and sends rows in chunks to /api/host:
//   {action: "songbook_upload", rows: [[title, artist, year, genre, duet], ...], start: true|false, done: true|false}
//     Chunks go in under a staging venue ("<slug>~new") that no search sees. The last chunk (done) swaps them in
//     for the old songbook in one transaction, so an upload that stops halfway leaves the old songbook as it was.
//   {action: "songbook_source", source: "catalog" | "mine" | "both"}   which list the Songbook tab searches
//   {action: "songbook_clear"}
// Songs go into the D1 full-text table `songbook`, with the same columns as `catalog` (plus `venue`, the bar's slug)
// so /api/catalog can search either or both. Ids start at OWN_BASE so they never clash with catalog ids (plays.song_id).
// Settings are per venue in host_config via cfgKey (songbook_source, songbook_count, songbook_updated).
// Popularity: a song that's also in the full catalog gets that song's rank, so the Top 10 still means
// something; the rest follow in file order.
import { searchKey } from "./catalog_import.js";
import { DEFAULT_VENUE, cfgKey, venueConfig } from "./venues.js";

export const OWN_BASE = 1000000000;
export const MAX_OWN = 150000;
const CHUNK = 2000;
const UNRANKED = 1000000;
export const SOURCES = ["catalog", "mine", "both"];

const SCHEMA = [
  "CREATE VIRTUAL TABLE IF NOT EXISTS songbook USING fts5(title, artist, k, year UNINDEXED, duo UNINDEXED, explicit UNINDEXED," +
  " styles UNINDEXED, languages UNINDEXED, added UNINDEXED, pop UNINDEXED, venue UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')",
  "CREATE TABLE IF NOT EXISTS host_config (k text primary key, v text not null)",
];
let ready = null;
export function ensureSongbook(env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; });
  return ready;
}

// Which list the Songbook searches, and how big the host's songbook is. Read on most /api/catalog
// requests, so it's remembered for 30 seconds per Worker instance.
const memo = new Map();
export async function songbookConfig(env, venue = DEFAULT_VENUE) {
  const hit = memo.get(venue.slug);
  if (hit && Date.now() - hit.at < 30000) return hit.v;
  let cfg = {};
  try { cfg = await venueConfig(env, venue); } catch (e) { /* no host_config table yet */ }
  const count = Number(cfg.songbook_count) || 0;
  const v = { source: SOURCES.includes(cfg.songbook_source) && (count || cfg.songbook_source === "catalog") ? cfg.songbook_source : "catalog", count, updated: cfg.songbook_updated || null };
  memo.set(venue.slug, { v, at: Date.now() });
  return v;
}
export function forgetSongbookConfig(venue = DEFAULT_VENUE) { memo.delete(venue.slug); }

// {title, artist} for a song id from whichever list it belongs to (null if neither has it).
export async function listSongById(env, id) {
  try {
    const table = Number(id) >= OWN_BASE ? "songbook" : "catalog";
    const r = await env.DB.prepare("SELECT rowid AS id, title, artist FROM " + table + " WHERE rowid = ?1").bind(Number(id)).first();
    return r && r.title ? r : null;
  } catch (e) { return null; }
}

const lit = (v) => v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/\u0000/g, "").replace(/'/g, "''") + "'";
const clean = (s, n) => String(s == null ? "" : s).normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const truthy = (v) => /^(1|y|yes|true|x|duet|duo)$/i.test(String(v || "").trim());

const staging = (venue) => venue.slug + "~new";

export async function hostSongbookAction(env, body, venue = DEFAULT_VENUE) {
  await ensureSongbook(env);
  const set = (k, v) => env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES (?, ?)").bind(cfgKey(venue, k), String(v));
  if (body.action === "songbook_source") {
    if (!SOURCES.includes(body.source)) return { error: "bad source" };
    await set("songbook_source", body.source).run();
  } else if (body.action === "songbook_clear") {
    await env.DB.batch([env.DB.prepare("DELETE FROM songbook WHERE venue IN (?1, ?2)").bind(venue.slug, staging(venue)), set("songbook_count", 0), set("songbook_source", "catalog"), set("songbook_updated", new Date().toISOString())]);
  } else if (body.action === "songbook_upload") {
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, CHUNK) : [];
    const stage = staging(venue);
    if (body.start) await env.DB.prepare("DELETE FROM songbook WHERE venue = ?").bind(stage).run(); // a half-done earlier upload
    const have = body.start ? 0 : (await env.DB.prepare("SELECT count(*) AS n FROM songbook WHERE venue = ?").bind(stage).first()).n;
    // Ids carry on after the highest one in the table (all venues share it).
    const next = Number((await env.DB.prepare("SELECT max(rowid) AS m FROM songbook").first()).m || OWN_BASE - 1) + 1;
    if (have + rows.length > MAX_OWN) return { error: "That’s more than " + MAX_OWN.toLocaleString("en-US") + " songs." };
    const songs = [];
    rows.forEach((r, i) => {
      if (!Array.isArray(r)) return;
      const title = clean(r[0], 150), artist = clean(r[1], 150);
      if (!title) return;
      const y = parseInt(r[2], 10);
      songs.push({ n: have + i, id: next + songs.length, title, artist, k: searchKey(title, artist), year: y >= 1900 && y <= 2100 ? y : null,
        styles: clean(r[3], 120).split(/\s*[,/;|]\s*/).filter(Boolean).join(","), duo: truthy(r[4]) ? 1 : 0 });
    });
    // Rank songs that are in the full catalog like the catalog does.
    const rank = new Map();
    for (let i = 0; i < songs.length; i += 400) {
      const ks = songs.slice(i, i + 400).map((s) => s.k);
      try {
        const { results } = await env.DB.prepare("SELECT k, min(pop) AS pop FROM catalog WHERE k IN (" + ks.map(lit).join(",") + ") GROUP BY k").all();
        results.forEach((r) => rank.set(r.k, Number(r.pop)));
      } catch (e) { break; } // no catalog: file order it is
    }
    const head = "INSERT INTO songbook (rowid, title, artist, k, year, duo, explicit, styles, languages, added, pop, venue) VALUES ";
    const stmts = [];
    for (let i = 0; i < songs.length; i += 150) {
      stmts.push(env.DB.prepare(head + songs.slice(i, i + 150).map((s) =>
        "(" + [s.id, s.title, s.artist, s.k, s.year, s.duo, 0, s.styles, "", "", rank.get(s.k) || UNRANKED + s.n, stage].map(lit).join(",") + ")").join(",")));
    }
    for (let i = 0; i < stmts.length; i += 5) await env.DB.batch(stmts.slice(i, i + 5));
    if (body.done) {
      // Swap the new songbook in and the old one out together (a D1 batch is one transaction).
      const n = (await env.DB.prepare("SELECT count(*) AS n FROM songbook WHERE venue = ?").bind(stage).first()).n;
      await env.DB.batch([
        env.DB.prepare("DELETE FROM songbook WHERE venue = ?").bind(venue.slug),
        env.DB.prepare("UPDATE songbook SET venue = ?1 WHERE venue = ?2").bind(venue.slug, stage),
        set("songbook_count", n), set("songbook_updated", new Date().toISOString())]);
    }
    forgetSongbookConfig(venue);
    return { ok: true, added: songs.length };
  } else return { error: "unknown action" };
  forgetSongbookConfig(venue);
  return { ok: true };
}
