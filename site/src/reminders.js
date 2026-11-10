// Sunday reminders for the crowd: a calendar invite (/sunday.ics), a Google Calendar link,
// and a push to a public ntfy topic 2 hours before each session (sent by the every-minute cron).
import { SCHEDULE, scheduleStatus } from "./schedule.js";

// Public on purpose: anyone can subscribe. ntfy topics have no password, so anyone who knows the name
// could also post to it; keep the name here so it can be changed if that ever happens.
export const CROWD_TOPIC = "okenight-sundays";
const SITE = "https://okenight.com";
const LEAD_S = 2 * 3600; // push this long before the start

const pad = (n) => String(n).padStart(2, "0");
// "20261115T210000" in the venue's time zone.
function wallStamp(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
  return p.year + p.month + p.day + "T" + p.hour + p.minute + p.second;
}
const utcStamp = (ts) => new Date(ts * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function nextSession(nowTs, sch = SCHEDULE) {
  const st = scheduleStatus(nowTs, sch);
  // During a session, invite from tonight; otherwise from the next one.
  const start = st.status === "off" ? st.next_start : st.session_start;
  return { start, end: start + sch.hours * 3600 };
}

export function reminderLinks(nowTs, sch = SCHEDULE) {
  const { start, end } = nextSession(nowTs, sch);
  const q = new URLSearchParams({
    action: "TEMPLATE", text: "Karaoke at " + sch.venue,
    dates: wallStamp(start, sch.tz) + "/" + wallStamp(end, sch.tz), ctz: sch.tz,
    recur: "RRULE:FREQ=WEEKLY;BYDAY=" + DAYS[sch.weekday], location: sch.venue,
    details: "Live stats, bingo and badges on your phone: " + SITE,
  });
  return { ics: "/sunday.ics", gcal: "https://calendar.google.com/calendar/render?" + q.toString(), ntfy: "https://ntfy.sh/" + CROWD_TOPIC };
}

// Folded long lines aren't needed: every line here is short.
export function sundayIcs(nowTs, sch = SCHEDULE) {
  const { start, end } = nextSession(nowTs, sch);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Oke Night//Sunday karaoke//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VTIMEZONE", "TZID:America/Chicago",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500", "TZNAME:CDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "TZNAME:CST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:sunday-karaoke@okenight.com",
    "DTSTAMP:" + utcStamp(nowTs),
    "DTSTART;TZID=" + sch.tz + ":" + wallStamp(start, sch.tz),
    "DTEND;TZID=" + sch.tz + ":" + wallStamp(end, sch.tz),
    "RRULE:FREQ=WEEKLY;BYDAY=" + DAYS[sch.weekday],
    "SUMMARY:Karaoke at " + sch.venue,
    "LOCATION:" + sch.venue,
    "URL:" + SITE,
    "DESCRIPTION:Live stats\\, bingo and badges on your phone: " + SITE,
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Karaoke tonight at " + sch.venue, "TRIGGER:-PT2H", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

// Cron: once per session, LEAD_S before it starts, push to the crowd topic. host_config
// 'crowd_reminded' holds the session start already announced, so overlapping runs send once.
export async function sendCrowdReminder(env, nowTs = Math.floor(Date.now() / 1000), sch = SCHEDULE) {
  const st = scheduleStatus(nowTs, sch);
  if (st.status !== "off") return;
  const start = st.next_start, until = start - nowTs;
  if (until > LEAD_S || until <= 0) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS host_config (k text primary key, v text not null)").run();
  const claim = await env.DB.prepare(
    "INSERT INTO host_config (k, v) VALUES ('crowd_reminded', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1 WHERE CAST(v AS integer) < ?1"
  ).bind(String(start)).run();
  if (!claim.meta.changes) return;
  const time = new Date(start * 1000).toLocaleTimeString("en-US", { timeZone: sch.tz, hour: "numeric", minute: "2-digit" }).replace(":00", "");
  try {
    const r = await fetch("https://ntfy.sh/" + CROWD_TOPIC, { method: "POST",
      body: "Karaoke tonight at " + time + " at " + sch.venue + ". Get there early, the first spots on the list go fast.",
      headers: { Title: "Oke Night tonight 🎤", Tags: "microphone", Click: SITE } });
    if (!r.ok) throw new Error("ntfy " + r.status);
  } catch (e) {
    // Let the next minute's run try again.
    await env.DB.prepare("DELETE FROM host_config WHERE k = 'crowd_reminded' AND v = ?").bind(String(start)).run();
  }
}
