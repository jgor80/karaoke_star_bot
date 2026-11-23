// Crowd meter: how loud the room cheers after each song.
//
// Loudness samples (one a second, in dBFS, never audio) come from two places:
//   src "laptop": sync/karaoke_sync.py --watch reads the karaoke laptop's mic and writes straight to D1.
//   src "phone":  okenight.com/host on a phone at the host table (browser mic), POST /api/crowd.
// The applause window is the song's last minute plus 15 seconds after it stops (Jeff's call, 2026-11-22),
// scored two ways and the bigger one wins:
//   - the last minute: the loudest 3 seconds over the song's own loud level (its 75th percentile before
//     the last minute), so cheering over the outro counts but a loud final chorus mostly doesn't;
//   - the 15 seconds after: the loudest 3 seconds over the room's normal chatter (the quiet floor of the last 15 minutes).
//     The next song's intro never counts (it gave the 2026-11-22 night's top score to a song's successor).
// KaraFun only records when songs start, so for a song the host cut short the mic finds when the music stopped:
// the first 3 seconds in a row clearly quieter than the song, in the minute before the next song.
// That difference in dB is the song's crowd score. Mics aren't calibrated, so it's relative, not a true dB reading.
//
// POST /api/crowd {samples: [[unix ts, dBFS], ...]}  (header x-host-key)  -> {ok, saved}
// scoreCrowd(env)   -> scores songs whose applause window has closed (every-minute cron)
// publicCrowd(env)  -> {crowd: [{play, db, at}]} folded into /api/plays

import { isHost } from "./secrets_api.js";
import { DEFAULT_VENUE, DEFAULT_SLUG } from "./venues.js";
// crowd_levels is keyed (ts, src), so other venues store src as "<slug>:laptop" / "<slug>:phone";
// the default venue keeps plain "laptop" / "phone" (what the laptop sync writes).
const srcFor = (venue, s) => (venue.slug === DEFAULT_SLUG ? s : venue.slug + ":" + s);

// Keep the crowd_levels table in sync with CROWD_TABLE in sync/karaoke_sync.py (the laptop creates it too).
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS crowd_levels (ts integer not null, src text not null, db real not null, PRIMARY KEY (ts, src)) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS crowd_scores (uuid text primary key, src text, peak real, base real, over real, scored_at integer not null)",
];
let ready = null;
function ensure(env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; });
  return ready;
}

export const CROWD = {
  tail: 60,         // listen to the song's last 60 seconds
  after: 15,        // and the 15 seconds after it stops
  stopDrop: 4,      // a cut song's music has stopped once 3 seconds in a row are 4 dB under its typical level
  stopRun: 3,
  lookback: 24 * 3600, // score songs from the last day (a night's scores can be redone by deleting them the next day)
  bodySkip: 20,     // the song's own level comes from 20s after it starts up to its last minute
  bodyPct: 0.75,    // ... its loud parts (75th percentile), so only cheering above the music counts
  minBody: 20,      // need 20 seconds of the song for that, or the last minute isn't scored on its own
  lag: 45,          // wait this long after the window closes for the last samples to upload
  giveUp: 30 * 60,  // no samples 30 minutes after: give up on that song
  baseS: 15 * 60,   // the room's chatter level comes from the 15 minutes before
  basePct: 0.1,     // ... its quietest 10% of seconds
  minWindow: 5,     // need at least 5 seconds of samples in the window
  minBase: 20,      // and 20 for the chatter level
  sources: ["laptop", "phone"], // the laptop wins when both were listening
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const now = () => Math.floor(Date.now() / 1000);

// The applause window for play p (followed by `next`, or null) -> {body, start, stop, end, next, cut} or null if it
// can't be placed yet. stop is when the music stopped: the song's length, or the next song's start if the
// host cut it short (cut: scoreWindow then looks for the real stop in the samples). start..stop is the last
// minute, stop..end the seconds after (never into the next song); body is where the song's own level starts.
export function windowFor(p, next) {
  const full = p.length_s ? p.played_at + Number(p.length_s) : null;
  const nx = next ? next.played_at : null;
  const stop = full && nx ? Math.min(full, nx) : full || nx;
  if (!stop) return null;
  return place(p.played_at, stop, nx, !full || (nx != null && nx < full));
}
function place(playedAt, stop, nx, cut) {
  const start = Math.max(playedAt, stop - CROWD.tail);
  const end = nx != null ? Math.max(stop, Math.min(stop + CROWD.after, nx)) : stop + CROWD.after;
  return { body: playedAt + CROWD.bodySkip, playedAt, start, stop, end, next: nx, cut };
}

// For a cut song: the second the music stopped, from the samples (or null if the mic can't tell).
export function findStop(samples, w) {
  const body = samples.filter((s) => s.ts >= w.body && s.ts < w.next - CROWD.tail).map((s) => s.db).sort((a, b) => a - b);
  if (body.length < CROWD.minBody) return null;
  const quiet = pct(body, 0.5) - CROWD.stopDrop;
  const xs = samples.filter((s) => s.ts >= Math.max(w.body, w.next - CROWD.tail) && s.ts < w.next);
  for (let i = 0; i + CROWD.stopRun <= xs.length; i++) {
    let ok = true;
    for (let j = 0; j < CROWD.stopRun; j++) if (xs[i + j].db > quiet || (j && xs[i + j].ts !== xs[i].ts + j)) { ok = false; break; }
    if (ok) return xs[i].ts - 1;
  }
  return null;
}

const r1 = (x) => Math.round(x * 10) / 10;
const pct = (sorted, f) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
function loudest3(xs) {
  if (xs.length < 3) return xs.length ? Math.max(...xs.map((s) => s.db)) : -Infinity;
  let peak = -Infinity;
  for (let i = 0; i + 2 < xs.length; i++) peak = Math.max(peak, (xs[i].db + xs[i + 1].db + xs[i + 2].db) / 3);
  return peak;
}

// samples: [{ts, db}] for one source, sorted by ts. -> {peak, base, over} or null if there's too little to go on.
export function scoreWindow(samples, w) {
  if (w.cut && w.next != null) { const st = findStop(samples, w); if (st) w = place(w.playedAt, st, w.next, false); }
  const inWin = samples.filter((s) => s.ts >= w.start && s.ts <= w.end);
  const pool = samples.filter((s) => s.ts >= w.start - CROWD.baseS && s.ts <= w.end).map((s) => s.db).sort((a, b) => a - b);
  if (inWin.length < CROWD.minWindow || pool.length < CROWD.minBase) return null;
  const parts = [];
  // The seconds after the music stopped, over the room's chatter.
  const after = inWin.filter((s) => s.ts > w.stop);
  if (after.length) parts.push({ peak: loudest3(after), base: pct(pool, CROWD.basePct) });
  // The last minute, over the song's own loud level.
  const body = samples.filter((s) => s.ts >= w.body && s.ts < w.start).map((s) => s.db).sort((a, b) => a - b);
  const tail = inWin.filter((s) => s.ts <= w.stop);
  if (tail.length && body.length >= CROWD.minBody) parts.push({ peak: loudest3(tail), base: pct(body, CROWD.bodyPct) });
  if (!parts.length) return null;
  const best = parts.reduce((a, b) => (b.peak - b.base > a.peak - a.base ? b : a));
  return { peak: r1(best.peak), base: r1(best.base), over: r1(Math.max(0, best.peak - best.base)) };
}

// Score every recent song whose applause window has closed and that has no score yet.
export async function scoreCrowd(env, venue = DEFAULT_VENUE) {
  await ensure(env);
  const t = now();
  const plays = (await env.DB.prepare(
    "SELECT p.uuid, p.played_at, p.length_s, s.uuid AS scored FROM plays p LEFT JOIN crowd_scores s ON s.uuid = p.uuid WHERE p.played_at > ? AND p.venue = ? ORDER BY p.played_at"
  ).bind(t - CROWD.lookback, venue.slug).all()).results;
  const todo = [];
  plays.forEach((p, i) => {
    if (p.scored) return;
    const w = windowFor(p, plays[i + 1] || null);
    if (w && t >= w.end + CROWD.lag) todo.push({ p, w });
  });
  if (!todo.length) return 0;
  const from = Math.min(...todo.map((x) => Math.min(x.w.body, x.w.start - CROWD.baseS))), to = Math.max(...todo.map((x) => x.w.end));
  const rows = (await env.DB.prepare("SELECT ts, src, db FROM crowd_levels WHERE ts BETWEEN ? AND ? ORDER BY ts").bind(from, to).all()).results;
  const bySrc = new Map(CROWD.sources.map((s) => [s, []]));
  const srcOf = new Map(CROWD.sources.map((s) => [srcFor(venue, s), s]));
  rows.forEach((r) => { const s = srcOf.get(r.src); if (s) bySrc.get(s).push({ ts: r.ts, db: Number(r.db) }); });
  const stmts = [];
  todo.forEach(({ p, w }) => {
    let best = null, src = null;
    for (const s of CROWD.sources) { best = scoreWindow(bySrc.get(s), w); if (best) { src = s; break; } }
    if (best) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO crowd_scores (uuid, src, peak, base, over, scored_at) VALUES (?, ?, ?, ?, ?, ?)").bind(p.uuid, src, best.peak, best.base, best.over, t));
    else if (t > w.end + CROWD.giveUp) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO crowd_scores (uuid, scored_at) VALUES (?, ?)").bind(p.uuid, t)); // nobody was listening
  });
  // Raw samples are only needed for scoring; privacy_api.js dailyCleanup deletes them after CROWD_KEEP_DAYS.
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

export async function publicCrowd(env, venue = DEFAULT_VENUE) {
  try {
    await ensure(env);
    const { results } = await env.DB.prepare("SELECT s.uuid AS play, s.over AS db, s.scored_at AS at FROM crowd_scores s JOIN plays p ON p.uuid = s.uuid WHERE s.over IS NOT NULL AND p.venue = ?").bind(venue.slug).all();
    return { crowd: results };
  } catch (e) { return { crowd: [] }; }
}

// The /host phone's mic: a batch of per-second levels every ~10 seconds.
export async function handleCrowd(req, env, venue = DEFAULT_VENUE) {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await isHost(env, req.headers.get("x-host-key"), venue, req))) return json({ error: "Wrong host key." }, 403);
  let body; try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const t = now();
  const samples = (Array.isArray(body.samples) ? body.samples : []).slice(0, 120)
    .map((s) => [Math.floor(Number(s && s[0])), Math.round(Number(s && s[1]) * 10) / 10])
    .filter(([ts, db]) => ts > t - 600 && ts < t + 60 && db >= -120 && db <= 0);
  if (samples.length) {
    await ensure(env);
    const stmts = [];
    for (let i = 0; i < samples.length; i += 30) {
      const chunk = samples.slice(i, i + 30);
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO crowd_levels (ts, src, db) VALUES " + chunk.map(() => "(?, ?, ?)").join(", ")).bind(...chunk.flatMap(([ts, db]) => [ts, srcFor(venue, "phone"), db])));
    }
    await env.DB.batch(stmts);
  }
  return json({ ok: true, saved: samples.length });
}
