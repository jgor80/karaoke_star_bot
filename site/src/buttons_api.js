// Bar buttons: wireless buttons around the bar (Flic, a Wi-Fi arcade button, anything that can open a web link)
// that send an emoji reaction to the song on the mic. It floats up the TV just like a phone tap.
//
// Each button gets its own secret link, made on /<slug>/host. Only a hash of the secret is stored, so the link
// is shown once when it's made; "New link" replaces it (the old link stops working), "Remove" deletes the button.
//
// GET or POST /<slug>/api/button?k=<secret>&r=<reaction>
//   k     the button's secret (or header x-button-key, or JSON body {k})
//   r     a reaction key from REACTION_KEYS (fire, micdrop, tomato, ...), its emoji (🔥), "hype", "roast" or
//         "random". Left out: the button's default reaction picked on /host.
//   test  test=1 checks the link without sending anything (shows "last press" on /host), even with nobody singing.
// -> 200 {ok, r, singer} | 401 wrong link | 409 nobody is singing | 429 too many presses
//
// Limits (each button): BTN_LIMITS.burst presses per burstWindowS seconds and perSong per song.
// All of a bar's buttons together: venuePerMin a minute. Presses over a limit are dropped, not queued.
// Button taps are saved as reactions with device_id "btn:<id>", so for crowd awards and badges each button
// counts as one more phone. They are left out of the "who reacted most" awards (see reactionTotals).
//
// Host actions (via /api/host): button_add {label, r}, button_set {id, r, label}, button_rotate {id}, button_remove {id}.
import { REACTION_KEYS, LIMITS, ensureTable } from "./reactions_api.js";
import { DEFAULT_VENUE } from "./venues.js";

export const BTN_LIMITS = { burst: 5, burstWindowS: 10, perSong: 30, venuePerMin: 120 };
export const MAX_BUTTONS = 24;
export const BUTTON_WHO = "Bar button";

// Keep in sync with REACTIONS in awards.js.
const EMOJI = { fire: "🔥", micdrop: "🎤", encore: "🔁", chills: "😭", dance: "💃", keychange: "📈", cringe: "😬", offkey: "🙉", tomato: "🍅", snooze: "😴" };
const HYPE = ["fire", "micdrop", "encore", "chills", "dance", "keychange"];
const ROAST = ["cringe", "offkey", "tomato", "snooze"];
const BY_EMOJI = Object.fromEntries(Object.entries(EMOJI).map(([k, e]) => [e.replace(/️/g, ""), k]));
const KEYS = new Set(REACTION_KEYS);
const CHOICES = new Set([...REACTION_KEYS, "hype", "roast", "random"]);

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
const now = () => Math.floor(Date.now() / 1000);

let ready = null;
function ensure(env) {
  if (!ready) ready = env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bar_buttons (
      id integer primary key autoincrement, venue text not null, label text not null,
      token_hash text not null unique, reaction text not null default 'hype',
      created_at integer not null, last_at integer, presses integer not null default 0)`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS bar_buttons_venue ON bar_buttons (venue)"),
  ]).then(() => ensureTable(env))
    // For the all-buttons-a-minute limit, which looks at the last minute of reactions.
    .then(() => env.DB.prepare("CREATE INDEX IF NOT EXISTS reactions_at ON reactions (created_at)").run()).catch((e) => { ready = null; throw e; });
  return ready;
}

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// 32 characters from a 32-letter alphabet = 160 random bits, so guessing a link is hopeless.
function newSecret() {
  const a = "abcdefghjkmnpqrstuvwxyz23456789Z", b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((x) => a[x % 32]).join("");
}

// "fire" / "🔥" / "hype" / "random" / "" -> a reaction key, or null when it isn't one.
export function pickReaction(given, fallback = "hype", rnd = Math.random) {
  let r = String(given || "").trim();
  if (!r) r = fallback || "hype";
  const byEmoji = BY_EMOJI[r.replace(/️/g, "")];
  if (byEmoji) return byEmoji;
  r = r.toLowerCase();
  if (KEYS.has(r)) return r;
  const pool = r === "hype" ? HYPE : r === "roast" ? ROAST : r === "random" ? REACTION_KEYS : null;
  return pool ? pool[Math.floor(rnd() * pool.length) % pool.length] : null;
}
const cleanLabel = (s) => String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
const cleanChoice = (s) => { const r = String(s || "").trim().toLowerCase(); return CHOICES.has(r) ? r : null; };

export async function handleButton(req, env, venue = DEFAULT_VENUE) {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "GET or POST" }, 405);
  const url = new URL(req.url);
  let body = {};
  if (req.method === "POST" && (req.headers.get("content-type") || "").includes("application/json")) {
    try { body = JSON.parse((await req.text()).slice(0, 1000)) || {}; } catch (e) { return json({ error: "Bad JSON" }, 400); }
  }
  const secret = String(url.searchParams.get("k") || req.headers.get("x-button-key") || body.k || "").trim();
  if (!/^[A-Za-z0-9]{20,64}$/.test(secret)) return json({ error: "Wrong button link" }, 401);
  await ensure(env);
  const btn = await env.DB.prepare("SELECT id, label, reaction FROM bar_buttons WHERE token_hash = ?1 AND venue = ?2")
    .bind(await sha256("btn:" + secret), venue.slug).first();
  if (!btn) {
    await new Promise((r) => setTimeout(r, 300)); // slows down anyone trying links
    return json({ error: "Wrong button link" }, 401);
  }
  const t = now();
  await env.DB.prepare("UPDATE bar_buttons SET last_at = ?1 WHERE id = ?2").bind(t, btn.id).run();
  const r = pickReaction(url.searchParams.get("r") || body.r, btn.reaction);
  if (!r) return json({ error: "Unknown reaction. Use one of: " + REACTION_KEYS.join(", ") + ", hype, roast or random." }, 400);
  if (url.searchParams.get("test") === "1" || body.test) return json({ ok: true, test: true, button: btn.label, r, e: EMOJI[r] });

  // The song on the mic: the latest one, if it's still within its length plus the same grace phones get.
  const p = await env.DB.prepare("SELECT uuid, night, singer, played_at, length_s FROM plays WHERE venue = ?1 ORDER BY played_at DESC LIMIT 1")
    .bind(venue.slug).first();
  const age = p ? t - Number(p.played_at) : Infinity, len = p ? Number(p.length_s) || LIMITS.defaultLenS : 0;
  if (!p || age < -120 || age > len + LIMITS.graceS) return json({ error: "Nobody is singing right now", idle: true }, 409);

  // Limit check and insert in one statement, so presses at the same moment can't slip past the limits together.
  const dev = "btn:" + btn.id;
  const ins = await env.DB.prepare(`INSERT INTO reactions (play_uuid, night, singer, reaction, who, device_id, ip_hash, created_at, venue)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8
      WHERE (SELECT count(*) FROM reactions WHERE device_id = ?6 AND venue = ?8 AND created_at > ?9) < ?10
        AND (SELECT count(*) FROM reactions WHERE device_id = ?6 AND play_uuid = ?1) < ?11
        AND (SELECT count(*) FROM reactions WHERE venue = ?8 AND device_id LIKE 'btn:%' AND created_at > ?12) < ?13`)
    .bind(p.uuid, p.night, p.singer, r, BUTTON_WHO, dev, t, venue.slug,
      t - BTN_LIMITS.burstWindowS, BTN_LIMITS.burst, BTN_LIMITS.perSong, t - 60, BTN_LIMITS.venuePerMin).run();
  if (!ins.meta || !ins.meta.changes) return json({ error: "Easy there! Give it a second.", slow: true }, 429, { "retry-after": String(BTN_LIMITS.burstWindowS) });
  await env.DB.prepare("UPDATE bar_buttons SET presses = presses + 1 WHERE id = ?1").bind(btn.id).run();
  return json({ ok: true, r, e: EMOJI[r], singer: p.singer });
}

// For /api/host: the bar's buttons, without their secrets.
export async function hostButtons(env, venue = DEFAULT_VENUE) {
  try {
    await ensure(env);
    const { results } = await env.DB.prepare("SELECT id, label, reaction AS r, created_at, last_at, presses FROM bar_buttons WHERE venue = ?1 ORDER BY id").bind(venue.slug).all();
    return { buttons: results };
  } catch (e) {
    return { buttons: [] };
  }
}

// Host actions. button_add and button_rotate return {secret} once; it is never shown again.
export async function hostButtonAction(env, body, venue = DEFAULT_VENUE) {
  await ensure(env);
  const id = Number(body.id) || 0;
  if (body.action === "button_add") {
    const label = cleanLabel(body.label);
    if (!label) return { error: "Give the button a name, like “Pool table”." };
    const r = cleanChoice(body.r) || "hype";
    const n = await env.DB.prepare("SELECT count(*) AS n FROM bar_buttons WHERE venue = ?1").bind(venue.slug).first();
    if (n && n.n >= MAX_BUTTONS) return { error: "That’s the most buttons one bar can have (" + MAX_BUTTONS + "). Remove one first." };
    const secret = newSecret();
    const res = await env.DB.prepare("INSERT INTO bar_buttons (venue, label, token_hash, reaction, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(venue.slug, label, await sha256("btn:" + secret), r, now()).run();
    return { ok: true, id: res.meta && res.meta.last_row_id, secret };
  }
  if (!id) return { error: "Which button?" };
  if (body.action === "button_rotate") {
    const secret = newSecret();
    const res = await env.DB.prepare("UPDATE bar_buttons SET token_hash = ?1 WHERE id = ?2 AND venue = ?3").bind(await sha256("btn:" + secret), id, venue.slug).run();
    if (!res.meta || !res.meta.changes) return { error: "That button is gone." };
    return { ok: true, id, secret };
  }
  if (body.action === "button_set") {
    const r = cleanChoice(body.r), label = body.label == null ? null : cleanLabel(body.label);
    if (!r && !label) return { error: "Nothing to change." };
    await env.DB.prepare("UPDATE bar_buttons SET reaction = coalesce(?1, reaction), label = coalesce(?2, label) WHERE id = ?3 AND venue = ?4")
      .bind(r, label || null, id, venue.slug).run();
    return { ok: true };
  }
  if (body.action === "button_remove") {
    await env.DB.prepare("DELETE FROM bar_buttons WHERE id = ?1 AND venue = ?2").bind(id, venue.slug).run();
    return { ok: true };
  }
  return { error: "unknown action" };
}
