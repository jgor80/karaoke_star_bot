// Privacy: the host's "remove this singer" action, the names it hides from then on, and the daily
// clean-up of rate-limit data. The public notice is privacy.html (okenight.com/privacy).
//
// POST /api/host {action:"singer_erase", singer}  (host key)  takes a singer's name off this venue's site:
//   - their plays are kept for the song and night counts, but the name becomes "Removed singer NNNN"
//     (the same label for all their songs, so nothing on the site links back to them);
//   - reactions copied from those plays get the same label, typed names (reaction "who", draft
//     "by_name") that match become "Anon", and crowd draft picks naming them are taken down;
//   - the name goes on this venue's removed list (host_config "erased_singers"), so songs they sing
//     later, and the live queue, are relabelled too (sweepErased runs from the cron every minute).
//     The list keeps a folded match key only (see matchKey), to know whom to hide. Spellings the site
//     merges ("Amy (fin)", "Vincent Vega (Amy)", accents, spacing) and duets ("Amy & Bob") match too,
//     and the name is dropped from song request "from" lists.
// GET /api/host lists the removed names as erased_singers so the host can see who has asked.
//
// dailyCleanup(env) runs once a day from the cron. Device IDs and IP hashes are only for rate limits,
// so after RETAIN_DAYS they are blanked. Seconds and request asks keep their row (they are counted)
// with the device ID swapped for a meaningless "old<rowid>". Bar leads are deleted after LEAD_DAYS.
import { cfgKey } from "./venues.js";
import { singerKey } from "./drafts_api.js";

export const RETAIN_DAYS = 90;
export const LEAD_DAYS = 365;
const KEY = "erased_singers";
const MAX_NAME = 80;

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
// How names are compared: like the site's own name merging (fun.js canonicalize), but also folding accents,
// so "Élodie", "elodie " and "E-lodie" are one person. SQLite's lower() only folds ASCII, so matching is
// done here in JS and the database is updated by exact stored spelling.
export const matchKey = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
// Same split as fun.js SPLIT: "Amy & Bob", "Amy, Bob", "Amy and Bob", "Amy n Bob", "Amy + Bob", "Amy/Bob".
const SPLIT = /(\s*(?:,|&|\/|\band\b|\bn\b|\+)\s*)/i;

async function readList(env, venue) {
  const row = await env.DB.prepare("SELECT v FROM host_config WHERE k = ?").bind(cfgKey(venue, KEY)).first().catch(() => null);
  try {
    const v = JSON.parse((row && row.v) || "[]");
    // Older entries kept the lowercased name; matchKey() of that is the same key.
    return Array.isArray(v) ? v.filter((x) => x && x.k && x.as).map((x) => ({ ...x, k: matchKey(x.k) })).filter((x) => x.k) : [];
  } catch (e) { return []; }
}

// The removed names for this venue: [{k: match key, as: label, at: unix seconds}].
export const erasedSingers = readList;

// What a stored singer name should become, or null when it names nobody on the list.
//   "Amy" / "amy " / "Amy (fin)" / "Vincent Vega (Amy)"   -> the label
//   "Amy & Bob"                                          -> "Removed singer 1234 & Bob"
function relabelName(list, name) {
  if (!name || !list.length) return null;
  const s = clean(name);
  const hit = (x) => { const k = matchKey(x); return k ? list.find((e) => e.k === k) : null; };
  let e = hit(s) || hit(s.replace(/\([^)]*\)/g, " "));
  if (!e) { const m = /\(([^)]+)\)/.exec(s); if (m) e = hit(m[1]); }
  if (e) return e.as;
  const parts = s.split(SPLIT);
  if (parts.length > 1) {
    let changed = false;
    const out = parts.map((part, i) => { if (i % 2) return part; const h = hit(part) || hit(part.replace(/\([^)]*\)/g, " ")); if (h) { changed = true; return h.as; } return part; });
    if (changed) return out.join("");
  }
  return null;
}

// Map a singer name to what the site shows. Used for the live queue, which the laptop rewrites.
export function relabel(list, name) {
  return relabelName(list, name) || name;
}

// Relabels every stored spelling in one column that names someone on the list.
// sinceNight limits it to recent nights (the cron sweep); null means all rows.
async function relabelColumn(env, venue, list, table, col, anon, sinceNight) {
  const where = "venue = ?" + (sinceNight ? " AND night >= ?" : "");
  const args = sinceNight ? [venue.slug, sinceNight] : [venue.slug];
  const { results } = await env.DB.prepare("SELECT DISTINCT " + col + " AS v FROM " + table + " WHERE " + where + " AND " + col + " IS NOT NULL AND " + col + " <> ''").bind(...args).all();
  const stmts = [];
  for (const r of results) {
    const to = relabelName(list, r.v);
    if (to && to !== r.v) stmts.push(env.DB.prepare("UPDATE " + table + " SET " + col + " = ? WHERE " + where + " AND " + col + " = ?").bind(anon || to, ...args, r.v));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

// Song request "from" names: "Amy, Bob" -> drop Amy.
async function cleanRequestNames(env, venue, list) {
  const { results } = await env.DB.prepare("SELECT id, names FROM song_requests WHERE venue = ? AND names IS NOT NULL AND names <> ''").bind(venue.slug).all();
  const stmts = [];
  for (const r of results) {
    const kept = String(r.names).split(/\s*,\s*/).filter((n) => n && !relabelName(list, n));
    const v = kept.join(", ");
    if (v !== r.names) stmts.push(env.DB.prepare("UPDATE song_requests SET names = ? WHERE id = ?").bind(v || null, r.id));
  }
  if (stmts.length) await env.DB.batch(stmts);
}

function label() {
  const n = new Uint16Array(1); crypto.getRandomValues(n);
  return "Removed singer " + String(1000 + (n[0] % 9000));
}

export async function eraseSinger(env, body, venue) {
  const name = clean(body.singer);
  const k = matchKey(name);
  if (!k) return { error: "Type the singer’s name as it shows on the site." };
  const list = await readList(env, venue);
  let e = list.find((x) => x.k === k);
  if (!e) { e = { k, as: label(), at: Math.floor(Date.now() / 1000) }; list.push(e); }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES (?, ?)").bind(cfgKey(venue, KEY), JSON.stringify(list)).run();
  const changed = await relabelColumn(env, venue, [e], "plays", "singer", null, null);
  // The crowd tables only exist once someone has used them, so each of these may have nothing to do.
  const jobs = [
    () => relabelColumn(env, venue, [e], "reactions", "singer", null, null),
    () => relabelColumn(env, venue, [e], "reactions", "who", "Anon", null),
    () => relabelColumn(env, venue, [e], "drafts", "by_name", "Anon", null),
    () => cleanRequestNames(env, venue, [e]),
    async () => {
      const { results } = await env.DB.prepare("SELECT DISTINCT singer, singer_key FROM drafts WHERE venue = ? AND removed_at IS NULL").bind(venue.slug).all();
      for (const r of results) if (relabelName([e], r.singer)) {
        await env.DB.prepare("UPDATE drafts SET singer = ?, singer_key = ?, removed_at = coalesce(removed_at, ?) WHERE venue = ? AND singer_key = ?")
          .bind(e.as, singerKey(e.as), now, venue.slug, r.singer_key).run();
      }
    },
  ];
  for (const job of jobs) await job().catch(() => {});
  return { ok: true, label: e.as, changed };
}

// Songs a removed singer sang after the removal (uploaded later by the laptop) get their label too.
// Only the last couple of nights are checked, so this stays cheap as the history grows.
export async function sweepErased(env, venue) {
  const list = await readList(env, venue);
  if (!list.length) return;
  const since = new Date(Date.now() - 2 * 86400 * 1000).toISOString().slice(0, 10);
  await relabelColumn(env, venue, list, "plays", "singer", null, since);
  await relabelColumn(env, venue, list, "reactions", "singer", null, since).catch(() => {});
}

// Once a day (the cron calls it every minute; it only does work in one minute of the day).
export async function dailyCleanup(env, when = Date.now()) {
  const d = new Date(when);
  if (d.getUTCHours() !== 11 || d.getUTCMinutes() !== 7) return false; // 5 or 6am in Chicago, after any night
  const now = Math.floor(when / 1000), cut = now - RETAIN_DAYS * 86400, leadCut = now - LEAD_DAYS * 86400;
  const stmts = [
    ["UPDATE reactions SET device_id = '', ip_hash = NULL WHERE created_at < ? AND (device_id <> '' OR ip_hash IS NOT NULL)", cut],
    ["UPDATE drafts SET device_id = '', ip_hash = NULL WHERE created_at < ? AND (device_id <> '' OR ip_hash IS NOT NULL)", cut],
    ["UPDATE draft_votes SET device_id = 'old' || rowid, ip_hash = NULL WHERE created_at < ? AND device_id NOT LIKE 'old%'", cut],
    ["UPDATE song_request_asks SET device_id = 'old' || rowid, ip_hash = NULL WHERE created_at < ? AND device_id NOT LIKE 'old%'", cut],
    ["DELETE FROM leads WHERE created_at < ?", leadCut],
  ];
  // One at a time: a table that doesn't exist yet (nothing ever posted to it) shouldn't stop the rest.
  for (const [sql, v] of stmts) await env.DB.prepare(sql).bind(v).run().catch(() => {});
  return true;
}
