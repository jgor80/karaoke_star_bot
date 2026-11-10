// Crowd meter: how loud the room cheers after each song.
//
// Loudness samples (one a second, in dBFS, never audio) come from two places:
//   src "laptop": sync/karaoke_sync.py --watch reads the KaraFun laptop's mic and writes straight to D1.
//   src "phone":  okenight.com/host on a phone at the host table (browser mic), POST /api/crowd.
// Songs are drowned out by the PA, so only the applause after each song is scored: the loudest
// 3 seconds just after the song ends, minus the room's normal chatter (the quiet floor of the last 15 minutes).
// That difference in dB is the song's crowd score. Mics aren't calibrated, so it's relative, not a true dB reading.
//
// POST /api/crowd {samples: [[unix ts, dBFS], ...]}  (header x-host-key)  -> {ok, saved}
// scoreCrowd(env)   -> scores songs whose applause window has closed (every-minute cron)
// publicCrowd(env)  -> {crowd: [{play, db, at}]} folded into /api/plays

import { isHost } from "./secrets_api.js";

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
  startAfter: 1,    // the window opens 1s after the song's end: any earlier and the music's last notes win
  after: 25,        // and stays open 25s after it
  early: 15,        // the next song started more than 15s before this one should have ended: it was stopped early
  noLength: 10,     // a song with no known length: the 10s before the next song
  intoNext: 3,      // a few seconds into the next song's intro still count
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

// The applause window for play p (followed by `next`, or null).
// -> {start, end}, {start, end, skip: true} for a song stopped early (the music ran up to the next song,
// so there's no clean applause to measure), or null if it can't be placed yet.
export function windowFor(p, next) {
  const end = p.length_s ? p.played_at + Number(p.length_s) : null;
  if (!end) return next ? { start: next.played_at - CROWD.noLength, end: next.played_at + CROWD.intoNext } : null;
  if (next && next.played_at < end - CROWD.early) return { start: next.played_at, end: next.played_at, skip: true };
  const start = end + CROWD.startAfter;
  return { start, end: next ? Math.max(start + CROWD.minWindow, Math.min(end + CROWD.after, next.played_at + CROWD.intoNext)) : end + CROWD.after };
}

// samples: [{ts, db}] for one source, sorted by ts. -> {peak, base, over} or null if there's too little to go on.
export function scoreWindow(samples, w) {
  const inWin = samples.filter((s) => s.ts >= w.start && s.ts <= w.end);
  const pool = samples.filter((s) => s.ts >= w.start - CROWD.baseS && s.ts <= w.end).map((s) => s.db).sort((a, b) => a - b);
  if (inWin.length < CROWD.minWindow || pool.length < CROWD.minBase) return null;
  let peak = -Infinity;
  for (let i = 0; i + 2 < inWin.length; i++) peak = Math.max(peak, (inWin[i].db + inWin[i + 1].db + inWin[i + 2].db) / 3);
  const base = pool[Math.floor(pool.length * CROWD.basePct)];
  const r = (x) => Math.round(x * 10) / 10;
  return { peak: r(peak), base: r(base), over: r(Math.max(0, peak - base)) };
}

// Score every recent song whose applause window has closed and that has no score yet.
export async function scoreCrowd(env) {
  await ensure(env);
  const t = now();
  const plays = (await env.DB.prepare(
    "SELECT p.uuid, p.played_at, p.length_s, s.uuid AS scored FROM plays p LEFT JOIN crowd_scores s ON s.uuid = p.uuid WHERE p.played_at > ? ORDER BY p.played_at"
  ).bind(t - 12 * 3600).all()).results;
  const todo = [];
  plays.forEach((p, i) => {
    if (p.scored) return;
    const w = windowFor(p, plays[i + 1] || null);
    if (w && t >= w.end + CROWD.lag) todo.push({ p, w });
  });
  if (!todo.length) return 0;
  const from = Math.min(...todo.map((x) => x.w.start)) - CROWD.baseS, to = Math.max(...todo.map((x) => x.w.end));
  const rows = (await env.DB.prepare("SELECT ts, src, db FROM crowd_levels WHERE ts BETWEEN ? AND ? ORDER BY ts").bind(from, to).all()).results;
  const bySrc = new Map(CROWD.sources.map((s) => [s, []]));
  rows.forEach((r) => { if (bySrc.has(r.src)) bySrc.get(r.src).push({ ts: r.ts, db: Number(r.db) }); });
  const stmts = [];
  todo.forEach(({ p, w }) => {
    let best = null, src = null;
    if (!w.skip) for (const s of CROWD.sources) { best = scoreWindow(bySrc.get(s), w); if (best) { src = s; break; } }
    if (best) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO crowd_scores (uuid, src, peak, base, over, scored_at) VALUES (?, ?, ?, ?, ?, ?)").bind(p.uuid, src, best.peak, best.base, best.over, t));
    else if (w.skip || t > w.end + CROWD.giveUp) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO crowd_scores (uuid, scored_at) VALUES (?, ?)").bind(p.uuid, t)); // stopped early, or nobody was listening
  });
  // Raw samples are only needed for scoring: keep 45 days, trimmed now and then.
  if (Math.random() < 1 / 60) stmts.push(env.DB.prepare("DELETE FROM crowd_levels WHERE ts < ?").bind(t - 45 * 86400));
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

export async function publicCrowd(env) {
  try {
    await ensure(env);
    const { results } = await env.DB.prepare("SELECT uuid AS play, over AS db, scored_at AS at FROM crowd_scores WHERE over IS NOT NULL").all();
    return { crowd: results };
  } catch (e) { return { crowd: [] }; }
}

// The /host phone's mic: a batch of per-second levels every ~10 seconds.
export async function handleCrowd(req, env) {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await isHost(env, req.headers.get("x-host-key")))) { await new Promise((r) => setTimeout(r, 400)); return json({ error: "Wrong host key." }, 403); }
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
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO crowd_levels (ts, src, db) VALUES " + chunk.map(() => "(?, 'phone', ?)").join(", ")).bind(...chunk.flat()));
    }
    await env.DB.batch(stmts);
  }
  return json({ ok: true, saved: samples.length });
}
