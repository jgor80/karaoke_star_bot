// Weekly karaoke schedule for a venue (see venues.js), worked out in the venue's time zone so DST is handled.
// A session runs `hours` from `start` on `weekday` and can run over until `latest_hours`.
import { DEFAULT_VENUE } from "./venues.js";
export const SCHEDULE = DEFAULT_VENUE; // functions below take any venue; this is the default

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Wall-clock parts in the schedule's timezone for a unix time (seconds).
function wall(ts, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, dow: DOW[p.weekday] };
}

// Unix time (seconds) of a wall-clock time in tz. Two passes settle DST offsets.
export function fromWall(y, m, d, h, mi, tz) {
  const target = Date.UTC(y, m - 1, d, h, mi) / 1000;
  let ts = target;
  for (let i = 0; i < 2; i++) {
    const w = wall(ts, tz);
    ts += target - Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) / 1000;
  }
  return ts;
}

function sessionStart(y, m, d, sch) {
  return fromWall(y, m, d, sch.start[0], sch.start[1], sch.tz);
}

function label(ts, tz, opts) {
  return new Date(ts * 1000).toLocaleString("en-US", { timeZone: tz, ...opts });
}

// status: "live" (regular hours), "overtime" (after 1am, before 2am), or "off".
export function scheduleStatus(nowTs, sch = SCHEDULE) {
  const w = wall(nowTs, sch.tz);
  const back = (w.dow - sch.weekday + 7) % 7;
  // Most recent session day on or before today (calendar math via UTC dates, no DST issues).
  const day = new Date(Date.UTC(w.y, w.m - 1, w.d - back));
  let start = sessionStart(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), sch);
  let startDay = day;
  if (start > nowTs) {
    startDay = new Date(Date.UTC(w.y, w.m - 1, w.d - back - 7));
    start = sessionStart(startDay.getUTCFullYear(), startDay.getUTCMonth() + 1, startDay.getUTCDate(), sch);
  }
  const end = start + sch.hours * 3600, latest = start + sch.latest_hours * 3600;
  const status = nowTs < end ? "live" : nowTs < latest ? "overtime" : "off";
  const nd = new Date(startDay.getTime() + 7 * 86400000);
  const next = status === "off" ? sessionStart(nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate(), sch) : start;
  return {
    venue: sch.venue,
    slug: sch.slug,
    status,
    session_start: start,
    session_end: end,
    latest_end: latest,
    next_start: next,
    next_label: label(next, sch.tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(":00", ""),
    hours_label: sch.hours_label,
  };
}

// The laptop writes sync times as Central wall clock "YYYY-MM-DDTHH:MM:SS" -> unix seconds.
export function localStampToUnix(v, sch = SCHEDULE) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?/.exec(String(v || ""));
  return m ? fromWall(+m[1], +m[2], +m[3], +m[4], +m[5], sch.tz) + Number(m[6] || 0) : null;
}
