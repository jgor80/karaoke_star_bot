// Laptop health: the host's "is the laptop ready?" alerts, and which copy of the sync script the laptop runs.
//
// syncHealth(env, venue)      -> {sync_health: {ts, version, current, up_to_date, app_open, device,
//                                 live: {ts, version, up_to_date}, mic: {status, level_ts}}} for /host
// checkSyncAlerts(env, venue) -> cron: push the host if the laptop or the karaoke app isn't ready before (or during) a night
//
// The laptop writes one row per bar to sync_health on every heartbeat (every 5 minutes, and after each song),
// and updates itself from sync/karaoke_sync.py on main in the GitHub repo (see check_update in that file).
// One-off runs (daily sync, installer test) only write ts/version/karafun/device; the live (--watch) copy also writes
// watch_ts/watch_version and the crowd mic's state, so /host can tell "a test ran" apart from "the live sync is running".
import { scheduleStatus, localStampToUnix } from "./schedule.js";
import { cfgKey, venueConfig, DEFAULT_SLUG } from "./venues.js";

// Keep in step with HEALTH_TABLE / HEALTH_ADD in sync/karaoke_sync.py.
const HEALTH_TABLE = "CREATE TABLE IF NOT EXISTS sync_health (venue text primary key, ts integer not null, version text, karafun integer, device text, watch_ts integer, watch_version text, mic text, mic_ts integer)";
const HEALTH_ADD = ["watch_ts integer", "watch_version text", "mic text", "mic_ts integer"];
const MIC_QUIET_S = 10 * 60; // during a night, no crowd-meter levels for this long while songs play = the mic isn't working
const PRE_S = 30 * 60;     // start checking this long before the night starts
const STALE_S = 15 * 60;   // no heartbeat for this long = the laptop is offline (it beats every 5 minutes)
const ACTIVE_S = 30 * 60;  // during the night, only nag while songs are still coming
const SCRIPT_URL = "https://raw.githubusercontent.com/jgor80/karaoke_star_bot/main/sync/karaoke_sync.py";

// First 12 hex of the newest script's SHA-256 (what the laptop reports as its version), cached 10 minutes.
async function currentVersion() {
  try {
    const r = await fetch(SCRIPT_URL, { cf: { cacheTtl: 600, cacheEverything: true } });
    if (!r.ok) return null;
    const d = await crypto.subtle.digest("SHA-256", await r.arrayBuffer());
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
  } catch (e) { return null; }
}

let ready = null;
const ensure = (env) => (ready ||= (async () => {
  await env.DB.prepare(HEALTH_TABLE).run();
  const cols = new Set(((await env.DB.prepare("PRAGMA table_info(sync_health)").all()).results || []).map((c) => c.name));
  for (const c of HEALTH_ADD) if (!cols.has(c.split(" ")[0])) await env.DB.prepare("ALTER TABLE sync_health ADD COLUMN " + c).run().catch(() => {});
})().catch((e) => { ready = null; throw e; }));

// Newest crowd-meter level from this bar's laptop and phone (crowd_api.js srcFor naming), or 0.
async function lastLevels(env, venue) {
  const pre = venue.slug === DEFAULT_SLUG ? "" : venue.slug + ":";
  try {
    const r = await env.DB.prepare("SELECT max(CASE WHEN src = ?1 THEN ts END) AS laptop, max(CASE WHEN src = ?2 THEN ts END) AS phone FROM crowd_levels WHERE src IN (?1, ?2) AND ts > ?3")
      .bind(pre + "laptop", pre + "phone", Math.floor(Date.now() / 1000) - 45 * 86400).first();
    return { laptop: Number(r?.laptop) || 0, phone: Number(r?.phone) || 0 };
  } catch (e) { return { laptop: 0, phone: 0 }; } // no crowd_levels table yet
}

async function lastBeat(env, venue) {
  await ensure(env);
  const [h, s] = await env.DB.batch([
    env.DB.prepare("SELECT ts, version, karafun, device, watch_ts, watch_version, mic, mic_ts FROM sync_health WHERE venue = ?1").bind(venue.slug),
    env.DB.prepare("SELECT max(ran_at) AS last FROM sync_runs WHERE venue = ?1").bind(venue.slug),
  ]);
  const row = h.results[0] || null;
  const runTs = localStampToUnix(s.results[0]?.last, venue) || 0;
  return { row, ts: Math.max(row ? Number(row.ts) : 0, runTs) };
}

// For the host page: is the laptop checking in, is the karaoke app open, and is it on the newest script?
export async function syncHealth(env, venue) {
  try {
    const { row, ts } = await lastBeat(env, venue);
    const [current, lv] = await Promise.all([currentVersion(), lastLevels(env, venue)]);
    const liveTs = row && row.watch_ts ? Number(row.watch_ts) : 0;
    return { sync_health: { ts: ts || null, version: row ? row.version : null, current, up_to_date: current ? !!row && row.version === current : null,
      app_open: row && row.karafun != null ? !!row.karafun : null, device: row ? row.device : null,
      live: { ts: liveTs || null, version: row ? row.watch_version || null : null, up_to_date: current && liveTs ? row.watch_version === current : null },
      mic: { status: row ? row.mic || null : null, level_ts: Math.max(lv.laptop, row ? Number(row.mic_ts) || 0 : 0) || null, phone_ts: lv.phone || null } } };
  } catch (e) { return { sync_health: null }; }
}

export async function push(topic, title, body, venue, priority = "high", tags = "computer,warning") {
  const r = await fetch("https://ntfy.sh/" + topic, { method: "POST", body,
    headers: { Title: title, Priority: priority, Tags: tags, Click: "https://okenight.com/" + venue.slug + "/host" } });
  return r.ok;
}

// Send one alert of `kind` per session: host_config "sync_alert_<kind>" holds the session start it was sent for.
export async function once(env, venue, kind, start, send) {
  const key = cfgKey(venue, "sync_alert_" + kind);
  const claim = await env.DB.prepare(
    "INSERT INTO host_config (k, v) VALUES (?2, ?1) ON CONFLICT(k) DO UPDATE SET v = ?1 WHERE CAST(v AS integer) < ?1").bind(String(start), key).run();
  if (!claim.meta.changes) return false;
  let ok = false;
  try { ok = await send(); } catch (e) { ok = false; }
  if (!ok) await env.DB.prepare("DELETE FROM host_config WHERE k = ? AND v = ?").bind(key, String(start)).run(); // retry next minute
  return ok;
}
const sentFor = async (env, venue, kind, start) => {
  const r = await env.DB.prepare("SELECT v FROM host_config WHERE k = ?").bind(cfgKey(venue, "sync_alert_" + kind)).first();
  return !!r && Number(r.v) === start;
};

// Every minute from 30 minutes before the night. Alerts the host's phone (the same ntfy topic as secret songs):
// - "offline": no heartbeat from the laptop for 15 minutes (laptop off, asleep, no wifi, or the sync isn't running)
// - "karafun": the laptop is checking in but the karaoke app isn't open, from 15 minutes before the start
// - "back": the laptop came back after an "offline" alert
// During the night it only keeps watching while songs are still coming, so packing up at 1am doesn't page anyone.
export async function checkSyncAlerts(env, venue, nowTs = Math.floor(Date.now() / 1000)) {
  const st = scheduleStatus(nowTs, venue);
  const pre = st.status === "off" && st.next_start - nowTs <= PRE_S;
  const start = pre ? st.next_start : st.session_start;
  if (!pre && st.status === "off") return;
  if (!pre) {
    // Live: watch the first hour no matter what, then only while songs are coming in.
    if (nowTs - start > 3600) {
      const p = await env.DB.prepare("SELECT max(played_at) AS t FROM plays WHERE venue = ?1").bind(venue.slug).first();
      if (!p || !p.t || nowTs - Number(p.t) > ACTIVE_S) return;
    }
  }
  const cfg = await venueConfig(env, venue);
  if (!cfg.ntfy_topic) return; // no host key set up yet, so nowhere to send it
  const { row, ts } = await lastBeat(env, venue);
  const age = ts ? nowTs - ts : Infinity;
  const when = new Date(start * 1000).toLocaleTimeString("en-US", { timeZone: venue.tz, hour: "numeric", minute: "2-digit" }).replace(":00", "");
  if (age > STALE_S) {
    const last = ts ? "Last check-in " + Math.round(age / 60) + " min ago." : "It has never checked in.";
    await once(env, venue, "offline", start, () => push(cfg.ntfy_topic, "Karaoke laptop is offline",
      (pre ? "Karaoke starts at " + when + ". " : "") + "The laptop isn’t syncing, so phones and the TV won’t update. " + last + " Check it’s on, awake and on wifi.", venue));
    return;
  }
  if (await sentFor(env, venue, "offline", start)) {
    await once(env, venue, "back", start, () => push(cfg.ntfy_topic, "Karaoke laptop is back", "The laptop is syncing again. 👍", venue, "default"));
  }
  const kfLead = pre ? st.next_start - nowTs <= 15 * 60 : true;
  // During the night: songs are coming but no crowd-meter levels arrive from the laptop or the /host phone.
  if (!pre) {
    const p = await env.DB.prepare("SELECT count(*) AS n, min(played_at) AS first FROM plays WHERE venue = ?1 AND played_at > ?2").bind(venue.slug, nowTs - 30 * 60).first();
    const lv = await lastLevels(env, venue);
    if (p && Number(p.n) >= 2 && nowTs - Number(p.first) >= MIC_QUIET_S && nowTs - Math.max(lv.laptop, lv.phone) > MIC_QUIET_S) {
      const why = row && row.mic && nowTs - Number(row.watch_ts || 0) < STALE_S ? " The laptop says: " + row.mic + "." : " The laptop’s live sync isn’t reporting, so an old copy may be running: sign out of Windows and back in.";
      await once(env, venue, "mic", start, () => push(cfg.ntfy_topic, "Crowd meter can’t hear the room",
        "Songs are coming in but no applause readings for " + Math.round(MIC_QUIET_S / 60) + " minutes, so songs get no crowd score." + why + " Or open /host on a phone and start its crowd mic.", venue, "default"));
    }
  }
  if (row && Number(row.karafun) === 0 && nowTs - Number(row.ts) < STALE_S && kfLead) {
    await once(env, venue, "karafun", start, () => push(cfg.ntfy_topic, "Open the karaoke app",
      "The laptop is online but the karaoke app isn’t open" + (pre ? ", and the night starts at " + when : "") + ". Songs only reach the site while it’s running.", venue));
  }
}
