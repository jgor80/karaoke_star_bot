// The bar owner's report: numbers from one karaoke night, compared with the nights before it.
// Numbers only, on purpose: no song titles and no singer names (Jeff, 2026-11-14).
//
// GET /<slug>/api/report?night=YYYY-MM-DD  -> {night, nights: [...], stats, compare, hours: [...]} (default: latest night)
// GET /<slug>/report                         the page that shows it (report.html)
// sendReports(env, venue)                    cron: the morning after a night, push the report link to the host and owner
// hostReportAction(env, body, venue)         /host: make (or turn off) the owner's alert topic
import { cfgKey, venueConfig } from "./venues.js";
import { scheduleStatus } from "./schedule.js";

const json = (body, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache } });
const NIGHT_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPARE_N = 4;      // compare with the average of this many nights before
const SEND_HOUR = 11;     // push the report at 11am (venue time) the day after a night
const pkey = (s) => String(s || "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]/g, "");
const isGroup = (s) => /^table\s*\d+/i.test(s || "") || /\s*(?:,|&|\/|\band\b|\+)\s*/i.test(String(s || "").trim());
const partsOf = (s) => isGroup(s) ? String(s).split(/\s*(?:,|&|\/|\band\b|\+)\s*/i).map(pkey).filter(Boolean) : [pkey(s)].filter(Boolean);

const hourOf = (ts, tz) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date(ts * 1000))) % 24;
const clockOf = (ts, tz) => new Date(ts * 1000).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });

async function hostKeyOf(env, venue) {
  const cfg = await venueConfig(env, venue).catch(() => ({}));
  return { cfg, host: pkey(cfg.host_name === undefined ? venue.host_default : cfg.host_name) };
}

// Everything the report needs from one night's rows. People are counted by name parts, so "Dave & Sue" counts both.
function nightStats(rows, before, host, tz) {
  const ppl = new Set(), guests = new Set();
  rows.forEach((p) => partsOf(p.singer).forEach((k) => { ppl.add(k); if (k !== host) guests.add(k); }));
  const seen = new Set(); before.forEach((p) => partsOf(p.singer).forEach((k) => seen.add(k)));
  const first = rows[0], last = rows[rows.length - 1];
  const span = rows.length ? Math.max(0, last.played_at + (Number(last.length_s) || 240) - first.played_at) : 0;
  const hours = {}; rows.forEach((p) => { const h = hourOf(p.played_at, tz); hours[h] = (hours[h] || 0) + 1; });
  const busiest = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
  const hostSongs = rows.filter((p) => partsOf(p.singer).includes(host)).length;
  return {
    songs: rows.length,
    guest_songs: rows.length - hostSongs,
    host_songs: hostSongs,
    singers: guests.size,
    first_timers: [...guests].filter((k) => !seen.has(k)).length,
    returning: [...guests].filter((k) => seen.has(k)).length,
    groups: rows.filter((p) => isGroup(p.singer)).length,
    start: first ? clockOf(first.played_at, tz) : null,
    end: last ? clockOf(last.played_at, tz) : null,
    hours_singing: Math.round(span / 360) / 10,
    songs_per_hour: span > 600 ? Math.round((rows.length / (span / 3600)) * 10) / 10 : null,
    busiest_hour: busiest ? Number(busiest[0]) : null,
    by_hour: hours,
  };
}

export async function handleReport(req, env, venue, url) {
  const { results: all } = await env.DB.prepare("SELECT uuid, night, played_at, singer, length_s FROM plays WHERE venue = ?1 AND night IS NOT NULL ORDER BY played_at").bind(venue.slug).all();
  const byNight = new Map(); all.forEach((p) => { p.played_at = Number(p.played_at); (byNight.get(p.night) || byNight.set(p.night, []).get(p.night)).push(p); });
  const nights = [...byNight.keys()].sort();
  if (!nights.length) return json({ venue: venue.name, nights: [], stats: null });
  const want = url.searchParams.get("night");
  const night = want && NIGHT_RE.test(want) && byNight.has(want) ? want : nights[nights.length - 1];
  const idx = nights.indexOf(night), rows = byNight.get(night);
  const { host } = await hostKeyOf(env, venue);
  const before = all.filter((p) => p.night < night);
  const stats = nightStats(rows, before, host, venue.tz);

  // Regulars: guests who sang on 2+ of the 4 nights before. How many came back, and how many of last week's singers returned.
  const prev = nights.slice(Math.max(0, idx - COMPARE_N), idx);
  const tonightPpl = new Set(); rows.forEach((p) => partsOf(p.singer).forEach((k) => tonightPpl.add(k)));
  const nightsOf = new Map();
  prev.forEach((n) => new Set(byNight.get(n).flatMap((p) => partsOf(p.singer))).forEach((k) => { if (k !== host) nightsOf.set(k, (nightsOf.get(k) || 0) + 1); }));
  const regulars = [...nightsOf.entries()].filter(([, c]) => c >= 2).map(([k]) => k);
  stats.regulars = regulars.length;
  stats.regulars_came = regulars.filter((k) => tonightPpl.has(k)).length;
  const lastWeek = prev.length ? new Set(byNight.get(prev[prev.length - 1]).flatMap((p) => partsOf(p.singer)).filter((k) => k !== host)) : null;
  stats.last_week_back = lastWeek && lastWeek.size ? Math.round((100 * [...lastWeek].filter((k) => tonightPpl.has(k)).length) / lastWeek.size) : null;

  // Crowd: applause scores (0-10, 2.5 dB per point like the site) and phones taking part.
  const uuids = rows.map((p) => p.uuid);
  const inList = uuids.map(() => "?").join(",");
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all().catch(() => ({ results: [] }))).results;
  const crowd = uuids.length ? await q("SELECT over FROM crowd_scores WHERE over IS NOT NULL AND uuid IN (" + inList + ")", ...uuids) : [];
  const scores = crowd.map((c) => Math.max(0, Math.min(10, Number(c.over) / 2.5)));
  stats.applause_avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
  stats.big_ovations = scores.filter((s) => s >= 7).length;
  const [rx] = await q("SELECT count(*) AS taps, count(DISTINCT device_id) AS phones FROM reactions WHERE venue = ?1 AND night = ?2", venue.slug, night);
  stats.reactions = rx ? Number(rx.taps) || 0 : 0;
  stats.phones = rx ? Number(rx.phones) || 0 : 0;
  const [dr] = await q("SELECT count(*) AS n FROM drafts WHERE venue = ?1 AND night = ?2", venue.slug, night);
  stats.draft_picks = dr ? Number(dr.n) || 0 : 0;
  const [du] = await q("SELECT count(*) AS n, sum(partner IS NOT NULL) AS m FROM duets WHERE venue = ?1 AND night = ?2", venue.slug, night);
  stats.duet_posts = du ? Number(du.n) || 0 : 0;
  stats.duet_matches = du ? Number(du.m) || 0 : 0;

  // Compare: average of the nights before (up to 4).
  const avg = (f) => prev.length ? Math.round((prev.reduce((a, n) => a + f(nightStats(byNight.get(n), all.filter((p) => p.night < n), host, venue.tz)), 0) / prev.length) * 10) / 10 : null;
  const compare = prev.length ? { nights: prev.length, songs: avg((s) => s.songs), guest_songs: avg((s) => s.guest_songs), singers: avg((s) => s.singers), first_timers: avg((s) => s.first_timers), hours_singing: avg((s) => s.hours_singing) } : null;

  // Season to date: total nights, songs and different guests ever.
  const everyone = new Set(); all.filter((p) => p.night <= night).forEach((p) => partsOf(p.singer).forEach((k) => { if (k !== host) everyone.add(k); }));
  const season = { nights: idx + 1, songs: all.filter((p) => p.night <= night).length, guests: everyone.size, since: nights[0] };
  return json({ venue: venue.name, slug: venue.slug, night, nights, stats, compare, season }, 200, "public, max-age=60");
}

// The night a report is due for: the latest night, the morning after it (from SEND_HOUR venue time on the next day).
export async function sendReports(env, venue, nowTs = Math.floor(Date.now() / 1000)) {
  const st = scheduleStatus(nowTs, venue);
  if (st.status !== "off") return;
  const hour = hourOf(nowTs, venue.tz);
  if (hour < SEND_HOUR || hour > SEND_HOUR + 6) return;
  const last = await env.DB.prepare("SELECT night, max(played_at) AS t, count(*) AS n FROM plays WHERE venue = ?1 AND night = (SELECT max(night) FROM plays WHERE venue = ?1)").bind(venue.slug).first();
  if (!last || !last.night || nowTs - Number(last.t) > 36 * 3600 || nowTs - Number(last.t) < 6 * 3600) return;
  const { cfg } = await hostKeyOf(env, venue);
  const topics = [cfg.ntfy_topic, cfg.owner_topic].filter(Boolean);
  if (!topics.length) return;
  const key = cfgKey(venue, "report_sent");
  const claim = await env.DB.prepare("INSERT INTO host_config (k, v) VALUES (?2, ?1) ON CONFLICT(k) DO UPDATE SET v = ?1 WHERE v < ?1").bind(last.night, key).run();
  if (!claim.meta.changes) return;
  const link = "https://okenight.com/" + venue.slug + "/report?night=" + last.night;
  const day = new Date(last.night + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  let ok = false;
  for (const t of topics) {
    ok = (await fetch("https://ntfy.sh/" + t, { method: "POST", body: Number(last.n) + (Number(last.n) === 1 ? " song " : " songs ") + day + ". Tap for singers, first-timers, busiest hour and how it compares.",
      headers: { Title: venue.name + " karaoke report", Tags: "bar_chart", Click: link } }).then((r) => r.ok).catch(() => false)) || ok;
  }
  if (!ok) await env.DB.prepare("DELETE FROM host_config WHERE k = ? AND v = ?").bind(key, last.night).run(); // try again next minute
}

function randomId(n) {
  const a = "abcdefghjkmnpqrstuvwxyz23456789", b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => a[x % a.length]).join("");
}
// owner_topic {on: true|false}: a separate ntfy topic the host can hand to the bar owner for the weekly report.
export async function hostReportAction(env, body, venue) {
  const K = cfgKey(venue, "owner_topic");
  if (body.on === false) { await env.DB.prepare("DELETE FROM host_config WHERE k = ?").bind(K).run(); return { ok: true, owner_topic: null }; }
  await env.DB.prepare("INSERT OR IGNORE INTO host_config (k, v) VALUES (?, ?)").bind(K, "okenight-report-" + randomId(14)).run();
  const r = await env.DB.prepare("SELECT v FROM host_config WHERE k = ?").bind(K).first();
  return { ok: true, owner_topic: r ? r.v : null };
}
