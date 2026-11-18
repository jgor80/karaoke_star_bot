// Rock-star looks: a singer who added a photo (avatars_api.js) can have AI restyle it in the look of a music era
// or genre ("70s glam rock", "90s grunge"...). Each look is made once and kept, so picking it again is free.
//
// What this does NOT do, on purpose (copyright, right of publicity, App Store 1.1/5.1 impersonation rules):
// no real band photos are used, no real musicians' faces or names go into the image, and no band names or logos
// are drawn. A singer can type a favorite band, but that only picks the closest look from STYLES below; the
// band's name is never sent to the image model. Only the fixed prompts below are.
//
// Consent and moderation: the phone must send consent (own photo, 21+, OK to restyle and show on the TV).
// A new look shows on the singer's own phone right away, but only on the TV and other phones once the host
// approves it on /host. The host can remove any look. A look made from an older photo stops showing as soon as
// the photo is changed, removed or blocked, and removing a singer (privacy_api.js) deletes their looks.
//
// Model: Cloudflare Workers AI, FLUX.2 [klein] 4B (env.AI binding), 512 x 512 output. About $0.0004 a look
// (one 512 px input tile + one 512 px output tile). Band -> look uses a small Workers AI text model.
// Storage: R2 (env.STYLED binding) when it is set up, otherwise the image goes in D1 like singer photos.
//
// GET  /<slug>/api/styled                                         -> {styles: [{id, label, emoji}]}
// GET  /<slug>/api/styled?k=<match key>&id=<look id>              -> the image
// POST /<slug>/api/styled {action: "suggest", band}               -> {style, label}
// POST /<slug>/api/styled {action: "make", name, key, style, consent: true, again?} -> {ok, look}
// POST /<slug>/api/styled {action: "mine", name, key}             -> {looks: [...]}
// POST /<slug>/api/styled {action: "use", name, key, id}          -> {ok}   (id "" = back to the plain photo)
// styledMap(env, venue) -> {styled: {match key: look id}}, sent with /api/plays (approved, chosen looks only).
// Host (via /api/host): styled_approve {id}, styled_remove {id}; hostStyled() lists them.
import { matchKey, erasedSingers } from "./privacy_api.js";
import { networkHash } from "./net.js";
import { jpegSize } from "./avatars_api.js";
import { okOrigin } from "./origins.js";

const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const OUT_PX = 512;
const SUGGEST_PER_NET_DAY = 30, SUGGEST_PER_DAY = 2000; // "Match" a band: each one is a small text-model call
const NEW_PER_NAME_DAY = 3, NEW_PER_NET_DAY = 6, NEW_PER_VENUE_DAY = 150;

// The only things that ever reach the image model. Eras and genres, never real people.
export const STYLES = [
  { id: "glam70", emoji: "⚡", label: "70s glam rock", prompt: "a 1970s glam rock album cover portrait: glitter eye makeup, a painted lightning bolt, a shiny metallic jumpsuit, a starry purple backdrop, soft film grain" },
  { id: "hair80", emoji: "🤘", label: "80s hair metal", prompt: "a 1980s hair metal concert photo: huge teased hair, leather jacket and bandana, stage smoke, red and blue spotlights, an arena behind" },
  { id: "metal", emoji: "🔥", label: "Heavy metal", prompt: "a heavy metal album cover painting: dark fantasy style, fire and thunderclouds, studded leather, dramatic lighting" },
  { id: "punk77", emoji: "🧷", label: "70s punk", prompt: "a late-1970s punk gig flyer photo: spiky hair, safety pins, a ripped jacket covered in patches, black and white photocopy texture" },
  { id: "grunge90", emoji: "🎸", label: "90s grunge", prompt: "a 1990s grunge band photo: flannel shirt, messy hair, a dim small club, muted colors, 35mm film look" },
  { id: "brit60", emoji: "🎩", label: "60s British Invasion", prompt: "a 1960s black and white band portrait: slim mod suit, mop-top haircut, plain studio backdrop, vintage press photo" },
  { id: "soul60", emoji: "🎙️", label: "60s soul revue", prompt: "a 1960s soul revue promo photo: sharp matching suit or sequined gown, a vintage microphone, warm studio light, faded color" },
  { id: "disco", emoji: "🪩", label: "Disco", prompt: "a 1970s disco night photo: sequins and wide collars, a mirror ball, a lit-up colored dance floor" },
  { id: "outlaw", emoji: "🤠", label: "Outlaw country", prompt: "a 1970s outlaw country album cover: cowboy hat, denim and suede, a desert highway at sunset, warm faded film" },
  { id: "crooner", emoji: "🍸", label: "Lounge crooner", prompt: "a 1950s Las Vegas lounge singer photo: tuxedo or evening gown, a classic microphone, red velvet curtain, spotlight" },
  { id: "hiphop90", emoji: "📻", label: "90s hip-hop", prompt: "a 1990s hip-hop album cover: oversized jacket, a city street at dusk, a boombox, grainy film photo" },
  { id: "pop90", emoji: "💿", label: "90s pop group", prompt: "a late-1990s pop group promo shot: frosted tips or butterfly clips, matching white outfits, bright glossy studio light" },
  { id: "poppunk", emoji: "🛹", label: "2000s pop-punk", prompt: "a mid-2000s pop-punk photo: side-swept fringe, studded belt, a skate park, direct camera flash" },
  { id: "synthwave", emoji: "🌆", label: "Neon synthwave", prompt: "an 1980s synthwave poster: a neon grid, a striped sunset, chrome, magenta and cyan glow" },
];
const STYLE = Object.fromEntries(STYLES.map((s) => [s.id, s]));
const publicStyles = () => STYLES.map(({ id, emoji, label }) => ({ id, emoji, label }));

const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const now = () => Math.floor(Date.now() / 1000);
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
const day = () => new Date().toISOString().slice(0, 10);

let ready = null;
function ensure(env) {
  if (!ready) ready = env.DB.batch([
    // One row per look. pver = the singer photo version it was made from. img is only used without R2.
    env.DB.prepare("CREATE TABLE IF NOT EXISTS styled_looks (id text PRIMARY KEY, venue text not null, k text not null, name text not null, style text not null, pver integer not null, ctype text not null, img blob, approved integer not null default 0, chosen integer not null default 0, consent_at integer not null, created_at integer not null)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS styled_looks_k ON styled_looks (venue, k)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS styled_log (venue text not null, k text, net text, at integer not null)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS styled_log_at ON styled_log (venue, at)"),
    // "Match" (favorite band -> look) tries, per network, for SUGGEST_PER_NET_DAY.
    env.DB.prepare("CREATE TABLE IF NOT EXISTS styled_suggest_log (net text not null, at integer not null)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS styled_suggest_log_net ON styled_suggest_log (net, at)"),
  ]).catch((e) => { ready = null; throw e; });
  return ready;
}

async function sha256(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function newId() { const b = new Uint8Array(16); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
const objKey = (venue, k, id) => "styled/" + venue.slug + "/" + k + "/" + id;

// The singer's photo, if this phone owns it (same photo key check as avatars_api.js) and it is showing.
async function ownedPhoto(env, venue, k, key) {
  if (!/^[a-f0-9]{32,64}$/.test(key)) return { error: "This phone’s photo key is missing. Reload the page and try again.", status: 400 };
  const row = await env.DB.prepare("SELECT * FROM avatars WHERE venue = ? AND k = ?").bind(venue.slug, k).first().catch(() => null);
  if (!row || !row.img || row.blocked) return { error: "Add your photo first.", status: 404 };
  if (row.owner !== await sha256("avatar:" + venue.slug + ":" + key)) return { error: "Only the phone that added this photo can make looks from it.", status: 403 };
  // A photo waiting for the host or hidden after reports (avatars.pending = 1) can't be made into a look.
  if (row.pending) return { error: "Your photo is waiting for the host. Try again once it shows.", status: 409 };
  if ((await erasedSingers(env, venue)).some((x) => x.k === k)) return { error: "That name isn’t on the site.", status: 404 };
  return { row };
}

function lookOut(r) { return { id: r.id, style: r.style, label: (STYLE[r.style] || {}).label || r.style, approved: !!r.approved, chosen: !!r.chosen, src: "api/styled?k=" + r.k + "&id=" + r.id }; }

async function limited(env, venue, k, net) {
  const t = now();
  const r = await env.DB.prepare("SELECT count(*) AS v, sum(k = ?2) AS n, sum(net = ?3) AS w FROM styled_log WHERE venue = ?1 AND at > ?4")
    .bind(venue.slug, k, net, t - 86400).first().catch(() => null);
  if (!r) return null;
  if ((r.n || 0) >= NEW_PER_NAME_DAY) return "That’s " + NEW_PER_NAME_DAY + " new looks today. Your looks are saved: pick one below, or come back tomorrow.";
  if ((r.w || 0) >= NEW_PER_NET_DAY || (r.v || 0) >= NEW_PER_VENUE_DAY) return "Lots of looks being made right now. Try again tomorrow.";
  return null;
}

// Band name -> the closest look id, or null. The text model only answers with an id from the list.
async function suggestStyle(env, band) {
  band = String(band || "").replace(/[\u0000-\u001f<>"]/g, "").trim().slice(0, 60);
  if (!band || !env.AI) return null;
  const list = STYLES.map((s) => s.id + " = " + s.label).join("\n");
  try {
    const r = await env.AI.run(TEXT_MODEL, { max_tokens: 12, temperature: 0, messages: [
      { role: "system", content: "You match a music artist or band to the closest visual style from a fixed list. Answer with exactly one id from the list and nothing else. If you don't know the artist, guess from the name.\n" + list },
      { role: "user", content: "Artist or band: " + band }] });
    const text = String((r && r.response) || "").toLowerCase();
    const hit = STYLES.find((s) => new RegExp("\\b" + s.id + "\\b").test(text));
    return hit ? hit.id : null;
  } catch (e) { return null; }
}

async function generate(env, photo, style) {
  const form = new FormData();
  form.append("prompt", "Restyle the person in image 0 as " + style.prompt + ". Keep their face, identity, skin tone, age and expression clearly recognizable. " +
    "Square head-and-shoulders portrait. A fictional scene: no text, no words, no band names, no logos, no famous people. Friendly, fully clothed, fun.");
  form.append("input_image_0", new Blob([photo], { type: "image/jpeg" }));
  form.append("width", String(OUT_PX));
  form.append("height", String(OUT_PX));
  const fr = new Response(form);
  const out = await env.AI.run(MODEL, { multipart: { body: fr.body, contentType: fr.headers.get("content-type") } });
  const b64 = out && out.image;
  if (!b64) throw new Error("no image");
  const bin = atob(b64), b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  const ctype = b[0] === 0x89 && b[1] === 0x50 ? "image/png" : b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b[0] === 0x52 && b[8] === 0x57 ? "image/webp" : null;
  if (!ctype) throw new Error("unknown image type");
  return { bytes: b, ctype };
}

export async function handleStyled(req, env, ctx, venue, url) {
  await ensure(env);
  if (req.method === "GET" || req.method === "HEAD") {
    if (!url.searchParams.get("id")) return new Response(JSON.stringify({ styles: publicStyles(), on: !!env.AI }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
    return serveLook(env, venue, url);
  }
  if (req.method !== "POST") return new Response("GET or POST", { status: 405 });
  if (!okOrigin(req, url)) return json({ error: "Wrong site" }, 403); // only this site and the app (each try costs AI time)
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }

  if (body.action === "suggest") {
    const t = now(), net = (await networkHash(env, req, "suggest", day())) || "none";
    const used = await env.DB.prepare("SELECT sum(net = ?1) AS n, count(*) AS all_n FROM styled_suggest_log WHERE at > ?2").bind(net, t - 86400).first().catch(() => null);
    if (used && ((used.n || 0) >= SUGGEST_PER_NET_DAY || (used.all_n || 0) >= SUGGEST_PER_DAY)) return json({ error: "That’s a lot of matching for today. Pick a look below." }, 429);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO styled_suggest_log (net, at) VALUES (?, ?)").bind(net, t),
      env.DB.prepare("DELETE FROM styled_suggest_log WHERE at < ?").bind(t - 2 * 86400)]);
    const id = await suggestStyle(env, body.band);
    return id ? json({ style: id, label: STYLE[id].label }) : json({ error: "Couldn’t place that one. Pick a look below." }, 404);
  }

  const name = cleanName(body.name), k = matchKey(name), key = String(body.key || "");
  if (!k) return json({ error: "Pick your singer name first." }, 400);
  const own = await ownedPhoto(env, venue, k, key);
  if (own.error) return json({ error: own.error }, own.status);
  const pver = own.row.ver;

  if (body.action === "mine") {
    const { results } = await env.DB.prepare("SELECT id, k, style, approved, chosen FROM styled_looks WHERE venue = ? AND k = ? AND pver = ? ORDER BY created_at DESC").bind(venue.slug, k, pver).all();
    return json({ looks: results.map(lookOut) });
  }

  if (body.action === "use") {
    const id = String(body.id || "");
    if (id && !(await env.DB.prepare("SELECT 1 FROM styled_looks WHERE id = ? AND venue = ? AND k = ? AND pver = ?").bind(id, venue.slug, k, pver).first())) return json({ error: "That look is gone. Make a new one." }, 404);
    await env.DB.batch([
      env.DB.prepare("UPDATE styled_looks SET chosen = 0 WHERE venue = ? AND k = ?").bind(venue.slug, k),
      ...(id ? [env.DB.prepare("UPDATE styled_looks SET chosen = 1 WHERE id = ?").bind(id)] : [])]);
    return json({ ok: true });
  }

  if (body.action !== "make") return json({ error: "unknown action" }, 400);
  const style = STYLE[String(body.style || "")];
  if (!style) return json({ error: "Pick a look." }, 400);
  if (body.consent !== true) return json({ error: "Tick the box to say it’s you and you’re OK with this." }, 400);
  if (!env.AI) return json({ error: "Rock-star looks aren’t switched on at this bar yet." }, 503);

  // Already made this look from this photo: just pick it again (free), unless "Try again" was tapped.
  const old = await env.DB.prepare("SELECT id, k, style, approved, chosen FROM styled_looks WHERE venue = ? AND k = ? AND pver = ? AND style = ?").bind(venue.slug, k, pver, style.id).first();
  if (old && !body.again) {
    await env.DB.batch([
      env.DB.prepare("UPDATE styled_looks SET chosen = 0 WHERE venue = ? AND k = ?").bind(venue.slug, k),
      env.DB.prepare("UPDATE styled_looks SET chosen = 1 WHERE id = ?").bind(old.id)]);
    return json({ ok: true, cached: true, look: lookOut({ ...old, chosen: 1 }) });
  }

  const net = await networkHash(env, req, "styled", day());
  const why = await limited(env, venue, k, net);
  if (why) return json({ error: why }, 429);
  const size = jpegSize(new Uint8Array(own.row.img));
  if (!size || size.w >= 512 || size.h >= 512) return json({ error: "Add your photo again (it was saved before looks existed), then try." }, 409);
  // Count the try before calling the model, so failures can't be retried without limit.
  await env.DB.prepare("INSERT INTO styled_log (venue, k, net, at) VALUES (?, ?, ?, ?)").bind(venue.slug, k, net, now()).run();

  let made;
  try { made = await generate(env, new Uint8Array(own.row.img), style); }
  catch (e) { return json({ error: "The look didn’t come out. Try again in a minute." }, 502); }

  const id = newId(), t = now();
  if (env.STYLED) await env.STYLED.put(objKey(venue, k, id), made.bytes, { httpMetadata: { contentType: made.ctype } });
  const stmts = [
    env.DB.prepare("UPDATE styled_looks SET chosen = 0 WHERE venue = ? AND k = ?").bind(venue.slug, k),
    env.DB.prepare("INSERT INTO styled_looks (id, venue, k, name, style, pver, ctype, img, approved, chosen, consent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)")
      .bind(id, venue.slug, k, name, style.id, pver, made.ctype, env.STYLED ? null : made.bytes, t, t),
    env.DB.prepare("DELETE FROM styled_log WHERE at < ?").bind(t - 2 * 86400),
  ];
  if (old) stmts.unshift(env.DB.prepare("DELETE FROM styled_looks WHERE id = ?").bind(old.id));
  await env.DB.batch(stmts);
  if (old && env.STYLED) ctx.waitUntil(env.STYLED.delete(objKey(venue, k, old.id)).catch(() => {}));
  return json({ ok: true, look: lookOut({ id, k, style: style.id, approved: 0, chosen: 1 }) });
}

// The look id is a random 128-bit value, so only the singer's phone (and the host) can find a look before the
// host approves it. Removed looks are gone from storage, so their links stop working.
async function serveLook(env, venue, url) {
  const k = String(url.searchParams.get("k") || ""), id = String(url.searchParams.get("id") || "");
  if (!/^[a-z0-9]{1,80}$/.test(k) || !/^[a-f0-9]{32}$/.test(id)) return new Response("Not found", { status: 404 });
  const row = await env.DB.prepare("SELECT ctype, img FROM styled_looks WHERE id = ? AND venue = ? AND k = ?").bind(id, venue.slug, k).first();
  if (!row) return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=60" } });
  let bytes = row.img ? new Uint8Array(row.img) : null;
  if (!bytes && env.STYLED) { const o = await env.STYLED.get(objKey(venue, k, id)); if (o) bytes = o.body; }
  if (!bytes) return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=60" } });
  return new Response(bytes, { headers: { "content-type": row.ctype, "x-content-type-options": "nosniff", "cache-control": "public, max-age=86400" } });
}

// {styled: {k: look id}}: approved, chosen looks made from the photo that is showing now.
export async function styledMap(env, venue) {
  try {
    await ensure(env);
    // Photos waiting for the host or hidden after reports (avatars.pending, added by the photo safety work)
    // hide their looks too. Before that column exists the first query fails and the second one runs.
    const q = (pending) => env.DB.prepare("SELECT s.k, s.id FROM styled_looks s JOIN avatars a ON a.venue = s.venue AND a.k = s.k AND a.ver = s.pver AND a.img IS NOT NULL AND a.blocked = 0" +
      (pending ? " AND a.pending = 0" : "") + " WHERE s.venue = ? AND s.approved = 1 AND s.chosen = 1").bind(venue.slug).all();
    const [{ results }, erased] = await Promise.all([q(true).catch(() => q(false)), erasedSingers(env, venue)]);
    const gone = new Set(erased.map((x) => x.k)), out = {};
    for (const r of results) if (!gone.has(r.k)) out[r.k] = r.id;
    return { styled: out };
  } catch (e) { return { styled: {} }; }
}

// /host: looks waiting for an OK first, then the newest.
export async function hostStyled(env, venue) {
  try {
    await ensure(env);
    const { results } = await env.DB.prepare("SELECT id, k, name, style, approved, chosen, created_at FROM styled_looks WHERE venue = ? ORDER BY approved, created_at DESC LIMIT 200").bind(venue.slug).all();
    return { styled: results.map((r) => ({ ...lookOut(r), name: r.name, at: r.created_at })) };
  } catch (e) { return { styled: [] }; }
}

export async function hostStyledAction(env, body, venue) {
  await ensure(env);
  const id = String(body.id || "");
  if (!/^[a-f0-9]{32}$/.test(id)) return { error: "Which look?" };
  if (body.action === "styled_approve") {
    await env.DB.prepare("UPDATE styled_looks SET approved = 1 WHERE id = ? AND venue = ?").bind(id, venue.slug).run();
    return { ok: true };
  }
  if (body.action === "styled_remove") {
    const row = await env.DB.prepare("SELECT k FROM styled_looks WHERE id = ? AND venue = ?").bind(id, venue.slug).first();
    if (row) {
      await env.DB.prepare("DELETE FROM styled_looks WHERE id = ?").bind(id).run();
      if (env.STYLED) await env.STYLED.delete(objKey(venue, row.k, id)).catch(() => {});
    }
    return { ok: true };
  }
  return { error: "unknown action" };
}

// privacy_api.js eraseSinger: a removed singer's looks go too (rows and stored images).
export async function eraseStyled(env, venue, k) {
  await ensure(env);
  await env.DB.prepare("DELETE FROM styled_looks WHERE venue = ? AND k = ?").bind(venue.slug, k).run();
  if (env.STYLED) {
    const prefix = "styled/" + venue.slug + "/" + k + "/";
    let cursor;
    do {
      const l = await env.STYLED.list({ prefix, cursor });
      if (l.objects.length) await env.STYLED.delete(l.objects.map((o) => o.key));
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
  }
}
