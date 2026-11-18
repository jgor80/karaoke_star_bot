// The demo night at okenight.com/demo/: a made-up bar whose show is always on, for App Review and for bar
// owners who want to see Oke Night outside karaoke night. Nothing here touches the database.
//
// Plays are generated from the clock: a show starts every CYCLE_S (the latest one began at least an hour
// ago), with a song every few minutes, so the page always has a "now singing", a line, a leaderboard and
// earlier songs. Three earlier weeks of shows give history, badges and records. Reactions and applause are
// generated too. Taps on the phone get a friendly answer, and Report on a singer's photo or name answers
// "thanks"; anything else that would save (requests, photos, draft picks, duet posts) says this is the demo.
// Singer names are invented, and the sample photos are drawings.
import { scheduleStatus } from "./schedule.js";
import { publicVenue } from "./venues.js";

export const DEMO_VENUE = {
  slug: "demo", demo: true,
  name: "Demo Night", venue: "Demo Night", neighborhood: "Always on", address: "", city: "Anywhere",
  lat: null, lng: null, tz: "America/Chicago",
  weekday: 0, start: [21, 0], hours: 4, latest_hours: 5, // replaced per request by demoSchedule()
  hours_label: "Any time: a sample show that's always on", day_name: "Every day",
  host_default: "DJ Demo",
};

const CYCLE_S = 3 * 3600, LEAD_S = 3600, WEEKS = 3;
const SINGERS = ["Maya", "Dev", "Rosa", "Theo", "Jules", "Priya", "Marcus", "Hana", "Leo", "Sam", "Nadia", "Ollie", "Grace", "Kofi", "Ivy", "Ben"];
const DUETS = ["Maya & Dev", "Rosa & Theo", "Hana & Leo", "Grace & Kofi"];
// [title, artist, year, seconds]
const SONGS = [
  ["Dancing Queen", "ABBA", 1976, 231], ["Bohemian Rhapsody", "Queen", 1975, 354], ["Don't Stop Believin'", "Journey", 1981, 250],
  ["I Wanna Dance with Somebody", "Whitney Houston", 1987, 291], ["Mr. Brightside", "The Killers", 2004, 222], ["Livin' on a Prayer", "Bon Jovi", 1986, 249],
  ["Total Eclipse of the Heart", "Bonnie Tyler", 1983, 269], ["Sweet Caroline", "Neil Diamond", 1969, 203], ["Rolling in the Deep", "Adele", 2010, 228],
  ["Wannabe", "Spice Girls", 1996, 173], ["Hey Ya!", "OutKast", 2003, 235], ["Africa", "Toto", 1982, 295], ["Valerie", "Amy Winehouse", 2007, 233],
  ["Shallow", "Lady Gaga & Bradley Cooper", 2018, 216], ["Take On Me", "a-ha", 1985, 225], ["Respect", "Aretha Franklin", 1967, 147],
  ["Before He Cheats", "Carrie Underwood", 2006, 199], ["Islands in the Stream", "Kenny Rogers & Dolly Parton", 1983, 248], ["Uptown Funk", "Mark Ronson ft. Bruno Mars", 2014, 270],
  ["Jolene", "Dolly Parton", 1973, 161], ["Love Shack", "The B-52's", 1989, 321], ["I Will Survive", "Gloria Gaynor", 1978, 198],
  ["Bad Romance", "Lady Gaga", 2009, 294], ["Piano Man", "Billy Joel", 1973, 338], ["Since U Been Gone", "Kelly Clarkson", 2004, 188],
  ["Girls Just Want to Have Fun", "Cyndi Lauper", 1983, 238], ["Wonderwall", "Oasis", 1995, 258], ["Proud Mary", "Tina Turner", 1971, 330],
  ["Torn", "Natalie Imbruglia", 1997, 245], ["Friends in Low Places", "Garth Brooks", 1990, 258], ["Dreams", "Fleetwood Mac", 1977, 257],
  ["Crazy in Love", "Beyoncé", 2003, 236], ["Say a Little Prayer", "Aretha Franklin", 1968, 216], ["Toxic", "Britney Spears", 2003, 199],
  ["Summer of '69", "Bryan Adams", 1984, 216], ["Killing Me Softly", "Fugees", 1996, 298], ["Barbie Girl", "Aqua", 1997, 197], ["Hallelujah", "Jeff Buckley", 1994, 412],
];
const RX = ["fire", "micdrop", "encore", "chills", "dance", "keychange"];
const REACTORS = ["Maya", "Dev", "Rosa", "Theo", "Priya", "Sam"];

// Small seeded random numbers, so a given show always has the same songs on every phone.
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
const dayOf = (ts, tz) => new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD

// One show: [{uuid, night, played_at, singer, song_id, artist, title, release_year, length_s}], up to `until`.
function show(start, until, seed, tz) {
  const r = rng(seed), out = [], night = dayOf(start, tz);
  let t = start, i = 0;
  while (t <= until && t < start + 4 * 3600) {
    const s = pick(r, SONGS), singer = r() < 0.12 ? pick(r, DUETS) : pick(r, SINGERS);
    out.push({ uuid: "demo-" + seed + "-" + i, night, played_at: t, singer, song_id: 900000 + SONGS.indexOf(s), artist: s[1], title: s[0], release_year: s[2], length_s: s[3] });
    t += s[3] + 40 + Math.floor(r() * 80); i++;
  }
  return out;
}

function shows(now) {
  const cur = Math.floor((now - LEAD_S) / CYCLE_S) * CYCLE_S; // the current show began at least LEAD_S ago
  const all = [];
  for (let w = WEEKS; w >= 1; w--) { const st = cur - w * 7 * 86400; all.push(...show(st, st + 4 * 3600, st / 60, DEMO_VENUE.tz)); }
  const tonight = show(cur, now, cur / 60, DEMO_VENUE.tz);
  const upcoming = show(cur, now + 3600, cur / 60, DEMO_VENUE.tz).slice(tonight.length, tonight.length + 4);
  return { start: cur, plays: [...all, ...tonight], upcoming };
}

// The venue with a schedule that says "live" for the current show.
function demoSchedule(start) {
  const w = new Date(start * 1000), tz = DEMO_VENUE.tz;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(w).map((x) => [x.type, x.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { ...DEMO_VENUE, weekday: dow, start: [Number(p.hour), Number(p.minute)] };
}

// Sample singer photos, so App Review can see photos and try Report and Hide. They are drawn here (a cartoon
// singer in the demo's colors), not photos of real people.
const DEMO_PHOTOS = { maya: ["#ff4fa0", "#2a1233"], rosa: ["#ffb347", "#1d1838"], theo: ["#4fd1ff", "#20122b"], priya: ["#a78bfa", "#17202e"], marcus: ["#7ee787", "#251530"] };
function demoPhoto(k) {
  const c = DEMO_PHOTOS[k];
  if (!c) return null;
  const [fg, bg] = c;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="${bg}"/>` +
    `<circle cx="60" cy="46" r="22" fill="${fg}" opacity=".9"/><path d="M22 120c4-26 20-40 38-40s34 14 38 40z" fill="${fg}" opacity=".75"/>` +
    `<rect x="78" y="52" width="9" height="30" rx="4" fill="#eee" transform="rotate(-25 82 67)"/><circle cx="88" cy="48" r="8" fill="#ccc"/></svg>`;
}

const json = (d, status = 200, cache = "no-store") => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache } });
const NOT_SAVED = "This is the demo night, so nothing is saved here. At a real Oke Night bar this works for real.";

// /demo/api/<name>. Shared, read-only lookups (song search, covers, listen links) go to the real handlers.
export async function handleDemoApi(name, req, url, real) {
  const now = Math.floor(Date.now() / 1000);
  if (name === "plays") {
    const { start, plays, upcoming } = shows(now), venue = demoSchedule(start);
    const since = url.searchParams.get("since");
    const list = since ? plays.filter((p) => p.night >= since) : plays;
    const reactions = [], reactors = [], crowd = [];
    for (const p of list) {
      const r = rng(Number(String(p.uuid).replace(/\D/g, "").slice(-9)) || 7), done = p.played_at + p.length_s < now;
      for (const k of RX) if (r() < 0.45) { const n = 1 + Math.floor(r() * 7); reactions.push({ play: p.uuid, r: k, n, taps: n + Math.floor(r() * 4) }); }
      if (done && r() < 0.8) crowd.push({ play: p.uuid, db: Math.round((4 + r() * 18) * 10) / 10, at: p.played_at + p.length_s + 60 });
    }
    for (const n of new Set(list.map((p) => p.night))) for (const who of REACTORS) reactors.push({ night: n, who, r: pick(rng(who.length * 97), RX), n: 3 + who.length });
    return json({
      venue: publicVenue(DEMO_VENUE), ...(since ? { since } : {}), demo: true, plays: list,
      last_sync: null, last_sync_ts: now - 20, served_at: now, schedule: { ...scheduleStatus(now, venue), reminder: null },
      reactions, reactors, secrets_found: [], secrets_left: 3, host: "DJ Demo", tips: { venmo: "", menu: [] },
      queue: { updated_at: now - 30, items: upcoming.map((p) => ({ id: p.song_id, singer: p.singer, len: p.length_s })) },
      draft_night: dayOf(start, DEMO_VENUE.tz), drafts: [], crowd, duets: [], avatars: Object.fromEntries(Object.keys(DEMO_PHOTOS).map((k) => [k, 1])),
    }, 200, "public, max-age=5");
  }
  if (name === "react") {
    let b = {}; try { b = await req.json(); } catch (e) {}
    const counts = {}; counts[String(b.r || "fire")] = 1 + Math.floor(Math.random() * 6);
    return json({ ok: true, demo: true, who: String(b.name || "You").slice(0, 24), counts, left: 9 });
  }
  if (name === "reactions") return json({ play: url.searchParams.get("play"), counts: {} }, 200, "public, max-age=5");
  if (["catalog", "art", "listen"].includes(name)) return real();
  if (name === "avatar" && req.method === "GET") {
    const svg = demoPhoto(String(url.searchParams.get("k") || ""));
    if (!svg) return new Response("Not found", { status: 404 });
    return new Response(svg, { headers: { "content-type": "image/svg+xml", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "cache-control": "public, max-age=86400" } });
  }
  if (name === "avatar" && req.method === "POST") {
    // Report works here (it's what App Review checks for user content), but nothing is stored or sent.
    let b = {}; try { b = await req.json(); } catch (e) {}
    if (b.action === "report") return json({ ok: true, demo: true, hidden: false });
    if (b.action === "upload") return json({ error: "This is the demo night, so your photo isn't uploaded. At a real Oke Night bar it goes to the host, who approves it before anyone else sees it.", demo: true }, 409);
  }
  if (req.method === "POST") return json({ error: NOT_SAVED, demo: true }, 409);
  return json({ error: "Not part of the demo night." }, 404);
}

