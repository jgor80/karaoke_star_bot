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
//     The list keeps the lowercased name only, to know whom to hide.
// GET /api/host lists the removed names as erased_singers so the host can see who has asked.
//
// dailyCleanup(env) runs once a day from the cron. Device IDs and IP hashes are only for rate limits,
// so after RETAIN_DAYS they are blanked. Seconds, request asks and reactions keep their row (they are
// counted) with the device ID swapped for a meaningless "old<n>". Bar leads are deleted after LEAD_DAYS.
import { cfgKey } from "./venues.js";
import { singerKey } from "./drafts_api.js";

export const RETAIN_DAYS = 90;
export const LEAD_DAYS = 365;
const KEY = "erased_singers";
const MAX_NAME = 80;

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
const keyOf = (s) => clean(s).toLowerCase();

async function readList(env, venue) {
  const row = await env.DB.prepare("SELECT v FROM host_config WHERE k = ?").bind(cfgKey(venue, KEY)).first().catch(() => null);
  try { const v = JSON.parse((row && row.v) || "[]"); return Array.isArray(v) ? v.filter((x) => x && x.k && x.as) : []; } catch (e) { return []; }
}

// The removed names for this venue: [{k: lowercased name, as: label, at: unix seconds}].
export const erasedSingers = readList;

// Map a singer name to what the site shows. Used for the live queue, which the laptop rewrites.
export function relabel(list, name) {
  if (!name || !list.length) return name;
  const k = keyOf(name);
  const hit = list.find((x) => x.k === k);
  return hit ? hit.as : name;
}

function label() {
  const n = new Uint16Array(1); crypto.getRandomValues(n);
  return "Removed singer " + String(1000 + (n[0] % 9000));
}

export async function eraseSinger(env, body, venue) {
  const name = clean(body.singer);
  if (name.length < 1) return { error: "Type the singer’s name as it shows on the site." };
  const k = name.toLowerCase();
  const list = await readList(env, venue);
  let e = list.find((x) => x.k === k);
  if (!e) { e = { k, as: label(), at: Math.floor(Date.now() / 1000) }; list.push(e); }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES (?, ?)").bind(cfgKey(venue, KEY), JSON.stringify(list)),
    env.DB.prepare("UPDATE plays SET singer = ? WHERE venue = ? AND lower(singer) = ?").bind(e.as, venue.slug, k),
  ]);
  // The crowd tables only exist once someone has used them, so each of these may have nothing to do.
  for (const st of [
    env.DB.prepare("UPDATE reactions SET singer = ? WHERE venue = ? AND lower(singer) = ?").bind(e.as, venue.slug, k),
    env.DB.prepare("UPDATE reactions SET who = 'Anon' WHERE venue = ? AND lower(who) = ?").bind(venue.slug, k),
    env.DB.prepare("UPDATE drafts SET by_name = 'Anon' WHERE venue = ? AND lower(by_name) = ?").bind(venue.slug, k),
    env.DB.prepare("UPDATE drafts SET singer = ?, singer_key = ?, removed_at = coalesce(removed_at, ?) WHERE venue = ? AND singer_key = ?")
      .bind(e.as, singerKey(e.as), now, venue.slug, singerKey(name)),
  ]) await st.run().catch(() => {});
  return { ok: true, label: e.as };
}

// Songs a removed singer sang after the removal (uploaded later by the laptop) get their label too.
export async function sweepErased(env, venue) {
  const list = await readList(env, venue);
  if (!list.length) return;
  await env.DB.batch(list.map((e) => env.DB.prepare("UPDATE plays SET singer = ? WHERE venue = ? AND lower(singer) = ?").bind(e.as, venue.slug, e.k)));
}

// Once a day (the cron calls it every minute; it only does work in one minute of the day).
export async function dailyCleanup(env, when = Date.now()) {
  const d = new Date(when);
  if (d.getUTCHours() !== 11 || d.getUTCMinutes() !== 7) return false; // 5 or 6am in Chicago, after any night
  const now = Math.floor(when / 1000), cut = now - RETAIN_DAYS * 86400, leadCut = now - LEAD_DAYS * 86400;
  const stmts = [
    // Reactions are counted as "how many phones" per song (count DISTINCT device_id), so each phone's ID is
    // swapped for a meaningless one that is only shared by that phone's taps on that one song.
    ["UPDATE reactions SET device_id = 'old' || m.first, ip_hash = NULL FROM (SELECT play_uuid AS p, device_id AS d, min(id) AS first" +
      " FROM reactions WHERE created_at < ?1 AND device_id NOT LIKE 'old%' GROUP BY play_uuid, device_id) AS m" +
      " WHERE reactions.play_uuid = m.p AND reactions.device_id = m.d AND reactions.created_at < ?1", cut],
    ["UPDATE drafts SET device_id = '', ip_hash = NULL WHERE created_at < ? AND (device_id <> '' OR ip_hash IS NOT NULL)", cut],
    ["UPDATE draft_votes SET device_id = 'old' || rowid, ip_hash = NULL WHERE created_at < ? AND device_id NOT LIKE 'old%'", cut],
    ["UPDATE song_request_asks SET device_id = 'old' || rowid, ip_hash = NULL WHERE created_at < ? AND device_id NOT LIKE 'old%'", cut],
    ["DELETE FROM leads WHERE created_at < ?", leadCut],
  ];
  // One at a time: a table that doesn't exist yet (nothing ever posted to it) shouldn't stop the rest.
  for (const [sql, v] of stmts) await env.DB.prepare(sql).bind(v).run().catch(() => {});
  return true;
}
