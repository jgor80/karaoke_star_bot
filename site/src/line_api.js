// The line vs time left: all night, compare how long the karaoke app's queue will take with when tonight ends.
//
// lineCheck(env, venue)     -> {line: {...}} for /host: singers in line, when the line should finish, tonight's end
//                              and whether it fits (or by how much it runs over, and who probably won't get on)
// watchLine(env, venue)     -> cron, every minute: push the host (same ntfy topic as secret songs) once a night when
//                              the line starts running past the end time, and a last-call nudge 30 minutes before the end
//
// Same estimate as the phone's "The line" and the TV's "Up next": each queued song's length (4 min if unknown)
// plus a 25 s changeover, after whatever is on the mic now. The host can reorder, so it's a guess.
import { scheduleStatus } from "./schedule.js";
import { venueConfig } from "./venues.js";
import { once, push } from "./health_api.js";

const DEFAULT_LEN = 240, GAP = 25;
const OVER_ALERT_S = 5 * 60;  // only page the host when the line runs at least this far past the end
const LAST_CALL_S = 30 * 60;  // the last-call nudge, this long before the end
const QUIET_S = 15 * 60;      // no new queue or song for this long = the laptop isn't syncing, don't guess

const clock = (ts, tz) => new Date(ts * 1000).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(":00", "");
export function waitLabel(s) {
  const m = Math.round(s / 60);
  if (m < 1) return "under a minute";
  return m < 60 ? m + " min" : Math.floor(m / 60) + " hr" + (m % 60 ? " " + (m % 60) + " min" : "");
}

// Pure: the estimate from the queue, the latest play and the schedule. null when there's no night on or no fresh queue.
export function estimateLine(queue, last, st, now, tz) {
  if (!st || (st.status !== "live" && st.status !== "overtime")) return null;
  if (!queue || !Array.isArray(queue.items) || Number(queue.updated_at) < st.session_start - 2 * 3600) return null;
  const items = queue.items.slice();
  const len = last ? Number(last.length_s) || DEFAULT_LEN : 0, played = last ? Number(last.played_at) : 0;
  const onMic = last && now - played < len + 180;
  if (onMic && items.length && String(items[0].id) === String(last.song_id)) items.shift();
  if (now - Math.max(Number(queue.updated_at), played) > QUIET_S && !onMic && items.length) return null; // stale queue
  let t = onMic ? Math.max(0, played + len - now) + GAP : 0;
  const late = [];
  const end = st.status === "live" ? st.session_end : st.latest_end;
  items.forEach((x) => { if (now + t > end) late.push(String(x.singer || "").trim() || "someone"); t += (Number(x.len) || DEFAULT_LEN) + GAP; });
  const finish = now + t;
  return { count: items.length, wait_s: Math.round(t), finish, finish_label: clock(finish, tz), end, end_label: clock(end, tz),
    overtime: st.status === "overtime", end_set: !!st.end_set, left_s: Math.max(0, end - now), over_s: Math.max(0, Math.round(finish - end)), late };
}

async function inputs(env, venue, now) {
  const st = scheduleStatus(now, venue);
  if (st.status !== "live" && st.status !== "overtime") return { st, q: null, last: null };
  const [q, last] = await Promise.all([
    env.DB.prepare("SELECT updated_at, items FROM live_queue WHERE venue = ?1 ORDER BY updated_at DESC LIMIT 1").bind(venue.slug).first().catch(() => null),
    env.DB.prepare("SELECT played_at, song_id, length_s FROM plays WHERE venue = ?1 ORDER BY played_at DESC LIMIT 1").bind(venue.slug).first().catch(() => null),
  ]);
  let queue = null;
  try { if (q) queue = { updated_at: q.updated_at, items: JSON.parse(q.items) }; } catch (e) {}
  return { st, q: queue, last };
}

export async function lineCheck(env, venue, now = Math.floor(Date.now() / 1000)) {
  try { const { st, q, last } = await inputs(env, venue, now); return { line: estimateLine(q, last, st, now, venue.tz) }; }
  catch (e) { return { line: null }; }
}

const names = (l, max = 4) => l.slice(-max).join(", ") + (l.length > max ? " (and " + (l.length - max) + " more)" : "");

export async function watchLine(env, venue, now = Math.floor(Date.now() / 1000)) {
  const { st, q, last } = await inputs(env, venue, now);
  const e = estimateLine(q, last, st, now, venue.tz);
  if (!e) return;
  const cfg = await venueConfig(env, venue);
  if (!cfg.ntfy_topic) return;
  const host = "okenight.com/" + venue.slug + "/host";
  if (e.over_s >= OVER_ALERT_S && e.late.length) {
    await once(env, venue, "line_over", st.session_start, () => push(env, cfg.ntfy_topic, "The line runs past " + e.end_label,
      e.count + " in line, about " + waitLabel(e.wait_s) + " of songs, and " + waitLabel(e.left_s) + " left. " +
      (e.late.length === 1 ? "The last one" : "The last " + e.late.length) + " (" + names(e.late) + ") probably won’t get on. " +
      (e.overtime ? "" : "Run later from " + host + ", or stop taking slips."), venue, "high", "hourglass"));
  }
  if (!e.overtime && e.left_s <= LAST_CALL_S && e.left_s > LAST_CALL_S - 10 * 60 && e.over_s === 0) {
    await once(env, venue, "line_lastcall", st.session_start, () => push(env, cfg.ntfy_topic, "30 minutes left: last call",
      "Karaoke ends at " + e.end_label + ". " + (e.count ? e.count + " in line, done around " + e.finish_label + ", so there’s room for about " + Math.max(0, Math.floor((e.end - e.finish) / 265)) + " more." : "Nobody’s in line.") + " The TV is showing last call.", venue, "default", "bell"));
  }
}
