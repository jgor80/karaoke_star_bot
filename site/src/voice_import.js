// Singer voice (male / female / guy + girl duet) for the Songbook's voice filters.
//
// KaraFun's catalog doesn't say who sings, so the Worker's every-minute cron looks the artists up
// on MusicBrainz, a few at a time, most popular artists first, and saves the answer in D1:
//   artist_voice(artist, pop, voice, checked)   one row per catalog artist string
//     voice: 'm' or 'f' (solo singer), 'mix' (duet credit with a man and a woman), 'band', '?' (unknown), NULL = not looked up yet
//   mb_person(nk, kind, gender)                 MusicBrainz answers by normalized name, shared by
//                                               artist strings ("Elton John" and "Elton John & Kiki Dee")
// /api/catalog?voice=m|f|mix filters on it (catalog_api.js).
//
// MusicBrainz asks for a User-Agent naming the app and about one request a second, so each run makes
// at most PER_RUN requests, 1.1 s apart, and stops early if MusicBrainz says slow down. That's about
// 20,000 lookups a day, so the most popular artists are done in the first hour and the long tail in a
// day or two. Bands get 'band': MusicBrainz has no gender for groups.

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS artist_voice (artist text primary key, pop integer, voice text, checked integer)",
  "CREATE INDEX IF NOT EXISTS artist_voice_todo ON artist_voice (voice, pop)",
  "CREATE INDEX IF NOT EXISTS artist_voice_v ON artist_voice (voice, artist)",
  "CREATE TABLE IF NOT EXISTS mb_person (nk text primary key, kind text, gender text, checked integer)",
];
const PER_RUN = 16;      // MusicBrainz requests per cron run
const MAX_SLOWDOWNS = 5; // "slow down" answers allowed per run before giving up until the next minute
const GAP_MS = 1100;
const MAX_PARTS = 4;
const MB_UA = "OkeNight/1.0 ( https://okenight.com )";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/^the\s+/, "").replace(/[^\p{L}\p{N}]+/gu, "");

// "A Star is Born (2018 film) (Lady Gaga & Bradley Cooper)" -> "Lady Gaga & Bradley Cooper"; "Queen (Live)" -> "Queen".
export function singers(artist) {
  const a = String(artist || "");
  const m = a.match(/\(([^()]+)\)\s*$/);
  if (m && !/\b(film|movie|musical|soundtrack|tv|series|version|live|remix|cover|karaoke)\b/i.test(m[1]) && /\(.*\(/.test(a)) return m[1].trim();
  return a.replace(/\s*\(.*?\)/g, "").trim() || a;
}
// "Elton John & Kiki Dee" -> ["Elton John", "Kiki Dee"]
export function splitArtists(name) {
  return String(name).split(/\s+(?:feat\.?|ft\.?|featuring|vs\.?|with|duet with|and)\s+|\s*(?:[,&/;+]|\s-\s)\s*/i)
    .map((x) => x.trim()).filter((x) => x.length > 1).slice(0, MAX_PARTS);
}
// Voice for an artist string from what MusicBrainz said about the whole name and, when MusicBrainz
// doesn't know the whole name ("Elton John & Kiki Dee"), about each part.
export function voiceOf(whole, parts) {
  if (whole && whole.kind === "person") return whole.gender === "m" || whole.gender === "f" ? whole.gender : "?";
  if (whole && whole.kind === "group") return "band"; // "Simon & Garfunkel", "Florence + the Machine"
  const g = new Set((parts || []).filter((p) => p && p.kind === "person" && (p.gender === "m" || p.gender === "f")).map((p) => p.gender));
  if (g.has("m") && g.has("f")) return "mix";
  if (g.size === 1 && (parts || []).every((p) => p && p.kind === "person")) return [...g][0];
  return "?";
}

// One MusicBrainz artist search. Returns {kind: 'person'|'group'|'none', gender} or null when told to slow down.
async function lookup(name) {
  const q = 'artist:"' + name.replace(/["\\]/g, " ") + '"';
  const r = await fetch("https://musicbrainz.org/ws/2/artist?fmt=json&limit=5&query=" + encodeURIComponent(q),
    { headers: { accept: "application/json", "user-agent": MB_UA } });
  if (r.status === 503 || r.status === 429) return null;
  if (!r.ok) throw new Error("musicbrainz HTTP " + r.status);
  const d = await r.json();
  const want = norm(name);
  const hit = (d.artists || []).find((x) => (x.score || 0) >= 90 &&
    (norm(x.name) === want || (x.aliases || []).some((al) => norm(al.name) === want)));
  if (!hit) return { kind: "none", gender: "" };
  const kind = hit.type === "Person" || hit.type === "Character" ? "person" : hit.type ? "group" : "none";
  return { kind, gender: hit.gender === "male" ? "m" : hit.gender === "female" ? "f" : "" };
}

let schemaDone = false;
export async function ensureVoiceTables(env) {
  if (schemaDone) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  // fails: lookups of this artist that errored (not "slow down"); added after the table existed.
  await env.DB.prepare("ALTER TABLE artist_voice ADD COLUMN fails integer not null default 0").run().catch(() => {});
  schemaDone = true;
}

const MAX_FAILS = 3;

export async function updateVoices(env, now = Date.now()) {
  await ensureVoiceTables(env);
  // New artists from the latest weekly catalog import join the queue (once per import).
  const meta = Object.fromEntries((await env.DB.prepare("SELECT k, v FROM catalog_meta WHERE k IN ('updated', 'voice_seeded')").all()).results.map((r) => [r.k, r.v]));
  // Any venue's songbook upload (keys are "songbook_updated" or "<slug>:songbook_updated").
  const own = await env.DB.prepare("SELECT max(v) AS v FROM host_config WHERE k = 'songbook_updated' OR k LIKE '%:songbook_updated'").first().catch(() => null);
  const stamp = (meta.updated || "") + "|" + ((own && own.v) || "");
  if (stamp === "|") return null;
  if (meta.voice_seeded !== stamp) {
    if (meta.updated) await env.DB.prepare("INSERT OR IGNORE INTO artist_voice (artist, pop) SELECT artist, min(pop) FROM catalog GROUP BY artist").run();
    // The host's own songbook too (see songbook_api.js).
    if (own && own.v) await env.DB.prepare("INSERT OR IGNORE INTO artist_voice (artist, pop) SELECT artist, min(pop) FROM songbook WHERE artist != '' GROUP BY artist").run().catch(() => {});
    await env.DB.prepare("INSERT OR REPLACE INTO catalog_meta (k, v) VALUES ('voice_seeded', ?)").bind(stamp).run();
  }
  // Artists whose lookups keep erroring go to the back of the queue, so one odd name can't block the rest.
  const { results: todo } = await env.DB.prepare("SELECT artist FROM artist_voice WHERE voice IS NULL ORDER BY fails, pop LIMIT ?").bind(PER_RUN).all();
  if (!todo.length) return 0;

  // What we already know, for every name these artists need.
  const need = todo.map(({ artist }) => { const w = singers(artist), parts = splitArtists(w); return { artist, w, parts: parts.length > 1 ? parts : [] }; });
  const names = [...new Set(need.flatMap((n) => [n.w, ...n.parts]).map(norm).filter(Boolean))];
  const known = new Map();
  for (let i = 0; i < names.length; i += 90) {
    const chunk = names.slice(i, i + 90);
    const { results } = await env.DB.prepare("SELECT nk, kind, gender FROM mb_person WHERE nk IN (" + chunk.map(() => "?").join(",") + ")").bind(...chunk).all();
    results.forEach((r) => known.set(r.nk, r));
  }
  let budget = PER_RUN, stop = false, done = 0, slowdowns = 0, errored = false;
  const ask = async (name) => {
    const nk = norm(name);
    if (!nk) return { kind: "none", gender: "" };
    if (known.has(nk)) return known.get(nk);
    let r = null;
    // MusicBrainz often says "slow down" to Cloudflare's shared addresses, so back off and try again a few times.
    while (r === null) {
      if (stop || budget <= 0) return undefined;
      if (budget < PER_RUN) await sleep(slowdowns ? 2500 : GAP_MS);
      budget--;
      // A 4xx error is about this name (a bad query); network trouble or 5xx just ends this run as before.
      r = await lookup(name).catch((e) => { errored = /HTTP 4\d\d/.test(String(e && e.message)); return undefined; });
      if (r === null && ++slowdowns >= MAX_SLOWDOWNS) stop = true;
    }
    if (!r) return undefined;
    known.set(nk, r);
    await env.DB.prepare("INSERT OR REPLACE INTO mb_person (nk, kind, gender, checked) VALUES (?, ?, ?, ?)").bind(nk, r.kind, r.gender, Math.floor(now / 1000)).run();
    return r;
  };
  // An artist whose lookup gets a 4xx error (not "slow down") is skipped this run, and after MAX_FAILS
  // errors marked '?' (unknown) for good, instead of stopping the whole run at the same artist every minute.
  const skip = async (artist) => {
    errored = false;
    await env.DB.prepare("UPDATE artist_voice SET fails = fails + 1, voice = CASE WHEN fails + 1 >= ? THEN '?' ELSE voice END, checked = ? WHERE artist = ?")
      .bind(MAX_FAILS, Math.floor(now / 1000), artist).run();
  };
  for (const n of need) {
    errored = false;
    const whole = await ask(n.w);
    if (whole === undefined) { if (errored && !stop && budget > 0) { await skip(n.artist); continue; } break; }
    let parts = [];
    if (n.parts.length && whole.kind === "none") {
      for (const p of n.parts) { const r = await ask(p); if (r === undefined) { parts = null; break; } parts.push(r); }
      if (parts === null) { if (errored && !stop && budget > 0) { await skip(n.artist); continue; } break; }
    }
    await env.DB.prepare("UPDATE artist_voice SET voice = ?, checked = ? WHERE artist = ?").bind(voiceOf(whole, parts), Math.floor(now / 1000), n.artist).run();
    done++;
  }
  return done;
}
